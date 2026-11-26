import { describe, expect, it } from 'vitest';
import { findSizeByDimensions, formatSizeLabel, resolveCopiedSize, resolvePricePerLfCents } from './size.ts';

describe('formatSizeLabel', () => {
  it('renders gauge, width, and length as one Size label', () => {
    expect(formatSizeLabel({ gauge: '26', width_in: 5, length_ft: 5 })).toBe(`26 ga 5" x 5'`);
  });

  it('omits the Dimensions a Size does not record', () => {
    expect(formatSizeLabel({ width_in: 5, length_ft: 10 })).toBe(`5" x 10'`);
    expect(formatSizeLabel({ gauge: '26' })).toBe('26 ga');
    expect(formatSizeLabel({ length_ft: 10 })).toBe(`10'`);
  });

  it('suffixes only a bare numeric gauge, passing other gauge text through untouched', () => {
    expect(formatSizeLabel({ gauge: '11 Gauge', width_in: 5 })).toBe('11 Gauge 5"');
    expect(formatSizeLabel({ gauge: '26 ga.', width_in: 5 })).toBe('26 ga. 5"');
  });

  it('has no label when the Size records no Dimensions', () => {
    expect(formatSizeLabel({})).toBeNull();
    expect(formatSizeLabel({ gauge: '  ', width_in: null, length_ft: null })).toBeNull();
  });
});

describe('resolvePricePerLfCents', () => {
  const product = { price_per_lf_cents: 1000 };
  const materialType = { price_per_lf_cents: 2000 };
  const size = { price_per_lf_cents: 3000 };

  it('prices a Line from the Price of the Size selected on it', () => {
    expect(
      resolvePricePerLfCents({ size, materialType, product, materialTypes: [materialType] })
    ).toBe(3000);
  });

  it("falls back to the Material Type's Price when its Sizes carry none", () => {
    expect(
      resolvePricePerLfCents({
        size: { price_per_lf_cents: null },
        materialType,
        product,
        materialTypes: [materialType],
      })
    ).toBe(2000);
    expect(
      resolvePricePerLfCents({ materialType, product, materialTypes: [materialType] })
    ).toBe(2000);
  });

  it('falls back to the legacy Product Price only when the Product has no Material Types', () => {
    expect(resolvePricePerLfCents({ product, materialTypes: [] })).toBe(1000);
    expect(resolvePricePerLfCents({ product })).toBe(1000);
  });

  it('never reads the Product Price while the Material Type is still unpicked', () => {
    expect(resolvePricePerLfCents({ product, materialTypes: [materialType] })).toBeNull();
    expect(resolvePricePerLfCents({ size, product, materialTypes: [materialType] })).toBe(3000);
  });

  it('has no Price when the Line selects nothing', () => {
    expect(resolvePricePerLfCents({})).toBeNull();
    expect(
      resolvePricePerLfCents({ product: null, materialType: null, size: null })
    ).toBeNull();
  });
});

describe('findSizeByDimensions', () => {
  const sizes = [
    { id: 1, gauge: '26', width_in: 5, length_ft: 5, price_per_lf_cents: 500 },
    { id: 2, gauge: '26', width_in: 5, length_ft: 10, price_per_lf_cents: 700 },
    { id: 3, gauge: null, width_in: 6, length_ft: null, price_per_lf_cents: 800 },
  ];

  it('finds the Size whose rendered label matches the given Dimensions', () => {
    expect(findSizeByDimensions(sizes, { gauge: '26', width_in: 5, length_ft: 5 })?.id).toBe(1);
    expect(findSizeByDimensions(sizes, { gauge: '26', width_in: 5, length_ft: 10 })?.id).toBe(2);
    expect(findSizeByDimensions(sizes, { width_in: 6 })?.id).toBe(3);
  });

  it('matches a bare numeric gauge against its suffixed label form, case-insensitively', () => {
    expect(findSizeByDimensions([{ id: 9, gauge: '26 GA' }], { gauge: '26' })?.id).toBe(9);
    expect(findSizeByDimensions(sizes, { gauge: '26 Ga', width_in: 5, length_ft: 5 })?.id).toBe(1);
  });

  it('returns null when the Dimensions render no label or no Size matches', () => {
    expect(findSizeByDimensions(sizes, {})).toBeNull();
    expect(findSizeByDimensions(sizes, { gauge: '24', width_in: 5, length_ft: 5 })).toBeNull();
    expect(findSizeByDimensions([], { gauge: '26', width_in: 5, length_ft: 5 })).toBeNull();
  });
});

describe('resolveCopiedSize', () => {
  const materialType = {
    sizes: [
      { id: 1, gauge: '26', width_in: 5, length_ft: 5, price_per_lf_cents: 500 },
      { id: 2, gauge: '26', width_in: 5, length_ft: 10, price_per_lf_cents: 700 },
    ],
  };

  it('re-resolves a copied line to the Size that still exists', () => {
    expect(resolveCopiedSize(materialType, { gauge: '26', width_in: 5, length_ft: 10 })).toEqual({
      size_id: 2,
      sizeIssue: null,
      fallbackSizeLabel: null,
    });
  });

  it('flags the line as deleted when its Size no longer exists, keeping the old label', () => {
    expect(resolveCopiedSize(materialType, { gauge: '24', width_in: 4, length_ft: 8 })).toEqual({
      size_id: null,
      sizeIssue: 'deleted',
      fallbackSizeLabel: '24 ga 4" x 8\'',
    });
  });

  it('needs no Size when the Material Type has none, and flags nothing', () => {
    expect(resolveCopiedSize({ sizes: [] }, { gauge: '26', width_in: 5, length_ft: 5 })).toEqual({
      size_id: null,
      sizeIssue: null,
      fallbackSizeLabel: null,
    });
  });

  it('needs no Size when the copied line recorded no Dimensions at all', () => {
    expect(resolveCopiedSize(materialType, { gauge: null, width_in: null, length_ft: null })).toEqual({
      size_id: null,
      sizeIssue: null,
      fallbackSizeLabel: null,
    });
  });

  it('resolves nothing when the Material Type itself is gone', () => {
    expect(resolveCopiedSize(null, { gauge: '26', width_in: 5, length_ft: 5 })).toEqual({
      size_id: null,
      sizeIssue: null,
      fallbackSizeLabel: null,
    });
  });
});
