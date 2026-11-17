import { Suspense, lazy } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { MotionConfig } from 'motion/react';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { ProtectedRoute } from './components/ProtectedRoute.tsx';
import { AuthProvider } from './context/AuthContext.tsx';
import LandingPage from './pages/LandingPage.tsx';

const AICompanionPage = lazy(() => import('./pages/AICompanionPage.tsx'));
const AdminDashboardPage = lazy(() => import('./pages/AdminDashboardPage.tsx'));
const AdminLoginPage = lazy(() => import('./pages/AdminLoginPage.tsx'));
const ApplicationDetailPage = lazy(() => import('./pages/ApplicationDetailPage.tsx'));
const ApplicationsPage = lazy(() => import('./pages/ApplicationsPage.tsx'));
const DashboardPage = lazy(() => import('./pages/DashboardPage.tsx'));
const DiscoveryPage = lazy(() => import('./pages/DiscoveryPage.tsx'));
const DocumentIntelligencePage = lazy(() => import('./pages/DocumentIntelligencePage.tsx'));
const EligibilityCheckerPage = lazy(() => import('./pages/EligibilityCheckerPage.tsx'));
const LoginPage = lazy(() => import('./pages/LoginPage.tsx'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage.tsx'));
const OnboardingPage = lazy(() => import('./pages/OnboardingPage.tsx'));
const PrivacyPolicyPage = lazy(() => import('./pages/PrivacyPolicyPage.tsx'));
const ProfilePage = lazy(() => import('./pages/ProfilePage.tsx'));
const ReadinessPage = lazy(() => import('./pages/ReadinessPage.tsx'));
const RegisterPage = lazy(() => import('./pages/RegisterPage.tsx'));
const ScholarshipDetailsPage = lazy(() => import('./pages/ScholarshipDetailsPage.tsx'));
const SupportGrievancePage = lazy(() => import('./pages/SupportGrievancePage.tsx'));
const TermsOfServicePage = lazy(() => import('./pages/TermsOfServicePage.tsx'));
const TrustGuardPage = lazy(() => import('./pages/TrustGuardPage.tsx'));

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
                  path="/onboarding"
                  element={
                    <ProtectedRoute>
                      <OnboardingPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/dashboard"
                  element={
                    <ProtectedRoute>
                      <DashboardPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/scholarships"
                  element={
                    <ProtectedRoute>
                      <DiscoveryPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/scholarships/:id"
                  element={
                    <ProtectedRoute>
                      <ScholarshipDetailsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/eligibility"
                  element={
                    <ProtectedRoute>
                      <EligibilityCheckerPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/documents"
                  element={
                    <ProtectedRoute>
                      <DocumentIntelligencePage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/companion"
                  element={
                    <ProtectedRoute>
                      <AICompanionPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/readiness"
                  element={
                    <ProtectedRoute>
                      <ReadinessPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/applications"
                  element={
                    <ProtectedRoute>
                      <ApplicationsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/applications/:id"
                  element={
                    <ProtectedRoute>
                      <ApplicationDetailPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/trustguard"
                  element={
                    <ProtectedRoute>
                      <TrustGuardPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/notifications"
                  element={
                    <ProtectedRoute>
                      <NotificationsPage initialTab="feed" />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/notifications/preferences"
                  element={
                    <ProtectedRoute>
                      <NotificationsPage initialTab="preferences" />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/profile"
                  element={
                    <ProtectedRoute>
                      <ProfilePage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/admin"
                  element={
                    <ProtectedRoute requireAdmin>
                      <AdminDashboardPage />
                    </ProtectedRoute>
                  }
                />

                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </BrowserRouter>
      </AuthProvider>
    </MotionConfig>
  );
}
