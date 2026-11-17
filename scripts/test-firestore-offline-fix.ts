import assert from 'node:assert/strict';
import { terminate } from 'firebase/firestore';
import {
  db,
  fetchFirestoreDocumentViaRest,
  isFirestoreOfflineError,
  testFirestoreConnection,
} from '../src/lib/firebase.ts';
import { getScholarships } from '../src/lib/firestoreRepo.ts';

async function run(): Promise<void> {
  console.log('--- Running Firestore Offline & REST Fallback Regression Tests ---');

  try {
    // 1. Offline error detection
    assert.equal(isFirestoreOfflineError({ code: 'unavailable', message: 'Network unavailable' }), true);
    assert.equal(
      isFirestoreOfflineError(new Error('Failed to get document because the client is offline.')),
      true
    );
    assert.equal(
      isFirestoreOfflineError(
        new Error(
          JSON.stringify({
            error: 'Failed to get document because the client is offline.',
            operationType: 'get',
            path: 'profiles/test-user',
          })
        )
      ),
      true
    );
    assert.equal(
      isFirestoreOfflineError(new Error('Could not reach Cloud Firestore backend.')),
      true
    );
    assert.equal(isFirestoreOfflineError({ code: 'permission-denied', message: 'Missing or insufficient permissions.' }), false);
    assert.equal(isFirestoreOfflineError(null), false);
    console.log('[PASS] isFirestoreOfflineError classification');

    // 2. fetchFirestoreDocumentViaRest decoding & status handling
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            fields: {
              uid: { stringValue: 'user-123' },
              fullName: { stringValue: 'Jiya Kumari' },
              onboardingCompleted: { booleanValue: true },
              annualIncome: { integerValue: '240000' },
              cgpa: { doubleValue: 9.15 },
              certificates: {
                arrayValue: {
                  values: [{ stringValue: 'Income Certificate' }, { stringValue: 'Domicile' }],
                },
              },
              preferences: {
                mapValue: {
                  fields: {
                    state: { stringValue: 'Bihar' },
                    verified: { booleanValue: false },
                    note: { nullValue: null },
                  },
                },
              },
              updatedAt: { timestampValue: '2026-11-16T10:00:00Z' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )) as typeof fetch;

      const okResult = await fetchFirestoreDocumentViaRest<Record<string, unknown>>(
        'profiles',
        'user-123',
        'mock-id-token'
      );
      assert.equal(okResult.exists, true);
      assert.deepEqual(okResult.data, {
        uid: 'user-123',
        fullName: 'Jiya Kumari',
        onboardingCompleted: true,
        annualIncome: 240000,
        cgpa: 9.15,
        certificates: ['Income Certificate', 'Domicile'],
        preferences: {
          state: 'Bihar',
          verified: false,
          note: null,
        },
        updatedAt: '2026-11-16T10:00:00Z',
      });

      globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
      const missingResult = await fetchFirestoreDocumentViaRest('profiles', 'missing-uid', 'mock-id-token');
      assert.deepEqual(missingResult, { exists: false, data: null });

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { code: 403, message: 'PERMISSION_DENIED' } }), {
          status: 403,
        })) as typeof fetch;
      await assert.rejects(
        () => fetchFirestoreDocumentViaRest('profiles', 'denied-uid', 'mock-id-token'),
        /Firestore REST GET profiles\/denied-uid failed \(403\)/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    console.log('[PASS] fetchFirestoreDocumentViaRest decoding, 404, and 403 error handling');

    // 3. Live Firestore server connectivity & catalog read
    const conn = await testFirestoreConnection();
    assert.equal(conn.reachable, true, `Expected Firestore to be reachable, got: ${conn.error}`);
    console.log('[PASS] Live testFirestoreConnection() reachable=true');

    const catalog = await getScholarships();
    assert.equal(catalog.isEmptyDatabase, false);
    assert.ok(catalog.items.length >= 16, `Expected >= 16 scholarships, got ${catalog.items.length}`);
    console.log(`[PASS] Live getScholarships() returned ${catalog.items.length} records via retry wrapper`);

    console.log('ALL FIRESTORE OFFLINE FIX CHECKS PASSED');
  } finally {
    await terminate(db).catch(() => {});
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Firestore offline fix test failed:', err);
    process.exit(1);
  });
