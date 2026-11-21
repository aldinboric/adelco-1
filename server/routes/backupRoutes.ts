import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { type Request, type Response, Router } from 'express';
import fs from 'fs';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { ensureInitialAdminUser, requireAuth, requirePermission } from '../auth.ts';
import {
  closeDb,
  DB_PATH,
  ensureDataDirs,
  getDb,
  getSetting,
  IMAGES_DIR,
  PRODUCT_IMAGES_DIR,
  QUOTE_IMAGES_DIR,
  reloadDb,
  setSetting,
} from '../db.ts';
import { sendBufferDownload } from '../validation.ts';

const MAX_ZIP_ENTRIES = 1000;
const MAX_SINGLE_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 150 * 1024 * 1024;
const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const uploadBackupZip = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB compressed archive limit
    files: 1,
  },
});

function safelyExtractBackupArchive(zipBuffer: Buffer, destDir: string): string {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error('Backup archive contains too many entries.');
  }

  let totalUncompressed = 0;
  let dbTargetPath: string | null = null;
  const resolvedDest = path.resolve(destDir);

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    // Detect symlinks stored in Unix file attributes inside zip
    const unixMode = (entry.header.attr >>> 16) & 0o170000;
    if (unixMode === 0o120000) {
      throw new Error('Backup archive contains forbidden symbolic links.');
    }

    const entrySize = entry.header.size;
    if (entrySize > MAX_SINGLE_ENTRY_BYTES) {
      throw new Error('Backup archive contains an oversized entry.');
    }
    totalUncompressed += entrySize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('Backup archive exceeds maximum uncompressed size limit.');
    }

    const normalized = entry.entryName.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalized.includes('..') || normalized.includes('\0')) {
      throw new Error('Invalid path detected in backup archive.');
    }

    if (normalized === 'adelco.db') {
      const outDb = path.resolve(resolvedDest, 'adelco.db');
      fs.writeFileSync(outDb, entry.getData());
      dbTargetPath = outDb;
      continue;
    }

    // Only permit safe image files inside images/products/ or images/quotes/
    const imageMatch = /^images\/(products|quotes)\/([a-zA-Z0-9._-]+)$/.exec(normalized);
    if (imageMatch) {
      const folder = imageMatch[1];
      const filename = imageMatch[2];
      const ext = path.extname(filename).toLowerCase();
      if (!ALLOWED_IMAGE_EXTS.has(ext)) {
        continue;
      }
      const targetDir = path.resolve(resolvedDest, 'images', folder);
      fs.mkdirSync(targetDir, { recursive: true });
      const targetFile = path.resolve(targetDir, filename);
      if (!targetFile.startsWith(targetDir + path.sep)) {
        throw new Error('Unsafe image path in backup archive.');
      }
      fs.writeFileSync(targetFile, entry.getData());
    }
  }

  if (!dbTargetPath || !fs.existsSync(dbTargetPath)) {
    throw new Error('Invalid backup archive: adelco.db not found.');
  }

  return dbTargetPath;
}

export function createBackupRouter(): Router {
  const router = Router();

  router.get('/settings', requireAuth, requirePermission('backup_settings'), (_req: Request, res: Response) => {
    res.json({
      quote_prefix: getSetting('quote_prefix', ''),
    });
  });

  router.put('/settings', requireAuth, requirePermission('backup_settings'), (req: Request, res: Response) => {
    const raw = typeof req.body?.quote_prefix === 'string' ? req.body.quote_prefix : '';
    const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 8);
    setSetting('quote_prefix', cleaned);
    res.json({ quote_prefix: cleaned });
  });

  router.get(
    '/backup/download',
    requireAuth,
    requirePermission('backup_settings'),
    async (_req: Request, res: Response) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adelco-backup-'));
      const tempDbPath = path.join(tempDir, 'adelco.db');

      try {
        const db = getDb();
        await db.backup(tempDbPath);

        const stamp = new Date().toISOString().slice(0, 10);
        const zip = new AdmZip();
        zip.addLocalFile(tempDbPath, '', 'adelco.db');
        if (fs.existsSync(IMAGES_DIR)) {
          zip.addLocalFolder(IMAGES_DIR, 'images');
        }
        const zipBuffer = zip.toBuffer();
        sendBufferDownload(res, 'application/zip', `AdelCo-Backup-${stamp}.zip`, zipBuffer);
      } catch (err) {
        if (!res.headersSent) {
          res.status(500).json({ error: err instanceof Error ? err.message : 'Backup failed.' });
        }
      } finally {
        setTimeout(() => {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }, 5000);
      }
    }
  );

  router.post(
    '/backup/restore',
    requireAuth,
    requirePermission('backup_settings'),
    uploadBackupZip.single('backup'),
    (req: Request, res: Response) => {
      if (!req.file) {
        res.status(400).json({ error: 'Please select a backup .zip file.' });
        return;
      }

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adelco-restore-'));
      // Staging paths live next to the live files (same filesystem) so the final
      // swap is a rename — a crash mid-copy can no longer leave a half-written DB.
      const stagedDbPath = `${DB_PATH}.restore-new`;
      const stagedImagesDir = `${IMAGES_DIR}.restore-new`;
      try {
        const restoredDbPath = safelyExtractBackupArchive(req.file.buffer, tempDir);

        // Validate SQLite integrity and required tables before replacing live DB
        const testDb = new Database(restoredDbPath, { readonly: true });
        const integrity = testDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
        if (integrity.integrity_check !== 'ok') {
          testDb.close();
          throw new Error('Invalid backup database: integrity check failed.');
        }
        const tables = testDb
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>;
        testDb.close();

        const tableNames = new Set(tables.map((t) => t.name));
        const required = [
          'metal_colors',
          'metal_products',
          'issued_quotes',
          'issued_quote_items',
          'quote_sequences',
          'app_settings',
          'users',
          'user_sessions',
        ];
        for (const reqTable of required) {
          if (!tableNames.has(reqTable)) {
            throw new Error(`Invalid backup database: missing table ${reqTable}.`);
          }
        }

        closeDb();
        ensureDataDirs();

        // Stage the restored DB next to the live one, then swap: the live DB is
        // only replaced once the restored copy is fully written and validated.
        fs.copyFileSync(restoredDbPath, stagedDbPath);
        for (const suffix of ['', '-wal', '-shm']) {
          const target = `${DB_PATH}${suffix}`;
          if (fs.existsSync(target)) {
            fs.unlinkSync(target);
          }
        }
        fs.renameSync(stagedDbPath, DB_PATH);

        const restoredImagesDir = path.join(tempDir, 'images');
        if (fs.existsSync(restoredImagesDir)) {
          fs.cpSync(restoredImagesDir, stagedImagesDir, { recursive: true });
          fs.rmSync(IMAGES_DIR, { recursive: true, force: true });
          fs.renameSync(stagedImagesDir, IMAGES_DIR);
        }
        fs.mkdirSync(PRODUCT_IMAGES_DIR, { recursive: true });
        fs.mkdirSync(QUOTE_IMAGES_DIR, { recursive: true });

        reloadDb();
        ensureInitialAdminUser();
        res.json({ restored: true });
      } catch (err) {
        // Never leave staging leftovers behind; the live DB was not touched yet.
        for (const p of [stagedDbPath, stagedImagesDir]) {
          try {
            fs.rmSync(p, { recursive: true, force: true });
          } catch {
            // ignore cleanup errors
          }
        }
        reloadDb();
        ensureInitialAdminUser();
        res.status(400).json({ error: err instanceof Error ? err.message : 'Restore failed.' });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );

  return router;
}
