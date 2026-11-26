// Material Types hold Sizes: parsing of what a product edit submits, and the
// transaction that writes it back. Kept out of the route layer so both the
// catalog editor and (later) the in-quote size addition validate identically.

import type Database from 'better-sqlite3';
import { formatSizeLabel } from '../shared/size.ts';
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
    const s = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const label = `Size #${index + 1} of "${materialName}"`;

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
    const labelKey = rendered.toLowerCase();
    if (seenLabels.has(labelKey)) {
      return {
        ok: false,
        error: `Duplicate size "${rendered}" for material type "${materialName}".`,
      };
    }
    seenLabels.add(labelKey);

    sizes.push({ priceCents, widthIn, gauge, lengthFt });
  }
  return { ok: true, sizes };
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
