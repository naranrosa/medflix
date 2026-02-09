import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import { createClient, Session, User } from '@supabase/supabase-js';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';

// --- CONFIGURAÇÃO DO SUPABASE ---
const supabaseUrl = 'https://vylpdfeqdylcqxzllnbh.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5bHBkZmVxZHlsY3F4emxsbmJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcxNjY3NzMsImV4cCI6MjA3Mjc0Mjc3M30.muT9yFZaHottkDM-acc6iU5XHqbo7yqTF-bpPoAotMY';
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// --- DADOS MOCADOS ---
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
 * Encapsula a chamada da API GenAI com uma lógica de retry para erros 503
 * @param {string} prompt
 * @param {object} schema
 * @param {number} maxRetries
 * @returns {Promise<object>}
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


// --- SCHEMAS DA IA ---

const integratorWeekAnswerSchema = {
    type: Type.OBJECT,
    properties: {
        answers: {
            type: Type.ARRAY,
            description: 'Uma lista de respostas para as perguntas fornecidas.',
            items: {
                type: Type.OBJECT,
                properties: {
                    originalQuestion: { type: Type.STRING, description: 'O texto da pergunta original que foi respondida.' },
                    answerText: {
                        type: Type.STRING,
                        description: 'Uma resposta completa e detalhada, com pelo menos dois parágrafos, sem usar tópicos ou listas numeradas. A resposta deve ser muito completa.'
                    },
                    abntReference: {
                        type: Type.STRING,
                        description: 'Uma referência bibliográfica de alta qualidade para a resposta, formatada no padrão ABNT.'
                    }
                },
                required: ['originalQuestion', 'answerText', 'abntReference']
            }
        }
    },
    required: ['answers']
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

// --- COMPONENTES ---

const IntegratorWeekView = ({ subject, allSubjects, user }) => {
    const questionsStorageKey = `integrator_week_questions_${user.id}`;
    const answersStorageKey = `integrator_week_answers_${user.id}`;

    const [questions, setQuestions] = useState(() => {
        try {
            const savedQuestions = localStorage.getItem(questionsStorageKey);
            return savedQuestions && savedQuestions.length > 2
                   ? JSON.parse(savedQuestions)
                   : [{ id: 1, text: '', subject: '' }];
        } catch (e) {
            console.error("Falha ao carregar perguntas do localStorage", e);
            return [{ id: 1, text: '', subject: '' }];
        }
    });

    const [generatedAnswers, setGeneratedAnswers] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        try {
            localStorage.setItem(questionsStorageKey, JSON.stringify(questions));
        } catch (e) {
            console.error("Falha ao salvar perguntas no localStorage", e);
        }
    }, [questions, questionsStorageKey]);

    useEffect(() => {
        try {
            const savedAnswers = localStorage.getItem(answersStorageKey);
            if (savedAnswers) {
                setGeneratedAnswers(JSON.parse(savedAnswers));
            }
        } catch (e) {
            console.error("Falha ao carregar respostas do localStorage", e);
            localStorage.removeItem(answersStorageKey);
        }
    }, [answersStorageKey]);


    const handleAddQuestion = () => {
        setQuestions(prev => [...prev, { id: Date.now(), text: '', subject: '' }]);
    };

    const handleQuestionChange = (id, field, value) => {
        setQuestions(prev => prev.map(q => q.id === id ? { ...q, [field]: value } : q));
    };

    const handleRemoveQuestion = (id) => {
        setQuestions(prev => prev.filter(q => q.id !== id));
    };

     const handleGetAnswers = async () => {
        const validQuestions = questions.filter(q => q.text.trim() && q.subject.trim());
        if (validQuestions.length === 0) {
            setError('Por favor, adicione pelo menos uma pergunta válida com uma matéria selecionada.');
            return;
        }

        setIsLoading(true);
        setError('');
        setGeneratedAnswers([]);

        try {
            const prompt = `
**PAPEL DE SISTEMA:** Você é um especialista em medicina e sua única tarefa é gerar respostas factuais e acadêmicas para as perguntas enviadas, seguindo estritamente o formato solicitado.

**INSTRUÇÕES:**
1. Para cada pergunta na lista abaixo, você deve fornecer uma resposta detalhada e completa.
2. A resposta deve ter no mínimo dois parágrafos de texto discursivo.
3. A resposta NÃO DEVE conter tópicos, listas numeradas ou marcadores.
4. Ao final de cada resposta, forneça uma referência bibliográfica de alta qualidade em formato ABNT.
5. Sua saída DEVE ser apenas o JSON. NÃO inclua absolutamente nenhum texto, preâmbulo, explicação, comentário ou conversa antes ou depois do bloco JSON.

**PERGUNTAS PARA PROCESSAR:**
${JSON.stringify(validQuestions.map(q => ({ pergunta: q.text, materia: q.subject })))}
`;

            const parsedJson = await generateAIContentWithRetry(prompt, integratorWeekAnswerSchema);

            if (!parsedJson.answers || parsedJson.answers.length === 0) {
                 throw new Error("A IA não retornou respostas válidas.");
            }

            setGeneratedAnswers(parsedJson.answers);
            localStorage.setItem(answersStorageKey, JSON.stringify(parsedJson.answers));

            localStorage.removeItem(questionsStorageKey);
            setQuestions([{ id: 1, text: '', subject: '' }]);

        } catch (e) {
            console.error(e);
            setError('Ocorreu um erro ao gerar as respostas. A IA pode ter retornado um formato inválido. Por favor, tente novamente.');
        } finally {
            setIsLoading(false);
        }
    };

    const availableSubjects = allSubjects.filter(s => s.id !== subject.id);

    return (
        <div className="container integrator-week-view">
            <div className="dashboard-header">
                <h1>{subject.name}</h1>
            </div>

            <div className="integrator-form">
                <h2>Faça suas perguntas</h2>
                <p>Digite sua pergunta, escolha a matéria correspondente e adicione quantas perguntas precisar. Ao final, clique em "Obter Respostas".</p>

                {questions.map((q, index) => (
                    <div key={q.id} className="question-input-group">
                        <textarea
                            className="input"
                            placeholder={`Digite sua pergunta aqui...`}
                            value={q.text}
                            onChange={(e) => handleQuestionChange(q.id, 'text', e.target.value)}
                            rows={2}
                        />
                        <select
                            className="select-input"
                            value={q.subject}
                            onChange={(e) => handleQuestionChange(q.id, 'subject', e.target.value)}
                        >
                            <option value="" disabled>Selecione a matéria...</option>
                            {availableSubjects.map(s => (
                                <option key={s.id} value={s.name}>{s.name}</option>
                            ))}
                        </select>
                        <IconButton onClick={() => handleRemoveQuestion(q.id)} className="danger-icon-btn" disabled={questions.length === 1}>
                           <DeleteIcon />
                        </IconButton>
                    </div>
                ))}

                <div className="integrator-actions">
                    <button className="btn btn-secondary" onClick={handleAddQuestion}>Adicionar Pergunta</button>
                    <button className="btn btn-primary" onClick={handleGetAnswers} disabled={isLoading}>
                        {isLoading ? 'Gerando...' : 'Obter Respostas'}
                    </button>
                </div>
            </div>

            {error && <p className="error-message" style={{textAlign: 'center', marginTop: '1.5rem'}}>{error}</p>}

            {isLoading && (
                <div className="loader-container">
                    <div className="loader"></div>
                    <p>Aguarde, a IA está elaborando as respostas...</p>
                </div>
            )}

            {generatedAnswers.length > 0 && (
                <div className="answers-section">
                    <h2>Respostas Geradas</h2>
                    {generatedAnswers.map((answer, index) => (
                        <div key={index} className="answer-card">
                            <h3>{answer.originalQuestion}</h3>
                            <div className="answer-content">
                                {answer.answerText.split('\n').map((paragraph, pIndex) => (
                                    <p key={pIndex}>{paragraph}</p>
                                ))}
                            </div>
                            <div className="answer-reference">
                                <strong>Referência (ABNT):</strong>
                                <p>{answer.abntReference}</p>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};


const QuizView = ({ questions, onGetExplanation, summaryId, userId, isMockExam = false }) => {
    const [answers, setAnswers] = useState({});
    const [explanations, setExplanations] = useState({});
    const [loadingExplanation, setLoadingExplanation] = useState(null);

    // --- Lógica para registrar as tentativas do quiz ---
    const logAttempt = async (question, isCorrect) => {
        if (isMockExam || !userId || !summaryId) return;
        try {
            await supabase.from('user_quiz_attempts').upsert({
                user_id: userId,
                summary_id: summaryId,
                question_text: question.questionText,
                is_correct: isCorrect,
            }, { onConflict: 'user_id, summary_id, question_text' });
        } catch (error) {
            console.error("Erro ao registrar tentativa do quiz:", error);
        }
    };

    const handleAnswer = async (questionIndex, alternativeIndex) => {
        if (answers[questionIndex] !== undefined) return;

        setAnswers(prev => ({ ...prev, [questionIndex]: alternativeIndex }));

        const question = questions[questionIndex];
        const isCorrect = question.correctAlternativeIndex === alternativeIndex;

        await logAttempt(question, isCorrect);

        if (isCorrect) {
            setLoadingExplanation(questionIndex);
            try {
                const explanationText = await onGetExplanation(
                    question.questionText,
                    question.alternatives[alternativeIndex]
                );
                setExplanations(prev => ({ ...prev, [questionIndex]: explanationText }));
            } catch (error) {
                console.error("Failed to get explanation:", error);
                setExplanations(prev => ({...prev, [questionIndex]: question.explanation || "Não foi possível carregar a explicação."}));
            } finally {
                setLoadingExplanation(null);
            }
        } else {
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
const subjectColors = [
  '#E63946', '#1D3557', '#457B9D', '#2A9D8F',
  '#E76F51', '#FFC300', '#6A057F', '#E5989B', '#008080'
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

const IconButton = ({ onClick, children, className = '', disabled = false, title = '' }) => (
    <button className={`icon-btn ${className}`} onClick={(e) => { e.stopPropagation(); onClick(e); }} disabled={disabled} title={title}>
        {children}
    </button>
);

const EditIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>;
const DeleteIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>;
const CheckCircleIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>;
const SearchIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>;
const SparklesIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L14.39 8.36L21 9.27L16.36 14.14L18.18 21L12 17.27L5.82 21L7.64 14.14L3 9.27L9.61 8.36L12 2z"/></svg>;
const ListIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>;
const CalendarIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>;
const MessageSquareIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>;
const ClipboardIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>;


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
  const [phone, setPhone] = useState('');
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
                options: {
                    data: {
                        phone: phone,
                    }
                }
            });
            if (signUpError) throw signUpError;
            const mercadoPagoCheckoutUrl = 'https://buy.stripe.com/dRmbJ20jYdu02ZKg9l1sQ00';
            window.location.href = mercadoPagoCheckoutUrl;

        } else {
            const { data, error: signInError } = await supabase.auth.signInWithPassword({
                email,
                password,
            });
            if (signInError) throw signInError;

            if (data.user) {
                const newSessionId = crypto.randomUUID();
                localStorage.setItem('active_session_id', newSessionId);

                const { error: updateError } = await supabase
                    .from('profiles')
                    .update({ active_session_id: newSessionId })
                    .eq('id', data.user.id);

                if (updateError) {
                    console.error("Falha ao definir a sessão ativa:", updateError.message);
                }
            }
        }
    } catch (error) {
        setError(error.message || "Ocorreu um erro. Tente novamente.");
    } finally {
        setLoading(false);
    }
  };

  return (
    <div className="login-screen">
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
          {isSignUp && (
            <div className="form-group">
              <label htmlFor="phone-input">Telefone (com DDD)</label>
              <input
                id="phone-input"
                className="input"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(XX) XXXXX-XXXX"
                required
              />
            </div>
           )}
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

const updatePrompt = `
Papel: Atue como Professor Titular de Medicina e Especialista em Design Instrucional de Alta Complexidade, com domínio simultâneo de conteúdo médico avançado e arquitetura visual HTML/CSS compatível com ambientes que sanitizam estilos.

🎯 OBJETIVO PEDAGÓGICO
Sua tarefa é integrar de forma inteligente novas informações a um resumo existente sobre o mesmo tópico.
Analise os dois inputs abaixo. Reestruture, reescreva e funda os textos para criar uma versão final aprimorada, coesa e de nível acadêmico (Graduação Avançada/Residência).

⬇️ INPUTS DO USUÁRIO
1. **Resumo Original:**
"""
${summary.content}
"""

2. **Novas Informações a serem Integradas:**
"""
${newInformation}
"""

🚫 REGRAS RESTRITIVAS ABSOLUTAS (VISUAL & TÉCNICA)
1. O resultado final DEVE ser um único bloco de conteúdo em formato HTML.
2. NUNCA use imagens externas (<img src="...">).
3. NUNCA use tabelas (<table>).
4. Texto teórico denso é OBRIGATÓRIO (intercalado com elementos visuais).
5. É PROIBIDO aplicar background-color diretamente em tags <h1>, <h2> ou <h3>.
6. Todo título com fundo DEVE estar dentro de um <div> contêiner.
7. Texto branco (#FFFFFF) SÓ é permitido quando o fundo estiver aplicado ao <div> pai.

🧠 FLUXO DE TRABALHO
🔹 FASE 1 — Integração de Conteúdo
- Identifique a lógica médica:
  - Fisiopatologia/Mecanismo → Converta em FLUXOGRAMA (CSS).
  - Critérios/Classificações → Converta em INFO-CARDS.
  - Dados Estatísticos → Converta em GRÁFICOS DE BARRA.
- Planeje blocos de texto explicativo robustos antes e depois de cada elemento visual.

🔹 FASE 2 — Execução Técnica (Templates HTML/CSS Obrigatórios)

🧱 1. TÍTULO PRINCIPAL (H1) - Use EXATAMENTE este wrapper:
<div style="background-color: #003366; padding: 25px 30px; border-radius: 6px; margin-bottom: 30px; border-left: 10px solid #d9534f;">
  <h1 style="color: #ffffff; margin: 0; font-size: 28px;">
    [TÍTULO DO TEMA INTEGRADO]
  </h1>
</div>

🧱 2. SUBTÍTULOS PRINCIPAIS (H2) - Use EXATAMENTE este wrapper:
<div style="background-color: #f4f8fb; padding: 16px 22px; border-radius: 4px; margin: 40px 0 20px; border-left: 6px solid #003366;">
  <h2 style="color: #003366; margin: 0; font-size: 22px;">
    [TÓPICO PRINCIPAL]
  </h2>
</div>

🧱 3. SUBTÓPICOS (H3) - Estilo editorial sem fundo:
<h3 style="color: #003366; border-bottom: 2px solid #d9534f; padding-bottom: 8px; margin-top: 40px;">
  [Subtópico]
</h3>

📄 4. TEXTO CORRIDO (Obrigatório entre visuais):
<p style="text-align: justify; font-size: 16px; margin-bottom: 20px; color: #333333;">
  [Texto acadêmico aqui...]
</p>

🧩 5. ELEMENTOS VISUAIS (Simulação via CSS)
- **Info-Cards:** Caixas com borda colorida e ícones.
- **Fluxogramas:** Divs com fundo cinza/azul claro conectadas por setas (⬇️).
- **Gráficos:** Divs com largura percentual (width: X%) para simular barras.

🧪 VALIDAÇÃO FINAL
Antes de responder, verifique:
✅ As novas informações foram fundidas organicamente ao texto?
✅ Nenhum H1/H2 tem background-color direto?
✅ Todo estilo está inline?

Gere agora APENAS o código HTML resultante da integração.
`;
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
const prompt = `
Atue como um Editor Sênior de Material Didático e Especialista em Conteúdo Técnico (Área da Saúde e Direito).

### Objetivo
Sua tarefa é receber fragmentos de texto formatados em HTML, revisá-los e transformá-los em um material didático visualmente padronizado, garantindo precisão técnica, fluidez acadêmica e design limpo.

### Instruções de Execução:
1. **Preservação e Estrutura:**
   - Mantenha a hierarquia lógica (títulos e subtítulos).
   - Se houver necessidade de imagens contextuais, insira placeholders no formato "[IMAGEM: Descrição do contexto da imagem]".

2. **Aprimoramento de Conteúdo:**
   - Reescreva para tom formal e educativo.
   - Atualize diretrizes (SBC, AHA, Leis, KDIGO) quando aplicável.
   - Complete raciocínios cortados logicamente.

3. **IDENTIDADE VISUAL OBRIGATÓRIA (CSS INLINE):**
Você deve aplicar o seguinte padrão de design em todo o documento. Não use classes externas, aplique style="..." diretamente nas tags.

* **Body/Geral:** Fonte: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f9f9f9; max-width: 1200px; margin: auto;
* **Cabeçalho Principal (H1 e H2):** - Container (div): background-color: #003366; padding: 40px; border-radius: 8px 8px 0 0; margin-bottom: 30px; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    - Texto: color: #ffffff;
* **Blocos de Conteúdo (Sections):** background-color: #fff; padding: 30px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);
* **Títulos de Seção Internos (H3):** background-color: #1a3b5c; color: #ffffff !important; padding: 15px; border-left: 8px solid #d9534f; border-radius: 4px; margin-top: 0;

4. **Tabelas (Proporção Inteligente):**
   - Envelopamento: <div style="overflow-x: auto; width: 100%;">
   - Cabeçalho (th): background-color: #003366; color: #ffffff; padding: 12px; border: 1px solid #ddd;
   - Célula Curta/Rótulo (td): padding: 12px; border: 1px solid #ddd; background-color: #f2f2f2; font-weight: bold; width: 1%; white-space: nowrap; min-width: 120px;
   - Célula de Conteúdo (td): padding: 12px; min-width: 250px; border: 1px solid #ddd; vertical-align: top;

### Formatação de Saída:
Entregue apenas o código HTML finalizado dentro de um bloco de código. Não inclua explicações ou scripts adicionais.

**Input do Usuário (HTML):**
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

const DpManagementModal = ({ isOpen, onClose, user, terms, allSubjects, onSave }) => {
    const [selectedDpSubjects, setSelectedDpSubjects] = useState(new Set());
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        if (isOpen && user) {
            setIsLoading(true);
            const fetchCurrentDps = async () => {
                const { data, error } = await supabase
                    .from('user_subject_access')
                    .select('subject_id')
                    .eq('user_id', user.id);

                if (error) {
                    console.error("Erro ao buscar DPs do usuário:", error);
                } else {
                    setSelectedDpSubjects(new Set(data.map(item => item.subject_id)));
                }
                setIsLoading(false);
            };
            fetchCurrentDps();
        }
    }, [isOpen, user]);

    const handleCheckboxChange = (subjectId) => {
        setSelectedDpSubjects(prev => {
            const newSet = new Set(prev);
            if (newSet.has(subjectId)) {
                newSet.delete(subjectId);
            } else {
                newSet.add(subjectId);
            }
            return newSet;
        });
    };

    const handleSave = () => {
        onSave(user.id, Array.from(selectedDpSubjects));
    };

    if (!isOpen) return null;

    const subjectsByTerm = allSubjects.reduce((acc, subject) => {
        const termId = subject.term_id;
        if (!acc[termId]) {
            acc[termId] = [];
        }
        acc[termId].push(subject);
        return acc;
    }, {});

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content large" onClick={(e) => e.stopPropagation()}>
                <h2>Gerenciar DPs para {user.email}</h2>
                <p>Selecione as matérias de outros períodos que este aluno precisa cursar.</p>

                {isLoading ? (
                    <div className="loader-container"><div className="loader"></div></div>
                ) : (
                    <div className="dp-selection-container">
                        {terms.map(term => (
                            <fieldset key={term.id} className="dp-term-group">
                                <legend>{term.name}</legend>
                                <div className="subjects-checkbox-group">
                                    {(subjectsByTerm[term.id] || []).map(subject => {
                                        const isFromMainTerm = subject.term_id === user.term_id;
                                        return (
                                            <label
                                                key={subject.id}
                                                className={`dp-subject-label ${isFromMainTerm ? 'disabled' : ''}`}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={isFromMainTerm || selectedDpSubjects.has(subject.id)}
                                                    onChange={() => handleCheckboxChange(subject.id)}
                                                    disabled={isFromMainTerm}
                                                />
                                                {subject.name}
                                                {isFromMainTerm && <span className="main-term-indicator">(Período Principal)</span>}
                                            </label>
                                        );
                                    })}
                                </div>
                            </fieldset>
                        ))}
                    </div>
                )}

                <div className="modal-actions">
                    <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
                    <button type="button" className="btn btn-primary" onClick={handleSave} disabled={isLoading}>
                        Salvar Alterações
                    </button>
                </div>
            </div>
        </div>
    );
};


const AdminPanel = ({ onBack, terms, onOpenDpModal, allSubjects }) => {
    const [activeTab, setActiveTab] = useState('reports');

    const UserManagementPanel = () => {
        const [users, setUsers] = useState([]);
        const [loadingUsers, setLoadingUsers] = useState(true);

        const fetchUsers = async () => {
            setLoadingUsers(true);
            try {
                const { data, error } = await supabase
                    .from('profiles')
                    .select('id, email, role, status, login_count, phone, term_id, term:term_id(id, name)')
                    .order('email');

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

        const handleUpdateUserTerm = async (userId, newTermId) => {
            const { error } = await supabase.from('profiles').update({ term_id: newTermId }).eq('id', userId);
            if (error) {
                alert(`Falha ao atualizar o período do usuário: ${error.message}`);
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
                            <th>Telefone</th>
                            <th>Período</th>
                            <th>Status</th>
                            <th>Nº de Acessos</th>
                            <th>Ações</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.filter(u => u.role !== 'admin').map(user => (
                            <tr key={user.id}>
                                <td>{user.email}</td>
                                <td>{user.phone || 'N/A'}</td>
                                <td>
                                    <select
                                        className="select-input-sm"
                                        value={user.term?.id || ''}
                                        onChange={(e) => handleUpdateUserTerm(user.id, e.target.value)}
                                    >
                                        <option value="">Selecione...</option>
                                        {terms.map(term => (
                                            <option key={term.id} value={term.id}>{term.name}</option>
                                        ))}
                                    </select>
                                </td>
                                <td>
                                    <span className={`status-badge status-${user.status || 'default'}`}>
                                        {user.status === 'pending_approval' ? 'Pendente' : user.status === 'active' ? 'Ativo' : user.status === 'blocked' ? 'Bloqueado' : 'Indefinido'}
                                    </span>
                                </td>
                                <td>{user.login_count || 0}</td>
                                <td className="user-actions">
                                    <button className="btn btn-sm btn-secondary" onClick={() => onOpenDpModal(user)}>Gerenciar DPs</button>
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


const Dashboard = ({ user, onLogout, subjects, onSelectSubject, onAddSubject, onEditSubject, onDeleteSubject, theme, toggleTheme, searchQuery, onSearchChange, searchResults, onSelectSummary, lastViewed, completedSummaries, onNavigateToAdmin, onGenerateFlashcardsForAll, onGenerateQuizForAll, isBatchLoading, batchLoadingMessage, onNavigateToSchedules }) => {
  const isSearching = searchQuery.trim() !== '';
  const isAdminOrAmbassador = user.role === 'admin' || user.role === 'embaixador';

  return (
    <div className="container dashboard">
      <div className="dashboard-header">
        <h1>{isSearching ? "Resultados da Busca" : "Início"}</h1>
        <div className="header-actions">
            {isAdminOrAmbassador && <button className="btn btn-secondary" onClick={onNavigateToSchedules}>Agendamentos</button>}
            {user.role === 'admin' && <button className="btn btn-primary" onClick={onNavigateToAdmin}>Painel Admin</button>}
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

const SubjectModal = ({ isOpen, onClose, onSave, subject, user, terms }) => {
    const [name, setName] = useState('');
    const [selectedTermId, setSelectedTermId] = useState('');
    const [color, setColor] = useState('');

    useEffect(() => {
        if (isOpen) {
            setName(subject?.name || '');
            setSelectedTermId(subject?.term_id || (user.role === 'admin' ? '' : user?.term_id));
            setColor(subject?.color || subjectColors[0]);
        }
    }, [isOpen, subject, user]);

    if (!isOpen) return null;

    const handleSubmit = (e) => {
        e.preventDefault();

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

const SummaryListView = ({ subject, summaries, onSelectSummary, onAddSummary, onEditSummary, onDeleteSummary, user, completedSummaries, onAISplit, onReorderSummaries, onGenerateFlashcardsForAll, onGenerateQuizForAll, isBatchLoading, batchLoadingMessage, onOpenMockExamModal }) => {
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

            <div className="dashboard-main-actions">
                <button className="btn btn-primary" onClick={onOpenMockExamModal}>
                    <ClipboardIcon /> Gerar Simulado da Disciplina
                </button>
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

const FlashcardView = ({ flashcards, summaryId, userId }) => {
    const [srsData, setSrsData] = useState(null);
    const [reviewDeck, setReviewDeck] = useState([]);
    const [dueCards, setDueCards] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isFlipped, setIsFlipped] = useState(false);
    const [isFinished, setIsFinished] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [studyMode, setStudyMode] = useState(null);

    const calculateSrs = (srsRecord, knows) => {
        let { interval, ease_factor } = srsRecord || { interval: 0, ease_factor: 2.5 };

        if (knows) {
            if (interval === 0) interval = 1;
            else if (interval === 1) interval = 6;
            else interval = Math.round(interval * ease_factor);
            ease_factor += 0.1;
        } else {
            interval = 1;
            ease_factor = Math.max(1.3, ease_factor - 0.2);
        }

        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + interval);

        return { interval, ease_factor, due_date: dueDate.toISOString() };
    };

    useEffect(() => {
        const initializeDeck = async () => {
            setIsLoading(true);
            if (!userId || !summaryId) {
                setIsLoading(false);
                return;
            }

            const { data, error } = await supabase
                .from('user_flashcard_srs')
                .select('*')
                .eq('user_id', userId)
                .eq('summary_id', summaryId);

            if (error) {
                console.error("Erro ao buscar dados SRS:", error);
            } else {
                const srsMap = new Map(data.map(item => [item.flashcard_front, item]));
                setSrsData(srsMap);

                const today = new Date();
                today.setHours(23, 59, 59, 999);
                const cardsParaRevisar = flashcards.filter(card => {
                    const record = srsMap.get(card.front);
                    return !record || new Date(record.due_date) <= today;
                });
                setDueCards(cardsParaRevisar);
            }
            setIsLoading(false);
        };

        initializeDeck();
    }, [flashcards, summaryId, userId]);

    const startSession = (mode) => {
        setCurrentIndex(0);
        setIsFlipped(false);
        setIsFinished(false);
        setStudyMode(mode);

        if (mode === 'review') {
            setReviewDeck(dueCards);
        } else { // studyAll
            setReviewDeck([...flashcards].sort(() => Math.random() - 0.5));
        }
    };

    // --- FUNÇÃO ---
    const handleAnswer = async (knows) => {
        const currentCard = reviewDeck[currentIndex];
        const currentSrsRecord = srsData?.get(currentCard.front);
        const newSrsData = calculateSrs(currentSrsRecord, knows);

        await supabase.from('user_flashcard_srs').upsert({
            user_id: userId,
            summary_id: summaryId,
            flashcard_front: currentCard.front,
            ...newSrsData,
        });
        setSrsData(prev => new Map(prev).set(currentCard.front, newSrsData));

        setIsFlipped(false);

        setTimeout(() => {
            if (knows) {
                const newDeck = reviewDeck.filter((_, index) => index !== currentIndex);
                setReviewDeck(newDeck);

                if (newDeck.length === 0) {
                    setIsFinished(true);
                } else if (currentIndex >= newDeck.length) {
                    setCurrentIndex(0);
                }

            } else {
                const newDeck = [...reviewDeck.slice(0, currentIndex), ...reviewDeck.slice(currentIndex + 1), currentCard];
                setReviewDeck(newDeck);

                if (currentIndex >= newDeck.length) {
                     setCurrentIndex(0);
                }
            }
        }, 300);
    };


    const handleFlip = () => setIsFlipped(prev => !prev);

    if (isLoading) {
        return <div className="loader-container"><div className="loader"></div></div>;
    }

    if (!studyMode) {
        return (
            <div className="flashcard-container finished-deck">
                <h2>Modo de Estudo</h2>
                <p>Você tem <strong>{dueCards.length}</strong> card(s) para revisar hoje.</p>
                <div className="flashcard-mode-selection">
                    <button className="btn btn-primary" onClick={() => startSession('review')} disabled={dueCards.length === 0}>
                        Revisar Cards de Hoje
                    </button>
                    <button className="btn btn-secondary" onClick={() => startSession('studyAll')}>
                        Estudar Baralho Completo
                    </button>
                </div>
            </div>
        );
    }

    if (isFinished) {
        return (
            <div className="flashcard-container finished-deck">
                <h2>Parabéns!</h2>
                <p>Você concluiu a sessão de estudos.</p>
                <button className="btn btn-primary" onClick={() => { setStudyMode(null); /* Recarrega os cards na próxima entrada */ }}>Voltar</button>
            </div>
        );
    }

    if (!reviewDeck || reviewDeck.length === 0) {
        return (
             <div className="flashcard-container finished-deck">
                <h2>Tudo em dia!</h2>
                <p>Você não tem cards para revisar hoje ou já concluiu todos.</p>
                <button className="btn btn-primary" onClick={() => setStudyMode(null)}>Voltar</button>
            </div>
        );
    }

    const currentCard = reviewDeck[currentIndex];

    return (
        <div className="flashcard-container">
            <div className="flashcard-progress">
                <span>{reviewDeck.length} restante(s)</span>
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

const AnnotationsPanel = ({ summaryId, userId, refreshKey }) => {
    const [annotations, setAnnotations] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const fetchAnnotations = async () => {
            setIsLoading(true);
            const { data, error } = await supabase
                .from('user_annotations')
                .select('*')
                .eq('user_id', userId)
                .eq('summary_id', summaryId)
                .order('created_at', { ascending: false });

            if (error) console.error("Erro ao buscar anotações:", error);
            else setAnnotations(data);
            setIsLoading(false);
        };
        fetchAnnotations();
    }, [summaryId, userId, refreshKey]);

    const deleteAnnotation = async (id) => {
        if (!window.confirm("Tem certeza que deseja apagar esta anotação?")) return;

        await supabase.from('user_annotations').delete().eq('id', id);
        setAnnotations(prev => prev.filter(a => a.id !== id));
    };

    if (isLoading) return <div className="loader-sm"></div>;

    return (
        <aside className="annotations-panel">
            <h4>Minhas Anotações</h4>
            {annotations.length > 0 ? (
                <ul>
                    {annotations.map(anno => (
                        <li key={anno.id} className="annotation-item">
                            {anno.highlighted_text && (
                                <blockquote className="highlighted-quote">
                                    {anno.highlighted_text}
                                </blockquote>
                            )}
                            <p className="note-content">{anno.note_content}</p>
                            <div className="annotation-actions">
                                <span className="annotation-date">{new Date(anno.created_at).toLocaleDateString()}</span>
                                <IconButton onClick={() => deleteAnnotation(anno.id)} className="danger-icon-btn"><DeleteIcon /></IconButton>
                            </div>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="empty-annotations">Selecione um texto no resumo para criar sua primeira anotação.</p>
            )}
        </aside>
    );
};

// --- NOVOS ÍCONES E COMPONENTES PARA ANOTAÇÃO DE DESENHO ---
const EraserIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.42 4.58a2.12 2.12 0 0 0-3-3L5.42 15.58a2.12 2.12 0 0 0 0 3l7 7a2.12 2.12 0 0 0 3 0l5-5a2.12 2.12 0 0 0 0-3zM15 10.5l-5 5M12.5 5.5l5 5"></path></svg>;
const SaveIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>;
const HighlighterIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13.5 2H10a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 2z"></path><polyline points="13 2 13 9 20 9"></polyline><path d="M4 22h7"></path></svg>;

// --- ADICIONADO: Ícones para o botão de bloqueio de rolagem ---
const LockIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>;
const UnlockIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>;


// --- MODIFICADO: AnnotationToolbar agora tem o botão de bloqueio ---
const AnnotationToolbar = ({ tool, onToolChange, color, onColorChange, lineWidth, onLineWidthChange, onSave, isScrollLocked, onToggleScrollLock }) => {
    const colors = ['#E63946', '#007BFF', '#2A9D8F', '#FFC300', '#8338EC', '#FF006E'];
    const PenToolIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>;

    return (
        <div className="annotation-toolbar">
            {/* --- ADICIONADO: Botão de bloqueio de rolagem --- */}
            <IconButton
                onClick={() => onToggleScrollLock(prev => !prev)}
                className={isScrollLocked ? 'active' : ''}
                title={isScrollLocked ? "Desbloquear Rolagem e Sair do Modo Desenho" : "Bloquear Rolagem para Desenhar"}
            >
                {isScrollLocked ? <UnlockIcon /> : <LockIcon />}
            </IconButton>

            <div className="toolbar-separator" />
            {/* --- FIM DA ADIÇÃO --- */}

            <IconButton onClick={() => onToolChange('pen')} className={tool === 'pen' ? 'active' : ''} title="Caneta">
                <PenToolIcon />
            </IconButton>
            <IconButton onClick={() => onToolChange('highlighter')} className={tool === 'highlighter' ? 'active' : ''} title="Marca-Texto">
                <HighlighterIcon />
            </IconButton>
            <IconButton onClick={() => onToolChange('eraser')} className={tool === 'eraser' ? 'active' : ''} title="Borracha">
                <EraserIcon />
            </IconButton>

            <div className="toolbar-separator" />
            {colors.map(c => (
                <button
                    key={c}
                    className={`color-swatch-btn ${color === c && (tool === 'pen' || tool === 'highlighter') ? 'active' : ''}`}
                    style={{ backgroundColor: c }}
                    onClick={() => onColorChange(c)}
                    title={`Cor ${c}`}
                />
            ))}

            {(tool === 'pen' || tool === 'highlighter') && (
                <>
                    <div className="toolbar-separator" />
                    <div className="thickness-slider-container">
                        <input
                            type="range"
                            min="1"
                            max={tool === 'pen' ? "10" : "25"}
                            value={lineWidth}
                            onChange={(e) => onLineWidthChange(Number(e.target.value))}
                            className="thickness-slider"
                            title={`Espessura: ${lineWidth}px`}
                        />
                    </div>
                </>
            )}

            <div className="toolbar-separator" />
            <IconButton onClick={onSave} title="Salvar Anotações">
                <SaveIcon />
            </IconButton>
        </div>
    );
};

// --- MODIFICADO: CanvasAnnotationLayer agora usa a lógica de bloqueio manual ---
const CanvasAnnotationLayer = ({ containerRef, initialStrokes, onSave, isScrollLocked, onToggleScrollLock }) => {
    const canvasRef = useRef(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [strokes, setStrokes] = useState(initialStrokes || []);
    const [tool, setTool] = useState('pen');
    const [color, setColor] = useState('#E63946');
    const [lineWidth, setLineWidth] = useState(3);

    const getCoords = (event) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        return {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
        };
    };

    const startDrawing = (event) => {
        // --- MODIFICADO: Apenas desenha se o bloqueio estiver ativo ---
        if (!isScrollLocked || event.pointerType !== 'pen') return;
        event.preventDefault();

        const coords = getCoords(event);
        if (!coords) return;
        setIsDrawing(true);

        let currentLineWidth = lineWidth;
        if (tool === 'highlighter') currentLineWidth = 20;
        else if (tool === 'eraser') currentLineWidth = 25;

        const newStroke = {
            tool,
            color,
            lineWidth: currentLineWidth,
            points: [{ x: coords.x, y: coords.y, pressure: event.pressure || 0.5 }]
        };
        setStrokes(prev => [...prev, newStroke]);
    };

    const draw = (event) => {
        if (!isDrawing) return;
        event.preventDefault();

        const coords = getCoords(event);
        if (!coords) return;
        setStrokes(prev => {
            const currentStrokes = [...prev];
            const lastStroke = currentStrokes[currentStrokes.length - 1];
            lastStroke.points.push({ x: coords.x, y: coords.y, pressure: event.pressure || 0.5 });
            return currentStrokes;
        });
    };

    const stopDrawing = () => {
        setIsDrawing(false);
    };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const options = { passive: false };

        canvas.addEventListener('pointerdown', startDrawing, options);
        canvas.addEventListener('pointermove', draw, options);
        canvas.addEventListener('pointerup', stopDrawing, options);
        canvas.addEventListener('pointerleave', stopDrawing, options);

        return () => {
            canvas.removeEventListener('pointerdown', startDrawing);
            canvas.removeEventListener('pointermove', draw);
            canvas.removeEventListener('pointerup', stopDrawing);
            canvas.removeEventListener('pointerleave', stopDrawing);
        };
    }, [isDrawing, strokes, tool, color, lineWidth, isScrollLocked]); // Adicionado isScrollLocked às dependências

    useEffect(() => {
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');

        const redrawAll = (ctx) => {
            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            strokes.forEach(stroke => {
                ctx.beginPath();
                ctx.strokeStyle = stroke.color;
                ctx.lineWidth = stroke.lineWidth;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';

                if (stroke.tool === 'highlighter') {
                    ctx.globalAlpha = 0.4;
                    ctx.globalCompositeOperation = 'source-over';
                } else if (stroke.tool === 'eraser') {
                    ctx.globalAlpha = 1.0;
                    ctx.globalCompositeOperation = 'destination-out';
                } else {
                    ctx.globalAlpha = 1.0;
                    ctx.globalCompositeOperation = 'source-over';
                }

                if (stroke.points.length > 0) {
                    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
                    for (let i = 1; i < stroke.points.length; i++) {
                        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
                    }
                }
                ctx.stroke();
            });
            ctx.globalAlpha = 1.0;
            ctx.globalCompositeOperation = 'source-over';
        };

        const resizeCanvas = () => {
            const container = containerRef.current;
            if (container) {
                canvas.width = container.offsetWidth;
                canvas.height = container.offsetHeight;
                redrawAll(context);
            }
        };

        const resizeObserver = new ResizeObserver(resizeCanvas);
        if (containerRef.current) resizeObserver.observe(containerRef.current);

        resizeCanvas();

        return () => {
            if (containerRef.current) resizeObserver.unobserve(containerRef.current);
        };
    }, [strokes, containerRef]);


    return (
        <>
            <canvas
                ref={canvasRef}
                className="annotation-canvas"
            />
            <AnnotationToolbar
                tool={tool}
                onToolChange={(newTool) => {
                    setTool(newTool);
                    if (newTool === 'pen') setLineWidth(3);
                    else if (newTool === 'highlighter') setLineWidth(20);
                }}
                color={color}
                onColorChange={setColor}
                lineWidth={lineWidth}
                onLineWidthChange={setLineWidth}
                onSave={() => onSave(strokes)}
                isScrollLocked={isScrollLocked}
                onToggleScrollLock={onToggleScrollLock}
            />
        </>
    );
};


// --- MODIFICADO: SummaryDetailView agora gerencia o estado de bloqueio ---
const SummaryDetailView = ({ summary, subject, onEdit, onDelete, onGenerateQuiz, onToggleComplete, isCompleted, onGetExplanation, user, onAIUpdate, onGenerateFlashcards, onScheduleClass }) => {
    const [activeTab, setActiveTab] = useState('summary');
    const [isGenerating, setIsGenerating] = useState(false);
    const [isTocVisible, setIsTocVisible] = useState(true);
    const [isAnnotationsPanelVisible, setAnnotationsPanelVisible] = useState(false);
    const [annotationRefreshKey, setAnnotationRefreshKey] = useState(0);

    const [selection, setSelection] = useState({ text: '', x: 0, y: 0 });
    const summaryContentRef = useRef(null);
    const [isAnnotationModalOpen, setAnnotationModalOpen] = useState(false);

    // --- MODIFICADO: Adicionando estado de bloqueio de rolagem ---
    const [isScrollLocked, setIsScrollLocked] = useState(false);
    const [isDrawingMode, setIsDrawingMode] = useState(false);
    const [drawingAnnotations, setDrawingAnnotations] = useState([]);
    const [isFetchingAnnotations, setIsFetchingAnnotations] = useState(false);

    const isAdminOrAmbassador = user.role === 'admin' || user.role === 'embaixador';
    const isStudent = user.role !== 'admin' && user.role !== 'embaixador';

    // --- ADICIONADO: Efeito para travar a rolagem da página ---
    useEffect(() => {
        if (isScrollLocked) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => {
            document.body.style.overflow = '';
        };
    }, [isScrollLocked]);

    useEffect(() => {
        if (!summary?.id || !user?.id) return;

        const fetchDrawingAnnotations = async () => {
            setIsFetchingAnnotations(true);
            const { data, error } = await supabase
                .from('user_drawing_annotations')
                .select('strokes_data')
                .eq('user_id', user.id)
                .eq('summary_id', summary.id)
                .single();

            if (error && error.code !== 'PGRST116') {
                console.error("Erro ao buscar anotações de desenho:", error);
            } else if (data) {
                setDrawingAnnotations(data.strokes_data || []);
            } else {
                setDrawingAnnotations([]);
            }
            setIsFetchingAnnotations(false);
        };

        fetchDrawingAnnotations();
    }, [summary, user]);

    const handleSaveDrawing = async (strokes) => {
        if (!summary?.id || !user?.id) return;
        try {
            const { error } = await supabase
                .from('user_drawing_annotations')
                .upsert({
                    user_id: user.id,
                    summary_id: summary.id,
                    strokes_data: strokes
                }, { onConflict: 'user_id, summary_id' });

            if (error) throw error;
            setDrawingAnnotations(strokes);
            alert("Anotações salvas!");
        } catch (error) {
            console.error("Falha ao salvar anotações de desenho:", error.message, error);
            alert("Erro ao salvar anotações.");
        }
    };

    const handleMouseUp = () => {
        const currentSelection = window.getSelection();
        const selectedText = currentSelection?.toString().trim();
        if (selectedText && selectedText.length > 5) {
            const rect = currentSelection.getRangeAt(0).getBoundingClientRect();
            setSelection({
                text: selectedText,
                x: rect.left + window.scrollX,
                y: rect.bottom + window.scrollY + 5
            });
        } else {
            setSelection({ text: '', x: 0, y: 0 });
        }
    };

    const handleSaveAnnotation = async (noteContent) => {
        const { error } = await supabase.from('user_annotations').insert({
            user_id: user.id,
            summary_id: summary.id,
            highlighted_text: selection.text,
            note_content: noteContent
        });
        if (error) {
            alert("Falha ao salvar anotação.");
        } else {
            setAnnotationModalOpen(false);
            setSelection({ text: '', x: 0, y: 0 });
            setAnnotationRefreshKey(prev => prev + 1);
        }
    };

    useEffect(() => {
        setIsTocVisible(true);
        setAnnotationsPanelVisible(false);
        setIsDrawingMode(false);
        setIsScrollLocked(false); // Garante que o bloqueio é resetado ao trocar de resumo
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

    const PenToolIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>;

    return (
        <div className="summary-detail-layout">
             {isStudent && (
                <button className="fab" onClick={onScheduleClass}>
                    <CalendarIcon />
                    Agendar Aula
                </button>
            )}
             {isAnnotationModalOpen && (
                <AnnotationModal
                    onClose={() => setAnnotationModalOpen(false)}
                    onSave={handleSaveAnnotation}
                    highlightedText={selection.text}
                />
            )}
            <style>{`
                .summary-content h2:has(+ h3) {
                  display: inline-block;
                  vertical-align: middle;
                  margin-bottom: 0;
                  border-top-right-radius: 0;
                  border-bottom-right-radius: 0;
                }
                .summary-content h2 + h3 {
                  display: inline-block;
                  vertical-align: middle;
                  border-top-left-radius: 0;
                  border-bottom-left-radius: 0;
                }
            `}</style>
            {activeTab === 'summary' && isTocVisible && <TableOfContents content={summary.content} />}
            {activeTab === 'summary' && isAnnotationsPanelVisible && <AnnotationsPanel summaryId={summary.id} userId={user.id} refreshKey={annotationRefreshKey} />}

            <div className="summary-detail-view">
                <div className="summary-header">
                    {activeTab === 'summary' && (
                        <div className="summary-view-toggles">
                            <IconButton onClick={() => setIsTocVisible(p => !p)} className={`toc-toggle-btn ${isTocVisible ? 'active' : ''}`} title="Índice">
                                <ListIcon />
                            </IconButton>
                             <IconButton onClick={() => setAnnotationsPanelVisible(p => !p)} className={`toc-toggle-btn ${isAnnotationsPanelVisible ? 'active' : ''}`} title="Anotações de Texto">
                                <ClipboardIcon />
                            </IconButton>
                            <IconButton onClick={() => setIsDrawingMode(p => !p)} className={`toc-toggle-btn ${isDrawingMode ? 'active' : ''}`} title="Modo de Desenho">
                                <PenToolIcon />
                            </IconButton>
                        </div>
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
                     {selection.text && activeTab === 'summary' && (
                        <button
                            className="annotation-creator-btn"
                            style={{ top: selection.y, left: selection.x }}
                            onClick={() => setAnnotationModalOpen(true)}
                        >
                            Criar Anotação
                        </button>
                     )}
                    <div
                        id="tab-panel-summary"
                        role="tabpanel"
                        className={`summary-content ${activeTab === 'summary' ? '' : 'hidden'}`}
                        style={{ '--subject-color': subject?.color || '#6c757d' }}
                        onMouseUp={handleMouseUp}
                    >
                        <div className="annotation-container" ref={summaryContentRef}>
                            <div dangerouslySetInnerHTML={{ __html: summary.content }} />
                            {isDrawingMode && !isFetchingAnnotations && (
                                <CanvasAnnotationLayer
                                    containerRef={summaryContentRef}
                                    initialStrokes={drawingAnnotations}
                                    onSave={handleSaveDrawing}
                                    isScrollLocked={isScrollLocked}
                                    onToggleScrollLock={setIsScrollLocked}
                                />
                            )}
                        </div>
                    </div>

                    <div id="tab-panel-video" role="tabpanel" className={activeTab === 'video' ? '' : 'hidden'}>
                        {summary.video && <GoogleDrivePlayer url={summary.video} />}
                    </div>

                    <div id="tab-panel-flashcards" role="tabpanel" className={activeTab === 'flashcards' ? '' : 'hidden'}>
                        <ProtectedContent>
                            {(summary.flashcards?.length > 0) ? (
                                <>
                                    <FlashcardView flashcards={summary.flashcards} summaryId={summary.id} userId={user.id} />
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
                                    <QuizView questions={summary.questions} onGetExplanation={onGetExplanation} summaryId={summary.id} userId={user.id} />
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

const ScheduleRequestModal = ({ isOpen, onClose, summary, user, onMessageSent }) => {
    const [message, setMessage] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!message.trim()) {
            setError('Por favor, escreva uma mensagem.');
            return;
        }
        setIsLoading(true);
        setError('');

        try {
            const { data: ambassador, error: ambassadorError } = await supabase
                .from('profiles')
                .select('id')
                .eq('term_id', user.term_id)
                .eq('role', 'embaixador')
                .single();

            if (ambassadorError || !ambassador) {
                throw new Error('Não foi possível encontrar um embaixador para este período.');
            }

            const conversationId = crypto.randomUUID();

            const { error: insertError } = await supabase
                .from('schedule_messages')
                .insert({
                    sender_id: user.id,
                    recipient_id: ambassador.id,
                    summary_id: summary.id,
                    message,
                    conversation_id: conversationId,
                });

            if (insertError) {
                throw insertError;
            }

            onMessageSent();
        } catch (err) {
            console.error(err);
            setError(err.message || 'Ocorreu um erro ao enviar a sua solicitação.');
            setIsLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <h2>Agendar Aula</h2>
                <p>Envie uma mensagem para o embaixador do seu período para agendar uma aula sobre <strong>{summary.title}</strong>.</p>
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="schedule-message">Sua Mensagem</label>
                        <textarea
                            id="schedule-message"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            rows={5}
                            placeholder="Olá, gostaria de agendar uma aula sobre este assunto..."
                        />
                    </div>
                    {error && <p className="error-message">{error}</p>}
                    <div className="modal-actions">
                        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
                        <button type="submit" className="btn btn-primary" disabled={isLoading}>
                            {isLoading ? 'Enviando...' : 'Enviar Solicitação'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

const SchedulesView = ({ user, onBack }) => {
    const [conversations, setConversations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedConversation, setSelectedConversation] = useState(null);

    useEffect(() => {
        const fetchConversations = async () => {
            setLoading(true);
            const { data, error } = await supabase.rpc('get_conversations', { p_user_id: user.id });

            if (error) {
                console.error("Erro ao buscar conversas:", error);
            } else {
                setConversations(data);
            }
            setLoading(false);
        };

        fetchConversations();
    }, [user.id]);

    const handleConversationSelect = (conversation) => {
        setSelectedConversation(conversation);
    };

    const handleBackToList = () => {
        setSelectedConversation(null);
    }

    if (loading) {
        return <div className="loader-container"><div className="loader"></div></div>;
    }

    if (selectedConversation) {
        return <ChatView conversation={selectedConversation} currentUser={user} onBack={handleBackToList} />
    }

    return (
        <div className="container schedules-view">
            <div className="dashboard-header">
                <h1>Agendamentos de Aulas</h1>
                <button className="btn btn-secondary" onClick={onBack}>Voltar</button>
            </div>
            <div className="conversation-list">
                {conversations.length > 0 ? (
                    conversations.map((convo) => (
                        <div key={convo.conversation_id} className="conversation-item" onClick={() => handleConversationSelect(convo)}>
                            <div className="conversation-item-header">
                                <span className="conversation-item-user">{convo.other_user_email}</span>
                                <span className="conversation-item-summary">{convo.summary_title}</span>
                            </div>
                            <p className="conversation-item-message">{convo.last_message}</p>
                        </div>
                    ))
                ) : (
                    <p>Nenhuma conversa de agendamento encontrada.</p>
                )}
            </div>
        </div>
    );
};

const ChatView = ({ conversation, currentUser, onBack }) => {
    const [messages, setMessages] = useState([]);
    const [newMessage, setNewMessage] = useState('');
    const messagesEndRef = useRef(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        const fetchMessages = async () => {
            const { data, error } = await supabase
                .from('schedule_messages')
                .select('*, sender:sender_id(email)')
                .eq('conversation_id', conversation.conversation_id)
                .order('created_at', { ascending: true });

            if (error) {
                console.error('Error fetching messages:', error);
            } else {
                setMessages(data);
            }
        };

        fetchMessages();

        const channel = supabase.channel(`schedule-messages:${conversation.conversation_id}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'schedule_messages',
                filter: `conversation_id=eq.${conversation.conversation_id}`
            }, (payload) => {
                setMessages((prev) => [...prev, payload.new]);
            })
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [conversation.conversation_id]);

    useEffect(scrollToBottom, [messages]);

    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (!newMessage.trim()) return;

        const { error } = await supabase.from('schedule_messages').insert({
            sender_id: currentUser.id,
            recipient_id: conversation.other_user_id,
            summary_id: conversation.summary_id,
            message: newMessage,
            conversation_id: conversation.conversation_id,
        });

        if (error) {
            console.error('Error sending message:', error);
        } else {
            setNewMessage('');
        }
    };

    return (
        <div className="container chat-view">
            <div className="dashboard-header">
                <button className="btn btn-secondary" onClick={onBack}>Voltar</button>
                <h2>{conversation.summary_title}</h2>
                <span>{conversation.other_user_email}</span>
            </div>
            <div className="chat-messages">
                {messages.map(msg => (
                    <div key={msg.id} className={`chat-message ${msg.sender_id === currentUser.id ? 'sent' : 'received'}`}>
                        <p>{msg.message}</p>
                        <span className="chat-message-time">{new Date(msg.created_at).toLocaleTimeString()}</span>
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>
            <form className="chat-input-form" onSubmit={handleSendMessage}>
                <input
                    type="text"
                    className="input"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    placeholder="Digite sua mensagem..."
                />
                <button type="submit" className="btn btn-primary">Enviar</button>
            </form>
        </div>
    );
};

const AnnotationModal = ({ onClose, onSave, highlightedText }) => {
    const [noteContent, setNoteContent] = useState('');

    const handleSave = () => {
        if (noteContent.trim()) {
            onSave(noteContent);
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <h2>Adicionar Anotação</h2>
                {highlightedText && (
                    <blockquote className="highlighted-quote-modal">
                        {highlightedText}
                    </blockquote>
                )}
                <textarea
                    placeholder="Escreva sua anotação aqui..."
                    value={noteContent}
                    onChange={(e) => setNoteContent(e.target.value)}
                    rows={6}
                />
                <div className="modal-actions">
                    <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
                    <button className="btn btn-primary" onClick={handleSave} disabled={!noteContent.trim()}>Salvar Anotação</button>
                </div>
            </div>
        </div>
    );
};

// --- ATUALIZADO: `MockExamModal` agora usa `summaries` (matérias) em vez de `subjects` (disciplinas) ---
const MockExamModal = ({ isOpen, onClose, onStartExam, summaries, user }) => {
    const [selectedSummaries, setSelectedSummaries] = useState([]);
    const [numQuestions, setNumQuestions] = useState(10);
    const [focusOnErrors, setFocusOnErrors] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setSelectedSummaries([]);
            setNumQuestions(10);
            setFocusOnErrors(false);
        }
    }, [isOpen]);

    const handleSummaryChange = (summaryId) => {
        setSelectedSummaries(prev =>
            prev.includes(summaryId)
                ? prev.filter(id => id !== summaryId)
                : [...prev, summaryId]
        );
    };

    const handleStart = () => {
        if (selectedSummaries.length === 0) {
            alert("Por favor, selecione pelo menos uma matéria.");
            return;
        }
        onStartExam({
            summaryIds: selectedSummaries,
            count: numQuestions,
            errorsOnly: focusOnErrors
        });
    };

    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content large" onClick={e => e.stopPropagation()}>
                <h2>Gerar Simulado Personalizado</h2>
                <div className="form-group">
                    <label>Matérias (Resumos)</label>
                    <div className="subjects-checkbox-group">
                        {summaries.map(sum => (
                            <label key={sum.id}>
                                <input
                                    type="checkbox"
                                    checked={selectedSummaries.includes(sum.id)}
                                    onChange={() => handleSummaryChange(sum.id)}
                                />
                                {sum.title}
                            </label>
                        ))}
                    </div>
                </div>
                <div className="form-group">
                    <label htmlFor="num-questions">Número de Questões</label>
                    <input
                        id="num-questions"
                        type="number"
                        className="input"
                        value={numQuestions}
                        onChange={e => setNumQuestions(Math.max(1, parseInt(e.target.value, 10) || 1))}
                        min="1"
                        max="100"
                    />
                </div>
                <div className="form-group">
                    <label>
                        <input
                            type="checkbox"
                            checked={focusOnErrors}
                            onChange={e => setFocusOnErrors(e.target.checked)}
                        />
                        Focar em questões que já errei
                    </label>
                </div>
                <div className="modal-actions">
                    <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
                    <button className="btn btn-primary" onClick={handleStart} disabled={selectedSummaries.length === 0}>
                        Iniciar Simulado
                    </button>
                </div>
            </div>
        </div>
    );
};

