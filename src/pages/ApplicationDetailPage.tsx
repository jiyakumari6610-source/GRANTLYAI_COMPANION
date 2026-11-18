import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  ExternalLink,
  FileText,
  History,
  Info,
  MessageSquare,
  Save,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { AppShell } from '../components/AppShell.tsx';
import { PageTransition, SkeletonCard } from '../components/ui/MotionPrimitives.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { postProtectedAi } from '../lib/apiClient.ts';
import {
  evaluateTrackedApplication,
  EXTERNAL_PORTAL_NOTICE,
  validateApplicationTransition,
} from '../lib/applicationTrackerEngine.ts';
import {
  addApplicationEvent,
  getApplicationById,
  getApplicationChecklistItems,
  getApplicationEvents,
  getDocumentAnalyses,
  getDocuments,
  getProfile,
  getScholarships,
  getTrustGuardAssessments,
  makeId,
  upsertApplicationChecklistItem,
} from '../lib/firestoreRepo.ts';
import type {
  ApplicationChecklistItemRecord,
  ApplicationEventRecord,
  ApplicationRecord,
  DocumentAnalysis,
  DocumentRecord,
  Phase8ApplicationStatus,
  Scholarship,
  StudentProfile,
  TrustGuardDocumentAssessment,
} from '../types/database.ts';
import { peekPublicCache, peekUserCache } from '../lib/workspaceCache.ts';

function formatDateTimeIst(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Kolkata',
    });
  } catch {
    return iso;
  }
}

