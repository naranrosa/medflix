import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import { createClient, Session, User } from '@supabase/supabase-js';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';

// --- CONFIGURAÇÃO DO SUPABASE ---
const supabaseUrl = 'https://vylpdfeqdylcqxzllnbh.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5bHBkZmVxZHlsY3F4emxsbmJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcxNjY3NzMsImV4cCI6MjA3Mjc0Mjc3M30.muT9yFZaHottkDM-acc6iU5XHqbo7yqTF-bpPoAotMY';
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// --- DADOS MOCADOS (APENAS PARA PREENCHER A INTERFACE INICIALMENTE) ---
const initialTerms = Array.from({ length: 12 }, (_, i) => ({
    id: `t${i + 1}`,
    name: `${i + 1}º Termo`,
}));

// --- CONFIGURAÇÃO DA IA E FUNÇÃO DE RETRY ---
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  throw new Error("API_KEY environment variable not set");
}
const ai = new GoogleGenAI({ apiKey: API_KEY });
const model = "gemini-2.5-flash";

/**
 * Encapsula a chamada da API GenAI com uma lógica de retry para erros 503 (servidor sobrecarregado).
 * @param {string} prompt O prompt a ser enviado para o modelo.
 * @param {object} schema O schema de resposta esperado.
 * @param {number} maxRetries O número máximo de tentativas.
 * @returns {Promise<object>} O JSON parseado da resposta da IA.
 */
const generateAIContentWithRetry = async (prompt, schema, maxRetries = 4) => {
    let attempt = 0;
    let delay = 1000;

    while (attempt < maxRetries) {
        try {
            const response = await ai.models.generateContent({
                model,
                contents: prompt,
                config: { responseMimeType: "application/json", responseSchema: schema },
            });

            let rawText = response.text.trim();
            const jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[1]) {
                rawText = jsonMatch[1];
            }

            const firstBracket = rawText.indexOf('{');
            const lastBracket = rawText.lastIndexOf('}');
            if (firstBracket !== -1 && lastBracket > firstBracket) {
                rawText = rawText.substring(firstBracket, lastBracket + 1);
            }

            try {
                return JSON.parse(rawText);
            } catch (parseError) {
                console.error("ERRO DE PARSE JSON:", parseError);
                console.error("--- TEXTO BRUTO DA IA QUE FALHOU --- \n", rawText, "\n--- FIM DO TEXTO BRUTO ---");
                throw new Error("JSON_PARSE_FAILED");
            }

        } catch (error) {
            attempt++;
            const isOverloaded = error.message && (error.message.includes('503') || error.message.toLowerCase().includes('overloaded'));
            const isParseFailure = error.message === "JSON_PARSE_FAILED";

            if ((isOverloaded || isParseFailure) && attempt < maxRetries) {
                const reason = isOverloaded ? "Modelo sobrecarregado" : "Resposta JSON inválida";
                console.warn(`${reason}. Tentando novamente em ${delay / 1000}s... (Tentativa ${attempt}/${maxRetries})`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
            } else {
                if (isParseFailure) {
                    console.error("Máximo de tentativas atingido. A IA continua retornando JSON inválido.");
                    throw new Error("A resposta da IA não pôde ser processada. Por favor, tente novamente.");
                }
                console.error("Erro final da API ou máximo de tentativas atingido para servidor sobrecarregado.");
                throw error;
            }
        }
    }
    throw new Error("Não foi possível gerar conteúdo da IA após múltiplas tentativas.");
};


const enhancedContentSchema = {
    type: Type.OBJECT,
    properties: {
      enhancedContent: {
        type: Type.STRING,
        description: 'O conteúdo do resumo aprimorado e reescrito em formato HTML bem formado. Use tags como <h2>, <h3>, <p>, <ul>, <li>, <strong>, etc. Se dados tabulares estiverem presentes, formate-os usando <table>, <thead>, <tbody>, <tr>, <th>, e <td>. Não inclua a tag <h1>.'
      },
    },
    required: ['enhancedContent']
};

const quizSchema = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      description: 'Uma lista de no mínimo 10 questões de múltipla escolha de alto nível, inspiradas em provas de residência médica, mesclando diferentes formatos complexos.',
      items: {
        type: Type.OBJECT,
        properties: {
          questionNumber: { type: Type.STRING },
          discipline: { type: Type.STRING },
          campus: { type: Type.STRING },
          knowledgeArea: { type: Type.STRING },
          questionText: { type: Type.STRING },
          alternatives: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          },
          correctAlternativeIndex: { type: Type.INTEGER, description: 'Índice (0-3) da alternativa correta' },
          explanation: { type: Type.STRING, description: 'Comentário da resposta correta' }
        },
        required: ['questionNumber','discipline','campus','knowledgeArea','questionText','alternatives','correctAlternativeIndex','explanation']
      }
    }
  },
  required: ['questions']
};


const quizExplanationSchema = {
    type: Type.OBJECT,
    properties: {
        explanation: {
            type: Type.STRING,
            description: 'Uma explicação curta e clara (1-2 sentenças) do porquê a alternativa é a correta, baseada no contexto fornecido.'
        }
    },
    required: ['explanation']
};

const flashcardsSchema = {
  type: Type.OBJECT,
  properties: {
    flashcards: {
      type: Type.ARRAY,
      description: 'gerar flashcards claros e objetivos a partir dele, organizados em formato de pergunta e resposta, sem incluir valores de exames laboratoriais ou dados numéricos específicos, priorizando conceitos, definições, mecanismos, causas, consequências, classificações e relações clínicas relevantes, de forma que cada flashcard seja curto, direto e facilite a memorização rápida, tendo uma lista de flashcards com frente e verso, deve ser a quantidade necessária para o aluno aprender todo o conteudo presente no resumo .',
      items: {
        type: Type.OBJECT,
        properties: {
          front: { type: Type.STRING, description: 'O texto da frente do flashcard (pergunta/conceito).' },
          back: { type: Type.STRING, description: 'O texto do verso do flashcard (resposta/explicação).' }
        },
        required: ['front', 'back']
      }
    }
  },
  required: ['flashcards']
};

const splitSummariesSchema = {
    type: Type.OBJECT,
    properties: {
      summaries: {
        type: Type.ARRAY,
        description: 'Uma lista de resumos, onde cada um contém um título e o conteúdo em HTML.',
        items: {
          type: Type.OBJECT,
          properties: {
            title: {
              type: Type.STRING,
              description: 'O título conciso e informativo para este resumo específico.'
            },
            content: {
              type: Type.STRING,
              description: 'O conteúdo do resumo em formato HTML bem formado. Use tags como <h2>, <h3>, <p>, <ul>, <li>, etc.'
            }
          },
          required: ['title', 'content']
        }
      }
    },
    required: ['summaries']
};

const identifyTitlesSchema = {
    type: Type.OBJECT,
    properties: {
        titles: {
            type: Type.ARRAY,
            description: "Uma lista de títulos de resumos concisos e informativos identificados no texto.",
            items: {
                type: Type.STRING
            }
        }
    },
    required: ['titles']
};


const QuizView = ({ questions, onGetExplanation }) => {
    const [answers, setAnswers] = useState({});
    const [explanations, setExplanations] = useState({});
    const [loadingExplanation, setLoadingExplanation] = useState(null);

    const handleAnswer = async (questionIndex, alternativeIndex) => {
        // Não faz nada se a questão já foi respondida
        if (answers[questionIndex] !== undefined) return;

        // Marca a alternativa selecionada pelo usuário
        setAnswers(prev => ({ ...prev, [questionIndex]: alternativeIndex }));

        const question = questions[questionIndex];
        const isCorrect = question.correctAlternativeIndex === alternativeIndex;

        if (isCorrect) {
            // Se acertou, busca uma nova explicação dinâmica da IA (comportamento original)
            setLoadingExplanation(questionIndex);
            try {
                const explanationText = await onGetExplanation(
                    question.questionText,
                    question.alternatives[alternativeIndex]
                );
                setExplanations(prev => ({ ...prev, [questionIndex]: explanationText }));
            } catch (error) {
                console.error("Failed to get explanation:", error);
                // Se a busca falhar, usa a explicação padrão que já existe
                setExplanations(prev => ({...prev, [questionIndex]: question.explanation || "Não foi possível carregar a explicação."}));
            } finally {
                setLoadingExplanation(null);
            }
        } else {
            // --- CORREÇÃO APLICADA AQUI ---
            // Se errou, simplesmente usa a explicação que já veio com a questão.
            setExplanations(prev => ({ ...prev, [questionIndex]: question.explanation }));
        }
    };

    return (
        <div className="quiz-container">
            <h2>Teste seu Conhecimento</h2>
            {questions.map((q, qIndex) => {
                const userAnswer = answers[qIndex];
                const isAnswered = userAnswer !== undefined;
                return (
                    <div key={qIndex} className="question-block">
                        <p className="question-text">{qIndex + 1}. {q.questionText}</p>
                        <div className="alternatives-list">
                            {q.alternatives.map((alt, aIndex) => {
                                let btnClass = 'alternative-item';
                                if (isAnswered) {
                                    if (aIndex === q.correctAlternativeIndex) {
                                        btnClass += ' correct';
                                    } else if (aIndex === userAnswer) {
                                        btnClass += ' incorrect';
                                    }
                                }
                                return (
                                    <button
                                        key={aIndex}
                                        className={btnClass}
                                        onClick={() => handleAnswer(qIndex, aIndex)}
                                        disabled={isAnswered}
                                    >
                                        {alt}
                                    </button>
                                );
                            })}
                        </div>
                        {/* Esta parte agora funcionará para acertos e erros */}
                        {isAnswered && explanations[qIndex] && (
                             <div className="explanation-box">
                                 <p><strong>Comentário:</strong></p>
                                 <p>{explanations[qIndex]}</p>
                             </div>
                        )}
                        {loadingExplanation === qIndex && <div className="explanation-box"><div className="loader-sm"></div></div>}
                    </div>
                );
            })}
        </div>
    );
};

// --- FUNÇÕES AUXILIARES ---
// --- FUNÇÕES AUXILIARES ---
const subjectColors = [
  '#E63946', // Vermelho
  '#1D3557', // Azul Escuro
  '#457B9D', // Azul Médio
  '#2A9D8F', // Verde-azulado
  '#E76F51', // Laranja
  '#FFC300', // Amarelo
  '#6A057F', // Roxo
  '#E5989B', // Rosa
  '#008080'  // Verde-petróleo
];
const getNewSubjectColor = (existingSubjects) => {
    const usedColors = new Set(existingSubjects.map(s => s.color));
    const availableColor = subjectColors.find(c => !usedColors.has(c));
    return availableColor || subjectColors[Math.floor(Math.random() * subjectColors.length)];
};

const getGoogleDriveEmbedUrl = (url) => {
  if (!url) return null;
  const regExp = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/;
  const match = url.match(regExp);
  return (match && match[1])
    ? `https://drive.google.com/file/d/${match[1]}/preview`
    : null;
};

