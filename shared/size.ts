// The one place that answers what a Line costs per linear foot and how its Size reads.
// Shared by the quote view (src/) and the server's quote validation (server/).

import { formatMeasureDimensions } from './format.ts';

/** Anything that carries a per-linear-foot Price: a Product, a Material Type, or a Size. */
export interface Priced {
  price_per_lf_cents: number | null;
}

/** The three Dimensions of a Size; each is optional, and at least one identifies it. */
export interface SizeDimensions {
  gauge?: string | null;
  width_in?: number | null;
  length_ft?: number | null;
}

const BARE_NUMBER_REGEX = /^\d+(\.\d+)?$/;

function formatGaugePart(gauge: string | null | undefined): string | null {
  const trimmed = gauge?.trim();
  if (!trimmed) return null;
  return BARE_NUMBER_REGEX.test(trimmed) ? `${trimmed} ga` : trimmed;
}

/** `26 ga 5" x 5'` — missing Dimensions are omitted, and a bare numeric gauge gains "ga". */
export function formatSizeLabel(size: SizeDimensions): string | null {
  const parts = [
    formatGaugePart(size.gauge),
    formatMeasureDimensions(size.width_in, size.length_ft),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** What a Line has selected to price itself from. */
export interface LinePriceSources {
  /** The Size selected on the Line, when its Material Type has any. */
  size?: Priced | null;
  /** The Material Type selected on the Line. */
  materialType?: Priced | null;
  /** The Product the Line is drawn from. */
  product?: Priced | null;
  /** The Material Types that Product defines; any of them makes the Product's own Price legacy-only. */
  materialTypes?: readonly Priced[] | null;
}

function priceOf(source: Priced | null | undefined): number | null {
  const cents = source?.price_per_lf_cents;
  return typeof cents === 'number' && Number.isFinite(cents) ? cents : null;
}

/**
 * The per-linear-foot Price of a Line: the selected Size's, else its Material Type's,
 * else — for a Product with no Material Types — the legacy Product Price.
 * Null while the Line has nothing to price itself from.
 */
export function resolvePricePerLfCents(line: LinePriceSources): number | null {
  const fromSize = priceOf(line.size);
  if (fromSize !== null) return fromSize;

  const fromMaterialType = priceOf(line.materialType);
  if (fromMaterialType !== null) return fromMaterialType;

  // A Product's own Price is legacy-only: it survives for rows that predate Material Types.
  const hasMaterialTypes = (line.materialTypes?.length ?? 0) > 0;
  return hasMaterialTypes ? null : priceOf(line.product);
}
