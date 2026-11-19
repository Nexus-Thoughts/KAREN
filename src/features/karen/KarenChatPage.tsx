/**
 * KAREN AI — Full enterprise AI assistant with voice interaction.
 *
 * Architecture:
 *   Browser → supabase.functions.invoke('karen-chat') → Edge Function
 *   → Gemini API (server-side, API key never in browser) → Response
 *
 * Features added in this version:
 *   1. Suggested prompts when conversation is empty
 *   2. Voice input (SpeechRecognition) — browser-native, gated by user opt-in
 *   3. Voice output (SpeechSynthesis) — 🔊 button per KAREN response
 *   4. Explain mode — ▶ Explain transforms response into a natural spoken form
 *   5. Voice settings panel — enable/disable each mode, persisted to localStorage
 *   6. Router state: navigating with { state: { prompt } } pre-fills the input
 *   7. Progress status messages: "Analyzing...", "Checking attendance...", etc.
 *
 * Security: KAREN never runs in the browser with a model key. This component
 * only sends the user's text and reads back { reply }. All tool execution,
 * rate-limiting, RLS, and confirmation enforcement happen in the Edge Function.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Sparkles, Send, Loader2, Plus, Wrench, ShieldAlert, Check, X,
  Mic, MicOff, Volume2, VolumeX, Settings as SettingsIcon, ChevronDown, ChevronUp,
  MessageSquare,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/features/auth/AuthProvider';
import type { KarenMessage } from '@/karen/providers/types';

type ChatResponse =
  | { conversationId: string; reply: string; pendingConfirmation?: { id: string; summary: string } | null }
  | { error: string; message: string };

// ─── Voice preferences ────────────────────────────────────────────────────────

interface VoicePrefs {
  inputEnabled: boolean;
  outputEnabled: boolean;
  autoRead: boolean;
}

function loadVoicePrefs(): VoicePrefs {
  try {
    const stored = localStorage.getItem('karen_voice_prefs');
    if (stored) return { inputEnabled: false, outputEnabled: false, autoRead: false, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return { inputEnabled: false, outputEnabled: false, autoRead: false };
}

function saveVoicePrefs(p: VoicePrefs) {
  try { localStorage.setItem('karen_voice_prefs', JSON.stringify(p)); } catch { /* ignore */ }
}

// ─── Speech recognition hook ──────────────────────────────────────────────────

type ListenState = 'idle' | 'listening' | 'processing' | 'error';

// Minimal interface to avoid relying on tslib's DOM SpeechRecognition type
interface SpeechRecognitionEvent {
  results: Array<Array<{ transcript: string }>>;
}

interface ISpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): ISpeechRecognition;
}

function getSpeechRecognitionClass(): SpeechRecognitionConstructor | undefined {
  const w = window as unknown as Record<string, unknown>;
  return (w['SpeechRecognition'] ?? w['webkitSpeechRecognition']) as SpeechRecognitionConstructor | undefined;
}

function useSpeechRecognition(onResult: (text: string) => void) {
  const [listenState, setListenState] = useState<ListenState>('idle');
  const [available, setAvailable] = useState(false);
  const recRef = useRef<ISpeechRecognition | null>(null);

  useEffect(() => {
    const SpeechRecognitionClass = getSpeechRecognitionClass();
    setAvailable(!!SpeechRecognitionClass);
    if (!SpeechRecognitionClass) return;

    const rec = new SpeechRecognitionClass();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = 'en-IN';

    rec.onresult = (e: SpeechRecognitionEvent) => {
      const text = e.results[0]?.[0]?.transcript ?? '';
      setListenState('idle');
      if (text) onResult(text);
    };
    rec.onerror = () => setListenState('error');
    rec.onend = () => setListenState((s) => s === 'listening' ? 'idle' : s);

    recRef.current = rec;
    return () => { rec.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startListening = useCallback(() => {
    if (!recRef.current || listenState === 'listening') return;
    setListenState('listening');
    try { recRef.current.start(); } catch { setListenState('idle'); }
  }, [listenState]);

  const stopListening = useCallback(() => {
    recRef.current?.stop();
    setListenState('idle');
  }, []);

  return { listenState, available, startListening, stopListening };
}

// ─── Speech synthesis helper ─────────────────────────────────────────────────

function speak(text: string, onEnd?: () => void) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'en-IN';
  utter.rate = 0.95;
  utter.onend = () => onEnd?.();
  window.speechSynthesis.speak(utter);
}

function stopSpeaking() {
  window.speechSynthesis?.cancel();
}

const synthAvailable = !!window.speechSynthesis;

// ─── KAREN thinking status messages ──────────────────────────────────────────

const THINKING_PHRASES = [
  'Analyzing your request…',
  'Checking attendance data…',
  'Looking up timetable…',
  'Querying department records…',
  'Reviewing notifications…',
  'Consulting institutional data…',
];

function useThinkingMessage(active: boolean) {
  const [phrase, setPhrase] = useState(THINKING_PHRASES[0]!);
  const idx = useRef(0);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      idx.current = (idx.current + 1) % THINKING_PHRASES.length;
      setPhrase(THINKING_PHRASES[idx.current]!);
    }, 2200);
    return () => clearInterval(interval);
  }, [active]);

  return phrase;
}

