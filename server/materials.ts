// Material Types hold Sizes: parsing of what a product edit submits, and the
// transaction that writes it back. Kept out of the route layer so both the
// catalog editor and (later) the in-quote size addition validate identically.

import type Database from 'better-sqlite3';
import { formatSizeLabel } from '../shared/size.ts';
import type { ProductMaterialRow, ProductMaterialSizeRow } from './db.ts';
import { parseCents } from './validation.ts';

export const MAX_MATERIAL_TYPES_PER_PRODUCT = 50;
export const MAX_SIZES_PER_MATERIAL_TYPE = 50;
const MAX_DIMENSION_VALUE = 1_000_000;

/** One Size as submitted: its Dimensions (each optional, at least one) and its own Price. */
export interface ParsedSizeInput {
  priceCents: number;
  widthIn: number | null;
  gauge: string | null;
  lengthFt: number | null;
  /** The rendered label (e.g. `26 ga 5" x 5'`) — what duplicate detection compares. */
  rendered: string;
}

/**
 * One Material Type as submitted. `priceCents` is the general Price, used while the
 * Type has no Sizes; with Sizes it mirrors the first Size's Price.
 */
export interface ParsedMaterialTypeInput {
  name: string;
  priceCents: number;
  sizes: ParsedSizeInput[];
}

type ParsedMaterials = { ok: true; materials: ParsedMaterialTypeInput[] } | { ok: false; error: string };

function parseDimension(raw: unknown): number | null | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_DIMENSION_VALUE) return 'invalid';
  return n;
}

/** The duplicate-Size message, shared by the product editor path and the in-quote add. */
export function duplicateSizeError(rendered: string, materialName: string): string {
  return `Duplicate size "${rendered}" for material type "${materialName}".`;
}

/**
 * Validates one Size as submitted — `{ price_per_lf_cents, gauge?, width_in?, length_ft? }` —
 * under the given `label` (e.g. `Size #2 of "Aluminum"`), with the exact wording the catalog
 * editor uses. `rendered` comes back on the parsed Size so callers can run the duplicate check.
 */
export function parseSizeInput(
  raw: unknown,
  label: string
): { ok: true; size: ParsedSizeInput } | { ok: false; error: string } {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const priceCents = parseCents(s.price_per_lf_cents);
  if (priceCents === null) {
    return { ok: false, error: `${label} needs a valid non-negative price per linear ft.` };
  }
  const widthIn = parseDimension(s.width_in);
  if (widthIn === 'invalid') {
    return { ok: false, error: `Width (in) for ${label} must be a positive number.` };
  }
  const lengthFt = parseDimension(s.length_ft);
  if (lengthFt === 'invalid') {
    return { ok: false, error: `Length (ft) for ${label} must be a positive number.` };
  }
  const gauge = typeof s.gauge === 'string' && s.gauge.trim() ? s.gauge.trim().slice(0, 20) : null;

  // At least one Dimension, so two Sizes of one Material Type can never be indistinguishable.
  const rendered = formatSizeLabel({ gauge, width_in: widthIn, length_ft: lengthFt });
  if (!rendered) {
    return { ok: false, error: `${label} needs at least one of gauge, width, or length.` };
  }

  return { ok: true, size: { priceCents, widthIn, gauge, lengthFt, rendered } };
}

function parseSizes(raw: unknown, materialName: string): { ok: true; sizes: ParsedSizeInput[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, sizes: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: `Sizes for "${materialName}" must be an array.` };
  }
  if (raw.length > MAX_SIZES_PER_MATERIAL_TYPE) {
    return {
      ok: false,
      error: `Material type "${materialName}" can have at most ${MAX_SIZES_PER_MATERIAL_TYPE} sizes.`,
    };
  }

  const sizes: ParsedSizeInput[] = [];
  const seenLabels = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const result = parseSizeInput(entry, `Size #${index + 1} of "${materialName}"`);
    if (!result.ok) return result;
    const labelKey = result.size.rendered.toLowerCase();
    if (seenLabels.has(labelKey)) {
      return { ok: false, error: duplicateSizeError(result.size.rendered, materialName) };
    }
    seenLabels.add(labelKey);
    sizes.push(result.size);
  }
  return { ok: true, sizes };
}

/**
 * Validates one Size being added to an existing Material Type (the in-quote "add size"):
 * numbered after the Sizes the Type already has and refused when its rendered label
 * matches one of them — exactly as the catalog editor would refuse it.
 */
export function parseNewSizeInput(
  raw: unknown,
  materialName: string,
  existingSizes: readonly { gauge: string | null; width_in: number | null; length_ft: number | null }[]
): { ok: true; size: ParsedSizeInput } | { ok: false; error: string } {
  if (existingSizes.length >= MAX_SIZES_PER_MATERIAL_TYPE) {
    return {
      ok: false,
      error: `Material type "${materialName}" can have at most ${MAX_SIZES_PER_MATERIAL_TYPE} sizes.`,
    };
  }
  const parsed = parseSizeInput(raw, `Size #${existingSizes.length + 1} of "${materialName}"`);
  if (!parsed.ok) return parsed;
  const labelKey = parsed.size.rendered.toLowerCase();
  if (existingSizes.some((s) => formatSizeLabel(s)?.toLowerCase() === labelKey)) {
    return { ok: false, error: duplicateSizeError(parsed.size.rendered, materialName) };
  }
  return parsed;
}

