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
import { getProtectedApi, postProtectedAi } from '../lib/apiClient.ts';
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
  const [activeTab, setActiveTab] = useState<AdminTabKey>('overview');
  const [metrics, setMetrics] = useState<AdminDashboardMetrics | null>(null);
  const [recentAuditLogs, setRecentAuditLogs] = useState<AdminAuditLogRecord[]>([]);
  const [scholarships, setScholarships] = useState<Scholarship[]>([]);
  const [preselectedScholarshipId, setPreselectedScholarshipId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleNotify = useCallback((msg: string | null, err: string | null = null) => {
    setMessage(msg);
    setError(err);
  }, []);

  const loadGovernanceData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await getIdToken();
      const [overviewRes, schRes] = await Promise.all([
        getProtectedApi<{
          metrics: AdminDashboardMetrics;
          recentAuditLogs: AdminAuditLogRecord[];
        }>('/api/admin/overview', token),
        getProtectedApi<{ scholarships: Scholarship[] }>('/api/admin/scholarships', token),
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

  useEffect(() => {
    void loadGovernanceData();
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
          onClick={() => void loadGovernanceData()}
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
          <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs sm:text-sm text-rose-200 flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{error}</span>
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
            onReload={loadGovernanceData}
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
            onReload={loadGovernanceData}
            onNotify={handleNotify}
          />
        )}

        {activeTab === 'rules' && (
          <AdminEligibilityRulesPanel
            scholarships={scholarships}
            preselectedScholarshipId={preselectedScholarshipId}
            getIdToken={getIdToken}
            onReload={loadGovernanceData}
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
