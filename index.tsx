import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import { createClient, Session } from '@supabase/supabase-js';

// --- CONFIGURAÇÃO DO SUPABASE ---
// Cole suas credenciais do Supabase aqui
const supabaseUrl = 'https://vylpdfeqdylcqxzllnbh.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5bHBkZmVxZHlsY3F4emxsbmJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcxNjY3NzMsImV4cCI6MjA3Mjc0Mjc3M30.muT9yFZaHottkDM-acc6iU5XHqbo7yqTF-bpPoAotMY';
export const supabase = createClient(supabaseUrl, supabaseAnonKey);


// --- DADOS MOCADOS (APENAS PARA PREENCHER A INTERFACE INICIALMENTE) ---
// Em uma aplicação real, os termos também viriam do banco de dados.
const initialTerms = Array.from({ length: 12 }, (_, i) => ({
    id: `t${i + 1}`,
    name: `${i + 1}º Termo`,
}));

// --- CONFIGURAÇÃO DA IA (Mantido do código original) ---
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  throw new Error("API_KEY environment variable not set");
}
const ai = new GoogleGenAI({ apiKey: API_KEY });
const model = "gemini-2.5-flash";

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
      description: 'Uma lista de exatamente 5 questões de múltipla escolha no padrão Intercampi.',
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

const QuizQuestion = ({ question }) => {
  const [selected, setSelected] = useState<number | null>(null);

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
            <p className="incorrect">❌ Você errou.
              <br />A resposta correta é: <strong>
                {question.alternatives[question.correctAlternativeIndex]}
              </strong>
            </p>
          )}
          <p><strong>Comentário:</strong> {question.explanation}</p>
        </div>
      )}
    </div>
  );
};

// --- FUNÇÕES AUXILIARES (HELPER FUNCTIONS) ---
const subjectColors = ['#007BFF', '#28A745', '#DC3545', '#FFC107', '#17A2B8', '#6610f2', '#fd7e14', '#20c997', '#e83e8c'];
const getNewSubjectColor = (existingSubjects) => {
    const usedColors = new Set(existingSubjects.map(s => s.color));
    const availableColor = subjectColors.find(c => !usedColors.has(c));
    return availableColor || subjectColors[Math.floor(Math.random() * subjectColors.length)];
};

const getGoogleDriveEmbedUrl = (url) => {
    if (!url) return null;
    const regExp = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/;
    const match = url.match(regExp);
    return (match && match[1]) ? `https://drive.google.com/file/d/${match[1]}/preview` : null;
};

