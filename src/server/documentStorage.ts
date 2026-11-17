import crypto from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };
import { validateDocumentBinary } from './documentProcessor.ts';
import { deletePrivateDocument, readPrivateDocument } from './privateVault.ts';

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{3,128}$/;

export const CONFIGURED_STORAGE_BUCKET = firebaseConfig.storageBucket;

export type DocumentStorageErrorCode =
  | 'INVALID_STORAGE_ID'
  | 'STORAGE_BUCKET_NOT_PROVISIONED'
  | 'STORAGE_BILLING_REQUIRED'
  | 'STORAGE_PERMISSION_DENIED'
  | 'STORAGE_INTEGRITY_MISMATCH'
  | 'STORAGE_UNAVAILABLE';

export class DocumentStorageError extends Error {
  public readonly code: DocumentStorageErrorCode;
  public readonly httpStatus: number;

  constructor(code: DocumentStorageErrorCode, message: string, httpStatus = 503) {
    super(message);
    this.name = 'DocumentStorageError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface StoredDocumentObjectMeta {
  docId: string;
  userId: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  sha256: string;
  storagePath: string;
  storageProvider: 'firebase-storage' | 'private-vault';
  bucket: string;
  uploadedAt: string;
}

export interface StorageObjectRecord {
  storagePath: string;
  contentType: string;
  size: number;
  customMetadata: Record<string, string>;
}

export interface StorageTransport {
  uploadObject(params: {
    bucket: string;
    storagePath: string;
    buffer: Buffer;
    contentType: string;
    customMetadata: Record<string, string>;
    idToken?: string;
  }): Promise<StorageObjectRecord>;
  getObjectMetadata(params: {
    bucket: string;
    storagePath: string;
    idToken?: string;
  }): Promise<StorageObjectRecord | null>;
  downloadObject(params: {
    bucket: string;
    storagePath: string;
    idToken?: string;
  }): Promise<{ buffer: Buffer; meta: StorageObjectRecord } | null>;
  deleteObject(params: {
    bucket: string;
    storagePath: string;
    idToken?: string;
  }): Promise<boolean>;
  probeBucket(params: { bucket: string }): Promise<{
    reachable: boolean;
    provisioned: boolean;
    errorCode?: DocumentStorageErrorCode;
    detail: string;
  }>;
}

export function assertSafeStorageIdentifier(value: string, label: string): string {
  if (!SAFE_ID_REGEX.test(value)) {
    throw new DocumentStorageError(
      'INVALID_STORAGE_ID',
      `Invalid ${label} format for Cloud Storage path.`,
      400
    );
  }
  return value;
}

export function buildPrivateDocumentStoragePath(userId: string, docId: string): string {
  const safeUserId = assertSafeStorageIdentifier(userId, 'userId');
  const safeDocId = assertSafeStorageIdentifier(docId, 'docId');
  return `private-documents/${safeUserId}/${safeDocId}`;
}

export function computeSha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function getAdminStorageBucket(bucketName: string) {
  const app = getApps().length
    ? getApps()[0]
    : initializeApp({
        projectId: firebaseConfig.projectId,
        storageBucket: bucketName,
      });
  return getStorage(app).bucket(bucketName);
}

function classifyCloudStorageFailure(err: unknown, bucketName: string): DocumentStorageError {
  if (err instanceof DocumentStorageError) return err;

  const statusCode =
    typeof (err as { code?: unknown })?.code === 'number'
      ? Number((err as { code?: unknown }).code)
      : typeof (err as { status?: unknown })?.status === 'number'
        ? Number((err as { status?: unknown }).status)
        : 0;
  const rawMessage = err instanceof Error ? err.message : String(err);
  const lower = rawMessage.toLowerCase();

  if (
    statusCode === 404 ||
    lower.includes('specified bucket does not exist') ||
    lower.includes('bucket does not exist')
  ) {
    return new DocumentStorageError(
      'STORAGE_BUCKET_NOT_PROVISIONED',
      `Document binary storage is temporarily unavailable because the storage bucket is not provisioned in this deployment.`,
      503
    );
  }

  if (
    lower.includes('billing') ||
    lower.includes('account is disabled') ||
    lower.includes('delinquent')
  ) {
    return new DocumentStorageError(
      'STORAGE_BILLING_REQUIRED',
      `Document binary storage is temporarily unavailable in the current deployment plan.`,
      503
    );
  }

  if (statusCode === 401 || statusCode === 403 || lower.includes('permission') || lower.includes('forbidden')) {
    return new DocumentStorageError(
      'STORAGE_PERMISSION_DENIED',
      `Access denied for private document storage.`,
      403
    );
  }

  return new DocumentStorageError(
    'STORAGE_UNAVAILABLE',
    `Document storage is temporarily unavailable. Please try again later.`,
    503
  );
}

function isObjectNotFoundError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  if (code === 404 && !msg.includes('bucket does not exist')) return true;
  return msg.includes('no such object');
}

