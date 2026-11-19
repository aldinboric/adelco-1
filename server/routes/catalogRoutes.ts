import { type Request, type Response, Router } from 'express';
import multer from 'multer';
import path from 'path';
import sharp from 'sharp';
import { requireAnyPermission, requireAuth, requirePermission } from '../auth.ts';
import {
  ensureDataDirs,
  getDb,
  type MetalColorRow,
  type MetalProductRow,
  PRODUCT_IMAGES_DIR,
  removeImageFileIfUnused,
  resolveSafeImagePath,
} from '../db.ts';
import {
  buildColorsExcel,
  buildColorsPdf,
  buildProductsExcel,
  buildProductsPdf,
} from '../exports.ts';
import {
  normalizeHex,
  paramAsString,
  parseCents,
  parsePositiveInt,
  sendBufferDownload,
} from '../validation.ts';

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const uploadProductImage = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB max per image
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed.'));
    }
  },
});

async function processProductImage(buffer: Buffer): Promise<string> {
  ensureDataDirs();
  const filename = `prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  const outPath = path.join(PRODUCT_IMAGES_DIR, filename);
  await sharp(buffer, { limitInputPixels: 4096 * 4096 })
    .rotate()
    .resize(128, 128, {
      fit: 'contain',
      background: { r: 247, g: 247, b: 247, alpha: 1 },
    })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  return `products/${filename}`;
}

export function createCatalogRouter(): Router {
  const router = Router();

  // Serve stored product & quote snapshot images safely (authenticated)
  router.get(
    '/images/:folder/:filename',
    requireAuth,
    requireAnyPermission('customer_quote', 'issued_quotes_view', 'products_view'),
    (req: Request, res: Response) => {
      const folder = paramAsString(req.params.folder);
      const filename = paramAsString(req.params.filename);
      if (folder !== 'products' && folder !== 'quotes') {
        res.status(404).end();
        return;
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
        res.status(400).end();
        return;
      }
      const fullPath = resolveSafeImagePath(`${folder}/${filename}`);
      if (!fullPath) {
        res.status(404).end();
        return;
      }
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.sendFile(fullPath);
    }
  );

  // ============================================================================
  // METAL COLORS
  // ============================================================================
  router.get(
    '/colors',
    requireAuth,
    requireAnyPermission('colors_view', 'customer_quote'),
    (_req: Request, res: Response) => {
      const db = getDb();
      const rows = db.prepare('SELECT * FROM metal_colors ORDER BY id ASC').all() as MetalColorRow[];
      res.json(rows);
    }
  );

  router.post('/colors', requireAuth, requirePermission('colors_manage'), (req: Request, res: Response) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
    const hex = normalizeHex(req.body?.hex_code);
    const priceCents = parseCents(req.body?.price_per_lf_cents);

    if (!name) {
      res.status(400).json({ error: 'Color name is required.' });
      return;
    }
    if (!hex) {
      res.status(400).json({ error: 'Valid 6-digit HEX code (e.g. #084091) is required.' });
      return;
    }
    if (priceCents === null) {
      res.status(400).json({ error: 'Valid non-negative price per linear ft is required.' });
      return;
    }

    const db = getDb();
    const now = new Date().toISOString();
    const info = db
      .prepare(
        'INSERT INTO metal_colors (name, hex_code, price_per_lf_cents, is_available, created_at) VALUES (?, ?, ?, 1, ?)'
      )
      .run(name, hex, priceCents, now);
    const created = db.prepare('SELECT * FROM metal_colors WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(created);
  });

  router.put('/colors/:id', requireAuth, requirePermission('colors_manage'), (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
    const hex = normalizeHex(req.body?.hex_code);
    const priceCents = parseCents(req.body?.price_per_lf_cents);

    if (!id) {
      res.status(400).json({ error: 'Invalid color ID.' });
      return;
    }
    if (!name) {
      res.status(400).json({ error: 'Color name is required.' });
      return;
    }
    if (!hex) {
      res.status(400).json({ error: 'Valid 6-digit HEX code is required.' });
      return;
    }
    if (priceCents === null) {
      res.status(400).json({ error: 'Valid price per linear ft is required.' });
      return;
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM metal_colors WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'Color not found.' });
      return;
    }

    db.prepare('UPDATE metal_colors SET name = ?, hex_code = ?, price_per_lf_cents = ? WHERE id = ?').run(
      name,
      hex,
      priceCents,
      id
    );
    res.json(db.prepare('SELECT * FROM metal_colors WHERE id = ?').get(id));
  });

  router.patch(
    '/colors/:id/availability',
    requireAuth,
    requirePermission('colors_manage'),
    (req: Request, res: Response) => {
      const id = parsePositiveInt(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Invalid color ID.' });
        return;
      }
      const isAvailable = req.body?.is_available ? 1 : 0;
      const db = getDb();
      const existing = db.prepare('SELECT * FROM metal_colors WHERE id = ?').get(id);
      if (!existing) {
        res.status(404).json({ error: 'Color not found.' });
        return;
      }
      db.prepare('UPDATE metal_colors SET is_available = ? WHERE id = ?').run(isAvailable, id);
      res.json(db.prepare('SELECT * FROM metal_colors WHERE id = ?').get(id));
    }
  );

  router.delete('/colors/:id', requireAuth, requirePermission('colors_manage'), (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid color ID.' });
      return;
    }
    const db = getDb();
    const info = db.prepare('DELETE FROM metal_colors WHERE id = ?').run(id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Color not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  router.get(
    '/colors/export/excel',
    requireAuth,
    requirePermission('colors_view', 'exports'),
    async (_req: Request, res: Response) => {
      const db = getDb();
      const rows = db.prepare('SELECT * FROM metal_colors ORDER BY id ASC').all() as MetalColorRow[];
      const buf = await buildColorsExcel(rows);
      sendBufferDownload(res, EXCEL_MIME, 'AdelCo-Colors.xlsx', buf);
    }
  );

  router.get(
    '/colors/export/pdf',
    requireAuth,
    requirePermission('colors_view', 'exports'),
    async (_req: Request, res: Response) => {
      const db = getDb();
      const rows = db.prepare('SELECT * FROM metal_colors ORDER BY id ASC').all() as MetalColorRow[];
      const buf = await buildColorsPdf(rows);
      sendBufferDownload(res, 'application/pdf', 'AdelCo-Colors.pdf', buf);
    }
  );

  // ============================================================================
  // METAL PRODUCTS
  // ============================================================================
  router.get(
    '/products',
    requireAuth,
    requireAnyPermission('products_view', 'customer_quote'),
    (_req: Request, res: Response) => {
      const db = getDb();
      const rows = db.prepare('SELECT * FROM metal_products ORDER BY id ASC').all() as MetalProductRow[];
      res.json(rows);
    }
  );

  router.post(
    '/products',
    requireAuth,
    requirePermission('products_manage'),
    uploadProductImage.single('image'),
    async (req: Request, res: Response) => {
      try {
        const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
        const priceCents = parseCents(req.body?.price_per_lf_cents);

        if (!name) {
          res.status(400).json({ error: 'Product name is required.' });
          return;
        }
        if (priceCents === null) {
          res.status(400).json({ error: 'Valid non-negative price per linear ft is required.' });
          return;
        }

        let imagePath: string | null = null;
        if (req.file) {
          imagePath = await processProductImage(req.file.buffer);
        }

        const db = getDb();
        const now = new Date().toISOString();
        const info = db
          .prepare(
            'INSERT INTO metal_products (name, image_path, price_per_lf_cents, is_available, created_at) VALUES (?, ?, ?, 1, ?)'
          )
          .run(name, imagePath, priceCents, now);
        res.status(201).json(db.prepare('SELECT * FROM metal_products WHERE id = ?').get(info.lastInsertRowid));
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create product.' });
      }
    }
  );

  router.put(
    '/products/:id',
    requireAuth,
    requirePermission('products_manage'),
    uploadProductImage.single('image'),
    async (req: Request, res: Response) => {
      try {
        const id = parsePositiveInt(req.params.id);
        const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
        const priceCents = parseCents(req.body?.price_per_lf_cents);
        const removeImage = req.body?.remove_image === 'true' || req.body?.remove_image === true;

        if (!id) {
          res.status(400).json({ error: 'Invalid product ID.' });
          return;
        }
        if (!name) {
          res.status(400).json({ error: 'Product name is required.' });
          return;
        }
        if (priceCents === null) {
          res.status(400).json({ error: 'Valid price per linear ft is required.' });
          return;
        }

        const db = getDb();
        const existing = db.prepare('SELECT * FROM metal_products WHERE id = ?').get(id) as
          | MetalProductRow
          | undefined;
        if (!existing) {
          res.status(404).json({ error: 'Product not found.' });
          return;
        }

        let nextImagePath = existing.image_path;
        if (req.file) {
          nextImagePath = await processProductImage(req.file.buffer);
        } else if (removeImage) {
          nextImagePath = null;
        }

        db.prepare('UPDATE metal_products SET name = ?, image_path = ?, price_per_lf_cents = ? WHERE id = ?').run(
          name,
          nextImagePath,
          priceCents,
          id
        );

        if ((req.file || removeImage) && existing.image_path && existing.image_path !== nextImagePath) {
          removeImageFileIfUnused(existing.image_path);
        }

        res.json(db.prepare('SELECT * FROM metal_products WHERE id = ?').get(id));
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update product.' });
      }
    }
  );

  router.patch(
    '/products/:id/availability',
    requireAuth,
    requirePermission('products_manage'),
    (req: Request, res: Response) => {
      const id = parsePositiveInt(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Invalid product ID.' });
        return;
      }
      const isAvailable = req.body?.is_available ? 1 : 0;
      const db = getDb();
      const existing = db.prepare('SELECT * FROM metal_products WHERE id = ?').get(id);
      if (!existing) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }
      db.prepare('UPDATE metal_products SET is_available = ? WHERE id = ?').run(isAvailable, id);
      res.json(db.prepare('SELECT * FROM metal_products WHERE id = ?').get(id));
    }
  );

  router.delete('/products/:id', requireAuth, requirePermission('products_manage'), (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid product ID.' });
      return;
    }
    const db = getDb();
    const existing = db.prepare('SELECT * FROM metal_products WHERE id = ?').get(id) as
      | MetalProductRow
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }
    db.prepare('DELETE FROM metal_products WHERE id = ?').run(id);
    removeImageFileIfUnused(existing.image_path);
    res.json({ deleted: true });
  });

  router.get(
    '/products/export/excel',
    requireAuth,
    requirePermission('products_view', 'exports'),
    async (_req: Request, res: Response) => {
      const db = getDb();
      const rows = db.prepare('SELECT * FROM metal_products ORDER BY id ASC').all() as MetalProductRow[];
      const buf = await buildProductsExcel(rows);
      sendBufferDownload(res, EXCEL_MIME, 'AdelCo-Products.xlsx', buf);
    }
  );

  router.get(
    '/products/export/pdf',
    requireAuth,
    requirePermission('products_view', 'exports'),
    async (_req: Request, res: Response) => {
      const db = getDb();
      const rows = db.prepare('SELECT * FROM metal_products ORDER BY id ASC').all() as MetalProductRow[];
      const buf = await buildProductsPdf(rows);
      sendBufferDownload(res, 'application/pdf', 'AdelCo-Products.pdf', buf);
    }
  );

  return router;
}
