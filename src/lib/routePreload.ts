// Shared route loaders for React.lazy AND hover/focus/idle route preloading.

export const routeModuleLoaders = {
  '/dashboard': () => import('../pages/DashboardPage.tsx'),
  '/scholarships': () => import('../pages/DiscoveryPage.tsx'),
  '/scholarships/:id': () => import('../pages/ScholarshipDetailsPage.tsx'),
  '/eligibility': () => import('../pages/EligibilityCheckerPage.tsx'),
  '/documents': () => import('../pages/DocumentIntelligencePage.tsx'),
  '/companion': () => import('../pages/AICompanionPage.tsx'),
  '/readiness': () => import('../pages/ReadinessPage.tsx'),
  '/applications': () => import('../pages/ApplicationsPage.tsx'),
  '/applications/:id': () => import('../pages/ApplicationDetailPage.tsx'),
  '/trustguard': () => import('../pages/TrustGuardPage.tsx'),
  '/notifications': () => import('../pages/NotificationsPage.tsx'),
  '/notifications/preferences': () => import('../pages/NotificationsPage.tsx'),
  '/profile': () => import('../pages/ProfilePage.tsx'),
  '/onboarding': () => import('../pages/OnboardingPage.tsx'),
  '/admin': () => import('../pages/AdminDashboardPage.tsx'),
} as const;

export type WorkspaceRouteKey = keyof typeof routeModuleLoaders;

const prefetchedRoutes = new Set<string>();

export function preloadWorkspaceRoute(path: string): void {
  const normalized = path.split('?')[0].split('#')[0];
  let matchedKey: WorkspaceRouteKey | null = null;

  if (normalized in routeModuleLoaders) {
    matchedKey = normalized as WorkspaceRouteKey;
  } else if (normalized.startsWith('/scholarships/')) {
    matchedKey = '/scholarships/:id';
  } else if (normalized.startsWith('/applications/')) {
    matchedKey = '/applications/:id';
  } else if (normalized.startsWith('/notifications/preferences')) {
    matchedKey = '/notifications/preferences';
  }

  if (!matchedKey || prefetchedRoutes.has(matchedKey)) return;
  prefetchedRoutes.add(matchedKey);
  void routeModuleLoaders[matchedKey]().catch(() => {
    prefetchedRoutes.delete(matchedKey!);
  });
}

let idlePreloadScheduled = false;

export function schedulePrimaryWorkspacePreload(): void {
  if (idlePreloadScheduled || typeof window === 'undefined') return;
  idlePreloadScheduled = true;

  const priorityRoutes: WorkspaceRouteKey[] = [
    '/scholarships',
    '/documents',
    '/companion',
    '/eligibility',
    '/applications',
    '/readiness',
    '/trustguard',
  ];

  const runBatch = () => {
    priorityRoutes.forEach((route, idx) => {
      window.setTimeout(() => {
        preloadWorkspaceRoute(route);
      }, idx * 80);
    });
  };

  if ('requestIdleCallback' in window) {
    (
      window as Window & {
        requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number;
      }
    ).requestIdleCallback(runBatch, { timeout: 1500 });
  } else {
    setTimeout(runBatch, 600);
  }
}
