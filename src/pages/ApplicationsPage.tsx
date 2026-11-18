import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CalendarClock,
  Check,
  CheckCircle2,
  ExternalLink,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { AppShell } from '../components/AppShell.tsx';
import {
  AnimatedCounter,
  PageTransition,
  SkeletonCard,
  StaggerGrid,
  StaggerItem,
} from '../components/ui/MotionPrimitives.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { postProtectedAi } from '../lib/apiClient.ts';
import {
  ACTIVE_PHASE8_STATUSES,
  computeTrackerOverviewCounts,
  evaluateDeadlineIntelligence,
  evaluateTrackedApplication,
  findDuplicateActiveApplication,
  getDeadlineTimestampForSort,
  PHASE8_APPLICATION_STATUSES,
  type EvaluatedTrackedApplication,
} from '../lib/applicationTrackerEngine.ts';
import { evaluateDeterministicEligibility } from '../lib/eligibilityEngine.ts';
import {
  deleteApplication,
  getApplicationChecklistItems,
  getApplications,
  getDocumentAnalyses,
  getDocuments,
  getNotificationPreferences,
  getNotifications,
  getProfile,
  getScholarships,
  getTrustGuardAssessments,
  markAllNotificationsRead,
  markNotificationRead,
  saveNotificationPreferences,
} from '../lib/firestoreRepo.ts';
import type {
  ApplicationChecklistItemRecord,
  ApplicationRecord,
  DocumentAnalysis,
  DocumentRecord,
  NotificationPreferenceRecord,
  NotificationRecord,
  Phase8ApplicationStatus,
  Scholarship,
  StudentProfile,
  TrustGuardDocumentAssessment,
} from '../types/database.ts';
import { peekPublicCache, peekUserCache, setUserCache } from '../lib/workspaceCache.ts';

type TrackerViewTab = 'All' | 'Active' | 'Submitted' | 'Completed' | 'Requiring Attention';
type DeadlineFilterOption =
  | 'All'
  | 'Approaching'
  | 'Verified Upcoming'
  | 'Expired / Closed'
  | 'Not Verified / Unavailable';

const VIEW_TABS: TrackerViewTab[] = [
  'All',
  'Active',
  'Submitted',
  'Completed',
  'Requiring Attention',
];