const MockExamView = ({ questions, onFinishExam }) => {
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [userAnswers, setUserAnswers] = useState({});
    const isFinished = currentQuestionIndex >= questions.length;

    const handleAnswer = (alternativeIndex) => {
        setUserAnswers(prev => ({...prev, [currentQuestionIndex]: alternativeIndex}));
    };

    const goToNext = () => {
        if (userAnswers[currentQuestionIndex] !== undefined) {
             setCurrentQuestionIndex(prev => prev + 1);
        } else {
            alert("Por favor, selecione uma alternativa.");
        }
    };

    if (isFinished) {
        let score = 0;
        questions.forEach((q, index) => {
            if (q.correctAlternativeIndex === userAnswers[index]) {
                score++;
            }
        });
        const percentage = questions.length > 0 ? Math.round((score / questions.length) * 100) : 0;

        return (
            <div className="container mock-exam-results">
                <h2>Simulado Concluído!</h2>
                <p className="final-score">Sua Pontuação: {score} de {questions.length} ({percentage}%)</p>
                <button className="btn btn-primary" onClick={onFinishExam}>Voltar ao Início</button>
            </div>
        );
    }

    const question = questions[currentQuestionIndex];
    const userAnswer = userAnswers[currentQuestionIndex];
    const isAnswered = userAnswer !== undefined;

    return (
        <div className="container mock-exam-view">
             <div className="mock-exam-header">
                <h1>Simulado</h1>
                <span>Questão {currentQuestionIndex + 1} de {questions.length}</span>
            </div>
            <div className="question-block">
                <p className="question-text">{question.questionText}</p>
                 <div className="alternatives-list">
                    {question.alternatives.map((alt, aIndex) => (
                        <button
                            key={aIndex}
                            className={`alternative-item ${isAnswered && userAnswer === aIndex ? 'selected' : ''}`}
                            onClick={() => handleAnswer(aIndex)}
                            disabled={isAnswered}
                        >
                            {alt}
                        </button>
                    ))}
                </div>
            </div>
            <div className="mock-exam-footer">
                <button className="btn btn-primary" onClick={goToNext}>
                    {currentQuestionIndex === questions.length - 1 ? "Finalizar Simulado" : "Próxima Questão"}
                </button>
            </div>
        </div>
    );
};


