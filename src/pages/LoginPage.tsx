import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { z } from 'zod';
import { AlertCircle, ArrowRight, CheckCircle2, KeyRound } from 'lucide-react';
import { GrantlyLogoMark } from '../components/ui/BrandGraphics.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { isSafeInternalPath } from '../lib/securityUtils.ts';

const loginSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address.'),
  password: z.string().min(1, 'Please enter your password.'),
});

const resetEmailSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address.'),
});

export default function LoginPage() {
  const { user, profile, signInWithGoogle, loginWithEmail, resetPassword } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const rawFromPath = (location.state as { from?: string } | null)?.from;
  const fromPath = isSafeInternalPath(rawFromPath) ? rawFromPath : undefined;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetMode, setResetMode] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      if (fromPath && fromPath !== '/login' && fromPath !== '/register') {
        navigate(fromPath, { replace: true });
      } else if (profile && !profile.onboardingCompleted) {
        navigate('/onboarding', { replace: true });
      } else {
        navigate('/dashboard', { replace: true });
      }
    }
  }, [user, profile, fromPath, navigate]);

  const handleGoogleLogin = async () => {
    setError(null);
    setResetMessage(null);
    setSubmitting(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResetMessage(null);

    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please enter valid credentials.');
      return;
    }

    setSubmitting(true);
    try {
      await loginWithEmail(parsed.data.email, parsed.data.password);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes('auth/operation-not-allowed')) {
        setError(
          'Email/Password sign-in is currently unavailable. Please use Google Sign-In above.'
        );
      } else if (raw.includes('auth/invalid-credential')) {
        setError('Invalid email or password. Please verify your credentials.');
      } else if (raw.includes('auth/too-many-requests')) {
        setError('Too many failed sign-in attempts. Please wait a moment or reset your password.');
      } else {
        setError('Unable to sign in with those credentials. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResetMessage(null);

    const parsed = resetEmailSchema.safeParse({ email });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please enter a valid email address.');
      return;
    }

    setSubmitting(true);
    try {
      await resetPassword(parsed.data.email);
      setResetMessage(
        'If an account exists for that email address, a password reset link has been sent.'
      );
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes('auth/user-not-found')) {
        // Avoid user enumeration
        setResetMessage(
          'If an account exists for that email address, a password reset link has been sent.'
        );
      } else if (raw.includes('auth/operation-not-allowed')) {
        setError('Email/Password recovery is currently unavailable. Please use Google Sign-In.');
      } else {
        setError('Unable to send password reset email right now. Please try again shortly.');
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
          <Link
            to="/"
            className="inline-flex items-center gap-2.5 text-lg font-bold tracking-tight text-white font-display"
          >
            <GrantlyLogoMark size={30} />
            <span>GRANTLY AI</span>
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-white font-display tracking-tight">
            {resetMode ? 'Reset your password' : 'Sign in to your workspace'}
          </h1>
          <p className="text-sm text-slate-400">
            {resetMode
              ? 'Enter your registered email to receive a secure Firebase password recovery link.'
              : 'Access your saved scholarships, eligibility reports, and document intelligence vault.'}
          </p>
        </div>

        <div className="surface-elevated rounded-2xl p-6 sm:p-8 space-y-6">
          {error && (
            <div className="p-3.5 rounded-xl bg-rose-500/15 border border-rose-500/30 text-sm text-rose-200 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {resetMessage && (
            <div className="p-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-sm text-emerald-200 flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
              <span>{resetMessage}</span>
            </div>
          )}

          {resetMode ? (
            <form onSubmit={handlePasswordReset} className="space-y-4">
              <div>
                <label htmlFor="reset-email" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Registered Email Address
                </label>
                <input
                  id="reset-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="student@university.edu.in"
                  className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold btn-primary-gradient rounded-xl disabled:opacity-60"
              >
                <KeyRound className="w-4 h-4" />
                <span>{submitting ? 'Sending Reset Link...' : 'Send Recovery Link'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setResetMode(false);
                  setError(null);
                  setResetMessage(null);
                }}
                className="w-full text-xs font-medium text-slate-400 hover:text-indigo-300 transition-colors"
              >
                Back to sign in
              </button>
            </form>
          ) : (
            <>
              <button
                type="button"
                disabled={submitting}
                onClick={handleGoogleLogin}
                className="w-full flex items-center justify-center gap-3 px-4 py-2.5 text-sm font-semibold text-slate-100 bg-slate-900/90 border border-slate-700/80 hover:border-indigo-400/50 hover:bg-slate-800/80 rounded-xl transition-all disabled:opacity-60"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z" />
                  <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z" />
                  <path fill="#FBBC05" d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z" />
                  <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z" />
                </svg>
                <span>Sign in with Google</span>
              </button>

              <div className="relative flex items-center">
                <div className="flex-grow border-t border-slate-800" />
                <span className="shrink mx-3 text-xs text-slate-500">or sign in with email</span>
                <div className="flex-grow border-t border-slate-800" />
              </div>

              <form onSubmit={handleEmailLogin} className="space-y-4">
                <div>
                  <label htmlFor="login-email" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Email Address
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="student@university.edu.in"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="login-password" className="block text-xs font-medium text-slate-300">
                      Password
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setResetMode(true);
                        setError(null);
                        setResetMessage(null);
                      }}
                      className="text-xs text-indigo-300 hover:text-indigo-200 hover:underline"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <input
                    id="login-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold btn-primary-gradient rounded-xl disabled:opacity-60"
                >
                  <span>{submitting ? 'Signing In...' : 'Sign In'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-sm text-slate-400">
          New to GRANTLY AI?{' '}
          <Link to="/register" className="font-semibold text-indigo-300 hover:text-indigo-200 hover:underline">
            Register as a student
          </Link>
        </p>

        <div className="flex items-center justify-center gap-4 text-xs text-slate-500">
          <Link to="/privacy" className="hover:text-slate-300 transition-colors">
            Privacy Policy
          </Link>
          <span aria-hidden="true">·</span>
          <Link to="/terms" className="hover:text-slate-300 transition-colors">
            Terms
          </Link>
          <span aria-hidden="true">·</span>
          <Link to="/support" className="hover:text-slate-300 transition-colors">
            Support
          </Link>
        </div>
      </motion.div>
    </div>
  );
}
