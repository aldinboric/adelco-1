// Validation of one Size row, shared by the catalog editor (MetalProductsView) and the
// in-quote "add size" form (CustomerQuoteView), so both refuse bad input with the exact
// wording the server's parseSizeInput uses.

import { dollarsInputToCents } from '../../shared/format.ts';
import { formatSizeLabel, type SizeDimensions } from '../../shared/size.ts';

/** A Size as the product endpoints receive it. */
export interface SizePayload extends SizeDimensions {
  price_per_lf_cents: number;
}

/** The editable fields of one Size row. */
export interface SizeFormInput {
  price: string;
  width: string;
  gauge: string;
  length: string;
}

// Same sanity ceiling the server applies to a Dimension's value.
export const MAX_DIMENSION_VALUE = 1_000_000;

/**
 * Validates one Size row exactly as the catalog editor does. `sizeNumber` is the row's
 * 1-based position within the Material Type, and `seenLabels` collects the rendered labels
 * already claimed (the Type's existing Sizes plus earlier rows) for the duplicate check.
 */
export function validateSizeRow(
  materialName: string,
  sizeNumber: number,
  row: SizeFormInput,
  seenLabels: Set<string>
): { ok: true; size: SizePayload } | { ok: false; error: string } {
  const label = `Size #${sizeNumber} of "${materialName}"`;
  const priceCents = dollarsInputToCents(row.price);
  if (priceCents === null) {
    return { ok: false, error: `${label} needs a valid non-negative price per linear ft.` };
  }
  let widthIn: number | null = null;
  if (row.width.trim()) {
    const w = Number(row.width.trim());
    if (!Number.isFinite(w) || w <= 0 || w > MAX_DIMENSION_VALUE) {
      return { ok: false, error: `Width (in) for ${label} must be a positive number.` };
    }
    widthIn = w;
  }
  let lengthFt: number | null = null;
  if (row.length.trim()) {
    const l = Number(row.length.trim());
    if (!Number.isFinite(l) || l <= 0 || l > MAX_DIMENSION_VALUE) {
      return { ok: false, error: `Length (ft) for ${label} must be a positive number.` };
    }
    lengthFt = l;
  }
  const gauge = row.gauge.trim() ? row.gauge.trim().slice(0, 20) : null;

  const rendered = formatSizeLabel({ gauge, width_in: widthIn, length_ft: lengthFt });
  if (!rendered) {
    return {
      ok: false,
      error: `${label} needs at least one of gauge, width, or length.`,
    };
  }
  const labelKey = rendered.toLowerCase();
  if (seenLabels.has(labelKey)) {
    return {
      ok: false,
      error: `Duplicate size "${rendered}" for material type "${materialName}".`,
    };
  }
  seenLabels.add(labelKey);

  return { ok: true, size: { price_per_lf_cents: priceCents, width_in: widthIn, gauge, length_ft: lengthFt } };
}