export default function ApplicationsPage() {
  const { user, profile: authProfile, getIdToken } = useAuth();
  const navigate = useNavigate();

  const cachedApps = peekUserCache<ApplicationRecord[]>(user?.uid, 'applications');
  const cachedSch = peekPublicCache<{ items: Scholarship[]; isEmptyDatabase: boolean }>('scholarships');
  const cachedProfile = peekUserCache<StudentProfile | null>(user?.uid, 'profile');
  const cachedDocs = peekUserCache<DocumentRecord[]>(user?.uid, 'documents');
  const cachedAnalyses = peekUserCache<DocumentAnalysis[]>(user?.uid, 'document_analysis');
  const cachedTg = peekUserCache<TrustGuardDocumentAssessment[]>(user?.uid, 'trustguard_assessments');
  const cachedChk = peekUserCache<ApplicationChecklistItemRecord[]>(
    user?.uid,
    'application_checklist_items'
  );
  const cachedNotifs = peekUserCache<NotificationRecord[]>(user?.uid, 'notifications');
  const cachedPrefs = peekUserCache<NotificationPreferenceRecord | null>(
    user?.uid,
    'notification_preferences'
  );

  const hasWarmCache = Boolean(
    cachedApps && cachedSch && cachedDocs && cachedAnalyses && cachedChk && cachedNotifs
  );

  const [applications, setApplications] = useState<ApplicationRecord[]>(() => cachedApps ?? []);
  const [scholarships, setScholarships] = useState<Scholarship[]>(() => cachedSch?.items ?? []);
  const [profile, setProfile] = useState<StudentProfile | null>(
    () => cachedProfile ?? authProfile
  );
  const [documents, setDocuments] = useState<DocumentRecord[]>(() => cachedDocs ?? []);
  const [analyses, setAnalyses] = useState<DocumentAnalysis[]>(() => cachedAnalyses ?? []);
  const [tgAssessment, setTgAssessment] = useState<TrustGuardDocumentAssessment | null>(
    () => cachedTg?.[0] ?? null
  );
  const [checklistItems, setChecklistItems] = useState<ApplicationChecklistItemRecord[]>(
    () => cachedChk ?? []
  );
  const [notifications, setNotifications] = useState<NotificationRecord[]>(() => cachedNotifs ?? []);
  const [preferences, setPreferences] = useState<NotificationPreferenceRecord | null>(
    () => cachedPrefs ?? null
  );

  const [selectedScholarshipId, setSelectedScholarshipId] = useState(() => {
    const list = cachedSch?.items ?? [];
    const first = list.find((s) => s.verificationStatus !== 'Archived') ?? list[0];
    return first?.id ?? '';
  });
  const [loading, setLoading] = useState(!hasWarmCache);
  const [adding, setAdding] = useState(false);
  const [syncingNotifs, setSyncingNotifs] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showNotifPanel, setShowNotifPanel] = useState(false);

  // View tabs & filters
  const [activeTab, setActiveTab] = useState<TrackerViewTab>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'All' | Phase8ApplicationStatus>('All');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [deadlineFilter, setDeadlineFilter] = useState<DeadlineFilterOption>('All');
  const [eligibilityFilter, setEligibilityFilter] = useState('All');
  const [sortBy, setSortBy] = useState<'attention' | 'deadline' | 'updated'>('attention');

  const loadAll = useCallback(
    async (showSkeleton = false) => {
      if (!user) return;
      if (showSkeleton) {
        setLoading(true);
      }
      setError(null);
      try {
        const [apps, sch, prof, docs, ana, tgList, chkList, notifs, prefs] = await Promise.all([
          getApplications(user.uid),
          getScholarships(),
          getProfile(user.uid),
          getDocuments(user.uid),
          getDocumentAnalyses(user.uid),
          getTrustGuardAssessments(user.uid),
          getApplicationChecklistItems(user.uid),
          getNotifications(user.uid),
          getNotificationPreferences(user.uid),
        ]);

        setApplications(apps);
        setScholarships(sch.items);
        setProfile(prof ?? authProfile);
        setDocuments(docs);
        setAnalyses(ana);
        setTgAssessment(tgList[0] ?? null);
        setChecklistItems(chkList);
        setNotifications(notifs);
        setPreferences(
          prefs ?? {
            uid: user.uid,
            deadlineRemindersEnabled: true,
            missingDocsAlertsEnabled: true,
            statusChangeAlertsEnabled: true,
            emailDigestRequested: false,
            emailDeliveryStatus: 'Not Configured (Requires SMTP/Email Provider)',
            updatedAt: new Date().toISOString(),
          }
        );

        const firstTrackable =
          sch.items.find((s) => s.verificationStatus !== 'Archived') ?? sch.items[0];
        if (firstTrackable && !selectedScholarshipId) {
          setSelectedScholarshipId(firstTrackable.id);
        }

        const alreadySyncedRecently = peekUserCache<boolean>(user.uid, 'apps_notif_synced');
        if (apps.length > 0 && !alreadySyncedRecently) {
          try {
            setUserCache(user.uid, 'apps_notif_synced', true, 60_000);
            const token = await getIdToken();
            const syncRes = await postProtectedAi<{
              createdNotifications: NotificationRecord[];
            }>('/api/applications/sync-notifications', token, {});
            if (syncRes.createdNotifications.length > 0) {
              setNotifications((prev) =>
                [...syncRes.createdNotifications, ...prev].sort((a, b) =>
                  b.createdAt.localeCompare(a.createdAt)
                )
              );
            }
          } catch {
            // Non-blocking sync
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to load application tracker data.');
      } finally {
        setLoading(false);
      }
    },
    [user, authProfile, getIdToken, selectedScholarshipId]
  );

  useEffect(() => {
    void loadAll(false);
  }, [loadAll]);

  const scholarshipMap = useMemo(
    () => new Map(scholarships.map((s) => [s.id, s])),
    [scholarships]
  );

  const trackableScholarships = useMemo(
    () => scholarships.filter((s) => s.verificationStatus !== 'Archived'),
    [scholarships]
  );

  const evaluatedApps = useMemo<EvaluatedTrackedApplication[]>(() => {
    return applications.map((app) =>
      evaluateTrackedApplication({
        application: app,
        scholarship: scholarshipMap.get(app.scholarshipId) ?? null,
        profile,
        documents,
        documentAnalyses: analyses,
        trustGuardAssessment: tgAssessment,
        savedChecklistItems: checklistItems,
      })
    );
  }, [applications, scholarshipMap, profile, documents, analyses, tgAssessment, checklistItems]);

  const overviewCounts = useMemo(
    () => computeTrackerOverviewCounts(evaluatedApps),
    [evaluatedApps]
  );

  const selectedScholarship = useMemo(
    () => scholarships.find((s) => s.id === selectedScholarshipId) ?? null,
    [scholarships, selectedScholarshipId]
  );

  const selectedDuplicateActive = useMemo(
    () =>
      selectedScholarshipId
        ? findDuplicateActiveApplication(applications, selectedScholarshipId)
        : null,
    [applications, selectedScholarshipId]
  );

  const selectedScholarshipPreview = useMemo(() => {
    if (!selectedScholarship) return null;
    const elig = evaluateDeterministicEligibility(profile, selectedScholarship);
    const deadline = evaluateDeadlineIntelligence(selectedScholarship);
    return { elig, deadline };
  }, [selectedScholarship, profile]);

  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    evaluatedApps.forEach((ev) => {
      if (ev.scholarship?.scholarshipType) set.add(ev.scholarship.scholarshipType);
    });
    return ['All', ...Array.from(set)];
  }, [evaluatedApps]);

  const filteredApps = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = evaluatedApps.filter((ev) => {
      const st = ev.normalizedStatus;
      if (activeTab === 'Active') {
        if (!ACTIVE_PHASE8_STATUSES.has(st) || st === 'Submitted' || st === 'Under Review') {
          return false;
        }
      } else if (activeTab === 'Submitted') {
        if (st !== 'Submitted' && st !== 'Under Review') return false;
      } else if (activeTab === 'Completed') {
        if (st !== 'Approved' && st !== 'Rejected' && st !== 'Withdrawn' && st !== 'Closed') {
          return false;
        }
      } else if (activeTab === 'Requiring Attention') {
        if (!ev.needsAttention) return false;
      }

      if (statusFilter !== 'All' && st !== statusFilter) return false;
      if (categoryFilter !== 'All' && ev.scholarship?.scholarshipType !== categoryFilter) {
        return false;
      }
      if (eligibilityFilter !== 'All' && ev.eligibilityStatus !== eligibilityFilter) {
        return false;
      }

      if (deadlineFilter !== 'All') {
        if (deadlineFilter === 'Approaching' && !ev.deadline.isApproaching) return false;
        if (deadlineFilter === 'Verified Upcoming' && ev.deadline.state !== 'Verified Upcoming') {
          return false;
        }
        if (
          deadlineFilter === 'Expired / Closed' &&
          ev.deadline.state !== 'Expired' &&
          ev.deadline.state !== 'Closed'
        ) {
          return false;
        }
        if (
          deadlineFilter === 'Not Verified / Unavailable' &&
          ev.deadline.state !== 'Not Verified' &&
          ev.deadline.state !== 'Unavailable'
        ) {
          return false;
        }
      }

      if (q) {
        const hay = `${ev.application.scholarshipTitle} ${ev.scholarship?.provider || ev.application.provider || ''} ${ev.application.portalReferenceId || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });

    filtered.sort((a, b) => {
      if (sortBy === 'attention') {
        if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
        return getDeadlineTimestampForSort(a.deadline) - getDeadlineTimestampForSort(b.deadline);
      }
      if (sortBy === 'deadline') {
        return getDeadlineTimestampForSort(a.deadline) - getDeadlineTimestampForSort(b.deadline);
      }
      return b.application.updatedAt.localeCompare(a.application.updatedAt);
    });

    return filtered;
  }, [
    evaluatedApps,
    activeTab,
    searchQuery,
    statusFilter,
    categoryFilter,
    deadlineFilter,
    eligibilityFilter,
    sortBy,
  ]);

  const unreadNotifCount = useMemo(
    () => notifications.filter((n) => !n.isRead).length,
    [notifications]
  );

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !selectedScholarshipId) return;
    if (selectedDuplicateActive) {
      navigate(`/applications/${selectedDuplicateActive.id}`);
      return;
    }

    setAdding(true);
    setError(null);
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{
        application: ApplicationRecord;
      }>('/api/applications', token, {
        scholarshipId: selectedScholarshipId,
        initialStatus: 'Interested',
      });
      setApplications((prev) => [res.application, ...prev]);
      navigate(`/applications/${res.application.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start tracking this scholarship.');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteApplication(id);
      setApplications((prev) => prev.filter((item) => item.id !== id));
      setConfirmDeleteId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove application.');
    }
  };

  const handleSyncNotifications = async () => {
    if (!user) return;
    setSyncingNotifs(true);
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{
        createdNotifications: NotificationRecord[];
      }>('/api/applications/sync-notifications', token, {});
      if (res.createdNotifications.length > 0) {
        setNotifications((prev) =>
          [...res.createdNotifications, ...prev].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt)
          )
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh reminders.');
    } finally {
      setSyncingNotifs(false);
    }
  };

  const handleMarkNotifRead = async (notifId: string) => {
    await markNotificationRead(notifId);
    setNotifications((prev) => prev.map((n) => (n.id === notifId ? { ...n, isRead: true } : n)));
  };

  const handleMarkAllRead = async () => {
    const unreadIds = notifications.filter((n) => !n.isRead).map((n) => n.id);
    if (unreadIds.length === 0) return;
    await markAllNotificationsRead(unreadIds);
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
  };

  const handleTogglePref = async (
    key:
      | 'deadlineRemindersEnabled'
      | 'missingDocsAlertsEnabled'
      | 'statusChangeAlertsEnabled'
      | 'emailDigestRequested'
  ) => {
    if (!preferences || !user) return;
    setSavingPrefs(true);
    const updated: NotificationPreferenceRecord = {
      ...preferences,
      [key]: !preferences[key],
      emailDeliveryStatus: 'Not Configured (Requires SMTP/Email Provider)',
      updatedAt: new Date().toISOString(),
    };
    try {
      await saveNotificationPreferences(updated);
      setPreferences(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save notification preferences.');
    } finally {
      setSavingPrefs(false);
    }
  };

  return (
    <AppShell
      title="Application Tracker"
      breadcrumb="Workspace / Application Tracker & Smart Workflow"
      primaryAction={
        <button
          type="button"
          onClick={() => setShowNotifPanel((v) => !v)}
          className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-200 bg-[#101933] border border-slate-700/80 hover:bg-slate-800 rounded-xl whitespace-nowrap shrink-0"
        >
          <Bell className="w-4 h-4 text-indigo-300" />
          <span>Reminders ({unreadNotifCount} unread)</span>
        </button>
      }
    >
      <PageTransition>
        <div className="space-y-6">
          {error && (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-sm text-rose-200 flex flex-wrap items-center justify-between gap-3">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => void loadAll(true)}
                className="px-3 py-1.5 text-xs font-semibold text-rose-100 bg-rose-500/25 hover:bg-rose-500/35 border border-rose-400/30 rounded-lg whitespace-nowrap"
              >
                Retry
              </button>
            </div>
          )}

          {/* Overview KPI Strip */}
          <StaggerGrid className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            {[
              { label: 'Total Tracked', val: overviewCounts.total, tone: 'text-white' },
              { label: 'Being Prepared', val: overviewCounts.beingPrepared, tone: 'text-indigo-300' },
              { label: 'Submitted', val: overviewCounts.submitted, tone: 'text-emerald-300' },
              { label: 'Under Review', val: overviewCounts.underReview, tone: 'text-violet-300' },
              { label: 'Approved', val: overviewCounts.approved, tone: 'text-emerald-400' },
              { label: 'Rejected', val: overviewCounts.rejected, tone: 'text-rose-300' },
              { label: 'Requiring Action', val: overviewCounts.requiringAction, tone: 'text-amber-300' },
            ].map((kpi) => (
              <StaggerItem key={kpi.label}>
                <div className="surface-card p-4">
                  <p className="text-[11px] font-medium text-slate-400 truncate">{kpi.label}</p>
                  <p className={`text-xl font-bold font-mono-num mt-1 ${kpi.tone}`}>
                    {loading ? '—' : <AnimatedCounter value={kpi.val} />}
                  </p>
                </div>
              </StaggerItem>
            ))}
          </StaggerGrid>

          {/* Notifications & Delivery Preferences Panel */}
          <AnimatePresence>
            {showNotifPanel && (
              <motion.section
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="surface-card p-6 space-y-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-white font-display">
                      In-App Application Alerts &amp; Reminder Preferences
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Triggered from real deadline states, missing checklist documents, Correction Required status, and TrustGuard conflicts.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={syncingNotifs}
                      onClick={() => void handleSyncNotifications()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#101933] border border-slate-700/80 hover:bg-slate-800 rounded-xl disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${syncingNotifs ? 'animate-spin' : ''}`} />
                      <span>{syncingNotifs ? 'Checking...' : 'Check Deadlines & Docs'}</span>
                    </button>
                    {unreadNotifCount > 0 && (
                      <button
                        type="button"
                        onClick={() => void handleMarkAllRead()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-200 bg-indigo-500/15 border border-indigo-500/30 hover:bg-indigo-500/25 rounded-xl"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Mark All Read</span>
                      </button>
                    )}
                  </div>
                </div>

                {preferences && (
                  <div className="p-4 rounded-xl bg-[#070C1B]/80 border border-slate-800 space-y-3">
                    <div className="flex flex-wrap gap-5 text-xs">
                      <label className="inline-flex items-center gap-2 cursor-pointer text-slate-200">
                        <input
                          type="checkbox"
                          disabled={savingPrefs}
                          checked={preferences.deadlineRemindersEnabled}
                          onChange={() => void handleTogglePref('deadlineRemindersEnabled')}
                          className="rounded border-slate-700 bg-[#0B1224] text-indigo-500"
                        />
                        <span>Deadline Reminders (In-App)</span>
                      </label>
                      <label className="inline-flex items-center gap-2 cursor-pointer text-slate-200">
                        <input
                          type="checkbox"
                          disabled={savingPrefs}
                          checked={preferences.missingDocsAlertsEnabled}
                          onChange={() => void handleTogglePref('missingDocsAlertsEnabled')}
                          className="rounded border-slate-700 bg-[#0B1224] text-indigo-500"
                        />
                        <span>Missing Document &amp; TrustGuard Alerts (In-App)</span>
                      </label>
                      <label className="inline-flex items-center gap-2 cursor-pointer text-slate-200">
                        <input
                          type="checkbox"
                          disabled={savingPrefs}
                          checked={preferences.statusChangeAlertsEnabled}
                          onChange={() => void handleTogglePref('statusChangeAlertsEnabled')}
                          className="rounded border-slate-700 bg-[#0B1224] text-indigo-500"
                        />
                        <span>Correction &amp; Status Alerts (In-App)</span>
                      </label>
                      <label className="inline-flex items-center gap-2 cursor-pointer text-slate-400">
                        <input
                          type="checkbox"
                          disabled={savingPrefs}
                          checked={preferences.emailDigestRequested}
                          onChange={() => void handleTogglePref('emailDigestRequested')}
                          className="rounded border-slate-700 bg-[#0B1224] text-indigo-500"
                        />
                        <span>Email Reminders Preference</span>
                      </label>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Delivery Status: <strong className="text-white">In-App Active</strong> · External Email / Scheduled Push:{' '}
                      <strong className="text-amber-300">{preferences.emailDeliveryStatus}</strong> (Requires SMTP/email provider and background scheduler).
                    </p>
                  </div>
                )}

                {notifications.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    No active application alerts right now. Alerts appear here automatically when a tracked deadline approaches or a required document is missing.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-800/80 max-h-64 overflow-y-auto">
                    {notifications.slice(0, 12).map((n) => (
                      <div
                        key={n.id}
                        className={`py-3 flex flex-wrap items-start justify-between gap-3 text-xs ${
                          n.isRead ? 'opacity-60' : ''
                        }`}
                      >
                        <div className="space-y-0.5 min-w-0 flex-1">
                          <p className="font-semibold text-white">
                            {n.title}{' '}
                            <span className="font-normal text-slate-400">
                              · {n.category ?? 'Application'} · {n.deliveryStatus ?? 'Delivered In-App'}
                            </span>
                          </p>
                          <p className="text-slate-300">{n.message}</p>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          {n.actionRoute && (
                            <Link
                              to={n.actionRoute}
                              className="font-semibold text-indigo-300 hover:text-indigo-200 hover:underline"
                            >
                              Open
                            </Link>
                          )}
                          {!n.isRead && (
                            <button
                              type="button"
                              onClick={() => void handleMarkNotifRead(n.id)}
                              className="text-slate-400 hover:text-white font-medium"
                            >
                              Mark Read
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </motion.section>
            )}
          </AnimatePresence>

          {/* Add Scholarship to Tracker */}
          <form onSubmit={handleAdd} className="surface-card p-5 space-y-3">
            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
              <div className="flex-1">
                <label htmlFor="track-sch" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Track a Verified Scholarship Application
                </label>
                <select
                  id="track-sch"
                  value={selectedScholarshipId}
                  disabled={trackableScholarships.length === 0}
                  onChange={(e) => setSelectedScholarshipId(e.target.value)}
                  className="input-midnight w-full px-3.5 py-2.5 text-sm disabled:opacity-50"
                >
                  {trackableScholarships.length === 0 ? (
                    <option value="">No active scholarships published in database yet</option>
                  ) : (
                    trackableScholarships.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title} ({s.provider})
                      </option>
                    ))
                  )}
                </select>
              </div>
              <button
                type="submit"
                disabled={adding || !selectedScholarshipId}
                className="btn-primary-gradient inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {selectedDuplicateActive ? (
                  <>
                    <span>Open Active Tracker ({selectedDuplicateActive.status})</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4" />
                    <span>{adding ? 'Creating...' : 'Start Tracking'}</span>
                  </>
                )}
              </button>
            </div>

            {selectedScholarshipPreview && selectedScholarship && (
              <div className="text-xs text-slate-400 flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
                <span>
                  Eligibility:{' '}
                  <strong
                    className={
                      selectedScholarshipPreview.elig.overallStatus === 'Eligible'
                        ? 'text-emerald-300'
                        : selectedScholarshipPreview.elig.overallStatus === 'Not Eligible'
                          ? 'text-rose-300'
                          : 'text-amber-300'
                    }
                  >
                    {selectedScholarshipPreview.elig.overallStatus}
                  </strong>
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  Source:{' '}
                  <strong className="text-slate-200">{selectedScholarship.verificationStatus}</strong>
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono-num">
                  Deadline: {selectedScholarshipPreview.deadline.displayLabel}
                </span>
                {selectedDuplicateActive && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-indigo-300 font-semibold">
                      Active application already exists (duplicate prevention active)
                    </span>
                  </>
                )}
              </div>
            )}
          </form>

          {/* View Tabs & Multi-Facet Filters */}
          <div className="surface-card p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1 p-1 bg-[#070C1B] border border-slate-800 rounded-xl">
                {VIEW_TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                      activeTab === tab
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {tab}
                    {tab === 'Requiring Attention' && overviewCounts.requiringAction > 0
                      ? ` (${overviewCounts.requiringAction})`
                      : ''}
                  </button>
                ))}
              </div>

              <span className="text-xs text-slate-400 font-mono-num flex items-center gap-1.5">
                <SlidersHorizontal className="w-3.5 h-3.5 text-indigo-400" />
                <span>{filteredApps.length} shown</span>
              </span>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-6 gap-3">
              <div className="lg:col-span-2 relative">
                <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search title, provider, reference ID..."
                  className="input-midnight w-full pl-9 pr-3 py-2 text-xs sm:text-sm"
                />
              </div>

              <select
                aria-label="Filter by status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'All' | Phase8ApplicationStatus)}
                className="input-midnight px-3 py-2 text-xs sm:text-sm"
              >
                <option value="All">Status: All</option>
                {PHASE8_APPLICATION_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>

              <select
                aria-label="Filter by category"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="input-midnight px-3 py-2 text-xs sm:text-sm"
              >
                {availableCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat === 'All' ? 'Category: All' : cat}
                  </option>
                ))}
              </select>

              <select
                aria-label="Filter by deadline state"
                value={deadlineFilter}
                onChange={(e) => setDeadlineFilter(e.target.value as DeadlineFilterOption)}
                className="input-midnight px-3 py-2 text-xs sm:text-sm"
              >
                <option value="All">Deadline: All</option>
                <option value="Approaching">Approaching (&le;7d)</option>
                <option value="Verified Upcoming">Verified Upcoming</option>
                <option value="Expired / Closed">Expired / Closed</option>
                <option value="Not Verified / Unavailable">Unverified / Unavailable</option>
              </select>

              <div className="flex gap-2">
                <select
                  aria-label="Filter by eligibility"
                  value={eligibilityFilter}
                  onChange={(e) => setEligibilityFilter(e.target.value)}
                  className="input-midnight flex-1 min-w-0 px-3 py-2 text-xs sm:text-sm"
                >
                  <option value="All">Eligibility: All</option>
                  <option value="Eligible">Eligible</option>
                  <option value="Potentially Eligible">Potentially Eligible</option>
                  <option value="Not Eligible">Not Eligible</option>
                  <option value="Insufficient Information">Insufficient Info</option>
                </select>
                <select
                  aria-label="Sort applications"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as 'attention' | 'deadline' | 'updated')}
                  className="input-midnight px-2.5 py-2 text-xs"
                >
                  <option value="attention">Attention</option>
                  <option value="deadline">Deadline</option>
                  <option value="updated">Updated</option>
                </select>
              </div>
            </div>
          </div>

          {/* Applications List */}
          {loading ? (
            <div className="space-y-4">
              <SkeletonCard className="h-44" />
              <SkeletonCard className="h-44" />
            </div>
          ) : applications.length === 0 ? (
            <div className="surface-card p-10 text-center space-y-3">
              <p className="text-base font-semibold text-white">No scholarship applications tracked yet</p>
              <p className="text-xs sm:text-sm text-slate-400 max-w-md mx-auto">
                Select an eligible scholarship above or click &ldquo;Track Application&rdquo; from Scholarship Discovery to manage scheme-specific document checklists, deadlines, and submissions.
              </p>
              <Link
                to="/scholarships"
                className="btn-primary-gradient inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl"
              >
                <span>Browse Scholarships</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          ) : filteredApps.length === 0 ? (
            <div className="surface-card p-8 text-center space-y-2">
              <p className="text-sm font-semibold text-white">
                No tracked applications match your current view or filters
              </p>
              <button
                type="button"
                onClick={() => {
                  setActiveTab('All');
                  setSearchQuery('');
                  setStatusFilter('All');
                  setCategoryFilter('All');
                  setDeadlineFilter('All');
                  setEligibilityFilter('All');
                }}
                className="text-xs font-semibold text-indigo-300 hover:text-indigo-200 hover:underline"
              >
                Reset Tracker Filters
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredApps.map((ev) => {
                const appItem = ev.application;
                const isConfirmingDelete = confirmDeleteId === appItem.id;
                return (
                  <article
                    key={appItem.id}
                    className="surface-card surface-interactive p-6 space-y-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                          <span className="font-semibold text-indigo-300">{ev.normalizedStatus}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-medium text-slate-200">{ev.preparationStatus}</span>
                          {ev.scholarship && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{ev.scholarship.scholarshipType}</span>
                            </>
                          )}
                          {ev.scholarshipMissingOrArchived && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-amber-300 font-semibold">
                                Scholarship Archived/Unavailable
                              </span>
                            </>
                          )}
                        </div>

                        <Link
                          to={`/applications/${appItem.id}`}
                          className="text-base font-semibold text-white hover:text-indigo-300 font-display block transition-colors"
                        >
                          {appItem.scholarshipTitle}
                        </Link>
                        <p className="text-xs text-slate-400">
                          {ev.scholarship?.provider || appItem.provider || 'Scholarship Provider'}
                          {appItem.portalReferenceId ? ` · Ref: ${appItem.portalReferenceId}` : ''}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <Link
                          to={`/applications/${appItem.id}`}
                          className="btn-primary-gradient inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl whitespace-nowrap"
                        >
                          <span>Manage Workflow</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </Link>

                        {isConfirmingDelete ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => void handleDelete(appItem.id)}
                              className="px-2.5 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-xl"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2.5 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-xl"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(appItem.id)}
                            aria-label="Remove tracked application"
                            className="p-2 text-slate-500 hover:text-rose-400 rounded-xl transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Structured Metrics Row */}
                    <div className="grid sm:grid-cols-3 gap-3 text-xs">
                      <div className="p-3.5 rounded-xl bg-[#070C1B]/80 border border-slate-800 flex items-start gap-2.5">
                        <CalendarClock
                          className={`w-4 h-4 shrink-0 mt-0.5 ${
                            ev.deadline.isExpired
                              ? 'text-rose-400'
                              : ev.deadline.isApproaching
                                ? 'text-amber-400'
                                : 'text-slate-400'
                          }`}
                        />
                        <div>
                          <span className="text-slate-400 block">Deadline (IST)</span>
                          <strong className="text-white font-mono-num">
                            {ev.deadline.displayLabel}
                          </strong>
                        </div>
                      </div>

                      <div className="p-3.5 rounded-xl bg-[#070C1B]/80 border border-slate-800 flex items-start gap-2.5">
                        <CheckCircle2
                          className={`w-4 h-4 shrink-0 mt-0.5 ${
                            ev.eligibilityStatus === 'Eligible'
                              ? 'text-emerald-400'
                              : ev.eligibilityStatus === 'Not Eligible'
                                ? 'text-rose-400'
                                : 'text-amber-400'
                          }`}
                        />
                        <div>
                          <span className="text-slate-400 block">Deterministic Eligibility</span>
                          <strong className="text-white">
                            {ev.eligibilityStatus}
                            {ev.eligibilityScore !== null ? ` (${ev.eligibilityScore}%)` : ''}
                          </strong>
                        </div>
                      </div>

                      <div className="p-3.5 rounded-xl bg-[#070C1B]/80 border border-slate-800 flex items-start gap-2.5">
                        {ev.unresolvedCriticalOrHighFindings > 0 ? (
                          <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                        ) : (
                          <AlertTriangle className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                        )}
                        <div>
                          <span className="text-slate-400 block">Documents &amp; TrustGuard</span>
                          <strong className="text-white font-mono-num">
                            {ev.checklist.hasPublishedChecklist
                              ? `${ev.checklist.readyCount}/${ev.checklist.totalRequired} Ready`
                              : 'No fixed checklist'}
                            {ev.checklist.missingCount > 0 ? ` · ${ev.checklist.missingCount} Missing` : ''}
                            {ev.unresolvedCriticalOrHighFindings > 0
                              ? ` · ${ev.unresolvedCriticalOrHighFindings} TG Risk`
                              : ''}
                          </strong>
                        </div>
                      </div>
                    </div>

                    {/* Next Action & Portal Link */}
                    <div className="pt-2.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
                      <div className="text-slate-300">
                        <span className="font-semibold text-white">Next Step: </span>
                        <span>{ev.nextRecommendedAction}</span>
                      </div>
                      {ev.scholarship?.officialUrl && (
                        <Link
                          to={`/applications/${appItem.id}`}
                          className="inline-flex items-center gap-1 font-semibold text-indigo-300 hover:text-indigo-200 hover:underline whitespace-nowrap shrink-0"
                        >
                          <span>Checklist &amp; Portal</span>
                          <ExternalLink className="w-3 h-3" />
                        </Link>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </PageTransition>
    </AppShell>
  );
}
