import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  Archive,
  Award,
  Bell,
  Briefcase,
  Check,
  CheckCheck,
  FileSearch,
  GraduationCap,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { getProtectedApi, postProtectedAi, putProtectedApi } from '../../lib/apiClient.ts';
import {
  archiveNotification,
  deleteNotification,
  getNotificationPreferences,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  saveNotificationPreferences,
} from '../../lib/firestoreRepo.ts';
import {
  normalizeNotificationPreferences,
  normalizeNotificationUiCategory,
  type CanonicalNotificationBucket,
} from '../../lib/notificationEngine.ts';
import type {
  NotificationCategory,
  NotificationPreferenceRecord,
  NotificationRecord,
} from '../../types/database.ts';

const DRAWER_CATEGORIES: Array<{ key: 'All' | CanonicalNotificationBucket; label: string }> = [
  { key: 'All', label: 'All' },
  { key: 'Scholarship', label: 'Scholarship' },
  { key: 'Application', label: 'Application' },
  { key: 'Document', label: 'Document' },
  { key: 'Readiness', label: 'Readiness' },
  { key: 'Account', label: 'Account' },
];

const PAGE_SIZE = 12;

function categoryMeta(cat?: NotificationCategory | string): {
  bucket: CanonicalNotificationBucket;
  colorClass: string;
  icon: typeof Bell;
} {
  const bucket = normalizeNotificationUiCategory(cat);
  switch (bucket) {
    case 'Scholarship':
      return { bucket, colorClass: 'text-amber-300', icon: GraduationCap };
    case 'Application':
      return { bucket, colorClass: 'text-indigo-300', icon: Briefcase };
    case 'Document':
      return { bucket, colorClass: 'text-sky-300', icon: FileSearch };
    case 'Readiness':
      return { bucket, colorClass: 'text-emerald-300', icon: Award };
    case 'Account':
    default:
      return { bucket: 'Account', colorClass: 'text-violet-300', icon: ShieldAlert };
  }
}

