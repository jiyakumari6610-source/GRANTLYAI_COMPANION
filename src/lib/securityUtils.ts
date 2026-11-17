export const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{3,128}$/;

export function isValidEntityId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_REGEX.test(value);
}

/**
 * Validates that a redirect target or in-app actionRoute is strictly a relative internal route
 * (starts with a single `/`, never `//`, never contains `://`, schemes, backslashes, or control chars).
 */
export function isSafeInternalPath(rawPath: string | null | undefined): rawPath is string {
  if (typeof rawPath !== 'string') return false;
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('/')) return false;
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) return false;
  if (trimmed.includes('://') || trimmed.includes('\\')) return false;
  if (/[\r\n\t\0]/.test(trimmed)) return false;
  if (/^\/[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(trimmed)) return false;
  return true;
}

export function sanitizeInternalRoute(
  rawPath: string | null | undefined,
  fallback = '/dashboard'
): string {
  if (!isSafeInternalPath(rawPath)) return fallback;
  return rawPath.trim().slice(0, 200);
}
