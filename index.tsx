import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import { createClient, Session, User } from '@supabase/supabase-js';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';

// --- CONFIGURAÇÃO DO SUPABASE ---
// !! IMPORTANTE: Substitua pelas suas credenciais reais do Supabase !!
const supabaseUrl = 'https://vylpdfeqdylcqxzllnbh.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5bHBkZmVxZHlsY3F4emxsbmJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcxNjY3NzMsImV4cCI6MjA3Mjc0Mjc3M30.muT9yFZaHottkDM-acc6iU5XHqbo7yqTF-bpPoAotMY';
export const supabase = createClient(supabaseUrl, supabaseAnonKey);



// --- DADOS MOCADOS (APENAS PARA PREENCHER A INTERFACE INICIALMENTE) ---
// Em uma aplicação real, os termos também viriam do banco de dados.
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
    let delay = 1000; // Começa com 1 segundo de espera

    while (attempt < maxRetries) {
        try {
            const response = await ai.models.generateContent({
                model,
                contents: prompt,
                config: { responseMimeType: "application/json", responseSchema: schema },
            });

            // --- [CORREÇÃO] Início da lógica robusta de parse ---
            let rawText = response.text.trim();

            // 1. Tenta extrair o JSON de dentro de um bloco de código markdown.
            const jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[1]) {
                rawText = jsonMatch[1];
            }

            // 2. Isola o objeto JSON principal para remover texto extra.
            const firstBracket = rawText.indexOf('{');
            const lastBracket = rawText.lastIndexOf('}');
            if (firstBracket !== -1 && lastBracket > firstBracket) {
                rawText = rawText.substring(firstBracket, lastBracket + 1);
            }

            // 3. Tenta fazer o parse do texto limpo.
            try {
                return JSON.parse(rawText);
            } catch (parseError) {
                console.error("ERRO DE PARSE JSON:", parseError);
                console.error("--- TEXTO BRUTO DA IA QUE FALHOU --- \n", rawText, "\n--- FIM DO TEXTO BRUTO ---");
                // Lança um erro específico para que a lógica de retry possa capturá-lo.
                throw new Error("JSON_PARSE_FAILED");
            }
            // --- Fim da lógica robusta de parse ---

        } catch (error) {
            attempt++;
            const isOverloaded = error.message && (error.message.includes('503') || error.message.toLowerCase().includes('overloaded'));
            const isParseFailure = error.message === "JSON_PARSE_FAILED";

            if ((isOverloaded || isParseFailure) && attempt < maxRetries) {
                const reason = isOverloaded ? "Modelo sobrecarregado" : "Resposta JSON inválida";
                console.warn(`${reason}. Tentando novamente em ${delay / 1000}s... (Tentativa ${attempt}/${maxRetries})`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 2; // Backoff exponencial
            } else {
                if (isParseFailure) {
                    console.error("Máximo de tentativas atingido. A IA continua retornando JSON inválido.");
                    throw new Error("A resposta da IA não pôde ser processada. Por favor, tente novamente.");
                }
                console.error("Erro final da API ou máximo de tentativas atingido para servidor sobrecarregado.");
                throw error; // Lança o erro original após esgotar as tentativas
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


const QuizQuestion = ({ question }) => {
  const [selected, setSelected] = useState(null);

  const handleAnswer = (index) => {
    if (selected === null) {
      setSelected(index);
    }
  };

  return (
    <div className="quiz-question">
      <h3>{question.questionNumber}</h3>
      <p><strong>Disciplina:</strong> {question.discipline}</p>
      <p><strong>Campus:</strong> {question.campus}</p>
      <p><strong>Área:</strong> {question.knowledgeArea}</p>
      <p>{question.questionText}</p>

      <ul>
        {question.alternatives.map((alt, index) => {
          const isCorrect = index === question.correctAlternativeIndex;
          const isSelected = index === selected;

          return (
            <li
              key={index}
              className={`alternative
                ${isSelected ? 'selected' : ''}
                ${selected !== null && isCorrect ? 'correct' : ''}
                ${selected !== null && isSelected && !isCorrect ? 'incorrect' : ''}`}
              onClick={() => handleAnswer(index)}
            >
              {alt}
            </li>
          );
        })}
      </ul>

      {selected !== null && (
        <div className="feedback">
          {selected === question.correctAlternativeIndex ? (
            <p className="correct">✅ Você acertou!</p>
          ) : (
            <>
              <p className="incorrect">❌ Você errou.</p>
              <p>
                A resposta correta é:{" "}
                <strong>{question.alternatives[question.correctAlternativeIndex]}</strong>
              </p>
            </>
          )}

          {/* Sempre exibe a explicação */}
          <p><strong>Comentário:</strong> {question.explanation}</p>
        </div>
      )}
    </div>
  );
};

// --- FUNÇÕES AUXILIARES (HELPER FUNCTIONS) ---
const subjectColors = [
  '#A8DADC', // azul pastel
  '#F4A261', // laranja suave
  '#E9C46A', // amarelo pastel
  '#F6BD60', // dourado claro
  '#D4A5A5', // rosa pastel
  '#B5CDA3', // verde claro
  '#CDB4DB', // lilás
  '#FFDAC1', // pêssego
  '#BDE0FE'  // azul bebê
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

// --- TELA DE LOGIN ---
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
        // --- [ALTERAÇÃO CRÍTICA] ---
        // --- ETAPA 1: Cadastra o usuário no sistema de autenticação do Supabase
    const { data: authData, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
    });
    if (signUpError) throw signUpError;

    // ETAPA 2: Garante que há sessão
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      throw new Error("Sessão ainda não criada. Verifique configuração de confirmação de email no Supabase.");
    }

    // ETAPA 3: Cria o perfil no banco
    const { error: profileError } = await supabase
      .from("profiles")
      .insert({
        id: authData.user.id,
        email: authData.user.email,
        role: "user",
      });

    if (profileError) {
      console.error(
        "ERRO CRÍTICO: Usuário criado na autenticação, mas falhou ao criar o perfil no banco de dados.",
        profileError
      );
      throw new Error(
        "Ocorreu um erro ao finalizar seu cadastro. Por favor, contate o suporte."
      );
    }
  } else {
    // --- Login normal ---
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;
  }

  // O listener onAuthStateChange no componente App cuidará do redirecionamento
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
            {loading ? 'Carregando...' : (isSignUp ? 'Cadastrar' : 'Entrar')}
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

                // Esta chamada não precisa de retry pois é um modelo diferente (transcription)
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
    const [currentStep, setCurrentStep] = useState(1); // 1: Identify titles, 2: Edit titles
    const [identifiedTitles, setIdentifiedTitles] = useState([]);

    useEffect(() => {
        if (isOpen) {
            // Reset state when modal opens
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


const Dashboard = ({ user, termName, onLogout, subjects, onSelectSubject, onAddSubject, onEditSubject, onDeleteSubject, theme, toggleTheme, searchQuery, onSearchChange, searchResults, onSelectSummary, lastViewed, userProgress }) => {
  const isSearching = searchQuery.trim() !== '';

  return (
    <div className="container dashboard">
      <div className="dashboard-header">
        <h1>{isSearching ? "Resultados da Busca" : "Início"}</h1>
        <div className="header-actions">
            <ThemeToggle theme={theme} toggleTheme={toggleTheme}/>
            {userProgress.streak > 0 && <div className="streak-display">🔥 {userProgress.streak}</div>}
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

          <div className="add-subject-button-container">
              {user.role === 'admin' && <button className="btn btn-primary" onClick={onAddSubject}>Adicionar Disciplina</button>}
          </div>

          <div className="subject-grid">
            {subjects.map(subject => {
              const subjectSummaries = searchResults.allSummaries.filter(s => s.subject_id === subject.id);
              const completedCount = subjectSummaries.filter(s => userProgress.completedSummaries.includes(s.id)).length;
              const progress = subjectSummaries.length > 0 ? (completedCount / subjectSummaries.length) * 100 : 0;
              return (
                <div key={subject.id} className="subject-card" style={{ backgroundColor: subject.color }} onClick={() => onSelectSubject(subject)}>
                  <div><h3>{subject.name}</h3></div>
                  <div className="subject-card-progress">
                    <p>{completedCount} de {subjectSummaries.length} concluídos</p>
                    <div className="progress-bar"><div className="progress-bar-inner" style={{ width: `${progress}%` }}></div></div>
                  </div>
                  {user.role === 'admin' && (
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

    useEffect(() => {
        if (isOpen) {
            setName(subject ? subject.name : '');
            setSelectedTermId(subject ? subject.term_id : (user?.role === 'admin' ? '' : user?.term_id));
        }
    }, [isOpen, subject, user]);

    if (!isOpen) return null;

    const handleSubmit = (e) => {
        e.preventDefault();

        if (user?.role === 'admin' && !selectedTermId) {
            alert('Por favor, selecione um período para esta disciplina.');
            return;
        }

        const finalColor = (subject && subject.color) ? subject.color : getNewSubjectColor(existingSubjects);
        const termIdToSave = user?.role === 'admin' ? selectedTermId : user?.term_id;

        onSave({ ...subject, name, color: finalColor, term_id: termIdToSave });
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

                    {user?.role === 'admin' && (
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

const SummaryListView = ({ subject, summaries, onSelectSummary, onAddSummary, onEditSummary, onDeleteSummary, user, userProgress, onAISplit, onReorderSummaries, onGenerateFlashcardsForAll, onGenerateQuizForAll, isBatchLoading, batchLoadingMessage }) => {
    const handleDragEnd = (result) => {
        const { destination, source } = result;
        if (!destination || (destination.droppableId === source.droppableId && destination.index === source.index)) {
            return;
        }
        onReorderSummaries(source.index, destination.index);
    };

    return (
        <div className="container summary-list-view">
            <div className="dashboard-header">
                <h1>{subject.name}</h1>
                 {user.role === 'admin' && (
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
                                    const isCompleted = userProgress.completedSummaries.includes(summary.id);
                                    return (
                                        <Draggable key={summary.id} draggableId={String(summary.id)} index={index} isDragDisabled={user.role !== 'admin'}>
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
                                                    {user.role === 'admin' && (
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
                    {user.role === 'admin' && (
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


const QuizView = ({ questions, onGetExplanation }) => {
    const [answers, setAnswers] = useState({});
    const [explanations, setExplanations] = useState({});
    const [loadingExplanation, setLoadingExplanation] = useState(null);

    const handleAnswer = async (questionIndex, alternativeIndex) => {
        if (answers[questionIndex] !== undefined) return;
        setAnswers(prev => ({ ...prev, [questionIndex]: alternativeIndex }));

        const isCorrect = questions[questionIndex].correctAlternativeIndex === alternativeIndex;
        if (isCorrect) {
            setLoadingExplanation(questionIndex);
            try {
                const explanationText = await onGetExplanation(
                    questions[questionIndex].questionText,
                    questions[questionIndex].alternatives[alternativeIndex]
                );
                setExplanations(prev => ({ ...prev, [questionIndex]: explanationText }));
            } catch (error) {
                console.error("Failed to get explanation:", error);
                setExplanations(prev => ({...prev, [questionIndex]: "Não foi possível carregar a explicação."}));
            } finally {
                setLoadingExplanation(null);
            }
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
                        {isAnswered && explanations[qIndex] && (
                             <div className="explanation-box">{explanations[qIndex]}</div>
                        )}
                        {loadingExplanation === qIndex && <div className="explanation-box"><div className="loader-sm"></div></div>}
                    </div>
                );
            })}
        </div>
    );
};

const FlashcardView = ({ flashcards }) => {
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
    }, [flashcards]);

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
                const currentCard = deck[currentIndex];
                const remainingDeck = deck.filter((_, index) => index !== currentIndex);
                const newDeck = [...remainingDeck, currentCard];
                setDeck(newDeck);
                if (deck.length > 1) {
                    setCurrentIndex(currentIndex % (deck.length -1));
                }
            }
        }, 600);
    };

    const handleAnswer = (knows) => {
        if (!isFlipped) {
            setIsFlipped(true);
            setTimeout(() => processAnswer(knows), 1500);
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

    useEffect(() => {
        setIsTocVisible(true);
    }, [summary]);

    const handleGenerateQuiz = async () => {
        setIsGenerating(true);
        await onGenerateQuiz();
        setIsGenerating(false);
    };

    const handleGenerateFlashcards = async () => {
        setIsGenerating(true);
        await onGenerateFlashcards();
        setIsGenerating(false);
    }

    const availableTabs = [
        { id: 'summary', label: 'Resumo', condition: true },
        { id: 'video', label: 'Vídeo', condition: !!summary.video },
        { id: 'flashcards', label: 'Flashcards', condition: (summary.flashcards && summary.flashcards.length > 0) || user.role === 'admin' },
        { id: 'questions', label: 'Questões', condition: (summary.questions && summary.questions.length > 0) || user.role === 'admin' }
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
                        {user.role === 'admin' && (
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
                        dangerouslySetInnerHTML={{ __html: summary.content }}
                    />

                    <div
                        id="tab-panel-video"
                        role="tabpanel"
                        className={activeTab === 'video' ? '' : 'hidden'}
                    >
                        {summary.video && <GoogleDrivePlayer url={summary.video} />}
                    </div>

                    <div
                        id="tab-panel-flashcards"
                        role="tabpanel"
                        className={activeTab === 'flashcards' ? '' : 'hidden'}
                    >
                        {(summary.flashcards && summary.flashcards.length > 0) ? (
                            <FlashcardView flashcards={summary.flashcards} />
                        ) : (
                            user.role === 'admin' && (
                                <div className="quiz-container empty-quiz">
                                    <p>Ainda não há flashcards para este resumo.</p>
                                    <button
                                        className="btn btn-primary"
                                        onClick={handleGenerateFlashcards}
                                        disabled={isGenerating}
                                    >
                                        {isGenerating ? 'Gerando Flashcards...' : 'Gerar Flashcards com IA'}
                                    </button>
                                </div>
                            )
                        )}
                    </div>

                    <div
                        id="tab-panel-questions"
                        role="tabpanel"
                        className={activeTab === 'questions' ? '' : 'hidden'}
                    >
                        {summary.questions && summary.questions.length > 0 ? (
                            <QuizView questions={summary.questions} onGetExplanation={onGetExplanation} />
                        ) : (
                            user.role === 'admin' && (
                                <div className="quiz-container empty-quiz">
                                    <p>Ainda não há questões para este resumo.</p>
                                    <button
                                        className="btn btn-primary"
                                        onClick={handleGenerateQuiz}
                                        disabled={isGenerating}
                                    >
                                        {isGenerating ? 'Gerando Quiz...' : 'Gerar Quiz com IA'}
                                    </button>
                                </div>
                            )
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

const HamburgerIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="3" y1="12" x2="21" y2="12"></line>
        <line x1="3" y1="6" x2="21" y2="6"></line>
        <line x1="3" y1="18" x2="21" y2="18"></line>
    </svg>
);

const Sidebar = ({ isOpen, onClose, title, children }) => {
    return (
        <>
            <div className={`sidebar-overlay ${isOpen ? 'open' : ''}`} onClick={onClose}></div>
            <div className={`sidebar ${isOpen ? 'open' : ''}`}>
                <div className="sidebar-header">
                    <h3>{title}</h3>
                    <button className="close-btn" onClick={onClose}>×</button>
                </div>
                <div className="sidebar-content">
                    {children}
                </div>
            </div>
        </>
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

// --- [NOVO] Componente para incentivar a assinatura ---
const SubscriptionPromptScreen = () => {
    const redirectToCheckout = () => {
        // !! IMPORTANTE !!
        // Substitua pela URL real do seu plano de assinatura do Mercado Pago
        const mercadoPagoCheckoutUrl = 'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_plan_id=fa9742c919ac44d793ad723d66d9feae';
        window.location.href = mercadoPagoCheckoutUrl;
    };

    return (
        <div className="login-screen">
            <div className="login-card">
                <h1>Med<span>flix</span></h1>
                <h2>Acesse todo o conteúdo</h2>
                <p>
                    Para continuar, inicie sua assinatura. Você terá <strong>7 dias de teste gratuito</strong> para explorar
                    toda a plataforma. Cancele quando quiser.
                </p>
                <button onClick={redirectToCheckout} className="btn btn-primary" style={{marginTop: '1rem', width: '100%'}}>
                    Iniciar Teste Gratuito
                </button>
                <button className="btn btn-secondary" onClick={() => supabase.auth.signOut()} style={{marginTop: '0.5rem', width: '100%'}}>
                    Sair
                </button>
            </div>
        </div>
    );
};


// --- [ATUALIZADO E CORRIGIDO] COMPONENTE PRINCIPAL APP ---
const App = () => {
  // State de Autenticação e UI
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [subscription, setSubscription] = useState(null); // State para a assinatura do usuário
  const [loading, setLoading] = useState(true); // Começa como true
  const [terms, setTerms] = useState([]);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');
  const [view, setView] = useState('dashboard');
  const [currentSubjectId, setCurrentSubjectId] = useState(null);
  const [currentSummaryId, setCurrentSummaryId] = useState(null);

  // State de Dados
  const [subjects, setSubjects] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [userProgress, setUserProgress] = useState({ completedSummaries: [], lastCompletionDate: null, streak: 0 });
  const [lastViewed, setLastViewed] = useState([]);

  // State de Modais e Loading
  const [isSubjectModalOpen, setSubjectModalOpen] = useState(false);
  const [isSummaryModalOpen, setSummaryModalOpen] = useState(false);
  const [isAISplitterModalOpen, setAISplitterModalOpen] = useState(false);
  const [isAIUpdateModalOpen, setAIUpdateModalOpen] = useState(false);
  const [editingSubject, setEditingSubject] = useState(null);
  const [editingSummary, setEditingSummary] = useState(null);
  const [isBatchLoading, setIsBatchLoading] = useState(false);
  const [batchLoadingMessage, setBatchLoadingMessage] = useState('');

  // State de Busca
  const [searchQuery, setSearchQuery] = useState('');

  // useEffect para verificar a sessão inicial e configurar o listener
  useEffect(() => {
    // Função async para checar a sessão inicial e qualquer mudança de estado (login/logout)
    const checkUserSession = async () => {
      try {
        const { data: { session: currentSession }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;

        setSession(currentSession);

        if (currentSession?.user) {
            // Se HÁ uma sessão, busca todos os dados necessários
            const { data: profileData, error: profileError } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', currentSession.user.id)
                .single();
            if (profileError) throw profileError;

            const fullUser = { ...currentSession.user, ...profileData };
            setUser(fullUser);

            const { data: subscriptionData, error: subscriptionError } = await supabase
                .from('subscriptions')
                .select('*')
                .eq('user_id', currentSession.user.id)
                .in('status', ['trialing', 'active'])
                .single();

            if (subscriptionError && subscriptionError.code !== 'PGRST116') {
                throw subscriptionError;
            }
            setSubscription(subscriptionData);

            if (fullUser.term_id) {
                await fetchAppData(fullUser.term_id);
            }
        } else {
            // Se NÃO HÁ sessão (usuário fez logout ou a sessão expirou)
            // Limpa o estado para redirecionar para a tela de login
            setUser(null);
            setSubscription(null);
            setSubjects([]);
            setSummaries([]);
        }
      } catch (error) {
        console.error("Erro ao verificar a sessão do usuário:", error);
        // Em caso de erro, limpa o estado para garantir a tela de login
        setUser(null);
        setSubscription(null);
      } finally {
        setLoading(false);
      }
    };

    // Executa a verificação na montagem inicial do componente
    checkUserSession();

    // Listener para mudanças de estado (login, logout)
    const { data: { subscription: authListener } } = supabase.auth.onAuthStateChange((_event, session) => {
        // Se houver mudança, re-executa a lógica de verificação
        checkUserSession();
    });

    const fetchTerms = async () => {
        const { data } = await supabase.from('terms').select('*').order('id');
        setTerms(data || []);
    };
    fetchTerms();

    // Limpa o listener quando o componente é desmontado
    return () => {
        authListener.unsubscribe();
    };
  }, []);

  // Função para buscar dados principais da aplicação
  const fetchAppData = async (termId) => {
      const { data: subjectsData } = await supabase.from('subjects').select('*').eq('term_id', termId);
      setSubjects(subjectsData || []);

      const { data: summariesData } = await supabase.from('summaries').select('*').order('position', { ascending: true });

      const parseJsonField = (field, fallback = []) => {
          if (typeof field === 'string') {
              try {
                  const parsed = JSON.parse(field);
                  return Array.isArray(parsed) ? parsed : fallback;
              } catch (e) { return fallback; }
          }
          return Array.isArray(field) ? field : fallback;
      };

      setSummaries(
        (summariesData || []).map(s => ({
          ...s,
          questions: parseJsonField(s.questions, []),
          flashcards: parseJsonField(s.flashcards, []),
        }))
      );
  }

  // Busca dados do localStorage quando o usuário muda
  useEffect(() => {
    if (user) {
      const savedProgress = localStorage.getItem(`userProgress_${user.id}`);
      if (savedProgress) setUserProgress(JSON.parse(savedProgress));

      const savedLastViewed = localStorage.getItem(`lastViewed_${user.id}`);
      if(savedLastViewed) setLastViewed(JSON.parse(savedLastViewed));
    }
  }, [user]);

  // Salva dados no localStorage
  useEffect(() => {
    localStorage.setItem('theme', theme);
    if (user) {
      localStorage.setItem(`userProgress_${user.id}`, JSON.stringify(userProgress));
      localStorage.setItem(`lastViewed_${user.id}`, JSON.stringify(lastViewed));
    }
  }, [theme, userProgress, lastViewed, user]);

  useEffect(() => {
    document.body.className = theme === 'dark' ? '' : 'light-mode';
  }, [theme]);

  const handleLogout = () => supabase.auth.signOut();

  const handleSelectSubject = (subject) => {
    setCurrentSubjectId(subject.id);
    setView('subject');
  };

  const handleSelectSummary = (summary) => {
    setCurrentSummaryId(summary.id);
    setView('summary');
    setLastViewed(prev => {
        const otherSummaries = prev.filter(s => s.id !== summary.id);
        const subjectName = subjects.find(s => s.id === summary.subject_id)?.name || '';
        return [{...summary, subjectName}, ...otherSummaries].slice(0, 3);
    });
  };

  const handleBackToDashboard = () => {
      setView('dashboard');
      setCurrentSubjectId(null);
      setCurrentSummaryId(null);
  }
  const handleBackToSubject = () => {
      setCurrentSummaryId(null);
      setView('subject');
  };

  const handleTermUpdate = async (newTermId) => {
      const { data, error } = await supabase
          .from('profiles')
          .update({ term_id: newTermId })
          .eq('id', user.id)
          .select()
          .single();

      if (error) {
          alert("Erro ao salvar o termo.");
      } else if (data) {
          setUser(prevUser => ({ ...prevUser, ...data }));
          fetchAppData(newTermId); // Recarrega os dados para o novo termo
      }
  };

  const handleSaveSubject = async (subjectData) => {
    if (!subjectData.term_id) {
        alert("Ocorreu um erro: o período da disciplina não foi especificado.");
        return;
    }

    if (subjectData.id) {
        const { data, error } = await supabase.from('subjects').update({ name: subjectData.name, color: subjectData.color, term_id: subjectData.term_id }).eq('id', subjectData.id).select();
        if (error) alert(error.message);
        else if (data) setSubjects(subjects.map(s => s.id === data[0].id ? data[0] : s));
    } else {
        const { data, error } = await supabase.from('subjects').insert({ name: subjectData.name, color: subjectData.color, user_id: session.user.id, term_id: subjectData.term_id }).select();
        if (error) alert(error.message);
        else if (data) {
            if (String(data[0].term_id) === String(user.term_id)) {
                setSubjects([...subjects, data[0]]);
            }
        }
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
    const isNewSummary = !summaryData.id;
    const summariesForSubject = summaries.filter(s => s.subject_id === summaryData.subject_id);

    const summaryPayload = {
        title: summaryData.title,
        content: summaryData.content,
        video: summaryData.video,
        subject_id: summaryData.subject_id,
        user_id: session.user.id,
        position: isNewSummary ? summariesForSubject.length : summaryData.position,
    };

    if (!isNewSummary) {
        const { data, error } = await supabase.from('summaries')
            .update({ title: summaryData.title, content: summaryData.content, video: summaryData.video })
            .eq('id', summaryData.id)
            .select()
            .single();
        if (error) {
            alert(error.message);
        } else if (data) {
            setSummaries(summaries.map(s => s.id === data.id ? data : s));
        }
    } else {
        const { data, error } = await supabase.from('summaries').insert(summaryPayload).select().single();
        if (error) {
            alert(error.message);
        } else if (data) {
            setSummaries([...summaries, data]);
        }
    }
    setSummaryModalOpen(false);
    setEditingSummary(null);
  };

  const handleDeleteSummary = async (summaryId) => {
      if (window.confirm("Tem certeza que deseja excluir este resumo?")) {
          const { error } = await supabase.from('summaries').delete().eq('id', summaryId);
          if (error) alert(error.message);
          else {
            setSummaries(summaries.filter(s => s.id !== summaryId));
            handleBackToSubject();
          }
      }
  };

  const handleSplitAndSaveSummaries = async (newSummaries) => {
    if (!currentSubjectId) {
        alert("Nenhuma disciplina selecionada.");
        setAISplitterModalOpen(false);
        return;
    }
    const summariesForSubject = summaries.filter(s => s.subject_id === currentSubjectId);
    const startPosition = summariesForSubject.length;

    const summariesPayload = newSummaries.map((summary, index) => ({
        title: summary.title,
        content: summary.content,
        subject_id: currentSubjectId,
        user_id: session.user.id,
        position: startPosition + index,
    }));

    const { data, error } = await supabase.from('summaries').insert(summariesPayload).select();

    if (error) {
        alert("Falha ao salvar os novos resumos. Tente novamente.");
        console.error(error);
    } else if (data) {
        setSummaries(prevSummaries => [...prevSummaries, ...data]);
        alert(`${data.length} resumos foram criados com sucesso!`);
    }

    setAISplitterModalOpen(false);
  };

  const handleUpdateSummaryContent = async (summaryId, newContent) => {
      const { data, error } = await supabase.from('summaries').update({ content: newContent }).eq('id', summaryId).select();
      if (error) alert(error.message);
      else if (data) setSummaries(summaries.map(s => s.id === data[0].id ? data[0] : s));
      setAIUpdateModalOpen(false);
  };

  const handleReorderSummaries = async (startIndex, endIndex) => {
    const currentSubjectSummaries = summaries
      .filter(s => s.subject_id === currentSubjectId)
      .sort((a, b) => a.position - b.position);

    const [removed] = currentSubjectSummaries.splice(startIndex, 1);
    currentSubjectSummaries.splice(endIndex, 0, removed);

    const otherSummaries = summaries.filter(s => s.subject_id !== currentSubjectId);
    const updatedSummariesForState = currentSubjectSummaries.map((s, index) => ({ ...s, position: index }));
    setSummaries([...otherSummaries, ...updatedSummariesForState]);


    const updates = updatedSummariesForState.map((summary, index) =>
        supabase
            .from('summaries')
            .update({ position: index })
            .eq('id', summary.id)
    );

    const { error } = await Promise.all(updates);
    if (error) {
        alert("Não foi possível salvar a nova ordem. Por favor, tente novamente.");
    }
  };

  const handleGenerateQuiz = async () => {
    const summary = summaries.find(s => s.id === currentSummaryId);
    if (!summary) return;

    try {
const prompt = `Você é um especialista em criar questões para provas de residência médica. Baseado estritamente no conteúdo do resumo a seguir, crie uma lista de no mínimo 10 questões de múltipla escolha de alto nível.
As questões devem ser complexas, mesclando diferentes formatos (ex: caso clínico curto, "qual das seguintes NÃO é", etc.). Cada questão deve ter 4 alternativas plausíveis, mas apenas uma correta.
Forneça também um comentário explicativo para a resposta correta, justificando-a com base no texto do resumo.

**Resumo para extrair as questões:**
"""
${summary.content.replace(/<[^>]*>?/gm, ' ')}
"""`;        const parsedJson = await generateAIContentWithRetry(prompt, quizSchema);

        const { data, error } = await supabase.from('summaries')
            .update({ questions: parsedJson.questions })
            .eq('id', currentSummaryId)
            .select()
            .single();

        if (error) throw error;
        setSummaries(summaries.map(s => s.id === currentSummaryId ? data : s));
    } catch (e) {
        console.error("Erro ao gerar/salvar quiz:", e);
        alert("Falha ao gerar o quiz. O serviço pode estar ocupado. Tente novamente mais tarde.");
    }
  };

  const handleGenerateFlashcards = async () => {
    const summary = summaries.find(s => s.id === currentSummaryId);
    if (!summary) return;
    try {
const prompt = `Baseado no seguinte resumo sobre "${summary.title}", sua tarefa é criar um conjunto de flashcards para estudo e memorização.
Cada flashcard deve ser claro e objetivo, no formato pergunta-e-resposta (frente e verso).
Priorize conceitos-chave, definições, mecanismos de ação, causas, consequências, classificações e relações clínicas importantes.
EVITE incluir valores específicos de exames laboratoriais ou dados numéricos que mudam com frequência. O foco é no conceito.
Cada flashcard deve ser curto e direto para facilitar a memorização rápida.

**Resumo para extrair os flashcards:**
"""
${summary.content.replace(/<[^>]*>?/gm, ' ')}
"""`;        const parsedJson = await generateAIContentWithRetry(prompt, flashcardsSchema);

        const { data, error } = await supabase.from('summaries')
            .update({ flashcards: parsedJson.flashcards })
            .eq('id', currentSummaryId)
            .select()
            .single();

        if (error) throw error;

        setSummaries(summaries.map(s => s.id === currentSummaryId ? data : s));

    } catch (e) {
        console.error("Erro ao gerar/salvar flashcards:", e);
        alert("Falha ao gerar os flashcards. Tente novamente.");
    }
  };

    const handleGenerateFlashcardsForAll = async () => {
        const summariesToProcess = summaries.filter(s => s.subject_id === currentSubjectId && (!s.flashcards || s.flashcards.length === 0));
        if (summariesToProcess.length === 0) {
            alert("Não há resumos sem flashcards nesta disciplina.");
            return;
        }

        setIsBatchLoading(true);
        const updatedSummaries = [];

        try {
            for (let i = 0; i < summariesToProcess.length; i++) {
                const summary = summariesToProcess[i];
                setBatchLoadingMessage(`Gerando flashcards para "${summary.title}" (${i + 1}/${summariesToProcess.length})...`);
const prompt = `Baseado no seguinte resumo sobre "${summary.title}", sua tarefa é criar um conjunto de flashcards para estudo e memorização.
Cada flashcard deve ser claro e objetivo, no formato pergunta-e-resposta (frente e verso).
Priorize conceitos-chave, definições, mecanismos de ação, causas, consequências, classificações e relações clínicas importantes.
EVITE incluir valores específicos de exames laboratoriais ou dados numéricos que mudam com frequência. O foco é no conceito.
Cada flashcard deve ser curto e direto para facilitar a memorização rápida.

**Resumo para extrair os flashcards:**
"""
${summary.content.replace(/<[^>]*>?/gm, ' ')}
"""`;
                const parsedJson = await generateAIContentWithRetry(prompt, flashcardsSchema);
                updatedSummaries.push({ id: summary.id, flashcards: parsedJson.flashcards });
            }

            setBatchLoadingMessage("Salvando no banco de dados...");
            const updatePromises = updatedSummaries.map(s =>
                supabase.from('summaries').update({ flashcards: s.flashcards }).eq('id', s.id)
            );
            await Promise.all(updatePromises);

            setSummaries(prev => prev.map(summary => {
                const updated = updatedSummaries.find(u => u.id === summary.id);
                return updated ? { ...summary, flashcards: updated.flashcards } : summary;
            }));

            alert(`Flashcards gerados para ${updatedSummaries.length} resumos com sucesso!`);
        } catch (e) {
            console.error("Erro na geração em lote de flashcards:", e);
            alert("Ocorreu um erro durante a geração em lote. Verifique o console.");
        } finally {
            setIsBatchLoading(false);
            setBatchLoadingMessage('');
        }
    };

    const handleGenerateQuizForAll = async () => {
        const summariesToProcess = summaries.filter(s => s.subject_id === currentSubjectId && (!s.questions || s.questions.length === 0));
        if (summariesToProcess.length === 0) {
            alert("Não há resumos sem questões nesta disciplina.");
            return;
        }

        setIsBatchLoading(true);
        const updatedSummaries = [];

        try {
            for (let i = 0; i < summariesToProcess.length; i++) {
                const summary = summariesToProcess[i];
                 setBatchLoadingMessage(`Gerando questões para "${summary.title}" (${i + 1}/${summariesToProcess.length})...`);
const prompt = `Você é um especialista em criar questões para provas de residência médica. Baseado estritamente no conteúdo do resumo a seguir, crie uma lista de no mínimo 10 questões de múltipla escolha de alto nível.
As questões devem ser complexas, mesclando diferentes formatos (ex: caso clínico curto, "qual das seguintes NÃO é", etc.). Cada questão deve ter 4 alternativas plausíveis, mas apenas uma correta.
Forneça também um comentário explicativo para a resposta correta, justificando-a com base no texto do resumo.

**Resumo para extrair as questões:**
"""
${summary.content.replace(/<[^>]*>?/gm, ' ')}
"""`;
                const parsedJson = await generateAIContentWithRetry(prompt, quizSchema);
                updatedSummaries.push({ id: summary.id, questions: parsedJson.questions });
            }

            setBatchLoadingMessage("Salvando no banco de dados...");
            const updatePromises = updatedSummaries.map(s =>
                supabase.from('summaries').update({ questions: s.questions }).eq('id', s.id)
            );
            await Promise.all(updatePromises);

            setSummaries(prev => prev.map(summary => {
                const updated = updatedSummaries.find(u => u.id === summary.id);
                return updated ? { ...summary, questions: updated.questions } : summary;
            }));

            alert(`Questões geradas para ${updatedSummaries.length} resumos com sucesso!`);
        } catch (e) {
            console.error("Erro na geração em lote de questões:", e);
            alert("Ocorreu um erro durante a geração em lote. Verifique o console.");
        } finally {
            setIsBatchLoading(false);
            setBatchLoadingMessage('');
        }
    };

   const handleGetExplanation = async (questionText, correctAnswer) => {
        const summary = summaries.find(s => s.id === currentSummaryId);
        if (!summary) return "Contexto não encontrado.";
        const prompt = `Contexto do resumo: "${summary.content.replace(/<[^>]*>?/gm, ' ')}". Pergunta: "${questionText}". Resposta correta: "${correctAnswer}". Explique brevemente por que esta é a resposta correta.`;

        const parsedJson = await generateAIContentWithRetry(prompt, quizExplanationSchema);
        return parsedJson.explanation;
    };

  const handleToggleComplete = () => {
    const today = new Date().toISOString().split('T')[0];
    const isCompleted = userProgress.completedSummaries.includes(currentSummaryId);
    setUserProgress(prev => {
        const completedSummaries = isCompleted ? prev.completedSummaries.filter(id => id !== currentSummaryId) : [...new Set([...prev.completedSummaries, currentSummaryId])];
        if (isCompleted) return { ...prev, completedSummaries };
        let { streak, lastCompletionDate } = prev;
        if (lastCompletionDate !== today) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            streak = (lastCompletionDate === yesterday.toISOString().split('T')[0]) ? streak + 1 : 1;
        }
        return { completedSummaries, streak, lastCompletionDate: today };
    });
  };

  const currentSubject = subjects.find(s => s.id === currentSubjectId);
  const currentSummary = summaries.find(s => s.id === currentSummaryId);

  const summariesForCurrentSubject = useMemo(() =>
  summaries
      .filter(s => s.subject_id === currentSubjectId)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
  [summaries, currentSubjectId]);


  const searchResults = useMemo(() => {
    const allSummariesWithSubject = summaries.map(sum => ({ ...sum, subjectName: subjects.find(sub => sub.id === sum.subject_id)?.name || '' }));
    if (!searchQuery.trim()) return { subjects: [], summaries: [], allSummaries: summaries };
    const lowerCaseQuery = searchQuery.toLowerCase();
    const filteredSubjects = subjects.filter(sub => sub.name.toLowerCase().includes(lowerCaseQuery)).map(sub => ({ ...sub, summaryCount: summaries.filter(s => s.subject_id === sub.id).length }));
    const filteredSummaries = allSummariesWithSubject.filter(sum => sum.title.toLowerCase().includes(lowerCaseQuery));
    return { subjects: filteredSubjects, summaries: filteredSummaries, allSummaries: summaries };
  }, [searchQuery, subjects, summaries]);

  const lastViewedWithDetails = useMemo(() => {
    return lastViewed.map(lv => {
        const subject = subjects.find(s => s.id === lv.subject_id);
        return { ...lv, subjectName: subject?.name || 'Disciplina Removida' };
    }).filter(lv => subjects.find(s => s.id === lv.subject_id));
  }, [lastViewed, subjects]);

    const needsSubscription =
      !subscription &&
      user?.role !== 'administrador' &&
      !user?.has_manual_access;

    const renderContent = () => {
    if (loading) {
        return <div className="loader-container"><div className="loader"></div></div>;
    }

    if (!session || !user) {
        return <LoginScreen theme={theme} toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />;
    }

    if (needsSubscription) {
        return <SubscriptionPromptScreen />;
    }

    if (!user.term_id) {
        return <TermSelector user={user} terms={terms} onTermUpdate={handleTermUpdate} />;
    }

    switch (view) {
      case 'dashboard':
        const termName = terms.find(t => t.id === user.term_id)?.name || "Meu Período";
        return <Dashboard user={user} termName={termName} onLogout={handleLogout} subjects={subjects} onSelectSubject={handleSelectSubject} onAddSubject={() => { setEditingSubject(null); setSubjectModalOpen(true); }} onEditSubject={(subject) => { setEditingSubject(subject); setSubjectModalOpen(true); }} onDeleteSubject={handleDeleteSubject} theme={theme} toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} searchQuery={searchQuery} onSearchChange={(e) => setSearchQuery(e.target.value)} searchResults={searchResults} onSelectSummary={handleSelectSummary} lastViewed={lastViewedWithDetails} userProgress={userProgress} />;

      case 'subject':
        return <SummaryListView subject={currentSubject} summaries={summariesForCurrentSubject} onSelectSummary={handleSelectSummary} onAddSummary={() => { setEditingSummary(null); setSummaryModalOpen(true); }} onEditSummary={(summary) => { setEditingSummary(summary); setSummaryModalOpen(true); }} onDeleteSummary={handleDeleteSummary} user={user} userProgress={userProgress} onAISplit={() => setAISplitterModalOpen(true)} onReorderSummaries={handleReorderSummaries} onGenerateFlashcardsForAll={handleGenerateFlashcardsForAll} onGenerateQuizForAll={handleGenerateQuizForAll} isBatchLoading={isBatchLoading} batchLoadingMessage={batchLoadingMessage}/>;

      case 'summary':
        return <SummaryDetailView
                  summary={currentSummary}
                  subject={currentSubject}
                  onEdit={() => { setEditingSummary(currentSummary); setSummaryModalOpen(true); }}
                  onDelete={() => handleDeleteSummary(currentSummary.id)}
                  onGenerateQuiz={handleGenerateQuiz}
                  onToggleComplete={handleToggleComplete}
                  isCompleted={userProgress.completedSummaries.includes(currentSummary.id)}
                  onGetExplanation={handleGetExplanation}
                  user={user}
                  onAIUpdate={() => setAIUpdateModalOpen(true)}
                  onGenerateFlashcards={handleGenerateFlashcards}
                />;

      default:
        return <LoginScreen theme={theme} toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />;
    }
  };

  const breadcrumbPaths = useMemo(() => {
      const paths = [{ name: 'Início', onClick: handleBackToDashboard }];
      if (view === 'subject' && currentSubject) {
          paths.push({ name: currentSubject.name, onClick: () => {} });
      } else if (view === 'summary' && currentSubject && currentSummary) {
          paths.push({ name: currentSubject.name, onClick: handleBackToSubject });
          paths.push({ name: currentSummary.title, onClick: () => {} });
      }
      return paths;
  }, [view, currentSubject, currentSummary]);

  return (
    <>
      {user && user.term_id && !needsSubscription && view !== 'dashboard' && (
          <div className="main-header">
              <Breadcrumbs paths={breadcrumbPaths} />
              <ThemeToggle theme={theme} toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
          </div>
      )}
      {renderContent()}

      <SubjectModal
        isOpen={isSubjectModalOpen}
        onClose={() => setSubjectModalOpen(false)}
        onSave={handleSaveSubject}
        subject={editingSubject}
        existingSubjects={subjects}
        user={user}
        terms={terms}
      />
      <SummaryModal
        isOpen={isSummaryModalOpen}
        onClose={() => setSummaryModalOpen(false)}
        onSave={handleSaveSummary}
        summary={editingSummary}
        subjectId={currentSubjectId}
      />
       <AISplitterModal
        isOpen={isAISplitterModalOpen}
        onClose={() => setAISplitterModalOpen(false)}
        onSummariesCreated={handleSplitAndSaveSummaries}
      />
      {isAIUpdateModalOpen && currentSummary && <AIUpdateModal
        summary={currentSummary}
        onClose={() => setAIUpdateModalOpen(false)}
        onUpdate={(newContent) => handleUpdateSummaryContent(currentSummary.id, newContent)}
      />}
    </>
  );
};

const root = createRoot(document.getElementById('root'));
root.render(<App />);