/**
 * Reads the `materials` field of a product edit — a JSON string inside the multipart
 * form, or an array for JSON clients. Each entry: `{ name, price_per_lf_cents?, sizes? }`
 * where a Size is `{ price_per_lf_cents, gauge?, width_in?, length_ft? }`.
 */
export function parseMaterialsInput(raw: unknown): ParsedMaterials {
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
  if (parsed.length > MAX_MATERIAL_TYPES_PER_PRODUCT) {
    return {
      ok: false,
      error: `A product can have at most ${MAX_MATERIAL_TYPES_PER_PRODUCT} material types.`,
    };
  }

  const materials: ParsedMaterialTypeInput[] = [];
  const seenNames = new Set<string>();
  for (const entry of parsed) {
    const m = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const name = typeof m.name === 'string' ? m.name.trim().slice(0, 100) : '';
    if (!name) {
      return { ok: false, error: 'Every material type needs a name.' };
    }
    if (seenNames.has(name.toLowerCase())) {
      return { ok: false, error: `Duplicate material type "${name}".` };
    }
    seenNames.add(name.toLowerCase());

    const sizesResult = parseSizes(m.sizes, name);
    if (!sizesResult.ok) return sizesResult;

    // With Sizes the general Price follows the first Size; without Sizes it is the only Price.
    const priceCents =
      sizesResult.sizes.length > 0
        ? sizesResult.sizes[0].priceCents
        : parseCents(m.price_per_lf_cents);
    if (priceCents === null) {
      return {
        ok: false,
        error: `Material type "${name}" needs a valid non-negative price per linear ft.`,
      };
    }

    materials.push({ name, priceCents, sizes: sizesResult.sizes });
  }
  return { ok: true, materials };
}

/** material_type column value kept in sync with the materials rows (legacy readers). */
export function materialTypeColumnValue(
  materials: ParsedMaterialTypeInput[],
  fallback: string
): string | null {
  return materials.length > 0 ? materials.map((m) => m.name).join(', ') : fallback || null;
}

// Transactionally replace a product's Material Types and their Sizes, and keep the
// legacy comma-joined material_type column in sync for older readers/exports.
export function replaceProductMaterials(
  db: Database.Database,
  productId: number,
  materials: ParsedMaterialTypeInput[]
): void {
  const now = new Date().toISOString();
  const del = db.prepare('DELETE FROM product_materials WHERE product_id = ?');
  const insertType = db.prepare(`
    INSERT INTO product_materials (product_id, name, price_per_lf_cents, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertSize = db.prepare(`
    INSERT INTO product_material_sizes (material_id, price_per_lf_cents, width_in, gauge, length_ft, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const sync = db.prepare('UPDATE metal_products SET material_type = ? WHERE id = ?');

  db.transaction(() => {
    // The cascading foreign key takes the replaced Types' Sizes with them.
    del.run(productId);
    materials.forEach((m, idx) => {
      const info = insertType.run(productId, m.name, m.priceCents, idx, now);
      const materialId = Number(info.lastInsertRowid);
      m.sizes.forEach((s, sizeIdx) => {
        insertSize.run(materialId, s.priceCents, s.widthIn, s.gauge, s.lengthFt, sizeIdx, now);
      });
    });
    sync.run(materialTypeColumnValue(materials, ''), productId);
  })();
}

/**
 * Adds one Size to a Material Type in a single transaction: appended after the existing
 * Sizes, and — when it is the Type's first — the Type's general Price mirrors it, the same
 * rule the product editor applies when it saves its first Size. Returns the created Size
 * and the updated Material Type with all its Sizes in order.
 */
export function addSizeToMaterial(
  db: Database.Database,
  material: ProductMaterialRow,
  size: ParsedSizeInput
): { size: ProductMaterialSizeRow; material: ProductMaterialRow & { sizes: ProductMaterialSizeRow[] } } {
  const now = new Date().toISOString();
  const insertSize = db.prepare(`
    INSERT INTO product_material_sizes (material_id, price_per_lf_cents, width_in, gauge, length_ft, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const countStmt = db.prepare('SELECT COUNT(*) AS cnt FROM product_material_sizes WHERE material_id = ?');
  const maxSortStmt = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM product_material_sizes WHERE material_id = ?'
  );
  const syncTypePrice = db.prepare('UPDATE product_materials SET price_per_lf_cents = ? WHERE id = ?');
  const getSize = db.prepare('SELECT * FROM product_material_sizes WHERE id = ?');
  const listSizes = db.prepare(
    'SELECT * FROM product_material_sizes WHERE material_id = ? ORDER BY sort_order ASC, id ASC'
  );

  return db.transaction(() => {
    const materialId = material.id;
    const count = (countStmt.get(materialId) as { cnt: number }).cnt;
    const maxSort = (maxSortStmt.get(materialId) as { m: number }).m;
    const info = insertSize.run(
      materialId,
      size.priceCents,
      size.widthIn,
      size.gauge,
      size.lengthFt,
      maxSort + 1,
      now
    );
    const sizeId = Number(info.lastInsertRowid);

    // First Size of the Type: the general Price follows it, so removing every Size later
    // still leaves a usable Price — the same mirror the catalog editor applies on save.
    let materialPriceCents = material.price_per_lf_cents;
    if (count === 0) {
      syncTypePrice.run(size.priceCents, materialId);
      materialPriceCents = size.priceCents;
    }

    const created = getSize.get(sizeId) as ProductMaterialSizeRow;
    const sizes = listSizes.all(materialId) as ProductMaterialSizeRow[];
    return { size: created, material: { ...material, price_per_lf_cents: materialPriceCents, sizes } };
  })();
}
