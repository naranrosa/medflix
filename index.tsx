import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import { supabase } from './supabaseClient'; // Importe seu cliente Supabase
import { Session } from '@supabase/supabase-js';


// --- DADOS ESTÁTICOS ---
// Mantido localmente, pois raramente muda. Poderia vir de uma tabela 'terms' no futuro.
const initialTerms = Array.from({ length: 12 }, (_, i) => ({
    id: `t${i + 1}`,
    name: `${i + 1}º Termo`,
}));


// --- CONFIGURAÇÃO DA IA ---
// Lembre-se de configurar esta variável de ambiente no seu projeto React (ex: .env.local)
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  throw new Error("A variável de ambiente GEMINI_API_KEY não está definida");
}
const ai = new GoogleGenAI({ apiKey: API_KEY });
const model = "gemini-1.5-flash";

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
      description: 'Uma lista de exatamente 5 questões de múltipla escolha.',
      items: {
        type: Type.OBJECT,
        properties: {
          questionText: { type: Type.STRING, description: 'O texto da pergunta.' },
          alternatives: {
            type: Type.ARRAY,
            description: 'Uma lista de exatamente 4 alternativas em string.',
            items: { type: Type.STRING }
          },
          correctAlternativeIndex: { type: Type.INTEGER, description: 'O índice de base 0 da alternativa correta na lista de alternativas.' }
        },
        required: ['questionText', 'alternatives', 'correctAlternativeIndex']
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


// --- FUNÇÕES AUXILIARES ---
const subjectColors = ['#007BFF', '#28A745', '#DC3545', '#FFC107', '#17A2B8', '#6610f2', '#fd7e14', '#20c997', '#e83e8c'];
const getNewSubjectColor = (existingSubjects) => {
    const usedColors = new Set(existingSubjects.map(s => s.color));
    const availableColor = subjectColors.find(c => !usedColors.has(c));
    return availableColor || subjectColors[Math.floor(Math.random() * subjectColors.length)];
};

const getYoutubeVideoId = (url) => {
    if (!url) return null;
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
};

const getSpotifyEmbedUrl = (url) => {
    if (!url) return null;
    const match = url.match(/open\.spotify\.com\/(track|episode)\/([a-zA-Z0-9]+)/);
    if (match && match[1] && match[2]) {
        return `https://open.spotify.com/embed/${match[1]}/${match[2]}`;
    }
    return null;
};

// --- COMPONENTES BÁSICOS DE UI ---

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


// --- TELA DE AUTENTICAÇÃO (ATUALIZADA com Placeholders) ---
const AuthScreen = ({ theme, toggleTheme }) => {
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleAuth = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err) {
      setError(err.error_description || err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      <div className="login-card">
        <h1>Med<span>flix</span></h1>
        <p>Acesse sua conta para continuar</p>
        <form onSubmit={handleAuth}>
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="Digite seu email"
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Senha</label>
            <input
              id="password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="Digite sua senha"
            />
          </div>

          {error && <p style={{color: 'var(--danger-accent)', marginTop: '1rem'}}>{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Carregando...' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
};

// --- MODAIS DE IA ---

const AIUpdateModal = ({ onClose, onUpdate, summary }) => {
    const [isLoading, setIsLoading] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState('');
    const [error, setError] = useState('');
    const [audioFile, setAudioFile] = useState(null);

    const handleUpdate = async () => {
        if (!audioFile) {
            setError('Por favor, selecione um arquivo de áudio.');
            return;
        }
        setIsLoading(true);
        setError('');
        try {
            setLoadingMessage('Extraindo texto do áudio...');
            // NOTA: Simulação. Implementação real necessitaria de uma API de Speech-to-Text.
            const textFromAudio = `(Texto simulado extraído do áudio: Novas descobertas sobre o sistema nervoso periférico indicam uma maior plasticidade nos nervos cranianos, especialmente no nervo vago. Além disso, a barreira hematoencefálica pode ser temporariamente permeabilizada por ultrassom focado, permitindo a entrega de medicamentos.)`;

            setLoadingMessage('Comparando com o resumo atual...');
            await new Promise(res => setTimeout(res, 1500));

            const updatePrompt = `Você é um especialista em redação médica. Sua tarefa é atualizar um resumo existente com novas informações de uma aula recente. Integre as novas informações de forma coesa, melhore a estrutura e clareza, e evite redundâncias. Mantenha o formato HTML.

            Resumo Atual (HTML):
            \`\`\`html
            ${summary.content}
            \`\`\`

            Novas Informações (extraídas do áudio da aula):
            "${textFromAudio}"

            Combine as duas fontes e forneça o resumo atualizado completo em HTML.`;

            const response = await ai.models.generateContent({
                model: model,
                contents: [{ role: 'user', parts: [{ text: updatePrompt }] }],
                generationConfig: { responseMimeType: "application/json" },
                // @ts-ignore
                tools: [{ functionDeclarations: [ { name: 'enhancedContentSchema', description: '', parameters: enhancedContentSchema }] }]
            });
            // @ts-ignore
            const parsedJson = JSON.parse(response.text());            
            setLoadingMessage('Resumo atualizado com sucesso!');
            await new Promise(res => setTimeout(res, 1000));
            onUpdate(parsedJson.enhancedContent);

        } catch (e) {
            console.error(e);
            setError('Falha ao atualizar o resumo. Verifique o áudio ou tente novamente.');
            setIsLoading(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content large" onClick={(e) => e.stopPropagation()}>
                {!isLoading ? (
                    <>
                        <h2>Atualizar Resumo com IA</h2>
                        <p>Faça o upload do áudio da aula mais recente. A IA irá analisar o conteúdo, compará-lo com o resumo atual e adicionar as informações que estão faltando.</p>
                        <div className="form-group">
                             <label>Áudio da Aula</label>
                             <input className="input" type="file" accept="audio/*" onChange={(e) => setAudioFile(e.target.files[0])} />
                        </div>
                        {error && <p style={{color: 'var(--danger-accent)', marginTop: '1rem'}}>{error}</p>}
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleUpdate} disabled={!audioFile}>Processar e Atualizar</button>
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
                generationConfig: { responseMimeType: "application/json", responseSchema: enhancedContentSchema },
            });

            // --- A CORREÇÃO ESTÁ AQUI ---
            // Substituímos a linha complexa e frágil por esta, que é mais robusta.
            const parsedJson = JSON.parse(response.text());

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

// --- COMPONENTE DASHBOARD ---

const Dashboard = ({ userProfile, onLogout, onSelectSubject, subjects, onAddSubject, onEditSubject, onDeleteSubject, theme, toggleTheme, searchQuery, onSearchChange, searchResults, onSelectSummary, lastViewed }) => {
  const termName = initialTerms.find(t => t.id === userProfile.term_id)?.name;
  const isSearching = searchQuery.trim() !== '';

  return (
    <div className="container dashboard">
      <div className="dashboard-header">
        <h1>{termName}</h1>
        <div className="header-actions">
            <ThemeToggle theme={theme} toggleTheme={toggleTheme}/>
            {userProfile.streak > 0 && <div className="streak-display">🔥 {userProfile.streak}</div>}
            <button className="btn btn-secondary" onClick={onLogout}>Sair</button>
        </div>
      </div>

      <div className="search-bar-container">
          <SearchIcon />
          <input
            type="text"
            placeholder="Buscar disciplinas ou resumos..."
            className="search-input"
            value={searchQuery}
            onChange={onSearchChange}
          />
      </div>

      {isSearching ? (
        <div className="search-results">
            <h2>Resultados da Busca</h2>
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
          {lastViewed && lastViewed.length > 0 && (
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

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1.5rem' }}>
              {userProfile.role === 'admin' && <button className="btn btn-primary" onClick={onAddSubject}>Adicionar Disciplina</button>}
          </div>

          <div className="subject-grid">
            {subjects.map(subject => {
              const subjectSummaries = searchResults.allSummaries.filter(s => s.subject_id === subject.id);
              const completedCount = subjectSummaries.filter(s => userProfile.completed_summaries.includes(s.id)).length;
              const progress = subjectSummaries.length > 0 ? (completedCount / subjectSummaries.length) * 100 : 0;
              return (
                <div key={subject.id} className="subject-card" style={{ backgroundColor: subject.color }} onClick={() => onSelectSubject(subject)}>
                  <div>
                    <h3>{subject.name}</h3>
                  </div>
                   <div className="subject-card-progress">
                    <p>{completedCount} de {subjectSummaries.length} concluídos</p>
                    <div className="progress-bar">
                        <div className="progress-bar-inner" style={{ width: `${progress}%` }}></div>
                    </div>
                  </div>
                  {userProfile.role === 'admin' && (
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

// --- MODAIS DE CRUD E EDITOR ---

const SubjectModal = ({ isOpen, onClose, onSave, subject, existingSubjects }) => {
    const [name, setName] = useState('');
    useEffect(() => {
        if (isOpen) {
            setName(subject ? subject.name : '');
        }
    }, [isOpen, subject]);

    if (!isOpen) return null;

    const handleSubmit = (e) => {
        e.preventDefault();
        const finalColor = (subject && subject.color) ? subject.color : getNewSubjectColor(existingSubjects);
        onSave({ ...subject, name, color: finalColor });
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
        onSave({ ...summary, title, content, audio, video, subjectId });
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
                                placeholder="https://open.spotify.com/episode/..."
                                value={audio}
                                onChange={e => setAudio(e.target.value)}
                            />
                        </div>

                         <div className="form-group">
                            <label htmlFor="summary-video-link">Link do Vídeo do YouTube</label>
                            <input
                                id="summary-video-link"
                                className="input"
                                type="url"
                                placeholder="https://www.youtube.com/watch?v=..."
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

// --- COMPONENTE DE VISUALIZAÇÃO DA LISTA DE RESUMOS ---

const SummaryListView = ({ subject, summaries, onSelectSummary, onAddSummary, onEditSummary, onDeleteSummary, userProfile, onAIEnhance }) => {
    return (
        <div className="container summary-list-view">
            <div className="dashboard-header">
                <h1>{subject.name}</h1>
                 {userProfile.role === 'admin' && (
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
                        const isCompleted = userProfile.completed_summaries.includes(summary.id);
                        return (
                            <li key={summary.id} className="summary-list-item">
                                <div className="summary-list-item-title" onClick={() => onSelectSummary(summary)}>
                                    {isCompleted && <span className="completion-check"><CheckCircleIcon /></span>}
                                    {summary.title}
                                </div>
                                {userProfile.role === 'admin' && (
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
                    {userProfile.role === 'admin' && (
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

// --- COMPONENTES DE VISUALIZAÇÃO DE CONTEÚDO ---

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

    // Reseta as respostas quando as questões mudam
    useEffect(() => {
        setAnswers({});
        setExplanations({});
    }, [questions]);

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
            if (text) {
                const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
                h.id = id;
                newHeadings.push({
                    id,
                    text,
                    level: h.tagName.toLowerCase() === 'h2' ? 1 : 2
                });
            }
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

const YoutubePlayer = ({ url }) => {
    const videoId = getYoutubeVideoId(url);
    if (!videoId) {
        return <p>Link do YouTube inválido.</p>;
    }

    return (
        <div className="youtube-player-container">
            <iframe
                src={`https://www.youtube.com/embed/${videoId}`}
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                title="Vídeo do YouTube"
            ></iframe>
        </div>
    );
};

const SpotifyPlayer = ({ url }) => {
    const embedUrl = getSpotifyEmbedUrl(url);
    if (!embedUrl) {
        return <p>Link do Spotify inválido ou não suportado.</p>;
    }

    return (
        <div className="spotify-player-container">
            <iframe
                src={`${embedUrl}?utm_source=generator`}
                frameBorder="0"
                allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                loading="lazy"
                title="Player do Spotify"
            ></iframe>
        </div>
    );
};

// --- COMPONENTE DE VISUALIZAÇÃO DOS DETALHES DO RESUMO ---

const SummaryDetailView = ({ summary, onEdit, onDelete, onGenerateQuiz, onToggleComplete, isCompleted, onGetExplanation, userProfile, onAIUpdate }) => {
    const [activeTab, setActiveTab] = useState('summary');
    const [isGenerating, setIsGenerating] = useState(false);

    useEffect(() => {
        // Quando o resumo muda, reseta para a aba principal
        setActiveTab('summary');
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
        { id: 'questions', label: 'Questões', condition: (summary.questions && summary.questions.length > 0) || userProfile.role === 'admin' }
    ].filter(tab => tab.condition);

    return (
        <div className="summary-detail-layout">
            {activeTab === 'summary' && <TableOfContents content={summary.content} />}
            <div className="summary-detail-view">
                <div className="summary-header">
                    <h1 className="summary-detail-title">{summary.title}</h1>
                    <div className="summary-detail-actions">
                        <button className="btn btn-secondary" onClick={onToggleComplete}>
                            {isCompleted ? <CheckCircleIcon /> : null}
                            {isCompleted ? 'Concluído' : 'Marcar como Concluído'}
                        </button>
                        {userProfile.role === 'admin' && (
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
                    {activeTab === 'summary' && (
                        <div id="tab-panel-summary" role="tabpanel" className="summary-content" dangerouslySetInnerHTML={{ __html: summary.content }}></div>
                    )}

                    {activeTab === 'video' && (
                        <div id="tab-panel-video" role="tabpanel">
                            {summary.video && <YoutubePlayer url={summary.video} />}
                        </div>
                    )}

                    {activeTab === 'podcast' && (
                        <div id="tab-panel-podcast" role="tabpanel">
                            {summary.audio && <SpotifyPlayer url={summary.audio} />}
                        </div>
                    )}

                    {activeTab === 'questions' && (
                        <div id="tab-panel-questions" role="tabpanel">
                             {summary.questions && summary.questions.length > 0 ? (
                                <QuizView questions={summary.questions} onGetExplanation={onGetExplanation} />
                            ) : (
                                userProfile.role === 'admin' && (
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

// --- COMPONENTE PRINCIPAL APP ---

const App = () => {
  // Estado de Autenticação e Perfil
  const [session, setSession] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [loadingApp, setLoadingApp] = useState(true);

  // Estado da Aplicação
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');
  const [view, setView] = useState('dashboard'); // login, dashboard, subject, summary
  const [currentSubjectId, setCurrentSubjectId] = useState(null);
  const [currentSummaryId, setCurrentSummaryId] = useState(null);

  // Dados do Supabase
  const [subjects, setSubjects] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [lastViewed, setLastViewed] = useState([]); // Ainda gerenciado localmente via localStorage

  // Modais e Busca
  const [isSubjectModalOpen, setSubjectModalOpen] = useState(false);
  const [isSummaryModalOpen, setSummaryModalOpen] = useState(false);
  const [isAIEnhanceModalOpen, setAIEnhanceModalOpen] = useState(false);
  const [isAIUpdateModalOpen, setAIUpdateModalOpen] = useState(false);
  const [editingSubject, setEditingSubject] = useState(null);
  const [editingSummary, setEditingSummary] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  // --- EFEITOS DE CICLO DE VIDA ---

  useEffect(() => {
    // Gerencia a sessão
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoadingApp(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    // Busca dados quando a sessão é estabelecida
    const fetchData = async () => {
      if (session?.user) {
        // 1. Buscar Perfil do Usuário
        let { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', session.user.id)
          .single();

        if (profileError && profileError.code === 'PGRST116') { // Código para "zero rows found"
            // Primeiro login: perfil não existe, vamos criar um.
            const { data: newProfile, error: insertError } = await supabase
                .from('profiles')
                .insert({
                    id: session.user.id,
                    role: session.user.user_metadata.role || 'student',
                    term_id: session.user.user_metadata.term_id || 't1',
                    completed_summaries: [],
                    streak: 0,
                }).select().single();
            if (insertError) console.error("Error creating profile:", insertError);
            profile = newProfile;
        } else if (profileError) {
            console.error("Error fetching profile:", profileError);
        }
        setUserProfile(profile);

        // 2. Buscar Disciplinas e Resumos
        if (profile) {
          const { data: subjectsData, error: subjectsError } = await supabase
            .from('subjects')
            .select('*, summaries(*)')
            .eq('term_id', profile.term_id);

          if (subjectsError) {
            console.error("Error fetching subjects/summaries:", subjectsError);
          } else {
            const allSummaries = subjectsData.flatMap(s => s.summaries || []).map(sum => ({...sum, subjectId: sum.subject_id}));
            setSubjects(subjectsData.map(({summaries, ...s}) => s));
            setSummaries(allSummaries);
          }
        }
      } else {
        setUserProfile(null);
        setSubjects([]);
        setSummaries([]);
      }
    };
    fetchData();
  }, [session]);

  useEffect(() => {
    // Gerencia o tema
    localStorage.setItem('theme', theme);
    document.body.className = theme === 'dark' ? '' : 'light-mode';
  }, [theme]);

  useEffect(() => {
    // Gerencia os resumos vistos por último
    const savedLastViewed = localStorage.getItem('lastViewed');
    if (savedLastViewed) setLastViewed(JSON.parse(savedLastViewed));
  }, []);

  useEffect(() => {
    localStorage.setItem('lastViewed', JSON.stringify(lastViewed));
  }, [lastViewed]);


  // --- FUNÇÕES DE NAVEGAÇÃO E UI ---

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

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setView('dashboard');
    setCurrentSubjectId(null);
    setCurrentSummaryId(null);
  };

  // --- FUNÇÕES CRUD (ASSÍNCRONAS COM SUPABASE) ---

  const handleSaveSubject = async (subjectData) => {
    try {
        let updatedSubjects = [...subjects];
        if (subjectData.id) { // Edição
            const { data, error } = await supabase.from('subjects').update({ name: subjectData.name, color: subjectData.color }).eq('id', subjectData.id).select().single();
            if (error) throw error;
            updatedSubjects = subjects.map(s => s.id === data.id ? data : s);
        } else { // Criação
            const { data, error } = await supabase.from('subjects').insert({
                name: subjectData.name,
                color: getNewSubjectColor(subjects),
                term_id: userProfile.term_id
            }).select().single();
            if (error) throw error;
            updatedSubjects.push(data);
        }
        setSubjects(updatedSubjects);
    } catch(error) {
        alert("Erro ao salvar disciplina: " + error.message);
    } finally {
        setSubjectModalOpen(false);
        setEditingSubject(null);
    }
  };

  const handleDeleteSubject = async (subjectId) => {
    if (window.confirm("Tem certeza que deseja excluir esta disciplina e todos os seus resumos?")) {
        try {
            const { error } = await supabase.from('subjects').delete().eq('id', subjectId);
            if (error) throw error;
            setSubjects(prev => prev.filter(s => s.id !== subjectId));
            setSummaries(prev => prev.filter(s => s.subject_id !== subjectId));
        } catch (error) {
            alert("Erro ao deletar disciplina: " + error.message);
        }
    }
  };

  const handleSaveSummary = async (summaryData) => {
      const dataToUpsert = { title: summaryData.title, content: summaryData.content, audio: summaryData.audio, video: summaryData.video, subject_id: summaryData.subjectId };
      try {
          let updatedSummaries = [...summaries];
          if (summaryData.id) { // Edição
              const { data, error } = await supabase.from('summaries').update(dataToUpsert).eq('id', summaryData.id).select().single();
              if (error) throw error;
              updatedSummaries = summaries.map(s => s.id === data.id ? {...data, subjectId: data.subject_id} : s);
          } else { // Criação
              const { data, error } = await supabase.from('summaries').insert(dataToUpsert).select().single();
              if (error) throw error;
              updatedSummaries.push({...data, subjectId: data.subject_id});
          }
          setSummaries(updatedSummaries);
      } catch (error) {
          alert("Erro ao salvar resumo: " + error.message);
      } finally {
          setSummaryModalOpen(false);
          setEditingSummary(null);
      }
  };

  const handleDeleteSummary = async (summaryId) => {
      if (window.confirm("Tem certeza que deseja excluir este resumo?")) {
          try {
              const { error } = await supabase.from('summaries').delete().eq('id', summaryId);
              if (error) throw error;
              setSummaries(prev => prev.filter(s => s.id !== summaryId));
              handleBackToSubject();
          } catch(error) {
              alert("Erro ao deletar resumo: " + error.message);
          }
      }
  };

  const handleUpdateSummaryContent = async (summaryId, newContent) => {
      try {
          const { data, error } = await supabase.from('summaries').update({ content: newContent }).eq('id', summaryId).select().single();
          if (error) throw error;
          setSummaries(prev => prev.map(s => s.id === summaryId ? {...data, subjectId: data.subject_id} : s));
          setAIUpdateModalOpen(false);
      } catch (error) {
          alert("Erro ao atualizar conteúdo: " + error.message);
      }
  };

  // --- FUNÇÕES DE PROGRESSO E IA (ASSÍNCRONAS COM SUPABASE) ---

  const handleToggleComplete = async () => {
    const isCompleted = userProfile.completed_summaries.includes(currentSummaryId);
    const newCompleted = isCompleted ? userProfile.completed_summaries.filter(id => id !== currentSummaryId) : [...new Set([...userProfile.completed_summaries, currentSummaryId])];

    // Lógica da sequência (streak)
    const today = new Date().toISOString().split('T')[0];
    let newStreak = userProfile.streak || 0;
    let newLastCompletionDate = userProfile.last_completion_date;

    if (!isCompleted) { // Apenas atualiza ao completar, não ao desmarcar
        if (newLastCompletionDate !== today) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            if (newLastCompletionDate === yesterday.toISOString().split('T')[0]) {
                newStreak += 1; // Continua streak
            } else {
                newStreak = 1; // Nova streak
            }
            newLastCompletionDate = today;
        }
    }

    const updatedProfileFields = { completed_summaries: newCompleted, streak: newStreak, last_completion_date: newLastCompletionDate };
    setUserProfile(prev => ({ ...prev, ...updatedProfileFields })); // Atualização otimista da UI

    const { error } = await supabase.from('profiles').update(updatedProfileFields).eq('id', userProfile.id);
    if (error) {
        alert("Erro ao salvar progresso.");
        setUserProfile(userProfile); // Reverte em caso de erro
    }
  };

  const handleGenerateQuiz = async () => {
    const summary = summaries.find(s => s.id === currentSummaryId);
    if (!summary) return;
    try {
        const prompt = `Baseado no seguinte resumo sobre "${summary.title}", gere um quiz. Resumo: "${summary.content.replace(/<[^>]*>?/gm, ' ')}".`;
        const response = await ai.models.generateContent({ /* ... */ }); // Adapte para a nova sintaxe se necessário
        const parsedJson = JSON.parse(response.text());

        const { error } = await supabase.from('summaries').update({ questions: parsedJson.questions }).eq('id', currentSummaryId);
        if (error) throw error;
        setSummaries(prev => prev.map(s => s.id === currentSummaryId ? { ...s, questions: parsedJson.questions } : s));
    } catch (e) {
        console.error("Erro ao gerar quiz:", e);
        alert("Falha ao gerar o quiz.");
    }
  };

   const handleGetExplanation = async (questionText, correctAnswer) => {
        const summary = summaries.find(s => s.id === currentSummaryId);
        if (!summary) return "Contexto não encontrado.";
        const prompt = `Contexto do resumo: "${summary.content.replace(/<[^>]*>?/gm, ' ')}". Pergunta: "${questionText}". Resposta correta: "${correctAnswer}". Explique brevemente por que esta é a resposta correta.`;
        const response = await ai.models.generateContent({ /* ... */ }); // Adapte para a nova sintaxe se necessário
        const parsedJson = JSON.parse(response.text());
        return parsedJson.explanation;
    };

  // --- ESTADO DERIVADO E MEMORIZADO ---

  const currentSubject = subjects.find(s => s.id === currentSubjectId);
  const currentSummary = summaries.find(s => s.id === currentSummaryId);
  const summariesForCurrentSubject = summaries.filter(s => s.subject_id === currentSubjectId);

  const searchResults = useMemo(() => {
    const allSummariesWithSubject = summaries.map(sum => ({
        ...sum,
        subjectName: subjects.find(sub => sub.id === sum.subject_id)?.name || ''
    }));

    if (!searchQuery.trim()) return { subjects: [], summaries: [], allSummaries: summaries };

    const lowerCaseQuery = searchQuery.toLowerCase();

    const filteredSubjects = subjects.filter(sub => sub.name.toLowerCase().includes(lowerCaseQuery))
        .map(sub => ({ ...sub, summaryCount: summaries.filter(s => s.subject_id === sub.id).length }));

    const filteredSummaries = allSummariesWithSubject.filter(sum => sum.title.toLowerCase().includes(lowerCaseQuery));

    return { subjects: filteredSubjects, summaries: filteredSummaries, allSummaries: summaries };
  }, [searchQuery, subjects, summaries]);

  const lastViewedWithDetails = useMemo(() => {
    return lastViewed.map(lv => {
        const subject = subjects.find(s => s.id === lv.subject_id);
        return { ...lv, subjectName: subject?.name || 'Disciplina Removida' };
    }).filter(lv => subjects.find(s => s.id === lv.subject_id)); // Apenas mostra se a disciplina ainda existe
  }, [lastViewed, subjects]);


  // --- LÓGICA DE RENDERIZAÇÃO ---

  const renderContent = () => {
    if (!userProfile) return <div className="loader-container"><div className="loader"></div></div>;

    switch (view) {
      case 'dashboard':
        return <Dashboard
                    userProfile={userProfile}
                    onLogout={handleLogout}
                    subjects={subjects}
                    onSelectSubject={handleSelectSubject}
                    onAddSubject={() => { setEditingSubject(null); setSubjectModalOpen(true); }}
                    onEditSubject={(subject) => { setEditingSubject(subject); setSubjectModalOpen(true); }}
                    onDeleteSubject={handleDeleteSubject}
                    theme={theme}
                    toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                    searchQuery={searchQuery}
                    onSearchChange={(e) => setSearchQuery(e.target.value)}
                    searchResults={searchResults}
                    onSelectSummary={handleSelectSummary}
                    lastViewed={lastViewedWithDetails}
                />;
      case 'subject':
        if (!currentSubject) { handleBackToDashboard(); return null; }
        return <SummaryListView
                    subject={currentSubject}
                    summaries={summariesForCurrentSubject}
                    onSelectSummary={handleSelectSummary}
                    onAddSummary={() => { setEditingSummary(null); setSummaryModalOpen(true); }}
                    onEditSummary={(summary) => { setEditingSummary(summary); setSummaryModalOpen(true); }}
                    onDeleteSummary={handleDeleteSummary}
                    userProfile={userProfile}
                    onAIEnhance={() => setAIEnhanceModalOpen(true)}
                />;
      case 'summary':
        if (!currentSummary) { handleBackToSubject(); return null; }
        return <SummaryDetailView
                    summary={currentSummary}
                    onEdit={() => { setEditingSummary(currentSummary); setSummaryModalOpen(true); }}
                    onDelete={() => handleDeleteSummary(currentSummary.id)}
                    onGenerateQuiz={handleGenerateQuiz}
                    onToggleComplete={handleToggleComplete}
                    isCompleted={userProfile.completed_summaries.includes(currentSummary.id)}
                    onGetExplanation={handleGetExplanation}
                    userProfile={userProfile}
                    onAIUpdate={() => setAIUpdateModalOpen(true)}
                />;
      default:
        return null; // A tela de login é tratada fora desta função
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

  // --- RENDERIZAÇÃO PRINCIPAL DO COMPONENTE ---

    if (loadingApp) {
      return (
        // Aplicando a nova classe aqui
        <div className="loading-overlay">
            <div className="loader"></div>
        </div>
      );
    }

    if (!session) {
      return <AuthScreen
                  theme={theme}
                  toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              />;
    }

    // Você pode adicionar um loader mais específico para o perfil se quiser
    if (!userProfile) {
        return (
            <div className="loading-overlay">
                <div className="loader"></div>
                <p>Carregando perfil...</p>
            </div>
        );
    }

  return (
    <>
      {view !== 'dashboard' && (
          <div className="main-header">
              <Breadcrumbs paths={breadcrumbPaths} />
              <ThemeToggle theme={theme} toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
          </div>
      )}
      {renderContent()}

      {/* Modals */}
      <SubjectModal
        isOpen={isSubjectModalOpen}
        onClose={() => setSubjectModalOpen(false)}
        onSave={handleSaveSubject}
        subject={editingSubject}
        existingSubjects={subjects}
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
              subjectId: currentSubjectId
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
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
