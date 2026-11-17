import assert from 'node:assert/strict';
import { VERIFIED_INDIAN_SCHOLARSHIPS } from '../src/data/verifiedScholarships.ts';
import {
  AI_MESSAGE_MAX_LENGTH,
  AICompanionValidationError,
  boundCompanionReplyForStorage,
  formatCompanionErrorMessage,
  normalizeRetrievedMessages,
  parseCompanionApiResponse,
  validateAndBuildAIMessage,
} from '../src/lib/aiMessageUtils.ts';
import { parseJsonApiResponse, postProtectedAi } from '../src/lib/apiClient.ts';
import { persistAIMessage } from '../src/lib/firestoreRepo.ts';
import { CompanionError, type StudentDatabaseSnapshot } from '../src/server/companionContext.ts';
import {
  classifyGeminiError,
  extractGeminiReplyText,
  generateCompanionReply,
} from '../src/server/companionService.ts';
import { GEMINI_COMPANION_MODEL, GEMINI_MODEL } from '../src/server/gemini.ts';
import type { AIMessage, StudentProfile } from '../src/types/database.ts';

function createTestSnapshot(uid = 'student-test-1'): StudentDatabaseSnapshot {
  const now = '2026-11-16T10:00:00.000Z';
  const profile: StudentProfile = {
    uid,
    fullName: 'Riya Sharma',
    email: 'riya@example.com',
    state: 'Maharashtra',
    category: 'General',
    educationLevel: 'Undergraduate (UG)',
    previousMarksPercent: 91,
    familyAnnualIncomeInr: 220000,
    onboardingCompleted: true,
    createdAt: now,
    updatedAt: now,
  };

  return {
    profile,
    documents: [],
    documentAnalyses: [],
    eligibilityAssessments: [],
    savedScholarships: [],
    applications: [],
    readinessAssessments: [],
    notifications: [],
    sourceMode: 'verified-client-snapshot',
  };
}

