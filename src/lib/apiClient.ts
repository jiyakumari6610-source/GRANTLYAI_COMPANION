import {
  DEFAULT_API_CACHE_TTL_MS,
  getActiveCacheUid,
  getOrFetchUser,
  invalidatePublicCache,
  invalidateUserCache,
} from './workspaceCache.ts';

export async function parseJsonApiResponse<TResponse>(response: Response): Promise<TResponse> {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const rawText = await response.text().catch(() => '');

  let payload: Record<string, unknown> | null = null;
  if (rawText.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const serverError =
      payload && typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : null;
    if (response.status === 413 && !serverError) {
      throw new Error(
        'The uploaded file is too large for the server gateway limit. Please upload a PDF or image under 3 MB (or compress the scan) and retry.'
      );
    }
    throw new Error(serverError || `Request failed with status ${response.status}`);
  }

  if (!payload || (contentType && !contentType.includes('application/json') && !contentType.includes('+json'))) {
    throw new Error(
      'The server returned an unexpected non-JSON response (gateway timeout or temporary service overload). Please retry.'
    );
  }

  return payload as TResponse;
}

function invalidateCachesForMutatingEndpoint(endpoint: string): void {
  const uid = getActiveCacheUid();
  if (endpoint.startsWith('/api/applications')) {
    if (uid) {
      invalidateUserCache(uid, 'applications');
      invalidateUserCache(uid, 'application:');
      invalidateUserCache(uid, 'application_events');
      invalidateUserCache(uid, 'application_checklist_items');
      invalidateUserCache(uid, 'notifications');
    }
  } else if (endpoint.startsWith('/api/notifications')) {
    if (uid) {
      invalidateUserCache(uid, 'notifications');
      invalidateUserCache(uid, 'notification_preferences');
      invalidateUserCache(uid, 'notification_delivery_logs');
      invalidateUserCache(uid, 'api:/api/notifications');
    }
  } else if (endpoint.startsWith('/api/documents')) {
    if (uid) {
      invalidateUserCache(uid, 'documents');
      invalidateUserCache(uid, 'document_analysis');
    }
  } else if (endpoint.startsWith('/api/admin')) {
    invalidatePublicCache();
    if (uid) {
      invalidateUserCache(uid, 'api:/api/admin');
    }
  }
}

export async function getProtectedApi<TResponse>(
  endpoint: string,
  idToken: string
): Promise<TResponse> {
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  });

  return parseJsonApiResponse<TResponse>(response);
}

export async function getCachedProtectedApi<TResponse>(
  uid: string,
  endpoint: string,
  getIdTokenFn: () => Promise<string>,
  ttlMs: number = DEFAULT_API_CACHE_TTL_MS
): Promise<TResponse> {
  return getOrFetchUser(
    uid,
    `api:${endpoint}`,
    async () => {
      const token = await getIdTokenFn();
      return getProtectedApi<TResponse>(endpoint, token);
    },
    ttlMs
  );
}

export async function postProtectedAi<TResponse>(
  endpoint: string,
  idToken: string,
  body: unknown
): Promise<TResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  });

  const data = await parseJsonApiResponse<TResponse>(response);
  invalidateCachesForMutatingEndpoint(endpoint);
  return data;
}

export async function putProtectedApi<TResponse>(
  endpoint: string,
  idToken: string,
  body: unknown
): Promise<TResponse> {
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  });

  const data = await parseJsonApiResponse<TResponse>(response);
  invalidateCachesForMutatingEndpoint(endpoint);
  return data;
}

export async function patchProtectedApi<TResponse>(
  endpoint: string,
  idToken: string,
  body: unknown
): Promise<TResponse> {
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  });

  const data = await parseJsonApiResponse<TResponse>(response);
  invalidateCachesForMutatingEndpoint(endpoint);
  return data;
}

export async function fetchProtectedBlob(endpoint: string, idToken: string): Promise<Blob> {
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error || `Failed to load private file (${response.status})`);
  }
  return response.blob();
}

export async function deleteProtected(endpoint: string, idToken: string): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error || `Delete request failed (${response.status})`);
  }
  invalidateCachesForMutatingEndpoint(endpoint);
}
