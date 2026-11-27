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

/**
 * The detail line under a Line's Product name wherever a quote is printed:
 * the Material Type with the Size's shared label beside it in the same line —
 * `Aluminum (26 ga 5" x 5')`. A Line without a Size keeps only its Material
 * Type (no empty parentheses), one without a Material Type keeps only the Size
 * label, and one with neither has no detail line at all.
 */
export function formatMaterialSizeLine(
  materialType: string | null | undefined,
  size: SizeDimensions
): string | null {
  const material = materialType?.trim() || null;
  const sizeLabel = formatSizeLabel(size);
  if (material && sizeLabel) return `${material} (${sizeLabel})`;
  return material ?? sizeLabel;
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

/** A saved Size: its id plus its Dimensions. */
export interface SavedSize extends SizeDimensions {
  id: number;
}

/**
 * The Size whose rendered label matches the given Dimensions, compared
 * case-insensitively on the label — how a copied Issued Quote line re-resolves the
 * Size it was sold at. Null when the Dimensions render no label or no Size matches.
 */
export function findSizeByDimensions<T extends SizeDimensions>(
  sizes: readonly T[],
  dimensions: SizeDimensions
): T | null {
  const label = formatSizeLabel(dimensions);
  if (!label) return null;
  const key = label.toLowerCase();
  return sizes.find((s) => formatSizeLabel(s)?.toLowerCase() === key) ?? null;
}

/** What a copied Issued Quote line ends up with for its Size. */
export interface CopiedSizeResolution {
  size_id: number | null;
  sizeIssue: 'deleted' | null;
  fallbackSizeLabel: string | null;
}

/** A Line with no Size selected and nothing flagged. */
export function noSizeResolution(): CopiedSizeResolution {
  return { size_id: null, sizeIssue: null, fallbackSizeLabel: null };
}

/**
 * Re-resolves the Size of a copied Issued Quote line against the Material Type's current
 * Sizes: the matching Size where it still exists, otherwise a `deleted` flag carrying the
 * old label so the draft asks for a replacement. A Material Type without Sizes — or a line
 * that recorded no Dimensions — needs no Size and flags nothing.
 */
export function resolveCopiedSize(
  materialType: { sizes: readonly SavedSize[] } | null,
  oldDimensions: SizeDimensions
): CopiedSizeResolution {
  if (!materialType || materialType.sizes.length === 0) return noSizeResolution();
  const oldLabel = formatSizeLabel(oldDimensions);
  if (!oldLabel) return noSizeResolution();
  const match = findSizeByDimensions(materialType.sizes, oldDimensions);
  if (match) return { size_id: match.id, sizeIssue: null, fallbackSizeLabel: null };
  return { size_id: null, sizeIssue: 'deleted', fallbackSizeLabel: oldLabel };
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

/**
 * ADR-0001 — a Material Type's general Price mirrors its first Size's Price while it
 * has Sizes; with no Sizes, `fallbackCents` (the Type's own Price input) applies.
 * Null when neither yields a usable Price.
 */
export function materialTypePriceCents(
  sizes: readonly Priced[],
  fallbackCents: number | null
): number | null {
  return sizes.length > 0 ? priceOf(sizes[0]) : fallbackCents;
}

/**
 * #1 story 10 — the general Price (form string) of a Material Type after one of its Size
 * rows is removed. While Sizes remain the Price is unchanged (the first-Size mirror is
 * re-derived from the remaining Sizes when the Type is rendered or saved). When the last
 * Size is removed, the Price keeps the current general Price — which the editor keeps
 * mirrored to the first Size — falling back to the pre-removal first Size's only when no
 * general Price was ever set, so removing every Size in any order leaves the Type sellable.
 */
export function generalPriceAfterSizeRemoval(
  sizes: readonly { price: string }[],
  removed: { price: string },
  currentGeneralPrice: string
): string {
  const remaining = sizes.filter((s) => s !== removed);
  if (remaining.length > 0) return currentGeneralPrice;
  return currentGeneralPrice.trim() ? currentGeneralPrice : sizes[0]?.price ?? currentGeneralPrice;
}