function isPermissionOrCredentialFallbackError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  return (
    code === 401 ||
    code === 403 ||
    msg.includes('could not load the default credentials') ||
    msg.includes('does not have storage.') ||
    msg.includes('caller does not have permission')
  );
}

function normalizeCustomMetadata(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v !== undefined && v !== null) {
      out[k] = String(v);
    }
  }
  return out;
}

async function firebaseStorageRestUpload(params: {
  bucket: string;
  storagePath: string;
  buffer: Buffer;
  contentType: string;
  customMetadata: Record<string, string>;
  idToken: string;
}): Promise<StorageObjectRecord> {
  const { bucket, storagePath, buffer, contentType, customMetadata, idToken } = params;
  const boundary = `grantly_boundary_${crypto.randomBytes(12).toString('hex')}`;
  const metadataJson = JSON.stringify({
    name: storagePath,
    contentType,
    cacheControl: 'private, no-store',
    metadata: customMetadata,
  });

  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataJson}\r\n` +
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, buffer, tail]);

  const url = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o?uploadType=multipart&name=${encodeURIComponent(storagePath)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Firebase ${idToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw classifyCloudStorageFailure(
      { code: res.status, message: errBody || `HTTP ${res.status}` },
      bucket
    );
  }

  const json = (await res.json()) as {
    name?: string;
    contentType?: string;
    size?: string | number;
    metadata?: Record<string, unknown>;
  };

  return {
    storagePath: json.name || storagePath,
    contentType: json.contentType || contentType,
    size: Number(json.size ?? buffer.byteLength),
    customMetadata: normalizeCustomMetadata(json.metadata),
  };
}

async function firebaseStorageRestGetMetadata(params: {
  bucket: string;
  storagePath: string;
  idToken: string;
}): Promise<StorageObjectRecord | null> {
  const { bucket, storagePath, idToken } = params;
  const url = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(storagePath)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Firebase ${idToken}`,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw classifyCloudStorageFailure(
      { code: res.status, message: errBody || `HTTP ${res.status}` },
      bucket
    );
  }

  const json = (await res.json()) as {
    name?: string;
    contentType?: string;
    size?: string | number;
    metadata?: Record<string, unknown>;
  };

  return {
    storagePath: json.name || storagePath,
    contentType: json.contentType || 'application/octet-stream',
    size: Number(json.size ?? 0),
    customMetadata: normalizeCustomMetadata(json.metadata),
  };
}

async function firebaseStorageRestDownload(params: {
  bucket: string;
  storagePath: string;
  idToken: string;
}): Promise<{ buffer: Buffer; meta: StorageObjectRecord } | null> {
  const meta = await firebaseStorageRestGetMetadata(params);
  if (!meta) return null;

  const url = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(params.bucket)}/o/${encodeURIComponent(params.storagePath)}?alt=media`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Firebase ${params.idToken}`,
    },
    signal: AbortSignal.timeout(20000),
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw classifyCloudStorageFailure(
      { code: res.status, message: errBody || `HTTP ${res.status}` },
      params.bucket
    );
  }

  const arrayBuf = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuf), meta };
}

