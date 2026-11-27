import { describe, expect, it } from 'vitest';
import {
  MAX_DIMENSION_VALUE,
  duplicateSizeError,
  validateSize,
  type SizeValidationInput,
} from './sizeValidation.ts';

/** A validation input with the given overrides, the way a client or the server builds one. */
function input(overrides: Partial<SizeValidationInput> = {}): SizeValidationInput {
  return {
    materialName: 'Aluminum',
    sizeNumber: 1,
    priceCents: 500,
    dimensions: { width_in: '5', length_ft: '5' },
    ...overrides,
  };
}

/** The rendered labels a Material Type already has, keyed the way the duplicate check keys them. */
function labelsOf(...labels: (string | null)[]): Set<string> {
  return new Set(labels.filter((l): l is string => Boolean(l)).map((l) => l.toLowerCase()));
}

describe('validateSize (one rule shared by the catalog editor, the in-quote add-size form, and the server)', () => {
  it('requires a valid non-negative price', () => {
    const result = validateSize(input({ sizeNumber: 3, priceCents: null, dimensions: { width_in: '5' } }));

    expect(result).toEqual({
      ok: false,
      error: 'Size #3 of "Aluminum" needs a valid non-negative price per linear ft.',
    });
  });

  it('rejects a non-positive width', () => {
    const result = validateSize(input({ dimensions: { width_in: '-2' } }));

    expect(result).toEqual({
      ok: false,
      error: 'Width (in) for Size #1 of "Aluminum" must be a positive number.',
    });
  });

  it('rejects a width beyond the sanity ceiling', () => {
    const result = validateSize(input({ dimensions: { width_in: String(MAX_DIMENSION_VALUE + 1) } }));

    expect(result).toEqual({
      ok: false,
      error: 'Width (in) for Size #1 of "Aluminum" must be a positive number.',
    });
  });

  it('rejects a non-positive length', () => {
    const result = validateSize(input({ sizeNumber: 2, dimensions: { length_ft: '0' } }));

    expect(result).toEqual({
      ok: false,
      error: 'Length (ft) for Size #2 of "Aluminum" must be a positive number.',
    });
  });

  it('treats an absent or blank Dimension as not entered', () => {
    const result = validateSize(
      input({ dimensions: { width_in: '', length_ft: '   ', gauge: '26' } })
    );

    expect(result).toEqual({
      ok: true,
      size: { price_per_lf_cents: 500, width_in: null, gauge: '26', length_ft: null, rendered: '26 ga' },
    });
  });

  it('requires at least one Dimension', () => {
    const result = validateSize(input({ dimensions: {} }));

    expect(result).toEqual({
      ok: false,
      error: 'Size #1 of "Aluminum" needs at least one of gauge, width, or length.',
    });
  });

  it('refuses a label already claimed, with the shared duplicate message', () => {
    const seenLabels = labelsOf('26 ga 5" x 10\'');
    const result = validateSize(
      input({
        sizeNumber: 3,
        priceCents: 900,
        dimensions: { gauge: '26', width_in: '5', length_ft: '10' },
        seenLabels,
      })
    );

    expect(result).toEqual({
      ok: false,
      error: duplicateSizeError('26 ga 5" x 10\'', 'Aluminum'),
    });
    expect(result).toEqual({
      ok: false,
      error: `Duplicate size "26 ga 5" x 10'" for material type "Aluminum".`,
    });
  });

  it('compares duplicate labels case-insensitively', () => {
    const seenLabels = labelsOf('26 ga 5" x 10\'');
    const result = validateSize(
      input({
        sizeNumber: 3,
        priceCents: 900,
        dimensions: { gauge: '26 GA', width_in: '5', length_ft: '10' },
        seenLabels,
      })
    );

    expect(result).toEqual({
      ok: false,
      error: `Duplicate size "26 GA 5" x 10'" for material type "Aluminum".`,
    });
  });

  it('trims and truncates the gauge', () => {
    const result = validateSize(
      input({ priceCents: 950, dimensions: { gauge: '  26  ', length_ft: '12' } })
    );

    expect(result).toEqual({
      ok: true,
      size: { price_per_lf_cents: 950, width_in: null, gauge: '26', length_ft: 12, rendered: `26 ga 12'` },
    });
  });

  it('accepts distinct Sizes sharing one seen-label set and claims each new label', () => {
    const seenLabels = new Set<string>();
    const first = validateSize(
      input({ sizeNumber: 1, priceCents: 500, dimensions: { width_in: '5', length_ft: '5' }, seenLabels })
    );
    const second = validateSize(
      input({ sizeNumber: 2, priceCents: 700, dimensions: { width_in: '5', length_ft: '10' }, seenLabels })
    );
    const duplicate = validateSize(
      input({ sizeNumber: 3, priceCents: 900, dimensions: { width_in: '5', length_ft: '5' }, seenLabels })
    );

    expect(first).toEqual({
      ok: true,
      size: { price_per_lf_cents: 500, width_in: 5, gauge: null, length_ft: 5, rendered: `5" x 5'` },
    });
    expect(second).toEqual({
      ok: true,
      size: { price_per_lf_cents: 700, width_in: 5, gauge: null, length_ft: 10, rendered: `5" x 10'` },
    });
    expect(duplicate).toEqual({
      ok: false,
      error: `Duplicate size "5" x 5'" for material type "Aluminum".`,
    });
  });
});
