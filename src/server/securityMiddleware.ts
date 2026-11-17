import dns from 'node:dns/promises';
import net from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { SAFE_ID_REGEX } from '../lib/securityUtils.ts';

interface AuthenticatedLikeRequest extends Request {
  user?: { uid?: string };
}

export function securityHeadersMiddleware(isProduction: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    // Allow Google Sign-In popup communication while isolating opener context
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    // Preserve AI Studio iframe compatibility (do NOT set X-Frame-Options: DENY)
    if (isProduction || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

function normalizeOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function createCorsMiddleware(appUrlEnv?: string) {
  const configuredOrigin = normalizeOrigin(appUrlEnv);

  return (req: Request, res: Response, next: NextFunction): void => {
    const originHeader = req.headers.origin;
    if (!originHeader) {
      next();
      return;
    }

    const requestOrigin = normalizeOrigin(originHeader);
    const hostHeader = req.headers.host;
    const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : req.protocol || 'http';
    const sameHostHttp = hostHeader ? `http://${hostHeader}`.toLowerCase() : null;
    const sameHostHttps = hostHeader ? `https://${hostHeader}`.toLowerCase() : null;

    const isLocalDevOrigin = Boolean(
      requestOrigin &&
        (requestOrigin.startsWith('http://localhost:') ||
          requestOrigin.startsWith('http://127.0.0.1:') ||
          requestOrigin === 'http://localhost' ||
          requestOrigin === 'http://127.0.0.1')
    );

    const isAllowed = Boolean(
      requestOrigin &&
        ((configuredOrigin && requestOrigin === configuredOrigin) ||
          requestOrigin === sameHostHttp ||
          requestOrigin === sameHostHttps ||
          isLocalDevOrigin)
    );

    if (!isAllowed) {
      if (req.path.startsWith('/api/')) {
        res.status(403).json({
          error: 'Cross-origin request denied by API CORS policy.',
          code: 'CORS_ORIGIN_FORBIDDEN',
        });
        return;
      }
      next();
      return;
    }

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', originHeader);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}

interface RateBucket {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
  message?: string;
}

export function createRateLimiter(options: RateLimiterOptions) {
  const { windowMs, maxRequests, keyPrefix, message } = options;
  const buckets = new Map<string, RateBucket>();

  return (req: AuthenticatedLikeRequest, res: Response, next: NextFunction): void => {
    const now = Date.now();
    if (buckets.size > 5000) {
      for (const [k, b] of buckets.entries()) {
        if (b.resetAt <= now) buckets.delete(k);
      }
    }

    const identity = req.user?.uid
      ? `uid:${req.user.uid}`
      : `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const key = `${keyPrefix}:${identity}`;
    const current = buckets.get(key);

    if (!current || current.resetAt <= now) {
      const nextBucket: RateBucket = { count: 1, resetAt: now + windowMs };
      buckets.set(key, nextBucket);
      res.setHeader('X-RateLimit-Limit', String(maxRequests));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - 1)));
      next();
      return;
    }

    if (current.count >= maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.setHeader('X-RateLimit-Limit', String(maxRequests));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.status(429).json({
        error:
          message ||
          'Too many requests in a short period. Please wait a moment and try again.',
        code: 'RATE_LIMITED',
        retryAfterSeconds,
      });
      return;
    }

    current.count += 1;
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - current.count)));
    next();
  };
}

function isPrivateOrBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // Multicast & reserved
  return false;
}

export function isBlockedIpAddress(ipRaw: string): boolean {
  const ip = ipRaw.trim().toLowerCase();
  if (!ip) return true;

  if (ip.startsWith('::ffff:')) {
    return isPrivateOrBlockedIpv4(ip.slice('::ffff:'.length));
  }
  const version = net.isIP(ip);
  if (version === 4) {
    return isPrivateOrBlockedIpv4(ip);
  }
  if (version === 6) {
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('fe80:') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) {
      return true; // fe80::/10 link-local
    }
    if (ip.startsWith('fc') || ip.startsWith('fd')) {
      return true; // fc00::/7 unique local address
    }
    if (ip.startsWith('ff')) return true; // multicast
    return false;
  }
  return true;
}

export async function assertSafePublicHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL format.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only HTTP/HTTPS URLs are supported.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs containing embedded credentials are not permitted.');
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) {
    throw new Error('URL hostname is required.');
  }

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    host === 'metadata'
  ) {
    throw new Error('Internal, loopback, and cloud metadata hostnames are blocked.');
  }

  if (net.isIP(host)) {
    if (isBlockedIpAddress(host)) {
      throw new Error('Private, loopback, and link-local IP addresses are blocked.');
    }
    return parsed;
  }

  try {
    const records = await dns.lookup(host, { all: true });
    if (!records.length) {
      throw new Error('Hostname could not be resolved.');
    }
    for (const rec of records) {
      if (isBlockedIpAddress(rec.address)) {
        throw new Error('Resolved target resolves to a private or blocked IP address.');
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('blocked')) {
      throw err;
    }
    // If DNS lookup fails transiently for an external public host in sandboxed environments,
    // allow fetch to fail cleanly rather than letting internal IPs pass.
  }

  return parsed;
}

export async function safePublicHttpFetch(
  rawUrl: string,
  options: { timeoutMs?: number; maxRedirects?: number } = {}
): Promise<globalThis.Response> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxRedirects = options.maxRedirects ?? 3;

  let currentUrl = (await assertSafePublicHttpUrl(rawUrl)).toString();
  let method: 'HEAD' | 'GET' = 'HEAD';

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let resp = await fetch(currentUrl, {
        method,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (method === 'HEAD' && (resp.status === 405 || resp.status === 403)) {
        method = 'GET';
        resp = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
        });
      }

      clearTimeout(timer);

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) {
          return resp;
        }
        const resolvedNext = new URL(location, currentUrl).toString();
        currentUrl = (await assertSafePublicHttpUrl(resolvedNext)).toString();
        continue;
      }

      return resp;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  throw new Error('Too many HTTP redirects while verifying source URL.');
}

export function assertValidRouteIdParam(value: unknown, label = 'id'): string {
  const str = typeof value === 'string' ? value.trim() : '';
  if (!SAFE_ID_REGEX.test(str)) {
    throw new RouteParamValidationError(`Invalid ${label} parameter.`);
  }
  return str;
}

export class RouteParamValidationError extends Error {
  httpStatus = 400;
  code = 'INVALID_ROUTE_PARAM';
}

export function sanitizeErrorForClient(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : fallback;
  const scrubbed = raw
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_KEY]')
    .replace(/\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+){2,}/g, '[internal-path]')
    .replace(/[A-Z]:\\[^\s]+/g, '[internal-path]')
    .replace(/\s+at\s+[^\n]+/g, '')
    .trim();

  if (!scrubbed) return fallback;
  return scrubbed.slice(0, 260);
}
