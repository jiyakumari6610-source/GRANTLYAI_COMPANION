import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { z } from 'zod';
import { AlertCircle, ArrowRight, LockKeyhole, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { postProtectedAi } from '../lib/apiClient.ts';
import { isSafeInternalPath } from '../lib/securityUtils.ts';

const adminLoginSchema = z.object({
  email: z.string().trim().email('Enter a valid administrator email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

export default function AdminLoginPage() {
  const { user, isAdmin, loading, signInWithGoogle, loginWithEmail, logout, getIdToken } =
    useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const rawFromPath = (location.state as { from?: string } | null)?.from;
  const fromPath = isSafeInternalPath(rawFromPath) && rawFromPath.startsWith('/admin') ? rawFromPath : '/admin';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [verifyingServerRole, setVerifyingServerRole] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleDeniedMessage, setRoleDeniedMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (loading || !user) return;

    if (!user.emailVerified) {
      setRoleDeniedMessage(
        `Your account (${user.email}) does not have a verified email address. Administrator access requires a verified account.`
      );
      return;
    }

    if (!isAdmin) {
      setRoleDeniedMessage(
        `Access Denied: ${user.email} holds Student permissions. Only authorized Admins or Super Admins listed in server RBAC (user_roles) can enter the Admin Control Center.`
      );
      return;
    }

    (async () => {
      setVerifyingServerRole(true);
      setError(null);
      try {
        const token = await getIdToken();
        await postProtectedAi('/api/admin/session/log', token, { action: 'Admin Login' });
        if (active) {
          navigate(fromPath, { replace: true });
        }
      } catch (err) {
        if (active) {
          setRoleDeniedMessage(
            err instanceof Error
              ? err.message
              : 'Server RBAC rejected administrator verification.'
          );
        }
      } finally {
        if (active) setVerifyingServerRole(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [user, isAdmin, loading, getIdToken, navigate, fromPath]);

  const handleGoogleAdminLogin = async () => {
    setError(null);
    setRoleDeniedMessage(null);
    setSubmitting(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEmailAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setRoleDeniedMessage(null);

    const parsed = adminLoginSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid administrator credentials.');
      return;
    }

    setSubmitting(true);
    try {
      await loginWithEmail(parsed.data.email, parsed.data.password);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes('auth/invalid-credential')) {
        setError('Invalid administrator email or password.');
      } else {
        setError(raw);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050914] text-slate-100 ambient-mesh grid-pattern-subtle flex flex-col justify-center py-12 px-4 sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="max-w-md w-full mx-auto space-y-6"
      >
        <div className="text-center space-y-2.5">
          <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-indigo-300">
            <LockKeyhole className="w-3.5 h-3.5 text-indigo-400" />
            <span>GRANTLY AI Governance</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white font-display tracking-tight">
            Admin Control Center Sign In
          </h1>
          <p className="text-sm text-slate-400">
            Server-verified authentication for Scholarship Data Governance, Verification, and System Operations.
          </p>
        </div>

        <div className="surface-elevated rounded-2xl p-6 sm:p-8 space-y-5">
          {roleDeniedMessage && (
            <div className="p-4 rounded-xl bg-rose-500/15 border border-rose-500/30 space-y-3">
              <div className="flex items-start gap-2.5 text-sm text-rose-200">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                <span>{roleDeniedMessage}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Link
                  to="/dashboard"
                  className="px-3 py-1.5 text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-200 rounded-lg hover:bg-slate-700"
                >
                  Return to Student Workspace
                </Link>
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="px-3 py-1.5 text-xs font-semibold bg-rose-600 text-white rounded-lg hover:bg-rose-500"
                >
                  Sign Out &amp; Switch Account
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="p-3.5 rounded-xl bg-rose-500/15 border border-rose-500/30 text-sm text-rose-200 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {verifyingServerRole ? (
            <div className="p-4 rounded-xl bg-indigo-500/10 border border-indigo-400/25 flex items-center gap-3 text-sm text-indigo-200">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Verifying administrator privileges and recording audit session...</span>
            </div>
          ) : (
            <>
              <button
                type="button"
                disabled={submitting}
                onClick={handleGoogleAdminLogin}
                className="w-full flex items-center justify-center gap-3 px-4 py-2.5 text-sm font-semibold text-slate-100 bg-slate-900/90 border border-slate-700/80 hover:border-indigo-400/50 hover:bg-slate-800/80 rounded-xl transition-all disabled:opacity-60"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z" />
                  <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z" />
                  <path fill="#FBBC05" d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z" />
                  <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z" />
                </svg>
                <span>Continue with Authorized Google Account</span>
              </button>

              <div className="relative flex items-center">
                <div className="flex-grow border-t border-slate-800" />
                <span className="shrink mx-3 text-xs text-slate-500">or administrator email</span>
                <div className="flex-grow border-t border-slate-800" />
              </div>

              <form onSubmit={handleEmailAdminLogin} className="space-y-4">
                <div>
                  <label htmlFor="admin-email" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Administrator Email
                  </label>
                  <input
                    id="admin-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@institution.org"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>

                <div>
                  <label htmlFor="admin-password" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Password
                  </label>
                  <input
                    id="admin-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter administrator password"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold btn-primary-gradient rounded-xl disabled:opacity-60"
                >
                  <span>{submitting ? 'Verifying Credentials...' : 'Sign In to Admin Center'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>
            </>
          )}

          <p className="text-[11px] text-slate-400 leading-relaxed border-t border-slate-800 pt-3">
            Public registration only creates Student accounts. Admin privileges are strictly verified server-side via <code className="font-mono text-indigo-300">user_roles</code> and all governance actions are recorded in immutable audit logs.
          </p>
        </div>

        <p className="text-center text-xs text-slate-400">
          Student applicant?{' '}
          <Link to="/login" className="font-semibold text-indigo-300 hover:text-indigo-200 hover:underline">
            Sign in to Student Workspace
          </Link>
        </p>
      </motion.div>
    </div>
  );
}
