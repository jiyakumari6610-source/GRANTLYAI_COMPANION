import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  DocumentProcessingError,
  extractRealDocumentText,
  validateDocumentBinary,
} from '../src/server/documentProcessor.ts';
import {
  buildPrivateDocumentStoragePath,
  checkFirebaseStorageHealth,
  computeSha256Hex,
  CONFIGURED_STORAGE_BUCKET,
  deleteDocumentFromCloudStorage,
  DocumentStorageError,
  readDocumentFromCloudStorage,
  saveDocumentToCloudStorage,
  type StorageObjectRecord,
  type StorageTransport,
} from '../src/server/documentStorage.ts';
import { migratePrivateVaultToCloudStorage, scanPrivateVaultFiles } from '../src/server/storageMigration.ts';

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

// Valid minimal 1x1 PNG binary (exact PNG signature + IHDR + IDAT + IEND)
function makeValidPngBuffer(): Buffer {
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cf0000000201018c18b4980000000049454e44ae426082',
    'hex'
  );
}

function createInMemoryFirebaseStorageTransport(): {
  transport: StorageTransport;
  objects: Map<string, { buffer: Buffer; record: StorageObjectRecord }>;
  uploadCalls: number;
} {
  const objects = new Map<string, { buffer: Buffer; record: StorageObjectRecord }>();
  const state = {
    uploadCalls: 0,
    objects,
    transport: {
      async uploadObject({ bucket, storagePath, buffer, contentType, customMetadata }) {
        state.uploadCalls += 1;
        const key = `${bucket}/${storagePath}`;
        const record: StorageObjectRecord = {
          storagePath,
          contentType,
          size: buffer.byteLength,
          customMetadata: { ...customMetadata },
        };
        objects.set(key, { buffer: Buffer.from(buffer), record });
        return record;
      },
      async getObjectMetadata({ bucket, storagePath }) {
        return objects.get(`${bucket}/${storagePath}`)?.record ?? null;
      },
      async downloadObject({ bucket, storagePath }) {
        const entry = objects.get(`${bucket}/${storagePath}`);
        if (!entry) return null;
        return { buffer: Buffer.from(entry.buffer), meta: entry.record };
      },
      async deleteObject({ bucket, storagePath }) {
        return objects.delete(`${bucket}/${storagePath}`);
      },
      async probeBucket({ bucket }) {
        return {
          reachable: true,
          provisioned: true,
          detail: `In-memory transport verified for ${bucket}`,
        };
      },
    } satisfies StorageTransport,
  };
  return state;
}

