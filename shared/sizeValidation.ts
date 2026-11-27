// The one rule for validating a Size, shared by the catalog editor and the in-quote
// "add size" form (src/) and by the server's product and size endpoints (server/),
// so every side refuses bad input with the same wording.

import { formatSizeLabel, type SizeDimensions } from './size.ts';

/** Sanity ceiling for one Dimension's value. */
export const MAX_DIMENSION_VALUE = 1_000_000;

/**
 * One Dimension value as submitted (number or numeric string): null when absent or
 * blank, 'invalid' when not a positive number within the ceiling.
 */
export function parseDimensionValue(raw: unknown): number | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_DIMENSION_VALUE) return 'invalid';
  return n;
}

/** The duplicate-Size message, shared by the product editor path and the in-quote add. */
export function duplicateSizeError(rendered: string, materialName: string): string {
  return `Duplicate size "${rendered}" for material type "${materialName}".`;
}

/** A Size as the product endpoints receive it: its Dimensions plus its own Price. */
export interface SizePayload extends SizeDimensions {
  price_per_lf_cents: number;
}

/** A validated Size: the payload plus the rendered label duplicate detection compares. */
export interface ValidatedSize extends SizePayload {
  /** The rendered label (e.g. `26 ga 5" x 5'`). */
  rendered: string;
}

export interface SizeValidationInput {
  /** The Material Type the Size belongs to; used in the messages. */
  materialName: string;
  /** The Size's 1-based position within the Material Type; used in the messages. */
  sizeNumber: number;
  /**
   * The submitted Price in cents, or null when absent or unparseable — each caller
   * parses its own input format (form dollars string, JSON cents) into cents.
   */
  priceCents: number | null;
  /** The submitted Dimensions, raw — numbers or numeric strings, the gauge a string. */
  dimensions: { gauge?: unknown; width_in?: unknown; length_ft?: unknown };
  /**
   * The rendered labels already claimed in this Material Type. When given, a label
   * already claimed is refused (case-insensitively) and a new label is claimed.
   */
  seenLabels?: Set<string>;
}

/**
 * Validates one Size: a valid non-negative Price, each Dimension a positive number
 * within MAX_DIMENSION_VALUE, and at least one Dimension so two Sizes of one Material
 * Type can never be indistinguishable. The validated Size comes back with its rendered
 * label, so callers can run the duplicate check against stored Sizes the same way.
 */
export function validateSize(
  input: SizeValidationInput
): { ok: true; size: ValidatedSize } | { ok: false; error: string } {
  const label = `Size #${input.sizeNumber} of "${input.materialName}"`;
  const { priceCents, dimensions } = input;
  if (priceCents === null) {
    return { ok: false, error: `${label} needs a valid non-negative price per linear ft.` };
  }
  const widthIn = parseDimensionValue(dimensions.width_in);
  if (widthIn === 'invalid') {
    return { ok: false, error: `Width (in) for ${label} must be a positive number.` };
  }
  const lengthFt = parseDimensionValue(dimensions.length_ft);
  if (lengthFt === 'invalid') {
    return { ok: false, error: `Length (ft) for ${label} must be a positive number.` };
  }
  const gaugeText = typeof dimensions.gauge === 'string' ? dimensions.gauge.trim() : '';
  const gauge = gaugeText ? gaugeText.slice(0, 20) : null;

  // At least one Dimension, so two Sizes of one Material Type can never be indistinguishable.
  const rendered = formatSizeLabel({ gauge, width_in: widthIn, length_ft: lengthFt });
  if (!rendered) {
    return { ok: false, error: `${label} needs at least one of gauge, width, or length.` };
  }
  if (input.seenLabels) {
    const labelKey = rendered.toLowerCase();
    if (input.seenLabels.has(labelKey)) {
      return { ok: false, error: duplicateSizeError(rendered, input.materialName) };
    }
    input.seenLabels.add(labelKey);
  }

  return {
    ok: true,
    size: { price_per_lf_cents: priceCents, width_in: widthIn, gauge, length_ft: lengthFt, rendered },
  };
}
