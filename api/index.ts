import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from '../src/server/app.ts';

export function normalizeVercelApiRequestUrl(req: IncomingMessage): void {
  const rawUrl = req.url || '/';
  const parsed = new URL(rawUrl, 'http://localhost');
  const rewrittenPath = parsed.searchParams.get('__vercel_path');

  if (rewrittenPath !== null) {
    parsed.searchParams.delete('__vercel_path');
    if (parsed.pathname === '/api/index' || parsed.pathname === '/api') {
      const cleaned = rewrittenPath.replace(/^\/+/, '');
      parsed.pathname = cleaned ? `/api/${cleaned}` : '/api';
    }
  } else if (parsed.pathname === '/api/index') {
    parsed.pathname = '/api';
  }

  const search = parsed.searchParams.toString();
  req.url = search ? `${parsed.pathname}?${search}` : parsed.pathname;
}

export default function handler(req: IncomingMessage, res: ServerResponse) {
  normalizeVercelApiRequestUrl(req);
  return app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
