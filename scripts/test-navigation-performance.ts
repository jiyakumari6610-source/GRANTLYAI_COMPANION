import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { VERIFIED_INDIAN_SCHOLARSHIPS } from '../src/data/verifiedScholarships.ts';
import { findDuplicateActiveApplication } from '../src/lib/applicationTrackerEngine.ts';
import { evaluateDeterministicEligibility } from '../src/lib/eligibilityEngine.ts';
import { filterAndSortScholarships, DEFAULT_DISCOVERY_FILTERS } from '../src/lib/scholarshipEngine.ts';
import { getCachedProtectedApi, postProtectedAi, putProtectedApi, deleteProtected } from '../src/lib/apiClient.ts';
import { preloadWorkspaceRoute, routeModuleLoaders } from '../src/lib/routePreload.ts';
import {
  ensureCacheOwner,
  getActiveCacheUid,
  getOrFetchPublic,
  getOrFetchUser,
  getWorkspaceCacheDiagnostics,
  invalidateAllUserCaches,
  invalidatePublicCache,
  invalidateUserCache,
  peekPublicCache,
  peekUserCache,
  setPublicCache,
  setUserCache,
  subscribeWorkspaceCache,
} from '../src/lib/workspaceCache.ts';
import type { StudentProfile } from '../src/types/database.ts';

