import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { GrantlyLogoMark } from './ui/BrandGraphics.tsx';
import { useAuth } from '../context/AuthContext.tsx';

interface PublicLegalShellProps {
  eyebrow: string;
  title: string;
  subtitle: string;
  lastUpdated: string;
  children: React.ReactNode;
}

export function PublicLegalShell({
  eyebrow,
  title,
  subtitle,
  lastUpdated,
  children,
}: PublicLegalShellProps) {
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-[#050914] text-slate-100 flex flex-col ambient-mesh">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:px-4 focus:py-2 focus:rounded-xl focus:bg-indigo-600 focus:text-white focus:text-xs focus:font-semibold"
      >
        Skip to main content
      </a>

      <header className="glass-surface border-x-0 border-t-0 border-b border-slate-800/80 sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4">
          <Link
            to="/"
            className="inline-flex items-center gap-2.5 text-base font-bold tracking-tight text-white font-display whitespace-nowrap shrink-0"
          >
            <GrantlyLogoMark size={26} />
            <span>GRANTLY AI</span>
          </Link>

          <nav className="hidden sm:flex items-center gap-5 text-xs font-medium text-slate-300" aria-label="Legal and support navigation">
            <Link to="/privacy" className="hover:text-white transition-colors whitespace-nowrap">
              Privacy Policy
            </Link>
            <Link to="/terms" className="hover:text-white transition-colors whitespace-nowrap">
              Terms of Service
            </Link>
            <Link to="/support" className="hover:text-white transition-colors whitespace-nowrap">
              Support &amp; Grievance
            </Link>
          </nav>

          <div className="flex items-center gap-2.5 shrink-0">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-900/80 border border-slate-700/80 hover:text-white hover:bg-slate-800 rounded-xl whitespace-nowrap"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Home</span>
            </Link>
            <Link
              to={user ? '/dashboard' : '/login'}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold btn-primary-gradient rounded-xl whitespace-nowrap"
            >
              <span>{user ? 'Workspace' : 'Sign In'}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 py-10 sm:py-14 space-y-8 focus:outline-none">
        <div className="space-y-3 border-b border-slate-800/80 pb-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
            {eyebrow}
          </p>
          <h1 className="text-2xl sm:text-4xl font-bold tracking-tight text-white font-display text-balance">
            {title}
          </h1>
          <p className="text-sm sm:text-base text-slate-300 leading-relaxed max-w-2xl">
            {subtitle}
          </p>
          <p className="text-xs text-slate-400 font-mono-num">
            Public Beta Release · Effective / Reviewed Date: {lastUpdated}
          </p>
        </div>

        <div className="space-y-6">{children}</div>
      </main>

      <footer className="border-t border-slate-800/90 bg-[#040710] py-8">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-400">
          <div className="flex items-center gap-2.5">
            <GrantlyLogoMark size={20} />
            <span>GRANTLY AI — Public Beta Release</span>
          </div>
          <div className="flex flex-wrap items-center gap-5">
            <Link to="/privacy" className="hover:text-white transition-colors">
              Privacy Policy
            </Link>
            <Link to="/terms" className="hover:text-white transition-colors">
              Terms of Service
            </Link>
            <Link to="/support" className="hover:text-white transition-colors">
              Support &amp; Grievance
            </Link>
            <Link to="/login" className="hover:text-white transition-colors">
              Sign In
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
