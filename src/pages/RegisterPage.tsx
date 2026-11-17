import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { z } from 'zod';
import { AlertCircle, ArrowRight, CheckCircle2 } from 'lucide-react';
import { GrantlyLogoMark } from '../components/ui/BrandGraphics.tsx';
import { useAuth } from '../context/AuthContext.tsx';

const registerSchema = z.object({
  fullName: z.string().trim().min(2, 'Please enter your full name (at least 2 characters).'),
  email: z.string().trim().email('Please enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters long.'),
});

export default function RegisterPage() {
  const { signInWithGoogle, registerWithEmail } = useAuth();
  const navigate = useNavigate();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verificationSent, setVerificationSent] = useState(false);

  const handleGoogleSignUp = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await signInWithGoogle();
      navigate('/onboarding');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Google sign-in failed.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleEmailRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const parsed = registerSchema.safeParse({ fullName, email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please check your registration details.');
      return;
    }

    setSubmitting(true);
    try {
      await registerWithEmail(parsed.data.fullName, parsed.data.email, parsed.data.password);
      setVerificationSent(true);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes('auth/operation-not-allowed')) {
        setError(
          'Email/Password sign-up is currently unavailable. Please continue with Google Sign-In above.'
        );
      } else if (raw.includes('auth/email-already-in-use')) {
        setError('An account with this email already exists. Please sign in instead.');
      } else {
        setError('Unable to create account with those details. Please check your input or use Google Sign-In.');
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
            Create your student account
          </h1>
          <p className="text-sm text-slate-400">
            Save your academic profile once and evaluate eligibility across verified Indian scholarships.
          </p>
        </div>

        <div className="surface-elevated rounded-2xl p-6 sm:p-8 space-y-6">
          {error && (
            <div className="p-3.5 rounded-xl bg-rose-500/15 border border-rose-500/30 text-sm text-rose-200 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {verificationSent ? (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-sm text-emerald-200 flex items-start gap-2.5">
                <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5 text-emerald-400" />
                <div>
                  <p className="font-semibold text-white">Account created &amp; verification email sent</p>
                  <p className="mt-1 text-emerald-200/90 text-xs leading-relaxed">
                    Please verify your email address from your inbox, then continue to login or sign in directly with Google.
                  </p>
                </div>
              </div>
              <Link
                to="/login"
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold btn-primary-gradient rounded-xl"
              >
                <span>Continue to Sign In</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          ) : (
            <>
              <button
                type="button"
                disabled={submitting}
                onClick={handleGoogleSignUp}
                className="w-full flex items-center justify-center gap-3 px-4 py-2.5 text-sm font-semibold text-slate-100 bg-slate-900/90 border border-slate-700/80 hover:border-indigo-400/50 hover:bg-slate-800/80 rounded-xl transition-all disabled:opacity-60"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z" />
                  <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z" />
                  <path fill="#FBBC05" d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z" />
                  <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z" />
                </svg>
                <span>Continue with Google (Recommended)</span>
              </button>

              <div className="relative flex items-center">
                <div className="flex-grow border-t border-slate-800" />
                <span className="shrink mx-3 text-xs text-slate-500">or register with email</span>
                <div className="flex-grow border-t border-slate-800" />
              </div>

              <form onSubmit={handleEmailRegister} className="space-y-4">
                <div>
                  <label htmlFor="reg-name" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Full Name
                  </label>
                  <input
                    id="reg-name"
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="e.g. Ananya Sharma"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>

                <div>
                  <label htmlFor="reg-email" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Email Address
                  </label>
                  <input
                    id="reg-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="student@university.edu.in"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>

                <div>
                  <label htmlFor="reg-password" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Password
                  </label>
                  <input
                    id="reg-password"
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 8 characters"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl input-midnight"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold btn-primary-gradient rounded-xl disabled:opacity-60"
                >
                  <span>{submitting ? 'Creating Account...' : 'Create Student Account'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-sm text-slate-400">
          Already registered?{' '}
          <Link to="/login" className="font-semibold text-indigo-300 hover:text-indigo-200 hover:underline">
            Sign in to your account
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
