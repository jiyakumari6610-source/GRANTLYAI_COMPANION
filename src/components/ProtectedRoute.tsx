import React, { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { MailCheck, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
}

export function ProtectedRoute({ children, requireAdmin = false }: ProtectedRouteProps) {
  const { user, isAdmin, loading, resendVerificationEmail, refreshProfile, logout } = useAuth();
  const location = useLocation();
  const [resending, setResending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#050914] flex items-center justify-center p-6 ambient-mesh">
        <div className="w-full max-w-md space-y-4">
          <div className="h-5 w-36 rounded-lg skeleton-shimmer" />
          <div className="h-28 w-full rounded-2xl border border-slate-800 skeleton-shimmer" />
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Navigate
        to={requireAdmin ? '/admin/login' : '/login'}
        state={{ from: location.pathname }}
        replace
      />
    );
  }

  if (!user.emailVerified) {
    return (
      <div className="min-h-screen bg-[#050914] text-slate-100 flex items-center justify-center p-6 ambient-mesh">
        <div className="max-w-md w-full surface-elevated rounded-2xl p-6 sm:p-7 space-y-4">
          <div className="flex items-center gap-2.5 text-amber-300 font-semibold font-display">
            <MailCheck className="w-5 h-5 shrink-0" />
            <span>Email Verification Required</span>
          </div>
          <p className="text-sm text-slate-300 leading-relaxed">
            Your account ({user.email}) must verify its email address before accessing protected student records, document storage, or scholarship tools.
          </p>
          {notice && (
            <div className="p-3 rounded-xl bg-indigo-500/15 border border-indigo-400/30 text-xs text-indigo-200">
              {notice}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2.5 pt-2">
            <button
              type="button"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                setNotice(null);
                try {
                  await refreshProfile();
                  setNotice('Checked verification status. If still pending, click the link in your inbox first.');
                } finally {
                  setRefreshing(false);
                }
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-white btn-primary-gradient rounded-xl disabled:opacity-60"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span>I&apos;ve Verified — Refresh</span>
            </button>
            <button
              type="button"
              disabled={resending}
              onClick={async () => {
                setResending(true);
                setNotice(null);
                try {
                  await resendVerificationEmail();
                  setNotice('Verification email sent. Check your inbox and spam folder.');
                } catch {
                  setNotice('Please wait a moment before requesting another verification email.');
                } finally {
                  setResending(false);
                }
              }}
              className="px-3.5 py-2.5 text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-200 rounded-xl hover:bg-slate-700 disabled:opacity-60"
            >
              {resending ? 'Sending...' : 'Resend Verification'}
            </button>
            <button
              type="button"
              onClick={() => void logout()}
              className="px-3.5 py-2.5 text-xs font-semibold bg-rose-500/15 border border-rose-500/30 text-rose-200 rounded-xl hover:bg-rose-500/25"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (requireAdmin && !isAdmin) {
    return (
      <div className="min-h-screen bg-[#050914] text-slate-100 flex items-center justify-center p-6 ambient-mesh">
        <div className="max-w-md w-full surface-elevated rounded-2xl p-6 sm:p-7 space-y-4">
          <div className="flex items-center gap-2.5 text-rose-300 font-semibold font-display">
            <ShieldAlert className="w-5 h-5 shrink-0" />
            <span>Administrator Access Required</span>
          </div>
          <p className="text-sm text-slate-300 leading-relaxed">
            Your account ({user.email}) has student permissions. Admin operations such as editing the verified scholarship registry, reviewing data quality, and inspecting audit logs are restricted to authorized administrators verified on the server.
          </p>
          <div className="flex items-center gap-2 pt-2">
            <Link
              to="/dashboard"
              className="px-4 py-2.5 text-xs font-semibold text-white btn-primary-gradient rounded-xl"
            >
              Return to Student Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
