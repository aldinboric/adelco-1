import { describe, expect, it } from 'vitest';
import {
  findSizeByDimensions,
  formatMaterialSizeLine,
  formatSizeLabel,
  generalPriceAfterSizeRemoval,
  materialTypePriceCents,
  resolveCopiedSize,
  resolvePricePerLfCents,
} from './size.ts';

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

describe('formatMaterialSizeLine', () => {
  it('prints the Size beside the Material Type in the same line', () => {
    expect(formatMaterialSizeLine('Aluminum', { gauge: '26', width_in: 5, length_ft: 5 })).toBe(
      `Aluminum (26 ga 5" x 5')`
    );
  });

  it('omits missing Dimensions instead of leaving stray punctuation', () => {
    expect(formatMaterialSizeLine('Aluminum', { width_in: 5 })).toBe(`Aluminum (5")`);
    expect(formatMaterialSizeLine('Aluminum', { gauge: '26' })).toBe('Aluminum (26 ga)');
  });

  it('leaves no empty parentheses when the Line records no Size', () => {
    expect(formatMaterialSizeLine('Aluminum', {})).toBe('Aluminum');
    expect(formatMaterialSizeLine('  ', { gauge: null, width_in: null, length_ft: null })).toBeNull();
  });

  it('keeps the Size label alone when the Line records no Material Type', () => {
    expect(formatMaterialSizeLine(null, { gauge: '26', width_in: 5, length_ft: 5 })).toBe(`26 ga 5" x 5'`);
    expect(formatMaterialSizeLine('', { length_ft: 10 })).toBe(`10'`);
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

describe('materialTypePriceCents (ADR-0001: the general Price mirrors the first Size)', () => {
  it("mirrors the first Size's Price while the Material Type has Sizes", () => {
    expect(
      materialTypePriceCents([{ price_per_lf_cents: 500 }, { price_per_lf_cents: 700 }], 900)
    ).toBe(500);
  });

  it("falls back to the Type's own Price when it has no Sizes", () => {
    expect(materialTypePriceCents([], 900)).toBe(900);
    expect(materialTypePriceCents([], null)).toBeNull();
  });

  it('has no mirror when the first Size carries no usable Price', () => {
    expect(materialTypePriceCents([{ price_per_lf_cents: null }], 900)).toBeNull();
    expect(materialTypePriceCents([{ price_per_lf_cents: Number.NaN }], 900)).toBeNull();
  });
});

describe('generalPriceAfterSizeRemoval (story 10: removing every Size keeps the first Size\'s Price)', () => {
  const rows = [
    { key: 'a', price: '5.00' },
    { key: 'b', price: '7.00' },
  ];

  it('keeps the general Price while Sizes remain', () => {
    expect(generalPriceAfterSizeRemoval(rows, rows[1], '5.00')).toBe('5.00');
    expect(generalPriceAfterSizeRemoval(rows, rows[0], '5.00')).toBe('5.00');
  });

  it("falls back to the pre-removal first Size's Price when the last Size is removed and none was set", () => {
    expect(generalPriceAfterSizeRemoval([rows[0]], rows[0], '')).toBe('5.00');
  });

  it('regression: removing Sizes out of order ends at the first Size\'s Price, not the removed one', () => {
    let price = '5.00';
    price = generalPriceAfterSizeRemoval(rows, rows[0], price); // remove the first Size first
    const remaining = rows.filter((r) => r !== rows[0]);
    price = generalPriceAfterSizeRemoval(remaining, remaining[0], price); // then the last
    expect(price).toBe('5.00');
  });

  it('removing Sizes in order lands on the same Price (the case the server test alone covered)', () => {
    let price = '5.00';
    price = generalPriceAfterSizeRemoval(rows, rows[1], price);
    const remaining = rows.filter((r) => r !== rows[1]);
    price = generalPriceAfterSizeRemoval(remaining, remaining[0], price);
    expect(price).toBe('5.00');
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
