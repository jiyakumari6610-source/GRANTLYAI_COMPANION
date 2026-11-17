import React, { useCallback, useEffect, useState } from 'react';
import {
  BellRing,
  Clock,
  Eye,
  Mail,
  Megaphone,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { SkeletonCard } from '../ui/MotionPrimitives.tsx';
import { getProtectedApi, postProtectedAi, putProtectedApi } from '../../lib/apiClient.ts';
import {
  INDIAN_STATES_AND_UTS,
  type AdminAnnouncementRecord,
  type AnnouncementAudience,
  type EducationLevelOption,
  type ScheduledNotificationRunRecord,
} from '../../types/database.ts';

const EDUCATION_LEVELS: EducationLevelOption[] = [
  'Class 11-12',
  'Diploma / Polytechnic',
  'Undergraduate (UG)',
  'Postgraduate (PG)',
  'PhD / Doctoral',
];

interface AdminAnnouncementsResponse {
  announcements: AdminAnnouncementRecord[];
  totalStudentsCount: number;
  scheduledRuns: ScheduledNotificationRunRecord[];
  emailProvider: {
    configured: boolean;
    provider: string;
    statusLabel: string;
  };
  schedulerState: {
    active: boolean;
    intervalMs: number;
    lastRunAt: string | null;
    lastRunStatus: string;
    lastError: string | null;
  };
}

export function AdminAnnouncementsPanel({
  getIdToken,
  onNotify,
}: {
  getIdToken: () => Promise<string>;
  onNotify: (msg: string | null, err?: string | null) => void;
}) {
  const [data, setData] = useState<AdminAnnouncementsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningSweep, setRunningSweep] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [category, setCategory] = useState<AdminAnnouncementRecord['category']>('Scholarship');
  const [targetAudience, setTargetAudience] = useState<AnnouncementAudience>('all');
  const [targetStates, setTargetStates] = useState<string[]>([]);
  const [targetEducationLevels, setTargetEducationLevels] = useState<string[]>([]);
  const [publishAt, setPublishAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [actionRoute, setActionRoute] = useState('/scholarships');

  const loadAnnouncements = useCallback(async () => {
    setLoading(true);
    try {
      const token = await getIdToken();
      const res = await getProtectedApi<AdminAnnouncementsResponse>(
        '/api/admin/announcements',
        token
      );
      setData(res);
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to load announcements.');
    } finally {
      setLoading(false);
    }
  }, [getIdToken, onNotify]);

  useEffect(() => {
    void loadAnnouncements();
  }, [loadAnnouncements]);

  const resetForm = () => {
    setEditingId(null);
    setTitle('');
    setMessage('');
    setCategory('Scholarship');
    setTargetAudience('all');
    setTargetStates([]);
    setTargetEducationLevels([]);
    setPublishAt('');
    setExpiresAt('');
    setActionRoute('/scholarships');
    setPreviewMode(false);
  };

  const handleEdit = (ann: AdminAnnouncementRecord) => {
    setEditingId(ann.id);
    setTitle(ann.title);
    setMessage(ann.message);
    setCategory(ann.category);
    setTargetAudience(ann.targetAudience);
    setTargetStates(ann.targetStates ?? []);
    setTargetEducationLevels(ann.targetEducationLevels ?? []);
    setPublishAt(ann.publishAt ? ann.publishAt.slice(0, 16) : '');
    setExpiresAt(ann.expiresAt ? ann.expiresAt.slice(0, 16) : '');
    setActionRoute(ann.actionRoute || '/notifications');
    setPreviewMode(false);
  };

  const handleSave = async (status: AdminAnnouncementRecord['status']) => {
    if (!title.trim() || !message.trim()) {
      onNotify(null, 'Announcement title and message are required.');
      return;
    }
    setSaving(true);
    onNotify(null, null);
    try {
      const token = await getIdToken();
      const payload = {
        title: title.trim(),
        message: message.trim(),
        category,
        targetAudience,
        targetStates: targetAudience === 'filtered' ? targetStates : undefined,
        targetEducationLevels: targetAudience === 'filtered' ? targetEducationLevels : undefined,
        status,
        publishAt: publishAt ? new Date(publishAt).toISOString() : undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        actionRoute: actionRoute.trim() || undefined,
      };

      const res = editingId
        ? await putProtectedApi<{ announcement: AdminAnnouncementRecord; deliveredCount: number }>(
            `/api/admin/announcements/${encodeURIComponent(editingId)}`,
            token,
            payload
          )
        : await postProtectedAi<{ announcement: AdminAnnouncementRecord; deliveredCount: number }>(
            '/api/admin/announcements',
            token,
            payload
          );

      onNotify(
        status === 'Published'
          ? `Published "${res.announcement.title}" (delivered to ${res.deliveredCount} targeted student(s)).`
          : `Saved announcement "${res.announcement.title}" (${res.announcement.status}).`
      );
      resetForm();
      await loadAnnouncements();
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to save announcement.');
    } finally {
      setSaving(false);
    }
  };

  const handleTogglePublish = async (ann: AdminAnnouncementRecord, publish: boolean) => {
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{ deliveredCount: number }>(
        `/api/admin/announcements/${encodeURIComponent(ann.id)}/${publish ? 'publish' : 'unpublish'}`,
        token,
        {}
      );
      onNotify(
        publish
          ? `Published "${ann.title}" to ${res.deliveredCount} targeted student(s).`
          : `Unpublished "${ann.title}".`
      );
      await loadAnnouncements();
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to update publish state.');
    }
  };

  const handleRunScheduledSweep = async () => {
    setRunningSweep(true);
    onNotify(null, null);
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{ run: ScheduledNotificationRunRecord }>(
        '/api/admin/notifications/run-scheduled',
        token,
        {}
      );
      onNotify(
        `Scheduled sweep ${res.run.status}: evaluated ${res.run.studentsEvaluated} students & ${res.run.scholarshipsEvaluated} scholarships, generated ${res.run.alertsGenerated} new alert(s).`
      );
      await loadAnnouncements();
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to run scheduled notification sweep.');
    } finally {
      setRunningSweep(false);
    }
  };

  const toggleState = (state: string) => {
    setTargetStates((prev) =>
      prev.includes(state) ? prev.filter((s) => s !== state) : [...prev, state]
    );
  };

  const toggleLevel = (lvl: string) => {
    setTargetEducationLevels((prev) =>
      prev.includes(lvl) ? prev.filter((l) => l !== lvl) : [...prev, lvl]
    );
  };

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <SkeletonCard className="h-36" />
        <SkeletonCard className="h-72" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Scheduler & Delivery Status Card */}
      <section className="surface-card rounded-2xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
              <BellRing className="w-4 h-4 text-indigo-300" />
              <span>Automated Notification Engine &amp; Email Transport</span>
            </h2>
            <p className="text-xs text-slate-400">
              Evaluates verified scholarships, eligibility matches, and IST deadlines across {data?.totalStudentsCount ?? 0} registered student profile(s).
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void loadAnnouncements()}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-700/70 bg-slate-900/60 hover:bg-slate-800 text-xs font-semibold text-slate-200 whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={() => void handleRunScheduledSweep()}
              disabled={runningSweep}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl btn-primary-gradient text-xs font-semibold text-white disabled:opacity-60 whitespace-nowrap"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{runningSweep ? 'Running Sweep...' : 'Run Scheduled Sweep Now'}</span>
            </button>
          </div>
        </div>

        <div className="grid sm:grid-cols-3 gap-4 text-xs">
          <div className="p-3.5 rounded-xl bg-[#090F20] border border-slate-800">
            <p className="text-slate-400 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-indigo-300" />
              <span>Background Cron Status</span>
            </p>
            <p className="text-sm font-semibold text-white mt-1">
              {data?.schedulerState.active ? 'Active' : 'Inactive'} ·{' '}
              {Math.round((data?.schedulerState.intervalMs ?? 21600000) / 3600000)}h interval
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              Last autonomous check: {data?.schedulerState.lastRunStatus || 'Idle'}
            </p>
          </div>

          <div className="p-3.5 rounded-xl bg-[#090F20] border border-slate-800">
            <p className="text-slate-400 flex items-center gap-1.5">
              <Mail className="w-3.5 h-3.5 text-amber-300" />
              <span>Server Email Provider</span>
            </p>
            <p
              className={`text-sm font-semibold mt-1 ${
                data?.emailProvider.configured ? 'text-emerald-300' : 'text-amber-300'
              }`}
            >
              {data?.emailProvider.statusLabel || 'Not Configured'}
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              In-app notifications always deliver immediately.
            </p>
          </div>

          <div className="p-3.5 rounded-xl bg-[#090F20] border border-slate-800">
            <p className="text-slate-400 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-300" />
              <span>Logged Scheduled Runs</span>
            </p>
            <p className="text-sm font-semibold text-white font-mono-num mt-1">
              {data?.scheduledRuns.length ?? 0} run(s)
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              Audited in notification_runs &amp; admin_audit_logs
            </p>
          </div>
        </div>

        {(data?.scheduledRuns.length ?? 0) > 0 && (
          <div className="overflow-x-auto pt-2">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 pr-3 font-medium">Completed</th>
                  <th className="py-2 pr-3 font-medium">Trigger</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Students</th>
                  <th className="py-2 pr-3 font-medium">Schemes</th>
                  <th className="py-2 pr-3 font-medium">Alerts Created</th>
                  <th className="py-2 font-medium">Emails (Sent/Failed)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {data!.scheduledRuns.slice(0, 6).map((run) => (
                  <tr key={run.id} className="text-slate-300">
                    <td className="py-2 pr-3 font-mono-num whitespace-nowrap">
                      {new Date(run.completedAt).toLocaleString('en-IN')}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{run.triggerType}</td>
                    <td className="py-2 pr-3 font-semibold text-emerald-300 whitespace-nowrap">
                      {run.status}
                    </td>
                    <td className="py-2 pr-3 font-mono-num">{run.studentsEvaluated}</td>
                    <td className="py-2 pr-3 font-mono-num">{run.scholarshipsEvaluated}</td>
                    <td className="py-2 pr-3 font-mono-num font-semibold text-indigo-300">
                      {run.alertsGenerated}
                    </td>
                    <td className="py-2 font-mono-num">
                      {run.emailsSent} / {run.emailsFailed}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Admin Announcement Composer & Audience Targeting */}
      <section className="grid lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 surface-card rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-indigo-300" />
              <span>{editingId ? 'Edit Admin Announcement' : 'Create Admin Announcement'}</span>
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPreviewMode((p) => !p)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-700/70 text-xs text-slate-300 hover:text-white"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>{previewMode ? 'Edit Form' : 'Preview'}</span>
              </button>
              {editingId && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="text-xs text-slate-400 hover:text-white"
                >
                  Cancel edit
                </button>
              )}
            </div>
          </div>

          {previewMode ? (
            <div className="p-5 rounded-xl bg-[#090F20] border border-indigo-500/35 space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="font-semibold text-indigo-300">{category} · Admin Announcement</span>
                <span>Target: {targetAudience}</span>
              </div>
              <p className="text-sm font-semibold text-white">{title || '(Untitled Announcement)'}</p>
              <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
                {message || '(No message entered)'}
              </p>
              {actionRoute && (
                <p className="text-xs text-indigo-300 font-medium pt-1">
                  Action link: {actionRoute}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-300 font-medium mb-1">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g., NSP OTR Biometric Authentication Window Open"
                  className="input-midnight w-full rounded-xl px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Message</label>
                <textarea
                  rows={3}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Provide factual, verifiable scholarship or platform guidance..."
                  className="input-midnight w-full rounded-xl px-3 py-2"
                />
              </div>

              <div className="grid sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-300 font-medium mb-1">Category</label>
                  <select
                    value={category}
                    onChange={(e) =>
                      setCategory(e.target.value as AdminAnnouncementRecord['category'])
                    }
                    className="input-midnight w-full rounded-xl px-3 py-2"
                  >
                    <option value="Scholarship">Scholarship</option>
                    <option value="Deadline">Deadline</option>
                    <option value="Account">Account</option>
                    <option value="System">System</option>
                    <option value="Maintenance">Maintenance</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 font-medium mb-1">Target Audience</label>
                  <select
                    value={targetAudience}
                    onChange={(e) => setTargetAudience(e.target.value as AnnouncementAudience)}
                    className="input-midnight w-full rounded-xl px-3 py-2"
                  >
                    <option value="all">All Registered Students</option>
                    <option value="onboarded">Onboarded Students Only</option>
                    <option value="pending_onboarding">Pending Onboarding Students</option>
                    <option value="filtered">Filtered (State / Level)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 font-medium mb-1">Action Route</label>
                  <input
                    type="text"
                    value={actionRoute}
                    onChange={(e) => setActionRoute(e.target.value)}
                    placeholder="/scholarships"
                    className="input-midnight w-full rounded-xl px-3 py-2"
                  />
                </div>
              </div>

              {targetAudience === 'filtered' && (
                <div className="p-3.5 rounded-xl bg-[#090F20] border border-slate-800 space-y-3">
                  <div>
                    <p className="text-slate-300 font-medium mb-1.5">
                      Target Education Levels (leave empty for any)
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {EDUCATION_LEVELS.map((lvl) => {
                        const active = targetEducationLevels.includes(lvl);
                        return (
                          <button
                            key={lvl}
                            type="button"
                            onClick={() => toggleLevel(lvl)}
                            className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium ${
                              active
                                ? 'bg-indigo-600 border-indigo-500 text-white'
                                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-white'
                            }`}
                          >
                            {lvl}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <p className="text-slate-300 font-medium mb-1.5">
                      Target States / UTs ({targetStates.length} selected; empty = all)
                    </p>
                    <div className="max-h-32 overflow-y-auto flex flex-wrap gap-1.5">
                      {INDIAN_STATES_AND_UTS.map((st) => {
                        const active = targetStates.includes(st);
                        return (
                          <button
                            key={st}
                            type="button"
                            onClick={() => toggleState(st)}
                            className={`px-2 py-0.5 rounded-md border text-[11px] ${
                              active
                                ? 'bg-indigo-600 border-indigo-500 text-white'
                                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-white'
                            }`}
                          >
                            {st}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-medium mb-1">
                    Publish At (Optional Schedule)
                  </label>
                  <input
                    type="datetime-local"
                    value={publishAt}
                    onChange={(e) => setPublishAt(e.target.value)}
                    className="input-midnight w-full rounded-xl px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-medium mb-1">
                    Expires At (Optional)
                  </label>
                  <input
                    type="datetime-local"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    className="input-midnight w-full rounded-xl px-3 py-2"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 pt-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSave(publishAt ? 'Scheduled' : 'Draft')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-xs font-semibold text-slate-200 disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{publishAt ? 'Save Scheduled' : 'Save Draft'}</span>
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSave('Published')}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl btn-primary-gradient text-xs font-semibold text-white disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{saving ? 'Publishing...' : 'Save & Publish Now'}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Existing Announcements Directory */}
        <div className="lg:col-span-5 surface-card rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white font-display">
              Announcement History
            </h3>
            <span className="text-xs font-mono-num text-slate-400">
              {data?.announcements.length ?? 0} total
            </span>
          </div>

          {(data?.announcements.length ?? 0) === 0 ? (
            <p className="text-xs text-slate-400 py-8 text-center">
              No announcements created yet.
            </p>
          ) : (
            <div className="space-y-3 max-h-[540px] overflow-y-auto pr-1">
              {data!.announcements.map((ann) => (
                <div
                  key={ann.id}
                  className="p-3.5 rounded-xl bg-[#090F20] border border-slate-800 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span
                      className={`font-semibold ${
                        ann.status === 'Published'
                          ? 'text-emerald-300'
                          : ann.status === 'Draft' || ann.status === 'Scheduled'
                            ? 'text-amber-300'
                            : 'text-slate-400'
                      }`}
                    >
                      {ann.status} · {ann.category}
                    </span>
                    <span className="font-mono-num text-slate-400">
                      {ann.deliveredCount ?? 0} delivered
                    </span>
                  </div>
                  <p className="text-xs font-semibold text-white">{ann.title}</p>
                  <p className="text-[11px] text-slate-400 line-clamp-2">{ann.message}</p>
                  <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-800/70 text-[11px]">
                    <span className="text-slate-500">Audience: {ann.targetAudience}</span>
                    <div className="flex items-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => handleEdit(ann)}
                        className="text-slate-300 hover:text-white font-medium"
                      >
                        Edit
                      </button>
                      {ann.status === 'Published' ? (
                        <button
                          type="button"
                          onClick={() => void handleTogglePublish(ann, false)}
                          className="text-amber-300 hover:text-amber-200 font-medium"
                        >
                          Unpublish
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleTogglePublish(ann, true)}
                          className="text-emerald-300 hover:text-emerald-200 font-medium"
                        >
                          Publish
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