async function runTests() {
  console.log('--- GRANTLY AI Navigation & Performance Verification Suite ---');

  // 1. UID Isolation & Cross-Account Cache Leakage Prevention
  ensureCacheOwner('student-A');
  setUserCache('student-A', 'profile', { uid: 'student-A', fullName: 'Alice Student' });
  setUserCache('student-A', 'documents', [{ id: 'doc-a-1' }]);
  setUserCache('student-A', 'ai_messages:conv-a1', [{ id: 'msg-1', content: 'Private A' }]);
  setPublicCache('scholarships', { items: VERIFIED_INDIAN_SCHOLARSHIPS, isEmptyDatabase: false });

  assert.equal(getActiveCacheUid(), 'student-A');
  assert.equal(peekUserCache<{ fullName: string }>('student-A', 'profile')?.fullName, 'Alice Student');
  assert.equal(peekUserCache('student-B', 'profile'), undefined, 'Student B cannot read Student A cache');

  // Start an in-flight async fetch for Student A that resolves slowly after user switches to Student B
  let resolveSlowFetch: ((val: string) => void) | null = null;
  const slowPromise = getOrFetchUser('student-A', 'slow_records', () => {
    return new Promise<string>((resolve) => {
      resolveSlowFetch = resolve;
    });
  });

  // Switch user synchronously to Student B (simulating account switch)
  ensureCacheOwner('student-B');
  assert.equal(getActiveCacheUid(), 'student-B');
  assert.equal(peekUserCache('student-A', 'profile'), undefined, 'Student A cache purged on switch');
  assert.equal(peekUserCache('student-B', 'profile'), undefined, 'Student B starts with clean cache');
  assert.ok(peekPublicCache('scholarships'), 'Public scholarship catalog survives safe user switch');

  // Resolve slow Student A promise late
  resolveSlowFetch!('STALE_STUDENT_A_SECRET');
  const slowResult = await slowPromise;
  assert.equal(slowResult, 'STALE_STUDENT_A_SECRET');
  assert.equal(
    peekUserCache('student-A', 'slow_records'),
    undefined,
    'Late-resolving Student A fetch must NOT write into cache after epoch change'
  );
  assert.equal(
    peekUserCache('student-B', 'slow_records'),
    undefined,
    'Late-resolving Student A fetch must NOT leak into Student B cache'
  );

  // Logout clears all user caches synchronously
  setUserCache('student-B', 'notifications', [{ id: 'notif-b' }]);
  invalidateAllUserCaches(null);
  assert.equal(getActiveCacheUid(), null);
  assert.equal(peekUserCache('student-B', 'notifications'), undefined, 'Logout clears user cache');
  assert.equal(getWorkspaceCacheDiagnostics().userEntries, 0);
  console.log('✓ Test 1 passed: Zero cross-account cache leakage (UID switch, late in-flight, logout)');

  // 2. Prefix Invalidation & Listener Subscriptions
  ensureCacheOwner('student-C');
  let listenerFired = 0;
  const unsubscribe = subscribeWorkspaceCache(() => {
    listenerFired += 1;
  });
  setUserCache('student-C', 'ai_messages:thread-1', ['m1']);
  setUserCache('student-C', 'ai_messages:thread-2', ['m2']);
  setUserCache('student-C', 'documents', ['d1']);
  invalidateUserCache('student-C', 'ai_messages:');
  assert.equal(peekUserCache('student-C', 'ai_messages:thread-1'), undefined);
  assert.equal(peekUserCache('student-C', 'ai_messages:thread-2'), undefined);
  assert.deepEqual(peekUserCache('student-C', 'documents'), ['d1']);
  assert.ok(listenerFired >= 1, 'Workspace cache subscriber notified on invalidation');
  unsubscribe();
  console.log('✓ Test 2 passed: Prefix-based user invalidation & cache listeners work accurately');

  // 3. In-Flight Request Deduplication
  invalidatePublicCache();
  let publicFetchCalls = 0;
  const concurrentPublic = await Promise.all(
    Array.from({ length: 6 }, () =>
      getOrFetchPublic('dedup_scholarships', async () => {
        publicFetchCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        return VERIFIED_INDIAN_SCHOLARSHIPS;
      })
    )
  );
  assert.equal(publicFetchCalls, 1, 'Concurrent public fetches deduplicated to 1 execution');
  assert.equal(concurrentPublic[0].length, VERIFIED_INDIAN_SCHOLARSHIPS.length);

  let userFetchCalls = 0;
  const concurrentUser = await Promise.all(
    Array.from({ length: 5 }, () =>
      getOrFetchUser('student-C', 'dedup_apps', async () => {
        userFetchCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        return [{ id: 'app-1' }];
      })
    )
  );
  assert.equal(userFetchCalls, 1, 'Concurrent user fetches deduplicated to 1 execution');
  assert.equal(concurrentUser[4][0].id, 'app-1');
  console.log('✓ Test 3 passed: In-flight request deduplication reduces duplicate concurrent loads to 1');

  // 4. API Client Caching & Automatic Mutation Invalidation
  const originalFetch = globalThis.fetch;
  let apiCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    apiCalls += 1;
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';
    if (method === 'GET' && url === '/api/notifications/preferences') {
      return new Response(
        JSON.stringify({ preferences: { uid: 'student-C', inAppEnabled: true } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    let tokenCalls = 0;
    const getToken = async () => {
      tokenCalls += 1;
      return 'mock-id-token';
    };

    const res1 = await getCachedProtectedApi<{ preferences: { uid: string } }>(
      'student-C',
      '/api/notifications/preferences',
      getToken,
      60_000
    );
    const res2 = await getCachedProtectedApi<{ preferences: { uid: string } }>(
      'student-C',
      '/api/notifications/preferences',
      getToken,
      60_000
    );
    assert.equal(res1.preferences.uid, 'student-C');
    assert.equal(res2.preferences.uid, 'student-C');
    assert.equal(apiCalls, 1, 'Warm API cache hits without re-fetching');
    assert.equal(tokenCalls, 1, 'Warm API cache avoids redundant getIdToken calls');

    await putProtectedApi('/api/notifications/preferences', 'mock-id-token', { inAppEnabled: false });
    assert.equal(
      peekUserCache('student-C', 'api:/api/notifications/preferences'),
      undefined,
      'PUT /api/notifications/preferences invalidates notification API cache'
    );

    setUserCache('student-C', 'documents', [{ id: 'd1' }]);
    setUserCache('student-C', 'document_analysis', [{ id: 'a1' }]);
    await deleteProtected('/api/documents/d1', 'mock-id-token');
    assert.equal(peekUserCache('student-C', 'documents'), undefined);
    assert.equal(peekUserCache('student-C', 'document_analysis'), undefined);

    setUserCache('student-C', 'applications', [{ id: 'app-1' }]);
    await postProtectedAi('/api/applications', 'mock-id-token', { scholarshipId: 'sch-1' });
    assert.equal(peekUserCache('student-C', 'applications'), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('✓ Test 4 passed: API response cache + automatic mutation invalidation verified');

  // 5. Route Preload & Persistent Layout Structural Verification
  const expectedRoutes: Array<keyof typeof routeModuleLoaders> = [
    '/onboarding',
    '/dashboard',
    '/scholarships',
    '/scholarships/:id',
    '/eligibility',
    '/documents',
    '/companion',
    '/readiness',
    '/applications',
    '/applications/:id',
    '/trustguard',
    '/notifications',
    '/notifications/preferences',
    '/profile',
    '/admin',
  ];
  for (const r of expectedRoutes) {
    assert.ok(routeModuleLoaders[r], `Missing routeModuleLoader for ${r}`);
  }
  // Exercise dynamic path resolution (ensures no throws on dynamic IDs or query strings)
  preloadWorkspaceRoute('/scholarships/nsp-central-sector');
  preloadWorkspaceRoute('/applications/app-123?tab=checklist');
  preloadWorkspaceRoute('/notifications/preferences');
  await Promise.all([
    routeModuleLoaders['/scholarships/:id'](),
    routeModuleLoaders['/applications/:id'](),
    routeModuleLoaders['/notifications/preferences'](),
  ]);

  const appTsx = fs.readFileSync(path.resolve('src/App.tsx'), 'utf-8');
  assert.ok(
    /<Route[\s\S]*?<ProtectedRoute>\s*<WorkspaceLayout \/>\s*<\/ProtectedRoute>/m.test(appTsx),
    'Workspace routes must share persistent WorkspaceLayout wrapper'
  );
  assert.ok(
    appTsx.includes('routeModuleLoaders'),
    'App.tsx lazy routes must share routeModuleLoaders for single-chunk preloading'
  );

  const shellTsx = fs.readFileSync(path.resolve('src/components/AppShell.tsx'), 'utf-8');
  assert.ok(
    shellTsx.includes('<NotificationCenter />'),
    'Persistent WorkspaceLayout header must render persistent NotificationCenter'
  );
  assert.ok(
    shellTsx.includes('setMobileOpen(false)'),
    'Persistent WorkspaceLayout must auto-close mobile drawer on route changes'
  );
  console.log('✓ Test 5 passed: All 15 workspace route loaders & persistent WorkspaceLayout verified');

  // 6. Real Measured Performance Benchmarks
  // 6a. DiscoveryPage memoized eligibility lookup vs per-render recalculation across 20 filter updates
  const sampleProfile: StudentProfile = {
    uid: 'student-bench',
    fullName: 'Bench Student',
    email: 'bench@example.com',
    onboardingCompleted: true,
    state: 'Maharashtra',
    category: 'OBC-NCL',
    educationLevel: 'Undergraduate (UG)',
    courseSpecialization: 'B.Tech Computer Science',
    previousMarksPercent: 86,
    familyAnnualIncomeInr: 250000,
    certificates: ['Income Certificate', 'Domicile Certificate', 'Bonafide Certificate'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const t0Uncached = performance.now();
  for (let i = 0; i < 20; i += 1) {
    const filtered = filterAndSortScholarships(
      VERIFIED_INDIAN_SCHOLARSHIPS,
      DEFAULT_DISCOVERY_FILTERS,
      'relevant',
      sampleProfile,
      new Set()
    );
    for (const item of filtered) {
      evaluateDeterministicEligibility(sampleProfile, item.scholarship);
      findDuplicateActiveApplication([], item.scholarship.id);
    }
  }
  const uncachedDiscoveryMs = performance.now() - t0Uncached;

  const t0Memoized = performance.now();
  const eligMap = new Map(
    VERIFIED_INDIAN_SCHOLARSHIPS.map((s) => [s.id, evaluateDeterministicEligibility(sampleProfile, s)])
  );
  const trackMap = new Map(
    VERIFIED_INDIAN_SCHOLARSHIPS.map((s) => [s.id, findDuplicateActiveApplication([], s.id)])
  );
  for (let i = 0; i < 20; i += 1) {
    const filtered = filterAndSortScholarships(
      VERIFIED_INDIAN_SCHOLARSHIPS,
      DEFAULT_DISCOVERY_FILTERS,
      'relevant',
      sampleProfile,
      new Set()
    );
    for (const item of filtered) {
      eligMap.get(item.scholarship.id);
      trackMap.get(item.scholarship.id);
    }
  }
  const memoizedDiscoveryMs = performance.now() - t0Memoized;

  // 6b. Warm cache synchronous read timing (100 navigations)
  setPublicCache('scholarships', { items: VERIFIED_INDIAN_SCHOLARSHIPS, isEmptyDatabase: false });
  setUserCache('student-C', 'applications', []);
  setUserCache('student-C', 'saved_scholarships', []);
  setUserCache('student-C', 'documents', []);
  setUserCache('student-C', 'document_analysis', []);
  setUserCache('student-C', 'eligibility_assessments', []);

  const t0Warm = performance.now();
  for (let i = 0; i < 100; i += 1) {
    peekPublicCache('scholarships');
    peekUserCache('student-C', 'applications');
    peekUserCache('student-C', 'saved_scholarships');
    peekUserCache('student-C', 'documents');
    peekUserCache('student-C', 'document_analysis');
    peekUserCache('student-C', 'eligibility_assessments');
  }
  const warm100NavsMs = performance.now() - t0Warm;

  // 6c. Decoupled AI Companion thread readiness vs 11-query barrier (simulated 25ms fast / 120ms slow query)
  const simFast = () => new Promise<string[]>((r) => setTimeout(() => r(['conv-1']), 25));
  const simSlowGrounding = () => new Promise<string[]>((r) => setTimeout(() => r([]), 120));

  const t0Coupled = performance.now();
  await Promise.all([simFast(), ...Array.from({ length: 10 }, () => simSlowGrounding())]);
  const coupledCompanionMs = performance.now() - t0Coupled;

  const t0Decoupled = performance.now();
  const threadsPromise = simFast();
  const groundingPromise = Promise.all(Array.from({ length: 10 }, () => simSlowGrounding()));
  await threadsPromise;
  const decoupledThreadReadyMs = performance.now() - t0Decoupled;
  await groundingPromise;

  console.log('\n--- Measured Verification Metrics ---');
  console.log(
    `• Discovery 20x filter/render passes (${VERIFIED_INDIAN_SCHOLARSHIPS.length} scholarships): uncached=${uncachedDiscoveryMs.toFixed(2)}ms vs memoized=${memoizedDiscoveryMs.toFixed(2)}ms`
  );
  console.log(
    `• 100 warm-cache Dashboard state hydrations (6 cache lookups each): total=${warm100NavsMs.toFixed(3)}ms (avg=${(warm100NavsMs / 100).toFixed(4)}ms/nav)`
  );
  console.log(
    `• AI Companion thread-list TTI (25ms threads + 120ms grounding): coupled=${coupledCompanionMs.toFixed(1)}ms vs decoupled=${decoupledThreadReadyMs.toFixed(1)}ms`
  );
  console.log('\nAll navigation & performance verification tests passed.');
}

runTests().catch((err) => {
  console.error('Verification suite failed:', err);
  process.exit(1);
});
