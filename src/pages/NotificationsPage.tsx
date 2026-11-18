import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Award,
  Bell,
  Briefcase,
  Check,
  CheckCheck,
  ExternalLink,
  FileSearch,
  GraduationCap,
  Mail,
  Megaphone,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { AppShell } from '../components/AppShell.tsx';
import { PageTransition, SkeletonCard } from '../components/ui/MotionPrimitives.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import {
  getCachedProtectedApi,
  getProtectedApi,
  postProtectedAi,
  putProtectedApi,
} from '../lib/apiClient.ts';
import {
  archiveNotification,
  deleteNotification,
  getNotificationDeliveryLogs,
  getNotificationPreferences,
  getNotifications,
  getPublishedAnnouncements,
  markAllNotificationsRead,
  markNotificationRead,
  saveNotificationPreferences,
} from '../lib/firestoreRepo.ts';
import { peekPublicCache, peekUserCache } from '../lib/workspaceCache.ts';
import {
  ALLOWED_DEADLINE_INTERVALS,
  doesProfileMatchAnnouncementAudience,
  isAnnouncementActiveAt,
  normalizeNotificationPreferences,
  normalizeNotificationUiCategory,
  type CanonicalNotificationBucket,
} from '../lib/notificationEngine.ts';
import type {
  AdminAnnouncementRecord,
  NotificationDeliveryLogRecord,
  NotificationPreferenceRecord,
  NotificationRecord,
} from '../types/database.ts';

const FEED_CATEGORIES: Array<{ key: 'All' | CanonicalNotificationBucket; label: string }> = [
  { key: 'All', label: 'All Alerts' },
  { key: 'Scholarship', label: 'Scholarship Alerts' },
  { key: 'Application', label: 'Application Alerts' },
  { key: 'Document', label: 'Document Alerts' },
  { key: 'Readiness', label: 'Readiness Alerts' },
  { key: 'Account', label: 'Account & Security' },
];

const PAGE_SIZE = 15;

function getBucketStyle(category?: string): {
  bucket: CanonicalNotificationBucket;
  textClass: string;
  icon: typeof Bell;
} {
  const bucket = normalizeNotificationUiCategory(category);
  switch (bucket) {
    case 'Scholarship':
      return { bucket, textClass: 'text-amber-300', icon: GraduationCap };
    case 'Application':
      return { bucket, textClass: 'text-indigo-300', icon: Briefcase };
    case 'Document':
      return { bucket, textClass: 'text-sky-300', icon: FileSearch };
    case 'Readiness':
      return { bucket, textClass: 'text-emerald-300', icon: Award };
    case 'Account':
    default:
      return { bucket: 'Account', textClass: 'text-violet-300', icon: ShieldAlert };
  }
}

