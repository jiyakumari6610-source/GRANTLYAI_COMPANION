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

  return parseJsonApiResponse<TResponse>(response);
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

  return parseJsonApiResponse<TResponse>(response);
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

  return parseJsonApiResponse<TResponse>(response);
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
}
