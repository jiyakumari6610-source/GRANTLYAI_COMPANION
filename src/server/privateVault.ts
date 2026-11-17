import fs from 'node:fs/promises';
import path from 'node:path';

const VAULT_ROOT = path.resolve(process.cwd(), '.private_vault', 'users');
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{3,128}$/;

export interface VaultFileMeta {
  docId: string;
  userId: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  storagePath: string;
  uploadedAt: string;
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID_REGEX.test(value)) {
    throw new Error(`Invalid ${label} format.`);
  }
}

function getUserDir(userId: string): string {
  assertSafeId(userId, 'userId');
  return path.join(VAULT_ROOT, userId);
}

function getBinaryPath(userId: string, docId: string): string {
  assertSafeId(docId, 'docId');
  return path.join(getUserDir(userId), `${docId}.bin`);
}

function getMetaPath(userId: string, docId: string): string {
  assertSafeId(docId, 'docId');
  return path.join(getUserDir(userId), `${docId}.meta.json`);
}

export async function savePrivateDocument(
  userId: string,
  docId: string,
  buffer: Buffer,
  meta: Omit<VaultFileMeta, 'docId' | 'userId' | 'storagePath' | 'uploadedAt'>
): Promise<VaultFileMeta> {
  const userDir = getUserDir(userId);
  await fs.mkdir(userDir, { recursive: true });

  const storagePath = `private-vault/users/${userId}/${docId}`;
  const fullMeta: VaultFileMeta = {
    docId,
    userId,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    fileSizeBytes: buffer.byteLength,
    storagePath,
    uploadedAt: new Date().toISOString(),
  };

  await fs.writeFile(getBinaryPath(userId, docId), buffer);
  await fs.writeFile(getMetaPath(userId, docId), JSON.stringify(fullMeta, null, 2), 'utf8');
  return fullMeta;
}

export async function readPrivateDocument(
  userId: string,
  docId: string
): Promise<{ buffer: Buffer; meta: VaultFileMeta } | null> {
  try {
    const [buffer, metaRaw] = await Promise.all([
      fs.readFile(getBinaryPath(userId, docId)),
      fs.readFile(getMetaPath(userId, docId), 'utf8'),
    ]);
    const meta = JSON.parse(metaRaw) as VaultFileMeta;
    if (meta.userId !== userId || meta.docId !== docId) {
      return null;
    }
    return { buffer, meta };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function deletePrivateDocument(userId: string, docId: string): Promise<boolean> {
  let deleted = false;
  for (const p of [getBinaryPath(userId, docId), getMetaPath(userId, docId)]) {
    try {
      await fs.unlink(p);
      deleted = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err;
      }
    }
  }
  return deleted;
}