// --- COMPONENTES ---

const ThemeToggle = ({ theme, toggleTheme }) => (
    <div className="theme-switch">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
        <label className="theme-switch-wrapper">
            <input type="checkbox" checked={theme === 'dark'} onChange={toggleTheme} />
            <span className="slider"></span>
        </label>
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
    </div>
);

const IconButton = ({ onClick, children, className = '', disabled = false }) => (
    <button className={`icon-btn ${className}`} onClick={(e) => { e.stopPropagation(); onClick(e); }} disabled={disabled}>
        {children}
    </button>
);

const EditIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>;
const DeleteIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>;
const CheckCircleIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>;
const SearchIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>;
const SparklesIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L14.39 8.36L21 9.27L16.36 14.14L18.18 21L12 17.27L5.82 21L7.64 14.14L3 9.27L9.61 8.36L12 2z"/></svg>;
const ListIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>;


const Breadcrumbs = ({ paths }) => (
    <nav className="breadcrumbs">
        {paths.map((path, index) => (
            <React.Fragment key={index}>
                {index > 0 && <span className="breadcrumb-separator">/</span>}
                <button
                    onClick={path.onClick}
                    className={`breadcrumb-item ${index === paths.length - 1 ? 'active' : ''}`}
                    disabled={index === paths.length - 1}
                >
                    {path.name}
                </button>
            </React.Fragment>
        ))}
    </nav>
);

const LoginScreen = ({ theme, toggleTheme }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleAuthAction = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
        if (isSignUp) {
            const { error: signUpError } = await supabase.auth.signUp({
                email,
                password,
            });

            if (signUpError) throw signUpError;

            const mercadoPagoCheckoutUrl = 'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_plan_id=fa9742c919ac44d793ad723d66d9feae';
            window.location.href = mercadoPagoCheckoutUrl;

        } else {
            const { error: signInError } = await supabase.auth.signInWithPassword({
                email,
                password,
            });
            if (signInError) throw signInError;
        }
    } catch (error) {
        setError(error.message || "Ocorreu um erro. Tente novamente.");
    } finally {
        setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      <div className="login-card">
        <h1>Med<span>flix</span></h1>
        <p>{isSignUp ? 'Crie sua conta para começar' : 'Faça login para continuar'}</p>
        <form onSubmit={handleAuthAction}>
          <div className="form-group">
            <label htmlFor="email-input">Email</label>
            <input
              id="email-input"
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="digite seu email"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="password-input">Senha</label>
            <input
              id="password-input"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="digite sua senha"
              required
            />
          </div>
          {error && <p className="error-message">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Carregando...' : (isSignUp ? 'Registrar e Pagar' : 'Entrar')}
          </button>
        </form>
        <button className="toggle-auth-btn" onClick={() => setIsSignUp(!isSignUp)}>
          {isSignUp ? 'Já tem uma conta? Faça login' : 'Não tem uma conta? Cadastre-se'}
        </button>
      </div>
    </div>
  );
};


