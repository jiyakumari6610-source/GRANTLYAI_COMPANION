import { Suspense, lazy } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { MotionConfig } from 'motion/react';
import { WorkspaceLayout } from './components/AppShell.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { ProtectedRoute } from './components/ProtectedRoute.tsx';
import { AuthProvider } from './context/AuthContext.tsx';
import { routeModuleLoaders } from './lib/routePreload.ts';
import LandingPage from './pages/LandingPage.tsx';

const AICompanionPage = lazy(routeModuleLoaders['/companion']);
const AdminDashboardPage = lazy(routeModuleLoaders['/admin']);
const AdminLoginPage = lazy(() => import('./pages/AdminLoginPage.tsx'));
const ApplicationDetailPage = lazy(routeModuleLoaders['/applications/:id']);
const ApplicationsPage = lazy(routeModuleLoaders['/applications']);
const DashboardPage = lazy(routeModuleLoaders['/dashboard']);
const DiscoveryPage = lazy(routeModuleLoaders['/scholarships']);
const DocumentIntelligencePage = lazy(routeModuleLoaders['/documents']);
const EligibilityCheckerPage = lazy(routeModuleLoaders['/eligibility']);
const LoginPage = lazy(() => import('./pages/LoginPage.tsx'));
const NotificationsPage = lazy(routeModuleLoaders['/notifications']);
const OnboardingPage = lazy(routeModuleLoaders['/onboarding']);
const PrivacyPolicyPage = lazy(() => import('./pages/PrivacyPolicyPage.tsx'));
const ProfilePage = lazy(routeModuleLoaders['/profile']);
const ReadinessPage = lazy(routeModuleLoaders['/readiness']);
const RegisterPage = lazy(() => import('./pages/RegisterPage.tsx'));
const ScholarshipDetailsPage = lazy(routeModuleLoaders['/scholarships/:id']);
const SupportGrievancePage = lazy(() => import('./pages/SupportGrievancePage.tsx'));
const TermsOfServicePage = lazy(() => import('./pages/TermsOfServicePage.tsx'));
const TrustGuardPage = lazy(routeModuleLoaders['/trustguard']);

function RouteLoadingFallback() {
  return (
    <div
      className="min-h-screen bg-[#050914] flex items-center justify-center p-6 ambient-mesh"
      role="status"
      aria-live="polite"
      aria-label="Loading view"
    >
      <div className="w-full max-w-md space-y-4">
        <div className="h-5 w-40 rounded-lg skeleton-shimmer" />
        <div className="h-28 w-full rounded-2xl border border-slate-800 skeleton-shimmer" />
      </div>
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="min-h-screen bg-[#050914] text-slate-100 ambient-mesh grid-pattern-subtle flex items-center justify-center p-6">
      <div className="max-w-md w-full surface-elevated rounded-2xl p-8 text-center space-y-4">
        <p className="text-xs font-mono uppercase tracking-widest text-indigo-300">404 — Page Not Found</p>
        <h1 className="text-2xl font-bold text-white font-display">This page does not exist</h1>
        <p className="text-sm text-slate-400">
          The link you followed may be outdated or invalid. Return to your GRANTLY AI workspace to continue.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Link
            to="/dashboard"
            className="px-4 py-2.5 text-xs font-semibold text-white btn-primary-gradient rounded-xl"
          >
            Go to Dashboard
          </Link>
          <Link
            to="/"
            className="px-4 py-2.5 text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-200 rounded-xl hover:bg-slate-700"
          >
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <BrowserRouter>
          <ErrorBoundary>
            <Suspense fallback={<RouteLoadingFallback />}>
              <Routes>
                <Route path="/" element={<LandingPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/admin/login" element={<AdminLoginPage />} />
                <Route path="/privacy" element={<PrivacyPolicyPage />} />
                <Route path="/terms" element={<TermsOfServicePage />} />
                <Route path="/support" element={<SupportGrievancePage />} />

                <Route
                  element={
                    <ProtectedRoute>
                      <WorkspaceLayout />
                    </ProtectedRoute>
                  }
                >
                  <Route path="/onboarding" element={<OnboardingPage />} />
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/scholarships" element={<DiscoveryPage />} />
                  <Route path="/scholarships/:id" element={<ScholarshipDetailsPage />} />
                  <Route path="/eligibility" element={<EligibilityCheckerPage />} />
                  <Route path="/documents" element={<DocumentIntelligencePage />} />
                  <Route path="/companion" element={<AICompanionPage />} />
                  <Route path="/readiness" element={<ReadinessPage />} />
                  <Route path="/applications" element={<ApplicationsPage />} />
                  <Route path="/applications/:id" element={<ApplicationDetailPage />} />
                  <Route path="/trustguard" element={<TrustGuardPage />} />
                  <Route path="/notifications" element={<NotificationsPage initialTab="feed" />} />
                  <Route
                    path="/notifications/preferences"
                    element={<NotificationsPage initialTab="preferences" />}
                  />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route
                    path="/admin"
                    element={
                      <ProtectedRoute requireAdmin>
                        <AdminDashboardPage />
                      </ProtectedRoute>
                    }
                  />
                </Route>

                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </BrowserRouter>
      </AuthProvider>
    </MotionConfig>
  );
}