export default function ApplicationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user, profile: authProfile, getIdToken } = useAuth();
  const navigate = useNavigate();

  const cachedSingleApp = id
    ? peekUserCache<ApplicationRecord | null>(user?.uid, `application:${id}`)
    : undefined;
  const cachedAppList = peekUserCache<ApplicationRecord[]>(user?.uid, 'applications');
  const initialApp =
    cachedSingleApp ?? (id ? cachedAppList?.find((item) => item.id === id) ?? null : null);
  const cachedSch = peekPublicCache<{ items: Scholarship[]; isEmptyDatabase: boolean }>('scholarships');
  const cachedProfile = peekUserCache<StudentProfile | null>(user?.uid, 'profile');
  const cachedDocs = peekUserCache<DocumentRecord[]>(user?.uid, 'documents');
  const cachedAnalyses = peekUserCache<DocumentAnalysis[]>(user?.uid, 'document_analysis');
  const cachedTg = peekUserCache<TrustGuardDocumentAssessment[]>(user?.uid, 'trustguard_assessments');
  const cachedEvents = id
    ? peekUserCache<ApplicationEventRecord[]>(user?.uid, `application_events:${id}`)
    : undefined;
  const cachedChecklist = id
    ? peekUserCache<ApplicationChecklistItemRecord[]>(user?.uid, `application_checklist_items:${id}`)
    : undefined;

  const hasWarmDetailCache = Boolean(
    initialApp && initialApp.userId === user?.uid && cachedSch && cachedDocs && cachedAnalyses
  );

  const [application, setApplication] = useState<ApplicationRecord | null>(() =>
    initialApp && initialApp.userId === user?.uid ? initialApp : null
  );
  const [scholarships, setScholarships] = useState<Scholarship[]>(() => cachedSch?.items ?? []);
  const [profile, setProfile] = useState<StudentProfile | null>(
    () => cachedProfile ?? authProfile
  );
  const [documents, setDocuments] = useState<DocumentRecord[]>(() => cachedDocs ?? []);
  const [analyses, setAnalyses] = useState<DocumentAnalysis[]>(() => cachedAnalyses ?? []);
  const [tgAssessment, setTgAssessment] = useState<TrustGuardDocumentAssessment | null>(
    () => cachedTg?.[0] ?? null
  );
  const [events, setEvents] = useState<ApplicationEventRecord[]>(() => cachedEvents ?? []);
  const [checklistItems, setChecklistItems] = useState<ApplicationChecklistItemRecord[]>(
    () => cachedChecklist ?? []
  );

  const [loading, setLoading] = useState(!hasWarmDetailCache);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Editable form state
  const [refIdDraft, setRefIdDraft] = useState(() => initialApp?.portalReferenceId || '');
  const [deadlineDraft, setDeadlineDraft] = useState(() => initialApp?.deadline || '');
  const [notesDraft, setNotesDraft] = useState(() => initialApp?.notes || '');
  const [correctionDraft, setCorrectionDraft] = useState(() => initialApp?.correctionNotes || '');
  const [outcomeDraft, setOutcomeDraft] = useState(() => initialApp?.finalOutcome || '');

  // Confirmation modal for status transitions
  const [pendingTransition, setPendingTransition] = useState<Phase8ApplicationStatus | null>(null);
  const [submissionConfirmedCheck, setSubmissionConfirmedCheck] = useState(false);
  const [submissionDateDraft, setSubmissionDateDraft] = useState(
    () => initialApp?.submissionDate || new Date().toISOString().slice(0, 10)
  );
  const [modalRefId, setModalRefId] = useState(() => initialApp?.portalReferenceId || '');
  const [modalCorrectionNote, setModalCorrectionNote] = useState('');
  const [modalOutcomeNote, setModalOutcomeNote] = useState('');

  // External portal modal
  const [showPortalModal, setShowPortalModal] = useState(false);

  const loadData = useCallback(
    async (showSkeleton = false) => {
      if (!user || !id) return;
      if (showSkeleton) {
        setLoading(true);
      }
      setAccessError(null);
      try {
        const [appRec, schRes, profRes, docsRes, anaRes, tgRes, evtRes, chkRes] = await Promise.all([
          getApplicationById(id),
          getScholarships(),
          getProfile(user.uid),
          getDocuments(user.uid),
          getDocumentAnalyses(user.uid),
          getTrustGuardAssessments(user.uid),
          getApplicationEvents(user.uid, id),
          getApplicationChecklistItems(user.uid, id),
        ]);

        if (!appRec) {
          setAccessError('Tracked application not found.');
          setApplication(null);
          return;
        }
        if (appRec.userId !== user.uid) {
          setAccessError('Access denied: this application belongs to another student account.');
          setApplication(null);
          return;
        }

        setApplication(appRec);
        setScholarships(schRes.items);
        setProfile(profRes ?? authProfile);
        setDocuments(docsRes);
        setAnalyses(anaRes);
        setTgAssessment(tgRes[0] ?? null);
        setEvents(evtRes);
        setChecklistItems(chkRes);

        setRefIdDraft(appRec.portalReferenceId || '');
        setDeadlineDraft(appRec.deadline || '');
        setNotesDraft(appRec.notes || '');
        setCorrectionDraft(appRec.correctionNotes || '');
        setOutcomeDraft(appRec.finalOutcome || '');
        setModalRefId(appRec.portalReferenceId || '');
        setSubmissionDateDraft(appRec.submissionDate || new Date().toISOString().slice(0, 10));
      } catch (err) {
        setAccessError(err instanceof Error ? err.message : 'Unable to load application details.');
      } finally {
        setLoading(false);
      }
    },
    [user, id, authProfile]
  );

  useEffect(() => {
    void loadData(false);
  }, [loadData]);

  const linkedScholarship = useMemo(() => {
    if (!application) return null;
    return scholarships.find((s) => s.id === application.scholarshipId) ?? null;
  }, [application, scholarships]);

  const evaluated = useMemo(() => {
    if (!application) return null;
    return evaluateTrackedApplication({
      application,
      scholarship: linkedScholarship,
      profile,
      documents,
      documentAnalyses: analyses,
      trustGuardAssessment: tgAssessment,
      savedChecklistItems: checklistItems,
    });
  }, [application, linkedScholarship, profile, documents, analyses, tgAssessment, checklistItems]);

  const startTransitionFlow = (nextStatus: Phase8ApplicationStatus) => {
    if (!evaluated) return;
    setActionError(null);
    setActionMessage(null);

    const check = validateApplicationTransition({
      currentStatus: evaluated.normalizedStatus,
      nextStatus,
      submissionConfirmed: false,
      scholarshipExists: Boolean(linkedScholarship),
      scholarshipArchived: linkedScholarship?.verificationStatus === 'Archived',
      deadlineExpired: evaluated.deadline.isExpired,
    });

    if (!check.allowed && nextStatus !== 'Submitted') {
      setActionError(check.reason || 'Transition not permitted.');
      return;
    }

    if (nextStatus === 'Submitted' && (evaluated.scholarshipMissingOrArchived || evaluated.deadline.isExpired)) {
      setActionError(check.reason || 'Cannot mark Submitted for an expired, archived, or missing scholarship.');
      return;
    }

    if (check.requiresConfirmation || nextStatus === 'Submitted') {
      setPendingTransition(nextStatus);
      setSubmissionConfirmedCheck(false);
      setModalRefId(refIdDraft || application?.portalReferenceId || '');
      setModalCorrectionNote(correctionDraft || application?.correctionNotes || '');
      setModalOutcomeNote(outcomeDraft || application?.finalOutcome || '');
      return;
    }

    void executeTransition(nextStatus, {});
  };

  const executeTransition = async (
    nextStatus: Phase8ApplicationStatus,
    extras: {
      submissionConfirmed?: boolean;
      submissionDate?: string;
      portalReferenceId?: string;
      correctionNotes?: string;
      finalOutcome?: string;
      notes?: string;
      deadline?: string;
    }
  ) => {
    if (!application || !user) return;
    setBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const token = await getIdToken();
      const result = await postProtectedAi<{
        application: ApplicationRecord;
        event: ApplicationEventRecord;
      }>(`/api/applications/${application.id}/transition`, token, {
        nextStatus,
        ...extras,
      });

      setApplication(result.application);
      setEvents((prev) => [result.event, ...prev]);
      setRefIdDraft(result.application.portalReferenceId || '');
      setDeadlineDraft(result.application.deadline || '');
      setNotesDraft(result.application.notes || '');
      setCorrectionDraft(result.application.correctionNotes || '');
      setOutcomeDraft(result.application.finalOutcome || '');
      setPendingTransition(null);
      setActionMessage(`Application workflow updated to "${result.application.status}".`);

      void postProtectedAi('/api/applications/sync-notifications', token, {}).catch(() => undefined);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update workflow stage.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!evaluated) return;
    await executeTransition(evaluated.normalizedStatus, {
      portalReferenceId: refIdDraft,
      deadline: deadlineDraft,
      notes: notesDraft,
      correctionNotes: correctionDraft,
      finalOutcome: outcomeDraft,
    });
  };

  const handleToggleChecklistItem = async (
    requirementName: string,
    canComplete: boolean,
    currentlyCompleted: boolean,
    linkedDocumentId?: string
  ) => {
    if (!user || !application || !canComplete) return;
    const now = new Date().toISOString();
    const existing = checklistItems.find(
      (i) => i.applicationId === application.id && i.requirementName.toLowerCase() === requirementName.toLowerCase()
    );
    const nextCompleted = !currentlyCompleted;
    const record: ApplicationChecklistItemRecord = {
      id: existing?.id ?? makeId('chk'),
      applicationId: application.id,
      userId: user.uid,
      scholarshipId: application.scholarshipId,
      requirementName,
      isCompleted: nextCompleted,
      manualStatus: nextCompleted ? 'Completed' : 'Pending',
      ...(linkedDocumentId ? { linkedDocumentId } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    try {
      await upsertApplicationChecklistItem(record);
      setChecklistItems((prev) => {
        const filtered = prev.filter((i) => i.id !== record.id);
        return [...filtered, record];
      });
      const evt: ApplicationEventRecord = {
        id: makeId('evt'),
        applicationId: application.id,
        userId: user.uid,
        scholarshipId: application.scholarshipId,
        eventType: 'Checklist Updated',
        description: `${nextCompleted ? 'Marked complete' : 'Unmarked'}: "${requirementName}".`,
        source: 'student',
        actorUid: user.uid,
        createdAt: now,
      };
      await addApplicationEvent(evt);
      setEvents((prev) => [evt, ...prev]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update checklist item.');
    }
  };

  const handleLogPortalOpen = async () => {
    if (!application) return;
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{
        application: ApplicationRecord;
        event: ApplicationEventRecord;
      }>(`/api/applications/${application.id}/portal-open`, token, {});
      setApplication(res.application);
      setEvents((prev) => [res.event, ...prev]);
    } catch {
      // Non-blocking audit log
    }
  };

  if (loading) {
    return (
      <AppShell title="Application Workflow" breadcrumb="Workspace / Application Tracker / Loading">
        <div className="space-y-4">
          <SkeletonCard className="h-28" />
          <SkeletonCard className="h-80" />
        </div>
      </AppShell>
    );
  }

  if (accessError || !application || !evaluated) {
    return (
      <AppShell title="Application Unavailable" breadcrumb="Workspace / Application Tracker">
        <div className="surface-card p-8 text-center space-y-4">
          <p className="text-base font-semibold text-white">
            {accessError || 'Tracked application could not be loaded.'}
          </p>
          <button
            type="button"
            onClick={() => navigate('/applications')}
            className="btn-primary-gradient inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Application Tracker</span>
          </button>
        </div>
      </AppShell>
    );
  }

  const officialUrl = linkedScholarship?.officialUrl || linkedScholarship?.officialSourceUrl || '';

  return (
    <AppShell
      title={application.scholarshipTitle}
      breadcrumb={`Workspace / Application Tracker / ${evaluated.normalizedStatus}`}
      primaryAction={
        officialUrl ? (
          <button
            type="button"
            onClick={() => setShowPortalModal(true)}
            className="btn-primary-gradient inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold rounded-xl whitespace-nowrap shrink-0"
          >
            <span>Open Official Portal</span>
            <ExternalLink className="w-4 h-4" />
          </button>
        ) : undefined
      }
    >
      <PageTransition>
        <div className="space-y-6">
          {/* Top Action Row */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link
              to="/applications"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-400 hover:text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back to Application Tracker</span>
            </Link>

            <div className="flex flex-wrap items-center gap-2.5">
              {linkedScholarship && (
                <Link
                  to={`/scholarships/${linkedScholarship.id}`}
                  className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#101933] border border-slate-700/80 hover:bg-slate-800 rounded-xl whitespace-nowrap shrink-0"
                >
                  View Scheme Details
                </Link>
              )}
              <Link
                to={`/companion?prompt=${encodeURIComponent(
                  `What is the status, missing documents, deadline, and next step for my ${application.scholarshipTitle} application?`
                )}`}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-indigo-200 bg-indigo-500/15 border border-indigo-500/30 hover:bg-indigo-500/25 rounded-xl whitespace-nowrap shrink-0"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>Ask AI Companion</span>
              </Link>
            </div>
          </div>

          {/* Scholarship Removed / Archived / Unverified Disclosure */}
          {evaluated.scholarshipDisclosure && (
            <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-sm text-amber-100 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-amber-200">
                  {evaluated.scholarshipMissingOrArchived
                    ? 'Linked Scholarship Unavailable or Archived'
                    : 'Scholarship Verification Notice'}
                </p>
                <p className="text-xs text-amber-200/90 mt-0.5">{evaluated.scholarshipDisclosure}</p>
              </div>
            </div>
          )}

          {actionError && (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-sm text-rose-200 flex items-start justify-between gap-3">
              <span>{actionError}</span>
              <button type="button" onClick={() => setActionError(null)} className="text-rose-300 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {actionMessage && (
            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-sm text-emerald-200 flex items-start justify-between gap-3">
              <span>{actionMessage}</span>
              <button type="button" onClick={() => setActionMessage(null)} className="text-emerald-300 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Header Summary Strip */}
          <div className="surface-card p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs text-slate-400">
                  {linkedScholarship?.provider || application.provider || 'Scholarship Provider'}
                  {linkedScholarship ? ` · ${linkedScholarship.scholarshipType}` : ''}
                  {linkedScholarship ? ` · ${linkedScholarship.verificationStatus}` : ''}
                </p>
                <h2 className="text-lg font-bold text-white font-display mt-0.5">
                  Current Stage: <span className="text-indigo-300">{evaluated.normalizedStatus}</span>
                </h2>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-300 font-mono-num">
                <span>
                  Eligibility:{' '}
                  <strong
                    className={
                      evaluated.eligibilityStatus === 'Eligible'
                        ? 'text-emerald-300'
                        : evaluated.eligibilityStatus === 'Not Eligible'
                          ? 'text-rose-300'
                          : 'text-amber-300'
                    }
                  >
                    {evaluated.eligibilityStatus}
                  </strong>
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  Preparation: <strong className="text-white">{evaluated.preparationStatus}</strong>
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  Checklist:{' '}
                  <strong className="text-white">
                    {evaluated.checklist.readyCount}/{evaluated.checklist.totalRequired} ready
                  </strong>
                </span>
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-[#070C1B]/80 border border-slate-800 text-xs text-slate-300 flex flex-wrap items-center justify-between gap-3">
              <div>
                <span className="font-semibold text-white">Recommended Next Step: </span>
                <span>{evaluated.nextRecommendedAction}</span>
              </div>
              {evaluated.nextRecommendedRoute !== `/applications/${application.id}` && (
                <Link
                  to={evaluated.nextRecommendedRoute}
                  className="font-semibold text-indigo-300 hover:text-indigo-200 hover:underline whitespace-nowrap shrink-0"
                >
                  Go to Action →
                </Link>
              )}
            </div>
          </div>

          {/* Main 12-Col Layout */}
          <div className="grid lg:grid-cols-12 gap-6">
            {/* Left 7 Columns: Workflow Transitions, Document Checklist, Editable Fields */}
            <div className="lg:col-span-7 space-y-6">
              {/* 1. Workflow Stage Transitions */}
              <section className="surface-card p-6 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <ClipboardCheck className="w-4 h-4 text-indigo-400" />
                    <h3 className="text-base font-semibold text-white font-display">
                      Application Lifecycle Controls
                    </h3>
                  </div>
                  <span className="text-xs text-slate-400 font-mono-num">
                    Updated {formatDateTimeIst(application.updatedAt)}
                  </span>
                </div>

                <div className="text-xs text-slate-300 grid sm:grid-cols-2 gap-3 bg-[#070C1B]/80 border border-slate-800 rounded-xl p-3.5">
                  <div>
                    <span className="text-slate-400 block">Submission Attestation</span>
                    <strong className="text-white">
                      {application.submissionConfirmedByStudent
                        ? `Confirmed by Student (${application.submissionDate || application.submissionConfirmedAt?.slice(0, 10)})`
                        : 'Not Submitted'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-400 block">External Portal Visit</span>
                    <strong className="text-white font-mono-num">
                      {application.portalOpenedAt ? formatDateTimeIst(application.portalOpenedAt) : 'Not recorded yet'}
                    </strong>
                  </div>
                </div>

                {evaluated.allowedNextStatuses.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    This application is in terminal stage &ldquo;{evaluated.normalizedStatus}&rdquo;. History and events remain preserved for audit.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    <p className="text-xs font-medium text-slate-300">
                      Valid Next Workflow Stages from &ldquo;{evaluated.normalizedStatus}&rdquo;:
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {evaluated.allowedNextStatuses.map((nextSt) => (
                        <button
                          key={nextSt}
                          type="button"
                          disabled={busy}
                          onClick={() => startTransitionFlow(nextSt)}
                          className={`px-3.5 py-2 text-xs font-semibold rounded-xl border transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 ${
                            nextSt === 'Submitted' || nextSt === 'Approved'
                              ? 'btn-primary-gradient border-transparent'
                              : nextSt === 'Correction Required' || nextSt === 'Rejected'
                                ? 'bg-amber-500/15 text-amber-200 border-amber-500/30 hover:bg-amber-500/25'
                                : 'bg-[#101933] text-slate-200 border-slate-700/80 hover:bg-slate-800'
                          }`}
                        >
                          Move to {nextSt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Explicit Confirmation Box for Sensitive Transitions */}
                {pendingTransition && (
                  <div className="p-4 rounded-xl bg-[#070C1B]/90 border border-indigo-500/35 space-y-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-white">
                        Confirm Transition to &ldquo;{pendingTransition}&rdquo;
                      </h4>
                      <button
                        type="button"
                        onClick={() => setPendingTransition(null)}
                        className="text-slate-400 hover:text-white"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {pendingTransition === 'Submitted' && (
                      <div className="space-y-3 text-xs">
                        <p className="text-slate-300 leading-relaxed">
                          GRANTLY AI does not auto-submit applications to government portals. Confirm below only after you have submitted your application on the official portal.
                        </p>
                        <label className="flex items-start gap-2.5 cursor-pointer font-medium text-white">
                          <input
                            type="checkbox"
                            checked={submissionConfirmedCheck}
                            onChange={(e) => setSubmissionConfirmedCheck(e.target.checked)}
                            className="mt-0.5 rounded border-slate-700 bg-[#0B1224] text-indigo-500"
                          />
                          <span>
                            I confirm that I submitted this scholarship application directly on the official external portal.
                          </span>
                        </label>
                        <div className="grid sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-slate-400 mb-1">Submission Date</label>
                            <input
                              type="date"
                              value={submissionDateDraft}
                              onChange={(e) => setSubmissionDateDraft(e.target.value)}
                              className="input-midnight w-full px-3 py-1.5 font-mono-num"
                            />
                          </div>
                          <div>
                            <label className="block text-slate-400 mb-1">
                              Portal Acknowledgement / Reference ID
                            </label>
                            <input
                              type="text"
                              value={modalRefId}
                              onChange={(e) => setModalRefId(e.target.value)}
                              placeholder="e.g. NSP2026-102948"
                              className="input-midnight w-full px-3 py-1.5 font-mono-num"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {pendingTransition === 'Correction Required' && (
                      <div className="space-y-1.5 text-xs">
                        <label className="block text-slate-300 font-medium">
                          Correction Details Requested by Portal / Nodal Officer
                        </label>
                        <textarea
                          rows={2}
                          value={modalCorrectionNote}
                          onChange={(e) => setModalCorrectionNote(e.target.value)}
                          placeholder="e.g. Re-upload current financial year income certificate signed by Tehsildar..."
                          className="input-midnight w-full px-3 py-2"
                        />
                      </div>
                    )}

                    {(pendingTransition === 'Approved' || pendingTransition === 'Rejected') && (
                      <div className="space-y-1.5 text-xs">
                        <label className="block text-slate-300 font-medium">
                          Official Outcome Note (Optional)
                        </label>
                        <input
                          type="text"
                          value={modalOutcomeNote}
                          onChange={(e) => setModalOutcomeNote(e.target.value)}
                          placeholder={
                            pendingTransition === 'Approved'
                              ? 'e.g. Merit list confirmed, DBT disbursement awaited'
                              : 'e.g. Institutional verification rejected due to income limit'
                          }
                          className="input-midnight w-full px-3 py-2"
                        />
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setPendingTransition(null)}
                        className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#101933] border border-slate-700/80 rounded-xl hover:bg-slate-800"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={
                          busy || (pendingTransition === 'Submitted' && !submissionConfirmedCheck)
                        }
                        onClick={() =>
                          void executeTransition(pendingTransition, {
                            submissionConfirmed:
                              pendingTransition === 'Submitted' ? submissionConfirmedCheck : undefined,
                            submissionDate:
                              pendingTransition === 'Submitted' ? submissionDateDraft : undefined,
                            portalReferenceId:
                              pendingTransition === 'Submitted' ? modalRefId : undefined,
                            correctionNotes:
                              pendingTransition === 'Correction Required'
                                ? modalCorrectionNote
                                : undefined,
                            finalOutcome:
                              pendingTransition === 'Approved' || pendingTransition === 'Rejected'
                                ? modalOutcomeNote
                                : undefined,
                          })
                        }
                        className="btn-primary-gradient px-4 py-2 text-xs font-semibold rounded-xl disabled:opacity-50"
                      >
                        {busy ? 'Saving...' : `Confirm ${pendingTransition}`}
                      </button>
                    </div>
                  </div>
                )}
              </section>

              {/* 2. Scholarship-Specific Document Checklist */}
              <section className="surface-card p-6 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-indigo-400" />
                    <h3 className="text-base font-semibold text-white font-display">
                      Scholarship-Specific Document Checklist
                    </h3>
                  </div>
                  <span className="text-xs font-mono-num text-slate-400">
                    {evaluated.checklist.readyCount} Ready · {evaluated.checklist.warningCount} Warnings ·{' '}
                    {evaluated.checklist.missingCount} Missing
                  </span>
                </div>

                {evaluated.checklist.disclosureNotice && (
                  <p className="text-xs text-slate-300 bg-[#070C1B]/80 border border-slate-800 rounded-xl p-3.5">
                    {evaluated.checklist.disclosureNotice}
                  </p>
                )}

                {evaluated.checklist.hasPublishedChecklist && (
                  <div className="divide-y divide-slate-800/80">
                    {evaluated.checklist.items.map((item) => (
                      <div key={item.requirementName} className="py-3.5 first:pt-1 last:pb-1 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <label
                            className={`flex items-start gap-2.5 text-sm font-medium ${
                              item.canMarkStudentComplete
                                ? 'text-white cursor-pointer'
                                : 'text-slate-500 cursor-not-allowed'
                            }`}
                          >
                            <input
                              type="checkbox"
                              disabled={!item.canMarkStudentComplete}
                              checked={item.studentMarkedComplete}
                              onChange={() =>
                                void handleToggleChecklistItem(
                                  item.requirementName,
                                  item.canMarkStudentComplete,
                                  item.studentMarkedComplete,
                                  item.linkedDocument?.id
                                )
                              }
                              className="mt-1 rounded border-slate-700 bg-[#0B1224] text-indigo-500 disabled:opacity-40"
                            />
                            <div>
                              <span>{item.requirementName}</span>
                              <p className="text-xs font-normal text-slate-400 mt-0.5">
                                {item.linkedDocument
                                  ? `Uploaded: ${item.linkedDocument.fileName} (${item.extractionStatus})`
                                  : 'No matching uploaded document found'}
                              </p>
                            </div>
                          </label>

                          <span
                            className={`text-xs font-semibold shrink-0 ${
                              item.checklistStatus === 'Verified Ready'
                                ? 'text-emerald-300'
                                : item.checklistStatus === 'Missing' ||
                                    item.checklistStatus === 'Failed — Re-upload'
                                  ? 'text-rose-300'
                                  : 'text-amber-300'
                            }`}
                          >
                            {item.checklistStatus}
                          </span>
                        </div>

                        <div className="pl-6 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                          <span>{item.recommendedAction}</span>
                          <Link
                            to={item.recommendedRoute}
                            className="font-semibold text-indigo-300 hover:text-indigo-200 hover:underline whitespace-nowrap shrink-0"
                          >
                            {item.recommendedRoute === '/trustguard' ? 'Inspect TrustGuard' : 'Open Documents'} →
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* 3. Editable Notes, Reference ID & Deadline */}
              <section className="surface-card p-6 space-y-4">
                <h3 className="text-base font-semibold text-white font-display">
                  Application Details &amp; Notes
                </h3>
                <form onSubmit={handleSaveDetails} className="space-y-4">
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1.5">
                        Portal Application / Reference ID
                      </label>
                      <input
                        type="text"
                        value={refIdDraft}
                        onChange={(e) => setRefIdDraft(e.target.value)}
                        placeholder="e.g. NSP2026XXXX"
                        className="input-midnight w-full px-3.5 py-2 text-sm font-mono-num"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1.5">
                        Personal / Target Deadline (YYYY-MM-DD)
                      </label>
                      <input
                        type="text"
                        value={deadlineDraft}
                        onChange={(e) => setDeadlineDraft(e.target.value)}
                        placeholder="e.g. 2026-10-31"
                        className="input-midnight w-full px-3.5 py-2 text-sm font-mono-num"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Preparation &amp; Nodal Officer Notes
                    </label>
                    <textarea
                      rows={3}
                      value={notesDraft}
                      onChange={(e) => setNotesDraft(e.target.value)}
                      placeholder="Record institute biometric verification, bonafide sign-off, or portal checkpoints..."
                      className="input-midnight w-full px-3.5 py-2 text-sm"
                    />
                  </div>

                  {evaluated.normalizedStatus === 'Correction Required' && (
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1.5">
                        Correction Notes
                      </label>
                      <input
                        type="text"
                        value={correctionDraft}
                        onChange={(e) => setCorrectionDraft(e.target.value)}
                        className="input-midnight w-full px-3.5 py-2 text-sm"
                      />
                    </div>
                  )}

                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={busy}
                      className="btn-primary-gradient inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl disabled:opacity-50"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>{busy ? 'Saving...' : 'Save Application Details'}</span>
                    </button>
                  </div>
                </form>
              </section>
            </div>

            {/* Right 5 Columns: Deadline Intelligence, Eligibility, TrustGuard, Timeline */}
            <div className="lg:col-span-5 space-y-6">
              {/* 1. Deadline Intelligence */}
              <section className="surface-card p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CalendarClock className="w-4 h-4 text-amber-400" />
                    <h3 className="text-sm font-semibold text-white font-display">
                      Deadline Intelligence (IST)
                    </h3>
                  </div>
                  <span
                    className={`text-xs font-semibold ${
                      evaluated.deadline.isExpired
                        ? 'text-rose-300'
                        : evaluated.deadline.isApproaching
                          ? 'text-amber-300'
                          : evaluated.deadline.isVerifiedDate
                            ? 'text-emerald-300'
                            : 'text-slate-400'
                    }`}
                  >
                    {evaluated.deadline.state}
                  </span>
                </div>
                <p className="text-base font-bold text-white font-mono-num">
                  {evaluated.deadline.displayLabel}
                </p>
                <p className="text-xs text-slate-400 leading-relaxed">{evaluated.deadline.detail}</p>
              </section>

              {/* 2. Deterministic Eligibility vs Application Preparation */}
              <section className="surface-card p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    <h3 className="text-sm font-semibold text-white font-display">
                      Eligibility &amp; Preparation
                    </h3>
                  </div>
                  {linkedScholarship && (
                    <Link
                      to={`/eligibility?scholarshipId=${linkedScholarship.id}`}
                      className="text-xs font-semibold text-indigo-300 hover:text-indigo-200 hover:underline"
                    >
                      Full Audit
                    </Link>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="p-3.5 rounded-xl bg-[#070C1B]/80 border border-slate-800">
                    <span className="text-slate-400 block">Deterministic Eligibility</span>
                    <strong className="text-white mt-0.5 block">
                      {evaluated.eligibilityStatus}
                      {evaluated.eligibilityScore !== null ? ` (${evaluated.eligibilityScore}%)` : ''}
                    </strong>
                  </div>
                  <div className="p-3.5 rounded-xl bg-[#070C1B]/80 border border-slate-800">
                    <span className="text-slate-400 block">Application Preparation</span>
                    <strong className="text-white mt-0.5 block">
                      {evaluated.preparationStatus}
                    </strong>
                  </div>
                </div>

                {evaluated.attentionReasons.length > 0 && (
                  <div className="space-y-1 text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3.5">
                    <p className="font-semibold text-amber-100">Attention Reasons:</p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {evaluated.attentionReasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>

              {/* 3. TrustGuard Findings for This Application */}
              <section className="surface-card p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-amber-400" />
                    <h3 className="text-sm font-semibold text-white font-display">
                      TrustGuard Verification Warnings
                    </h3>
                  </div>
                  <Link
                    to="/trustguard"
                    className="text-xs font-semibold text-indigo-300 hover:text-indigo-200 hover:underline"
                  >
                    Open TrustGuard
                  </Link>
                </div>

                {evaluated.trustGuardFindingsForApp.length === 0 ? (
                  <p className="text-xs text-slate-300 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>No document consistency conflicts flagged for this application.</span>
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {evaluated.trustGuardFindingsForApp.slice(0, 5).map((f) => (
                      <div
                        key={f.findingId}
                        className="p-3.5 rounded-xl bg-[#070C1B]/80 border border-slate-800 text-xs space-y-1"
                      >
                        <div className="flex items-center justify-between gap-2 font-semibold">
                          <span className="text-white">{f.title}</span>
                          <span
                            className={
                              f.severity === 'Critical' || f.severity === 'High'
                                ? 'text-rose-300 shrink-0'
                                : 'text-amber-300 shrink-0'
                            }
                          >
                            {f.severity}
                          </span>
                        </div>
                        <p className="text-slate-400">{f.recommendedAction}</p>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* 4. Chronological Application Timeline */}
              <section className="surface-card p-6 space-y-4">
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-slate-400" />
                  <h3 className="text-sm font-semibold text-white font-display">
                    Application Audit Timeline
                  </h3>
                </div>

                {events.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    No timeline events recorded yet. Status updates, portal visits, and checklist actions appear here automatically.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-800/80">
                    {events.map((evt) => (
                      <div key={evt.id} className="py-2.5 first:pt-0 last:pb-0 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-white">{evt.eventType}</span>
                          <span className="text-[11px] text-slate-400 font-mono-num shrink-0 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatDateTimeIst(evt.createdAt)}
                          </span>
                        </div>
                        <p className="text-slate-400">{evt.description}</p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      </PageTransition>

      {/* External Portal Disclosure Modal (Never auto-marks Submitted) */}
      {showPortalModal && officialUrl && (
        <div className="fixed inset-0 z-50 bg-[#02050D]/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="surface-elevated max-w-lg w-full p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Info className="w-5 h-5 text-indigo-400 shrink-0" />
                <h3 className="text-base font-semibold text-white font-display">
                  Proceed to Official Scholarship Portal
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowPortalModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
              {EXTERNAL_PORTAL_NOTICE}
            </p>

            <div className="p-3.5 rounded-xl bg-[#070C1B] border border-slate-800 text-xs text-slate-300 break-all font-mono-num">
              Official URL: {officialUrl}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowPortalModal(false)}
                className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#101933] border border-slate-700/80 rounded-xl hover:bg-slate-800"
              >
                Stay in GRANTLY AI
              </button>
              <a
                href={officialUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  void handleLogPortalOpen();
                  setShowPortalModal(false);
                }}
                className="btn-primary-gradient inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl"
              >
                <span>Open Official Portal Link</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
