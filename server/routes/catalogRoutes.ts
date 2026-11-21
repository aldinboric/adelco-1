import { type Request, type Response, Router } from 'express';
import multer from 'multer';
import path from 'path';
import sharp from 'sharp';
import { requireAnyPermission, requireAuth, requirePermission } from '../auth.ts';
import {
  attachMaterials,
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
  EXCEL_MIME,
  normalizeHex,
  paramAsString,
  parseCents,
  parsePositiveInt,
  sendBufferDownload,
} from '../validation.ts';

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

const MAX_MATERIALS_PER_PRODUCT = 50;
const MAX_MEASURE = 1_000_000;

// ---------------------------------------------------------------------------
// Shared route-handler factories (colors & products endpoints are structurally
// identical — only the table and labels differ).
// ---------------------------------------------------------------------------

function makeAvailabilityHandler(table: 'metal_colors' | 'metal_products', label: string) {
  return (req: Request, res: Response): void => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: `Invalid ${label.toLowerCase()} ID.` });
      return;
    }
    const isAvailable = req.body?.is_available ? 1 : 0;
    const db = getDb();
    const existing = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
    if (!existing) {
      res.status(404).json({ error: `${label} not found.` });
      return;
    }
    db.prepare(`UPDATE ${table} SET is_available = ? WHERE id = ?`).run(isAvailable, id);
    res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
  };
}

function makeReorderHandler(table: 'metal_colors' | 'metal_products') {
  return (req: Request, res: Response): void => {
    const result = applyReorder(table, req.body?.ids);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, order: result.order });
  };
}

