import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Copy,
  Edit3,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { AppShell } from '../components/AppShell.tsx';
import { PageTransition, SkeletonCard } from '../components/ui/MotionPrimitives.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import {
  formatCompanionErrorMessage,
  normalizeRetrievedMessages,
  parseCompanionApiResponse,
  validateAndBuildAIMessage,
} from '../lib/aiMessageUtils.ts';
import { postProtectedAi } from '../lib/apiClient.ts';
import { computeProfileCompleteness } from '../lib/eligibilityEngine.ts';
import {
  addMessage,
  createConversation,
  deleteConversationWithMessages,
  getApplicationChecklistItems,
  getApplicationEvents,
  getApplications,
  getConversations,
  getDocumentAnalyses,
  getDocuments,
  getEligibilityAssessments,
  getMessages,
  getNotifications,
  getReadinessAssessments,
  getSavedScholarships,
  getScholarships,
  makeId,
  renameConversation,
} from '../lib/firestoreRepo.ts';
import type {
  AIConversation,
  AIMessage,
  ApplicationChecklistItemRecord,
  ApplicationEventRecord,
  ApplicationRecord,
  DocumentAnalysis,
  DocumentRecord,
  EligibilityAssessment,
  NotificationRecord,
  ReadinessAssessment,
  SavedScholarship,
  Scholarship,
} from '../types/database.ts';
import { peekPublicCache, peekUserCache } from '../lib/workspaceCache.ts';

const STARTER_PROMPTS = [
  'Which scholarships in the database am I eligible for, and what are their official portals and deadlines?',
  'Explain my uploaded Academic Marksheet marks, main aggregate percentage, and how additional subjects are handled.',
  'Which tracked applications have approaching deadlines, missing checklist documents, or require action?',
  'Why am I marked Not Eligible or Potentially Eligible for some scholarships in the catalog?',
  'What are my current tracked scholarship applications and readiness next steps?',
];

function formatMessageTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatThreadDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
    });
  } catch {
    return '';
  }
}

