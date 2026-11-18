import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, getCachedDocumentStorageStatus } from './src/server/app.ts';
import { startNotificationScheduler } from './src/server/notificationService.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`GRANTLY AI server listening on http://0.0.0.0:${PORT}`);
    startNotificationScheduler();
    void getCachedDocumentStorageStatus();
  });
}

startServer().catch((err) => {
  console.error('Failed to start GRANTLY AI server:', err);
  process.exit(1);
});

export { app };
export default app;
