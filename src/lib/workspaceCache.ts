// Strictly UID-isolated client cache & request deduplication layer.
// Zero user-specific data may ever leak across logout or account switching.

export const DEFAULT_USER_CACHE_TTL_MS = 60_000;
export const DEFAULT_PUBLIC_CACHE_TTL_MS = 180_000;
export const DEFAULT_API_CACHE_TTL_MS = 90_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  updatedAt: number;
}

let activeUid: string | null = null;
let cacheEpoch = 1;

const publicDataCache = new Map<string, CacheEntry<unknown>>();
const publicInFlight = new Map<string, Promise<unknown>>();

const userDataCache = new Map<string, CacheEntry<unknown>>();
const userInFlight = new Map<string, Promise<unknown>>();

type CacheListener = (scope: 'user' | 'public', keyPrefix?: string) => void;
const listeners = new Set<CacheListener>();

function notifyListeners(scope: 'user' | 'public', keyPrefix?: string): void {
  listeners.forEach((listener) => {
    try {
      listener(scope, keyPrefix);
    } catch {
      // Listener errors must never disrupt cache operations
    }
  });
}

export function subscribeWorkspaceCache(listener: CacheListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Synchronously aligns the user cache with the active Firebase UID.
 * Whenever UID changes or becomes null, all cached user records and
 * in-flight user requests are discarded immediately.
 */
export function ensureCacheOwner(uid: string | null): void {
  const normalized = uid ? String(uid) : null;
  if (normalized === activeUid) return;
  invalidateAllUserCaches(normalized);
}

/**
 * Hard purge of every user-scoped cache entry and in-flight request.
 * Called synchronously on logout, UID switch, and auth state reset.
 */
export function invalidateAllUserCaches(nextUid: string | null = null): void {
  userDataCache.clear();
  userInFlight.clear();
  cacheEpoch += 1;
  activeUid = nextUid;
  notifyListeners('user');
}

export function getActiveCacheUid(): string | null {
  return activeUid;
}

function buildUserKey(uid: string, resourceKey: string): string {
  return `${uid}::${resourceKey}`;
}

export function peekPublicCache<T>(resourceKey: string): T | undefined {
  const entry = publicDataCache.get(resourceKey);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    return undefined;
  }
  return entry.value as T;
}

export function setPublicCache<T>(
  resourceKey: string,
  value: T,
  ttlMs: number = DEFAULT_PUBLIC_CACHE_TTL_MS
): void {
  const now = Date.now();
  publicDataCache.set(resourceKey, {
    value,
    updatedAt: now,
    expiresAt: now + ttlMs,
  });
}

export function invalidatePublicCache(keyPrefix?: string): void {
  if (!keyPrefix) {
    publicDataCache.clear();
    publicInFlight.clear();
  } else {
    for (const k of Array.from(publicDataCache.keys())) {
      if (k === keyPrefix || k.startsWith(keyPrefix)) {
        publicDataCache.delete(k);
      }
    }
    for (const k of Array.from(publicInFlight.keys())) {
      if (k === keyPrefix || k.startsWith(keyPrefix)) {
        publicInFlight.delete(k);
      }
    }
  }
  notifyListeners('public', keyPrefix);
}

export async function getOrFetchPublic<T>(
  resourceKey: string,
  fetcher: () => Promise<T>,
  ttlMs: number = DEFAULT_PUBLIC_CACHE_TTL_MS
): Promise<T> {
  const cached = peekPublicCache<T>(resourceKey);
  if (cached !== undefined) {
    return cached;
  }

  const existingPromise = publicInFlight.get(resourceKey) as Promise<T> | undefined;
  if (existingPromise) {
    return existingPromise;
  }

  const promise = fetcher()
    .then((result) => {
      setPublicCache(resourceKey, result, ttlMs);
      return result;
    })
    .finally(() => {
      if (publicInFlight.get(resourceKey) === promise) {
        publicInFlight.delete(resourceKey);
      }
    });

  publicInFlight.set(resourceKey, promise);
  return promise;
}

export function peekUserCache<T>(uid: string | null | undefined, resourceKey: string): T | undefined {
  if (!uid || !activeUid || uid !== activeUid) {
    return undefined;
  }
  const fullKey = buildUserKey(uid, resourceKey);
  const entry = userDataCache.get(fullKey);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    return undefined;
  }
  return entry.value as T;
}

export function setUserCache<T>(
  uid: string,
  resourceKey: string,
  value: T,
  ttlMs: number = DEFAULT_USER_CACHE_TTL_MS
): void {
  if (!uid) return;
  if (activeUid !== uid) {
    ensureCacheOwner(uid);
  }
  const now = Date.now();
  userDataCache.set(buildUserKey(uid, resourceKey), {
    value,
    updatedAt: now,
    expiresAt: now + ttlMs,
  });
}

export function invalidateUserCache(uid: string | null | undefined, keyPrefix?: string): void {
  if (!uid) return;
  if (activeUid !== uid) return;
  const uidPrefix = `${uid}::`;
  const targetPrefix = keyPrefix ? `${uidPrefix}${keyPrefix}` : uidPrefix;

  for (const k of Array.from(userDataCache.keys())) {
    if (k === targetPrefix || k.startsWith(targetPrefix)) {
      userDataCache.delete(k);
    }
  }
  for (const k of Array.from(userInFlight.keys())) {
    if (k === targetPrefix || k.startsWith(targetPrefix)) {
      userInFlight.delete(k);
    }
  }
  notifyListeners('user', keyPrefix);
}

/**
 * Deduplicated, UID-isolated async fetcher.
 * If account changes or logs out while the request is in-flight, the late response
 * is NOT stored into the cache under the new account or logged-out state.
 */
export async function getOrFetchUser<T>(
  uid: string,
  resourceKey: string,
  fetcher: () => Promise<T>,
  ttlMs: number = DEFAULT_USER_CACHE_TTL_MS
): Promise<T> {
  if (!uid) {
    return fetcher();
  }

  ensureCacheOwner(uid);

  const cached = peekUserCache<T>(uid, resourceKey);
  if (cached !== undefined) {
    return cached;
  }

  const fullKey = buildUserKey(uid, resourceKey);
  const existing = userInFlight.get(fullKey) as Promise<T> | undefined;
  if (existing) {
    return existing;
  }

  const epochAtStart = cacheEpoch;
  const promise = fetcher()
    .then((result) => {
      if (cacheEpoch === epochAtStart && activeUid === uid) {
        setUserCache(uid, resourceKey, result, ttlMs);
      }
      return result;
    })
    .finally(() => {
      if (userInFlight.get(fullKey) === promise) {
        userInFlight.delete(fullKey);
      }
    });

  userInFlight.set(fullKey, promise);
  return promise;
}

export function getWorkspaceCacheDiagnostics(): {
  activeUid: string | null;
  cacheEpoch: number;
  userEntries: number;
  publicEntries: number;
} {
  return {
    activeUid,
    cacheEpoch,
    userEntries: userDataCache.size,
    publicEntries: publicDataCache.size,
  };
}