export default function NotificationsPage({
  initialTab = 'feed',
}: {
  initialTab?: 'feed' | 'preferences';
}) {
  const { user, profile, getIdToken } = useAuth();
  const navigate = useNavigate();

  const cachedNotifs = peekUserCache<NotificationRecord[]>(user?.uid, 'notifications');
  const cachedAnns = peekPublicCache<AdminAnnouncementRecord[]>('announcements');
  const cachedPrefsApi = peekUserCache<{
    preferences: NotificationPreferenceRecord;
    emailProvider?: { configured: boolean; statusLabel: string };
  }>(user?.uid, 'api:/api/notifications/preferences');
  const cachedPrefsRepo = peekUserCache<NotificationPreferenceRecord | null>(
    user?.uid,
    'notification_preferences'
  );
  const cachedLogsApi = peekUserCache<{
    logs: NotificationDeliveryLogRecord[];
    emailProvider?: { configured: boolean; statusLabel: string };
  }>(user?.uid, 'api:/api/notifications/delivery-logs');
  const cachedLogsRepo = peekUserCache<NotificationDeliveryLogRecord[]>(
    user?.uid,
    'notification_delivery_logs'
  );
  const initialEmailProvider = cachedPrefsApi?.emailProvider ?? cachedLogsApi?.emailProvider;

  const [activeTab, setActiveTab] = useState<'feed' | 'preferences'>(initialTab);
  const [notifications, setNotifications] = useState<NotificationRecord[]>(() => cachedNotifs ?? []);
  const [announcements, setAnnouncements] = useState<AdminAnnouncementRecord[]>(
    () => cachedAnns ?? []
  );
  const [deliveryLogs, setDeliveryLogs] = useState<NotificationDeliveryLogRecord[]>(
    () => cachedLogsApi?.logs ?? cachedLogsRepo ?? []
  );
  const [preferences, setPreferences] = useState<NotificationPreferenceRecord | null>(
    () => cachedPrefsApi?.preferences ?? cachedPrefsRepo ?? null
  );
  const [emailProviderLabel, setEmailProviderLabel] = useState(
    () => initialEmailProvider?.statusLabel ?? 'Not Configured (Requires SMTP/Email Provider)'
  );
  const [emailConfigured, setEmailConfigured] = useState(
    () => initialEmailProvider?.configured ?? false
  );
  const [emptyScholarshipDatabase, setEmptyScholarshipDatabase] = useState(false);

  const [categoryFilter, setCategoryFilter] = useState<'All' | CanonicalNotificationBucket>('All');
  const [statusFilter, setStatusFilter] = useState<'active' | 'unread' | 'archived'>('active');
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);

  const [loading, setLoading] = useState(() => !(user && cachedNotifs !== undefined));
  const [syncing, setSyncing] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const loadData = useCallback(async (forceSpinner = false) => {
    if (!user) return;
    const warm = peekUserCache(user.uid, 'notifications') !== undefined;
    if (forceSpinner || !warm) {
      setLoading(true);
    }
    setError(null);
    try {
      const [notifs, publishedAnns, prefsRes, logsRes] = await Promise.all([
        getNotifications(user.uid),
        getPublishedAnnouncements().catch(() => [] as AdminAnnouncementRecord[]),
        getCachedProtectedApi<{
          preferences: NotificationPreferenceRecord;
          emailProvider?: { configured: boolean; statusLabel: string };
        }>(user.uid, '/api/notifications/preferences', getIdToken, 60_000).catch(async () => {
          const fallback = await getNotificationPreferences(user.uid);
          return {
            preferences: normalizeNotificationPreferences(user.uid, fallback),
            emailProvider: {
              configured: false,
              statusLabel: 'Not Configured (Requires SMTP/Email Provider)',
            },
          };
        }),
        getCachedProtectedApi<{
          logs: NotificationDeliveryLogRecord[];
          emailProvider?: { configured: boolean; statusLabel: string };
        }>(user.uid, '/api/notifications/delivery-logs', getIdToken, 60_000).catch(async () => {
          const fallbackLogs = await getNotificationDeliveryLogs(user.uid).catch(() => []);
          return { logs: fallbackLogs, emailProvider: undefined };
        }),
      ]);

      setNotifications(notifs);
      setAnnouncements(publishedAnns);
      setPreferences(prefsRes.preferences);
      setDeliveryLogs(logsRes.logs);
      if (prefsRes.emailProvider) {
        setEmailConfigured(prefsRes.emailProvider.configured);
        setEmailProviderLabel(prefsRes.emailProvider.statusLabel);
      } else if (logsRes.emailProvider) {
        setEmailConfigured(logsRes.emailProvider.configured);
        setEmailProviderLabel(logsRes.emailProvider.statusLabel);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notification data.');
    } finally {
      setLoading(false);
    }
  }, [user, getIdToken]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleSync = async () => {
    if (!user || syncing) return;
    setSyncing(true);
    setError(null);
    setFeedback(null);
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{
        newNotifications: NotificationRecord[];
        allNotifications: NotificationRecord[];
        preferences: NotificationPreferenceRecord;
        emptyScholarshipDatabase: boolean;
        emailConfigured: boolean;
      }>('/api/notifications/sync', token, {});

      setNotifications(res.allNotifications);
      setPreferences(res.preferences);
      setEmptyScholarshipDatabase(res.emptyScholarshipDatabase);
      setEmailConfigured(res.emailConfigured);
      setFeedback(
        res.newNotifications.length > 0
          ? `Generated ${res.newNotifications.length} new verified alert(s).`
          : 'All notification checks are up to date.'
      );
      const logsRes = await getProtectedApi<{ logs: NotificationDeliveryLogRecord[] }>(
        '/api/notifications/delivery-logs',
        token
      ).catch(() => null);
      if (logsRes) setDeliveryLogs(logsRes.logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check alerts.');
    } finally {
      setSyncing(false);
    }
  };

  const handleAction = async (
    id: string,
    action: 'mark_read' | 'mark_unread' | 'archive' | 'unarchive' | 'delete'
  ) => {
    if (!user) return;
    const nowIso = new Date().toISOString();
    setNotifications((prev) => {
      if (action === 'delete') return prev.filter((n) => n.id !== id);
      return prev.map((n) => {
        if (n.id !== id) return n;
        if (action === 'mark_read') return { ...n, isRead: true, readAt: nowIso };
        if (action === 'mark_unread') return { ...n, isRead: false, readAt: undefined };
        if (action === 'archive') {
          return {
            ...n,
            isArchived: true,
            archivedAt: nowIso,
            isRead: true,
            readAt: n.readAt || nowIso,
          };
        }
        return { ...n, isArchived: false, archivedAt: undefined };
      });
    });

    try {
      const token = await getIdToken();
      await postProtectedAi(`/api/notifications/${encodeURIComponent(id)}/action`, token, {
        action,
      });
    } catch {
      try {
        if (action === 'mark_read') await markNotificationRead(id);
        else if (action === 'archive') await archiveNotification(id);
        else if (action === 'delete') await deleteNotification(id);
      } catch {
        void loadData();
      }
    }
  };

  const handleMarkAllRead = async () => {
    const unreadIds = notifications.filter((n) => !n.isArchived && !n.isRead).map((n) => n.id);
    if (unreadIds.length === 0) return;
    const nowIso = new Date().toISOString();
    setNotifications((prev) =>
      prev.map((n) => (!n.isArchived ? { ...n, isRead: true, readAt: n.readAt || nowIso } : n))
    );
    try {
      await markAllNotificationsRead(unreadIds);
      setFeedback(`Marked ${unreadIds.length} notification(s) as read.`);
    } catch {
      void loadData();
    }
  };

  const persistPreferences = async (patch: Partial<NotificationPreferenceRecord>) => {
    if (!preferences || !user) return;
    const optimistic = normalizeNotificationPreferences(
      user.uid,
      { ...preferences, ...patch, updatedAt: new Date().toISOString() },
      emailProviderLabel
    );
    setPreferences(optimistic);
    setSavingPrefs(true);
    setError(null);
    setFeedback(null);
    try {
      const token = await getIdToken();
      const res = await putProtectedApi<{ preferences: NotificationPreferenceRecord }>(
        '/api/notifications/preferences',
        token,
        patch
      );
      setPreferences(res.preferences);
      setFeedback('Notification preferences saved.');
    } catch (err) {
      await saveNotificationPreferences(optimistic).catch(() => {});
      setError(
        err instanceof Error ? err.message : 'Preferences saved locally; server sync failed.'
      );
    } finally {
      setSavingPrefs(false);
    }
  };

  const toggleDeadlineInterval = (day: number) => {
    if (!preferences) return;
    const current = preferences.deadlineIntervalsDays ?? [7, 3, 1, 0];
    const exists = current.includes(day);
    const next = exists ? current.filter((d) => d !== day) : [...current, day];
    if (next.length === 0) return; // Keep at least 1 active interval
    void persistPreferences({ deadlineIntervalsDays: next });
  };

  const targetedAnnouncements = useMemo(() => {
    const now = new Date();
    return announcements.filter(
      (a) => isAnnouncementActiveAt(a, now) && doesProfileMatchAnnouncementAudience(a, profile)
    );
  }, [announcements, profile]);

  const activeCount = useMemo(() => notifications.filter((n) => !n.isArchived).length, [notifications]);
  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.isArchived && !n.isRead).length,
    [notifications]
  );
  const archivedCount = useMemo(() => notifications.filter((n) => n.isArchived).length, [notifications]);

  const filteredNotifications = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return notifications.filter((n) => {
      if (statusFilter === 'active' && n.isArchived) return false;
      if (statusFilter === 'unread' && (n.isArchived || n.isRead)) return false;
      if (statusFilter === 'archived' && !n.isArchived) return false;
      if (categoryFilter !== 'All') {
        if (normalizeNotificationUiCategory(n.category) !== categoryFilter) return false;
      }
      if (q) {
        const hay = `${n.title} ${n.message} ${n.subCategory || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [notifications, statusFilter, categoryFilter, searchQuery]);

  const visibleNotifications = filteredNotifications.slice(0, visibleLimit);

  const switchTab = (tab: 'feed' | 'preferences') => {
    setActiveTab(tab);
    navigate(tab === 'preferences' ? '/notifications/preferences' : '/notifications');
  };

  return (
    <AppShell
      title={activeTab === 'preferences' ? 'Notification Preferences' : 'Notification Center'}
      breadcrumb={
        activeTab === 'preferences'
          ? 'Workspace / Notifications / Preferences'
          : 'Workspace / Notification Center'
      }
      primaryAction={
        <button
          type="button"
          onClick={() => void handleSync()}
          disabled={syncing}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white btn-primary-gradient rounded-xl disabled:opacity-60 whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          <span>{syncing ? 'Checking Alerts...' : 'Check Alerts'}</span>
        </button>
      }
    >
      <PageTransition className="space-y-6">
        {/* Top Tab Switcher */}
        <div className="surface-card rounded-2xl p-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5" role="tablist" aria-label="Notification Views">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'feed'}
              onClick={() => switchTab('feed')}
              className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'feed'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
              }`}
            >
              <Bell className="w-3.5 h-3.5" />
              <span>Alert Feed</span>
              {unreadCount > 0 && (
                <span className="font-mono-num text-[11px] opacity-90">({unreadCount})</span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'preferences'}
              onClick={() => switchTab('preferences')}
              className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'preferences'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
              }`}
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span>Preferences &amp; Delivery Logs</span>
            </button>
          </div>

          <div className="px-2 text-xs text-slate-400 flex items-center gap-2">
            <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span>
              Email Transport:{' '}
              <span className={emailConfigured ? 'text-emerald-300 font-medium' : 'text-amber-300 font-medium'}>
                {emailProviderLabel}
              </span>
            </span>
          </div>
        </div>

        {/* Status / Honest Disclosure Banners */}
        {feedback && (
          <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs sm:text-sm text-emerald-200 flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{feedback}</span>
          </div>
        )}
        {error && (
          <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs sm:text-sm text-rose-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={() => void loadData(true)}
              className="px-3 py-1 text-xs font-semibold rounded-lg bg-rose-500/20 border border-rose-400/40 text-rose-100 hover:bg-rose-500/30 shrink-0"
            >
              Retry
            </button>
          </div>
        )}
        {emptyScholarshipDatabase && (
          <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Scholarship Catalog Empty</p>
              <p className="text-amber-200/80 mt-0.5">
                No verified scholarship records exist in the database yet. Smart scholarship match alerts are withheld rather than fabricated.
              </p>
            </div>
          </div>
        )}

        {activeTab === 'feed' ? (
          <div className="space-y-5">
            {/* Active Targeted Admin Announcements */}
            {targetedAnnouncements.length > 0 && (
              <section className="surface-card rounded-2xl p-5 space-y-3" aria-label="Platform Announcements">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-white font-display flex items-center gap-2">
                    <Megaphone className="w-4 h-4 text-indigo-300" />
                    <span>Official Platform Announcements</span>
                  </h2>
                  <span className="text-xs font-mono-num text-slate-400">
                    {targetedAnnouncements.length} active
                  </span>
                </div>
                <div className="space-y-2.5">
                  {targetedAnnouncements.map((ann) => (
                    <div
                      key={ann.id}
                      className="rounded-xl p-3.5 bg-[#090F20] border border-indigo-500/25 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2 text-[11px] text-slate-400">
                          <span className="font-semibold text-indigo-300">{ann.category}</span>
                          {ann.publishedAt && (
                            <span className="font-mono-num">
                              · {new Date(ann.publishedAt).toLocaleDateString('en-IN')}
                            </span>
                          )}
                        </div>
                        <p className="text-sm font-semibold text-white">{ann.title}</p>
                        <p className="text-xs text-slate-300 leading-relaxed">{ann.message}</p>
                      </div>
                      {ann.actionRoute && (
                        <Link
                          to={ann.actionRoute}
                          className="text-xs font-semibold text-indigo-300 hover:text-indigo-200 whitespace-nowrap shrink-0"
                        >
                          Open →
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Filters & Bulk Actions */}
            <div className="surface-card rounded-2xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {FEED_CATEGORIES.map((cat) => {
                    const active = categoryFilter === cat.key;
                    return (
                      <button
                        key={cat.key}
                        type="button"
                        onClick={() => {
                          setCategoryFilter(cat.key);
                          setVisibleLimit(PAGE_SIZE);
                        }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                          active
                            ? 'bg-indigo-600 text-white'
                            : 'bg-slate-900/70 text-slate-400 hover:text-white hover:bg-slate-800/80 border border-slate-800'
                        }`}
                      >
                        {cat.label}
                      </button>
                    );
                  })}
                </div>

                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleMarkAllRead()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-indigo-300 hover:bg-indigo-500/15 whitespace-nowrap shrink-0"
                  >
                    <CheckCheck className="w-3.5 h-3.5" />
                    <span>Mark All Read</span>
                  </button>
                )}
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-slate-800/70">
                <div className="flex items-center gap-1.5 text-xs">
                  {(
                    [
                      ['active', `Active (${activeCount})`],
                      ['unread', `Unread (${unreadCount})`],
                      ['archived', `Archived (${archivedCount})`],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        setStatusFilter(key);
                        setVisibleLimit(PAGE_SIZE);
                      }}
                      className={`px-2.5 py-1 rounded-lg font-medium transition-colors whitespace-nowrap ${
                        statusFilter === key
                          ? 'bg-slate-800 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="relative w-full sm:w-64">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter notifications..."
                    aria-label="Filter notifications"
                    className="input-midnight w-full rounded-xl pl-8 pr-3 py-1.5 text-xs"
                  />
                </div>
              </div>
            </div>

            {/* Notification List */}
            {loading && notifications.length === 0 ? (
              <div className="space-y-3">
                {[0, 1, 2].map((idx) => (
                  <SkeletonCard key={idx} className="h-28" />
                ))}
              </div>
            ) : filteredNotifications.length === 0 ? (
              <div className="surface-card rounded-2xl p-12 text-center space-y-2.5">
                <Bell className="w-8 h-8 text-slate-500 mx-auto" />
                <h3 className="text-sm font-semibold text-white font-display">
                  No matching notifications
                </h3>
                <p className="text-xs text-slate-400 max-w-md mx-auto">
                  All alerts are generated exclusively from verified database records, scholarship eligibility rules, document extraction, TrustGuard checks, and admin announcements.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {visibleNotifications.map((n) => {
                  const meta = getBucketStyle(n.category);
                  const CatIcon = meta.icon;
                  return (
                    <article
                      key={n.id}
                      className={`surface-card rounded-2xl p-5 transition-colors ${
                        !n.isRead && !n.isArchived ? 'border-indigo-500/40 bg-indigo-950/15' : ''
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <CatIcon className={`w-4 h-4 shrink-0 ${meta.textClass}`} />
                          <span className={`font-semibold ${meta.textClass}`}>{meta.bucket}</span>
                          {n.subCategory && (
                            <span className="text-slate-400">· {n.subCategory}</span>
                          )}
                          {n.priority && (
                            <span
                              className={`font-medium ${
                                n.priority === 'High'
                                  ? 'text-rose-300'
                                  : n.priority === 'Medium'
                                    ? 'text-amber-300'
                                    : 'text-slate-400'
                              }`}
                            >
                              · {n.priority} Priority
                            </span>
                          )}
                          {!n.isRead && !n.isArchived && (
                            <span className="text-indigo-300 font-semibold">· Unread</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-[11px] font-mono-num text-slate-400 shrink-0">
                          {n.deliveryStatus && <span>{n.deliveryStatus}</span>}
                          <span>{new Date(n.createdAt).toLocaleString('en-IN')}</span>
                        </div>
                      </div>

                      <h3 className="text-sm font-semibold text-white mt-2">{n.title}</h3>
                      <p className="text-xs sm:text-sm text-slate-300 mt-1 leading-relaxed">
                        {n.message}
                      </p>

                      {(n.verifiedDeadline || n.officialSourceUrl) && (
                        <div className="flex flex-wrap items-center gap-4 mt-2.5 text-xs text-slate-400">
                          {n.verifiedDeadline && (
                            <span className="font-mono-num">
                              Verified Deadline: <strong className="text-slate-200">{n.verifiedDeadline} IST</strong>
                            </span>
                          )}
                          {n.officialSourceUrl && (
                            <a
                              href={n.officialSourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200"
                            >
                              <span>Official Source</span>
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-3 border-t border-slate-800/70 text-xs">
                        <div>
                          {n.actionRoute && (
                            <Link
                              to={n.actionRoute}
                              onClick={() => {
                                if (!n.isRead) void handleAction(n.id, 'mark_read');
                              }}
                              className="font-semibold text-indigo-300 hover:text-indigo-200"
                            >
                              Open related workspace →
                            </Link>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          {!n.isArchived && (
                            <button
                              type="button"
                              onClick={() =>
                                void handleAction(n.id, n.isRead ? 'mark_unread' : 'mark_read')
                              }
                              className="inline-flex items-center gap-1 text-slate-300 hover:text-white font-medium"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>{n.isRead ? 'Mark unread' : 'Mark read'}</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              void handleAction(n.id, n.isArchived ? 'unarchive' : 'archive')
                            }
                            className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-200"
                          >
                            {n.isArchived ? (
                              <>
                                <ArchiveRestore className="w-3.5 h-3.5" />
                                <span>Restore</span>
                              </>
                            ) : (
                              <>
                                <Archive className="w-3.5 h-3.5" />
                                <span>Archive</span>
                              </>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleAction(n.id, 'delete')}
                            className="inline-flex items-center gap-1 text-slate-400 hover:text-rose-300"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Delete</span>
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}

                {filteredNotifications.length > visibleLimit && (
                  <button
                    type="button"
                    onClick={() => setVisibleLimit((v) => v + PAGE_SIZE)}
                    className="w-full py-2.5 rounded-xl border border-slate-700/70 bg-slate-900/60 hover:bg-slate-800 text-xs font-semibold text-slate-200 transition-colors"
                  >
                    Load more ({filteredNotifications.length - visibleLimit} remaining)
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          /* Preferences & Real Email Delivery Logs Tab */
          <div className="space-y-6">
            {!preferences ? (
              <SkeletonCard className="h-64" />
            ) : (
              <div className="grid lg:grid-cols-12 gap-6">
                {/* Category & Interval Settings */}
                <section className="lg:col-span-7 surface-card rounded-2xl p-6 space-y-5">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h2 className="text-base font-semibold text-white font-display">
                        Alert Categories &amp; Deadline Schedule
                      </h2>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Controls which real database events and IST deadline checks create notifications for your account.
                      </p>
                    </div>
                    {savingPrefs && (
                      <span className="text-xs text-indigo-300 font-medium">Saving...</span>
                    )}
                  </div>

                  <div className="divide-y divide-slate-800/70">
                    {(
                      [
                        {
                          key: 'scholarshipAlertsEnabled',
                          title: 'Scholarship Alerts',
                          desc: 'Newly verified scholarships matching your profile and eligibility changes.',
                        },
                        {
                          key: 'applicationAlertsEnabled',
                          title: 'Application Alerts',
                          desc: 'Workflow stage changes, correction required notices, and outcome updates.',
                        },
                        {
                          key: 'documentAlertsEnabled',
                          title: 'Document & TrustGuard Alerts',
                          desc: 'Document processing completions, failures, manual review flags, and consistency risks.',
                        },
                        {
                          key: 'readinessAlertsEnabled',
                          title: 'Readiness Alerts',
                          desc: 'Scholarship readiness score updates, missing requirements, and action plan revisions.',
                        },
                        {
                          key: 'accountSecurityAlertsEnabled',
                          title: 'Account & Announcement Alerts',
                          desc: 'Account security notices and targeted administrative scholarship announcements.',
                        },
                      ] as const
                    ).map((item) => (
                      <label
                        key={item.key}
                        className="flex items-start justify-between gap-4 py-3.5 cursor-pointer"
                      >
                        <div>
                          <p className="text-sm font-medium text-slate-100">{item.title}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{item.desc}</p>
                        </div>
                        <input
                          type="checkbox"
                          checked={Boolean(preferences[item.key])}
                          onChange={() =>
                            void persistPreferences({
                              [item.key]: !preferences[item.key],
                              ...(item.key === 'applicationAlertsEnabled'
                                ? { statusChangeAlertsEnabled: !preferences[item.key] }
                                : {}),
                              ...(item.key === 'documentAlertsEnabled'
                                ? { missingDocsAlertsEnabled: !preferences[item.key] }
                                : {}),
                            })
                          }
                          className="mt-1 rounded border-slate-600 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                        />
                      </label>
                    ))}
                  </div>

                  {/* Deadline Reminder Intervals */}
                  <div className="pt-3 border-t border-slate-800/80 space-y-3">
                    <label className="flex items-center justify-between gap-4 cursor-pointer">
                      <div>
                        <p className="text-sm font-medium text-slate-100">
                          Verified Deadline Reminders (IST)
                        </p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          Select how many days before an official IST deadline to alert you (deduplicated per scheme).
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        checked={preferences.deadlineRemindersEnabled}
                        onChange={() =>
                          void persistPreferences({
                            deadlineRemindersEnabled: !preferences.deadlineRemindersEnabled,
                          })
                        }
                        className="rounded border-slate-600 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                      />
                    </label>

                    <div className="flex flex-wrap items-center gap-2">
                      {ALLOWED_DEADLINE_INTERVALS.map((day) => {
                        const active = (preferences.deadlineIntervalsDays ?? []).includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            disabled={!preferences.deadlineRemindersEnabled}
                            onClick={() => toggleDeadlineInterval(day)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold font-mono-num border transition-colors disabled:opacity-40 ${
                              active
                                ? 'bg-indigo-600 border-indigo-500 text-white'
                                : 'bg-slate-900/70 border-slate-700/70 text-slate-400 hover:text-white'
                            }`}
                          >
                            {day === 0 ? 'Deadline Day (0d)' : `${day}d before`}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </section>

                {/* Email Transport & Honest Configuration Disclosure */}
                <section className="lg:col-span-5 surface-card rounded-2xl p-6 space-y-4">
                  <div className="flex items-center gap-2.5">
                    <Mail className="w-4 h-4 text-indigo-300 shrink-0" />
                    <h2 className="text-base font-semibold text-white font-display">
                      Email Notifications
                    </h2>
                  </div>

                  <label className="flex items-start justify-between gap-4 p-3.5 rounded-xl bg-[#090F20] border border-slate-800 cursor-pointer">
                    <div>
                      <p className="text-sm font-medium text-slate-100">
                        Enable Email Alerts
                      </p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Recipient: <span className="text-slate-200">{user?.email || 'Not set'}</span>
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={Boolean(preferences.emailNotificationsEnabled)}
                      onChange={() => {
                        const next = !preferences.emailNotificationsEnabled;
                        void persistPreferences({
                          emailNotificationsEnabled: next,
                          emailDigestRequested: next,
                        });
                      }}
                      className="mt-1 rounded border-slate-600 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                    />
                  </label>

                  <div
                    className={`p-4 rounded-xl border text-xs space-y-1.5 ${
                      emailConfigured
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                        : 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                    }`}
                  >
                    <p className="font-semibold">Server Email Transport: {emailProviderLabel}</p>
                    <p className="leading-relaxed opacity-90">
                      {emailConfigured
                        ? 'Transactional email delivery is active on the backend with idempotent keys and retry handling. Every send attempt is logged below.'
                        : 'External email delivery is inactive during this public beta. When email alerts are requested, delivery logs honestly record "Not Configured" and alerts are delivered in-app without simulated sends.'}
                    </p>
                  </div>
                </section>
              </div>
            )}

            {/* Notification Delivery Logs Table */}
            <section className="surface-card rounded-2xl p-6 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-white font-display">
                    Notification Delivery Logs
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Auditable record of email delivery attempts, retries, provider responses, or unconfigured transport status.
                  </p>
                </div>
                <span className="text-xs font-mono-num text-slate-400">
                  {deliveryLogs.length} record(s)
                </span>
              </div>

              {deliveryLogs.length === 0 ? (
                <p className="text-xs text-slate-400 py-6 text-center">
                  No email delivery log entries recorded yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400">
                        <th className="py-2.5 pr-4 font-medium">Timestamp</th>
                        <th className="py-2.5 pr-4 font-medium">Channel / Provider</th>
                        <th className="py-2.5 pr-4 font-medium">Status</th>
                        <th className="py-2.5 pr-4 font-medium">Attempts</th>
                        <th className="py-2.5 font-medium">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {deliveryLogs.map((log) => (
                        <tr key={log.id} className="text-slate-300">
                          <td className="py-2.5 pr-4 font-mono-num whitespace-nowrap">
                            {new Date(log.createdAt).toLocaleString('en-IN')}
                          </td>
                          <td className="py-2.5 pr-4 whitespace-nowrap">
                            {log.channel} · {log.provider}
                          </td>
                          <td className="py-2.5 pr-4 font-semibold whitespace-nowrap">
                            <span
                              className={
                                log.status === 'Sent' || log.status === 'Delivered'
                                  ? 'text-emerald-300'
                                  : log.status === 'Failed'
                                    ? 'text-rose-300'
                                    : 'text-amber-300'
                              }
                            >
                              {log.status}
                            </span>
                          </td>
                          <td className="py-2.5 pr-4 font-mono-num">{log.attempts}</td>
                          <td className="py-2.5 text-slate-400 max-w-md truncate">
                            {log.providerMessageId
                              ? `Provider ID: ${log.providerMessageId}`
                              : log.errorMessage || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </PageTransition>
    </AppShell>
  );
}