// ─── Suggested prompts ────────────────────────────────────────────────────────

const SUGGESTED_PROMPTS = [
  { category: 'Attendance', prompt: 'Which class has the highest absenteeism today?' },
  { category: 'Attendance', prompt: 'Which departments have attendance below 75%?' },
  { category: 'Timetable', prompt: "What's today's timetable for CSE?" },
  { category: 'Reports', prompt: 'Generate the monthly attendance report.' },
  { category: 'Geo-Fencing', prompt: 'Show failed geo-fence checks today.' },
  { category: 'Students', prompt: 'Show students below the attendance threshold.' },
  { category: 'Analytics', prompt: 'Compare attendance across departments.' },
  { category: 'Analytics', prompt: 'Explain the biggest attendance issue in simple terms.' },
];

// ─── Main Component ───────────────────────────────────────────────────────────

const KarenChatPage: React.FC = () => {
  const { profile } = useAuth();
  const location = useLocation();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<KarenMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [pendingConfirmation, setPendingConfirmation] = useState<{ id: string; summary: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [voicePrefs, setVoicePrefs] = useState<VoicePrefs>(loadVoicePrefs);
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const [explainLoading, setExplainLoading] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const thinkingPhrase = useThinkingMessage(sending);

  // Voice recognition
  const { listenState, available: voiceInputAvailable, startListening, stopListening } = useSpeechRecognition((text) => {
    setInput((prev) => prev ? `${prev} ${text}` : text);
    inputRef.current?.focus();
  });

  // Pre-fill from router state (quick-ask from dashboard)
  useEffect(() => {
    const state = location.state as { prompt?: string } | null;
    if (state?.prompt) {
      setInput(state.prompt);
      // Clear state so navigating back doesn't re-fill
      window.history.replaceState({}, '');
    }
  }, [location.state]);

  // Resume most recent conversation
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: convo } = await supabase
        .from('karen_conversations')
        .select('id')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (convo) {
        setConversationId(convo.id);
        await loadMessages(convo.id);
      }
      setLoadingHistory(false);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const updateVoicePrefs = (patch: Partial<VoicePrefs>) => {
    setVoicePrefs((prev) => {
      const next = { ...prev, ...patch };
      saveVoicePrefs(next);
      return next;
    });
  };

  const loadMessages = async (id: string) => {
    const { data } = await supabase
      .from('karen_messages')
      .select('id, role, content, tool_name, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true });
    setMessages((data ?? []) as KarenMessage[]);
  };

  const startNewConversation = () => {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setPendingConfirmation(null);
    stopSpeaking();
  };

  const handleSend = async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || sending) return;
    setInput('');
    setError(null);
    setPendingConfirmation(null);
    setSending(true);
    stopSpeaking();

    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: 'user', content: msg, tool_name: null, created_at: new Date().toISOString() },
    ]);

    const { data, error: fnError } = await supabase.functions.invoke<ChatResponse>(
      'karen-chat',
      { body: { conversationId: conversationId ?? undefined, message: msg } },
    );

    setSending(false);

    if (fnError || !data || 'error' in data) {
      const message = data && 'message' in data ? data.message : fnError?.message ?? 'KAREN is unavailable right now. Please try again in a moment.';
      setError(message);
      return;
    }

    setConversationId(data.conversationId);
    await loadMessages(data.conversationId);
    if (data.pendingConfirmation) setPendingConfirmation(data.pendingConfirmation);

    // Auto-read response if enabled
    if (voicePrefs.autoRead && synthAvailable) {
      const lastAssistant = (data as { conversationId: string; reply: string }).reply;
      if (lastAssistant) speak(lastAssistant);
    }
  };

  const handleConfirm = async () => {
    if (!pendingConfirmation || confirming) return;
    setConfirming(true);
    setError(null);
    const { data, error: fnError } = await supabase.functions.invoke<ChatResponse>('karen-chat', {
      body: { conversationId, confirmActionId: pendingConfirmation.id },
    });
    setConfirming(false);
    setPendingConfirmation(null);

    if (fnError || !data || 'error' in data) {
      setError(data && 'message' in data ? data.message : fnError?.message ?? 'Could not confirm that action.');
      return;
    }
    await loadMessages((data as { conversationId: string }).conversationId);
  };

  const handleCancel = async () => {
    if (!pendingConfirmation) return;
    const id = pendingConfirmation.id;
    setPendingConfirmation(null);
    await supabase.from('karen_pending_actions').update({ consumed_at: new Date().toISOString() }).eq('id', id);
  };

  const handleSpeak = (text: string, msgId: string) => {
    if (speakingMsgId === msgId) {
      stopSpeaking();
      setSpeakingMsgId(null);
    } else {
      setSpeakingMsgId(msgId);
      speak(text, () => setSpeakingMsgId(null));
    }
  };

  const handleExplain = async (originalText: string, msgId: string) => {
    setExplainLoading(msgId);
    const explainPrompt = `Please explain the following response in simple, clear spoken English as if speaking directly to the administrator: "${originalText}"`;
    const { data, error: fnError } = await supabase.functions.invoke<ChatResponse>(
      'karen-chat',
      { body: { conversationId: conversationId ?? undefined, message: explainPrompt } },
    );
    setExplainLoading(null);
    if (fnError || !data || 'error' in data) return;
    setConversationId((data as { conversationId: string }).conversationId);
    await loadMessages((data as { conversationId: string }).conversationId);
    if (synthAvailable && voicePrefs.outputEnabled) {
      speak((data as { reply: string }).reply);
    }
  };

  const handleMicClick = () => {
    if (listenState === 'listening') stopListening();
    else startListening();
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-primary to-accent-secondary flex items-center justify-center shadow-[0_0_15px_rgba(47,91,255,0.3)]">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-text-primary">KAREN AI</h2>
            <p className="text-text-muted text-xs">Intelligent administrative assistant · powered by Gemini</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Voice settings toggle */}
          <button
            onClick={() => setShowVoiceSettings(!showVoiceSettings)}
            className={`p-2 rounded-lg border transition-colors flex items-center gap-1.5 text-xs font-medium ${showVoiceSettings ? 'bg-accent-primary/10 border-accent-primary/30 text-accent-primary' : 'bg-panel border-border-default text-text-secondary hover:text-text-primary'}`}
          >
            <SettingsIcon size={14} />
            <span className="hidden sm:inline">Voice</span>
            {showVoiceSettings ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>

          {/* New conversation */}
          <button
            onClick={startNewConversation}
            className="px-3 py-2 bg-panel border border-border-default rounded-lg text-text-secondary hover:text-text-primary transition-colors flex items-center gap-2 text-sm"
          >
            <Plus size={15} /> New
          </button>
        </div>
      </div>

      {/* Voice settings panel */}
      {showVoiceSettings && (
        <div className="mb-3 p-4 bg-panel border border-border-default rounded-xl animate-in slide-in-from-top-2 duration-200">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Voice Controls</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <VoiceToggle
              label="Voice Input"
              description="Use microphone to speak prompts"
              enabled={voicePrefs.inputEnabled}
              available={voiceInputAvailable}
              unavailableMsg="SpeechRecognition not supported in this browser"
              onChange={(v) => updateVoicePrefs({ inputEnabled: v })}
            />
            <VoiceToggle
              label="Voice Output"
              description="Enable 🔊 button on responses"
              enabled={voicePrefs.outputEnabled}
              available={synthAvailable}
              unavailableMsg="SpeechSynthesis not supported in this browser"
              onChange={(v) => updateVoicePrefs({ outputEnabled: v })}
            />
            <VoiceToggle
              label="Auto-Read"
              description="Automatically read each KAREN response"
              enabled={voicePrefs.autoRead}
              available={synthAvailable}
              unavailableMsg="Requires voice output support"
              onChange={(v) => updateVoicePrefs({ autoRead: v })}
            />
          </div>
        </div>
      )}

      {/* Chat area */}
      <div className="flex-1 bg-panel border border-border-default rounded-2xl flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-main/30">
          {loadingHistory ? (
            <div className="flex items-center justify-center h-full text-text-muted text-sm gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading conversation…
            </div>
          ) : messages.length === 0 ? (
            /* ── Suggested prompts (empty state) ── */
            <div className="flex flex-col items-center justify-center h-full gap-6 py-8">
              <div className="text-center">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-accent-primary to-accent-secondary flex items-center justify-center mx-auto mb-3 shadow-[0_0_20px_rgba(47,91,255,0.25)]">
                  <Sparkles size={24} className="text-white" />
                </div>
                <p className="text-base font-semibold text-text-primary">Hi {profile?.full_name?.split(' ')[0] ?? 'there'}</p>
                <p className="text-sm text-text-muted mt-1">Ask me anything about your institution.</p>
              </div>

              <div className="w-full max-w-xl">
                <p className="text-xs text-text-muted uppercase tracking-wider mb-3 text-center">Quick prompts</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {SUGGESTED_PROMPTS.map((p) => (
                    <button
                      key={p.prompt}
                      onClick={() => void handleSend(p.prompt)}
                      className="text-left p-3 bg-panel border border-border-default rounded-xl hover:border-accent-primary/40 hover:bg-accent-primary/5 transition-all group"
                    >
                      <span className="text-[10px] font-bold uppercase tracking-wider text-accent-secondary mb-1 block">{p.category}</span>
                      <span className="text-sm text-text-primary group-hover:text-text-primary">{p.prompt}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            /* ── Messages ── */
            messages.map((msg) =>
              msg.role === 'tool' ? (
                <div key={msg.id} className="flex justify-start">
                  <div className="text-[11px] text-text-muted flex items-center gap-1.5 px-3 py-1.5 bg-panel border border-border-default rounded-full">
                    <Wrench size={11} /> used {msg.tool_name}
                  </div>
                </div>
              ) : (
                <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} gap-1`}>
                  <div
                    className={`max-w-[80%] p-3.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'bg-accent-primary text-white rounded-br-sm shadow-[0_2px_12px_rgba(47,91,255,0.25)]'
                        : 'bg-panel border border-border-default text-text-primary rounded-bl-sm shadow-sm'
                    }`}
                  >
                    {msg.content}
                  </div>

                  {/* KAREN response action buttons */}
                  {msg.role === 'assistant' && msg.content && (voicePrefs.outputEnabled || synthAvailable) && (
                    <div className="flex items-center gap-1.5 ml-1">
                      {synthAvailable && (
                        <>
                          <button
                            onClick={() => handleSpeak(msg.content!, msg.id)}
                            className={`text-[11px] flex items-center gap-1 px-2 py-1 rounded-full border transition-all ${
                              speakingMsgId === msg.id
                                ? 'bg-accent-primary/10 border-accent-primary/30 text-accent-primary'
                                : 'border-border-default text-text-muted hover:text-text-primary hover:border-border-hover'
                            }`}
                            title={speakingMsgId === msg.id ? 'Stop' : 'Listen'}
                          >
                            {speakingMsgId === msg.id ? <VolumeX size={11} /> : <Volume2 size={11} />}
                            {speakingMsgId === msg.id ? 'Stop' : 'Listen'}
                          </button>

                          <button
                            onClick={() => void handleExplain(msg.content!, msg.id)}
                            disabled={explainLoading === msg.id || sending}
                            className="text-[11px] flex items-center gap-1 px-2 py-1 rounded-full border border-border-default text-text-muted hover:text-text-primary hover:border-border-hover transition-all disabled:opacity-40"
                            title="Explain in simpler terms and optionally read aloud"
                          >
                            {explainLoading === msg.id ? <Loader2 size={11} className="animate-spin" /> : <MessageSquare size={11} />}
                            Explain
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            )
          )}

          {/* Thinking indicator */}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-panel border border-border-default p-3.5 rounded-2xl rounded-bl-sm flex items-center gap-2 shadow-sm">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent-primary animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-accent-primary animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-accent-primary animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                <span className="text-xs text-text-muted">{thinkingPhrase}</span>
              </div>
            </div>
          )}

          {/* Confirmation widget */}
          {pendingConfirmation && (
            <div className="flex justify-start">
              <div className="max-w-[85%] bg-status-warning/10 border border-status-warning/30 rounded-2xl rounded-bl-sm p-4 space-y-3">
                <div className="flex items-start gap-2 text-sm text-text-primary">
                  <ShieldAlert size={16} className="text-status-warning mt-0.5 shrink-0" />
                  <span>{pendingConfirmation.summary}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleConfirm}
                    disabled={confirming}
                    className="px-3 py-1.5 bg-status-warning text-white text-xs font-medium rounded-lg flex items-center gap-1.5 hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {confirming ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Confirm
                  </button>
                  <button
                    onClick={handleCancel}
                    disabled={confirming}
                    className="px-3 py-1.5 bg-panel border border-border-default text-text-secondary text-xs font-medium rounded-lg flex items-center gap-1.5 hover:text-text-primary transition-colors disabled:opacity-50"
                  >
                    <X size={13} /> Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex justify-start">
              <div className="bg-status-error/10 border border-status-error/20 text-status-error p-3 rounded-2xl rounded-bl-sm text-xs max-w-[80%]">
                {error}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input area */}
        <div className="p-4 bg-panel border-t border-border-default">
          {/* Voice status banner */}
          {listenState === 'listening' && (
            <div className="mb-2 flex items-center gap-2 text-xs text-status-success animate-pulse">
              <span className="w-2 h-2 rounded-full bg-status-success" />
              Listening… speak your request
            </div>
          )}
          {listenState === 'error' && (
            <div className="mb-2 text-xs text-status-error">Microphone error — check browser permissions.</div>
          )}

          <div className="flex items-center gap-2 bg-main rounded-xl border border-border-default px-3 py-2 focus-within:border-accent-primary transition-colors">
            {/* Mic button */}
            {voicePrefs.inputEnabled && voiceInputAvailable && (
              <button
                onClick={handleMicClick}
                disabled={sending}
                className={`p-1.5 rounded-lg flex-shrink-0 transition-all ${
                  listenState === 'listening'
                    ? 'bg-status-error/10 text-status-error ring-2 ring-status-error/30'
                    : 'text-text-muted hover:text-accent-primary hover:bg-accent-primary/10'
                } disabled:opacity-40`}
                title={listenState === 'listening' ? 'Stop listening' : 'Start voice input'}
              >
                {listenState === 'listening' ? <MicOff size={16} /> : <Mic size={16} />}
              </button>
            )}

            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void handleSend()}
              placeholder={voicePrefs.inputEnabled ? 'Ask anything or tap 🎙…' : 'Ask KAREN anything…'}
              disabled={sending}
              className="flex-1 bg-transparent border-none outline-none text-text-primary text-sm placeholder-text-muted disabled:opacity-50"
            />

            <button
              onClick={() => void handleSend()}
              disabled={sending || !input.trim()}
              className="p-2 bg-accent-primary/15 rounded-lg text-accent-primary hover:bg-accent-primary hover:text-white transition-all disabled:opacity-40 disabled:hover:bg-accent-primary/15 disabled:hover:text-accent-primary flex-shrink-0"
            >
              <Send size={16} />
            </button>
          </div>

          <p className="text-[10px] text-text-muted mt-2 text-center">
            KAREN uses your institutional data only · Sensitive actions require confirmation
          </p>
        </div>
      </div>
    </div>
  );
};

// ─── Voice Toggle component ───────────────────────────────────────────────────

const VoiceToggle: React.FC<{
  label: string;
  description: string;
  enabled: boolean;
  available: boolean;
  unavailableMsg: string;
  onChange: (v: boolean) => void;
}> = ({ label, description, enabled, available, unavailableMsg, onChange }) => (
  <div className={`p-3 rounded-xl border ${available ? 'border-border-default' : 'border-border-default opacity-50'}`}>
    <div className="flex items-center justify-between mb-1">
      <span className="text-xs font-semibold text-text-primary">{label}</span>
      <button
        disabled={!available}
        onClick={() => onChange(!enabled)}
        className={`relative w-8 h-4 rounded-full transition-colors ${enabled && available ? 'bg-accent-primary' : 'bg-border-default'} disabled:cursor-not-allowed`}
      >
        <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${enabled && available ? 'translate-x-4' : 'translate-x-0'}`} />
      </button>
    </div>
    <p className="text-[10px] text-text-muted">{available ? description : unavailableMsg}</p>
  </div>
);

export default KarenChatPage;
