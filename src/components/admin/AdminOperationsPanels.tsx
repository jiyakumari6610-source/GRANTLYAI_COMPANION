import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  ClipboardList,
  Eye,
  FileWarning,
  Lock,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  Users,
} from 'lucide-react';
import { AnimatedCounter, SkeletonCard } from '../ui/MotionPrimitives.tsx';
import type { TrustGuardSystemSummary } from '../../lib/adminGovernanceEngine.ts';
import { getProtectedApi, postProtectedAi } from '../../lib/apiClient.ts';
import type {
  AdminAuditLogRecord,
  AdminDashboardMetrics,
  AdminStudentOversightItem,
  AppRole,
  TrustGuardReport,
  UserRoleRecord,
} from '../../types/database.ts';

// ============================================================================
// 1. Admin Dashboard Overview Panel
// ============================================================================

export function AdminOverviewPanel({
  metrics,
  recentAuditLogs,
  onNavigateTab,
}: {
  metrics: AdminDashboardMetrics | null;
  recentAuditLogs: AdminAuditLogRecord[];
  onNavigateTab: (tab: string) => void;
}) {
  if (!metrics) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((idx) => (
            <SkeletonCard key={idx} className="h-32" />
          ))}
        </div>
        <div className="grid lg:grid-cols-12 gap-6">
          <SkeletonCard className="lg:col-span-7 h-72" />
          <SkeletonCard className="lg:col-span-5 h-72" />
        </div>
      </div>
    );
  }

  const { platform, dataQuality } = metrics;

  const totalSchemes = Math.max(1, platform.totalScholarships);
  const unverifiedOrOther = Math.max(
    0,
    platform.totalScholarships -
      platform.verifiedScholarships -
      platform.reviewRequiredScholarships -
      platform.expiredScholarships
  );
  const scholarshipDistribution = [
    { label: 'Verified', count: platform.verifiedScholarships, color: '#34d399', textClass: 'text-emerald-300' },
    { label: 'Review Required', count: platform.reviewRequiredScholarships, color: '#fbbf24', textClass: 'text-amber-300' },
    { label: 'Expired', count: platform.expiredScholarships, color: '#fb7185', textClass: 'text-rose-300' },
    ...(unverifiedOrOther > 0
      ? [{ label: 'Other / Archived', count: unverifiedOrOther, color: '#64748b', textClass: 'text-slate-300' }]
      : []),
  ];

  const docTotal = Math.max(1, platform.documentJobsTotal);
  const docDistribution = [
    { label: 'Completed', count: platform.documentJobsByStatus.Completed, color: '#34d399', textClass: 'text-emerald-300' },
    { label: 'Needs Review', count: platform.documentJobsByStatus['Needs Review'], color: '#fbbf24', textClass: 'text-amber-300' },
    { label: 'Pending / Processing', count: platform.documentJobsByStatus.Pending + platform.documentJobsByStatus.Processing, color: '#818cf8', textClass: 'text-indigo-300' },
    { label: 'Failed', count: platform.documentJobsByStatus.Failed, color: '#fb7185', textClass: 'text-rose-300' },
  ];

  return (
    <div className="space-y-6">
      {/* Top 4 Real Platform Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="surface-card rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-400">Student Accounts (Active / Total)</p>
          <p className="text-2xl font-bold text-white font-mono-num mt-2">
            <AnimatedCounter value={platform.activeStudentAccounts} />{' '}
            <span className="text-slate-500 text-base font-normal">
              / <AnimatedCounter value={platform.totalStudents} />
            </span>
          </p>
          <p className="text-[11px] text-slate-400 mt-1.5">{platform.activeStudentDefinition}</p>
        </div>

        <div className="surface-card rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-400">Verified vs Unverified Schemes</p>
          <p className="text-2xl font-bold text-emerald-300 font-mono-num mt-2">
            <AnimatedCounter value={platform.verifiedScholarships} />{' '}
            <span className="text-slate-400 text-base font-normal">
              / <AnimatedCounter value={platform.totalScholarships} />
            </span>
          </p>
          <p className="text-[11px] text-slate-400 mt-1.5 font-mono-num">
            {platform.reviewRequiredScholarships} need review · {platform.expiredScholarships} expired
          </p>
        </div>

        <div className="surface-card rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-400">Tracked Applications &amp; Docs</p>
          <p className="text-2xl font-bold text-indigo-300 font-mono-num mt-2">
            <AnimatedCounter value={platform.totalApplications} />{' '}
            <span className="text-sm font-medium text-slate-400">apps</span>
          </p>
          <p className="text-[11px] text-slate-400 mt-1.5 font-mono-num">
            {platform.documentJobsTotal} doc jobs ({platform.documentJobsByStatus.Failed} failed)
          </p>
        </div>

        <div className="surface-card rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-400">Data Quality &amp; TrustGuard</p>
          <p className={`text-2xl font-bold font-mono-num mt-2 ${dataQuality.totalOpenIssues > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
            <AnimatedCounter value={dataQuality.totalOpenIssues} />
          </p>
          <p className="text-[11px] text-slate-400 mt-1.5 font-mono-num">
            Open catalog issues · {platform.trustGuardOpenReports} open scam reports
          </p>
        </div>
      </div>

      {/* Real Operational Distribution Bars (SVG Horizontal Distribution) */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="surface-card rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white font-display">
              Scholarship Verification Breakdown
            </h2>
            <span className="text-xs font-mono-num text-slate-400">
              {platform.totalScholarships} total
            </span>
          </div>
          <svg viewBox="0 0 400 14" className="w-full h-3.5 rounded-full overflow-hidden bg-[#070C1B]" role="img" aria-label="Scholarship verification distribution">
            {(() => {
              let xOffset = 0;
              return scholarshipDistribution.map((seg) => {
                const width = (seg.count / totalSchemes) * 400;
                const el = (
                  <rect
                    key={seg.label}
                    x={xOffset}
                    y={0}
                    width={Math.max(0, width)}
                    height={14}
                    fill={seg.color}
                  />
                );
                xOffset += width;
                return el;
              });
            })()}
          </svg>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            {scholarshipDistribution.map((seg) => (
              <div key={seg.label} className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: seg.color }} />
                <span className="text-slate-300">{seg.label}:</span>
                <span className={`font-semibold font-mono-num ${seg.textClass}`}>{seg.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="surface-card rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white font-display">
              Document Pipeline Outcomes
            </h2>
            <span className="text-xs font-mono-num text-slate-400">
              {platform.documentJobsTotal} jobs
            </span>
          </div>
          <svg viewBox="0 0 400 14" className="w-full h-3.5 rounded-full overflow-hidden bg-[#070C1B]" role="img" aria-label="Document job status distribution">
            {platform.documentJobsTotal === 0 ? (
              <rect x={0} y={0} width={400} height={14} fill="rgba(148,163,184,0.14)" />
            ) : (
              (() => {
                let xOffset = 0;
                return docDistribution.map((seg) => {
                  const width = (seg.count / docTotal) * 400;
                  const el = (
                    <rect
                      key={seg.label}
                      x={xOffset}
                      y={0}
                      width={Math.max(0, width)}
                      height={14}
                      fill={seg.color}
                    />
                  );
                  xOffset += width;
                  return el;
                });
              })()
            )}
          </svg>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            {docDistribution.map((seg) => (
              <div key={seg.label} className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: seg.color }} />
                <span className="text-slate-300">{seg.label}:</span>
                <span className={`font-semibold font-mono-num ${seg.textClass}`}>{seg.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Data Quality Summary + Operational Queues */}
      <div className="grid lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 surface-card rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white font-display">
              Scholarship Data Quality Summary
            </h2>
            <button
              type="button"
              onClick={() => onNavigateTab('quality')}
              className="text-xs font-semibold text-indigo-300 hover:text-indigo-200 hover:underline whitespace-nowrap shrink-0"
            >
              Open Data Quality Queue
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
            {[
              { label: 'Missing Official URLs', val: dataQuality.missingOfficialUrls },
              { label: 'Missing Deadlines', val: dataQuality.missingDeadlines },
              { label: 'Missing Eligibility Rules', val: dataQuality.missingEligibilityRules },
              { label: 'Duplicate Candidates', val: dataQuality.duplicateCandidates },
              { label: 'Incomplete Records', val: dataQuality.incompleteRecords },
              { label: 'Outdated Verifications', val: dataQuality.outdatedVerificationTimestamps },
            ].map((item) => (
              <div key={item.label} className="p-3.5 rounded-xl bg-[#070C1B]/75 border border-slate-800">
                <p className="text-[11px] text-slate-400">{item.label}</p>
                <p
                  className={`text-lg font-bold font-mono-num mt-1 ${
                    item.val > 0 ? 'text-amber-300' : 'text-emerald-300'
                  }`}
                >
                  {item.val}
                </p>
              </div>
            ))}
          </div>

          {/* Application Status Distribution */}
          <div className="pt-3 border-t border-slate-800 space-y-2.5">
            <h3 className="text-xs font-semibold text-slate-300">Applications by Stage</h3>
            {Object.keys(platform.applicationStatusCounts).length === 0 ? (
              <p className="text-xs text-slate-400">No tracked student applications recorded yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2 text-xs">
                {Object.entries(platform.applicationStatusCounts).map(([status, count]) => (
                  <span
                    key={status}
                    className="px-2.5 py-1 rounded-lg bg-[#070C1B]/80 border border-slate-800 text-slate-200 font-mono-num"
                  >
                    {status}: <strong className="text-white">{count}</strong>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent Immutable Admin Activity */}
        <div className="lg:col-span-5 surface-card rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white font-display">
              Recent Admin Activity
            </h2>
            <button
              type="button"
              onClick={() => onNavigateTab('audit')}
              className="text-xs font-semibold text-indigo-300 hover:text-indigo-200 hover:underline whitespace-nowrap shrink-0"
            >
              View Audit Logs
            </button>
          </div>
          {recentAuditLogs.length === 0 ? (
            <p className="text-xs text-slate-400">No admin governance actions logged yet.</p>
          ) : (
            <div className="divide-y divide-slate-800/70 max-h-72 overflow-y-auto pr-1">
              {recentAuditLogs.slice(0, 8).map((log) => (
                <div key={log.id} className="py-2.5 text-xs space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-white">{log.action}</span>
                    <span className="text-[11px] font-mono-num text-slate-400 shrink-0">
                      {new Date(log.createdAt).toLocaleTimeString('en-IN')}
                    </span>
                  </div>
                  <p className="text-slate-400 line-clamp-2">{log.summary}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 2. Student & Application Oversight Panel (Sanitized + Audited Sensitive Access)
// ============================================================================

export function AdminStudentOversightPanel({
  getIdToken,
  onNotify,
}: {
  getIdToken: () => Promise<string>;
  onNotify: (msg: string | null, err?: string | null) => void;
}) {
  const [students, setStudents] = useState<AdminStudentOversightItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [inspectTarget, setInspectTarget] = useState<AdminStudentOversightItem | null>(null);
  const [justification, setJustification] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [sensitiveDetail, setSensitiveDetail] = useState<{
    student: Record<string, unknown>;
    applications: Array<{ id: string; scholarshipTitle: string; status: string; deadline?: string }>;
    documents: Array<{ id: string; documentType: string; processingStatus: string; errorDetails?: string }>;
  } | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const token = await getIdToken();
        const res = await getProtectedApi<{ students: AdminStudentOversightItem[] }>(
          '/api/admin/students',
          token
        );
        setStudents(res.students);
      } catch (err) {
        onNotify(null, err instanceof Error ? err.message : 'Failed to load student oversight.');
      } finally {
        setLoading(false);
      }
    })();
  }, [getIdToken]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return students;
    return students.filter((s) =>
      `${s.displayName} ${s.maskedEmail} ${s.uid} ${s.state || ''}`.toLowerCase().includes(q)
    );
  }, [students, search]);

  const handleAuditedAccess = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inspectTarget) return;
    setInspecting(true);
    onNotify(null, null);
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{
        student: Record<string, unknown>;
        applications: Array<{ id: string; scholarshipTitle: string; status: string; deadline?: string }>;
        documents: Array<{ id: string; documentType: string; processingStatus: string; errorDetails?: string }>;
      }>(`/api/admin/students/${inspectTarget.uid}/sensitive-access`, token, {
        justification: justification.trim(),
      });
      setSensitiveDetail(res);
      onNotify(`Audited access logged for student ${inspectTarget.uid} in admin_audit_logs.`, null);
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Sensitive record inspection rejected.');
    } finally {
      setInspecting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="surface-card rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
            <Users className="w-4 h-4 text-indigo-400" />
            <span>Student &amp; Application Operational Oversight (<span className="font-mono-num">{students.length}</span>)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Privacy-preserving view: raw passwords, tokens, and identity document previews are never exposed. Support inspection requires written justification and creates an audit log.
          </p>
        </div>
        <div className="relative w-full sm:w-64 shrink-0">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name, state, UID..."
            className="input-midnight w-full pl-8 pr-3 py-2 text-xs rounded-xl"
          />
        </div>
      </div>

      <div className="surface-card rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[#070C1B] border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">Student (Sanitized)</th>
                <th className="py-3.5 px-4">Onboarding &amp; State</th>
                <th className="py-3.5 px-4">Applications</th>
                <th className="py-3.5 px-4">Documents</th>
                <th className="py-3.5 px-4">TrustGuard Status</th>
                <th className="py-3.5 px-4 text-right">Support Access</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-400">Loading sanitized student records...</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-400">No matching student records.</td>
                </tr>
              ) : (
                filtered.map((s) => (
                  <tr key={s.uid} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3.5 px-4">
                      <p className="font-semibold text-white">{s.displayName}</p>
                      <p className="text-[11px] font-mono-num text-slate-400 mt-0.5">{s.maskedEmail}</p>
                    </td>
                    <td className="py-3.5 px-4">
                      <p className="text-slate-200 font-medium">{s.accountStatus}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5">{s.state || 'State unset'}</p>
                    </td>
                    <td className="py-3.5 px-4 font-mono-num text-slate-200">{s.applicationCount}</td>
                    <td className="py-3.5 px-4 font-mono-num text-slate-200">
                      {s.documentCount}{' '}
                      {s.failedDocumentCount > 0 && (
                        <span className="text-rose-300 font-semibold">({s.failedDocumentCount} attention)</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-slate-300">
                      {s.latestTrustGuardStatus || 'Not Assessed'}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setInspectTarget(s);
                          setSensitiveDetail(null);
                          setJustification('');
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-slate-200 bg-[#101933] border border-slate-700/80 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                      >
                        <Eye className="w-3 h-3 text-indigo-400" />
                        <span>Audited Inspect</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Audited Sensitive Student Access Modal */}
      <AnimatePresence>
        {inspectTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-[#02050D]/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              className="surface-elevated rounded-2xl max-w-xl w-full p-6 space-y-4 max-h-[85vh] overflow-y-auto"
            >
              <div className="flex items-start justify-between border-b border-slate-800 pb-3.5">
                <div>
                  <h3 className="text-base font-semibold text-white font-display">
                    Audited Operational Support Access
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5 font-mono-num">
                    Target: {inspectTarget.displayName} ({inspectTarget.uid})
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setInspectTarget(null)}
                  className="text-xs font-medium text-slate-400 hover:text-white whitespace-nowrap shrink-0"
                >
                  Close
                </button>
              </div>

              {!sensitiveDetail ? (
                <form onSubmit={handleAuditedAccess} className="space-y-4">
                  <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 leading-relaxed">
                    This action logs <code className="font-mono text-amber-100">Sensitive Student Record Accessed</code> to <code className="font-mono text-amber-100">admin_audit_logs</code>. Admins cannot alter student eligibility results or browse raw identity document files here.
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-300">
                      Support Justification (minimum 8 characters) *
                    </label>
                    <input
                      type="text"
                      required
                      minLength={8}
                      value={justification}
                      onChange={(e) => setJustification(e.target.value)}
                      placeholder="e.g. Investigating ticket #412 failed document job"
                      className="input-midnight w-full px-3 py-2 text-xs rounded-xl"
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setInspectTarget(null)}
                      className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#101933] border border-slate-700/80 hover:bg-slate-800 rounded-xl whitespace-nowrap shrink-0"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={inspecting || justification.trim().length < 8}
                      className="btn-primary-gradient px-4 py-2 text-xs font-semibold rounded-xl disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      {inspecting ? 'Logging & Fetching...' : 'Log Audit & View Operational Details'}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="space-y-4 text-xs">
                  <div className="p-3.5 rounded-xl bg-[#070C1B]/80 border border-slate-800 space-y-1">
                    <p className="font-semibold text-white">Profile Metadata (Non-Credential)</p>
                    <p className="text-slate-300">
                      State: {String(sensitiveDetail.student.state || 'Unset')} · District: {String(sensitiveDetail.student.district || 'Unset')} · Level: {String(sensitiveDetail.student.educationLevel || 'Unset')} · Course: {String(sensitiveDetail.student.courseSpecialization || 'Unset')}
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-white mb-2">
                      Tracked Applications (<span className="font-mono-num">{sensitiveDetail.applications.length}</span>)
                    </p>
                    {sensitiveDetail.applications.length === 0 ? (
                      <p className="text-slate-400">No applications tracked.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {sensitiveDetail.applications.map((a) => (
                          <li key={a.id} className="p-2.5 rounded-xl bg-[#070C1B]/80 border border-slate-800 flex justify-between gap-2">
                            <span className="font-medium text-slate-200">{a.scholarshipTitle}</span>
                            <span className="text-indigo-300 font-semibold whitespace-nowrap">{a.status}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <p className="font-semibold text-white mb-2">
                      Document Jobs (<span className="font-mono-num">{sensitiveDetail.documents.length}</span>)
                    </p>
                    {sensitiveDetail.documents.length === 0 ? (
                      <p className="text-slate-400">No documents uploaded.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {sensitiveDetail.documents.map((d) => (
                          <li key={d.id} className="p-2.5 rounded-xl bg-[#070C1B]/80 border border-slate-800 flex justify-between gap-2">
                            <span className="font-medium text-slate-200">{d.documentType}</span>
                            <span className="text-slate-300 font-mono-num">{d.processingStatus}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ============================================================================
// 3. Document Processing Monitor & Real Backend Retry
// ============================================================================

export function AdminDocumentMonitorPanel({
  getIdToken,
  onNotify,
}: {
  getIdToken: () => Promise<string>;
  onNotify: (msg: string | null, err?: string | null) => void;
}) {
  interface JobRow {
    id: string;
    userId: string;
    documentType: string;
    fileName: string;
    processingStatus: string;
    verificationStatus: string;
    errorDetails?: string;
    extractionMethod?: string;
    pageCount?: number;
    updatedAt: string;
  }
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [repeatedFailures, setRepeatedFailures] = useState<Array<{ pattern: string; count: number }>>([]);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadJobs = async () => {
    setLoading(true);
    try {
      const token = await getIdToken();
      const res = await getProtectedApi<{
        jobs: JobRow[];
        repeatedFailures: Array<{ pattern: string; count: number }>;
      }>('/api/admin/documents/monitor', token);
      setJobs(res.jobs);
      setRepeatedFailures(res.repeatedFailures);
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to load document monitor.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadJobs();
  }, []);

  const handleRetry = async (docId: string) => {
    setRetryingId(docId);
    onNotify(null, null);
    try {
      const token = await getIdToken();
      const res = await postProtectedAi<{ success: boolean; error?: string; document: JobRow }>(
        `/api/admin/documents/${docId}/retry`,
        token,
        {}
      );
      await loadJobs();
      onNotify(
        `Document ${docId} re-processed via OCR/Gemini pipeline (${res.document.processingStatus}).`,
        null
      );
    } catch (err) {
      await loadJobs();
      onNotify(
        null,
        err instanceof Error
          ? `Retry failed genuinely (status remains Failed): ${err.message}`
          : 'Document retry failed.'
      );
    } finally {
      setRetryingId(null);
    }
  };

  const visibleJobs = useMemo(
    () => jobs.filter((j) => statusFilter === 'ALL' || j.processingStatus === statusFilter),
    [jobs, statusFilter]
  );

  return (
    <div className="space-y-6">
      <div className="surface-card rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
            <Activity className="w-4 h-4 text-indigo-400" />
            <span>Document Processing Monitor (<span className="font-mono-num">{jobs.length}</span> jobs)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Retrying a job invokes the real Firebase Storage + OCR + Gemini analysis pipeline and never fakes a Completed status.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="input-midnight px-3 py-2 text-xs rounded-xl"
          >
            <option value="ALL" className="bg-[#0B1224] text-slate-100">All Statuses</option>
            <option value="Pending" className="bg-[#0B1224] text-slate-100">Pending</option>
            <option value="Processing" className="bg-[#0B1224] text-slate-100">Processing</option>
            <option value="Completed" className="bg-[#0B1224] text-slate-100">Completed</option>
            <option value="Needs Review" className="bg-[#0B1224] text-slate-100">Needs Review</option>
            <option value="Failed" className="bg-[#0B1224] text-slate-100">Failed</option>
          </select>
          <button
            type="button"
            onClick={() => void loadJobs()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-[#101933] border border-slate-700/80 rounded-xl hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5 text-slate-300" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {repeatedFailures.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 space-y-2 text-xs">
          <p className="font-semibold text-amber-200 flex items-center gap-1.5">
            <FileWarning className="w-4 h-4 text-amber-400" />
            <span>Repeated Failure Patterns</span>
          </p>
          <ul className="space-y-1 text-amber-100/90">
            {repeatedFailures.slice(0, 5).map((rf) => (
              <li key={rf.pattern} className="font-mono-num">
                [{rf.count}x] {rf.pattern}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="surface-card rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[#070C1B] border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">Job &amp; Category</th>
                <th className="py-3.5 px-4">Processing Status</th>
                <th className="py-3.5 px-4">Extraction / Pages</th>
                <th className="py-3.5 px-4">Failure / Diagnostics</th>
                <th className="py-3.5 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {loading ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-slate-400">Loading document jobs...</td>
                </tr>
              ) : visibleJobs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-slate-400">No document jobs found.</td>
                </tr>
              ) : (
                visibleJobs.map((j) => (
                  <tr key={j.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3.5 px-4">
                      <p className="font-semibold text-white">{j.documentType}</p>
                      <p className="text-[11px] font-mono-num text-slate-400 mt-0.5">
                        {j.id} · Owner: {j.userId.slice(0, 10)}...
                      </p>
                    </td>
                    <td className="py-3.5 px-4 font-semibold">
                      <span
                        className={
                          j.processingStatus === 'Failed'
                            ? 'text-rose-300'
                            : j.processingStatus === 'Needs Review'
                              ? 'text-amber-300'
                              : j.processingStatus === 'Completed'
                                ? 'text-emerald-300'
                                : 'text-slate-300'
                        }
                      >
                        {j.processingStatus}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 font-mono-num text-slate-300">
                      {j.extractionMethod || 'Pending'} ({j.pageCount ?? 1}p)
                    </td>
                    <td className="py-3.5 px-4 text-slate-400 max-w-xs truncate">
                      {j.errorDetails || '—'}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <button
                        type="button"
                        disabled={retryingId === j.id}
                        onClick={() => void handleRetry(j.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-slate-200 bg-[#101933] border border-slate-700/80 hover:bg-slate-800 rounded-lg disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                      >
                        <RefreshCw className={`w-3 h-3 text-indigo-400 ${retryingId === j.id ? 'animate-spin' : ''}`} />
                        <span>{retryingId === j.id ? 'Running OCR...' : 'Retry Real Job'}</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 4. TrustGuard Monitor & Scam Moderation Panel
// ============================================================================

export function AdminTrustGuardMonitorPanel({
  getIdToken,
  onNotify,
}: {
  getIdToken: () => Promise<string>;
  onNotify: (msg: string | null, err?: string | null) => void;
}) {
  const [reports, setReports] = useState<TrustGuardReport[]>([]);
  const [summary, setSummary] = useState<TrustGuardSystemSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMonitor = async () => {
    setLoading(true);
    try {
      const token = await getIdToken();
      const res = await getProtectedApi<{
        reports: TrustGuardReport[];
        systemSummary: TrustGuardSystemSummary;
      }>('/api/admin/trustguard/monitor', token);
      setReports(res.reports);
      setSummary(res.systemSummary);
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to load TrustGuard monitor.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMonitor();
  }, []);

  const handleModerate = async (report: TrustGuardReport, status: TrustGuardReport['status']) => {
    onNotify(null, null);
    try {
      const token = await getIdToken();
      await postProtectedAi(`/api/admin/trustguard/reports/${report.id}/moderate`, token, {
        status,
        adminNotes: `Moderated to ${status} via Admin Control Center`,
      });
      await loadMonitor();
      onNotify(`Moderated TrustGuard report ${report.id} to ${status}.`, null);
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Moderation failed.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="p-4 rounded-2xl bg-[#0B1224] border border-slate-800 text-xs text-slate-300 leading-relaxed">
        <strong className="text-white">Governance Boundary:</strong> TrustGuard findings reflect consistency or readability discrepancies across uploaded files. Admins must never edit extracted document evidence or label students as fraudulent based solely on consistency mismatches.
      </div>

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="surface-card rounded-2xl p-4">
            <p className="text-[11px] text-slate-400">Critical / High Findings</p>
            <p className="text-xl font-bold text-rose-300 font-mono-num mt-1.5">
              <AnimatedCounter value={summary.severityCounts.critical + summary.severityCounts.high} />
            </p>
          </div>
          <div className="surface-card rounded-2xl p-4">
            <p className="text-[11px] text-slate-400">Medium / Low Findings</p>
            <p className="text-xl font-bold text-amber-300 font-mono-num mt-1.5">
              <AnimatedCounter value={summary.severityCounts.medium + summary.severityCounts.low} />
            </p>
          </div>
          <div className="surface-card rounded-2xl p-4">
            <p className="text-[11px] text-slate-400">Awaiting Student Review</p>
            <p className="text-xl font-bold text-white font-mono-num mt-1.5">
              <AnimatedCounter value={summary.awaitingReviewCount} />
            </p>
          </div>
          <div className="surface-card rounded-2xl p-4">
            <p className="text-[11px] text-slate-400">Resolved Findings</p>
            <p className="text-xl font-bold text-emerald-300 font-mono-num mt-1.5">
              <AnimatedCounter value={summary.resolvedCount} />
            </p>
          </div>
          <div className="surface-card rounded-2xl p-4">
            <p className="text-[11px] text-slate-400">Analysis Failures / Manual</p>
            <p className="text-xl font-bold text-orange-300 font-mono-num mt-1.5">
              <AnimatedCounter value={summary.analysisFailuresCount} />
            </p>
          </div>
        </div>
      )}

      {summary && summary.repeatedCategories.length > 0 && (
        <div className="surface-card rounded-2xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-white font-display">
            Repeated System-Wide Discrepancy Categories
          </h3>
          <div className="flex flex-wrap gap-2 text-xs">
            {summary.repeatedCategories.map((cat) => (
              <span key={cat.category} className="px-3 py-1.5 rounded-lg bg-[#070C1B]/80 border border-slate-800 text-slate-200 font-mono-num">
                {cat.category}: <strong className="text-white">{cat.count}</strong>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="surface-card rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-white font-display flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>Student Scam &amp; Link Moderation Queue (<span className="font-mono-num">{reports.length}</span>)</span>
        </h3>
        {loading ? (
          <div className="space-y-3">
            <SkeletonCard className="h-20" />
            <SkeletonCard className="h-20" />
          </div>
        ) : reports.length === 0 ? (
          <p className="text-xs text-slate-400">No student scam reports submitted yet.</p>
        ) : (
          <div className="space-y-3">
            {reports.map((rep) => (
              <div
                key={rep.id}
                className="p-4 rounded-xl bg-[#070C1B]/80 border border-slate-800 flex flex-wrap items-center justify-between gap-4 text-xs"
              >
                <div className="space-y-1 min-w-0 flex-1">
                  <p className="font-medium text-white break-all">{rep.submittedUrlOrText}</p>
                  <p className="text-slate-400">
                    Risk: <strong className="text-slate-200">{rep.riskLevel}</strong> · Status: <strong className="text-slate-200">{rep.status}</strong>
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={rep.status === 'Confirmed Scam'}
                    onClick={() => void handleModerate(rep, 'Under Review')}
                    className="px-3 py-1.5 font-medium text-slate-200 bg-[#101933] border border-slate-700/80 rounded-lg hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                  >
                    Under Review
                  </button>
                  <button
                    type="button"
                    disabled={rep.status === 'Confirmed Scam'}
                    onClick={() => void handleModerate(rep, 'Verified Safe')}
                    className="px-3 py-1.5 font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                  >
                    Verify Safe
                  </button>
                  <button
                    type="button"
                    disabled={rep.status === 'Confirmed Scam'}
                    onClick={() => void handleModerate(rep, 'Confirmed Scam')}
                    className="px-3 py-1.5 font-medium bg-rose-600 text-white rounded-lg hover:bg-rose-500 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                  >
                    Confirm Scam
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 5. Immutable Admin Audit Logs Panel
// ============================================================================

export function AdminAuditLogsPanel({
  getIdToken,
  onNotify,
}: {
  getIdToken: () => Promise<string>;
  onNotify: (msg: string | null, err?: string | null) => void;
}) {
  const [logs, setLogs] = useState<AdminAuditLogRecord[]>([]);
  const [filterAction, setFilterAction] = useState('ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const loadLogs = async () => {
    setLoading(true);
    try {
      const token = await getIdToken();
      const res = await getProtectedApi<{ logs: AdminAuditLogRecord[] }>('/api/admin/audit-logs', token);
      setLogs(res.logs);
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to load audit logs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadLogs();
  }, []);

  const uniqueActions = useMemo(() => Array.from(new Set(logs.map((l) => l.action))), [logs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter((l) => {
      if (filterAction !== 'ALL' && l.action !== filterAction) return false;
      if (q) {
        return `${l.adminEmail} ${l.action} ${l.entityId} ${l.summary}`.toLowerCase().includes(q);
      }
      return true;
    });
  }, [logs, filterAction, search]);

  return (
    <div className="space-y-6">
      <div className="surface-card rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-indigo-400" />
            <span>Immutable Admin Audit Logs (<span className="font-mono-num">{logs.length}</span>)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1 flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span>Append-only governance ledger. Edits and deletions are blocked in both Firestore Security Rules and API middleware.</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search admin, entity, summary..."
            className="input-midnight px-3 py-2 text-xs rounded-xl"
          />
          <select
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
            className="input-midnight px-3 py-2 text-xs rounded-xl"
          >
            <option value="ALL" className="bg-[#0B1224] text-slate-100">All Actions</option>
            {uniqueActions.map((a) => (
              <option key={a} value={a} className="bg-[#0B1224] text-slate-100">{a}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="surface-card rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[#070C1B] border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">Timestamp</th>
                <th className="py-3.5 px-4">Actor</th>
                <th className="py-3.5 px-4">Action &amp; Target</th>
                <th className="py-3.5 px-4">Summary &amp; Changes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {loading ? (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-slate-400">Loading immutable audit log...</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-slate-400">No audit records match filter.</td>
                </tr>
              ) : (
                filtered.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3.5 px-4 whitespace-nowrap font-mono-num text-slate-400">
                      {new Date(log.createdAt).toLocaleString('en-IN')}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <p className="font-semibold text-white">{log.adminEmail}</p>
                      <p className="text-[11px] font-mono-num text-indigo-300 uppercase mt-0.5">{log.adminRole}</p>
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <p className="font-semibold text-slate-200">{log.action}</p>
                      <p className="text-[11px] font-mono-num text-slate-400 mt-0.5">
                        {log.entityType}:{log.entityId}
                      </p>
                    </td>
                    <td className="py-3.5 px-4 max-w-md">
                      <p className="text-slate-200">{log.summary}</p>
                      {log.changesSummary && (
                        <p className="text-[11px] text-slate-400 mt-0.5">{log.changesSummary}</p>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 6. Admin Settings & Super Admin RBAC Role Management Panel
// ============================================================================

export function AdminSettingsRbacPanel({
  isSuperAdmin,
  userEmail,
  getIdToken,
  onNotify,
}: {
  isSuperAdmin: boolean;
  userEmail: string;
  getIdToken: () => Promise<string>;
  onNotify: (msg: string | null, err?: string | null) => void;
}) {
  const [roles, setRoles] = useState<UserRoleRecord[]>([]);
  const [bootstrapEmail, setBootstrapEmail] = useState('');
  const [targetEmail, setTargetEmail] = useState('');
  const [newRole, setNewRole] = useState<AppRole>('admin');
  const [newStatus, setNewStatus] = useState<'active' | 'disabled'>('active');
  const [submitting, setSubmitting] = useState(false);

  const loadRoles = async () => {
    try {
      const token = await getIdToken();
      const res = await getProtectedApi<{
        roles: UserRoleRecord[];
        bootstrapSuperAdminEmail: string;
      }>('/api/admin/roles', token);
      setRoles(res.roles);
      setBootstrapEmail(res.bootstrapSuperAdminEmail);
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Failed to load RBAC directory.');
    }
  };

  useEffect(() => {
    void loadRoles();
  }, []);

  const handleAssignRole = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    onNotify(null, null);
    try {
      const token = await getIdToken();
      await postProtectedAi('/api/admin/roles', token, {
        targetEmail: targetEmail.trim(),
        role: newRole,
        status: newStatus,
      });
      setTargetEmail('');
      await loadRoles();
      onNotify(`Assigned role "${newRole}" (${newStatus}) and recorded Role Updated audit log.`, null);
    } catch (err) {
      onNotify(null, err instanceof Error ? err.message : 'Role update failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="surface-card rounded-2xl p-6 space-y-4">
        <h2 className="text-base font-semibold text-white font-display flex items-center gap-2">
          <UserCheck className="w-4 h-4 text-indigo-400" />
          <span>Role-Based Access Control (RBAC) &amp; Governance Settings</span>
        </h2>
        <div className="grid sm:grid-cols-3 gap-4 text-xs">
          <div className="p-4 rounded-xl bg-[#070C1B]/80 border border-slate-800">
            <p className="text-slate-400">Current Session</p>
            <p className="font-semibold text-white mt-1.5 break-all">{userEmail}</p>
            <p className="text-[11px] font-mono-num text-indigo-300 mt-1 uppercase">
              {isSuperAdmin ? 'super_admin' : 'admin'}
            </p>
          </div>
          <div className="p-4 rounded-xl bg-[#070C1B]/80 border border-slate-800">
            <p className="text-slate-400">Bootstrap Super Admin</p>
            <p className="font-semibold text-white mt-1.5 font-mono-num break-all">{bootstrapEmail || 'Configured'}</p>
            <p className="text-[11px] text-emerald-300 mt-1">Email verification enforced</p>
          </div>
          <div className="p-4 rounded-xl bg-[#070C1B]/80 border border-slate-800">
            <p className="text-slate-400">Public Registration Rule</p>
            <p className="font-semibold text-white mt-1.5">Student Role Only</p>
            <p className="text-[11px] text-slate-400 mt-1">Frontend role claims ignored</p>
          </div>
        </div>
      </div>

      {isSuperAdmin ? (
        <form onSubmit={handleAssignRole} className="surface-card rounded-2xl p-6 space-y-4">
          <h3 className="text-sm font-semibold text-white font-display">
            Assign or Update Role (Super Admin Only)
          </h3>
          <div className="grid sm:grid-cols-4 gap-3">
            <input
              type="email"
              required
              value={targetEmail}
              onChange={(e) => setTargetEmail(e.target.value)}
              placeholder="Existing registered user email *"
              className="input-midnight sm:col-span-2 px-3 py-2 text-xs rounded-xl"
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as AppRole)}
              className="input-midnight px-3 py-2 text-xs rounded-xl"
            >
              <option value="admin" className="bg-[#0B1224] text-slate-100">Admin</option>
              <option value="super_admin" className="bg-[#0B1224] text-slate-100">Super Admin</option>
              <option value="student" className="bg-[#0B1224] text-slate-100">Student (Demote)</option>
            </select>
            <select
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value as 'active' | 'disabled')}
              className="input-midnight px-3 py-2 text-xs rounded-xl"
            >
              <option value="active" className="bg-[#0B1224] text-slate-100">Active</option>
              <option value="disabled" className="bg-[#0B1224] text-slate-100">Disabled</option>
            </select>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="btn-primary-gradient px-4 py-2 text-xs font-semibold rounded-xl disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              {submitting ? 'Updating user_roles...' : 'Apply Role Assignment'}
            </button>
          </div>
        </form>
      ) : (
        <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-start gap-2.5 leading-relaxed">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          <span>
            You are signed in as a standard <strong className="text-white">Admin</strong>. Assigning, promoting, demoting, or disabling admin accounts is restricted strictly to an authorized <strong className="text-white">Super Admin</strong>.
          </span>
        </div>
      )}

      <div className="surface-card rounded-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 bg-[#070C1B]">
          <h3 className="text-xs font-semibold text-slate-200">
            Assigned Roles Directory (<span className="font-mono-num">{roles.length}</span>)
          </h3>
        </div>
        <div className="divide-y divide-slate-800/70 text-xs">
          {roles.length === 0 ? (
            <p className="p-8 text-slate-400 text-center">No additional entries in user_roles beyond bootstrap Super Admin.</p>
          ) : (
            roles.map((r) => (
              <div key={r.uid} className="p-4 flex flex-wrap items-center justify-between gap-3 hover:bg-slate-800/20 transition-colors">
                <div>
                  <p className="font-semibold text-white">{r.email || r.uid}</p>
                  <p className="text-[11px] font-mono-num text-slate-400 mt-0.5">
                    UID: {r.uid} · Assigned by: {r.assignedByEmail || r.assignedBy || 'System'}
                  </p>
                </div>
                <div className="flex items-center gap-2 font-mono-num">
                  <span className="px-2.5 py-0.5 rounded-md border border-indigo-500/30 bg-indigo-500/10 font-semibold text-indigo-200">
                    {r.role}
                  </span>
                  <span
                    className={`px-2.5 py-0.5 rounded-md border text-[11px] font-semibold ${
                      r.status === 'disabled'
                        ? 'text-rose-300 bg-rose-500/10 border-rose-500/30'
                        : 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
                    }`}
                  >
                    {r.status || 'active'}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