async function runTests() {
  console.log('=== AI Companion Firestore Undefined Content Regression Tests ===');

  const storedMessages = new Map<string, AIMessage>();
  const conversationUpdates: Array<{ conversationId: string; updatedAt: string }> = [];

  const mockAdapter = {
    writeMessage: async (cleanMsg: AIMessage) => {
      for (const [key, value] of Object.entries(cleanMsg)) {
        assert.notEqual(
          value,
          undefined,
          `Firestore setDoc payload field "${key}" must never be undefined`
        );
      }
      assert.equal(typeof cleanMsg.content, 'string');
      assert.ok(cleanMsg.content.trim().length > 0);
      storedMessages.set(cleanMsg.id, cleanMsg);
    },
    touchConversation: async (conversationId: string, updatedAt: string) => {
      conversationUpdates.push({ conversationId, updatedAt });
    },
  };

  // 1. Valid user message persistence
  {
    const userMsg: AIMessage = {
      id: 'msg-user-1',
      conversationId: 'conv-thread-1',
      userId: 'student-test-1',
      role: 'user',
      content: '  Which scholarships fit my Maharashtra UG profile?  ',
      createdAt: '2026-11-16T10:01:00.000Z',
    };

    const persisted = await persistAIMessage(userMsg, mockAdapter);
    assert.equal(persisted.id, 'msg-user-1');
    assert.equal(persisted.conversationId, 'conv-thread-1');
    assert.equal(persisted.userId, 'student-test-1');
    assert.equal(persisted.role, 'user');
    assert.equal(persisted.content, 'Which scholarships fit my Maharashtra UG profile?');
    assert.equal(storedMessages.get('msg-user-1')?.content, persisted.content);
    assert.equal(conversationUpdates.length, 1);
    assert.equal(conversationUpdates[0]?.conversationId, 'conv-thread-1');
    console.log('PASS [1] Valid user message persistence verified');
  }

  // 2. Valid assistant response persistence
  {
    const snapshot = createTestSnapshot('student-test-1');
    const apiResult = await generateCompanionReply({
      message: 'Which scholarships fit my Maharashtra UG profile?',
      history: [{ role: 'user', content: 'Which scholarships fit my Maharashtra UG profile?' }],
      scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
      snapshot,
      generateTextFn: async () =>
        'Based on your Maharashtra UG profile, check the verified scholarships listed in your dashboard.',
    });

    assert.ok(apiResult.diagnostics.promptChars > 0);
    assert.ok(apiResult.diagnostics.replyChars && apiResult.diagnostics.replyChars > 0);
    assert.equal(apiResult.diagnostics.attempts, 1);
    assert.equal(apiResult.diagnostics.model, GEMINI_COMPANION_MODEL);

    const parsedApi = parseCompanionApiResponse(apiResult);
    const assistantMsg = validateAndBuildAIMessage({
      id: 'msg-assistant-1',
      conversationId: 'conv-thread-1',
      userId: 'student-test-1',
      role: 'assistant',
      content: parsedApi.reply,
      createdAt: '2026-11-16T10:01:05.000Z',
    });

    const persisted = await persistAIMessage(assistantMsg, mockAdapter);
    assert.equal(persisted.role, 'assistant');
    assert.ok(persisted.content.includes('Maharashtra UG profile'));
    assert.equal(storedMessages.size, 2);
    assert.equal(conversationUpdates.length, 2);
    console.log('PASS [2] Valid assistant response & diagnostics persistence verified');
  }

  // 3. Missing, malformed, empty, or safety-blocked Gemini responses
  {
    const snapshot = createTestSnapshot('student-test-1');
    const writeCountBefore = storedMessages.size;

    // 3a. Missing / undefined Gemini reply
    await assert.rejects(
      () =>
        generateCompanionReply({
          message: 'Hello',
          history: [],
          scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
          snapshot,
          generateTextFn: async () => undefined,
        }),
      (err: unknown) => err instanceof CompanionError && err.code === 'AI_EMPTY_RESPONSE'
    );

    // 3b. Whitespace-only Gemini reply
    await assert.rejects(
      () =>
        generateCompanionReply({
          message: 'Hello',
          history: [],
          scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
          snapshot,
          generateTextFn: async () => '   \n\t  ',
        }),
      (err: unknown) => err instanceof CompanionError && err.code === 'AI_EMPTY_RESPONSE'
    );

    // 3c. Malformed / safety-blocked raw GenerateContentResponse extraction
    assert.throws(
      () => extractGeminiReplyText(null),
      (err: unknown) => err instanceof CompanionError && err.code === 'AI_EMPTY_RESPONSE'
    );
    assert.throws(
      () =>
        extractGeminiReplyText({
          candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
        }),
      (err: unknown) => err instanceof CompanionError && err.code === 'AI_RESPONSE_BLOCKED'
    );
    assert.throws(
      () =>
        extractGeminiReplyText({
          candidates: [{ finishReason: 'PROHIBITED_CONTENT', content: { parts: [] } }],
        }),
      (err: unknown) => err instanceof CompanionError && err.code === 'AI_RESPONSE_BLOCKED'
    );
    assert.throws(
      () =>
        extractGeminiReplyText({
          candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }],
        }),
      (err: unknown) => err instanceof CompanionError && err.code === 'AI_EMPTY_RESPONSE'
    );

    // 3d. Candidate parts fallback when `.text` is omitted
    const extractedFromParts = extractGeminiReplyText({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [{ text: 'thinking...', thought: true }, { text: 'Verified answer.' }],
          },
        },
      ],
    });
    assert.equal(extractedFromParts, 'Verified answer.');

    // 3e. Malformed / missing `reply` in HTTP JSON payload (e.g. `{}` after failed JSON parse)
    for (const badPayload of [undefined, null, {}, { reply: undefined }, { reply: null }, { reply: '   ' }, { reply: 123 }]) {
      assert.throws(
        () => parseCompanionApiResponse(badPayload),
        (err: unknown) => err instanceof AICompanionValidationError
      );
    }

    assert.equal(
      storedMessages.size,
      writeCountBefore,
      'Missing or malformed Gemini responses must never persist placeholder messages'
    );
    console.log('PASS [3] Missing, empty, safety-blocked, and malformed Gemini responses rejected safely');
  }

  // 4. Undefined / null / empty / oversized content rejection in Firestore persistence path
  {
    let writeInvocations = 0;
    const strictRejectAdapter = {
      writeMessage: async () => {
        writeInvocations += 1;
      },
      touchConversation: async () => {
        writeInvocations += 1;
      },
    };

    const invalidInputs = [
      undefined,
      null,
      '',
      '    \n ',
      12345,
      { text: 'not a string' },
      'x'.repeat(AI_MESSAGE_MAX_LENGTH + 1),
    ];

    for (const badContent of invalidInputs) {
      await assert.rejects(
        () =>
          persistAIMessage(
            {
              id: 'msg-bad',
              conversationId: 'conv-thread-1',
              userId: 'student-test-1',
              role: 'assistant',
              content: badContent as unknown as string,
              createdAt: '2026-11-16T10:02:00.000Z',
            },
            strictRejectAdapter
          ),
        (err: unknown) => err instanceof AICompanionValidationError
      );
    }

    assert.equal(
      writeInvocations,
      0,
      'setDoc adapter must never be called when content is undefined, null, empty, or invalid'
    );

    // Verify long Gemini replies (>10,000 chars) are bounded cleanly within Firestore rules limit
    const hugeReply = `${'Eligible scholarship details. '.repeat(450)}`;
    assert.ok(hugeReply.length > AI_MESSAGE_MAX_LENGTH);
    const bounded = boundCompanionReplyForStorage(hugeReply);
    assert.ok(bounded.length <= AI_MESSAGE_MAX_LENGTH && bounded.length > 0);
    const builtFromBounded = validateAndBuildAIMessage({
      id: 'msg-long-1',
      conversationId: 'conv-thread-1',
      userId: 'student-test-1',
      role: 'assistant',
      content: bounded,
      createdAt: '2026-11-16T10:02:10.000Z',
    });
    assert.ok(builtFromBounded.content.length <= AI_MESSAGE_MAX_LENGTH);
    console.log('PASS [4] Undefined, null, empty, non-string, and oversized content rejection verified');
  }

  // 5. Thread history retrieval normalization & readable error formatting
  {
    const rawFromFirestore: unknown[] = [
      {
        id: 'msg-2',
        conversationId: 'conv-thread-1',
        userId: 'student-test-1',
        role: 'assistant',
        content: 'Second turn response.',
        createdAt: '2026-11-16T10:02:00.000Z',
      },
      {
        id: 'msg-corrupted-undefined',
        conversationId: 'conv-thread-1',
        userId: 'student-test-1',
        role: 'assistant',
        content: undefined,
        createdAt: '2026-11-16T10:01:30.000Z',
      },
      {
        id: 'msg-corrupted-empty',
        conversationId: 'conv-thread-1',
        userId: 'student-test-1',
        role: 'user',
        content: '   ',
        createdAt: '2026-11-16T10:01:40.000Z',
      },
      {
        id: 'msg-other-thread',
        conversationId: 'conv-thread-2',
        userId: 'student-test-1',
        role: 'user',
        content: 'Belongs to another thread',
        createdAt: '2026-11-16T10:00:30.000Z',
      },
      {
        id: 'msg-1',
        conversationId: 'conv-thread-1',
        userId: 'student-test-1',
        role: 'user',
        content: 'First turn prompt.',
        createdAt: '2026-11-16T10:01:00.000Z',
      },
      // Duplicate ID should be deduplicated
      {
        id: 'msg-1',
        conversationId: 'conv-thread-1',
        userId: 'student-test-1',
        role: 'user',
        content: 'First turn prompt.',
        createdAt: '2026-11-16T10:01:00.000Z',
      },
    ];

    const normalized = normalizeRetrievedMessages(rawFromFirestore, 'conv-thread-1');
    assert.equal(normalized.length, 2);
    assert.deepEqual(
      normalized.map((m) => m.id),
      ['msg-1', 'msg-2']
    );
    assert.equal(normalized[0]?.content, 'First turn prompt.');
    assert.equal(normalized[1]?.content, 'Second turn response.');

    // Verify raw Firestore JSON error is translated into a readable message
    const rawFirebaseJsonError = new Error(
      JSON.stringify({
        error:
          'Function setDoc() called with invalid data. Unsupported field value: undefined (found in field content in document ai_messages/msg-123)',
        operationType: 'create',
        path: 'ai_messages/msg-123',
        authInfo: { userId: 'uid-secret' },
      })
    );
    const userFriendly = formatCompanionErrorMessage(
      rawFirebaseJsonError,
      'Fallback error message.'
    );
    assert.equal(userFriendly.includes('setDoc()'), false);
    assert.equal(userFriendly.includes('authInfo'), false);
    assert.ok(userFriendly.includes('content was missing or incomplete'));

    console.log('PASS [5] Thread history retrieval normalization and readable error formatting verified');
  }

  // 6. Transient 503 retry recovery, fallback model selection, and exhausted 503 classification
  {
    const snapshot = createTestSnapshot('student-test-1');
    const modelsTried: string[] = [];

    const recovered = await generateCompanionReply({
      message: 'Which scholarships fit my profile?',
      history: [],
      scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
      snapshot,
      maxRetries: 2,
      retryDelayMs: 10,
      generateTextFn: async ({ model }) => {
        modelsTried.push(model);
        if (modelsTried.length <= 2) {
          const err = new Error('This model is currently experiencing high demand.') as Error & {
            status: number;
          };
          err.status = 503;
          throw err;
        }
        return 'Recovered on fallback model with grounded scholarship details.';
      },
    });

    assert.equal(recovered.diagnostics.attempts, 3);
    assert.deepEqual(modelsTried, [GEMINI_COMPANION_MODEL, GEMINI_COMPANION_MODEL, GEMINI_MODEL]);
    assert.equal(recovered.diagnostics.model, GEMINI_MODEL);
    assert.ok(recovered.reply.includes('Recovered on fallback model'));

    // Exhausted 503 throws AI_HIGH_DEMAND (httpStatus 503)
    await assert.rejects(
      () =>
        generateCompanionReply({
          message: 'Which scholarships fit my profile?',
          history: [],
          scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
          snapshot,
          maxRetries: 1,
          retryDelayMs: 10,
          generateTextFn: async () => {
            const err = new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}') as Error & {
              status: number;
            };
            err.status = 503;
            throw err;
          },
        }),
      (err: unknown) =>
        err instanceof CompanionError && err.code === 'AI_HIGH_DEMAND' && err.httpStatus === 503
    );

    const classified503 = classifyGeminiError(
      Object.assign(new Error('503 UNAVAILABLE'), { status: 503 })
    );
    assert.equal(classified503.code, 'AI_HIGH_DEMAND');
    assert.equal(classified503.httpStatus, 503);
    console.log('PASS [6] Transient 503 retry recovery, fallback routing, and AI_HIGH_DEMAND classification verified');
  }

  // 7. apiClient.ts rejects 200 OK HTML (Nginx warmup interception) & non-JSON instead of returning {}
  {
    const htmlWarmupResponse = new Response('<html><body>Starting Server...</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    await assert.rejects(
      () => parseJsonApiResponse(htmlWarmupResponse),
      (err: unknown) => err instanceof Error && err.message.includes('non-JSON response')
    );

    const emptyJsonResponse = new Response('', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await assert.rejects(
      () => parseJsonApiResponse(emptyJsonResponse),
      (err: unknown) => err instanceof Error && err.message.includes('non-JSON response')
    );

    const serverErrorResponse = new Response(
      JSON.stringify({
        error: 'The Gemini model is temporarily experiencing high demand. Please wait a few seconds and retry.',
        code: 'AI_HIGH_DEMAND',
      }),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }
    );
    await assert.rejects(
      () => parseJsonApiResponse(serverErrorResponse),
      (err: unknown) => err instanceof Error && err.message.includes('high demand')
    );

    // Verify postProtectedAi end-to-end with stubbed fetch returning valid JSON
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ reply: 'Grounded scholarship answer.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      const res = await postProtectedAi<{ reply: string }>('/api/ai/companion', 'test-token', {
        message: 'hi',
      });
      const parsed = parseCompanionApiResponse(res);
      assert.equal(parsed.reply, 'Grounded scholarship answer.');
    } finally {
      globalThis.fetch = originalFetch;
    }

    console.log('PASS [7] apiClient HTML/non-JSON gateway error rejection and JSON parsing verified');
  }

  // 8. Live Gemini API end-to-end grounded test (when GEMINI_API_KEY is present in env)
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY') {
    const snapshot = createTestSnapshot('student-live-1');
    const liveResult = await generateCompanionReply({
      message: 'Which 1 scholarship in my database should a Maharashtra General UG student with ₹2,20,000 family income check, and what is its official URL?',
      history: [],
      scholarships: VERIFIED_INDIAN_SCHOLARSHIPS,
      snapshot,
    });
    const parsedLive = parseCompanionApiResponse(liveResult);
    const liveMsg = validateAndBuildAIMessage({
      id: 'msg-live-1',
      conversationId: 'conv-live-1',
      userId: 'student-live-1',
      role: 'assistant',
      content: parsedLive.reply,
      createdAt: new Date().toISOString(),
    });
    assert.ok(liveMsg.content.length > 20);
    assert.ok(liveMsg.content.includes('https://'), 'Live reply must cite official scholarship URL');
    console.log(
      `PASS [8] Live Gemini API verified (model=${liveResult.diagnostics.model}, ms=${liveResult.diagnostics.durationMs}, replyChars=${liveMsg.content.length})`
    );
  } else {
    console.log('SKIP [8] GEMINI_API_KEY not set in current shell environment');
  }

  console.log('ALL AI COMPANION REGRESSION TESTS PASSED');
}

runTests().catch((err) => {
  console.error('AI Companion regression test suite failed:', err);
  process.exit(1);
});