const AIUpdateModal = ({ onClose, onUpdate, summary }) => {
    const [isLoading, setIsLoading] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState('');
    const [error, setError] = useState('');
    const [audioFile, setAudioFile] = useState(null);
    const [textContent, setTextContent] = useState('');

    const fileToBase64 = async (file) => {
        const arrayBuffer = await file.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(arrayBuffer);
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    };

    const handleUpdate = async () => {
        if (!audioFile && !textContent.trim()) {
            setError('Por favor, selecione um arquivo de áudio ou cole o texto com as novas informações.');
            return;
        }
        setIsLoading(true);
        setError('');

        try {
            let textFromAudio = '';
            if (audioFile) {
                setLoadingMessage('Transcrevendo o áudio...');
                const base64Audio = await fileToBase64(audioFile);

                const transcription = await ai.models.generateContent({
                    model: "gemini-2.5-flash",
                    contents: [
                        { role: "user", parts: [{ text: "Transcreva este áudio para texto em português médico-acadêmico:" }, { inlineData: { mimeType: audioFile.type, data: base64Audio } }] }
                    ]
                });

                textFromAudio = transcription.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (!textFromAudio) {
                    throw new Error("Falha na transcrição do áudio");
                }
            }

            const newInformation = `
                ${textFromAudio ? `Informações do áudio transcrito:\n"""${textFromAudio}"""\n\n` : ''}
                ${textContent.trim() ? `Informações do texto fornecido:\n"""${textContent.trim()}"""` : ''}
            `.trim();

            setLoadingMessage('Atualizando o resumo com as novas informações...');

const updatePrompt = `Você é um especialista em redação médica e acadêmica. Sua tarefa é integrar de forma inteligente novas informações a um resumo existente sobre o mesmo tópico.
Analise o resumo original e as novas informações fornecidas. Reestruture, reescreva e combine os textos para criar uma versão final aprimorada, coesa e bem organizada. Corrija quaisquer inconsistências e melhore a clareza.
O resultado final DEVE ser um único bloco de conteúdo em formato HTML bem formado, utilizando tags como <h2>, <h3>, <p>, <ul>, <li>, <strong>, etc., pronto para ser renderizado em uma página web.

**Resumo Original:**
"""
${summary.content}
"""

**Novas Informações a serem Integradas:**
"""
${newInformation}
"""`;
            const parsedJson = await generateAIContentWithRetry(updatePrompt, enhancedContentSchema);

            setLoadingMessage('Resumo atualizado com sucesso!');
            await new Promise(res => setTimeout(res, 1000));

            onUpdate(parsedJson.enhancedContent);
        } catch (e) {
            console.error(e);
            setError('Falha ao processar as informações ou atualizar o resumo. Tente novamente.');
            setIsLoading(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content large" onClick={(e) => e.stopPropagation()}>
                {!isLoading ? (
                    <>
                        <h2>Atualizar Resumo com IA</h2>
                        <p>
                            Faça o upload do áudio da aula ou cole abaixo as anotações. A IA irá analisar e integrar
                            as informações no resumo atual.
                        </p>

                        <div className="form-group">
                            <label>Opção 1: Áudio da Aula</label>
                            <input
                                className="input"
                                type="file"
                                accept="audio/*"
                                onChange={(e) => setAudioFile(e.target.files?.[0] || null)}
                            />
                        </div>

                        <div className="form-group">
                             <label>Opção 2: Novas Informações (Texto)</label>
                             <textarea
                                placeholder="Cole aqui o texto ou anotações a serem adicionadas ao resumo..."
                                value={textContent}
                                onChange={(e) => setTextContent(e.target.value)}
                                rows={8}
                            />
                        </div>

                        {error && <p style={{ color: 'var(--danger-accent)', marginTop: '1rem' }}>{error}</p>}
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleUpdate} disabled={!audioFile && !textContent.trim()}>
                                Processar e Atualizar
                            </button>
                        </div>
                    </>
                ) : (
                    <div className="loader-container">
                        <div className="loader"></div>
                        <p>{loadingMessage}</p>
                    </div>
                )}
            </div>
        </div>
    );
};

const AIEnhancementModal = ({ onClose, onContentEnhanced }) => {
    const [isLoading, setIsLoading] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState('');
    const [error, setError] = useState('');
    const [textContent, setTextContent] = useState('');

    const handleEnhance = async () => {
        if (!textContent.trim()) {
            setError('Por favor, insira o texto para ser aprimorado.');
            return;
        }
        setIsLoading(true);
        setError('');
        setLoadingMessage('Aprimorando o texto com IA...');
        try {
const prompt = `Você é um especialista em redação acadêmica e médica. Sua tarefa é aprimorar o texto a seguir, tornando-o mais claro, conciso e profissional.
Reestruture as frases para melhor fluidez, corrija erros gramaticais e de estilo, e organize o conteúdo de forma lógica.
Formate o resultado final em HTML bem formado, usando títulos (<h2>, <h3>), parágrafos (<p>), listas (<ul>, <li>) e outras tags relevantes para garantir uma excelente legibilidade. Não inclua a tag <h1>.

**Texto para aprimorar:**
"""
${textContent}
"""`;
            const parsedJson = await generateAIContentWithRetry(prompt, enhancedContentSchema);

            setLoadingMessage('Conteúdo aprimorado com sucesso!');
            await new Promise(res => setTimeout(res, 1000));
            onContentEnhanced(parsedJson.enhancedContent);
        } catch (e) {
            console.error(e);
            setError('Falha ao aprimorar o resumo. O texto pode ser muito complexo ou o formato retornado pela IA é inválido. Tente novamente.');
            setIsLoading(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content large" onClick={(e) => e.stopPropagation()}>
                {!isLoading ? (
                    <>
                        <h2>Aprimorar Resumo com IA</h2>
                        <p>Cole abaixo o resumo que você deseja melhorar...</p>
                        <textarea
                            placeholder="Cole o texto do resumo aqui..."
                            value={textContent}
                            onChange={(e) => setTextContent(e.target.value)}
                        />
                        {error && <p style={{color: 'var(--danger-accent)', marginTop: '1rem'}}>{error}</p>}
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleEnhance} disabled={!textContent.trim()}>Aprimorar Texto</button>
                        </div>
                    </>
                ) : (
                    <div className="loader-container">
                        <div className="loader"></div>
                        <p>{loadingMessage}</p>
                    </div>
                )}
            </div>
        </div>
    );
};

const AISplitterModal = ({ isOpen, onClose, onSummariesCreated }) => {
    const [isLoading, setIsLoading] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState('');
    const [error, setError] = useState('');
    const [textContent, setTextContent] = useState('');
    const [currentStep, setCurrentStep] = useState(1);
    const [identifiedTitles, setIdentifiedTitles] = useState([]);

    useEffect(() => {
        if (isOpen) {
            setTextContent('');
            setError('');
            setCurrentStep(1);
            setIdentifiedTitles([]);
            setIsLoading(false);
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleIdentifyTitles = async () => {
        if (!textContent.trim()) {
            setError('Por favor, cole o conteúdo do documento.');
            return;
        }
        setIsLoading(true);
        setError('');
        setLoadingMessage('Identificando títulos no documento...');
        try {
            const prompt = `Você é um assistente especialista em estruturação de conteúdo acadêmico. Sua tarefa é analisar um documento e extrair os títulos de todos os resumos individuais com base em um padrão estrutural específico.

**INSTRUÇÃO CRÍTICA:** O padrão para identificar um título é que ele aparece **imediatamente na linha de baixo após o nome da disciplina**, que está em maiúsculas. Por exemplo:
- \`Anatomia III
    Telencefalo\`
- \`Fisiologia III
    Sistema Nervoso Autônomo 1\`

Nos exemplos acima, você deve extrair "Telencefalo" e "Sistema Nervoso Autônomo 1". Ignore o nome da disciplina no seu resultado.

Analise todo o texto abaixo, identifique todos os títulos dos resumos seguindo esta regra.

**Texto para Análise:**
"""
${textContent}
"""`;
            const parsedJson = await generateAIContentWithRetry(prompt, identifyTitlesSchema);
            const uniqueTitles = [...new Set(parsedJson.titles || [])];
            setIdentifiedTitles(uniqueTitles.map((title, index) => ({ id: index, name: title })));
            setCurrentStep(2);
        } catch (e) {
            console.error(e);
            setError('Não foi possível identificar os títulos. Verifique se o texto segue o padrão esperado ou se o modelo está sobrecarregado.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleGenerateSummaries = async () => {
        const finalTitles = identifiedTitles.map(t => t.name.trim()).filter(Boolean);
        if (finalTitles.length === 0) {
            setError("Nenhum título válido para gerar resumos. Adicione ou edite a lista.");
            return;
        }

        setIsLoading(true);
        setError('');
        setLoadingMessage('Gerando conteúdo dos resumos...');

        try {
            const prompt = `Sua tarefa é criar um resumo detalhado para cada título na lista fornecida, usando o documento de texto completo como contexto. Para cada título, localize a seção correspondente no documento e extraia/reescreva o conteúdo. Formate o conteúdo em HTML bem-formado (usando <p>, <ul>, <li>, <strong>, etc.). Retorne uma lista de objetos, cada um contendo o 'title' e seu 'content' em HTML correspondente.

**Lista de Títulos para Processar:**
${JSON.stringify(finalTitles)}

**Documento de Texto Completo:**
"""
${textContent}
"""`;

            const parsedJson = await generateAIContentWithRetry(prompt, splitSummariesSchema);
            if (!parsedJson.summaries || parsedJson.summaries.length === 0) {
                throw new Error("A IA não conseguiu gerar os resumos para os títulos fornecidos.");
            }
            setLoadingMessage(`${parsedJson.summaries.length} resumos criados com sucesso!`);
            await new Promise(res => setTimeout(res, 1500));
            onSummariesCreated(parsedJson.summaries);

        } catch (e) {
            console.error(e);
            setError('Falha ao gerar os resumos. Verifique se os títulos correspondem ao conteúdo do texto.');
            setIsLoading(false);
        }
    };

    const handleTitleNameChange = (id, newName) => {
        setIdentifiedTitles(titles =>
            titles.map(t => t.id === id ? { ...t, name: newName } : t)
        );
    };

    const addTitleField = () => {
        setIdentifiedTitles(titles => [...titles, { id: Date.now(), name: '' }]);
    };

    const removeTitleField = (id) => {
        setIdentifiedTitles(titles => titles.filter(t => t.id !== id));
    };

    const renderStepOne = () => (
        <>
            <h2>Gerar Resumos em Lote com IA</h2>
            <p>**Etapa 1:** Cole o documento da disciplina abaixo. A IA irá identificar e sugerir os títulos dos resumos.</p>
            <div className="modal-form-content" style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: '1rem' }}>
                <div className="form-group">
                    <label htmlFor="summary-full-content">Conteúdo Completo da Disciplina</label>
                    <textarea
                        id="summary-full-content"
                        placeholder="Cole aqui o texto bruto que contém o conteúdo de todos os resumos para esta disciplina..."
                        value={textContent}
                        onChange={(e) => setTextContent(e.target.value)}
                        rows={15}
                        required
                    />
                </div>
            </div>
            {error && <p style={{ color: 'var(--danger-accent)', marginTop: '1rem' }}>{error}</p>}
            <div className="modal-actions">
                <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
                <button className="btn btn-primary" onClick={handleIdentifyTitles} disabled={!textContent.trim()}>1. Identificar Títulos</button>
            </div>
        </>
    );

    const renderStepTwo = () => (
         <>
            <h2>Gerar Resumos em Lote com IA</h2>
            <p>**Etapa 2:** Revise, edite, adicione ou remova os títulos sugeridos. Em seguida, gere os resumos.</p>
            <div className="modal-form-content" style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: '1rem' }}>
                 <div className="form-group">
                    <label>Títulos Sugeridos</label>
                    {identifiedTitles.map((title, index) => (
                        <div key={title.id} className="dynamic-input-group">
                            <input
                                className="input"
                                type="text"
                                value={title.name}
                                onChange={(e) => handleTitleNameChange(title.id, e.target.value)}
                                placeholder={`Título do Resumo ${index + 1}`}
                            />
                            <IconButton onClick={() => removeTitleField(title.id)} className="danger-icon-btn">
                                <DeleteIcon />
                            </IconButton>
                        </div>
                    ))}
                    <button type="button" className="btn btn-secondary btn-sm" onClick={addTitleField}>Adicionar Título</button>
                </div>
            </div>
            {error && <p style={{ color: 'var(--danger-accent)', marginTop: '1rem' }}>{error}</p>}
            <div className="modal-actions">
                 <button className="btn btn-secondary" onClick={() => setCurrentStep(1)}>Voltar</button>
                <button className="btn btn-primary" onClick={handleGenerateSummaries} disabled={identifiedTitles.every(t => t.name.trim() === '')}>2. Gerar Resumos para estes Títulos</button>
            </div>
        </>
    );

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content large" onClick={(e) => e.stopPropagation()}>
                {isLoading ? (
                    <div className="loader-container">
                        <div className="loader"></div>
                        <p>{loadingMessage}</p>
                    </div>
                ) : (
                    currentStep === 1 ? renderStepOne() : renderStepTwo()
                )}
            </div>
        </div>
    );
};

const ReportsDashboard = () => {
    const [reportData, setReportData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [studentsPerTerm, setStudentsPerTerm] = useState([]);
    const [costs, setCosts] = useState(0);

    const formatCurrency = (value) => (value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    const fetchData = async (currentCosts) => {
        setLoading(true);
        try {
            const { data: studentsData, error: studentsError } = await supabase.rpc('get_students_per_term');
            if (studentsError) throw studentsError;
            setStudentsPerTerm(studentsData);

            const { data: statsData, error: statsError } = await supabase.rpc('get_admin_dashboard_stats', { operational_costs: currentCosts });
            if (statsError) throw statsError;
            setReportData(statsData);

        } catch (error) {
            console.error("Erro ao carregar dados do admin:", error);
            alert("Não foi possível carregar os relatórios.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData(costs);
    }, []);

    const handleCostsChange = (e) => setCosts(e.target.value === '' ? 0 : parseFloat(e.target.value));
    const handleUpdateCosts = () => fetchData(costs);

    if (loading) return <div className="loader-container"><div className="loader"></div></div>;
    if (!reportData) return <div>Não foi possível carregar os dados.</div>;

    return (
        <div className="admin-reports">
            <div className="stat-cards-grid">
                <div className="stat-card"><h4>Faturamento Bruto Mensal</h4><p>{formatCurrency(reportData.total_revenue_monthly)}</p></div>
                <div className="stat-card"><h4>Lucro Líquido Mensal</h4><p>{formatCurrency(reportData.net_profit_monthly)}</p></div>
                <div className="stat-card"><h4>Total de Alunos Ativos</h4><p>{reportData.total_students}</p></div>
                <div className="stat-card"><h4>Custo por Aluno</h4><p>{formatCurrency(reportData.monthly_price_per_student)}</p></div>
            </div>

            <div className="admin-section">
                <h2>Alunos por Período</h2>
                <table className="admin-table">
                    <thead><tr><th>Período</th><th>Nº de Alunos</th></tr></thead>
                    <tbody>
                        {studentsPerTerm.map(term => (
                            <tr key={term.term_id}><td>{term.term_name}</td><td>{term.student_count}</td></tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="admin-section">
                <h2>Cálculo de Lucro e Comissões</h2>
                 <div className="costs-input-section">
                    <label htmlFor="costs-input">Custos Operacionais Mensais (ex: servidor, ferramentas)</label>
                    <div className="input-group">
                        <input id="costs-input" type="number" value={costs} onChange={handleCostsChange} className="input" placeholder="R$ 0,00" />
                        <button onClick={handleUpdateCosts} className="btn btn-primary">Recalcular Lucro</button>
                    </div>
                </div>
                <table className="admin-table">
                    <thead>
                        <tr>
                            <th>Embaixador</th>
                            <th>Período</th>
                            <th>Alunos no Período</th>
                            <th>% Comissão</th>
                            <th>Valor a Pagar</th>
                        </tr>
                    </thead>
                    <tbody>
                        {reportData.embaixador_commissions_details?.map((detail, index) => (
                            <tr key={index}>
                                <td>{detail.embaixador_email}</td>
                                <td>{detail.term_name}</td>
                                <td>{detail.students_in_term}</td>
                                <td>{detail.commission_percentage}%</td>
                                <td>{formatCurrency(detail.commission_to_pay)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};


const AdminPanel = ({ onBack }) => {
    const [activeTab, setActiveTab] = useState('reports');

    const UserManagementPanel = () => {
        const [users, setUsers] = useState([]);
        const [loadingUsers, setLoadingUsers] = useState(true);

        const fetchUsers = async () => {
            setLoadingUsers(true);
            try {
                const { data, error } = await supabase.from('profiles').select('id, email, role, status').order('email');
                if (error) throw error;
                setUsers(data || []);
            } catch (error) {
                console.error("Erro ao carregar usuários:", error);
                alert("Não foi possível carregar a lista de usuários.");
            } finally {
                setLoadingUsers(false);
            }
        };

        const handleUpdateUserStatus = async (userId, newStatus) => {
            const { error } = await supabase.from('profiles').update({ status: newStatus }).eq('id', userId);
            if (error) {
                alert(`Falha ao atualizar o status do usuário: ${error.message}`);
            } else {
                fetchUsers();
            }
        };

        useEffect(() => {
            fetchUsers();
        }, []);

        if (loadingUsers) return <div className="loader"></div>;

        return (
            <div className="admin-section">
                <h2>Gerenciamento de Usuários</h2>
                 <table className="admin-table">
                    <thead>
                        <tr>
                            <th>Email</th>
                            <th>Status</th>
                            <th>Ações</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.filter(u => u.role !== 'admin').map(user => (
                            <tr key={user.id}>
                                <td>{user.email}</td>
                                <td>
                                    <span className={`status-badge status-${user.status || 'default'}`}>
                                        {user.status === 'pending_approval' ? 'Pendente' : user.status === 'active' ? 'Ativo' : user.status === 'blocked' ? 'Bloqueado' : 'Indefinido'}
                                    </span>
                                </td>
                                <td className="user-actions">
                                    {user.status !== 'active' && <button className="btn btn-sm btn-success" onClick={() => handleUpdateUserStatus(user.id, 'active')}>Liberar</button>}
                                    {user.status !== 'blocked' && <button className="btn btn-sm btn-danger" onClick={() => handleUpdateUserStatus(user.id, 'blocked')}>Bloquear</button>}
                                    {user.status === 'blocked' && <button className="btn btn-sm btn-secondary" onClick={() => handleUpdateUserStatus(user.id, 'active')}>Desbloquear</button>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    };

    return (
        <div className="container admin-panel">
            <div className="dashboard-header">
                <h1>Painel Administrativo</h1>
                <button className="btn btn-secondary" onClick={onBack}>Voltar</button>
            </div>
            <nav className="tabs-nav admin-tabs">
                <button className={`tab-button ${activeTab === 'reports' ? 'active' : ''}`} onClick={() => setActiveTab('reports')}>Relatórios</button>
                <button className={`tab-button ${activeTab === 'users' ? 'active' : ''}`} onClick={() => setActiveTab('users')}>Usuários</button>
            </nav>
            <div className="tab-content">
                {activeTab === 'reports' && <ReportsDashboard />}
                {activeTab === 'users' && <UserManagementPanel />}
            </div>
        </div>
    );
};


// ALTERADO: Adicionado novas props para os botões e estados de loading
const Dashboard = ({ user, termName, onLogout, subjects, onSelectSubject, onAddSubject, onEditSubject, onDeleteSubject, theme, toggleTheme, searchQuery, onSearchChange, searchResults, onSelectSummary, lastViewed, completedSummaries, onNavigateToAdmin, onGenerateFlashcardsForAll, onGenerateQuizForAll, isBatchLoading, batchLoadingMessage }) => {
  const isSearching = searchQuery.trim() !== '';
  const isAdminOrAmbassador = user.role === 'admin' || user.role === 'embaixador';

  return (
    <div className="container dashboard">
      <div className="dashboard-header">
        <h1>{isSearching ? "Resultados da Busca" : "Início"}</h1>
        <div className="header-actions">
            {user.role === 'admin' && <button className="btn btn-primary" onClick={onNavigateToAdmin}>Painel Admin</button>}
            <ThemeToggle theme={theme} toggleTheme={toggleTheme}/>
            <button className="btn btn-secondary" onClick={onLogout}>Sair</button>
        </div>
      </div>

      <div className="search-bar-container">
          <SearchIcon />
          <input type="text" placeholder="Buscar disciplinas ou resumos..." className="search-input" value={searchQuery} onChange={onSearchChange}/>
      </div>

      {isSearching ? (
        <div className="search-results">
          {searchResults.subjects.length > 0 && <h3>Disciplinas</h3>}
          <div className="subject-grid">
              {searchResults.subjects.map(subject => (
                <div key={subject.id} className="subject-card" style={{ backgroundColor: subject.color }} onClick={() => onSelectSubject(subject)}>
                    <h3>{subject.name}</h3>
                    <p>{subject.summaryCount} resumos</p>
                </div>
            ))}
          </div>
          {searchResults.summaries.length > 0 && <h3>Resumos</h3>}
          <ul className="summary-list">
              {searchResults.summaries.map(summary => (
                  <li key={summary.id} className="summary-list-item" onClick={() => onSelectSummary(summary)}>
                      <div className="summary-list-item-title">{summary.title}</div>
                      <span className="summary-list-item-subject">{summary.subjectName}</span>
                  </li>
              ))}
          </ul>
        </div>
      ) : (
        <>
          {lastViewed.length > 0 && (
            <div className="last-viewed-section">
                <h2>Continue de Onde Parou</h2>
                <div className="last-viewed-grid">
                    {lastViewed.map(summary => (
                        <div key={summary.id} className="last-viewed-card" onClick={() => onSelectSummary(summary)}>
                            <h4>{summary.title}</h4>
                            <p>{summary.subjectName}</p>
                        </div>
                    ))}
                </div>
            </div>
          )}

          {/* NOVO: Container para os botões de ação em lote */}
          {isAdminOrAmbassador && (
            <div className="dashboard-global-actions">
              {isBatchLoading ? (
                <div className="batch-loader">
                  <div className="loader-sm"></div>
                  <p>{batchLoadingMessage}</p>
                </div>
              ) : (
                <>
                  <button className="btn btn-secondary" onClick={onGenerateFlashcardsForAll} disabled={isBatchLoading}>
                    Gerar Flashcards para Faltantes
                  </button>
                  <button className="btn btn-secondary" onClick={onGenerateQuizForAll} disabled={isBatchLoading}>
                    Gerar Questões para Faltantes
                  </button>
                  <button className="btn btn-primary" onClick={onAddSubject}>
                    Adicionar Disciplina
                  </button>
                </>
              )}
            </div>
          )}

          <div className="subject-grid">
            {subjects.map(subject => {
              const subjectSummaries = searchResults.allSummaries.filter(s => s.subject_id === subject.id);
              const completedCount = subjectSummaries.filter(s => completedSummaries.includes(s.id)).length;
              const progress = subjectSummaries.length > 0 ? (completedCount / subjectSummaries.length) * 100 : 0;
              return (
                <div key={subject.id} className="subject-card" style={{ backgroundColor: subject.color }} onClick={() => onSelectSubject(subject)}>
                  <h3>{subject.name}</h3>
                  <div className="subject-card-progress">
                    <p>{completedCount} de {subjectSummaries.length} concluídos</p>
                    <div className="progress-bar"><div className="progress-bar-inner" style={{ width: `${progress}%` }}></div></div>
                  </div>
                  {isAdminOrAmbassador && (
                    <div className="card-actions">
                      <IconButton onClick={(e) => onEditSubject(subject)}><EditIcon /></IconButton>
                      <IconButton onClick={(e) => onDeleteSubject(subject.id)}><DeleteIcon /></IconButton>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
const SubjectModal = ({ isOpen, onClose, onSave, subject, existingSubjects, user, terms }) => {
    const [name, setName] = useState('');
    const [selectedTermId, setSelectedTermId] = useState('');
    const [color, setColor] = useState('');

    useEffect(() => {
        if (isOpen) {
            setName(subject?.name || '');
            // APENAS ADMIN seleciona período, embaixador usa o seu próprio
            setSelectedTermId(subject?.term_id || (user.role === 'admin' ? '' : user?.term_id));
            setColor(subject?.color || subjectColors[0]);
        }
    }, [isOpen, subject, user]);

    if (!isOpen) return null;

    const handleSubmit = (e) => {
        e.preventDefault();

        // A verificação de período só se aplica ao admin, pois ele é o único que pode escolher
        if (user.role === 'admin' && !selectedTermId) {
            alert('Por favor, selecione um período para esta disciplina.');
            return;
        }

        const termIdToSave = user.role === 'admin' ? selectedTermId : user?.term_id;
        onSave({ ...subject, name, color, term_id: termIdToSave });
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <h2>{subject ? 'Editar' : 'Adicionar'} Disciplina</h2>
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="subject-name">Nome da Disciplina</label>
                        <input id="subject-name" className="input" type="text" value={name} onChange={e => setName(e.target.value)} required />
                    </div>

                    {/* Seletor de período visível APENAS para o admin */}
                    {user.role === 'admin' && (
                        <div className="form-group">
                            <label htmlFor="term-select-subject">Período</label>
                            <select
                                id="term-select-subject"
                                className="select-input"
                                value={selectedTermId}
                                onChange={(e) => setSelectedTermId(e.target.value)}
                                required
                            >
                                <option value="" disabled>Selecione um período...</option>
                                {terms.map(term => (
                                    <option key={term.id} value={term.id}>{term.name}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    <div className="form-group">
                        <label>Cor da Disciplina</label>
                        <div className="color-selector">
                            {subjectColors.map((c, index) => (
                                <div
                                    key={index}
                                    className={`color-swatch ${color === c ? 'selected' : ''}`}
                                    style={{ backgroundColor: c }}
                                    onClick={() => setColor(c)}
                                />
                            ))}
                        </div>
                    </div>

                    <div className="modal-actions">
                        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
                        <button type="submit" className="btn btn-primary">Salvar</button>
                    </div>
                </form>
            </div>
        </div>
    );
};

const SimpleRichTextEditor = ({ value, onChange, textareaRef }) => {
    const format = (tag) => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selectedText = value.substring(start, end);
        const newText = `${value.substring(0, start)}<${tag}>${selectedText}</${tag}>${value.substring(end)}`;
        onChange(newText);
    };

    return (
        <div className="editor-container">
            <div className="editor-toolbar">
                <button type="button" onClick={() => format('strong')}><b>B</b></button>
                <button type="button" onClick={() => format('em')}><i>I</i></button>
                <button type="button" onClick={() => format('h2')}>H2</button>
                <button type="button" onClick={() => format('h3')}>H3</button>
                <button type="button" onClick={() => format('p')}>P</button>
            </div>
            <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder="Comece a escrever o conteúdo do resumo aqui..."
            />
        </div>
    );
};

const SummaryModal = ({ isOpen, onClose, onSave, summary, subjectId }) => {
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [video, setVideo] = useState('');
    const [isAIEnhanceModalOpen, setAIEnhanceModalOpen] = useState(false);
    const textareaRef = useRef(null);

    useEffect(() => {
        if (isOpen) {
            setTitle(summary?.title || '');
            setContent(String(summary?.content || ''));
            setVideo(summary?.video || '');
        }
    }, [isOpen, summary]);

    if (!isOpen) return null;

    const handleSubmit = (e) => {
        e.preventDefault();
        onSave({ ...summary, title, content, video, subject_id: subjectId });
    };

    return (
        <>
            <div className="modal-overlay" onClick={onClose}>
                <div className="modal-content large" onClick={e => e.stopPropagation()}>
                    <h2>{summary ? 'Editar' : 'Adicionar'} Resumo</h2>
                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label htmlFor="summary-title">Título</label>
                            <input id="summary-title" className="input" type="text" value={title} onChange={e => setTitle(e.target.value)} required />
                        </div>
                        <div className="form-group">
                            <label>Conteúdo</label>
                            <SimpleRichTextEditor value={content} onChange={setContent} textareaRef={textareaRef} />
                        </div>

                         <div className="form-group">
                            <label htmlFor="summary-video-link">Link do Vídeo do Google Drive</label>
                            <input
                                id="summary-video-link"
                                className="input"
                                type="url"
                                placeholder="https://drive.google.com/file/d/..."
                                value={video}
                                onChange={e => setVideo(e.target.value)}
                            />
                        </div>

                        <div className="modal-actions">
                             <button type="button" className="btn btn-secondary" onClick={() => setAIEnhanceModalOpen(true)}>Aprimorar com IA</button>
                            <div>
                                <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
                                <button type="submit" className="btn btn-primary">Salvar</button>
                            </div>
                        </div>
                    </form>
                </div>
            </div>
            {isAIEnhanceModalOpen && <AIEnhancementModal onClose={() => setAIEnhanceModalOpen(false)} onContentEnhanced={(enhanced) => { setContent(enhanced); setAIEnhanceModalOpen(false);}} />}
        </>
    );
};

const SummaryListView = ({ subject, summaries, onSelectSummary, onAddSummary, onEditSummary, onDeleteSummary, user, completedSummaries, onAISplit, onReorderSummaries, onGenerateFlashcardsForAll, onGenerateQuizForAll, isBatchLoading, batchLoadingMessage }) => {
    const handleDragEnd = (result) => {
        const { destination, source } = result;
        if (!destination || (destination.droppableId === source.droppableId && destination.index === source.index)) {
            return;
        }
        onReorderSummaries(source.index, destination.index);
    };
    const isAdminOrAmbassador = user.role === 'admin' || user.role === 'embaixador';

    return (
        <div className="container summary-list-view">
            <div className="dashboard-header">
                <h1>{subject.name}</h1>
                 {isAdminOrAmbassador && (
                    isBatchLoading ? (
                         <div className="batch-loader">
                            <div className="loader-sm"></div>
                            <p>{batchLoadingMessage}</p>
                        </div>
                    ) : (
                        <div className="dashboard-main-actions">
                             <button className="btn btn-secondary" onClick={onGenerateFlashcardsForAll}>Gerar Flashcards para Todos</button>
                             <button className="btn btn-secondary" onClick={onGenerateQuizForAll}>Gerar Questões para Todas</button>
                             <button className="btn btn-secondary" onClick={onAISplit}>
                               Adicionar Resumos em Lote
                            </button>
                            <button className="btn btn-primary" onClick={onAddSummary}>
                               Adicionar Resumo
                            </button>
                        </div>
                    )
                )}
            </div>

            {summaries.length > 0 ? (
                <DragDropContext onDragEnd={handleDragEnd}>
                    <Droppable droppableId="summaries-list">
                        {(provided) => (
                            <ul className="summary-list" {...provided.droppableProps} ref={provided.innerRef}>
                                {summaries.map((summary, index) => {
                                    const isCompleted = completedSummaries.includes(summary.id);
                                    return (
                                        <Draggable key={summary.id} draggableId={String(summary.id)} index={index} isDragDisabled={!isAdminOrAmbassador}>
                                            {(provided, snapshot) => (
                                                <li
                                                    ref={provided.innerRef}
                                                    {...provided.draggableProps}
                                                    {...provided.dragHandleProps}
                                                    className={`summary-list-item ${snapshot.isDragging ? 'is-dragging' : ''}`}
                                                    style={{ ...provided.draggableProps.style }}
                                                >
                                                    <div className="summary-list-item-title" onClick={() => onSelectSummary(summary)}>
                                                        {isCompleted && <span className="completion-check"><CheckCircleIcon /></span>}
                                                        {summary.title}
                                                    </div>
                                                    {isAdminOrAmbassador && (
                                                        <div className="summary-list-item-actions">
                                                            <IconButton onClick={() => onEditSummary(summary)}><EditIcon/></IconButton>
                                                            <IconButton onClick={() => onDeleteSummary(summary.id)}><DeleteIcon/></IconButton>
                                                        </div>
                                                    )}
                                                </li>
                                            )}
                                        </Draggable>
                                    );
                                })}
                                {provided.placeholder}
                            </ul>
                        )}
                    </Droppable>
                </DragDropContext>
            ) : (
                <div className="empty-state">
                    <h2>Nenhum resumo aqui ainda</h2>
                    <p>Que tal começar adicionando o primeiro resumo para esta disciplina?</p>
                    {isAdminOrAmbassador && (
                        <div className="empty-state-actions">
                             <button className="btn btn-secondary" onClick={onAISplit}>Adicionar Resumos em Lote</button>
                            <button className="btn btn-primary" onClick={onAddSummary}>Criar Manualmente</button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};


const FlashcardView = ({ flashcards, summaryId }) => {
    const [deck, setDeck] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isFlipped, setIsFlipped] = useState(false);
    const [isFinished, setIsFinished] = useState(false);

    useEffect(() => {
        const safeFlashcards = Array.isArray(flashcards) ? flashcards : [];
        setDeck(safeFlashcards.map(f => ({...f, id: Math.random()})).sort(() => Math.random() - 0.5));
        setCurrentIndex(0);
        setIsFlipped(false);
        setIsFinished(false);
    }, [flashcards, summaryId]);

    const handleFlip = () => setIsFlipped(prev => !prev);

    const processAnswer = (knows) => {
        setIsFlipped(false);

        setTimeout(() => {
            if (knows) {
                const newDeck = deck.filter((_, index) => index !== currentIndex);
                if (newDeck.length === 0) {
                    setIsFinished(true);
                } else {
                    setDeck(newDeck);
                    setCurrentIndex(currentIndex % newDeck.length);
                }
            } else {
                setCurrentIndex((currentIndex + 1) % deck.length);
            }
        }, 300);
    };

    const handleAnswer = (knows) => {
        if (!isFlipped) {
            setIsFlipped(true);
            setTimeout(() => processAnswer(knows), 1000);
        } else {
            processAnswer(knows);
        }
    };

    const handleReset = () => {
        const safeFlashcards = Array.isArray(flashcards) ? flashcards : [];
        setDeck(safeFlashcards.map(f => ({...f, id: Math.random()})).sort(() => Math.random() - 0.5));
        setCurrentIndex(0);
        setIsFlipped(false);
        setIsFinished(false);
    };

    if (isFinished) {
        return (
            <div className="flashcard-container finished-deck">
                <h2>Parabéns!</h2>
                <p>Você revisou todos os flashcards.</p>
                <button className="btn btn-primary" onClick={handleReset}>Estudar Novamente</button>
            </div>
        );
    }

    if (!deck || deck.length === 0) {
        return <div className="flashcard-container"><p>Nenhum flashcard para exibir.</p></div>;
    }

    const currentCard = deck[currentIndex];

    return (
        <div className="flashcard-container">
            <div className="flashcard-progress">
                <span>{deck.length} restantes</span>
            </div>
            <div className={`flashcard ${isFlipped ? 'is-flipped' : ''}`} onClick={handleFlip}>
                <div className="flashcard-inner">
                    <div className="flashcard-front">
                        <p>{currentCard.front}</p>
                    </div>
                    <div className="flashcard-back">
                        <p>{currentCard.back}</p>
                    </div>
                </div>
            </div>
            <div className="flashcard-actions">
                <button className="btn btn-action-dont-know" onClick={() => handleAnswer(false)}>Não Lembro</button>
                <button className="btn btn-action-know" onClick={() => handleAnswer(true)}>Já Domino</button>
            </div>
        </div>
    );
};

const TableOfContents = ({ content }) => {
    const [headings, setHeadings] = useState([]);

    useEffect(() => {
        const summaryContentElement = document.querySelector('.summary-content');
        if (!summaryContentElement) return;

        const newHeadings = [];
        summaryContentElement.querySelectorAll('h2, h3').forEach((h, index) => {
            const text = h.textContent;
            const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + `-${index}`;
            h.id = id;
            newHeadings.push({
                id,
                text,
                level: h.tagName.toLowerCase() === 'h2' ? 1 : 2
            });
        });
        setHeadings(newHeadings);
    }, [content]);

    const handleTocClick = (e, id) => {
        e.preventDefault();
        const element = document.getElementById(id);
        if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    };

    if (headings.length === 0) return null;

    return (
        <aside className="toc-container">
            <h4>Neste Resumo</h4>
            <ul>
                {headings.map(h => (
                    <li key={h.id} className={`toc-level-${h.level}`}>
                        <a href={`#${h.id}`} onClick={(e) => handleTocClick(e, h.id)}>{h.text}</a>
                    </li>
                ))}
            </ul>
        </aside>
    );
};

const GoogleDrivePlayer = ({ url }) => {
    const embedUrl = getGoogleDriveEmbedUrl(url);
    if (!embedUrl) return <p>Link do Google Drive inválido.</p>;
    return (
        <div className="youtube-player-container">
            <iframe
                src={embedUrl}
                allow="autoplay; fullscreen"
                frameBorder="0"
                title="Vídeo do Google Drive"
                allowFullScreen>
            </iframe>
        </div>
    );
};

const SummaryDetailView = ({ summary, subject, onEdit, onDelete, onGenerateQuiz, onToggleComplete, isCompleted, onGetExplanation, user, onAIUpdate, onGenerateFlashcards }) => {
    const [activeTab, setActiveTab] = useState('summary');
    const [isGenerating, setIsGenerating] = useState(false);
    const [isTocVisible, setIsTocVisible] = useState(true);
    const isAdminOrAmbassador = user.role === 'admin' || user.role === 'embaixador';

    useEffect(() => {
        setIsTocVisible(true);
    }, [summary]);

    const handleGenerateQuiz = async () => {
        if (window.confirm("Tem certeza que deseja gerar novas questões? As questões atuais serão substituídas.")) {
            setIsGenerating(true);
            await onGenerateQuiz();
            setIsGenerating(false);
        }
    };

    const handleGenerateFlashcards = async () => {
        if (window.confirm("Tem certeza que deseja gerar novos flashcards? Os flashcards atuais serão substituídos.")) {
            setIsGenerating(true);
            await onGenerateFlashcards();
            setIsGenerating(false);
        }
    }

    const availableTabs = [
        { id: 'summary', label: 'Resumo', condition: true },
        { id: 'video', label: 'Vídeo', condition: !!summary.video },
        { id: 'flashcards', label: 'Flashcards', condition: (summary.flashcards?.length > 0) || isAdminOrAmbassador },
        { id: 'questions', label: 'Questões', condition: (summary.questions?.length > 0) || isAdminOrAmbassador }
    ].filter(tab => tab.condition);

    return (
        <div className="summary-detail-layout">
            {activeTab === 'summary' && isTocVisible && <TableOfContents content={summary.content} />}
            <div className="summary-detail-view">
                <div className="summary-header">
                    {activeTab === 'summary' && (
                        <IconButton onClick={() => setIsTocVisible(!isTocVisible)} className="toc-toggle-btn">
                            <ListIcon />
                        </IconButton>
                    )}
                    <h1 className="summary-detail-title">{summary.title}</h1>
                    <div className="summary-detail-actions">
                        <button className="btn btn-secondary" onClick={onToggleComplete}>
                            {isCompleted ? <CheckCircleIcon /> : null}
                            {isCompleted ? 'Concluído' : 'Marcar como Concluído'}
                        </button>
                        {isAdminOrAmbassador && (
                            <>
                                <button className="btn btn-secondary" onClick={onAIUpdate}><SparklesIcon />Atualizar com IA</button>
                                <IconButton onClick={onEdit}><EditIcon/></IconButton>
                                <IconButton onClick={onDelete}><DeleteIcon/></IconButton>
                            </>
                        )}
                    </div>
                </div>

                <nav className="tabs-nav">
                    {availableTabs.map(tab => (
                        <button
                            key={tab.id}
                            className={`tab-button ${activeTab === tab.id ? 'active' : ''}`}
                            onClick={() => setActiveTab(tab.id)}
                            aria-controls={`tab-panel-${tab.id}`}
                            role="tab"
                        >
                            {tab.label}
                        </button>
                    ))}
                </nav>

                <div className="tab-content">
                    <div
                        id="tab-panel-summary"
                        role="tabpanel"
                        className={`summary-content ${activeTab === 'summary' ? '' : 'hidden'}`}
                        style={{ '--subject-color': subject?.color || '#6c757d' }}
                    >
                            <div dangerouslySetInnerHTML={{ __html: summary.content }} />
                    </div>

                    <div id="tab-panel-video" role="tabpanel" className={activeTab === 'video' ? '' : 'hidden'}>
                        {summary.video && <GoogleDrivePlayer url={summary.video} />}
                    </div>

                    <div id="tab-panel-flashcards" role="tabpanel" className={activeTab === 'flashcards' ? '' : 'hidden'}>
                        <ProtectedContent>
                            {(summary.flashcards?.length > 0) ? (
                                <>
                                    <FlashcardView flashcards={summary.flashcards} summaryId={summary.id} />
                                    {isAdminOrAmbassador && (
                                        <div className="update-content-container">
                                             <button className="btn btn-secondary" onClick={handleGenerateFlashcards} disabled={isGenerating}>
                                                {isGenerating ? 'Atualizando...' : 'Atualizar Flashcards'}
                                            </button>
                                        </div>
                                    )}
                                </>
                            ) : (
                                isAdminOrAmbassador && (
                                    <div className="quiz-container empty-quiz">
                                        <p>Ainda não há flashcards para este resumo.</p>
                                        <button className="btn btn-primary" onClick={handleGenerateFlashcards} disabled={isGenerating}>
                                            {isGenerating ? 'Gerando Flashcards...' : 'Gerar Flashcards com IA'}
                                        </button>
                                    </div>
                                )
                            )}
                        </ProtectedContent>
                    </div>

                    <div id="tab-panel-questions" role="tabpanel" className={activeTab === 'questions' ? '' : 'hidden'}>
                        <ProtectedContent>
                            {summary.questions?.length > 0 ? (
                                 <>
                                    <QuizView questions={summary.questions} onGetExplanation={onGetExplanation} />
                                    {isAdminOrAmbassador && (
                                        <div className="update-content-container">
                                            <button className="btn btn-secondary" onClick={handleGenerateQuiz} disabled={isGenerating}>
                                                {isGenerating ? 'Atualizando...' : 'Atualizar Questões'}
                                            </button>
                                        </div>
                                    )}
                                </>
                            ) : (
                                isAdminOrAmbassador && (
                                    <div className="quiz-container empty-quiz">
                                        <p>Ainda não há questões para este resumo.</p>
                                        <button className="btn btn-primary" onClick={handleGenerateQuiz} disabled={isGenerating}>
                                            {isGenerating ? 'Gerando Quiz...' : 'Gerar Quiz com IA'}
                                        </button>
                                    </div>
                                )
                            )}
                        </ProtectedContent>
                    </div>
                </div>
            </div>
        </div>
    );
};

const TermSelector = ({ user, terms, onTermUpdate }) => {
    const [selectedTerm, setSelectedTerm] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSave = async () => {
        if (!selectedTerm) {
            alert("Por favor, selecione um termo.");
            return;
        }
        setLoading(true);
        await onTermUpdate(selectedTerm);
        setLoading(false);
    };

    return (
        <div className="login-screen">
            <div className="login-card">
                <h1>Bem-vindo(a)!</h1>
                <p>Para começar, selecione o seu período atual.</p>
                <div className="form-group">
                    <label htmlFor="term-select">Seu Período</label>
                    <select
                        id="term-select"
                        className="select-input"
                        value={selectedTerm}
                        onChange={(e) => setSelectedTerm(e.target.value)}
                    >
                        <option value="" disabled>Selecione...</option>
                        {terms.map(term => (
                            <option key={term.id} value={term.id}>{term.name}</option>
                        ))}
                    </select>
                </div>
                <button onClick={handleSave} className="btn btn-primary" disabled={loading}>
                    {loading ? "Salvando..." : "Salvar e Continuar"}
                </button>
            </div>
        </div>
    );
};

// --- TELAS DE STATUS DO USUÁRIO ---
const PendingApprovalScreen = () => (
    <div className="login-screen">
        <div className="login-card">
            <h1>Med<span>flix</span></h1>
            <h2>Aguardando Liberação</h2>
            <p style={{ textAlign: 'center', lineHeight: '1.6' }}>
                Seu cadastro foi recebido. Para concluir e liberar seu acesso, entre em contato pelo WhatsApp com o número abaixo e envie seu comprovante de pagamento.
            </p>
            <div className="contact-info">
                <strong>(14) 99872-9082</strong>
            </div>
            <a
                href="https://wa.me/5514998729082"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
                style={{marginTop: '1.5rem', width: '100%', textDecoration: 'none'}}
            >
                Contatar Suporte via WhatsApp
            </a>
            <button className="btn btn-secondary" onClick={() => supabase.auth.signOut()} style={{marginTop: '0.5rem', width: '100%'}}>
                Sair
            </button>
        </div>
    </div>
);

const BlockedScreen = () => (
    <div className="login-screen">
        <div className="login-card">
            <h1>Med<span>flix</span></h1>
            <h2>Acesso Bloqueado</h2>
            <p>Sua conta foi bloqueada. Por favor, entre em contato com o suporte para mais informações.</p>
            <button className="btn btn-secondary" onClick={() => supabase.auth.signOut()} style={{marginTop: '1rem', width: '100%'}}>
                Sair
            </button>
        </div>
    </div>
);

// --- COMPONENTE DE PROTEÇÃO DE CONTEÚDO ---
const ProtectedContent = ({ children }) => {
  const preventActions = (e) => e.preventDefault();
  const wrapperRef = useRef(null);

  useEffect(() => {
    const element = wrapperRef.current;
    if (element) {
      element.addEventListener('contextmenu', preventActions);
      element.addEventListener('copy', preventActions);
      element.addEventListener('selectstart', preventActions);
    }
    return () => {
      if (element) {
        element.removeEventListener('contextmenu', preventActions);
        element.removeEventListener('copy', preventActions);
        element.removeEventListener('selectstart', preventActions);
      }
    };
  }, []);

  return <div ref={wrapperRef}>{children}</div>;
};


// --- COMPONENTE PRINCIPAL APP ---
const App = () => {
  // States de UI e Autenticação
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [terms, setTerms] = useState([]);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const [view, setView] = useState('dashboard');
  const [currentSubjectId, setCurrentSubjectId] = useState(null);
  const [currentSummaryId, setCurrentSummaryId] = useState(null);

  // States de Dados
  const [subjects, setSubjects] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [completedSummaries, setCompletedSummaries] = useState([]);
  const [lastViewed, setLastViewed] = useState([]);

  // States de Modais, Loading e Filtros
  const [isSubjectModalOpen, setSubjectModalOpen] = useState(false);
  const [isSummaryModalOpen, setSummaryModalOpen] = useState(false);
  const [isAISplitterModalOpen, setAISplitterModalOpen] = useState(false);
  const [isAIUpdateModalOpen, setAIUpdateModalOpen] = useState(false);
  const [editingSubject, setEditingSubject] = useState(null);
  const [editingSummary, setEditingSummary] = useState(null);
  const [isBatchLoading, setIsBatchLoading] = useState(false);
  const [batchLoadingMessage, setBatchLoadingMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTermForAdmin, setSelectedTermForAdmin] = useState(null);


  const fetchUserProgress = async (userId) => {
    const { data, error } = await supabase.from('user_summary_progress').select('summary_id').eq('user_id', userId);
    if (error) console.error("Erro ao buscar progresso do usuário:", error);
    else setCompletedSummaries(data.map(item => item.summary_id));
  };

  useEffect(() => {
    const checkUserSession = async () => {
      setLoading(true);
      try {
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        setSession(currentSession);

        if (currentSession?.user) {
            const { data: profileData } = await supabase.from('profiles').select('*').eq('id', currentSession.user.id).single();
            const fullUser = { ...currentSession.user, ...profileData };
            setUser(fullUser);

            if (fullUser.status === 'active') {
                await fetchUserProgress(currentSession.user.id);
                // Admin e embaixador podem ter term_id, mas a lógica de fetch é diferente
                if (fullUser.role === 'admin') {
                    await fetchAppData(null, 'admin'); // Admin vê tudo
                } else if (fullUser.term_id) { // Embaixador e Aluno
                    await fetchAppData(fullUser.term_id, fullUser.role);
                }
            }
        } else {
            setUser(null);
            setSubjects([]);
            setSummaries([]);
            setCompletedSummaries([]);
        }
      } catch (error) {
        console.error("Erro ao verificar sessão:", error);
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    checkUserSession();

    const { data: { subscription: authListener } } = supabase.auth.onAuthStateChange((_event, session) => {
        checkUserSession();
    });

    const fetchTerms = async () => {
        const { data } = await supabase.from('terms').select('*').order('id');
        setTerms(data || []);
    };
    fetchTerms();

    return () => authListener.unsubscribe();
  }, []);


  const fetchAppData = async (termId, userRole) => {
    let subjectsQuery = supabase.from('subjects').select('*');

    // Admin vê todas as disciplinas, embaixador e aluno veem apenas as do seu termo
    if (userRole !== 'admin') {
      subjectsQuery = subjectsQuery.eq('term_id', termId);
    }

    const { data: subjectsData, error: subjectsError } = await subjectsQuery;
    if (subjectsError) console.error("Erro ao buscar disciplinas:", subjectsError);
    setSubjects(subjectsData || []);

    // A busca de resumos pode continuar global, pois serão filtrados na UI
    // com base nas disciplinas já filtradas
    const { data: summariesData, error: summariesError } = await supabase.from('summaries').select('*').order('position', { ascending: true });
    if (summariesError) console.error("Erro ao buscar resumos:", summariesError);

    const parseJsonField = (field, fallback = []) => {
        if (typeof field === 'string') { try { const parsed = JSON.parse(field); return Array.isArray(parsed) ? parsed : fallback; } catch (e) { return fallback; } }
        return Array.isArray(field) ? field : fallback;
    };
    setSummaries((summariesData || []).map(s => ({ ...s, questions: parseJsonField(s.questions), flashcards: parseJsonField(s.flashcards) })));
  }

  useEffect(() => {
    document.body.className = theme === 'light' ? 'light-mode' : '';
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    if (user) {
      const savedLastViewed = localStorage.getItem(`lastViewed_${user.id}`);
      if(savedLastViewed) setLastViewed(JSON.parse(savedLastViewed));
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      localStorage.setItem(`lastViewed_${user.id}`, JSON.stringify(lastViewed));
    }
  }, [lastViewed, user]);

  const handleLogout = () => supabase.auth.signOut();
  const handleSelectSubject = (subject) => { setCurrentSubjectId(subject.id); setView('subject'); };
  const handleSelectSummary = (summary) => {
    setCurrentSummaryId(summary.id);
    setView('summary');
    setLastViewed(prev => {
        const otherSummaries = prev.filter(s => s.id !== summary.id);
        const subjectName = subjects.find(s => s.id === summary.subject_id)?.name || '';
        return [{...summary, subjectName}, ...otherSummaries].slice(0, 3);
    });
  };

  const handleBackToDashboard = () => { setView('dashboard'); setCurrentSubjectId(null); setCurrentSummaryId(null); }
  const handleBackToSubject = () => { setCurrentSummaryId(null); setView('subject'); };

  const handleTermUpdate = async (newTermId) => {
      const { data, error } = await supabase.from('profiles').update({ term_id: newTermId }).eq('id', user.id).select().single();
      if (error) { alert("Erro ao salvar o termo."); }
      else if (data) {
          const updatedUser = { ...user, ...data };
          setUser(updatedUser);
          fetchAppData(newTermId, updatedUser.role);
      }
  };

  const handleSaveSubject = async (subjectData) => {
    if (!subjectData.term_id) { alert("O período da disciplina não foi especificado."); return; }
    if (subjectData.id) {
        const { data, error } = await supabase.from('subjects').update({ name: subjectData.name, color: subjectData.color, term_id: subjectData.term_id }).eq('id', subjectData.id).select().single();
        if (error) alert(error.message);
        else if (data) setSubjects(subjects.map(s => s.id === data.id ? data : s));
    } else {
        const { data, error } = await supabase.from('subjects').insert({ name: subjectData.name, color: subjectData.color, user_id: session.user.id, term_id: subjectData.term_id }).select().single();
        if (error) alert(error.message);
        else if (data) setSubjects([...subjects, data]);
    }
    setSubjectModalOpen(false);
    setEditingSubject(null);
  };

  const handleDeleteSubject = async (subjectId) => {
    if (window.confirm("Tem certeza que deseja excluir esta disciplina e todos os seus resumos?")) {
        await supabase.from('summaries').delete().eq('subject_id', subjectId);
        const { error } = await supabase.from('subjects').delete().eq('id', subjectId);
        if (error) alert(error.message);
        else {
          setSubjects(subjects.filter(s => s.id !== subjectId));
          setSummaries(summaries.filter(s => s.subject_id !== subjectId));
        }
    }
  };

  const handleSaveSummary = async (summaryData) => {
    const isNew = !summaryData.id;
    const position = isNew ? summaries.filter(s => s.subject_id === summaryData.subject_id).length : summaryData.position;
    const payload = { ...summaryData, user_id: session.user.id, position };

    if (isNew) {
        const { data, error } = await supabase.from('summaries').insert(payload).select().single();
        if (error) alert(error.message);
        else if (data) setSummaries([...summaries, data]);
    } else {
        // --- CORREÇÃO APLICADA AQUI ---
        // 1. Apenas faz o update, sem o .select().single()
        const { error } = await supabase.from('summaries').update(payload).eq('id', summaryData.id);

        if (error) {
            alert(error.message);
        } else {
            // 2. Se não houve erro, atualiza o estado local com o `payload` que já temos
            setSummaries(summaries.map(s => s.id === payload.id ? payload : s));
        }
    }
    setSummaryModalOpen(false);
    setEditingSummary(null);
  };


  const handleDeleteSummary = async (summaryId) => {
      if (window.confirm("Tem certeza que deseja excluir este resumo?")) {
          const { error } = await supabase.from('summaries').delete().eq('id', summaryId);
          if (error) alert(error.message);
          else { setSummaries(summaries.filter(s => s.id !== summaryId)); handleBackToSubject(); }
      }
  };

  const handleSplitAndSaveSummaries = async (newSummaries) => {
    if (!currentSubjectId) { alert("Nenhuma disciplina selecionada."); setAISplitterModalOpen(false); return; }
    const startPosition = summaries.filter(s => s.subject_id === currentSubjectId).length;
    const summariesPayload = newSummaries.map((s, i) => ({ ...s, subject_id: currentSubjectId, user_id: session.user.id, position: startPosition + i }));
    const { data, error } = await supabase.from('summaries').insert(summariesPayload).select();
    if (error) { alert("Falha ao salvar os novos resumos."); console.error(error); }
    else if (data) { setSummaries(prev => [...prev, ...data]); alert(`${data.length} resumos criados!`); }
    setAISplitterModalOpen(false);
  };

  const handleUpdateSummaryContent = async (summaryId, newContent) => {
      const { data, error } = await supabase.from('summaries').update({ content: newContent }).eq('id', summaryId).select().single();
      if (error) alert(error.message);
      else if (data) setSummaries(summaries.map(s => s.id === data.id ? data : s));
      setAIUpdateModalOpen(false);
  };

  const handleReorderSummaries = async (startIndex, endIndex) => {
    const subjectSummaries = summaries.filter(s => s.subject_id === currentSubjectId).sort((a, b) => a.position - b.position);
    const [removed] = subjectSummaries.splice(startIndex, 1);
    subjectSummaries.splice(endIndex, 0, removed);
    const updatedSummaries = subjectSummaries.map((s, index) => ({ ...s, position: index }));
    setSummaries(prev => [...prev.filter(s => s.subject_id !== currentSubjectId), ...updatedSummaries]);
    const updates = updatedSummaries.map(s => supabase.from('summaries').update({ position: s.position }).eq('id', s.id));
    const { error } = await Promise.all(updates);
    if (error) alert("Não foi possível salvar a nova ordem.");
  };

  const handleGenerateQuiz = async () => {
    const summary = summaries.find(s => s.id === currentSummaryId);
    if (!summary) return;
    try {
        const prompt = `Você é um especialista em criar questões para provas de residência médica. Baseado estritamente no conteúdo do resumo a seguir, crie uma lista de no mínimo 10 questões de múltipla escolha de alto nível. As questões devem ser complexas, mesclando diferentes formatos (ex: caso clínico curto, "qual das seguintes NÃO é", etc.). Cada questão deve ter 4 alternativas plausíveis, mas apenas uma correta. Forneça também um comentário explicativo para a resposta correta, justificando-a com base no texto do resumo. Resumo: """${summary.content.replace(/<[^>]*>?/gm, ' ')}"""`;
        const parsedJson = await generateAIContentWithRetry(prompt, quizSchema);
        const { data, error } = await supabase.from('summaries').update({ questions: parsedJson.questions }).eq('id', currentSummaryId).select().single();
        if (error) throw error;
        setSummaries(summaries.map(s => s.id === currentSummaryId ? data : s));
    } catch (e) { console.error("Erro ao gerar/salvar quiz:", e); alert("Falha ao gerar o quiz."); }
  };

  const handleGenerateFlashcards = async () => {
    const summary = summaries.find(s => s.id === currentSummaryId);
    if (!summary) return;
    try {
        const prompt = `Baseado no resumo sobre "${summary.title}", crie flashcards para estudo. Formato pergunta-e-resposta (frente e verso). Priorize conceitos-chave, definições, mecanismos, causas, consequências, classificações e relações clínicas. EVITE valores numéricos específicos. Resumo: """${summary.content.replace(/<[^>]*>?/gm, ' ')}"""`;
        const parsedJson = await generateAIContentWithRetry(prompt, flashcardsSchema);
        const { data, error } = await supabase.from('summaries').update({ flashcards: parsedJson.flashcards }).eq('id', currentSummaryId).select().single();
        if (error) throw error;
        setSummaries(summaries.map(s => s.id === currentSummaryId ? data : s));
    } catch (e) { console.error("Erro ao gerar/salvar flashcards:", e); alert("Falha ao gerar os flashcards."); }
  };

    const generateForAll = async (contentType) => {
        const isFlashcards = contentType === 'flashcards';
        const summariesToProcess = summaries.filter(s => s.subject_id === currentSubjectId && (!s[contentType] || s[contentType].length === 0));
        if (summariesToProcess.length === 0) { alert(`Não há resumos sem ${contentType} nesta disciplina.`); return; }

        setIsBatchLoading(true);
        const updatedSummaries = [];
        try {
            for (let i = 0; i < summariesToProcess.length; i++) {
                const summary = summariesToProcess[i];
                setBatchLoadingMessage(`Gerando ${contentType} para "${summary.title}" (${i + 1}/${summariesToProcess.length})...`);
                const prompt = isFlashcards ? `Baseado no resumo sobre "${summary.title}", crie flashcards para estudo...` : `Baseado no resumo, crie questões de múltipla escolha...`;
                const schema = isFlashcards ? flashcardsSchema : quizSchema;
                const parsedJson = await generateAIContentWithRetry(prompt.replace('...', `Resumo: """${summary.content.replace(/<[^>]*>?/gm, ' ')}"""`), schema);
                updatedSummaries.push({ id: summary.id, [contentType]: parsedJson[isFlashcards ? 'flashcards' : 'questions'] });
            }
            setBatchLoadingMessage("Salvando no banco de dados...");
            const updatePromises = updatedSummaries.map(s => supabase.from('summaries').update({ [contentType]: s[contentType] }).eq('id', s.id));
            await Promise.all(updatePromises);
            setSummaries(prev => prev.map(s => ({ ...s, ...updatedSummaries.find(u => u.id === s.id) })));
            alert(`${contentType} gerados para ${updatedSummaries.length} resumos!`);
        } catch (e) { console.error(`Erro na geração em lote de ${contentType}:`, e); alert("Ocorreu um erro durante a geração em lote."); }
        finally { setIsBatchLoading(false); setBatchLoadingMessage(''); }
    };

    // NOVO: Lógica centralizada para gerar conteúdo para todos os resumos faltantes
    const handleGenerateContentForAllMissing = async (contentType) => {
        const visibleSubjectIds = new Set(subjectsForUser.map(s => s.id));
        const summariesToProcess = summaries.filter(s =>
            visibleSubjectIds.has(s.subject_id) &&
            (!s[contentType] || s[contentType].length === 0)
        );

        if (summariesToProcess.length === 0) {
            const contentName = contentType === 'flashcards' ? 'flashcards' : 'questões';
            alert(`Não há resumos sem ${contentName} para gerar.`);
            return;
        }

        const confirm = window.confirm(`Isso irá gerar ${contentType} para ${summariesToProcess.length} resumo(s). Deseja continuar?`);
        if (!confirm) return;

        setIsBatchLoading(true);

        try {
            for (const [index, summary] of summariesToProcess.entries()) {
                const isFlashcards = contentType === 'flashcards';
                const contentName = isFlashcards ? 'Flashcards' : 'Questões';
                setBatchLoadingMessage(`Gerando ${contentName} para "${summary.title}" (${index + 1}/${summariesToProcess.length})...`);

                const prompt = isFlashcards
                    ? `Baseado no resumo sobre "${summary.title}", crie flashcards para estudo. Formato pergunta-e-resposta (frente e verso). Priorize conceitos-chave, definições, mecanismos, causas, consequências, classificações e relações clínicas. EVITE valores numéricos específicos. Resumo: """${summary.content.replace(/<[^>]*>?/gm, ' ')}"""`
                    : `Você é um especialista em criar questões para provas de residência médica. Baseado estritamente no conteúdo do resumo a seguir, crie uma lista de no mínimo 10 questões de múltipla escolha de alto nível. As questões devem ser complexas, mesclando diferentes formatos (ex: caso clínico curto, "qual das seguintes NÃO é", etc.). Cada questão deve ter 4 alternativas plausíveis, mas apenas uma correta. Forneça também um comentário explicativo para a resposta correta, justificando-a com base no texto do resumo. Resumo: """${summary.content.replace(/<[^>]*>?/gm, ' ')}"""`;

                const schema = isFlashcards ? flashcardsSchema : quizSchema;
                const parsedJson = await generateAIContentWithRetry(prompt, schema);

                const contentPayload = parsedJson[isFlashcards ? 'flashcards' : 'questions'];
                const { error } = await supabase.from('summaries').update({ [contentType]: contentPayload }).eq('id', summary.id);

                if (error) {
                    throw new Error(`Falha ao salvar no resumo "${summary.title}": ${error.message}`);
                }

                // Atualiza o estado local para a UI refletir a mudança imediatamente
                setSummaries(prev =>
                    prev.map(s => s.id === summary.id ? { ...s, [contentType]: contentPayload } : s)
                );
            }
            alert(`${contentType.charAt(0).toUpperCase() + contentType.slice(1)} gerados com sucesso para ${summariesToProcess.length} resumo(s)!`);
        } catch (e) {
            console.error(`Erro na geração em lote de ${contentType}:`, e);
            alert(`Ocorreu um erro durante a geração em lote: ${e.message}`);
        } finally {
            setIsBatchLoading(false);
            setBatchLoadingMessage('');
        }
    };

    // NOVO: Funções específicas que serão passadas para o Dashboard
    const handleGenerateFlashcardsForAllSubjects = () => handleGenerateContentForAllMissing('flashcards');
    const handleGenerateQuizForAllSubjects = () => handleGenerateContentForAllMissing('questions');


   const handleGetExplanation = async (questionText, correctAnswer) => {
        const summary = summaries.find(s => s.id === currentSummaryId);
        if (!summary) return "Contexto não encontrado.";
        const prompt = `Contexto: "${summary.content.replace(/<[^>]*>?/gm, ' ')}". Pergunta: "${questionText}". Resposta correta: "${correctAnswer}". Explique brevemente por que esta é a resposta correta.`;
        const parsedJson = await generateAIContentWithRetry(prompt, quizExplanationSchema);
        return parsedJson.explanation;
    };

    const handleToggleComplete = async () => {
        if (!user || !currentSummaryId) return;
        const isCompleted = completedSummaries.includes(currentSummaryId);
        if (isCompleted) {
            const { error } = await supabase.from('user_summary_progress').delete().match({ user_id: user.id, summary_id: currentSummaryId });
            if (!error) setCompletedSummaries(prev => prev.filter(id => id !== currentSummaryId));
            else alert("Erro ao remover o progresso.");
        } else {
            const { error } = await supabase.from('user_summary_progress').insert({ user_id: user.id, summary_id: currentSummaryId });
            if (!error) setCompletedSummaries(prev => [...prev, currentSummaryId]);
            else alert("Erro ao salvar o progresso.");
        }
    };

  const currentSubject = subjects.find(s => s.id === currentSubjectId);
  const currentSummary = summaries.find(s => s.id === currentSummaryId);
  const summariesForCurrentSubject = useMemo(() => summaries.filter(s => s.subject_id === currentSubjectId).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)), [summaries, currentSubjectId]);

  const subjectsForUser = useMemo(() => {
    // Para o admin, permite filtrar por um termo selecionado ou ver todos
    if (user?.role === 'admin') {
      if (selectedTermForAdmin) {
        return subjects.filter(s => String(s.term_id) === String(selectedTermForAdmin));
      }
      return subjects; // Retorna todos se nenhum termo for selecionado
    }
    // Para embaixador e aluno, 'subjects' já vem pré-filtrado por termo do fetchAppData
    return subjects;
  }, [subjects, user, selectedTermForAdmin]);

  const searchResults = useMemo(() => {
    const allSummariesWithSubject = summaries.map(sum => ({ ...sum, subjectName: subjects.find(sub => sub.id === sum.subject_id)?.name || '' }));
    if (!searchQuery.trim()) return { subjects: [], summaries: [], allSummaries: summaries };
    const q = searchQuery.toLowerCase();
    return {
        subjects: subjectsForUser.filter(s => s.name.toLowerCase().includes(q)).map(s => ({ ...s, summaryCount: summaries.filter(sum => sum.subject_id === s.id).length })),
        summaries: allSummariesWithSubject.filter(s => s.title.toLowerCase().includes(q) && subjectsForUser.some(sub => sub.id === s.subject_id)),
        allSummaries: summaries
    };
  }, [searchQuery, subjectsForUser, summaries, subjects]);

  const lastViewedWithDetails = useMemo(() => lastViewed.map(lv => ({ ...lv, subjectName: subjects.find(s => s.id === lv.subject_id)?.name || '...' })).filter(lv => subjects.some(s => s.id === lv.subject_id)), [lastViewed, subjects]);

    const AdminTermSelector = () => (
        <div className="admin-term-selector">
            <label htmlFor="term-selector">Visualizando Período:</label>
            <select
                id="term-selector"
                className="select-input"
                value={selectedTermForAdmin || ''}
                onChange={(e) => setSelectedTermForAdmin(e.target.value ? Number(e.target.value) : null)}
            >
                <option value="">Todos os Períodos</option>
                {terms.map(term => <option key={term.id} value={term.id}>{term.name}</option>)}
            </select>
        </div>
    );

    const renderContent = () => {
    if (loading) {
        return <div className="loader-container"><div className="loader"></div></div>;
    }
    if (!session || !user) {
        return <LoginScreen theme={theme} toggleTheme={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')} />;
    }
    if (user.status === 'pending_approval') return <PendingApprovalScreen />;
    if (user.status === 'blocked') return <BlockedScreen />;
    if (user.status !== 'active') {
        return <LoginScreen theme={theme} toggleTheme={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')} />;
    }
    if (!user.term_id && user.role !== 'admin') {
        return <TermSelector user={user} terms={terms} onTermUpdate={handleTermUpdate} />;
    }

    switch (view) {
      case 'dashboard':
        return (
            <>
                {user.role === 'admin' && <AdminTermSelector />}
                {/* ALTERADO: Passando as novas props para o Dashboard */}
                <Dashboard
                    user={user}
                    termName={terms.find(t => t.id === user.term_id)?.name}
                    onLogout={handleLogout}
                    subjects={subjectsForUser}
                    onSelectSubject={handleSelectSubject}
                    onAddSubject={() => { setEditingSubject(null); setSubjectModalOpen(true); }}
                    onEditSubject={(s) => { setEditingSubject(s); setSubjectModalOpen(true); }}
                    onDeleteSubject={handleDeleteSubject}
                    theme={theme}
                    toggleTheme={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
                    searchQuery={searchQuery}
                    onSearchChange={(e) => setSearchQuery(e.target.value)}
                    searchResults={searchResults}
                    onSelectSummary={handleSelectSummary}
                    lastViewed={lastViewedWithDetails}
                    completedSummaries={completedSummaries}
                    onNavigateToAdmin={() => setView('admin')}
                    onGenerateFlashcardsForAll={handleGenerateFlashcardsForAllSubjects}
                    onGenerateQuizForAll={handleGenerateQuizForAllSubjects}
                    isBatchLoading={isBatchLoading}
                    batchLoadingMessage={batchLoadingMessage}
                />
            </>
        );
      case 'subject':
        return <SummaryListView subject={currentSubject} summaries={summariesForCurrentSubject} onSelectSummary={handleSelectSummary} onAddSummary={() => { setEditingSummary(null); setSummaryModalOpen(true); }} onEditSummary={(s) => { setEditingSummary(s); setSummaryModalOpen(true); }} onDeleteSummary={handleDeleteSummary} user={user} completedSummaries={completedSummaries} onAISplit={() => setAISplitterModalOpen(true)} onReorderSummaries={handleReorderSummaries} onGenerateFlashcardsForAll={() => generateForAll('flashcards')} onGenerateQuizForAll={() => generateForAll('questions')} isBatchLoading={isBatchLoading} batchLoadingMessage={batchLoadingMessage}/>;
      case 'summary':
        return <SummaryDetailView summary={currentSummary} subject={currentSubject} onEdit={() => { setEditingSummary(currentSummary); setSummaryModalOpen(true); }} onDelete={() => handleDeleteSummary(currentSummary.id)} onGenerateQuiz={handleGenerateQuiz} onToggleComplete={handleToggleComplete} isCompleted={completedSummaries.includes(currentSummary.id)} onGetExplanation={handleGetExplanation} user={user} onAIUpdate={() => setAIUpdateModalOpen(true)} onGenerateFlashcards={handleGenerateFlashcards} />;
      case 'admin':
        return <AdminPanel onBack={handleBackToDashboard} />;
      default:
        return <div>Carregando...</div>;
    }
  };

  const breadcrumbPaths = useMemo(() => {
      const paths = [{ name: 'Início', onClick: handleBackToDashboard }];
      if (view === 'subject' && currentSubject) paths.push({ name: currentSubject.name, onClick: () => {} });
      else if (view === 'summary' && currentSubject && currentSummary) {
          paths.push({ name: currentSubject.name, onClick: handleBackToSubject });
          paths.push({ name: currentSummary.title, onClick: () => {} });
      }
      return paths;
  }, [view, currentSubject, currentSummary]);

  const showHeader = user && user.status === 'active' && view !== 'dashboard' && view !== 'admin';

  return (
    <>
      {showHeader && (
          <div className="main-header">
              <Breadcrumbs paths={breadcrumbPaths} />
              <ThemeToggle theme={theme} toggleTheme={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')} />
          </div>
      )}
      {renderContent()}

      <SubjectModal isOpen={isSubjectModalOpen} onClose={() => setSubjectModalOpen(false)} onSave={handleSaveSubject} subject={editingSubject} existingSubjects={subjects} user={user} terms={terms} />
      <SummaryModal isOpen={isSummaryModalOpen} onClose={() => setSummaryModalOpen(false)} onSave={handleSaveSummary} summary={editingSummary} subjectId={currentSubjectId} />
      <AISplitterModal isOpen={isAISplitterModalOpen} onClose={() => setAISplitterModalOpen(false)} onSummariesCreated={handleSplitAndSaveSummaries} />
      {isAIUpdateModalOpen && currentSummary && <AIUpdateModal summary={currentSummary} onClose={() => setAIUpdateModalOpen(false)} onUpdate={(newContent) => handleUpdateSummaryContent(currentSummary.id, newContent)} />}
    </>
  );
};

const root = createRoot(document.getElementById('root'));
root.render(<App />);