/** Runs an async export builder and converts failures into a clean 500 JSON. */
async function sendExport(
  res: Response,
  contentType: string,
  filename: string,
  build: () => Promise<Buffer>
): Promise<void> {
  try {
    sendBufferDownload(res, contentType, filename, await build());
  } catch (err) {
    console.error(`Export ${filename} failed:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Export failed. Please try again.' });
    }
  }
}

interface ColorInput {
  name: string;
  hex: string;
  priceCents: number;
}

function parseColorInput(body: unknown): { ok: true; value: ColorInput } | { ok: false; error: string } {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
  const hex = normalizeHex(b.hex_code);
  const priceCents = parseCents(b.price_per_lf_cents);
  if (!name) return { ok: false, error: 'Color name is required.' };
  if (!hex) return { ok: false, error: 'Valid 6-digit HEX code (e.g. #084091) is required.' };
  if (priceCents === null) {
    return { ok: false, error: 'Valid non-negative price per linear ft is required.' };
  }
  return { ok: true, value: { name, hex, priceCents } };
}

interface ProductInput {
  name: string;
  materialType: string;
  priceCents: number;
  removeImage: boolean;
  materials: ParsedMaterialInput[];
  imageValid: boolean;
}

function parseProductInput(req: Request): { ok: true; value: ProductInput } | { ok: false; error: string } {
  const b = req.body ?? {};
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
  const materialType = typeof b.material_type === 'string' ? b.material_type.trim().slice(0, 200) : '';
  const priceCents = parseCents(b.price_per_lf_cents);
  const removeImage = b.remove_image === 'true' || b.remove_image === true;

  if (!name) return { ok: false, error: 'Product name is required.' };
  if (priceCents === null) {
    return { ok: false, error: 'Valid non-negative price per linear ft is required.' };
  }
  if (req.file && !hasValidImageMagic(req.file.buffer)) {
    return { ok: false, error: 'Only valid PNG, JPEG, WebP or GIF images are allowed.' };
  }
  const materialsResult = parseMaterialsInput(b.materials);
  if (!materialsResult.ok) return materialsResult;

  return {
    ok: true,
    value: { name, materialType, priceCents, removeImage, materials: materialsResult.materials, imageValid: true },
  };
}

/** material_type column value kept in sync with the materials rows (legacy readers). */
function materialTypeColumnValue(materials: ParsedMaterialInput[], fallback: string): string | null {
  return materials.length > 0 ? materials.map((m) => m.name).join(', ') : fallback || null;
}

interface ParsedMaterialInput {
  name: string;
  priceCents: number;
  widthIn: number | null;
  gauge: string | null;
  lengthFt: number | null;
}

// Materials arrive as a JSON string inside the multipart form (or as an array
// for JSON clients). Each entry: { name, price_per_lf_cents, width_in?, gauge?, length_ft? }.
function parseMaterialsInput(
  raw: unknown
): { ok: true; materials: ParsedMaterialInput[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, materials: [] };
  }
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'materials must be a valid JSON array.' };
    }
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'materials must be an array.' };
  }
  if (parsed.length > MAX_MATERIALS_PER_PRODUCT) {
    return { ok: false, error: `A product can have at most ${MAX_MATERIALS_PER_PRODUCT} material types.` };
  }
  const materials: ParsedMaterialInput[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const m = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const name = typeof m.name === 'string' ? m.name.trim().slice(0, 100) : '';
    if (!name) {
      return { ok: false, error: 'Every material type needs a name.' };
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return { ok: false, error: `Duplicate material type "${name}".` };
    }
    seen.add(key);
    const priceCents = parseCents(m.price_per_lf_cents);
    if (priceCents === null) {
      return {
        ok: false,
        error: `Material type "${name}" needs a valid non-negative price per linear ft.`,
      };
    }
    let widthIn: number | null = null;
    if (m.width_in !== undefined && m.width_in !== null && m.width_in !== '') {
      const w = Number(m.width_in);
      if (!Number.isFinite(w) || w <= 0 || w > MAX_MEASURE) {
        return { ok: false, error: `Width (in) for "${name}" must be a positive number.` };
      }
      widthIn = w;
    }
    let lengthFt: number | null = null;
    if (m.length_ft !== undefined && m.length_ft !== null && m.length_ft !== '') {
      const l = Number(m.length_ft);
      if (!Number.isFinite(l) || l <= 0 || l > MAX_MEASURE) {
        return { ok: false, error: `Length (ft) for "${name}" must be a positive number.` };
      }
      lengthFt = l;
    }
    const gauge =
      typeof m.gauge === 'string' && m.gauge.trim() ? m.gauge.trim().slice(0, 20) : null;
    materials.push({ name, priceCents, widthIn, gauge, lengthFt });
  }
  return { ok: true, materials };
}

// Transactionally replace a product's material rows and keep the legacy
// comma-joined material_type column in sync for older readers/exports.
function replaceProductMaterials(
  db: import('better-sqlite3').Database,
  productId: number,
  materials: ParsedMaterialInput[]
): void {
  const now = new Date().toISOString();
  const del = db.prepare('DELETE FROM product_materials WHERE product_id = ?');
  const ins = db.prepare(`
    INSERT INTO product_materials (product_id, name, price_per_lf_cents, width_in, gauge, length_ft, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sync = db.prepare('UPDATE metal_products SET material_type = ? WHERE id = ?');
  db.transaction(() => {
    del.run(productId);
    materials.forEach((m, idx) => {
      ins.run(productId, m.name, m.priceCents, m.widthIn, m.gauge, m.lengthFt, idx, now);
    });
    sync.run(materials.length > 0 ? materials.map((m) => m.name).join(', ') : null, productId);
  })();
}

function getAllColors(): MetalColorRow[] {
  return getDb()
    .prepare('SELECT * FROM metal_colors ORDER BY sort_order ASC, id ASC')
    .all() as MetalColorRow[];
}

function getAllProducts(): MetalProductRow[] {
  return getDb()
    .prepare('SELECT * FROM metal_products ORDER BY sort_order ASC, id ASC')
    .all() as MetalProductRow[];
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
      res.json(getAllColors());
    }
  );

  router.post('/colors', requireAuth, requirePermission('colors_manage'), (req: Request, res: Response) => {
    const parsed = parseColorInput(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { name, hex, priceCents } = parsed.value;

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
    if (!id) {
      res.status(400).json({ error: 'Invalid color ID.' });
      return;
    }
    const parsed = parseColorInput(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { name, hex, priceCents } = parsed.value;

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
    makeAvailabilityHandler('metal_colors', 'Color')
  );

  router.patch(
    '/colors/reorder',
    requireAuth,
    requirePermission('catalog_reorder'),
    makeReorderHandler('metal_colors')
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
    (_req: Request, res: Response) => {
      void sendExport(res, EXCEL_MIME, 'AdelCo-Colors.xlsx', async () =>
        buildColorsExcel(getAllColors())
      );
    }
  );

  router.get(
    '/colors/export/pdf',
    requireAuth,
    requirePermission('colors_view', 'exports'),
    (_req: Request, res: Response) => {
      void sendExport(res, 'application/pdf', 'AdelCo-Colors.pdf', async () =>
        buildColorsPdf(getAllColors())
      );
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
      res.json(attachMaterials(getDb(), getAllProducts()));
    }
  );

  router.post(
    '/products',
    requireAuth,
    requirePermission('products_manage'),
    uploadProductImage.single('image'),
    async (req: Request, res: Response) => {
      try {
        const parsed = parseProductInput(req);
        if (!parsed.ok) {
          res.status(400).json({ error: parsed.error });
          return;
        }
        const { name, materialType, priceCents, materials } = parsed.value;

        const imagePath = req.file ? await processProductImage(req.file.buffer) : null;

        const db = getDb();
        const now = new Date().toISOString();
        const maxSort = db
          .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM metal_products')
          .get() as { m: number };
        const info = db
          .prepare(
            'INSERT INTO metal_products (name, image_path, material_type, price_per_lf_cents, is_available, sort_order, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)'
          )
          .run(name, imagePath, materialTypeColumnValue(materials, materialType), priceCents, maxSort.m + 1, now);
        const productId = Number(info.lastInsertRowid);
        replaceProductMaterials(db, productId, materials);
        const created = db.prepare('SELECT * FROM metal_products WHERE id = ?').get(productId) as MetalProductRow;
        res.status(201).json(attachMaterials(db, [created])[0]);
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
        if (!id) {
          res.status(400).json({ error: 'Invalid product ID.' });
          return;
        }
        const parsed = parseProductInput(req);
        if (!parsed.ok) {
          res.status(400).json({ error: parsed.error });
          return;
        }
        const { name, materialType, priceCents, removeImage, materials } = parsed.value;

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
        ).run(name, nextImagePath, materialTypeColumnValue(materials, materialType), priceCents, id);
        replaceProductMaterials(db, id, materials);

        if ((req.file || removeImage) && existing.image_path && existing.image_path !== nextImagePath) {
          removeImageFileIfUnused(existing.image_path);
        }

        const updated = db.prepare('SELECT * FROM metal_products WHERE id = ?').get(id) as MetalProductRow;
        res.json(attachMaterials(db, [updated])[0]);
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
    makeAvailabilityHandler('metal_products', 'Product')
  );

  router.patch(
    '/products/reorder',
    requireAuth,
    requirePermission('catalog_reorder'),
    makeReorderHandler('metal_products')
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
    (_req: Request, res: Response) => {
      void sendExport(res, EXCEL_MIME, 'AdelCo-Products.xlsx', async () =>
        buildProductsExcel(attachMaterials(getDb(), getAllProducts()))
      );
    }
  );

  router.get(
    '/products/export/pdf',
    requireAuth,
    requirePermission('products_view', 'exports'),
    (_req: Request, res: Response) => {
      void sendExport(res, 'application/pdf', 'AdelCo-Products.pdf', async () =>
        buildProductsPdf(attachMaterials(getDb(), getAllProducts()))
      );
    }
  );

  return router;
}
