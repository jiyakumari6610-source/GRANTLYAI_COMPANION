import fs from 'node:fs/promises';
import path from 'node:path';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };
import { validateDocumentBinary } from './documentProcessor.ts';
import {
  buildPrivateDocumentStoragePath,
  computeSha256Hex,
  CONFIGURED_STORAGE_BUCKET,
  firebaseCloudStorageTransport,
  readDocumentFromCloudStorage,
  saveDocumentToCloudStorage,
  type StorageTransport,
} from './documentStorage.ts';
import { deletePrivateDocument, readPrivateDocument } from './privateVault.ts';

const DEFAULT_VAULT_ROOT = path.resolve(process.cwd(), '.private_vault', 'users');
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{3,128}$/;

export interface VaultScanEntry {
  userId: string;
  docId: string;
  binPath: string;
  metaPath: string;
}

export interface MigrationItemResult {
  userId: string;
  docId: string;
  storagePath: string;
  status: 'migrated' | 'skipped-already-exists' | 'dry-run-ready' | 'failed';
  fileSizeBytes?: number;
  sha256?: string;
  firestoreUpdated: boolean;
  sourcePreserved: boolean;
  error?: string;
}

export interface StorageMigrationSummary {
  status: 'no-files-to-migrate' | 'completed' | 'completed-with-errors' | 'dry-run';
  bucket: string;
  vaultRoot: string;
  scanned: number;
  migrated: number;
  skippedAlreadyMigrated: number;
  failed: number;
  items: MigrationItemResult[];
  startedAt: string;
  completedAt: string;
}

export type FirestoreDocumentMetadataUpdater = (params: {
  docId: string;
  userId: string;
  storagePath: string;
  storageProvider: 'firebase-storage';
  mimeType: string;
  fileSizeBytes: number;
  updatedAt: string;
}) => Promise<boolean>;