export function NotificationCenter() {
  const { user, getIdToken } = useAuth();
  const [open, setOpen] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [preferences, setPreferences] = useState<NotificationPreferenceRecord | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<'All' | CanonicalNotificationBucket>('All');
  const [readFilter, setReadFilter] = useState<'all' | 'unread'>('all');
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);

  const loadNotifications = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await getIdToken();
      const [items, prefsRes] = await Promise.all([
        getNotifications(user.uid),
        getProtectedApi<{ preferences: NotificationPreferenceRecord }>(
          '/api/notifications/preferences',
          token
        ).catch(async () => {
          const fallback = await getNotificationPreferences(user.uid);
          return { preferences: normalizeNotificationPreferences(user.uid, fallback) };
        }),
      ]);
      setNotifications(items);
      setPreferences(prefsRes.preferences);
    } catch {
      // Non-blocking in global header
    } finally {
      setLoading(false);
    }
  }, [user, getIdToken]);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const activeNotifications = useMemo(
    () => notifications.filter((n) => !n.isArchived),
    [notifications]
  );

  const unreadCount = useMemo(
    () => activeNotifications.filter((n) => !n.isRead).length,
    [activeNotifications]
  );

  const filteredNotifications = useMemo(() => {
    return activeNotifications.filter((n) => {
      if (readFilter === 'unread' && n.isRead) return false;
      if (categoryFilter !== 'All') {
        const bucket = normalizeNotificationUiCategory(n.category);
        if (bucket !== categoryFilter) return false;
      }
      return true;
    });
  }, [activeNotifications, categoryFilter, readFilter]);

  const visibleNotifications = filteredNotifications.slice(0, visibleLimit);

  const runNotificationAction = async (
    id: string,
    action: 'mark_read' | 'mark_unread' | 'archive' | 'delete'
  ) => {
    if (!user) return;
    const nowIso = new Date().toISOString();

    if (action === 'delete') {
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    } else if (action === 'archive') {
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === id ? { ...n, isArchived: true, archivedAt: nowIso, isRead: true, readAt: n.readAt || nowIso } : n
        )
      );
    } else if (action === 'mark_read') {
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, isRead: true, readAt: nowIso } : n))
      );
    } else {
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, isRead: false, readAt: undefined } : n))
      );
    }

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
        void loadNotifications();
      }
    }
  };

  const handleMarkAllRead = async () => {
    const unreadIds = activeNotifications.filter((n) => !n.isRead).map((n) => n.id);
    if (unreadIds.length === 0) return;
    const nowIso = new Date().toISOString();
    setNotifications((prev) =>
      prev.map((n) => (!n.isArchived ? { ...n, isRead: true, readAt: n.readAt || nowIso } : n))
    );
    try {
      await markAllNotificationsRead(unreadIds);
    } catch {
      void loadNotifications();
    }
  };

  const handleSync = async () => {
    if (!user || syncing) return;
    setSyncing(true);
    try {
      const token = await getIdToken();
      await postProtectedAi('/api/notifications/sync', token, {});
      await loadNotifications();
    } catch {
      // Ignore transient error
    } finally {
      setSyncing(false);
    }
  };

  const handleTogglePref = async (
    key:
      | 'scholarshipAlertsEnabled'
      | 'applicationAlertsEnabled'
      | 'documentAlertsEnabled'
      | 'readinessAlertsEnabled'
      | 'deadlineRemindersEnabled'
      | 'emailNotificationsEnabled'
  ) => {
    if (!preferences || !user) return;
    const nextValue = !preferences[key];
    const nextPayload: Partial<NotificationPreferenceRecord> = {
      [key]: nextValue,
      ...(key === 'applicationAlertsEnabled' ? { statusChangeAlertsEnabled: nextValue } : {}),
      ...(key === 'documentAlertsEnabled' ? { missingDocsAlertsEnabled: nextValue } : {}),
      ...(key === 'emailNotificationsEnabled' ? { emailDigestRequested: nextValue } : {}),
    };

    const optimistic = normalizeNotificationPreferences(
      user.uid,
      { ...preferences, ...nextPayload, updatedAt: new Date().toISOString() },
      preferences.emailDeliveryStatus
    );
    setPreferences(optimistic);
    setSavingPrefs(true);
    try {
      const token = await getIdToken();
      const res = await putProtectedApi<{ preferences: NotificationPreferenceRecord }>(
        '/api/notifications/preferences',
        token,
        nextPayload
      );
      setPreferences(res.preferences);
    } catch {
      await saveNotificationPreferences(optimistic).catch(() => {});
    } finally {
      setSavingPrefs(false);
    }
  };

  if (!user) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          void loadNotifications();
        }}
        aria-label={`Open notifications (${unreadCount} unread)`}
        className="relative p-2.5 rounded-xl bg-slate-900/80 border border-slate-700/60 text-slate-300 hover:text-white hover:border-indigo-400/50 transition-colors"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-indigo-500 text-white text-[10px] font-bold font-mono-num flex items-center justify-center shadow-lg shadow-indigo-500/40">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-50 flex justify-end">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 bg-black/65 backdrop-blur-xs"
              aria-hidden="true"
            />

            <motion.aside
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              aria-label="Notification Center"
              className="relative z-10 w-full max-w-md h-full bg-[#090F20] border-l border-slate-800 flex flex-col shadow-2xl"
            >
              {/* Header */}
              <div className="px-5 py-4 border-b border-slate-800/90 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
                    <span>Notifications</span>
                    {unreadCount > 0 && (
                      <span className="text-xs font-mono-num text-indigo-300">
                        ({unreadCount} unread)
                      </span>
                    )}
                  </h2>
                  <p className="text-[11px] text-slate-400 truncate">
                    Real-time scholarship, workflow, document &amp; readiness alerts
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close notifications"
                  className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/80 shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Action Bar */}
              <div className="px-5 py-2.5 border-b border-slate-800/70 bg-slate-900/40 flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSync()}
                    disabled={syncing}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-800 text-slate-200 border border-slate-700/70 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} />
                    <span>{syncing ? 'Checking...' : 'Check Alerts'}</span>
                  </button>
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleMarkAllRead()}
                      className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-indigo-300 hover:bg-indigo-500/15 whitespace-nowrap shrink-0"
                    >
                      <CheckCheck className="w-3.5 h-3.5" />
                      <span>Mark all read</span>
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setShowPrefs((v) => !v)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                    showPrefs
                      ? 'bg-indigo-500/20 border-indigo-400/40 text-indigo-200'
                      : 'border-slate-700/70 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <Settings2 className="w-3.5 h-3.5" />
                  <span>Quick Settings</span>
                </button>
              </div>

              {/* Quick Preferences Accordion */}
              <AnimatePresence>
                {showPrefs && preferences && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden border-b border-slate-800/80 bg-[#0D152C]"
                  >
                    <div className="p-4 space-y-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-200">Alert Channels</span>
                        {savingPrefs && (
                          <span className="text-[11px] text-indigo-300">Saving...</span>
                        )}
                      </div>
                      {(
                        [
                          ['scholarshipAlertsEnabled', 'Scholarship & Match Alerts'],
                          ['deadlineRemindersEnabled', 'Deadline Reminders (IST)'],
                          ['applicationAlertsEnabled', 'Application Workflow Alerts'],
                          ['documentAlertsEnabled', 'Document & TrustGuard Alerts'],
                          ['readinessAlertsEnabled', 'Readiness Score Alerts'],
                          ['emailNotificationsEnabled', 'Email Delivery Opt-In'],
                        ] as const
                      ).map(([field, label]) => (
                        <label
                          key={field}
                          className="flex items-center justify-between gap-3 py-0.5 cursor-pointer text-slate-300"
                        >
                          <span>{label}</span>
                          <input
                            type="checkbox"
                            checked={Boolean(preferences[field])}
                            onChange={() => void handleTogglePref(field)}
                            className="rounded border-slate-600 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                          />
                        </label>
                      ))}
                      <div className="pt-1 flex items-center justify-between gap-2 text-[11px]">
                        <span className="text-amber-300/90 flex items-center gap-1 min-w-0">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{preferences.emailDeliveryStatus}</span>
                        </span>
                        <Link
                          to="/notifications/preferences"
                          onClick={() => setOpen(false)}
                          className="text-indigo-300 hover:text-indigo-200 font-semibold whitespace-nowrap shrink-0"
                        >
                          All preferences →
                        </Link>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Category & Unread Filter Bar */}
              <div className="px-4 py-2.5 border-b border-slate-800/70 space-y-2 bg-[#070C1B]/80">
                <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
                  {DRAWER_CATEGORIES.map((cat) => {
                    const active = categoryFilter === cat.key;
                    return (
                      <button
                        key={cat.key}
                        type="button"
                        onClick={() => {
                          setCategoryFilter(cat.key);
                          setVisibleLimit(PAGE_SIZE);
                        }}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 ${
                          active
                            ? 'bg-indigo-600 text-white'
                            : 'text-slate-400 hover:bg-slate-800/80 hover:text-slate-200'
                        }`}
                      >
                        {cat.label}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setReadFilter('all')}
                      className={`px-2 py-0.5 rounded-md font-medium ${
                        readFilter === 'all'
                          ? 'bg-slate-800 text-slate-100'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      All ({activeNotifications.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setReadFilter('unread')}
                      className={`px-2 py-0.5 rounded-md font-medium ${
                        readFilter === 'unread'
                          ? 'bg-slate-800 text-indigo-300'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Unread ({unreadCount})
                    </button>
                  </div>
                  <Link
                    to="/notifications"
                    onClick={() => setOpen(false)}
                    className="text-indigo-300 hover:text-indigo-200 font-medium whitespace-nowrap shrink-0"
                  >
                    Open full center →
                  </Link>
                </div>
              </div>

              {/* Notification Feed */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
                {loading && notifications.length === 0 ? (
                  <div className="space-y-3">
                    {[1, 2, 3].map((k) => (
                      <div key={k} className="h-20 rounded-xl skeleton-shimmer border border-slate-800" />
                    ))}
                  </div>
                ) : filteredNotifications.length === 0 ? (
                  <div className="py-14 text-center space-y-2 px-4">
                    <Bell className="w-7 h-7 text-slate-500 mx-auto" />
                    <p className="text-sm font-medium text-slate-200">
                      {readFilter === 'unread'
                        ? 'No unread alerts in this view'
                        : 'No alerts yet'}
                    </p>
                    <p className="text-xs text-slate-400">
                      Verified scholarship matches, IST deadlines, document extraction updates, and readiness changes appear here from real database events.
                    </p>
                  </div>
                ) : (
                  <>
                    {visibleNotifications.map((n) => {
                      const meta = categoryMeta(n.category);
                      const CatIcon = meta.icon;
                      return (
                        <div
                          key={n.id}
                          className={`rounded-xl p-3.5 border transition-colors ${
                            n.isRead
                              ? 'bg-slate-900/40 border-slate-800/70'
                              : 'bg-indigo-950/25 border-indigo-500/35'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <div className="flex items-center gap-1.5 min-w-0 truncate">
                              <CatIcon className={`w-3.5 h-3.5 shrink-0 ${meta.colorClass}`} />
                              <span className={`font-semibold ${meta.colorClass}`}>
                                {meta.bucket}
                              </span>
                              {n.subCategory && (
                                <span className="text-slate-500 truncate">· {n.subCategory}</span>
                              )}
                              {!n.isRead && (
                                <span className="text-indigo-300 font-semibold">· Unread</span>
                              )}
                            </div>
                            <span className="text-[10px] font-mono-num text-slate-500 shrink-0">
                              {new Date(n.createdAt).toLocaleDateString('en-IN')}
                            </span>
                          </div>

                          <p className="text-xs font-semibold text-slate-100 mt-1.5">{n.title}</p>
                          <p className="text-xs text-slate-400 mt-1 leading-relaxed">{n.message}</p>

                          <div className="flex items-center justify-between gap-2 mt-2.5 pt-2 border-t border-slate-800/70 text-[11px]">
                            {n.actionRoute ? (
                              <Link
                                to={n.actionRoute}
                                onClick={() => {
                                  if (!n.isRead) void runNotificationAction(n.id, 'mark_read');
                                  setOpen(false);
                                }}
                                className="text-indigo-300 hover:text-indigo-200 font-medium whitespace-nowrap shrink-0"
                              >
                                Open details →
                              </Link>
                            ) : (
                              <span />
                            )}
                            <div className="flex items-center gap-2 shrink-0">
                              {!n.isRead && (
                                <button
                                  type="button"
                                  onClick={() => void runNotificationAction(n.id, 'mark_read')}
                                  className="inline-flex items-center gap-1 text-slate-300 hover:text-white font-medium"
                                  title="Mark as read"
                                >
                                  <Check className="w-3 h-3" />
                                  <span>Read</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void runNotificationAction(n.id, 'archive')}
                                className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-200"
                                title="Archive notification"
                                aria-label="Archive notification"
                              >
                                <Archive className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void runNotificationAction(n.id, 'delete')}
                                className="inline-flex items-center gap-1 text-slate-400 hover:text-rose-300"
                                title="Delete notification"
                                aria-label="Delete notification"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {filteredNotifications.length > visibleLimit && (
                      <button
                        type="button"
                        onClick={() => setVisibleLimit((v) => v + PAGE_SIZE)}
                        className="w-full py-2 rounded-xl border border-slate-700/70 bg-slate-900/60 hover:bg-slate-800 text-xs font-semibold text-slate-200 transition-colors"
                      >
                        Show more ({filteredNotifications.length - visibleLimit} remaining)
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Drawer Footer */}
              <div className="px-5 py-3 border-t border-slate-800/80 bg-[#070C1B] flex items-center justify-between gap-3 text-xs">
                <Link
                  to="/notifications"
                  onClick={() => setOpen(false)}
                  className="font-semibold text-indigo-300 hover:text-indigo-200 whitespace-nowrap"
                >
                  View Full Notification Center
                </Link>
                <Link
                  to="/notifications/preferences"
                  onClick={() => setOpen(false)}
                  className="font-medium text-slate-400 hover:text-white whitespace-nowrap"
                >
                  Preferences &amp; Logs
                </Link>
              </div>
            </motion.aside>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
