import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  doc,
  enableNetwork,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
  type Firestore,
} from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

function createFirestoreClient(): Firestore {
  try {
    return initializeFirestore(
      app,
      typeof window !== 'undefined'
        ? { experimentalForceLongPolling: true, ignoreUndefinedProperties: true }
        : { ignoreUndefinedProperties: true },
      firebaseConfig.firestoreDatabaseId
    );
  } catch {
    return getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }
}

export const auth = getAuth(app);
export const googleAuthProvider = new GoogleAuthProvider();
export const db = createFirestoreClient();
export const storage = getStorage(app);

export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
} as const;

export type OperationTypeValue = (typeof OperationType)[keyof typeof OperationType];

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationTypeValue;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo: Array<{
      providerId?: string | null;
      email?: string | null;
    }>;
  };
}

export function isFirestoreOfflineError(error: unknown): boolean {
  if (!error) return false;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code).toLowerCase()
      : '';
  if (code === 'unavailable') return true;

  const rawMsg = error instanceof Error ? error.message : String(error);
  const lower = rawMsg.toLowerCase();
  return (
    lower.includes('client is offline') ||
    lower.includes('failed to get document because the client is offline') ||
    lower.includes('could not reach cloud firestore backend') ||
    lower.includes('unavailable')
  );
}

export async function recoverFirestoreNetwork(): Promise<void> {
  try {
    await enableNetwork(db);
  } catch {
    // Ignore if network toggle is unsupported in current runtime
  }
}

type FirestoreRestValue = {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  timestampValue?: string;
  stringValue?: string;
  arrayValue?: { values?: FirestoreRestValue[] };
  mapValue?: { fields?: Record<string, FirestoreRestValue> };
};

function decodeFirestoreRestValue(val: FirestoreRestValue | undefined): unknown {
  if (!val) return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) {
    const num = Number(val.integerValue);
    return Number.isFinite(num) ? num : val.integerValue;
  }
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('timestampValue' in val) return val.timestampValue;
  if ('stringValue' in val) return val.stringValue;
  if ('arrayValue' in val) {
    return (val.arrayValue?.values ?? []).map((item) => decodeFirestoreRestValue(item));
  }
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    const fields = val.mapValue?.fields ?? {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeFirestoreRestValue(v);
    }
    return out;
  }
  return null;
}

export async function fetchFirestoreDocumentViaRest<T>(
  collectionPath: string,
  docId: string,
  idToken: string
): Promise<{ exists: boolean; data: T | null }> {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/${collectionPath}/${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) {
    return { exists: false, data: null };
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Firestore REST GET ${collectionPath}/${docId} failed (${res.status}): ${errText.slice(0, 200)}`);
  }
  const json = (await res.json()) as { fields?: Record<string, FirestoreRestValue> };
  if (!json.fields) {
    return { exists: false, data: null };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json.fields)) {
    out[k] = decodeFirestoreRestValue(v);
  }
  return { exists: true, data: out as T };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationTypeValue,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId ?? null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) ?? [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', {
    operationType: errInfo.operationType,
    path: errInfo.path,
    error: errInfo.error,
  });
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<{ reachable: boolean; error?: string }> {
  const attempt = () => getDocFromServer(doc(db, 'test', 'connection'));
  try {
    await attempt();
    return { reachable: true };
  } catch (error) {
    if (isFirestoreOfflineError(error)) {
      await recoverFirestoreNetwork();
      try {
        await attempt();
        return { reachable: true };
      } catch (retryError) {
        if (isFirestoreOfflineError(retryError)) {
          return { reachable: false, error: 'Firestore client appears offline. Check configuration.' };
        }
        return { reachable: true };
      }
    }
    // Permission errors or missing doc still indicate server reachability
    return { reachable: true };
  }
}
