import { describe, expect, it } from 'vitest';
import { formatSizeLabel, resolvePricePerLfCents } from './size.ts';

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