const getSpotifyEmbedUrl = (url) => {
    if (!url) return null;
    const match = url.match(/open\.spotify\.com\/(track|episode)\/([a-zA-Z0-9]+)/);
    if (match && match[1] && match[2]) {
        return `https://open.spotify.com/embed/${match[1]}/${match[2]}`;
    }
    return null;
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

const IconButton = ({ onClick, children, className = '' }) => (
    <button className={`icon-btn ${className}`} onClick={(e) => { e.stopPropagation(); onClick(e); }}>
        {children}
    </button>
);

const EditIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>;
const DeleteIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>;
const CheckCircleIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>;
const SearchIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>;
const SparklesIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L14.39 8.36L21 9.27L16.36 14.14L18.18 21L12 17.27L5.82 21L7.64 14.14L3 9.27L9.61 8.36L12 2z"/></svg>;
// NOVO: Ícone para o botão de exibir/ocultar o sumário
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

// --- TELA DE LOGIN CORRIGIDA ---
const LoginScreen = ({ theme, toggleTheme }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

    } catch (error) { // <-- CORREÇÃO: Removido o "=>" daqui
      setError("Email ou senha inválidos. Tente novamente.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      <div className="login-card">
        <h1>Med<span>flix</span></h1>
        <p>Faça login para continuar</p>
        <form onSubmit={handleLogin}>
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
            {loading ? 'Carregando...' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
};


const AIUpdateModal = ({ onClose, onUpdate, summary }) => {
    const [isLoading, setIsLoading] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState('');
    const [error, setError] = useState('');
    const [audioFile, setAudioFile] = useState(null);
    // NOVO: Estado para armazenar o texto do usuário
    const [textContent, setTextContent] = useState('');

    // Função auxiliar para converter o áudio em base64 (mantida)
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
        // --- LÓGICA ATUALIZADA ---
        // Validação: Garante que pelo menos um dos dois (áudio ou texto) foi fornecido.
        if (!audioFile && !textContent.trim()) {
            setError('Por favor, selecione um arquivo de áudio ou cole o texto com as novas informações.');
            return;
        }
        setIsLoading(true);
        setError('');

        try {
            let textFromAudio = '';
            // 1) Transcrição do áudio (se existir)
            if (audioFile) {
                setLoadingMessage('Transcrevendo o áudio...');
                const base64Audio = await fileToBase64(audioFile);

                const transcription = await ai.models.generateContent({
                    model: "gemini-2.5-flash",
                    contents: [
                        {
                            role: "user",
                            parts: [
                                { text: "Transcreva este áudio para texto em português médico-acadêmico:" },
                                { inlineData: { mimeType: audioFile.type, data: base64Audio } }
                            ]
                        }
                    ]
                });

                textFromAudio = transcription.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (!textFromAudio) {
                    throw new Error("Falha na transcrição do áudio");
                }
            }

            // 2) Combina as informações do áudio e do texto
            const newInformation = `
                ${textFromAudio ? `Informações do áudio transcrito:\n"""${textFromAudio}"""\n\n` : ''}
                ${textContent.trim() ? `Informações do texto fornecido:\n"""${textContent.trim()}"""` : ''}
            `.trim();

            // 3) Atualização do resumo com IA
            setLoadingMessage('Atualizando o resumo com as novas informações...');
            const updatePrompt = `Você é um especialista em redação médica.
            Sua tarefa é atualizar o resumo abaixo com as novas informações da aula,
            integrando de forma coesa, melhorando clareza e mantendo formato HTML.

            Resumo Atual (HTML):
            \`\`\`html
            ${summary.content}
            \`\`\`

            Novas informações para adicionar/integrar:
            "${newInformation}"

            Forneça o resumo atualizado completo em HTML.`;

            const response = await ai.models.generateContent({
                model: model,
                contents: updatePrompt,
                config: { responseMimeType: "application/json", responseSchema: enhancedContentSchema },
            });

            const parsedJson = JSON.parse(response.text.trim());
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

                        {/* Campo de Upload de Áudio (mantido) */}
                        <div className="form-group">
                            <label>Opção 1: Áudio da Aula</label>
                            <input
                                className="input"
                                type="file"
                                accept="audio/*"
                                onChange={(e) => setAudioFile(e.target.files?.[0] || null)}
                            />
                        </div>

                        {/* NOVO: Campo de Texto */}
                        <div className="form-group">
                             <label>Opção 2: Novas Informações (Texto)</label>
                             <textarea
                                placeholder="Cole aqui o texto ou anotações a serem adicionadas ao resumo..."
                                value={textContent}
                                onChange={(e) => setTextContent(e.target.value)}
                                rows={8} // Altura inicial do campo de texto
                            />
                        </div>

                        {error && <p style={{ color: 'var(--danger-accent)', marginTop: '1rem' }}>{error}</p>}
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
                            {/* Lógica do botão atualizada */}
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
            const prompt = `Você é um especialista em redação acadêmica para a área de medicina. Sua tarefa é aprimorar o corpo do texto a seguir, melhorando a clareza, a fluidez e reescrevendo-o para evitar plágio, sem perder a informação original. Mantenha a estrutura com subtítulos (h2, h3), parágrafos, listas, etc. Se houver dados tabulares, formate-os como uma tabela HTML. O resultado DEVE ser um objeto JSON contendo apenas o HTML do conteúdo aprimorado.

            IMPORTANTE: NÃO inclua um título principal (tag <h1>) no seu resultado. O título já existe e será exibido separadamente. Foque apenas no corpo do texto fornecido.

            Texto para aprimorar: "${textContent}"`;

            const response = await ai.models.generateContent({
                model: model,
                contents: prompt,
                config: { responseMimeType: "application/json", responseSchema: enhancedContentSchema },
            });
            const parsedJson = JSON.parse(response.text.trim());
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
                        <p>Cole abaixo o resumo que você deseja melhorar. A IA irá reescrever o texto para otimizar a clareza e evitar plágio, mantendo o conteúdo original.</p>
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

const Dashboard = ({ user, termName, onLogout, subjects, onSelectSubject, onAddSubject, onEditSubject, onDeleteSubject, theme, toggleTheme, searchQuery, onSearchChange, searchResults, onSelectSummary, lastViewed, userProgress }) => {
  // Estado para controlar se a barra lateral está aberta ou fechada
  const [isSidebarOpen, setSidebarOpen] = useState(false);
  const isSearching = searchQuery.trim() !== '';

  const handleSelectAndClose = (subject) => {
    onSelectSubject(subject);
    setSidebarOpen(false); // Fecha a sidebar após a seleção
  };

  return (
    <>
      {/* A Sidebar agora vive aqui, mas só é visível quando 'isOpen' é true */}
      <Sidebar isOpen={isSidebarOpen} onClose={() => setSidebarOpen(false)} title={termName}>
        {/* O conteúdo da sidebar é a própria grade de disciplinas */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
            {user.role === 'admin' && <button className="btn btn-primary" onClick={onAddSubject}>Adicionar Disciplina</button>}
        </div>
        <div className="subject-grid">
          {subjects.map(subject => {
            const subjectSummaries = searchResults.allSummaries.filter(s => s.subject_id === subject.id);
            const completedCount = subjectSummaries.filter(s => userProgress.completedSummaries.includes(s.id)).length;
            const progress = subjectSummaries.length > 0 ? (completedCount / subjectSummaries.length) * 100 : 0;
            return (
              <div key={subject.id} className="subject-card" style={{ backgroundColor: subject.color }} onClick={() => handleSelectAndClose(subject)}>
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
      </Sidebar>

      <div className="container dashboard">
        <div className="dashboard-header">
          {/* O botão hamburger aparece aqui, mas só é visível no celular (via CSS) */}
          <button className="hamburger-btn" onClick={() => setSidebarOpen(true)}>
            <HamburgerIcon />
          </button>
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
                  <div key={subject.id} className="subject-card" style={{ backgroundColor: subject.color }} onClick={() => handleSelectAndClose(subject)}>
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

            {/* O contêiner para o botão foi renomeado para ser alvo do CSS de ocultar */}
            <div className="add-subject-button-container" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1.5rem' }}>
                {user.role === 'admin' && <button className="btn btn-primary" onClick={onAddSubject}>Adicionar Disciplina</button>}
            </div>

            {/* A grade de disciplinas original. Será OCULTA no celular pelo CSS. */}
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
    </>
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

        // --- ESTA É A VALIDAÇÃO QUE ESTAVA FALTANDO ---
        // Se o usuário for admin e não tiver selecionado um período, mostre um alerta e pare.
        if (user?.role === 'admin' && !selectedTermId) {
            alert('Por favor, selecione um período para esta disciplina.');
            return; // Impede o envio do formulário
        }
        // -------------------------------------------------

        const finalColor = (subject && subject.color) ? subject.color : getNewSubjectColor(existingSubjects);

        // Usa o term_id do estado do modal (para admins) ou o do perfil do usuário (para estudantes)
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
                                required // O 'required' aqui ajuda, mas a validação no JS é mais segura
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
    const [audio, setAudio] = useState('');
    const [video, setVideo] = useState('');
    const [isAIEnhanceModalOpen, setAIEnhanceModalOpen] = useState(false);
    const textareaRef = useRef(null);

    useEffect(() => {
        if (isOpen) {
            setTitle(summary?.title || '');
            setContent(String(summary?.content || ''));
            setAudio(summary?.audio || '');
            setVideo(summary?.video || '');
        }
    }, [isOpen, summary]);

    if (!isOpen) return null;

    const handleSubmit = (e) => {
        e.preventDefault();
        onSave({ ...summary, title, content, audio, video, subject_id: subjectId });
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
                            <label htmlFor="summary-audio-link">Link do Áudio do Spotify</label>
                            <input
                                id="summary-audio-link"
                                className="input"
                                type="url"
                                placeholder="https://open.spotify.com/..."
                                value={audio}
                                onChange={e => setAudio(e.target.value)}
                            />
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

const SummaryListView = ({ subject, summaries, onSelectSummary, onAddSummary, onEditSummary, onDeleteSummary, user, userProgress, onAIEnhance }) => {
    return (
        <div className="container summary-list-view">
            <div className="dashboard-header">
                <h1>{subject.name}</h1>
                 {user.role === 'admin' && (
                    <div className="dashboard-main-actions">
                         <button className="btn btn-secondary" onClick={onAIEnhance}>
                           Aprimorar com IA
                        </button>
                        <button className="btn btn-primary" onClick={onAddSummary}>
                           Adicionar Resumo
                        </button>
                    </div>
                )}
            </div>

            {summaries.length > 0 ? (
                <ul className="summary-list">
                    {summaries.map(summary => {
                        const isCompleted = userProgress.completedSummaries.includes(summary.id);
                        return (
                            <li key={summary.id} className="summary-list-item">
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
                        );
                    })}
                </ul>
            ) : (
                <div className="empty-state">
                    <h2>Nenhum resumo aqui ainda</h2>
                    <p>Que tal começar adicionando o primeiro resumo para esta disciplina?</p>
                    {user.role === 'admin' && (
                        <div className="empty-state-actions">
                             <button className="btn btn-secondary" onClick={onAIEnhance}>Gerar com IA</button>
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

const TableOfContents = ({ content }) => {
    const [headings, setHeadings] = useState([]);

    useEffect(() => {
        const summaryContentElement = document.querySelector('.summary-content');
        if (!summaryContentElement) return;

        const newHeadings = [];
        summaryContentElement.querySelectorAll('h2, h3').forEach(h => {
            const text = h.textContent;
            const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
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
                allow="autoplay"
                frameBorder="0"
                title="Vídeo do Google Drive">
            </iframe>
        </div>
    );
};

const SpotifyPlayer = ({ url }) => {
    const embedUrl = getSpotifyEmbedUrl(url);
    if (!embedUrl) return <p>Link do Spotify inválido ou não suportado.</p>;
    return (
        <div className="spotify-player-container">
            <iframe src={`${embedUrl}?utm_source=generator`} frameBorder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy" title="Player do Spotify"></iframe>
        </div>
    );
};


// MODIFICADO: Este é o componente com a nova funcionalidade
const SummaryDetailView = ({ summary, onEdit, onDelete, onGenerateQuiz, onToggleComplete, isCompleted, onGetExplanation, user, onAIUpdate }) => {
    const [activeTab, setActiveTab] = useState('summary');
    const [isGenerating, setIsGenerating] = useState(false);
    // 1. Adicionado estado para controlar a visibilidade do sumário (Table of Contents)
    const [isTocVisible, setIsTocVisible] = useState(true);

    useEffect(() => {
        setActiveTab('summary');
        // Reseta a visibilidade do sumário sempre que um novo resumo for carregado
        setIsTocVisible(true);
    }, [summary]);

    const handleGenerateQuiz = async () => {
        setIsGenerating(true);
        await onGenerateQuiz();
        setIsGenerating(false);
    }

    const availableTabs = [
        { id: 'summary', label: 'Resumo', condition: true },
        { id: 'video', label: 'Vídeo', condition: !!summary.video },
        { id: 'podcast', label: 'Podcast', condition: !!summary.audio },
        { id: 'questions', label: 'Questões', condition: (summary.questions && summary.questions.length > 0) || user.role === 'admin' }
    ].filter(tab => tab.condition);

    return (
        <div className="summary-detail-layout">
            {/* 4. A renderização do sumário agora depende do estado 'isTocVisible' */}
            {activeTab === 'summary' && isTocVisible && <TableOfContents content={summary.content} />}
            <div className="summary-detail-view">
                <div className="summary-header">
                    {/* 2. Adicionado o botão para controlar a visibilidade. Ele só aparece na aba 'Resumo' */}
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
                        <button key={tab.id} className={`tab-button ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)} aria-controls={`tab-panel-${tab.id}`} role="tab">
                            {tab.label}
                        </button>
                    ))}
                </nav>

                <div className="tab-content">
                    {activeTab === 'summary' && (
                        <div id="tab-panel-summary" role="tabpanel" className="summary-content" dangerouslySetInnerHTML={{ __html: summary.content }}></div>
                    )}
                    {activeTab === 'video' && <div id="tab-panel-video" role="tabpanel">{summary.video && <GoogleDrivePlayer url={summary.video} />}</div>}
                    {activeTab === 'podcast' && <div id="tab-panel-podcast" role="tabpanel">{summary.audio && <SpotifyPlayer url={summary.audio} />}</div>}
                    {activeTab === 'questions' && (
                        <div id="tab-panel-questions" role="tabpanel">
                             {summary.questions && summary.questions.length > 0 ? (
                                <QuizView questions={summary.questions} onGetExplanation={onGetExplanation} />
                            ) : (
                                user.role === 'admin' && (
                                    <div className="quiz-container empty-quiz">
                                        <p>Ainda não há questões para este resumo.</p>
                                        <button className="btn btn-primary" onClick={handleGenerateQuiz} disabled={isGenerating}>
                                            {isGenerating && <span className="spinner-sm"></span>}
                                            {isGenerating ? 'Gerando Quiz...' : 'Gerar Quiz com IA'}
                                        </button>
                                    </div>
                                )
                            )}
                        </div>
                    )}
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

// Componente para o usuário escolher seu termo inicial
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


// --- COMPONENTE PRINCIPAL APP ATUALIZADO E COMPLETO ---
const App = () => {
  // State de Autenticação e UI
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [terms, setTerms] = useState([]);
  const [theme, setTheme] = useState('dark');
  const [view, setView] = useState('dashboard');
  const [currentSubjectId, setCurrentSubjectId] = useState(null);
  const [currentSummaryId, setCurrentSummaryId] = useState(null);

  // State de Dados
  const [subjects, setSubjects] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [userProgress, setUserProgress] = useState({ completedSummaries: [], lastCompletionDate: null, streak: 0 });
  const [lastViewed, setLastViewed] = useState([]);

  // State de Modais
  const [isSubjectModalOpen, setSubjectModalOpen] = useState(false);
  const [isSummaryModalOpen, setSummaryModalOpen] = useState(false);
  const [isAIEnhanceModalOpen, setAIEnhanceModalOpen] = useState(false);
  const [isAIUpdateModalOpen, setAIUpdateModalOpen] = useState(false);
  const [editingSubject, setEditingSubject] = useState(null);
  const [editingSummary, setEditingSummary] = useState(null);

  // State de Busca
  const [searchQuery, setSearchQuery] = useState('');

  // Gerencia a sessão de autenticação e busca os termos
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    const fetchTerms = async () => {
        const { data } = await supabase.from('terms').select('*').order('id');
        setTerms(data || []);
    };
    fetchTerms();

    return () => subscription.unsubscribe();
  }, []);

  // Busca o perfil do usuário e os dados do seu termo quando a sessão muda
  useEffect(() => {
    if (session?.user) {
      const fetchUserProfileAndData = async () => {
        const { data: profileData, error: profileError } = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
        if (profileError) {
          console.error("Erro ao buscar perfil:", profileError);
          return;
        }

        const fullUser = { ...session.user, ...profileData };
        setUser(fullUser);

        if (fullUser.term_id) {
            const { data: subjectsData } = await supabase.from('subjects').select('*').eq('term_id', fullUser.term_id);
            setSubjects(subjectsData || []);

            const { data: summariesData } = await supabase.from('summaries').select('*');
            setSummaries(summariesData || []);
        } else {
            setSubjects([]);
            setSummaries([]);
        }
      };

      fetchUserProfileAndData();

      const savedProgress = localStorage.getItem(`userProgress_${session.user.id}`);
      if (savedProgress) setUserProgress(JSON.parse(savedProgress));

      const savedLastViewed = localStorage.getItem(`lastViewed_${session.user.id}`);
      if(savedLastViewed) setLastViewed(JSON.parse(savedLastViewed));
    } else {
      setUser(null);
    }
  }, [session]);

  // Salva dados no localStorage
  useEffect(() => {
    localStorage.setItem('theme', theme);
    if (session) {
      localStorage.setItem(`userProgress_${session.user.id}`, JSON.stringify(userProgress));
      localStorage.setItem(`lastViewed_${session.user.id}`, JSON.stringify(lastViewed));
    }
  }, [theme, userProgress, lastViewed, session]);

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

  const handleBackToDashboard = () => setView('dashboard');
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
    const summaryPayload = { title: summaryData.title, content: summaryData.content, audio: summaryData.audio, video: summaryData.video, subject_id: summaryData.subject_id, user_id: session.user.id };
    if (summaryData.id) {
        const { data, error } = await supabase.from('summaries').update(summaryPayload).eq('id', summaryData.id).select();
        if (error) alert(error.message);
        else if (data) setSummaries(summaries.map(s => s.id === data[0].id ? data[0] : s));
    } else {
        const { data, error } = await supabase.from('summaries').insert(summaryPayload).select();
        if (error) alert(error.message);
        else if (data) setSummaries([...summaries, data[0]]);
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

  const handleUpdateSummaryContent = async (summaryId, newContent) => {
      const { data, error } = await supabase.from('summaries').update({ content: newContent }).eq('id', summaryId).select();
      if (error) alert(error.message);
      else if (data) setSummaries(summaries.map(s => s.id === data[0].id ? data[0] : s));
      setAIUpdateModalOpen(false);
  };

  const handleGenerateQuiz = async () => {
    const summary = summaries.find(s => s.id === currentSummaryId);
    if (!summary) return;
    try {
        const prompt = `Baseado no seguinte resumo sobre "${summary.title}", gere um quiz. Resumo: "${summary.content.replace(/<[^>]*>?/gm, ' ')}".`;
        const response = await ai.models.generateContent({ model, contents: prompt, config: { responseMimeType: "application/json", responseSchema: quizSchema } });
        const parsedJson = JSON.parse(response.text.trim());
        const { error } = await supabase.from('summaries').update({ questions: parsedJson.questions }).eq('id', currentSummaryId);
        if (error) throw error;
        setSummaries(summaries.map(s => s.id === currentSummaryId ? { ...s, questions: parsedJson.questions } : s));
    } catch (e) {
        console.error("Erro ao gerar/salvar quiz:", e);
        alert("Falha ao gerar o quiz. Tente novamente.");
    }
  };

   const handleGetExplanation = async (questionText, correctAnswer) => {
        const summary = summaries.find(s => s.id === currentSummaryId);
        if (!summary) return "Contexto não encontrado.";
        const prompt = `Contexto do resumo: "${summary.content.replace(/<[^>]*>?/gm, ' ')}". Pergunta: "${questionText}". Resposta correta: "${correctAnswer}". Explique brevemente por que esta é a resposta correta.`;
        const response = await ai.models.generateContent({ model, contents: prompt, config: { responseMimeType: "application/json", responseSchema: quizExplanationSchema } });
        const parsedJson = JSON.parse(response.text.trim());
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
  const summariesForCurrentSubject = summaries.filter(s => s.subject_id === currentSubjectId);

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

  const renderContent = () => {
    if (!session || !user) {
        return <LoginScreen theme={theme} toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />;
    }

    if (!user.term_id) {
        return <TermSelector user={user} terms={terms} onTermUpdate={handleTermUpdate} />;
    }

    switch (view) {
      case 'dashboard':
        const termName = terms.find(t => t.id === user.term_id)?.name || "Meu Período";
        return <Dashboard user={user} termName={termName} onLogout={handleLogout} subjects={subjects} onSelectSubject={handleSelectSubject} onAddSubject={() => { setEditingSubject(null); setSubjectModalOpen(true); }} onEditSubject={(subject) => { setEditingSubject(subject); setSubjectModalOpen(true); }} onDeleteSubject={handleDeleteSubject} theme={theme} toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} searchQuery={searchQuery} onSearchChange={(e) => setSearchQuery(e.target.value)} searchResults={searchResults} onSelectSummary={handleSelectSummary} lastViewed={lastViewedWithDetails} userProgress={userProgress} />;
      case 'subject':
        return <SummaryListView subject={currentSubject} summaries={summariesForCurrentSubject} onSelectSummary={handleSelectSummary} onAddSummary={() => { setEditingSummary(null); setSummaryModalOpen(true); }} onEditSummary={(summary) => { setEditingSummary(summary); setSummaryModalOpen(true); }} onDeleteSummary={handleDeleteSummary} user={user} userProgress={userProgress} onAIEnhance={() => setAIEnhanceModalOpen(true)} />;
      case 'summary':
        return <SummaryDetailView summary={currentSummary} onEdit={() => { setEditingSummary(currentSummary); setSummaryModalOpen(true); }} onDelete={() => handleDeleteSummary(currentSummary.id)} onGenerateQuiz={handleGenerateQuiz} onToggleComplete={handleToggleComplete} isCompleted={userProgress.completedSummaries.includes(currentSummary.id)} onGetExplanation={handleGetExplanation} user={user} onAIUpdate={() => setAIUpdateModalOpen(true)} />;
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
      {user && user.term_id && view !== 'dashboard' && (
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
      {isAIEnhanceModalOpen && <AIEnhancementModal onClose={() => setAIEnhanceModalOpen(false)} onContentEnhanced={(enhancedContent) => {
          handleSaveSummary({
              title: "Novo Resumo (Gerado por IA)",
              content: enhancedContent,
              subject_id: currentSubjectId
          });
          setAIEnhanceModalOpen(false);
      }} />}
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
