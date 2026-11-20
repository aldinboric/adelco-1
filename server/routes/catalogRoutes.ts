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

// Whitelist of allowed upload types. The declared mimetype is client-controlled,
// so the actual magic bytes are verified again in hasValidImageMagic().
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const uploadProductImage = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB max per image
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPEG, WebP or GIF images are allowed.'));
    }
  },
});

// Verifies actual file content (magic bytes), not just the client-supplied mimetype.
function hasValidImageMagic(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const head6 = buffer.subarray(0, 6).toString('latin1');
  const isGif = head6 === 'GIF89a' || head6 === 'GIF87a';
  const isWebp =
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP';
  return isPng || isJpeg || isGif || isWebp;
}

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

function applyReorder(
  table: 'metal_colors' | 'metal_products',
  rawIds: unknown
): { ok: true; order: number[] } | { ok: false; error: string } {
  const ids = Array.isArray(rawIds) ? rawIds : [];
  const parsed = ids.map((v) => parsePositiveInt(v));
  if (parsed.length === 0 || parsed.some((p) => p === null)) {
    return { ok: false, error: 'ids must be a non-empty array of positive integers.' };
  }
  const order = parsed as number[];
  if (new Set(order).size !== order.length) {
    return { ok: false, error: 'ids must not contain duplicates.' };
  }
  const db = getDb();
  const existing = (db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: number }>).map(
    (r) => r.id
  );
  if (existing.length !== order.length || !order.every((id) => existing.includes(id))) {
    return { ok: false, error: 'ids must match exactly the existing rows.' };
  }
  const stmt = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
  db.transaction(() => {
    order.forEach((id, idx) => stmt.run(idx, id));
  })();
  return { ok: true, order };
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
      const rows = db.prepare('SELECT * FROM metal_colors ORDER BY sort_order ASC, id ASC').all() as MetalColorRow[];
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
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM metal_colors').get() as {
      m: number;
    };
    const info = db
      .prepare(
        'INSERT INTO metal_colors (name, hex_code, price_per_lf_cents, is_available, sort_order, created_at) VALUES (?, ?, ?, 1, ?, ?)'
      )
      .run(name, hex, priceCents, maxSort.m + 1, now);
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

  router.patch(
    '/colors/reorder',
    requireAuth,
    requirePermission('catalog_reorder'),
    (req: Request, res: Response) => {
      const result = applyReorder('metal_colors', req.body?.ids);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ ok: true, order: result.order });
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
      const rows = db.prepare('SELECT * FROM metal_colors ORDER BY sort_order ASC, id ASC').all() as MetalColorRow[];
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
      const rows = db.prepare('SELECT * FROM metal_colors ORDER BY sort_order ASC, id ASC').all() as MetalColorRow[];
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
      const rows = db.prepare('SELECT * FROM metal_products ORDER BY sort_order ASC, id ASC').all() as MetalProductRow[];
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
        const materialType =
          typeof req.body?.material_type === 'string' ? req.body.material_type.trim().slice(0, 200) : '';
        const priceCents = parseCents(req.body?.price_per_lf_cents);

        if (!name) {
          res.status(400).json({ error: 'Product name is required.' });
          return;
        }
        if (priceCents === null) {
          res.status(400).json({ error: 'Valid non-negative price per linear ft is required.' });
          return;
        }
        if (req.file && !hasValidImageMagic(req.file.buffer)) {
          res.status(400).json({ error: 'Only valid PNG, JPEG, WebP or GIF images are allowed.' });
          return;
        }

        let imagePath: string | null = null;
        if (req.file) {
          imagePath = await processProductImage(req.file.buffer);
        }

        const db = getDb();
        const now = new Date().toISOString();
        const maxSort = db
          .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM metal_products')
          .get() as { m: number };
        const info = db
          .prepare(
            'INSERT INTO metal_products (name, image_path, material_type, price_per_lf_cents, is_available, sort_order, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)'
          )
          .run(name, imagePath, materialType || null, priceCents, maxSort.m + 1, now);
        res.status(201).json(db.prepare('SELECT * FROM metal_products WHERE id = ?').get(info.lastInsertRowid));
      } catch (err) {
        // Log the real error server-side; never leak internal details (paths, stack) to the client.
        console.error('Failed to create product:', err);
        res.status(400).json({ error: 'Failed to create product. Please check the uploaded image and try again.' });
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
        const materialType =
          typeof req.body?.material_type === 'string' ? req.body.material_type.trim().slice(0, 200) : '';
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
        if (req.file && !hasValidImageMagic(req.file.buffer)) {
          res.status(400).json({ error: 'Only valid PNG, JPEG, WebP or GIF images are allowed.' });
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

        db.prepare(
          'UPDATE metal_products SET name = ?, image_path = ?, material_type = ?, price_per_lf_cents = ? WHERE id = ?'
        ).run(name, nextImagePath, materialType || null, priceCents, id);

        if ((req.file || removeImage) && existing.image_path && existing.image_path !== nextImagePath) {
          removeImageFileIfUnused(existing.image_path);
        }

        res.json(db.prepare('SELECT * FROM metal_products WHERE id = ?').get(id));
      } catch (err) {
        console.error('Failed to update product:', err);
        res.status(400).json({ error: 'Failed to update product. Please check the uploaded image and try again.' });
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

  router.patch(
    '/products/reorder',
    requireAuth,
    requirePermission('catalog_reorder'),
    (req: Request, res: Response) => {
      const result = applyReorder('metal_products', req.body?.ids);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ ok: true, order: result.order });
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
      const rows = db.prepare('SELECT * FROM metal_products ORDER BY sort_order ASC, id ASC').all() as MetalProductRow[];
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
      const rows = db.prepare('SELECT * FROM metal_products ORDER BY sort_order ASC, id ASC').all() as MetalProductRow[];
      const buf = await buildProductsPdf(rows);
      sendBufferDownload(res, 'application/pdf', 'AdelCo-Products.pdf', buf);
    }
  );

  return router;
}