// --- COMPONENTE PRINCIPAL APP ---
const App = () => {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [terms, setTerms] = useState([]);
  const [allSubjects, setAllSubjects] = useState([]);
  const [theme] = useState('light');
  const [view, setView] = useState('dashboard');
  const [currentSubjectId, setCurrentSubjectId] = useState(null);
  const [currentSummaryId, setCurrentSummaryId] = useState(null);
  const [subjects, setSubjects] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [completedSummaries, setCompletedSummaries] = useState([]);
  const [lastViewed, setLastViewed] = useState([]);
  const [isSubjectModalOpen, setSubjectModalOpen] = useState(false);
  const [isSummaryModalOpen, setSummaryModalOpen] = useState(false);
  const [isAISplitterModalOpen, setAISplitterModalOpen] = useState(false);
  const [isAIUpdateModalOpen, setAIUpdateModalOpen] = useState(false);
  const [isScheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [isMockExamModalOpen, setMockExamModalOpen] = useState(false);
  const [isDpModalOpen, setIsDpModalOpen] = useState(false);
  const [managingDpForUser, setManagingDpForUser] = useState(null);
  const [editingSubject, setEditingSubject] = useState(null);
  const [editingSummary, setEditingSummary] = useState(null);
  const [isBatchLoading, setIsBatchLoading] = useState(false);
  const [batchLoadingMessage, setBatchLoadingMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTermForAdmin, setSelectedTermForAdmin] = useState(null);
  const [areSummariesLoaded, setAreSummariesLoaded] = useState(false);
  const [mockExamQuestions, setMockExamQuestions] = useState([]);

  useEffect(() => {
    if (user) {
      const localSessionId = localStorage.getItem('active_session_id');

      if (!localSessionId) {
          return;
      }

      const channel = supabase.channel(`profile-updates:${user.id}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'profiles',
            filter: `id=eq.${user.id}`
          },
          (payload) => {
            const newRemoteSessionId = payload.new.active_session_id;

            if (newRemoteSessionId && newRemoteSessionId !== localSessionId) {
              supabase.removeChannel(channel);
              alert("Sua conta foi acessada em um novo dispositivo. Esta sessão será encerrada.");
              supabase.auth.signOut();
            }
          }
        )
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }
  }, [user]);

  const fetchUserProgress = async (userId) => {
    const { data, error } = await supabase.from('user_summary_progress').select('summary_id').eq('user_id', userId);
    if (error) console.error("Erro ao buscar progresso do usuário:", error);
    else setCompletedSummaries(data.map(item => item.summary_id));
  };

  const fetchUserSubjects = async (userId) => {
      const { data, error } = await supabase.rpc('get_user_accessible_subjects', { p_user_id: userId });
      if (error) {
          console.error("Erro ao buscar disciplinas do usuário:", error);
          setSubjects([]);
      } else {
          setSubjects(data || []);
      }
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
      }
    );

    const fetchInitialData = async () => {
        const { data: termsData } = await supabase.from('terms').select('*').order('id');
        setTerms(termsData || []);
        const { data: allSubjectsData } = await supabase.from('subjects').select('*').order('term_id').order('name');
        setAllSubjects(allSubjectsData || []);
    };
    fetchInitialData();

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session && !user) {
      const setupUserAndFetchData = async () => {
        setLoading(true);
        try {
          const { data: profileData, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .single();

          if (profileError) throw profileError;
          const fullUser = { ...session.user, ...profileData };
          setUser(fullUser);

          if (fullUser.status === 'active') {
            await supabase.rpc('increment_login_count');
            await fetchUserProgress(session.user.id);
            if (fullUser.role !== 'admin') {
                await fetchUserSubjects(fullUser.id);
            }
          }
        } catch (error) {
           console.error("Falha ao configurar o usuário e buscar dados:", error);
           supabase.auth.signOut();
        } finally {
            setLoading(false);
        }
      };
      setupUserAndFetchData();
    }
    else if (!session && user) {
        setUser(null);
        setSubjects([]);
        setSummaries([]);
        setCompletedSummaries([]);
        setView('dashboard');
    }
  }, [session, user]);

  // CORREÇÃO: Effect separado para garantir que o admin receba as disciplinas após o carregamento
  useEffect(() => {
      if (user?.role === 'admin' && allSubjects.length > 0) {
          setSubjects(allSubjects);
      }
  }, [user, allSubjects]);


  useEffect(() => {
    const fetchAllSummariesInBackground = async () => {
        if (!user || subjects.length === 0 || areSummariesLoaded) return;
        try {
            const visibleSubjectIds = subjects.map(s => s.id);
            if (visibleSubjectIds.length === 0) {
                 setAreSummariesLoaded(true);
                 return;
            }
            const { data: summariesData, error: summariesError } = await supabase
                .from('summaries')
                .select('*')
                .in('subject_id', visibleSubjectIds)
                .order('position', { ascending: true });
            if (summariesError) throw summariesError;
            const parseJsonField = (field, fallback = []) => {
                if (typeof field === 'string') { try { const parsed = JSON.parse(field); return Array.isArray(parsed) ? parsed : fallback; } catch (e) { return fallback; } }
                return Array.isArray(field) ? field : fallback;
            };
            const processedSummaries = (summariesData || []).map(s => ({ ...s, questions: parseJsonField(s.questions), flashcards: parseJsonField(s.flashcards) }));
            setSummaries(processedSummaries);
        } catch (error) {
            console.error("Erro ao carregar resumos em segundo plano:", error);
        } finally {
            setAreSummariesLoaded(true);
        }
    };
    fetchAllSummariesInBackground();
  }, [user, subjects, areSummariesLoaded]);

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

  const handleLogout = async () => {
      if (user) {
        localStorage.removeItem(`integrator_week_answers_${user.id}`);
        localStorage.removeItem(`integrator_week_questions_${user.id}`);
        localStorage.removeItem('active_session_id');
      }
      await supabase.auth.signOut();
      setUser(null);
      setSession(null);
      setView("login");
    };

  const handleSelectSubject = (subject) => {
    if (subject.name.toLowerCase().trim() === 'semana integradora') {
        setCurrentSubjectId(subject.id);
        setView('integrator_week');
    } else {
        setCurrentSubjectId(subject.id);
        setView('subject');
    }
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

  const handleBackToDashboard = () => { setView('dashboard'); setCurrentSubjectId(null); setCurrentSummaryId(null); }
  const handleBackToSubject = () => { setCurrentSummaryId(null); setView('subject'); };

  const handleTermUpdate = async (newTermId) => {
      const { data, error } = await supabase.from('profiles').update({ term_id: newTermId }).eq('id', user.id).select().single();
      if (error) { alert("Erro ao salvar o termo."); }
      else if (data) {
          const updatedUser = { ...user, ...data };
          setUser(updatedUser);
          await fetchUserSubjects(updatedUser.id);
      }
  };

  const handleSaveSubject = async (subjectData) => {
    if (!subjectData.term_id) { alert("O período da disciplina não foi especificado."); return; }
    if (subjectData.id) {
        const { data, error } = await supabase.from('subjects').update({ name: subjectData.name, color: subjectData.color, term_id: subjectData.term_id }).eq('id', subjectData.id).select().single();
        if (error) alert(error.message);
        else if (data) {
            setSubjects(subjects.map(s => s.id === data.id ? data : s));
            setAllSubjects(allSubjects.map(s => s.id === data.id ? data : s));
        }
    } else {
        const { data, error } = await supabase.from('subjects').insert({ name: subjectData.name, color: subjectData.color, user_id: session.user.id, term_id: subjectData.term_id }).select().single();
        if (error) alert(error.message);
        else if (data) {
            setSubjects([...subjects, data]);
            setAllSubjects([...allSubjects, data]);
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
          setAllSubjects(allSubjects.filter(s => s.id !== subjectId));
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
        const { error } = await supabase.from('summaries').update(payload).eq('id', summaryData.id);

        if (error) {
            alert(error.message);
        } else {
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

  const handleSaveDpSubjects = async (userId, selectedSubjectIds) => {
    setIsDpModalOpen(false);
    const { error: deleteError } = await supabase.from('user_subject_access').delete().eq('user_id', userId);
    if (deleteError) {
        alert("Erro ao limpar DPs antigas. A operação foi cancelada.");
        console.error(deleteError);
        return;
    }

    if (selectedSubjectIds.length > 0) {
        const newDps = selectedSubjectIds.map(subjectId => ({ user_id: userId, subject_id: subjectId }));
        const { error: insertError } = await supabase.from('user_subject_access').insert(newDps);
        if (insertError) {
            alert("Erro ao salvar as novas DPs.");
            console.error(insertError);
            return;
        }
    }

    alert("As DPs do usuário foram atualizadas com sucesso!");
    setManagingDpForUser(null);
  };


  const handleReorderSummaries = async (startIndex, endIndex) => {
    const subjectSummaries = summaries.filter(s => s.subject_id === currentSubjectId).sort((a, b) => a.position - b.position);
    const [removed] = subjectSummaries.splice(startIndex, 1);
    subjectSummaries.splice(endIndex, 0, removed);
    const updatedSummaries = subjectSummaries.map((s, index) => ({ ...s, position: index }));
    setSummaries(prev => [...prev.filter(s => s.subject_id !== currentSubjectId), ...updatedSummaries]);
    const updates = updatedSummaries.map(s => supabase.from('summaries').update({ position: s.position }).eq('id', s.id));
    await Promise.all(updates);
  };

  const handleGenerateQuiz = async () => {
    const summary = summaries.find(s => s.id === currentSummaryId);
    if (!summary) return;
    try {
        const prompt = `
**PAPEL:** Você é um elaborador de questões de alto nível para bancas de residência médica, especificamente no padrão ENARE e Enamed.

**TAREFA:** Gere um quiz de múltipla escolha baseado no resumo fornecido.

**DIRETRIZES TÉCNICAS:**
1. **Dificuldade:** As questões devem ser de nível difícil, priorizando exclusivamente casos clínicos complexos em vez de perguntas conceituais diretas.
2. **Estilo ENARE:** Use enunciados que descrevam um quadro clínico (anamnese, exame físico, exames complementares) e exijam a conduta mais adequada, diagnóstico ou fisiopatologia.
3. **Volume Dinâmico:** - Analise a relevância epidemiológica e a complexidade do conteúdo abaixo.
   - Se o tema for de baixa gravidade/importância clínica: gere 20 questões.
   - Conforme a importância e o volume de informações aumentarem, aumente a quantidade, podendo chegar a até 50 questões para temas extensos e vitais.
4. **Alternativas:** Devem ser 4 alternativas (A, B, C, D). Os distratores devem ser plausíveis, baseados em erros comuns de diagnóstico ou condutas desatualizadas.

**RESUMO PARA ANÁLISE:**
"""
${summary.content.replace(/<[^>]*>?/gm, ' ')}
"""

**SAÍDA:** Retorne estritamente o JSON conforme o schema solicitado.`;
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
        const prompt = `Baseado no resumo sobre "${summary.title}"... Resumo: """${summary.content.replace(/<[^>]*>?/gm, ' ')}"""`;
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
                const prompt = isFlashcards ? `Baseado no resumo sobre "${summary.title}", crie flashcards...` : `Baseado no resumo... crie questões...`;
                const schema = isFlashcards ? flashcardsSchema : quizSchema;
                const parsedJson = await generateAIContentWithRetry(prompt, schema);
                const contentPayload = parsedJson[isFlashcards ? 'flashcards' : 'questions'];
                const { error } = await supabase.from('summaries').update({ [contentType]: contentPayload }).eq('id', summary.id);

                if (error) {
                    throw new Error(`Falha ao salvar no resumo "${summary.title}": ${error.message}`);
                }

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

    const handleStartMockExam = async (config) => {
        setLoading(true);
        setMockExamModalOpen(false);

        try {
            const { data: summariesWithQuestions, error: summariesError } = await supabase
                .from('summaries')
                .select('questions')
                .in('id', config.summaryIds)
                .not('questions', 'is', null);

            if (summariesError) throw summariesError;

            let allQuestions = summariesWithQuestions.flatMap(s => s.questions || []);

            if (config.errorsOnly) {
                const { data: errorAttempts, error: attemptsError } = await supabase
                    .from('user_quiz_attempts')
                    .select('question_text')
                    .eq('user_id', user.id)
                    .eq('is_correct', false);

                if (attemptsError) throw attemptsError;

                const errorQuestionsText = new Set(errorAttempts.map(a => a.question_text));
                allQuestions = allQuestions.filter(q => errorQuestionsText.has(q.questionText));
            }

            if (allQuestions.length === 0) {
                alert("Nenhuma questão encontrada para os critérios selecionados. Tente novamente.");
                setLoading(false);
                return;
            }

            const shuffled = allQuestions.sort(() => 0.5 - Math.random());
            const selectedQuestions = shuffled.slice(0, config.count);

            setMockExamQuestions(selectedQuestions);
            setView('mock_exam');

        } catch (error) {
            console.error("Erro ao gerar simulado:", error);
            alert("Não foi possível gerar o simulado. Tente novamente.");
        } finally {
            setLoading(false);
        }
    };

  const currentSubject = subjects.find(s => s.id === currentSubjectId);
  const currentSummary = summaries.find(s => s.id === currentSummaryId);
  const summariesForCurrentSubject = useMemo(() => summaries.filter(s => s.subject_id === currentSubjectId).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)), [summaries, currentSubjectId]);

  const subjectsForUser = useMemo(() => {
    if (user?.role === 'admin') {
      if (selectedTermForAdmin) {
        return allSubjects.filter(s => String(s.term_id) === String(selectedTermForAdmin));
      }
      return allSubjects; // Admin vê a lista completa
    }
    return subjects; // Alunos/Embaixadores veem sua lista personalizada
  }, [subjects, allSubjects, user, selectedTermForAdmin]);


  const searchResults = useMemo(() => {
    if (!areSummariesLoaded) return { subjects: [], summaries: [], allSummaries: [] };
    const relevantSubjects = user?.role === 'admin' ? allSubjects : subjects;
    const allSummariesWithSubject = summaries.map(sum => ({ ...sum, subjectName: relevantSubjects.find(sub => sub.id === sum.subject_id)?.name || '' }));

    if (!searchQuery.trim()) return { subjects: [], summaries: [], allSummaries: summaries };

    const q = searchQuery.toLowerCase();
    const filteredSubjects = subjectsForUser.filter(s => s.name.toLowerCase().includes(q));
    const filteredSummaries = allSummariesWithSubject.filter(s =>
        s.title.toLowerCase().includes(q) &&
        subjectsForUser.some(sub => sub.id === s.subject_id)
    );

    return {
        subjects: filteredSubjects.map(s => ({ ...s, summaryCount: summaries.filter(sum => sum.subject_id === s.id).length })),
        summaries: filteredSummaries,
        allSummaries: summaries
    };
  }, [searchQuery, subjectsForUser, summaries, subjects, allSubjects, areSummariesLoaded, user]);


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
                <Dashboard
                    user={user}
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
                    onNavigateToSchedules={() => setView('schedules')}
                />
            </>
        );
      case 'subject':
        return <SummaryListView
            subject={currentSubject}
            summaries={summariesForCurrentSubject}
            onSelectSummary={handleSelectSummary}
            onAddSummary={() => { setEditingSummary(null); setSummaryModalOpen(true); }}
            onEditSummary={(s) => { setEditingSummary(s); setSummaryModalOpen(true); }}
            onDeleteSummary={handleDeleteSummary}
            user={user}
            completedSummaries={completedSummaries}
            onAISplit={() => setAISplitterModalOpen(true)}
            onReorderSummaries={handleReorderSummaries}
            onGenerateFlashcardsForAll={() => generateForAll('flashcards')}
            onGenerateQuizForAll={() => generateForAll('questions')}
            isBatchLoading={isBatchLoading}
            batchLoadingMessage={batchLoadingMessage}
            onOpenMockExamModal={() => setMockExamModalOpen(true)}
        />;
      case 'summary':
        return <SummaryDetailView summary={currentSummary} subject={currentSubject} onEdit={() => { setEditingSummary(currentSummary); setSummaryModalOpen(true); }} onDelete={() => handleDeleteSummary(currentSummary.id)} onGenerateQuiz={handleGenerateQuiz} onToggleComplete={handleToggleComplete} isCompleted={completedSummaries.includes(currentSummary.id)} onGetExplanation={handleGetExplanation} user={user} onAIUpdate={() => setAIUpdateModalOpen(true)} onGenerateFlashcards={handleGenerateFlashcards} onScheduleClass={() => setScheduleModalOpen(true)} />;
      case 'integrator_week':
        return <IntegratorWeekView subject={currentSubject} allSubjects={subjects} user={user} />;
      case 'admin':
        return <AdminPanel
                    onBack={handleBackToDashboard}
                    terms={terms}
                    allSubjects={allSubjects}
                    onOpenDpModal={(userToManage) => { setManagingDpForUser(userToManage); setIsDpModalOpen(true); }}
                />;
      case 'schedules':
        return <SchedulesView user={user} onBack={handleBackToDashboard} />;
      case 'mock_exam':
        return <MockExamView questions={mockExamQuestions} onFinishExam={() => { setMockExamQuestions([]); handleBackToDashboard(); }} />;
      default:
        return <div>Carregando...</div>;
    }
  };

  const breadcrumbPaths = useMemo(() => {
      const paths = [{ name: 'Início', onClick: handleBackToDashboard }];
      if ((view === 'subject' || view === 'integrator_week') && currentSubject) {
          paths.push({ name: currentSubject.name, onClick: () => {} });
      } else if (view === 'summary' && currentSubject && currentSummary) {
          paths.push({ name: currentSubject.name, onClick: handleBackToSubject });
          paths.push({ name: currentSummary.title, onClick: () => {} });
      } else if (view === 'mock_exam') {
          paths.push({ name: 'Simulado', onClick: () => {} });
      }
      return paths;
  }, [view, currentSubject, currentSummary]);

  const showHeader = user && user.status === 'active' && !['dashboard', 'admin', 'schedules'].includes(view);

  return (
    <>
      {showHeader && (
          <div className="main-header">
              <Breadcrumbs paths={breadcrumbPaths} />
          </div>
      )}
      {renderContent()}

      <SubjectModal isOpen={isSubjectModalOpen} onClose={() => setSubjectModalOpen(false)} onSave={handleSaveSubject} subject={editingSubject} user={user} terms={terms} />
      <SummaryModal isOpen={isSummaryModalOpen} onClose={() => setSummaryModalOpen(false)} onSave={handleSaveSummary} summary={editingSummary} subjectId={currentSubjectId} />
      <AISplitterModal isOpen={isAISplitterModalOpen} onClose={() => setAISplitterModalOpen(false)} onSummariesCreated={handleSplitAndSaveSummaries} />
      {isAIUpdateModalOpen && currentSummary && <AIUpdateModal summary={currentSummary} onClose={() => setAIUpdateModalOpen(false)} onUpdate={(newContent) => handleUpdateSummaryContent(currentSummary.id, newContent)} />}
      {isScheduleModalOpen && currentSummary && user && <ScheduleRequestModal isOpen={isScheduleModalOpen} onClose={() => setScheduleModalOpen(false)} summary={currentSummary} user={user} onMessageSent={() => {setScheduleModalOpen(false); alert("Sua solicitação foi enviada!");}}/>}
      {user && <MockExamModal
          isOpen={isMockExamModalOpen}
          onClose={() => setMockExamModalOpen(false)}
          onStartExam={handleStartMockExam}
          summaries={summariesForCurrentSubject}
          user={user}
      />}
       <DpManagementModal
            isOpen={isDpModalOpen}
            onClose={() => setIsDpModalOpen(false)}
            user={managingDpForUser}
            terms={terms}
            allSubjects={allSubjects}
            onSave={handleSaveDpSubjects}
        />
    </>
  );
};

const root = createRoot(document.getElementById('root'));
root.render(<App />);
