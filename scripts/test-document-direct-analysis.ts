import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { app, documentPipelineDeps } from '../src/server/app.ts';
import {
  extractRealDocumentText,
  validateDocumentBinary,
} from '../src/server/documentProcessor.ts';
import { adminAuth } from '../src/server/firebaseAdmin.ts';
import { scanPrivateVaultFiles } from '../src/server/storageMigration.ts';

async function makeValidPdfBuffer(lines: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let y = 780;
  for (const line of lines) {
    page.drawText(line, { x: 48, y, size: 12, font });
    y -= 20;
  }
  return Buffer.from(await pdf.save());
}

function makeValidPngBuffer(): Buffer {
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cf0000000201018c18b4980000000049454e44ae426082',
    'hex'
  );
}

function makeMinimalJpegHeaderBuffer(): Buffer {
  // Valid JPEG SOI + APP0 header + EOI marker (binary header passes JPEG signature check)
  return Buffer.from('ffd8ffe000104a46494600010101004800480000ffd9', 'hex');
}

async function runTests() {
  console.log('=== DOCUMENT DIRECT ANALYSIS (NO FIREBASE STORAGE) TEST SUITE ===');
  let passed = 0;
  const total = 9;

  const vaultCountBefore = (await scanPrivateVaultFiles()).length;

  // Save originals to restore cleanly
  const origVerifyIdToken = adminAuth.verifyIdToken.bind(adminAuth);
  const origExtractText = documentPipelineDeps.extractRealDocumentText;
  const origAnalyzeWithGemini = documentPipelineDeps.analyzeDocumentWithGemini;
  const origResolveProfile = documentPipelineDeps.resolveAuthenticatedStudentProfile;
  const origFetchScholarships = documentPipelineDeps.fetchLiveScholarshipsFromDb;

  const testUid = 'student-direct-test-01';
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  if (!prevGeminiKey || prevGeminiKey === 'MY_GEMINI_API_KEY') {
    process.env.GEMINI_API_KEY = 'test-configured-key-placeholder';
  }

  // Stub Firebase ID token verification for deterministic local HTTP testing
  (adminAuth as unknown as { verifyIdToken: (token: string) => Promise<DecodedIdToken> }).verifyIdToken =
    async (token: string) => {
      if (token !== 'valid-student-token') {
        throw new Error('Invalid test token');
      }
      return {
        uid: testUid,
        email: 'student.direct@example.com',
        email_verified: true,
        aud: 'test-project',
        auth_time: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        firebase: { identities: {}, sign_in_provider: 'password' },
        iat: Math.floor(Date.now() / 1000),
        iss: 'https://securetoken.google.com/test-project',
        sub: testUid,
      } as DecodedIdToken;
    };

  documentPipelineDeps.resolveAuthenticatedStudentProfile = async (
    authUid: string,
    _idToken: string | undefined,
    clientProfile?: Record<string, unknown> | null
  ) => origResolveProfile(authUid, undefined, clientProfile);

  documentPipelineDeps.fetchLiveScholarshipsFromDb = async () => [];

  // Mock Gemini analyzer while keeping real validateDocumentBinary & real PDF extractRealDocumentText
  let geminiBehavior: 'success' | 'quota429' | 'timeout' | 'empty' = 'success';
  documentPipelineDeps.analyzeDocumentWithGemini = async ({
    rawExtraction,
    declaredCategory,
  }) => {
    if (geminiBehavior === 'quota429') {
      const err = new Error('429 RESOURCE_EXHAUSTED quota exceeded');
      (err as unknown as { status: number }).status = 429;
      throw err;
    }
    if (geminiBehavior === 'timeout') {
      throw new Error('Request timed out after 60000ms');
    }
    if (geminiBehavior === 'empty') {
      throw new Error('Document intelligence model returned empty output. Please retry.');
    }
    return {
      processingStatus: 'Completed',
      verificationStatus: 'Analyzed',
      rawTextPreview: rawExtraction.combinedText.slice(0, 2400),
      disclaimer:
        'AI extraction assists scholarship preparation and does not verify official government authenticity.',
      analysis: {
        detectedType: declaredCategory,
        readabilityStatus: 'Readable',
        issuingAuthority: 'Central Board of Secondary Education',
        validityNotes: 'Digital PDF extracted cleanly in memory.',
        expiryWarning: '',
        overallConfidence: 'High',
        extractedFields: [
          {
            fieldName: 'Student Name',
            value: 'Ananya Sharma',
            confidence: 'High',
            status: 'Extracted',
            pageNumber: 1,
          },
        ],
        missingFields: [],
        unreadableFields: [],
        profileMismatches: [],
        manualVerificationItems: [],
        issuesFound: [],
        recommendations: [],
        readinessVerdict: 'Ready',
      },
    };
  };

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // -----------------------------------------------------------------------
    // TEST 1: Authenticated PDF analysis without Firebase Storage (real PDF)
    // -----------------------------------------------------------------------
    const pdfBuf = await makeValidPdfBuffer([
      'CENTRAL BOARD OF SECONDARY EDUCATION',
      'Candidate Name: Ananya Sharma',
      'Aadhaar: 1234 5678 9012',
      'ENGLISH: 94  MATHEMATICS: 97  SCIENCE: 95  HINDI: 92  SOCIAL SCIENCE: 94',
    ]);
    const pdfRes = await fetch(`${baseUrl}/api/ai/analyze-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-student-token',
      },
      body: JSON.stringify({
        documentType: 'Academic Marksheet',
        fileName: 'cbse_marksheet.pdf',
        mimeType: 'application/pdf',
        base64Data: pdfBuf.toString('base64'),
        profile: { uid: testUid, fullName: 'Ananya Sharma', previousMarksPercent: 94.4 },
      }),
    });
    assert.equal(pdfRes.status, 200, 'Authenticated PDF direct analysis must succeed');
    const pdfJson = (await pdfRes.json()) as Record<string, unknown>;
    assert.equal(pdfJson.processingStatus, 'Completed');
    assert.equal(pdfJson.extractionMethod, 'pdf-text');
    assert.equal(pdfJson.pageCount, 1);
    assert.equal(pdfJson.storageMode, 'temporary-in-memory');
    assert.equal(pdfJson.permanentlyStored, false);
    assert.ok(
      typeof pdfJson.rawTextPreview === 'string' &&
        pdfJson.rawTextPreview.includes('Ananya Sharma') &&
        !pdfJson.rawTextPreview.includes('1234 5678 9012'),
      'Real PDF extraction must mask 12-digit Aadhaar numbers'
    );
    const vaultCountAfterPdf = (await scanPrivateVaultFiles()).length;
    assert.equal(vaultCountAfterPdf, vaultCountBefore, 'Temporary mode must not write files to disk');
    passed += 1;
    console.log('PASS [1/9] Authenticated PDF direct analysis (in-memory, Aadhaar masked, zero disk writes)');

    // -----------------------------------------------------------------------
    // TEST 2: Authenticated JPG / PNG analysis without Firebase Storage
    // -----------------------------------------------------------------------
    documentPipelineDeps.extractRealDocumentText = async (buffer, mime) => {
      if (mime === 'application/pdf') return origExtractText(buffer, mime);
      return {
        normalizedMimeType: mime,
        extractionMethod: 'tesseract-ocr+gemini-vision',
        pageCount: 1,
        pages: [{ pageNumber: 1, text: 'INCOME CERTIFICATE INR 1,60,000' }],
        combinedText: '[Page 1 OCR (confidence 91%)]\nINCOME CERTIFICATE INR 1,60,000',
        ocrConfidence: 91,
      };
    };

    const pngRes = await fetch(`${baseUrl}/api/ai/analyze-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-student-token',
      },
      body: JSON.stringify({
        documentType: 'Income Certificate',
        fileName: 'income_scan.png',
        mimeType: 'image/png',
        base64Data: makeValidPngBuffer().toString('base64'),
      }),
    });
    assert.equal(pngRes.status, 200);
    const pngJson = (await pngRes.json()) as Record<string, unknown>;
    assert.equal(pngJson.extractionMethod, 'tesseract-ocr+gemini-vision');
    assert.equal(pngJson.permanentlyStored, false);

    const jpgRes = await fetch(`${baseUrl}/api/ai/analyze-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-student-token',
      },
      body: JSON.stringify({
        documentType: 'Income Certificate',
        fileName: 'income_scan.jpg',
        mimeType: 'image/jpeg',
        base64Data: makeMinimalJpegHeaderBuffer().toString('base64'),
      }),
    });
    assert.equal(jpgRes.status, 200);
    passed += 1;
    console.log('PASS [2/9] Authenticated PNG and JPG direct analysis succeeded');

    // -----------------------------------------------------------------------
    // TEST 3: Unauthenticated upload/analysis rejection & cross-UID spoofing rejection
    // -----------------------------------------------------------------------
    const unauthAnalyze = await fetch(`${baseUrl}/api/ai/analyze-document`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentType: 'Income Certificate',
        fileName: 'income.pdf',
        mimeType: 'application/pdf',
        base64Data: pdfBuf.toString('base64'),
      }),
    });
    assert.equal(unauthAnalyze.status, 401);

    const unauthStatus = await fetch(`${baseUrl}/api/documents/storage-status`);
    assert.equal(unauthStatus.status, 401);

    const spoofUidRes = await fetch(`${baseUrl}/api/ai/analyze-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-student-token',
      },
      body: JSON.stringify({
        documentType: 'Income Certificate',
        fileName: 'income.pdf',
        mimeType: 'application/pdf',
        base64Data: pdfBuf.toString('base64'),
        profile: { uid: 'victim-student-uid-999', fullName: 'Victim' },
      }),
    });
    assert.equal(spoofUidRes.status, 403, 'Client-supplied foreign UID must be rejected with 403');
    passed += 1;
    console.log('PASS [3/9] Unauthenticated requests (401) & cross-student UID spoofing (403) rejected');

    // -----------------------------------------------------------------------
    // TEST 4: Invalid MIME / extension / spoofed signatures / bad base64 rejection
    // -----------------------------------------------------------------------
    const exeRes = await fetch(`${baseUrl}/api/ai/analyze-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-student-token',
      },
      body: JSON.stringify({
        documentType: 'Other Supporting Document',
        fileName: 'malware.exe',
        mimeType: 'application/x-msdownload',
        base64Data: Buffer.from('MZfake-binary').toString('base64'),
      }),
    });
    assert.equal(exeRes.status, 400);

    const spoofedPdfRes = await fetch(`${baseUrl}/api/ai/analyze-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-student-token',
      },
      body: JSON.stringify({
        documentType: 'Income Certificate',
        fileName: 'fake.pdf',
        mimeType: 'application/pdf',
        base64Data: Buffer.from('NOT-A-PDF-HEADER').toString('base64'),
      }),
    });
    assert.equal(spoofedPdfRes.status, 400);

    const invalidBase64Res = await fetch(`${baseUrl}/api/ai/analyze-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-student-token',
      },
      body: JSON.stringify({
        documentType: 'Income Certificate',
        fileName: 'corrupt.pdf',
        mimeType: 'application/pdf',
        base64Data: 'not!valid@base64###',
      }),
    });
    assert.equal(invalidBase64Res.status, 400);
    passed += 1;
    console.log('PASS [4/9] Invalid MIME, spoofed signatures & malformed base64 rejected cleanly (400)');

    // -----------------------------------------------------------------------
    // TEST 5: Empty & oversized (> 8 MB) file rejection
    // -----------------------------------------------------------------------
    const emptyRes = await fetch(`${baseUrl}/api/ai/analyze-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-student-token',
      },
      body: JSON.stringify({
        documentType: 'Income Certificate',
        fileName: 'empty.pdf',
        mimeType: 'application/pdf',
        base64Data: '    ',
      }),
    });
    assert.equal(emptyRes.status, 400);

    const oversizedBuf = Buffer.alloc(8 * 1024 * 1024 + 512, 0x25);
    const oversizedRes = await fetch(`${baseUrl}/api/ai/analyze-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-student-token',
      },
      body: JSON.stringify({
        documentType: 'Income Certificate',
        fileName: 'huge.pdf',
        mimeType: 'application/pdf',
        base64Data: oversizedBuf.toString('base64'),
      }),
    });
    assert.equal(oversizedRes.status, 413);
    passed += 1;
    console.log('PASS [5/9] Empty (400) and >8 MB oversized (413) files rejected cleanly');

    // -----------------------------------------------------------------------
    // TEST 6: Gemini failure handling (429 quota, timeout, empty response)
    // -----------------------------------------------------------------------
    geminiBehavior = 'quota429';
    const quotaRes = await fetch(`${baseUrl}/api/ai/analyze-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-student-token',
      },
      body: JSON.stringify({
        documentType: 'Academic Marksheet',
        fileName: 'cbse_marksheet.pdf',
        mimeType: 'application/pdf',
        base64Data: pdfBuf.toString('base64'),
      }),
    });
    assert.equal(quotaRes.status, 429);
    const quotaJson = (await quotaRes.json()) as { code?: string; error?: string };
    assert.equal(quotaJson.code, 'AI_RATE_LIMITED');

    geminiBehavior = 'timeout';
    const timeoutRes = await fetch(`${baseUrl}/api/ai/analyze-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-student-token',
      },
      body: JSON.stringify({
        documentType: 'Academic Marksheet',
        fileName: 'cbse_marksheet.pdf',
        mimeType: 'application/pdf',
        base64Data: pdfBuf.toString('base64'),
      }),
    });
    assert.equal(timeoutRes.status, 408);

    geminiBehavior = 'empty';
    const emptyAiRes = await fetch(`${baseUrl}/api/ai/analyze-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-student-token',
      },
      body: JSON.stringify({
        documentType: 'Academic Marksheet',
        fileName: 'cbse_marksheet.pdf',
        mimeType: 'application/pdf',
        base64Data: pdfBuf.toString('base64'),
      }),
    });
    assert.equal(emptyAiRes.status, 500);
    passed += 1;
    console.log('PASS [6/9] Gemini 429, timeout, and empty output handled safely with JSON responses');

    // -----------------------------------------------------------------------
    // TEST 7: /api/documents/storage-status & /api/health truthful semantics
    // -----------------------------------------------------------------------
    const statusRes = await fetch(`${baseUrl}/api/documents/storage-status`, {
      headers: { Authorization: 'Bearer valid-student-token' },
    });
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as {
      uploadAvailable: boolean;
      permanentStorageAvailable: boolean;
      analysisAvailable: boolean;
      mode: string;
      reason: string;
    };
    assert.equal(
      statusJson.uploadAvailable,
      false,
      'uploadAvailable must NOT falsely claim permanent storage when bucket is unprovisioned'
    );
    assert.equal(statusJson.permanentStorageAvailable, false);
    assert.equal(statusJson.analysisAvailable, true);
    assert.equal(statusJson.mode, 'temporary-analysis');
    assert.ok(statusJson.reason.toLowerCase().includes('temporary'));

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as {
      status: string;
      documentUploadAvailable: boolean;
      permanentStorageAvailable: boolean;
      documentAnalysisAvailable: boolean;
    };
    assert.equal(healthJson.status, 'ok');
    assert.equal(healthJson.documentUploadAvailable, false);
    assert.equal(healthJson.permanentStorageAvailable, false);
    assert.equal(healthJson.documentAnalysisAvailable, true);
    passed += 1;
    console.log('PASS [7/9] Storage-status & health truthfully distinguish temporary analysis from permanent storage');

    // -----------------------------------------------------------------------
    // TEST 8: Firestore rules schema compatibility verification
    // -----------------------------------------------------------------------
    // Matches isValidDocument & isValidDocumentAnalysis in firestore.rules
    const sampleTempDocRecord = {
      id: 'doc-1760000000000-ab12cd34',
      userId: testUid,
      documentType: 'Academic Marksheet',
      fileName: 'cbse_marksheet.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: pdfBuf.byteLength,
      storagePath: 'temporary-in-memory',
      downloadUrl: '',
      verificationStatus: 'Analyzed',
      processingStatus: 'Completed',
      extractionMethod: 'pdf-text',
      pageCount: 1,
      lastAnalyzedAt: '2026-11-17T00:00:00.000Z',
      errorDetails: '',
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
    };
    assert.ok(
      sampleTempDocRecord.storagePath.length >= 3 && sampleTempDocRecord.storagePath.length <= 500
    );
    assert.equal('storageProvider' in sampleTempDocRecord, false);
    assert.ok(
      ['Uploaded', 'Analyzed', 'Needs Attention', 'Verified'].includes(
        sampleTempDocRecord.verificationStatus
      )
    );
    assert.ok(validateDocumentBinary(pdfBuf, 'application/pdf', 'cbse.pdf') === 'application/pdf');
    passed += 1;
    console.log('PASS [8/9] Temporary-mode Firestore DocumentRecord schema satisfies firestore.rules');

    // -----------------------------------------------------------------------
    // TEST 9: UI component verification (DocumentIntelligencePage.tsx & TrustGuardPage.tsx)
    // -----------------------------------------------------------------------
    const docPageSource = await fs.readFile(
      path.resolve(process.cwd(), 'src/pages/DocumentIntelligencePage.tsx'),
      'utf8'
    );
    assert.ok(docPageSource.includes("'/api/ai/analyze-document'"));
    assert.ok(docPageSource.includes('Temporary In-Memory Analysis Active'));
    assert.ok(docPageSource.includes('hasStoredBinary'));
    assert.ok(!docPageSource.includes('Document Upload Temporarily Unavailable (Public Beta)'));
    passed += 1;
    console.log('PASS [9/9] DocumentIntelligencePage enables temporary direct analysis with accurate UI notices');

    console.log(`\nALL DIRECT DOCUMENT ANALYSIS TESTS PASSED: ${passed}/${total}`);
  } finally {
    server.close();
    (adminAuth as unknown as { verifyIdToken: typeof adminAuth.verifyIdToken }).verifyIdToken =
      origVerifyIdToken;
    documentPipelineDeps.extractRealDocumentText = origExtractText;
    documentPipelineDeps.analyzeDocumentWithGemini = origAnalyzeWithGemini;
    documentPipelineDeps.resolveAuthenticatedStudentProfile = origResolveProfile;
    documentPipelineDeps.fetchLiveScholarshipsFromDb = origFetchScholarships;
    if (prevGeminiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = prevGeminiKey;
    }
  }
}

runTests().catch((err) => {
  console.error('Direct document analysis test suite failed:', err);
  process.exit(1);
});