async function firebaseStorageRestDelete(params: {
  bucket: string;
  storagePath: string;
  idToken: string;
}): Promise<boolean> {
  const url = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(params.bucket)}/o/${encodeURIComponent(params.storagePath)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Firebase ${params.idToken}`,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 404) return false;
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw classifyCloudStorageFailure(
      { code: res.status, message: errBody || `HTTP ${res.status}` },
      params.bucket
    );
  }
  return true;
}

export const firebaseCloudStorageTransport: StorageTransport = {
  async uploadObject({ bucket, storagePath, buffer, contentType, customMetadata, idToken }) {
    try {
      const gcsBucket = getAdminStorageBucket(bucket);
      const file = gcsBucket.file(storagePath);
      await file.save(buffer, {
        resumable: false,
        validation: 'crc32c',
        metadata: {
          contentType,
          cacheControl: 'private, no-store',
          metadata: customMetadata,
        },
      });
      const [meta] = await file.getMetadata();
      return {
        storagePath,
        contentType: meta.contentType || contentType,
        size: Number(meta.size ?? buffer.byteLength),
        customMetadata: normalizeCustomMetadata(meta.metadata),
      };
    } catch (err) {
      if (idToken && isPermissionOrCredentialFallbackError(err)) {
        return firebaseStorageRestUpload({
          bucket,
          storagePath,
          buffer,
          contentType,
          customMetadata,
          idToken,
        });
      }
      throw classifyCloudStorageFailure(err, bucket);
    }
  },

  async getObjectMetadata({ bucket, storagePath, idToken }) {
    try {
      const gcsBucket = getAdminStorageBucket(bucket);
      const [meta] = await gcsBucket.file(storagePath).getMetadata();
      return {
        storagePath,
        contentType: meta.contentType || 'application/octet-stream',
        size: Number(meta.size ?? 0),
        customMetadata: normalizeCustomMetadata(meta.metadata),
      };
    } catch (err) {
      if (isObjectNotFoundError(err)) return null;
      if (idToken && isPermissionOrCredentialFallbackError(err)) {
        return firebaseStorageRestGetMetadata({ bucket, storagePath, idToken });
      }
      throw classifyCloudStorageFailure(err, bucket);
    }
  },

  async downloadObject({ bucket, storagePath, idToken }) {
    try {
      const gcsBucket = getAdminStorageBucket(bucket);
      const file = gcsBucket.file(storagePath);
      const [meta] = await file.getMetadata();
      const [buffer] = await file.download();
      return {
        buffer,
        meta: {
          storagePath,
          contentType: meta.contentType || 'application/octet-stream',
          size: Number(meta.size ?? buffer.byteLength),
          customMetadata: normalizeCustomMetadata(meta.metadata),
        },
      };
    } catch (err) {
      if (isObjectNotFoundError(err)) return null;
      if (idToken && isPermissionOrCredentialFallbackError(err)) {
        return firebaseStorageRestDownload({ bucket, storagePath, idToken });
      }
      throw classifyCloudStorageFailure(err, bucket);
    }
  },

  async deleteObject({ bucket, storagePath, idToken }) {
    try {
      const gcsBucket = getAdminStorageBucket(bucket);
      await gcsBucket.file(storagePath).delete({ ignoreNotFound: false });
      return true;
    } catch (err) {
      if (isObjectNotFoundError(err)) return false;
      if (idToken && isPermissionOrCredentialFallbackError(err)) {
        return firebaseStorageRestDelete({ bucket, storagePath, idToken });
      }
      throw classifyCloudStorageFailure(err, bucket);
    }
  },

  async probeBucket({ bucket }) {
    try {
      const gcsBucket = getAdminStorageBucket(bucket);
      const [meta] = await gcsBucket.getMetadata();
      return {
        reachable: true,
        provisioned: true,
        detail: `Cloud Storage bucket "${meta.name}" is provisioned and reachable.`,
      };
    } catch (err) {
      const classified = classifyCloudStorageFailure(err, bucket);
      return {
        reachable: classified.code === 'STORAGE_PERMISSION_DENIED',
        provisioned: classified.code !== 'STORAGE_BUCKET_NOT_PROVISIONED',
        errorCode: classified.code,
        detail: classified.message,
      };
    }
  },
};

export async function saveDocumentToCloudStorage(params: {
  userId: string;
  docId: string;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  idToken?: string;
  bucketName?: string;
  transport?: StorageTransport;
}): Promise<StoredDocumentObjectMeta> {
  const {
    userId,
    docId,
    buffer,
    fileName,
    mimeType,
    idToken,
    bucketName = CONFIGURED_STORAGE_BUCKET,
    transport = firebaseCloudStorageTransport,
  } = params;

  const storagePath = buildPrivateDocumentStoragePath(userId, docId);
  const normalizedMime = validateDocumentBinary(buffer, mimeType, fileName);
  const sha256 = computeSha256Hex(buffer);
  const uploadedAt = new Date().toISOString();

  await transport.uploadObject({
    bucket: bucketName,
    storagePath,
    buffer,
    contentType: normalizedMime,
    customMetadata: {
      userId,
      docId,
      originalFileName: fileName.slice(0, 240),
      sha256,
      uploadedAt,
    },
    idToken,
  });

  // Verify post-upload object state & ownership metadata before confirming upload success
  const verifiedMeta = await transport.getObjectMetadata({
    bucket: bucketName,
    storagePath,
    idToken,
  });

  if (
    !verifiedMeta ||
    verifiedMeta.size !== buffer.byteLength ||
    verifiedMeta.customMetadata.userId !== userId ||
    verifiedMeta.customMetadata.docId !== docId
  ) {
    throw new DocumentStorageError(
      'STORAGE_INTEGRITY_MISMATCH',
      'Uploaded object verification failed: stored byte size or owner metadata mismatch.',
      500
    );
  }

  return {
    docId,
    userId,
    fileName,
    mimeType: verifiedMeta.contentType || normalizedMime,
    fileSizeBytes: verifiedMeta.size,
    sha256: verifiedMeta.customMetadata.sha256 || sha256,
    storagePath,
    storageProvider: 'firebase-storage',
    bucket: bucketName,
    uploadedAt: verifiedMeta.customMetadata.uploadedAt || uploadedAt,
  };
}

export async function readDocumentFromCloudStorage(params: {
  userId: string;
  docId: string;
  idToken?: string;
  bucketName?: string;
  transport?: StorageTransport;
  allowLegacyVaultFallback?: boolean;
}): Promise<{ buffer: Buffer; meta: StoredDocumentObjectMeta } | null> {
  const {
    userId,
    docId,
    idToken,
    bucketName = CONFIGURED_STORAGE_BUCKET,
    transport = firebaseCloudStorageTransport,
    allowLegacyVaultFallback = true,
  } = params;

  const storagePath = buildPrivateDocumentStoragePath(userId, docId);

  try {
    const cloudObj = await transport.downloadObject({
      bucket: bucketName,
      storagePath,
      idToken,
    });

    if (cloudObj) {
      const ownerInMeta = cloudObj.meta.customMetadata.userId;
      if (ownerInMeta && ownerInMeta !== userId) {
        return null;
      }
      const expectedSha = cloudObj.meta.customMetadata.sha256;
      const actualSha = computeSha256Hex(cloudObj.buffer);
      if (expectedSha && expectedSha !== actualSha) {
        throw new DocumentStorageError(
          'STORAGE_INTEGRITY_MISMATCH',
          'Stored document checksum mismatch detected during retrieval.',
          500
        );
      }

      return {
        buffer: cloudObj.buffer,
        meta: {
          docId,
          userId,
          fileName: cloudObj.meta.customMetadata.originalFileName || docId,
          mimeType: cloudObj.meta.contentType,
          fileSizeBytes: cloudObj.buffer.byteLength,
          sha256: actualSha,
          storagePath,
          storageProvider: 'firebase-storage',
          bucket: bucketName,
          uploadedAt: cloudObj.meta.customMetadata.uploadedAt || '',
        },
      };
    }
  } catch (err) {
    // Allow pre-existing unmigrated legacy vault documents to be read if Cloud Storage isn't holding them yet
    if (!allowLegacyVaultFallback) {
      throw err;
    }
    const legacy = await readPrivateDocument(userId, docId);
    if (legacy) {
      return {
        buffer: legacy.buffer,
        meta: {
          docId: legacy.meta.docId,
          userId: legacy.meta.userId,
          fileName: legacy.meta.fileName,
          mimeType: legacy.meta.mimeType,
          fileSizeBytes: legacy.meta.fileSizeBytes,
          sha256: computeSha256Hex(legacy.buffer),
          storagePath: legacy.meta.storagePath,
          storageProvider: 'private-vault',
          bucket: 'local-private-vault',
          uploadedAt: legacy.meta.uploadedAt,
        },
      };
    }
    throw err;
  }

  if (allowLegacyVaultFallback) {
    const legacy = await readPrivateDocument(userId, docId);
    if (legacy) {
      return {
        buffer: legacy.buffer,
        meta: {
          docId: legacy.meta.docId,
          userId: legacy.meta.userId,
          fileName: legacy.meta.fileName,
          mimeType: legacy.meta.mimeType,
          fileSizeBytes: legacy.meta.fileSizeBytes,
          sha256: computeSha256Hex(legacy.buffer),
          storagePath: legacy.meta.storagePath,
          storageProvider: 'private-vault',
          bucket: 'local-private-vault',
          uploadedAt: legacy.meta.uploadedAt,
        },
      };
    }
  }

  return null;
}

export async function deleteDocumentFromCloudStorage(params: {
  userId: string;
  docId: string;
  idToken?: string;
  bucketName?: string;
  transport?: StorageTransport;
  alsoDeleteLegacyVault?: boolean;
}): Promise<{ deleted: boolean; deletedFromCloud: boolean; deletedFromLegacyVault: boolean }> {
  const {
    userId,
    docId,
    idToken,
    bucketName = CONFIGURED_STORAGE_BUCKET,
    transport = firebaseCloudStorageTransport,
    alsoDeleteLegacyVault = true,
  } = params;

  const storagePath = buildPrivateDocumentStoragePath(userId, docId);
  let deletedFromCloud = false;
  let cloudError: unknown = null;

  try {
    const meta = await transport.getObjectMetadata({
      bucket: bucketName,
      storagePath,
      idToken,
    });
    if (meta) {
      if (meta.customMetadata.userId && meta.customMetadata.userId !== userId) {
        throw new DocumentStorageError(
          'STORAGE_PERMISSION_DENIED',
          'Cannot delete document owned by another user.',
          403
        );
      }
      deletedFromCloud = await transport.deleteObject({
        bucket: bucketName,
        storagePath,
        idToken,
      });
    }
  } catch (err) {
    if (err instanceof DocumentStorageError && err.code === 'STORAGE_PERMISSION_DENIED') {
      throw err;
    }
    cloudError = err;
  }

  const deletedFromLegacyVault = alsoDeleteLegacyVault
    ? await deletePrivateDocument(userId, docId)
    : false;

  if (cloudError && !deletedFromLegacyVault) {
    throw cloudError;
  }

  return {
    deleted: deletedFromCloud || deletedFromLegacyVault,
    deletedFromCloud,
    deletedFromLegacyVault,
  };
}

export async function checkFirebaseStorageHealth(
  bucketName: string = CONFIGURED_STORAGE_BUCKET,
  transport: StorageTransport = firebaseCloudStorageTransport
) {
  const probe = await transport.probeBucket({ bucket: bucketName });
  return {
    bucket: bucketName,
    ...probe,
  };
}