function renderInlineSegments(text: string, isUser: boolean): React.ReactNode[] {
  // Split by **bold** and https:// URLs safely without dangerouslySetInnerHTML
  const tokenRegex = /(\*\*[^*]+\*\*|https?:\/\/[^\s)<>]+)/g;
  const parts = text.split(tokenRegex);

  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (/^https?:\/\/[^\s)<>]+$/.test(part)) {
      const cleanUrl = part.replace(/[.,;:!?]+$/, '');
      const trailing = part.slice(cleanUrl.length);
      return (
        <React.Fragment key={idx}>
          <a
            href={cleanUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={
              isUser
                ? 'underline text-indigo-100 hover:text-white break-all'
                : 'underline text-indigo-300 hover:text-indigo-200 break-all'
            }
          >
            {cleanUrl}
          </a>
          {trailing}
        </React.Fragment>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

function FormattedMessageText({ content, isUser }: { content: string; isUser: boolean }) {
  const safeContent = typeof content === 'string' ? content : '';
  const lines = safeContent.split('\n');
  return (
    <div className="space-y-1.5 text-sm leading-relaxed">
      {lines.map((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <div key={idx} className="h-1" />;
        }
        if (/^#{1,3}\s+/.test(trimmed)) {
          const headingText = trimmed.replace(/^#{1,3}\s+/, '');
          return (
            <p key={idx} className="font-semibold text-sm text-white pt-1 font-display">
              {renderInlineSegments(headingText, isUser)}
            </p>
          );
        }
        if (/^[-*]\s+/.test(trimmed)) {
          return (
            <div key={idx} className="flex items-start gap-2 pl-1">
              <span aria-hidden="true" className="mt-0.5 text-xs text-indigo-300/80">
                •
              </span>
              <span className="flex-1">{renderInlineSegments(trimmed.slice(2), isUser)}</span>
            </div>
          );
        }
        return <p key={idx}>{renderInlineSegments(line, isUser)}</p>;
      })}
    </div>
  );
}

interface CompanionApiResponse {
  reply: string;
  groundedSummary?: {
    scholarshipsCount: number;
    eligibleCount: number;
    documentsCount: number;
    marksheetsCount: number;
    readinessPercent: number;
  };
}

interface FailedAttempt {
  conversationId: string;
  messageText: string;
  historySnapshot: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export default function AICompanionPage() {
  const { user, profile, getIdToken } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const cachedConvs = peekUserCache<AIConversation[]>(user?.uid, 'ai_conversations');
  const initialConvId = cachedConvs?.[0]?.id ?? null;
  const cachedInitialMsgs = initialConvId
    ? peekUserCache<AIMessage[]>(user?.uid, `ai_messages:${initialConvId}`)
    : undefined;
  const cachedDocs = peekUserCache<DocumentRecord[]>(user?.uid, 'documents');
  const cachedAnalyses = peekUserCache<DocumentAnalysis[]>(user?.uid, 'document_analysis');
  const cachedElig = peekUserCache<EligibilityAssessment[]>(user?.uid, 'eligibility_assessments');
  const cachedSaved = peekUserCache<SavedScholarship[]>(user?.uid, 'saved_scholarships');
  const cachedApps = peekUserCache<ApplicationRecord[]>(user?.uid, 'applications');
  const cachedEvents = peekUserCache<ApplicationEventRecord[]>(user?.uid, 'application_events');
  const cachedChecklist = peekUserCache<ApplicationChecklistItemRecord[]>(
    user?.uid,
    'application_checklist_items'
  );
  const cachedReadiness = peekUserCache<ReadinessAssessment[]>(user?.uid, 'readiness_assessments');
  const cachedNotifications = peekUserCache<NotificationRecord[]>(user?.uid, 'notifications');
  const cachedSch = peekPublicCache<{ items: Scholarship[]; isEmptyDatabase: boolean }>('scholarships');

  const [conversations, setConversations] = useState<AIConversation[]>(() => cachedConvs ?? []);
  const [activeConvId, setActiveConvId] = useState<string | null>(() => initialConvId);
  const [messages, setMessages] = useState<AIMessage[]>(() =>
    initialConvId && cachedInitialMsgs
      ? normalizeRetrievedMessages(cachedInitialMsgs, initialConvId)
      : []
  );
  const [loadingThreads, setLoadingThreads] = useState(() => !cachedConvs);
  const [loadingMessages, setLoadingMessages] = useState(
    () => Boolean(initialConvId && !cachedInitialMsgs)
  );

  // Grounded student database records
  const [documents, setDocuments] = useState<DocumentRecord[]>(() => cachedDocs ?? []);
  const [analyses, setAnalyses] = useState<DocumentAnalysis[]>(() => cachedAnalyses ?? []);
  const [eligibilityAssessments, setEligibilityAssessments] = useState<EligibilityAssessment[]>(
    () => cachedElig ?? []
  );
  const [savedScholarships, setSavedScholarships] = useState<SavedScholarship[]>(
    () => cachedSaved ?? []
  );
  const [applications, setApplications] = useState<ApplicationRecord[]>(() => cachedApps ?? []);
  const [applicationEvents, setApplicationEvents] = useState<ApplicationEventRecord[]>(
    () => cachedEvents ?? []
  );
  const [applicationChecklistItems, setApplicationChecklistItems] = useState<
    ApplicationChecklistItemRecord[]
  >(() => cachedChecklist ?? []);
  const [readinessAssessments, setReadinessAssessments] = useState<ReadinessAssessment[]>(
    () => cachedReadiness ?? []
  );
  const [notifications, setNotifications] = useState<NotificationRecord[]>(
    () => cachedNotifications ?? []
  );
  const [catalogCount, setCatalogCount] = useState<number | null>(
    () => cachedSch?.items.length ?? null
  );

  // Chat input & controls
  const [input, setInput] = useState(() => searchParams.get('prompt') ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedAttempt, setFailedAttempt] = useState<FailedAttempt | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [mobileThreadsOpen, setMobileThreadsOpen] = useState(false);

  useEffect(() => {
    const qp = searchParams.get('prompt');
    if (qp) {
      setInput(qp);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Thread search, rename, delete
  const [threadSearch, setThreadSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [threadBusyId, setThreadBusyId] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const skipNextFetchConvIdRef = useRef<string | null>(null);
  const sendingLockRef = useRef(false);

  const appendUniqueMessage = (prev: AIMessage[], nextMsg: AIMessage): AIMessage[] => {
    if (prev.some((m) => m.id === nextMsg.id)) {
      return prev;
    }
    return [...prev, nextMsg];
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    if (!peekUserCache<AIConversation[]>(user.uid, 'ai_conversations')) {
      setLoadingThreads(true);
    }

    // Decouple thread list loading from background grounding context so sidebar & active thread render immediately
    getConversations(user.uid)
      .then((convList) => {
        if (cancelled) return;
        setConversations(convList);
        setActiveConvId((prev) => prev ?? (convList[0]?.id ?? null));
      })
      .catch((err) => {
        if (!cancelled) {
          setError(formatCompanionErrorMessage(err, 'Failed to load companion threads.'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingThreads(false);
      });

    Promise.all([
      getDocuments(user.uid),
      getDocumentAnalyses(user.uid),
      getEligibilityAssessments(user.uid),
      getSavedScholarships(user.uid),
      getApplications(user.uid),
      getApplicationEvents(user.uid),
      getApplicationChecklistItems(user.uid),
      getReadinessAssessments(user.uid),
      getNotifications(user.uid),
      getScholarships(),
    ])
      .then(
        ([
          docsRes,
          anaRes,
          eligRes,
          savedRes,
          appsRes,
          appEventsRes,
          appChecklistRes,
          readyRes,
          notifRes,
          scholarshipsRes,
        ]) => {
          if (cancelled) return;
          setDocuments(docsRes);
          setAnalyses(anaRes);
          setEligibilityAssessments(eligRes);
          setSavedScholarships(savedRes);
          setApplications(appsRes);
          setApplicationEvents(appEventsRes);
          setApplicationChecklistItems(appChecklistRes);
          setReadinessAssessments(readyRes);
          setNotifications(notifRes);
          setCatalogCount(scholarshipsRes.items.length);
        }
      )
      .catch((err) => {
        if (!cancelled) {
          setError(formatCompanionErrorMessage(err, 'Failed to load companion grounding context.'));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user || !activeConvId) {
      setMessages([]);
      setLoadingMessages(false);
      return;
    }
    if (skipNextFetchConvIdRef.current === activeConvId) {
      skipNextFetchConvIdRef.current = null;
      return;
    }
    let cancelled = false;
    const warmMessages = peekUserCache<AIMessage[]>(user.uid, `ai_messages:${activeConvId}`);
    if (warmMessages) {
      setMessages(normalizeRetrievedMessages(warmMessages, activeConvId));
      setLoadingMessages(false);
    } else {
      setLoadingMessages(true);
    }
    setError(null);
    setFailedAttempt(null);

    getMessages(user.uid, activeConvId)
      .then((msgs) => {
        if (cancelled) return;
        setMessages(normalizeRetrievedMessages(msgs, activeConvId));
      })
      .catch((err) => {
        if (!cancelled) {
          setError(formatCompanionErrorMessage(err, 'Unable to load conversation messages.'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user, activeConvId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, sending]);

  const profileCompleteness = useMemo(() => computeProfileCompleteness(profile), [profile]);

  const marksheetCount = useMemo(
    () =>
      analyses.filter((a) => Boolean(a.marksheetSummary)).length ||
      documents.filter((d) => d.documentType.toLowerCase().includes('marksheet')).length,
    [analyses, documents]
  );

  const documentContext = useMemo(() => {
    const latestByDoc = new Map<string, DocumentAnalysis>();
    for (const ana of analyses) {
      const existing = latestByDoc.get(ana.documentId);
      if (!existing || ana.createdAt > existing.createdAt) {
        latestByDoc.set(ana.documentId, ana);
      }
    }
    return documents.slice(0, 12).map((d) => {
      const ana = latestByDoc.get(d.id);
      return {
        id: d.id,
        userId: d.userId,
        documentType: d.documentType,
        fileName: d.fileName,
        processingStatus: d.processingStatus ?? d.verificationStatus,
        detectedType: ana?.detectedType,
        readinessVerdict: ana?.readinessVerdict,
        issuingAuthority: ana?.issuingAuthority,
        extractedFields: (ana?.extractedFields ?? [])
          .filter((f) => f.status === 'Extracted')
          .slice(0, 15)
          .map((f) => ({ fieldName: f.fieldName, value: f.value, confidence: f.confidence })),
        marksheetSummary: ana?.marksheetSummary ?? null,
        missingFields: ana?.missingFields ?? [],
        issuesFound: ana?.issuesFound ?? [],
      };
    });
  }, [documents, analyses]);

  const filteredConversations = useMemo(() => {
    const q = threadSearch.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, threadSearch]);

  const startNewConversation = async (initialTitle = 'Scholarship Guidance Thread') => {
    if (!user) return null;
    const now = new Date().toISOString();
    const cleanTitle = initialTitle.trim().slice(0, 80) || 'Scholarship Guidance Thread';
    const conv: AIConversation = {
      id: makeId('conv'),
      userId: user.uid,
      title: cleanTitle,
      createdAt: now,
      updatedAt: now,
    };
    await createConversation(conv);
    skipNextFetchConvIdRef.current = conv.id;
    setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]));
    setActiveConvId(conv.id);
    setMessages([]);
    setError(null);
    setFailedAttempt(null);
    setMobileThreadsOpen(false);
    return conv.id;
  };

  const requestCompanionResponse = async (
    convId: string,
    messageText: string,
    historySnapshot: Array<{ role: 'user' | 'assistant'; content: string }>
  ) => {
    if (!user) return;
    sendingLockRef.current = true;
    setError(null);
    setFailedAttempt(null);
    setSending(true);
    try {
      const token = await getIdToken();
      const rawRes = await postProtectedAi<CompanionApiResponse>('/api/ai/companion', token, {
        message: messageText,
        history: historySnapshot.slice(-12),
        profileContext: profile,
        documentContext,
        studentContext: {
          profile,
          documents: documents.slice(0, 20),
          documentAnalyses: analyses.slice(0, 20),
          eligibilityAssessments: eligibilityAssessments.slice(0, 25),
          savedScholarships: savedScholarships.slice(0, 25),
          applications: applications.slice(0, 25),
          applicationEvents: applicationEvents.slice(0, 40),
          applicationChecklistItems: applicationChecklistItems.slice(0, 40),
          readinessAssessments: readinessAssessments.slice(0, 10),
          notifications: notifications.slice(0, 10),
        },
      });

      const validatedRes = parseCompanionApiResponse(rawRes);
      const assistantMsg = validateAndBuildAIMessage({
        id: makeId('msg'),
        conversationId: convId,
        userId: user.uid,
        role: 'assistant',
        content: validatedRes.reply,
        createdAt: new Date().toISOString(),
      });
      await addMessage(assistantMsg);
      setMessages((prev) => appendUniqueMessage(prev, assistantMsg));
      setConversations((prev) => {
        const updated = prev.map((c) =>
          c.id === convId ? { ...c, updatedAt: assistantMsg.createdAt } : c
        );
        return updated.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
    } catch (err) {
      setError(
        formatCompanionErrorMessage(
          err,
          'Unable to get response from AI Companion. Please retry.'
        )
      );
      setFailedAttempt({
        conversationId: convId,
        messageText,
        historySnapshot,
      });
    } finally {
      sendingLockRef.current = false;
      setSending(false);
    }
  };

  const sendPrompt = async (textToSend: string) => {
    const trimmed = typeof textToSend === 'string' ? textToSend.trim() : '';
    if (!user || !trimmed || sending || sendingLockRef.current) return;

    sendingLockRef.current = true;
    setSending(true);
    setError(null);
    setFailedAttempt(null);

    try {
      let convId = activeConvId;
      const historyBefore = messages
        .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
        .map((m) => ({ role: m.role, content: m.content }));

      if (!convId) {
        convId = await startNewConversation(trimmed);
      }
      if (!convId) {
        sendingLockRef.current = false;
        setSending(false);
        return;
      }

      const userMsg = validateAndBuildAIMessage({
        id: makeId('msg'),
        conversationId: convId,
        userId: user.uid,
        role: 'user',
        content: trimmed,
        createdAt: new Date().toISOString(),
      });
      await addMessage(userMsg);
      setMessages((prev) => appendUniqueMessage(prev, userMsg));
      setInput('');

      await requestCompanionResponse(convId, trimmed, historyBefore);
    } catch (err) {
      sendingLockRef.current = false;
      setSending(false);
      setError(
        formatCompanionErrorMessage(err, 'Unable to save message to conversation history.')
      );
    }
  };

  const handleRetry = () => {
    if (!failedAttempt || sending || sendingLockRef.current) return;
    void requestCompanionResponse(
      failedAttempt.conversationId,
      failedAttempt.messageText,
      failedAttempt.historySnapshot
    );
  };

  const handleCopyMessage = async (msgId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMsgId(msgId);
      setTimeout(() => {
        setCopiedMsgId((prev) => (prev === msgId ? null : prev));
      }, 2000);
    } catch {
      // Clipboard unavailable in restricted browser context
    }
  };

  const handleSaveRename = async (convId: string) => {
    const clean = renameDraft.trim();
    if (!clean || threadBusyId) return;
    setThreadBusyId(convId);
    try {
      await renameConversation(convId, clean);
      const now = new Date().toISOString();
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? { ...c, title: clean, updatedAt: now } : c))
      );
      setRenamingId(null);
    } catch (err) {
      setError(formatCompanionErrorMessage(err, 'Unable to rename conversation.'));
    } finally {
      setThreadBusyId(null);
    }
  };

  const handleDeleteConversation = async (convId: string) => {
    if (!user || threadBusyId) return;
    setThreadBusyId(convId);
    try {
      await deleteConversationWithMessages(user.uid, convId);
      const remaining = conversations.filter((c) => c.id !== convId);
      setConversations(remaining);
      if (activeConvId === convId) {
        setActiveConvId(remaining[0]?.id ?? null);
        setMessages([]);
      }
      setConfirmDeleteId(null);
    } catch (err) {
      setError(formatCompanionErrorMessage(err, 'Unable to delete conversation.'));
    } finally {
      setThreadBusyId(null);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendPrompt(input);
  };

  const renderThreadSidebarContent = () => (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold text-slate-300 font-display tracking-wide">
          Saved Conversations
        </h2>
        <span className="text-xs font-mono-num text-slate-400">{conversations.length}</span>
      </div>

      <div className="relative">
        <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={threadSearch}
          onChange={(e) => setThreadSearch(e.target.value)}
          placeholder="Search threads..."
          aria-label="Search conversations"
          className="input-midnight w-full pl-8 pr-3 py-2 text-xs"
        />
      </div>

      {loadingThreads ? (
        <div className="space-y-2 py-2">
          <SkeletonCard className="h-12" />
          <SkeletonCard className="h-12" />
          <SkeletonCard className="h-12" />
        </div>
      ) : filteredConversations.length === 0 ? (
        <div className="py-6 px-2 text-xs text-slate-400 space-y-1.5">
          <p>{conversations.length === 0 ? 'No saved threads yet.' : 'No matching threads.'}</p>
          {conversations.length === 0 && (
            <p className="text-slate-500">
              Ask a question to save your personalized scholarship guidance history.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-1.5 overflow-y-auto max-h-[520px] pr-0.5">
          {filteredConversations.map((c) => {
            const isActive = activeConvId === c.id;
            const isRenaming = renamingId === c.id;
            const isConfirmingDelete = confirmDeleteId === c.id;

            return (
              <div
                key={c.id}
                className={`rounded-xl border transition-colors ${
                  isActive
                    ? 'bg-indigo-500/15 border-indigo-500/40'
                    : 'bg-[#070C1B]/60 border-slate-800/80 hover:bg-slate-800/40 hover:border-slate-700'
                }`}
              >
                {isRenaming ? (
                  <div className="p-2 flex items-center gap-1.5">
                    <input
                      type="text"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleSaveRename(c.id);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      autoFocus
                      className="input-midnight flex-1 min-w-0 px-2.5 py-1 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveRename(c.id)}
                      disabled={threadBusyId === c.id}
                      aria-label="Save thread title"
                      className="p-1.5 text-emerald-300 hover:bg-emerald-500/15 rounded-lg"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenamingId(null)}
                      aria-label="Cancel rename"
                      className="p-1.5 text-slate-400 hover:bg-slate-800 rounded-lg"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : isConfirmingDelete ? (
                  <div className="p-2.5 flex items-center justify-between gap-2 text-xs">
                    <span className="text-rose-300 font-medium truncate">Delete thread?</span>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => void handleDeleteConversation(c.id)}
                        disabled={threadBusyId === c.id}
                        className="px-2.5 py-1 bg-rose-600 text-white rounded-lg text-[11px] font-semibold hover:bg-rose-500 whitespace-nowrap"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-2.5 py-1 bg-slate-800 border border-slate-700 text-slate-200 rounded-lg text-[11px] hover:bg-slate-700 whitespace-nowrap"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-1 px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveConvId(c.id);
                        setConfirmDeleteId(null);
                        setRenamingId(null);
                        setMobileThreadsOpen(false);
                      }}
                      className="flex-1 min-w-0 text-left"
                    >
                      <p
                        className={`text-xs font-semibold truncate ${
                          isActive ? 'text-indigo-200' : 'text-slate-200'
                        }`}
                      >
                        {c.title}
                      </p>
                      <p className="text-[11px] text-slate-500 font-mono-num mt-0.5">
                        {formatThreadDate(c.updatedAt)}
                      </p>
                    </button>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setRenamingId(c.id);
                          setRenameDraft(c.title);
                          setConfirmDeleteId(null);
                        }}
                        aria-label="Rename conversation"
                        title="Rename thread"
                        className="p-1.5 text-slate-500 hover:text-slate-200 hover:bg-slate-800/80 rounded-lg transition-colors"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDeleteId(c.id);
                          setRenamingId(null);
                        }}
                        aria-label="Delete conversation"
                        title="Delete thread"
                        className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <AppShell
      title="AI Companion"
      breadcrumb="Workspace / Grounded Scholarship Advisor"
      primaryAction={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMobileThreadsOpen((v) => !v)}
            className="lg:hidden inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-200 bg-[#101933] border border-slate-700/80 hover:bg-slate-800 rounded-xl whitespace-nowrap shrink-0"
          >
            {mobileThreadsOpen ? (
              <PanelLeftClose className="w-4 h-4 text-indigo-300" />
            ) : (
              <PanelLeftOpen className="w-4 h-4 text-indigo-300" />
            )}
            <span>Threads ({conversations.length})</span>
          </button>

          <button
            type="button"
            onClick={() => void startNewConversation()}
            className="btn-primary-gradient inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>New Thread</span>
          </button>
        </div>
      }
    >
      <PageTransition>
        <div className="grid lg:grid-cols-12 gap-6 min-h-[640px]">
          {/* Mobile Collapsible Thread Panel */}
          <AnimatePresence>
            {mobileThreadsOpen && (
              <motion.aside
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="lg:hidden surface-card p-4"
              >
                {renderThreadSidebarContent()}
              </motion.aside>
            )}
          </AnimatePresence>

          {/* Desktop Left Sidebar: Saved Conversations */}
          <aside className="hidden lg:flex lg:col-span-4 xl:col-span-3 surface-card p-4 flex-col">
            {renderThreadSidebarContent()}
          </aside>

          {/* Main Chat Stage */}
          <section className="lg:col-span-8 xl:col-span-9 surface-card flex flex-col justify-between overflow-hidden">
            {/* Grounded Data Context Strip */}
            <div className="px-5 py-3.5 border-b border-slate-800/90 bg-[#070C1B]/85 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs text-slate-200 font-semibold font-display">
                <MessageSquare className="w-4 h-4 text-indigo-400 shrink-0" />
                <span>Grounded Scholarship Advisor</span>
              </div>
              <p className="text-xs text-slate-400 font-mono-num">
                Profile {profileCompleteness.percent}% · {documents.length} Docs ({marksheetCount}{' '}
                Marksheet{marksheetCount === 1 ? '' : 's'}) ·{' '}
                {catalogCount === null ? '...' : `${catalogCount} Scholarships`} ·{' '}
                {applications.length} Tracked
              </p>
            </div>

            {/* Messages Viewport */}
            <div className="flex-1 p-5 sm:p-6 space-y-5 overflow-y-auto max-h-[540px]">
              {loadingMessages ? (
                <div className="py-12 flex items-center justify-center gap-2.5 text-sm text-slate-400">
                  <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                  <span>Loading conversation history...</span>
                </div>
              ) : messages.length === 0 ? (
                <div className="space-y-6 py-4">
                  <div className="space-y-2">
                    <div className="inline-flex items-center gap-2 text-xs font-semibold text-indigo-300">
                      <Sparkles className="w-4 h-4 shrink-0" />
                      <span>Context-Aware Reasoning Engine</span>
                    </div>
                    <h2 className="text-lg font-semibold text-white font-display">
                      Ask About Your Eligibility, Marksheets, or Applications
                    </h2>
                    <p className="text-sm text-slate-400 max-w-2xl leading-relaxed">
                      Every response is grounded in your saved student profile, deterministic
                      eligibility rules, analyzed documents (including marksheet subject totals and
                      AI-Calculated vs Document-Extracted aggregates), saved scholarships, and tracked
                      applications.
                    </p>
                  </div>

                  {catalogCount === 0 && (
                    <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-xs text-amber-200">
                      The scholarship catalog currently contains 0 records. The AI Companion will
                      honestly report this gap without recommending invented scholarships.
                    </div>
                  )}

                  <div className="grid sm:grid-cols-2 gap-3">
                    {STARTER_PROMPTS.map((promptText) => (
                      <button
                        key={promptText}
                        type="button"
                        onClick={() => void sendPrompt(promptText)}
                        disabled={sending}
                        className="group text-left p-4 rounded-xl border border-slate-800 bg-[#070C1B]/75 hover:bg-[#101933] hover:border-indigo-500/40 text-xs text-slate-300 hover:text-white leading-relaxed transition-all disabled:opacity-60 flex items-start justify-between gap-2.5"
                      >
                        <span className="flex-1">{promptText}</span>
                        <ArrowUpRight className="w-4 h-4 text-slate-500 group-hover:text-indigo-300 shrink-0 mt-0.5 transition-colors" />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((m) => {
                  const isUser = m.role === 'user';
                  const isCopied = copiedMsgId === m.id;
                  return (
                    <motion.div
                      key={m.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2 }}
                      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                    >
                      <div
                        className={`max-w-[90%] sm:max-w-[82%] rounded-2xl px-4 py-3.5 ${
                          isUser
                            ? 'bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-sm'
                            : 'bg-[#101933]/90 text-slate-100 border border-slate-800'
                        }`}
                      >
                        {!isUser && (
                          <div className="flex items-center justify-between gap-3 pb-2 mb-2 border-b border-slate-800/80">
                            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-indigo-300 font-display">
                              <Sparkles className="w-3.5 h-3.5" />
                              <span>GRANTLY AI</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleCopyMessage(m.id, m.content)}
                              className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-100 transition-colors"
                              aria-label="Copy response"
                            >
                              {isCopied ? (
                                <>
                                  <Check className="w-3 h-3 text-emerald-400" />
                                  <span className="text-emerald-300">Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>
                          </div>
                        )}
                        <FormattedMessageText content={m.content} isUser={isUser} />
                      </div>
                      <span className="text-[11px] text-slate-500 font-mono-num mt-1.5 px-1">
                        {isUser ? 'You' : 'Advisor'} · {formatMessageTime(m.createdAt)}
                      </span>
                    </motion.div>
                  );
                })
              )}

              {sending && (
                <div className="flex items-start">
                  <div className="rounded-2xl px-4 py-3 bg-[#101933]/85 border border-indigo-500/30 text-xs text-slate-300 inline-flex items-center gap-2.5">
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                    <span>Retrieving grounded records and analyzing your question...</span>
                  </div>
                </div>
              )}

              {error && (
                <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-sm text-rose-200 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-start gap-2.5 flex-1 min-w-[200px]">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                    <span>{error}</span>
                  </div>
                  {failedAttempt && (
                    <button
                      type="button"
                      onClick={handleRetry}
                      disabled={sending}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-rose-100 bg-rose-500/20 border border-rose-500/40 hover:bg-rose-500/30 rounded-lg whitespace-nowrap shrink-0"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Retry</span>
                    </button>
                  )}
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            {/* Input Bar */}
            <form
              onSubmit={handleSubmit}
              className="p-4 border-t border-slate-800/90 bg-[#070C1B]/80 flex gap-3"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={sending}
                placeholder="Ask about matching scholarships, marksheet percentage, missing documents, or NSP/DBT steps..."
                className="input-midnight flex-1 min-w-0 px-4 py-2.5 text-sm disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                className="btn-primary-gradient inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {sending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                <span>{sending ? 'Sending...' : 'Send'}</span>
              </button>
            </form>
          </section>
        </div>
      </PageTransition>
    </AppShell>
  );
}
