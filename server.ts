import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import http from 'http';
import multer from 'multer';
import path from 'path';
import {
  ensureInitialAdminUser,
  isAiStudioIframeHost,
  isHttpsRequest,
  verifySameOriginForMutations,
} from './server/auth.ts';
import { ensureDataDirs, getDb, seedInitialDataIfEmpty } from './server/db.ts';
import { createAuthRouter } from './server/routes/authRoutes.ts';
import { createBackupRouter } from './server/routes/backupRoutes.ts';
import { createCatalogRouter } from './server/routes/catalogRoutes.ts';
import { createQuoteRouter } from './server/routes/quoteRoutes.ts';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;

async function startServer() {
  ensureDataDirs();
  getDb();
  await seedInitialDataIfEmpty();
  ensureInitialAdminUser();

  const distDir = path.resolve(process.cwd(), 'dist');
  const isProduction = process.env.NODE_ENV === 'production' && fs.existsSync(distDir);

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // Security headers
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-DNS-Prefetch-Control', 'off');

    const iframeHost = isAiStudioIframeHost(req);
    if (!iframeHost) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      if (isProduction) {
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      }
    }

    if (isProduction) {
      if (isHttpsRequest(req)) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }
      const frameAncestors = iframeHost ? "'self' https://aistudio.google.com" : "'self'";
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com",
          "img-src 'self' data: blob:",
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          `frame-ancestors ${frameAncestors}`,
        ].join('; ')
      );
    }

    next();
  });

  // Strict no-store caching and Same-Origin CSRF validation on all /api/* routes
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    verifySameOriginForMutations(req, res, next);
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.use('/api', createAuthRouter());
  app.use('/api', createCatalogRouter());
  app.use('/api', createQuoteRouter());
  app.use('/api', createBackupRouter());

  // Catch-all 404 JSON for unknown /api routes
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // ============================================================================
  // VITE / STATIC SERVING
  // ============================================================================
  const httpServer = http.createServer(app);

  if (isProduction) {
    app.use(express.static(distDir));
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: disableHmr
        ? { middlewareMode: true, hmr: false, ws: false }
        : { middlewareMode: true, hmr: { server: httpServer } },
      appType: 'spa',
    });

    if (disableHmr) {
      app.get('/@vite/client', async (_req: Request, res: Response, next: NextFunction) => {
        try {
          const result = await vite.transformRequest('/@vite/client');
          if (!result) {
            next();
            return;
          }
          const patched = result.code
            .replace('await wsTransport.connect(handlers);', 'return;')
            .replace('wsTransport.send(data);', 'return;');
          res.setHeader('Content-Type', 'application/javascript');
          res.send(patched);
        } catch {
          next();
        }
      });
    }

    app.use(vite.middlewares);
  }

  // Global error handler (multer upload limits, invalid JSON, unhandled errors)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;

    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      res.status(status).json({
        error:
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Uploaded file exceeds the maximum allowed size.'
            : err.message,
      });
      return;
    }

    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Invalid JSON request body.' });
      return;
    }

    if (err instanceof Error && err.message === 'Only image files are allowed.') {
      res.status(400).json({ error: err.message });
      return;
    }

    console.error('Unhandled server error:', err);
    res.status(500).json({ error: 'An unexpected internal error occurred.' });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`AdelCo Inc. app listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