async function defaultFirestoreMetadataUpdater(params: {
  docId: string;
  userId: string;
  storagePath: string;
  storageProvider: 'firebase-storage';
  mimeType: string;
  fileSizeBytes: number;
  updatedAt: string;
  idToken?: string;
}): Promise<boolean> {
  const { docId, userId, storagePath, storageProvider, mimeType, fileSizeBytes, updatedAt, idToken } = params;

  if (idToken) {
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/documents/${encodeURIComponent(docId)}?updateMask.fieldPaths=storagePath&updateMask.fieldPaths=storageProvider&updateMask.fieldPaths=mimeType&updateMask.fieldPaths=fileSizeBytes&updateMask.fieldPaths=updatedAt`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        fields: {
          storagePath: { stringValue: storagePath },
          storageProvider: { stringValue: storageProvider },
          mimeType: { stringValue: mimeType },
          fileSizeBytes: { integerValue: String(fileSizeBytes) },
          updatedAt: { stringValue: updatedAt },
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(`Firestore REST metadata update failed (${res.status}): ${msg.slice(0, 180)}`);
    }
    return true;
  }

  const app = getApps().length
    ? getApps()[0]
    : initializeApp({
        projectId: firebaseConfig.projectId,
        storageBucket: CONFIGURED_STORAGE_BUCKET,
      });
  const adminDb = getAdminFirestore(app, firebaseConfig.firestoreDatabaseId);
  const docRef = adminDb.collection('documents').doc(docId);
  const snap = await docRef.get();
  if (!snap.exists) return false;
  const data = snap.data() as { userId?: string } | undefined;
  if (data?.userId && data.userId !== userId) {
    throw new Error(`Firestore ownership mismatch on documents/${docId}.`);
  }
  await docRef.update({
    storagePath,
    storageProvider,
    mimeType,
    fileSizeBytes,
    updatedAt,
  });
  return true;
}

export async function scanPrivateVaultFiles(
  vaultRoot: string = DEFAULT_VAULT_ROOT
): Promise<VaultScanEntry[]> {
  let userEntries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    userEntries = await fs.readdir(vaultRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const found: VaultScanEntry[] = [];
  for (const userDir of userEntries) {
    if (!userDir.isDirectory() || !SAFE_ID_REGEX.test(userDir.name)) continue;
    const userPath = path.join(vaultRoot, userDir.name);
    const files = await fs.readdir(userPath, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.bin')) continue;
      const docId = file.name.slice(0, -'.bin'.length);
      if (!SAFE_ID_REGEX.test(docId)) continue;
      found.push({
        userId: userDir.name,
        docId,
        binPath: path.join(userPath, `${docId}.bin`),
        metaPath: path.join(userPath, `${docId}.meta.json`),
      });
    }
  }

  return found;
}

export async function migratePrivateVaultToCloudStorage(options?: {
  vaultRoot?: string;
  bucketName?: string;
  idToken?: string;
  dryRun?: boolean;
  pruneVerifiedSource?: boolean;
  transport?: StorageTransport;
  firestoreUpdater?: FirestoreDocumentMetadataUpdater;
}): Promise<StorageMigrationSummary> {
  const startedAt = new Date().toISOString();
  const vaultRoot = options?.vaultRoot ?? DEFAULT_VAULT_ROOT;
  const bucketName = options?.bucketName ?? CONFIGURED_STORAGE_BUCKET;
  const dryRun = Boolean(options?.dryRun);
  const pruneVerifiedSource = Boolean(options?.pruneVerifiedSource);
  const transport = options?.transport ?? firebaseCloudStorageTransport;
  const updateFirestore =
    options?.firestoreUpdater ??
    ((params) => defaultFirestoreMetadataUpdater({ ...params, idToken: options?.idToken }));

  const entries = await scanPrivateVaultFiles(vaultRoot);
  if (entries.length === 0) {
    return {
      status: 'no-files-to-migrate',
      bucket: bucketName,
      vaultRoot,
      scanned: 0,
      migrated: 0,
      skippedAlreadyMigrated: 0,
      failed: 0,
      items: [],
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  const items: MigrationItemResult[] = [];
  let migrated = 0;
  let skippedAlreadyMigrated = 0;
  let failed = 0;

  for (const entry of entries) {
    const storagePath = buildPrivateDocumentStoragePath(entry.userId, entry.docId);
    try {
      const legacy =
        options?.vaultRoot && options.vaultRoot !== DEFAULT_VAULT_ROOT
          ? await (async () => {
              const [buffer, metaRaw] = await Promise.all([
                fs.readFile(entry.binPath),
                fs.readFile(entry.metaPath, 'utf8'),
              ]);
              const meta = JSON.parse(metaRaw) as {
                docId: string;
                userId: string;
                fileName: string;
                mimeType: string;
              };
              if (meta.userId !== entry.userId || meta.docId !== entry.docId) return null;
              return { buffer, meta };
            })()
          : await readPrivateDocument(entry.userId, entry.docId);

      if (!legacy) {
        throw new Error('Missing or ownership-mismatched .meta.json/.bin pair in local vault.');
      }

      const normalizedMime = validateDocumentBinary(
        legacy.buffer,
        legacy.meta.mimeType,
        legacy.meta.fileName
      );
      const sourceSha256 = computeSha256Hex(legacy.buffer);

      // Duplicate migration guard: verify if already uploaded & matching size/owner/checksum
      const existingCloudMeta = await transport.getObjectMetadata({
        bucket: bucketName,
        storagePath,
        idToken: options?.idToken,
      });

      if (
        existingCloudMeta &&
        existingCloudMeta.size === legacy.buffer.byteLength &&
        existingCloudMeta.customMetadata.userId === entry.userId &&
        (!existingCloudMeta.customMetadata.sha256 ||
          existingCloudMeta.customMetadata.sha256 === sourceSha256)
      ) {
        let firestoreUpdated = false;
        if (!dryRun) {
          firestoreUpdated = await updateFirestore({
            docId: entry.docId,
            userId: entry.userId,
            storagePath,
            storageProvider: 'firebase-storage',
            mimeType: existingCloudMeta.contentType || normalizedMime,
            fileSizeBytes: existingCloudMeta.size,
            updatedAt: new Date().toISOString(),
          });
        }
        skippedAlreadyMigrated += 1;
        items.push({
          userId: entry.userId,
          docId: entry.docId,
          storagePath,
          status: 'skipped-already-exists',
          fileSizeBytes: existingCloudMeta.size,
          sha256: sourceSha256,
          firestoreUpdated,
          sourcePreserved: true,
        });
        continue;
      }

      if (dryRun) {
        items.push({
          userId: entry.userId,
          docId: entry.docId,
          storagePath,
          status: 'dry-run-ready',
          fileSizeBytes: legacy.buffer.byteLength,
          sha256: sourceSha256,
          firestoreUpdated: false,
          sourcePreserved: true,
        });
        continue;
      }

      // 1. Upload to Firebase Cloud Storage (includes post-upload metadata verification)
      const saved = await saveDocumentToCloudStorage({
        userId: entry.userId,
        docId: entry.docId,
        buffer: legacy.buffer,
        fileName: legacy.meta.fileName,
        mimeType: normalizedMime,
        idToken: options?.idToken,
        bucketName,
        transport,
      });

      // 2. Download-back verification to prove Cloud Storage object readability & exact SHA-256 integrity
      const readBack = await readDocumentFromCloudStorage({
        userId: entry.userId,
        docId: entry.docId,
        idToken: options?.idToken,
        bucketName,
        transport,
        allowLegacyVaultFallback: false,
      });

      if (
        !readBack ||
        readBack.buffer.byteLength !== legacy.buffer.byteLength ||
        readBack.meta.sha256 !== sourceSha256
      ) {
        throw new Error('Post-upload download integrity verification failed (SHA-256 or byte size mismatch).');
      }

      // 3. Update Firestore documents/{docId} metadata strictly after verified upload
      const firestoreUpdated = await updateFirestore({
        docId: entry.docId,
        userId: entry.userId,
        storagePath: saved.storagePath,
        storageProvider: 'firebase-storage',
        mimeType: saved.mimeType,
        fileSizeBytes: saved.fileSizeBytes,
        updatedAt: new Date().toISOString(),
      });

      // 4. Preserve original local files unless operator explicitly opted into pruning AFTER verified upload + DB update
      let sourcePreserved = true;
      if (pruneVerifiedSource && firestoreUpdated) {
        if (options?.vaultRoot && options.vaultRoot !== DEFAULT_VAULT_ROOT) {
          await fs.unlink(entry.binPath);
          await fs.unlink(entry.metaPath);
        } else {
          await deletePrivateDocument(entry.userId, entry.docId);
        }
        sourcePreserved = false;
      }

      migrated += 1;
      items.push({
        userId: entry.userId,
        docId: entry.docId,
        storagePath: saved.storagePath,
        status: 'migrated',
        fileSizeBytes: saved.fileSizeBytes,
        sha256: sourceSha256,
        firestoreUpdated,
        sourcePreserved,
      });
    } catch (err) {
      failed += 1;
      items.push({
        userId: entry.userId,
        docId: entry.docId,
        storagePath,
        status: 'failed',
        firestoreUpdated: false,
        sourcePreserved: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    status: dryRun
      ? 'dry-run'
      : failed > 0
        ? 'completed-with-errors'
        : 'completed',
    bucket: bucketName,
    vaultRoot,
    scanned: entries.length,
    migrated,
    skippedAlreadyMigrated,
    failed,
    items,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
