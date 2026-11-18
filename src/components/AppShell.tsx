import React, {
  Suspense,
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  Award,
  Bell,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  FileSearch,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Search,
  Shield,
  ShieldCheck,
  UserCircle,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { preloadWorkspaceRoute, schedulePrimaryWorkspacePreload } from '../lib/routePreload.ts';
import { GrantlyLogoMark } from './ui/BrandGraphics.tsx';
import { NotificationCenter } from './ui/NotificationCenter.tsx';

interface AppShellProps {
  title: string;
  breadcrumb?: string;
  primaryAction?: React.ReactNode;
  children: React.ReactNode;
}

interface HeaderMeta {
  title: string;
  breadcrumb?: string;
}

interface WorkspaceShellContextValue {
  setHeaderMeta: (meta: HeaderMeta) => void;
  actionHost: HTMLDivElement | null;
}

const WorkspaceShellContext = createContext<WorkspaceShellContextValue | null>(null);

const STUDENT_NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/scholarships', label: 'Discovery', icon: Search },
  { to: '/eligibility', label: 'Eligibility Checker', icon: CheckCircle2 },
  { to: '/documents', label: 'Document Intelligence', icon: FileSearch },
  { to: '/companion', label: 'AI Companion', icon: MessageSquare },
  { to: '/readiness', label: 'Readiness Score', icon: Award },
  { to: '/applications', label: 'Application Tracker', icon: ClipboardCheck },
  { to: '/trustguard', label: 'TrustGuard', icon: ShieldCheck },
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/profile', label: 'Student Profile', icon: UserCircle },
];

interface SidebarNavProps {
  onboardingCompleted?: boolean;
  isAdmin: boolean;
  fullName?: string | null;
  displayName?: string | null;
  email?: string | null;
  onCloseMobile: () => void;
  onLogout: () => void;
}