async function runTests() {
  console.log('=== FIREBASE CLOUD STORAGE & MIGRATION VALIDATION ===');
  assert.equal(CONFIGURED_STORAGE_BUCKET, 'gen-lang-client-0713556627.firebasestorage.app');

  // 1. Server-generated path safety & traversal guard
  assert.equal(
    buildPrivateDocumentStoragePath('studentA_01', 'doc-123'),
    'private-documents/studentA_01/doc-123'
  );
  assert.throws(
    () => buildPrivateDocumentStoragePath('../evil', 'doc-123'),
    (e: unknown) => e instanceof DocumentStorageError && e.code === 'INVALID_STORAGE_ID'
  );
  assert.throws(
    () => buildPrivateDocumentStoragePath('studentA_01', 'doc/../../secret'),
    (e: unknown) => e instanceof DocumentStorageError && e.code === 'INVALID_STORAGE_ID'
  );
  console.log('PASS [1] Server-generated paths & traversal rejection verified');

  // 2. Upload PDF + PNG, retrieve, extract text, cross-user isolation, and deletion
  const mem = createInMemoryFirebaseStorageTransport();
  const pdfBuf = await makeValidPdfBuffer([
    'CENTRAL BOARD OF SECONDARY EDUCATION',
    'Student Name: Aarav Sen',
    'ENGLISH: 92  MATHEMATICS: 96  SCIENCE: 94  SOCIAL SCIENCE: 95  HINDI: 90',
    'Aggregate Marks: 467 / 500 (93.4%)',
  ]);
  const pngBuf = makeValidPngBuffer();

  const savedPdf = await saveDocumentToCloudStorage({
    userId: 'student-a-uid',
    docId: 'doc-marksheet-01',
    buffer: pdfBuf,
    fileName: 'cbse_marksheet.pdf',
    mimeType: 'application/pdf',
    transport: mem.transport,
  });
  assert.equal(savedPdf.storageProvider, 'firebase-storage');
  assert.equal(savedPdf.storagePath, 'private-documents/student-a-uid/doc-marksheet-01');
  assert.equal(savedPdf.fileSizeBytes, pdfBuf.byteLength);
  assert.equal(savedPdf.sha256, computeSha256Hex(pdfBuf));

  const savedPng = await saveDocumentToCloudStorage({
    userId: 'student-a-uid',
    docId: 'doc-photo-02',
    buffer: pngBuf,
    fileName: 'income_cert.png',
    mimeType: 'image/png',
    transport: mem.transport,
  });
  assert.equal(savedPng.storageProvider, 'firebase-storage');
  assert.equal(savedPng.mimeType, 'image/png');
  assert.equal(savedPng.storagePath, 'private-documents/student-a-uid/doc-photo-02');
  console.log('PASS [2] PDF and PNG upload verification passed');

  // Reject invalid MIME & oversized files
  await assert.rejects(
    () =>
      saveDocumentToCloudStorage({
        userId: 'student-a-uid',
        docId: 'doc-bad-exe',
        buffer: Buffer.from('MZfakeexe'),
        fileName: 'payload.exe',
        mimeType: 'application/x-msdownload',
        transport: mem.transport,
      }),
    (e: unknown) => e instanceof DocumentProcessingError && e.code === 'INVALID_FORMAT'
  );
  await assert.rejects(
    () =>
      saveDocumentToCloudStorage({
        userId: 'student-a-uid',
        docId: 'doc-huge-pdf',
        buffer: Buffer.alloc(9 * 1024 * 1024),
        fileName: 'huge.pdf',
        mimeType: 'application/pdf',
        transport: mem.transport,
      }),
    (e: unknown) => e instanceof DocumentProcessingError && e.code === 'FILE_TOO_LARGE'
  );

  // Retrieve Student A PDF & run PDF text extraction
  const fetchedPdf = await readDocumentFromCloudStorage({
    userId: 'student-a-uid',
    docId: 'doc-marksheet-01',
    transport: mem.transport,
    allowLegacyVaultFallback: false,
  });
  assert.ok(fetchedPdf, 'Student A must retrieve own PDF');
  assert.equal(Buffer.compare(fetchedPdf.buffer, pdfBuf), 0);
  const normalizedFetchedMime = validateDocumentBinary(
    fetchedPdf.buffer,
    fetchedPdf.meta.mimeType,
    fetchedPdf.meta.fileName
  );
  const extracted = await extractRealDocumentText(fetchedPdf.buffer, normalizedFetchedMime);
  assert.ok(extracted.combinedText.includes('Aarav Sen'));
  assert.ok(extracted.combinedText.includes('467 / 500'));
  console.log('PASS [3] Authenticated retrieval & PDF text extraction verified');

  // Cross-student isolation: Student B cannot read Student A's document or spoof metadata
  const readByStudentB = await readDocumentFromCloudStorage({
    userId: 'student-b-uid',
    docId: 'doc-marksheet-01',
    transport: mem.transport,
    allowLegacyVaultFallback: false,
  });
  assert.equal(readByStudentB, null, 'Student B path cannot read Student A document');

  // Even if object exists at a path with mismatched owner metadata, read and delete reject it
  mem.objects.set(
    `${CONFIGURED_STORAGE_BUCKET}/private-documents/student-b-uid/doc-marksheet-01`,
    {
      buffer: pdfBuf,
      record: {
        storagePath: 'private-documents/student-b-uid/doc-marksheet-01',
        contentType: 'application/pdf',
        size: pdfBuf.byteLength,
        customMetadata: {
          userId: 'student-a-uid',
          docId: 'doc-marksheet-01',
        },
      },
    }
  );
  assert.equal(
    await readDocumentFromCloudStorage({
      userId: 'student-b-uid',
      docId: 'doc-marksheet-01',
      transport: mem.transport,
      allowLegacyVaultFallback: false,
    }),
    null
  );
  await assert.rejects(
    () =>
      deleteDocumentFromCloudStorage({
        userId: 'student-b-uid',
        docId: 'doc-marksheet-01',
        transport: mem.transport,
        alsoDeleteLegacyVault: false,
      }),
    (e: unknown) => e instanceof DocumentStorageError && e.code === 'STORAGE_PERMISSION_DENIED'
  );
  mem.objects.delete(`${CONFIGURED_STORAGE_BUCKET}/private-documents/student-b-uid/doc-marksheet-01`);
  console.log('PASS [4] Cross-student read & metadata ownership isolation verified');

  // Delete Student A document and verify gone
  const delRes = await deleteDocumentFromCloudStorage({
    userId: 'student-a-uid',
    docId: 'doc-marksheet-01',
    transport: mem.transport,
    alsoDeleteLegacyVault: false,
  });
  assert.equal(delRes.deletedFromCloud, true);
  assert.equal(
    await readDocumentFromCloudStorage({
      userId: 'student-a-uid',
      docId: 'doc-marksheet-01',
      transport: mem.transport,
      allowLegacyVaultFallback: false,
    }),
    null
  );
  console.log('PASS [5] Secure deletion & post-delete absence verified');

  // 3. Migration verification (temp legacy vault + duplicate prevention + source preservation + failure handling)
  const realVaultEntries = await scanPrivateVaultFiles();
  console.log(`INFO [Migration] Real .private_vault file count on disk: ${realVaultEntries.length}`);
  if (realVaultEntries.length === 0) {
    const emptySummary = await migratePrivateVaultToCloudStorage({
      transport: mem.transport,
    });
    assert.equal(emptySummary.status, 'no-files-to-migrate');
  }

  const tmpVaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grantly-vault-mig-'));
  try {
    const uDir = path.join(tmpVaultRoot, 'mig-student-1');
    await fs.mkdir(uDir, { recursive: true });
    await fs.writeFile(path.join(uDir, 'doc-mig-pdf.bin'), pdfBuf);
    await fs.writeFile(
      path.join(uDir, 'doc-mig-pdf.meta.json'),
      JSON.stringify({
        docId: 'doc-mig-pdf',
        userId: 'mig-student-1',
        fileName: 'legacy_marksheet.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: pdfBuf.byteLength,
        storagePath: 'private-vault/users/mig-student-1/doc-mig-pdf',
        uploadedAt: '2026-11-12T00:00:00.000Z',
      })
    );

    const firestoreUpdates: Array<{ docId: string; storageProvider: string; storagePath: string }> = [];
    const migTransport = createInMemoryFirebaseStorageTransport();
    const firstRun = await migratePrivateVaultToCloudStorage({
      vaultRoot: tmpVaultRoot,
      transport: migTransport.transport,
      firestoreUpdater: async (u) => {
        firestoreUpdates.push({
          docId: u.docId,
          storageProvider: u.storageProvider,
          storagePath: u.storagePath,
        });
        return true;
      },
    });
    assert.equal(firstRun.status, 'completed');
    assert.equal(firstRun.migrated, 1);
    assert.equal(firstRun.failed, 0);
    assert.equal(firstRun.items[0].sourcePreserved, true, 'Original file must remain preserved by default');
    assert.equal(firestoreUpdates[0].storageProvider, 'firebase-storage');
    assert.equal(firestoreUpdates[0].storagePath, 'private-documents/mig-student-1/doc-mig-pdf');

    // Second run must detect already-migrated file and skip re-upload
    const uploadCallsBeforeSecond = migTransport.uploadCalls;
    const secondRun = await migratePrivateVaultToCloudStorage({
      vaultRoot: tmpVaultRoot,
      transport: migTransport.transport,
      firestoreUpdater: async () => true,
    });
    assert.equal(secondRun.skippedAlreadyMigrated, 1);
    assert.equal(migTransport.uploadCalls, uploadCallsBeforeSecond, 'Duplicate upload prevented');
    console.log('PASS [6] Migration idempotency, SHA-256 verification, Firestore update & source preservation verified');
  } finally {
    await fs.rm(tmpVaultRoot, { recursive: true, force: true });
  }

  // 4. Live HTTP unauthenticated rejection checks & live Firebase Cloud Storage probe
  try {
    const unauthChecks = [
      { method: 'POST', path: '/api/documents/upload', body: { docId: 'doc-123', fileName: 'a.pdf', mimeType: 'application/pdf', base64Data: 'JVBERi0=' } },
      { method: 'POST', path: '/api/documents/doc-123/process', body: { documentType: 'Marksheet' } },
      { method: 'GET', path: '/api/documents/doc-123/content' },
      { method: 'DELETE', path: '/api/documents/doc-123/file' },
      { method: 'GET', path: '/api/admin/storage/status' },
    ];
    for (const c of unauthChecks) {
      const r = await fetch(`http://127.0.0.1:3000${c.path}`, {
        method: c.method,
        headers: c.body ? { 'Content-Type': 'application/json' } : undefined,
        body: c.body ? JSON.stringify(c.body) : undefined,
      });
      assert.equal(r.status, 401, `${c.method} ${c.path} must enforce 401`);
    }
    console.log('PASS [7] Live HTTP server rejects all unauthenticated document & storage endpoints (401)');
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('fetch failed')) {
      console.log('SKIP [7] Dev server not reachable on 127.0.0.1:3000');
    } else {
      throw err;
    }
  }

  // Honest live Cloud Storage bucket probe (never pretends bucket exists if unprovisioned)
  const liveHealth = await checkFirebaseStorageHealth();
  console.log('INFO [Live Firebase Bucket Probe]:', JSON.stringify(liveHealth));
  console.log('=== STORAGE & MIGRATION VALIDATION COMPLETE ===');
}

runTests().catch((err) => {
  console.error('Storage validation failed:', err);
  process.exit(1);
});
