import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMaterialsByProductId, initSchema } from './db.ts';
import { parseMaterialsInput, replaceProductMaterials } from './materials.ts';

// Every test runs against a throwaway data directory: a real SQLite file in tmp,
// dropped afterwards, so saving is exercised through the same statements production uses.
let dataDir: string;
let db: Database.Database;
let productId: number;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adelco-materials-'));
  db = new Database(path.join(dataDir, 'adelco.db'));
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const info = db
    .prepare(
      'INSERT INTO metal_products (name, image_path, price_per_lf_cents, is_available, sort_order, created_at) VALUES (?, NULL, ?, 1, 0, ?)'
    )
    .run('Fascia', 1200, new Date().toISOString());
  productId = Number(info.lastInsertRowid);
});

afterEach(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Saves the given Material Types the way the product endpoints do, then reads them back. */
function savedMaterials(raw: unknown) {
  const parsed = parseMaterialsInput(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  replaceProductMaterials(db, productId, parsed.materials);
  return getMaterialsByProductId(db).get(productId) ?? [];
}

const aluminumWithTwoSizes = [
  {
    name: 'Aluminum',
    sizes: [
      { gauge: '26', width_in: 5, length_ft: 5, price_per_lf_cents: 500 },
      { gauge: '26', width_in: 5, length_ft: 10, price_per_lf_cents: 700 },
    ],
  },
];

describe('parseMaterialsInput', () => {
  it("takes the Material Type's Price from its first Size when it has Sizes", () => {
    const parsed = parseMaterialsInput(aluminumWithTwoSizes);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.materials).toHaveLength(1);
    expect(parsed.materials[0].priceCents).toBe(500);
    expect(parsed.materials[0].sizes.map((s) => s.priceCents)).toEqual([500, 700]);
  });

  it('requires a Price on a Material Type that has no Sizes', () => {
    const parsed = parseMaterialsInput([{ name: 'Wood', sizes: [] }]);

    expect(parsed).toEqual({
      ok: false,
      error: 'Material type "Wood" needs a valid non-negative price per linear ft.',
    });
  });

  it('requires at least one Dimension on every Size, so two Sizes stay distinguishable', () => {
    const parsed = parseMaterialsInput([
      { name: 'Aluminum', sizes: [{ price_per_lf_cents: 500 }] },
    ]);

    expect(parsed).toEqual({
      ok: false,
      error: `Size #1 of "Aluminum" needs at least one of gauge, width, or length.`,
    });
  });

  it('rejects two Sizes of one Material Type whose rendered labels match, ignoring case', () => {
    const parsed = parseMaterialsInput([
      {
        name: 'Aluminum',
        sizes: [
          { gauge: '11 Gauge', width_in: 5, price_per_lf_cents: 500 },
          { gauge: '11 gauge', width_in: 5, price_per_lf_cents: 700 },
        ],
      },
    ]);

    expect(parsed).toEqual({
      ok: false,
      error: `Duplicate size "11 gauge 5"" for material type "Aluminum".`,
    });
  });

  it('rejects two Material Types sharing a name', () => {
    const parsed = parseMaterialsInput([
      { name: 'Aluminum', price_per_lf_cents: 500 },
      { name: 'aluminum', price_per_lf_cents: 700 },
    ]);

    expect(parsed).toEqual({ ok: false, error: 'Duplicate material type "aluminum".' });
  });
});

describe('replaceProductMaterials', () => {
  it('saves several Sizes under one Material Type and reopens them in creation order', () => {
    const [aluminum] = savedMaterials(aluminumWithTwoSizes);

    expect(aluminum.name).toBe('Aluminum');
    expect(aluminum.price_per_lf_cents).toBe(500);
    expect(
      aluminum.sizes.map((s) => ({
        gauge: s.gauge,
        width_in: s.width_in,
        length_ft: s.length_ft,
        price_per_lf_cents: s.price_per_lf_cents,
      }))
    ).toEqual([
      { gauge: '26', width_in: 5, length_ft: 5, price_per_lf_cents: 500 },
      { gauge: '26', width_in: 5, length_ft: 10, price_per_lf_cents: 700 },
    ]);
  });

  it("keeps the first Size's mirrored Price when every Size is removed, so the Type stays sellable", () => {
    const [aluminumWithPrices] = savedMaterials(aluminumWithTwoSizes);

    // The editor mirrors the first Size's Price into the general Price field, so
    // removing every Size submits that Price rather than an empty one.
    const [aluminum] = savedMaterials([
      { name: 'Aluminum', price_per_lf_cents: aluminumWithPrices.price_per_lf_cents },
    ]);

    expect(aluminum.sizes).toHaveLength(0);
    expect(aluminum.price_per_lf_cents).toBe(500);
  });

  it('replaces the saved Sizes on re-save instead of appending to them', () => {
    savedMaterials(aluminumWithTwoSizes);

    const [aluminum] = savedMaterials([
      { name: 'Aluminum', sizes: [{ width_in: 5, length_ft: 10, price_per_lf_cents: 700 }] },
    ]);

    expect(aluminum.sizes).toHaveLength(1);
    expect(aluminum.sizes[0].length_ft).toBe(10);
    const sizeRows = db.prepare('SELECT COUNT(*) AS cnt FROM product_material_sizes').get() as {
      cnt: number;
    };
    expect(sizeRows.cnt).toBe(1);
  });
});
