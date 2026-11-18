import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  Database,
  FileCheck2,
  LayoutDashboard,
  Megaphone,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  UserCheck,
  Users,
} from 'lucide-react';
import { AppShell } from '../components/AppShell.tsx';
import { PageTransition } from '../components/ui/MotionPrimitives.tsx';
import { AdminAnnouncementsPanel } from '../components/admin/AdminAnnouncementsPanel.tsx';
import {
  AdminDataQualityPanel,
  AdminEligibilityRulesPanel,
  AdminScholarshipsPanel,
  AdminVerificationQueuePanel,
} from '../components/admin/AdminCatalogAndVerification.tsx';
import {
  AdminAuditLogsPanel,
  AdminDocumentMonitorPanel,
  AdminOverviewPanel,
  AdminSettingsRbacPanel,
  AdminStudentOversightPanel,
  AdminTrustGuardMonitorPanel,
} from '../components/admin/AdminOperationsPanels.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { getCachedProtectedApi, postProtectedAi } from '../lib/apiClient.ts';
import { invalidateUserCache, peekPublicCache, peekUserCache } from '../lib/workspaceCache.ts';
import type {
  AdminAuditLogRecord,
  AdminDashboardMetrics,
  Scholarship,
} from '../types/database.ts';

type AdminTabKey =
  | 'overview'
  | 'scholarships'
  | 'verification'
  | 'rules'
  | 'quality'
  | 'students'
  | 'documents'
  | 'trustguard'
  | 'announcements'
  | 'audit'
  | 'settings';

const ADMIN_TABS: Array<{ key: AdminTabKey; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'scholarships', label: 'Scholarships', icon: Database },
  { key: 'verification', label: 'Verification Queue', icon: ShieldCheck },
  { key: 'rules', label: 'Eligibility Rules', icon: SlidersHorizontal },
  { key: 'quality', label: 'Data Quality', icon: FileCheck2 },
  { key: 'students', label: 'Students & Apps', icon: Users },
  { key: 'documents', label: 'Document Monitor', icon: Activity },
  { key: 'trustguard', label: 'TrustGuard Monitor', icon: ShieldCheck },
  { key: 'announcements', label: 'Announcements & Alerts', icon: Megaphone },
  { key: 'audit', label: 'Audit Logs', icon: ClipboardList },
  { key: 'settings', label: 'RBAC & Settings', icon: UserCheck },
];

