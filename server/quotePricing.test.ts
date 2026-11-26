import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A throwaway data directory: the modules under test read it on first import, and the
// database it holds is opened and dropped like any other deployment's would be.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adelco-quote-'));
process.env.ADELCO_DATA_DIR = dataDir;

let db: import('better-sqlite3').Database;
let validateAndBuildQuoteLines: typeof import('./validation.ts').validateAndBuildQuoteLines;
let closeDb: typeof import('./db.ts').closeDb;
let colorId: number;
let fasciaWithMaterialId: number;
let aluminumMaterialId: number;
let size5x5Id: number;
let size5x10Id: number;
let downpipesWithGeneralPriceId: number;
let panelWithoutMaterialsId: number;

beforeAll(async () => {
  const dbModule = await import('./db.ts');
  const validation = await import('./validation.ts');
  validateAndBuildQuoteLines = validation.validateAndBuildQuoteLines;
  closeDb = dbModule.closeDb;
  db = dbModule.getDb();

  const now = new Date().toISOString();
  colorId = Number(
    db
      .prepare(
        'INSERT INTO metal_colors (name, hex_code, price_per_lf_cents, is_available, sort_order, created_at) VALUES (?, ?, ?, 1, 0, ?)'
      )
      .run('Charcoal', '#333333', 100, now).lastInsertRowid
  );

  // Fascia with an Aluminum Material Type carrying two Sizes at different Prices.
  fasciaWithMaterialId = Number(
    db
      .prepare(
        'INSERT INTO metal_products (name, image_path, price_per_lf_cents, is_available, sort_order, created_at) VALUES (?, NULL, ?, 1, 0, ?)'
      )
      .run('Fascia', 1200, now).lastInsertRowid
  );
  aluminumMaterialId = Number(
    db
      .prepare(
        `INSERT INTO product_materials (product_id, name, price_per_lf_cents, width_in, gauge, length_ft, sort_order, created_at)
         VALUES (?, 'Aluminum', 500, 5, '26', 5, 0, ?)`
      )
      .run(fasciaWithMaterialId, now).lastInsertRowid
  );
  size5x5Id = Number(
    db
      .prepare(
        `INSERT INTO product_material_sizes (material_id, price_per_lf_cents, width_in, gauge, length_ft, sort_order, created_at)
         VALUES (?, 500, 5, '26', 5, 0, ?)`
      )
      .run(aluminumMaterialId, now).lastInsertRowid
  );
  size5x10Id = Number(
    db
      .prepare(
        `INSERT INTO product_material_sizes (material_id, price_per_lf_cents, width_in, gauge, length_ft, sort_order, created_at)
         VALUES (?, 700, 5, '26', 10, 1, ?)`
      )
      .run(aluminumMaterialId, now).lastInsertRowid
  );

  // A Material Type without Sizes quotes at its own general Price.
  downpipesWithGeneralPriceId = Number(
    db
      .prepare(
        'INSERT INTO metal_products (name, image_path, price_per_lf_cents, is_available, sort_order, created_at) VALUES (?, NULL, ?, 1, 1, ?)'
      )
      .run('Downpipes', 0, now).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO product_materials (product_id, name, price_per_lf_cents, sort_order, created_at)
     VALUES (?, 'Metal', 900, 0, ?)`
  ).run(downpipesWithGeneralPriceId, now);

  // A product with no Material Types at all: a Preview, saved but not sellable.
  panelWithoutMaterialsId = Number(
    db
      .prepare(
        'INSERT INTO metal_products (name, image_path, price_per_lf_cents, is_available, sort_order, created_at) VALUES (?, NULL, ?, 1, 2, ?)'
      )
      .run('Ribbed Roof Panel', 425, now).lastInsertRowid
  );
});

afterAll(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function quoteLine(productId: number, extra: Record<string, unknown> = {}) {
  return {
    product_id: productId,
    color_id: colorId,
    linear_feet: 10,
    ...extra,
  };
}

describe('quoting a line with a Size selected', () => {
  it("prices the line from the selected Size's Price and stores its Dimensions on the issued line", () => {
    const { items } = validateAndBuildQuoteLines(
      [quoteLine(fasciaWithMaterialId, { material_type: 'Aluminum', size_id: size5x5Id })],
      { requireAvailable: true }
    );

    expect(items[0].material_type).toBe('Aluminum');
    expect(items[0].product_price_per_lf_cents).toBe(500);
    expect(items[0].width_in).toBe(5);
    expect(items[0].gauge).toBe('26');
    expect(items[0].length_ft).toBe(5);
    expect(items[0].line_total_cents).toBe(6000);
  });

  it("prices a second Size of the same Material Type at that Size's own Price", () => {
    const { items } = validateAndBuildQuoteLines(
      [quoteLine(fasciaWithMaterialId, { material_type: 'Aluminum', size_id: size5x10Id })],
      { requireAvailable: true }
    );

    expect(items[0].product_price_per_lf_cents).toBe(700);
    expect(items[0].length_ft).toBe(10);
    expect(items[0].line_total_cents).toBe(8000);
  });

  it('still resolves the Size price when exporting an unissued Customer Quote', () => {
    const { items } = validateAndBuildQuoteLines(
      [quoteLine(fasciaWithMaterialId, { material_type: 'Aluminum', size_id: size5x10Id })],
      { requireAvailable: false }
    );

    expect(items[0].product_price_per_lf_cents).toBe(700);
  });

  it('refuses a line whose Material Type has Sizes but none is selected', () => {
    expect(() =>
      validateAndBuildQuoteLines(
        [quoteLine(fasciaWithMaterialId, { material_type: 'Aluminum', size_id: null })],
        { requireAvailable: true }
      )
    ).toThrow(/size/i);
  });

  it('refuses a Size that belongs to another Material Type', () => {
    db.prepare(
      `INSERT INTO product_materials (product_id, name, price_per_lf_cents, sort_order, created_at)
       VALUES (?, 'Steel', 600, 1, ?)`
    ).run(fasciaWithMaterialId, new Date().toISOString());
    const steelMaterialId = (
      db.prepare('SELECT id FROM product_materials WHERE product_id = ? AND name = ?').get(fasciaWithMaterialId, 'Steel') as { id: number }
    ).id;
    const foreignSizeId = Number(
      db
        .prepare(
          `INSERT INTO product_material_sizes (material_id, price_per_lf_cents, width_in, gauge, length_ft, sort_order, created_at)
           VALUES (?, 600, 4, '24', 8, 0, ?)`
        )
        .run(steelMaterialId, new Date().toISOString()).lastInsertRowid
    );

    expect(() =>
      validateAndBuildQuoteLines(
        [quoteLine(fasciaWithMaterialId, { material_type: 'Aluminum', size_id: foreignSizeId })],
        { requireAvailable: true }
      )
    ).toThrow(/size/i);
  });
});

describe('quoting a Material Type without Sizes', () => {
  it("prices the line from the Material Type's general Price and records no Dimensions", () => {
    const { items } = validateAndBuildQuoteLines(
      [quoteLine(downpipesWithGeneralPriceId, { material_type: 'Metal', size_id: null })],
      { requireAvailable: true }
    );

    expect(items[0].product_price_per_lf_cents).toBe(900);
    expect(items[0].width_in).toBeNull();
    expect(items[0].gauge).toBeNull();
    expect(items[0].length_ft).toBeNull();
    expect(items[0].line_total_cents).toBe(10000);
  });

  it('refuses a Size picked for a Material Type that has none', () => {
    expect(() =>
      validateAndBuildQuoteLines(
        [quoteLine(downpipesWithGeneralPriceId, { material_type: 'Metal', size_id: size5x5Id })],
        { requireAvailable: true }
      )
    ).toThrow(/no sizes/i);
  });
});

describe('quoting a Preview product', () => {
  it('refuses a Product that has no Material Types', () => {
    expect(() =>
      validateAndBuildQuoteLines([quoteLine(panelWithoutMaterialsId)], { requireAvailable: true })
    ).toThrow(/no material types/i);
  });

  it('refuses it when exporting an unissued Customer Quote, where Unavailable products are allowed', () => {
    expect(() =>
      validateAndBuildQuoteLines([quoteLine(panelWithoutMaterialsId)], { requireAvailable: false })
    ).toThrow(/no material types/i);
  });
});
