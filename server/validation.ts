import type { Response } from 'express';
import { normalizeHexStrict } from '../shared/hex.ts';
import { getDb, type MetalColorRow, type MetalProductRow } from './db.ts';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** User-facing validation error — safe to send to the client. Anything else is logged server-side only. */
export class ValidationError extends Error {}

export const MAX_PRICE_CENTS = 100_000_000; // $1,000,000.00 max
export const MAX_LINEAR_FEET = 1_000_000;
export const MAX_QUOTE_ITEMS = 200;

export function paramAsString(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

export function parsePositiveInt(raw: unknown): number | null {
  const str = Array.isArray(raw) ? raw[0] : raw;
  const n = typeof str === 'number' ? str : Number(str);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function normalizeHex(raw: unknown): string | null {
  return normalizeHexStrict(raw);
}

export function parseCents(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= MAX_PRICE_CENTS) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      const rounded = Math.round(n);
      if (rounded <= MAX_PRICE_CENTS) return rounded;
    }
  }
  return null;
}

export function parseIsoDate(raw: unknown): string {
  const today = new Date().toISOString().slice(0, 10);
  if (typeof raw !== 'string') return today;
  const trimmed = raw.trim();
  if (!ISO_DATE_REGEX.test(trimmed)) {
    throw new ValidationError('Quote date must be in YYYY-MM-DD format.');
  }
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new ValidationError('Invalid calendar date.');
  }
  return trimmed;
}

export function parseOptionalCustomerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 120) : null;
}

export interface ValidatedQuoteLine {
  source_product_id: number;
  source_color_id: number;
  product_name: string;
  product_image_path: string | null;
  material_type: string | null;
  width_in: number | null;
  gauge: string | null;
  length_ft: number | null;
  color_name: string;
  color_hex: string;
  product_price_per_lf_cents: number;
  color_price_per_lf_cents: number;
  combined_price_per_lf_cents: number;
  linear_feet: number;
  additional_costs_cents: number;
  additional_costs_description: string | null;
  line_total_cents: number;
}

export function validateAndBuildQuoteLines(
  rawItemsInput: unknown,
  options: { requireAvailable: boolean }
): { items: ValidatedQuoteLine[]; totalCents: number } {
  const rawItems = Array.isArray(rawItemsInput) ? rawItemsInput : [];
  if (rawItems.length === 0) {
    throw new ValidationError('Add at least one complete product line.');
  }
  if (rawItems.length > MAX_QUOTE_ITEMS) {
    throw new ValidationError(`A single quote cannot exceed ${MAX_QUOTE_ITEMS} line items.`);
  }

  const db = getDb();
  const getProd = db.prepare('SELECT * FROM metal_products WHERE id = ?');
  const getColor = db.prepare('SELECT * FROM metal_colors WHERE id = ?');

  const items: ValidatedQuoteLine[] = [];
  let totalCents = 0;

  for (const row of rawItems) {
    const item = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    const productId = parsePositiveInt(item.product_id);
    const colorId = parsePositiveInt(item.color_id);
    if (!productId || !colorId) {
      throw new ValidationError('Every quote line must have both a product and a color selected.');
    }

    const lf = Number(item.linear_feet);
    if (!Number.isFinite(lf) || lf <= 0 || lf > MAX_LINEAR_FEET) {
      throw new ValidationError(`Every quote line must have Linear Feet between 0 and ${MAX_LINEAR_FEET}.`);
    }

    let additionalCostsCents = 0;
    if (
      item.additional_costs_cents !== undefined &&
      item.additional_costs_cents !== null &&
      item.additional_costs_cents !== ''
    ) {
      const parsedAdd = parseCents(item.additional_costs_cents);
      if (parsedAdd === null) {
        throw new ValidationError('Additional Costs must be a valid non-negative amount.');
      }
      additionalCostsCents = parsedAdd;
    }

    const additionalCostsDescription =
      typeof item.additional_costs_description === 'string' &&
      item.additional_costs_description.trim()
        ? item.additional_costs_description.trim().slice(0, 200)
        : null;

    const product = getProd.get(productId) as MetalProductRow | undefined;
    const color = getColor.get(colorId) as MetalColorRow | undefined;

    if (!product || (options.requireAvailable && !product.is_available)) {
      throw new ValidationError('One or more selected products are unavailable or deleted.');
    }
    if (!color || (options.requireAvailable && !color.is_available)) {
      throw new ValidationError('One or more selected colors are unavailable or deleted.');
    }

    // Material type: comma-separated list on the product; selection must be one of them.
    // Required when the product defines material types, optional otherwise (legacy products).
    const availableMaterials = (product.material_type ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    const rawMaterialType =
      typeof item.material_type === 'string' ? item.material_type.trim().slice(0, 200) : '';
    let materialType: string | null = rawMaterialType || null;
    if (availableMaterials.length > 0) {
      if (!materialType) {
        throw new ValidationError(`Every quote line for "${product.name}" must have a Material Type selected.`);
      }
      if (!availableMaterials.includes(materialType)) {
        throw new ValidationError(
          `Material Type "${materialType}" is not defined for product "${product.name}".`
        );
      }
    } else if (materialType) {
      // Product has no materials defined — ignore any stale selection.
      materialType = null;
    }

    // Measures (optional): Width (in), Gauge (ga), Length (ft)
    let widthIn: number | null = null;
    if (item.width_in !== undefined && item.width_in !== null && item.width_in !== '') {
      const w = Number(item.width_in);
      if (!Number.isFinite(w) || w <= 0 || w > MAX_LINEAR_FEET) {
        throw new ValidationError('Width (in) must be a positive number.');
      }
      widthIn = w;
    }
    let lengthFt: number | null = null;
    if (item.length_ft !== undefined && item.length_ft !== null && item.length_ft !== '') {
      const l = Number(item.length_ft);
      if (!Number.isFinite(l) || l <= 0 || l > MAX_LINEAR_FEET) {
        throw new ValidationError('Length (ft) must be a positive number.');
      }
      lengthFt = l;
    }
    const gauge =
      typeof item.gauge === 'string' && item.gauge.trim() ? item.gauge.trim().slice(0, 20) : null;

    const combinedCents = product.price_per_lf_cents + color.price_per_lf_cents;
    const lineTotalCents = Math.round(lf * combinedCents) + additionalCostsCents;
    totalCents += lineTotalCents;

    items.push({
      source_product_id: product.id,
      source_color_id: color.id,
      product_name: product.name,
      product_image_path: product.image_path,
      material_type: materialType,
      width_in: widthIn,
      gauge,
      length_ft: lengthFt,
      color_name: color.name,
      color_hex: color.hex_code,
      product_price_per_lf_cents: product.price_per_lf_cents,
      color_price_per_lf_cents: color.price_per_lf_cents,
      combined_price_per_lf_cents: combinedCents,
      linear_feet: lf,
      additional_costs_cents: additionalCostsCents,
      additional_costs_description: additionalCostsDescription,
      line_total_cents: lineTotalCents,
    });
  }

  return { items, totalCents };
}

export function sendBufferDownload(
  res: Response,
  contentType: string,
  filename: string,
  buf: Buffer
): void {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.send(buf);
}