export default function AdminDashboardPage() {
  const { user, isSuperAdmin, getIdToken } = useAuth();
  const cachedOverview = peekUserCache<{
    metrics: AdminDashboardMetrics;
    recentAuditLogs: AdminAuditLogRecord[];
  }>(user?.uid, 'api:/api/admin/overview');
  const cachedAdminSch = peekUserCache<{ scholarships: Scholarship[] }>(
    user?.uid,
    'api:/api/admin/scholarships'
  );
  const cachedPublicSch = peekPublicCache<{ items: Scholarship[] }>('scholarships');

  const [activeTab, setActiveTab] = useState<AdminTabKey>('overview');
  const [metrics, setMetrics] = useState<AdminDashboardMetrics | null>(
    () => cachedOverview?.metrics ?? null
  );
  const [recentAuditLogs, setRecentAuditLogs] = useState<AdminAuditLogRecord[]>(
    () => cachedOverview?.recentAuditLogs ?? []
  );
  const [scholarships, setScholarships] = useState<Scholarship[]>(
    () => cachedAdminSch?.scholarships ?? cachedPublicSch?.items ?? []
  );
  const [preselectedScholarshipId, setPreselectedScholarshipId] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !(user && cachedOverview && cachedAdminSch));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleNotify = useCallback((msg: string | null, err: string | null = null) => {
    setMessage(msg);
    setError(err);
  }, []);

  const loadGovernanceData = useCallback(async (forceRefresh = false) => {
    if (!user) return;
    if (forceRefresh) {
      invalidateUserCache(user.uid, 'api:/api/admin');
      setLoading(true);
    } else if (!peekUserCache(user.uid, 'api:/api/admin/overview')) {
      setLoading(true);
    }
    setError(null);
    try {
      const [overviewRes, schRes] = await Promise.all([
        getCachedProtectedApi<{
          metrics: AdminDashboardMetrics;
          recentAuditLogs: AdminAuditLogRecord[];
        }>(user.uid, '/api/admin/overview', getIdToken, 30_000),
        getCachedProtectedApi<{ scholarships: Scholarship[] }>(
          user.uid,
          '/api/admin/scholarships',
          getIdToken,
          30_000
        ),
      ]);
      setMetrics(overviewRes.metrics);
      setRecentAuditLogs(overviewRes.recentAuditLogs);
      setScholarships(schRes.scholarships);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Admin Control Center data.');
    } finally {
      setLoading(false);
    }
  }, [user, getIdToken]);

  const forceReloadGovernanceData = useCallback(
    () => loadGovernanceData(true),
    [loadGovernanceData]
  );

  useEffect(() => {
    void loadGovernanceData(false);
  }, [loadGovernanceData]);

  // Verify admin access on server and record audited access once per browser session
  useEffect(() => {
    if (!user || typeof window === 'undefined') return;
    const sessionKey = `grantly_admin_access_logged_${user.uid}`;
    if (window.sessionStorage.getItem(sessionKey)) return;

    (async () => {
      try {
        const token = await getIdToken();
        await postProtectedAi('/api/admin/session/log', token, {
          action: 'Admin Access Verified',
        });
        window.sessionStorage.setItem(sessionKey, '1');
      } catch {
        // Server rejects unauthorized access cleanly; UI ProtectedRoute handles non-admins
      }
    })();
  }, [user, getIdToken]);

  return (
    <AppShell
      title="Admin Control Center"
      breadcrumb={`Governance / ${isSuperAdmin ? 'Super Admin' : 'Admin'} Operations`}
      primaryAction={
        <button
          type="button"
          onClick={() => void forceReloadGovernanceData()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-200 bg-[#101933] border border-slate-700/80 hover:bg-slate-800 rounded-xl transition-colors disabled:opacity-60 whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-indigo-400' : 'text-slate-300'}`} />
          <span>{loading ? 'Refreshing...' : 'Refresh Metrics'}</span>
        </button>
      }
    >
      <PageTransition className="space-y-6">
        {/* Governance Section Switcher */}
        <div
          className="surface-card rounded-2xl p-2 flex flex-wrap items-center gap-1.5"
          role="tablist"
          aria-label="Admin Control Center Modules"
        >
          {ADMIN_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setActiveTab(tab.key);
                  setMessage(null);
                  setError(null);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-white'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 shrink-0 ${active ? 'text-white' : 'text-slate-400'}`} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {message && (
          <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs sm:text-sm text-emerald-200 flex items-center gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{message}</span>
          </div>
        )}

        {error && (
          <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs sm:text-sm text-rose-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={() => void forceReloadGovernanceData()}
              className="px-3 py-1 text-xs font-semibold rounded-lg bg-rose-500/20 border border-rose-400/40 text-rose-100 hover:bg-rose-500/30 shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {activeTab === 'overview' && (
          <AdminOverviewPanel
            metrics={metrics}
            recentAuditLogs={recentAuditLogs}
            onNavigateTab={(tab) => setActiveTab(tab as AdminTabKey)}
          />
        )}

        {activeTab === 'scholarships' && (
          <AdminScholarshipsPanel
            scholarships={scholarships}
            getIdToken={getIdToken}
            onReload={forceReloadGovernanceData}
            onNotify={handleNotify}
            onOpenVerification={(schId) => {
              setPreselectedScholarshipId(schId);
              setActiveTab('verification');
            }}
            onOpenRules={(schId) => {
              setPreselectedScholarshipId(schId);
              setActiveTab('rules');
            }}
          />
        )}

        {activeTab === 'verification' && (
          <AdminVerificationQueuePanel
            scholarships={scholarships}
            preselectedScholarshipId={preselectedScholarshipId}
            getIdToken={getIdToken}
            onReload={forceReloadGovernanceData}
            onNotify={handleNotify}
          />
        )}

        {activeTab === 'rules' && (
          <AdminEligibilityRulesPanel
            scholarships={scholarships}
            preselectedScholarshipId={preselectedScholarshipId}
            getIdToken={getIdToken}
            onReload={forceReloadGovernanceData}
            onNotify={handleNotify}
          />
        )}

        {activeTab === 'quality' && (
          <AdminDataQualityPanel
            getIdToken={getIdToken}
            onNotify={handleNotify}
            onOpenScholarshipVerify={(schId) => {
              setPreselectedScholarshipId(schId);
              setActiveTab('verification');
            }}
          />
        )}

        {activeTab === 'students' && (
          <AdminStudentOversightPanel
            getIdToken={getIdToken}
            onNotify={handleNotify}
          />
        )}

        {activeTab === 'documents' && (
          <AdminDocumentMonitorPanel
            getIdToken={getIdToken}
            onNotify={handleNotify}
          />
        )}

        {activeTab === 'trustguard' && (
          <AdminTrustGuardMonitorPanel
            getIdToken={getIdToken}
            onNotify={handleNotify}
          />
        )}

        {activeTab === 'announcements' && (
          <AdminAnnouncementsPanel
            getIdToken={getIdToken}
            onNotify={handleNotify}
          />
        )}

        {activeTab === 'audit' && (
          <AdminAuditLogsPanel
            getIdToken={getIdToken}
            onNotify={handleNotify}
          />
        )}

        {activeTab === 'settings' && (
          <AdminSettingsRbacPanel
            isSuperAdmin={isSuperAdmin}
            userEmail={user?.email || ''}
            getIdToken={getIdToken}
            onNotify={handleNotify}
          />
        )}
      </PageTransition>
    </AppShell>
  );
}