const SidebarNav = memo(function SidebarNav({
  onboardingCompleted,
  isAdmin,
  fullName,
  displayName,
  email,
  onCloseMobile,
  onLogout,
}: SidebarNavProps) {
  const initialLetter = (fullName || displayName || 'S').slice(0, 1).toUpperCase();
  const displayUser = fullName || displayName || 'Student';

  return (
    <div className="flex flex-col h-full bg-[#070C1B]">
      <div className="px-5 py-4.5 border-b border-slate-800/80 flex items-center justify-between">
        <Link
          to="/"
          className="inline-flex items-center gap-2.5 text-base font-bold tracking-tight text-white font-display whitespace-nowrap"
        >
          <GrantlyLogoMark size={28} />
          <span>GRANTLY AI</span>
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1" aria-label="Workspace navigation">
        {STUDENT_NAV.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onCloseMobile}
              onMouseEnter={() => preloadWorkspaceRoute(item.to)}
              onFocus={() => preloadWorkspaceRoute(item.to)}
              className={({ isActive }) =>
                `group relative flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-[13px] font-medium transition-all whitespace-nowrap ${
                  isActive
                    ? 'bg-gradient-to-r from-indigo-500/20 via-blue-500/15 to-transparent text-white border border-indigo-400/25 shadow-sm shadow-indigo-950/50'
                    : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-100 border border-transparent'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    className={`w-4 h-4 shrink-0 transition-colors ${
                      isActive ? 'text-indigo-300' : 'text-slate-500 group-hover:text-slate-300'
                    }`}
                  />
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}

        {!onboardingCompleted && (
          <NavLink
            to="/onboarding"
            onClick={onCloseMobile}
            onMouseEnter={() => preloadWorkspaceRoute('/onboarding')}
            onFocus={() => preloadWorkspaceRoute('/onboarding')}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-[13px] font-medium transition-all whitespace-nowrap border ${
                isActive
                  ? 'bg-amber-500/20 text-amber-200 border-amber-400/30'
                  : 'text-amber-300/90 hover:bg-amber-500/10 border-amber-500/20'
              }`
            }
          >
            <BookOpen className="w-4 h-4 shrink-0" />
            <span className="truncate">Complete Onboarding</span>
          </NavLink>
        )}

        {isAdmin && (
          <div className="pt-4 mt-4 border-t border-slate-800/80">
            <NavLink
              to="/admin"
              onClick={onCloseMobile}
              onMouseEnter={() => preloadWorkspaceRoute('/admin')}
              onFocus={() => preloadWorkspaceRoute('/admin')}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-[13px] font-medium transition-all whitespace-nowrap border ${
                  isActive
                    ? 'bg-violet-500/20 text-white border-violet-400/35'
                    : 'text-slate-300 hover:bg-slate-800/60 border-transparent'
                }`
              }
            >
              <Shield className="w-4 h-4 shrink-0 text-violet-300" />
              <span className="truncate">Admin Control Center</span>
            </NavLink>
          </div>
        )}
      </nav>

      <div className="p-4 border-t border-slate-800/80 space-y-3 bg-[#060A17]">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-xs font-bold text-indigo-200 shrink-0 font-display">
            {initialLetter}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-100 truncate">{displayUser}</p>
            <p className="text-[11px] text-slate-400 truncate">{email}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 bg-slate-800/60 hover:bg-slate-800 hover:text-white border border-slate-700/60 rounded-xl transition-colors whitespace-nowrap"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Sign Out</span>
        </button>
        <div className="flex items-center justify-center gap-3 pt-1 text-[11px] text-slate-500">
          <Link to="/privacy" onClick={onCloseMobile} className="hover:text-slate-300 transition-colors">
            Privacy
          </Link>
          <span aria-hidden="true">·</span>
          <Link to="/terms" onClick={onCloseMobile} className="hover:text-slate-300 transition-colors">
            Terms
          </Link>
          <span aria-hidden="true">·</span>
          <Link to="/support" onClick={onCloseMobile} className="hover:text-slate-300 transition-colors">
            Support
          </Link>
        </div>
      </div>
    </div>
  );
});

export function WorkspaceRouteFallback() {
  return (
    <div className="space-y-4 py-2" role="status" aria-live="polite" aria-label="Loading workspace page">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="h-24 rounded-2xl border border-slate-800/80 skeleton-shimmer" />
        <div className="h-24 rounded-2xl border border-slate-800/80 skeleton-shimmer" />
        <div className="h-24 rounded-2xl border border-slate-800/80 skeleton-shimmer" />
      </div>
      <div className="h-56 rounded-2xl border border-slate-800/80 skeleton-shimmer" />
    </div>
  );
}

/**
 * Persistent shell layout rendered once across all authenticated workspace routes.
 * Preserves sidebar scroll state, header, NotificationCenter subscription, and avoids shell remounts.
 */
export function WorkspaceLayout() {
  const { user, profile, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [headerMeta, setHeaderMeta] = useState<HeaderMeta>({ title: 'Workspace' });
  const [actionHost, setActionHost] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    schedulePrimaryWorkspacePreload();
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  const handleCloseMobile = useMemo(() => () => setMobileOpen(false), []);

  const handleLogout = useMemo(
    () => async () => {
      await logout();
      navigate('/');
    },
    [logout, navigate]
  );

  const shellCtx = useMemo<WorkspaceShellContextValue>(
    () => ({ setHeaderMeta, actionHost }),
    [actionHost]
  );

  return (
    <WorkspaceShellContext.Provider value={shellCtx}>
      <div className="min-h-screen bg-[#050914] text-slate-100 flex ambient-mesh">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:px-4 focus:py-2 focus:rounded-xl focus:bg-indigo-600 focus:text-white focus:text-xs focus:font-semibold"
        >
          Skip to main content
        </a>
        {/* Desktop Sidebar */}
        <aside className="hidden lg:block w-64 shrink-0 border-r border-slate-800/80 sticky top-0 h-screen z-20">
          <SidebarNav
            onboardingCompleted={profile?.onboardingCompleted}
            isAdmin={isAdmin}
            fullName={profile?.fullName}
            displayName={user?.displayName}
            email={user?.email}
            onCloseMobile={handleCloseMobile}
            onLogout={handleLogout}
          />
        </aside>

        {/* Mobile Drawer */}
        <AnimatePresence>
          {mobileOpen && (
            <div className="fixed inset-0 z-50 lg:hidden flex">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/70 backdrop-blur-xs"
                onClick={handleCloseMobile}
                aria-hidden="true"
              />
              <motion.aside
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                className="relative w-72 max-w-[85vw] h-full border-r border-slate-800 z-10 shadow-2xl"
              >
                <button
                  type="button"
                  onClick={handleCloseMobile}
                  className="absolute top-3.5 right-3.5 p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800/80 z-20"
                  aria-label="Close navigation menu"
                >
                  <X className="w-5 h-5" />
                </button>
                <SidebarNav
                  onboardingCompleted={profile?.onboardingCompleted}
                  isAdmin={isAdmin}
                  fullName={profile?.fullName}
                  displayName={user?.displayName}
                  email={user?.email}
                  onCloseMobile={handleCloseMobile}
                  onLogout={handleLogout}
                />
              </motion.aside>
            </div>
          )}
        </AnimatePresence>

        {/* Main Content */}
        <div className="flex-1 min-w-0 flex flex-col">
          <header className="glass-surface border-x-0 border-t-0 border-b border-slate-800/80 px-4 sm:px-8 py-3.5 flex items-center justify-between gap-4 sticky top-0 z-30">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                className="lg:hidden p-2 -ml-2 text-slate-300 hover:text-white rounded-lg hover:bg-slate-800/60"
                aria-label="Open navigation menu"
              >
                <Menu className="w-5 h-5" />
              </button>
              <div className="min-w-0">
                {headerMeta.breadcrumb && (
                  <p className="text-[11px] text-slate-400 truncate">{headerMeta.breadcrumb}</p>
                )}
                <h1 className="text-lg sm:text-xl font-semibold text-white truncate font-display tracking-tight">
                  {headerMeta.title}
                </h1>
              </div>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <NotificationCenter />
              <div ref={setActionHost} className="shrink-0 empty:hidden" />
            </div>
          </header>

          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 px-4 sm:px-8 py-6 max-w-7xl w-full mx-auto focus:outline-none"
          >
            <Suspense fallback={<WorkspaceRouteFallback />}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>
    </WorkspaceShellContext.Provider>
  );
}

export function AppShell({ title, breadcrumb, primaryAction, children }: AppShellProps) {
  const shellCtx = useContext(WorkspaceShellContext);
  const { user, profile, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  useLayoutEffect(() => {
    if (!shellCtx) return;
    shellCtx.setHeaderMeta({ title, breadcrumb });
  }, [shellCtx, title, breadcrumb]);

  useEffect(() => {
    if (shellCtx || !mobileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shellCtx, mobileOpen]);

  // Inside persistent WorkspaceLayout, only render the page body and portal the header action.
  if (shellCtx) {
    return (
      <>
        {primaryAction && shellCtx.actionHost
          ? createPortal(primaryAction, shellCtx.actionHost)
          : null}
        {children}
      </>
    );
  }

  const handleCloseMobile = () => setMobileOpen(false);
  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-[#050914] text-slate-100 flex ambient-mesh">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:px-4 focus:py-2 focus:rounded-xl focus:bg-indigo-600 focus:text-white focus:text-xs focus:font-semibold"
      >
        Skip to main content
      </a>
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 border-r border-slate-800/80 sticky top-0 h-screen z-20">
        <SidebarNav
          onboardingCompleted={profile?.onboardingCompleted}
          isAdmin={isAdmin}
          fullName={profile?.fullName}
          displayName={user?.displayName}
          email={user?.email}
          onCloseMobile={handleCloseMobile}
          onLogout={handleLogout}
        />
      </aside>

      {/* Mobile Drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <div className="fixed inset-0 z-50 lg:hidden flex">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/70 backdrop-blur-xs"
              onClick={handleCloseMobile}
              aria-hidden="true"
            />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              className="relative w-72 max-w-[85vw] h-full border-r border-slate-800 z-10 shadow-2xl"
            >
              <button
                type="button"
                onClick={handleCloseMobile}
                className="absolute top-3.5 right-3.5 p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800/80 z-20"
                aria-label="Close navigation menu"
              >
                <X className="w-5 h-5" />
              </button>
              <SidebarNav
                onboardingCompleted={profile?.onboardingCompleted}
                isAdmin={isAdmin}
                fullName={profile?.fullName}
                displayName={user?.displayName}
                email={user?.email}
                onCloseMobile={handleCloseMobile}
                onLogout={handleLogout}
              />
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="glass-surface border-x-0 border-t-0 border-b border-slate-800/80 px-4 sm:px-8 py-3.5 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-300 hover:text-white rounded-lg hover:bg-slate-800/60"
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              {breadcrumb && (
                <p className="text-[11px] text-slate-400 truncate">{breadcrumb}</p>
              )}
              <h1 className="text-lg sm:text-xl font-semibold text-white truncate font-display tracking-tight">
                {title}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <NotificationCenter />
            {primaryAction && <div className="shrink-0">{primaryAction}</div>}
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="flex-1 px-4 sm:px-8 py-6 max-w-7xl w-full mx-auto focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
