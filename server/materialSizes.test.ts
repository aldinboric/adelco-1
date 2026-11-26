import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getMaterialsByProductId,
  initSchema,
  MATERIAL_SIZES_MIGRATED_KEY,
  migrateMaterialSizes,
} from './db.ts';

// Every test runs against a throwaway data directory: a real SQLite file in tmp,
// dropped afterwards, so the migrations see genuine tables instead of mocks.
let dataDir: string;
let db: Database.Database;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adelco-sizes-'));
  db = new Database(path.join(dataDir, 'adelco.db'));
  db.pragma('foreign_keys = ON');
  initSchema(db);
  // initSchema runs the migration on the empty database; rearm it for the seeded rows.
  rearmMigration();
});

afterEach(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function rearmMigration(): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(MATERIAL_SIZES_MIGRATED_KEY);
}

function insertProduct(name: string, pricePerLfCents: number): number {
  const info = db
    .prepare(
      'INSERT INTO metal_products (name, image_path, price_per_lf_cents, is_available, sort_order, created_at) VALUES (?, NULL, ?, 1, 0, ?)'
    )
    .run(name, pricePerLfCents, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

function insertMaterial(
  productId: number,
  name: string,
  pricePerLfCents: number,
  dimensions: { width_in?: number | null; gauge?: string | null; length_ft?: number | null } = {},
  sortOrder = 0
): number {
  const info = db
    .prepare(
      `INSERT INTO product_materials (product_id, name, price_per_lf_cents, width_in, gauge, length_ft, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      productId,
      name,
      pricePerLfCents,
      dimensions.width_in ?? null,
      dimensions.gauge ?? null,
      dimensions.length_ft ?? null,
      sortOrder,
      new Date().toISOString()
    );
  return Number(info.lastInsertRowid);
}

describe('migrateMaterialSizes', () => {
  it("turns a material row's recorded Dimensions into one Size and keeps its Price", () => {
    const productId = insertProduct('Fascia', 1200);
    insertMaterial(productId, 'Aluminum', 500, { width_in: 5, length_ft: 5 });

    migrateMaterialSizes(db);

    const [material] = getMaterialsByProductId(db).get(productId) ?? [];
    expect(material.name).toBe('Aluminum');
    expect(material.sizes).toHaveLength(1);
    expect(material.sizes[0]).toMatchObject({
      price_per_lf_cents: 500,
      width_in: 5,
      length_ft: 5,
      gauge: null,
    });
  });

  it('merges material rows that share a name into one Material Type, one Size per row', () => {
    const productId = insertProduct('Fascia', 1200);
    insertMaterial(productId, 'Aluminum', 500, { gauge: '26', width_in: 5, length_ft: 5 }, 0);
    insertMaterial(productId, 'aluminum', 700, { gauge: '26', width_in: 5, length_ft: 10 }, 1);
    insertMaterial(productId, 'Wood', 900, {}, 2);

    migrateMaterialSizes(db);

    const materials = getMaterialsByProductId(db).get(productId) ?? [];
    expect(materials.map((m) => m.name)).toEqual(['Aluminum', 'Wood']);

    const [aluminum, wood] = materials;
    expect(aluminum.sizes.map((s) => s.price_per_lf_cents)).toEqual([500, 700]);
    expect(aluminum.sizes.map((s) => s.length_ft)).toEqual([5, 10]);
    // The Type's own Price mirrors its first Size, so removing every Size leaves a usable Price.
    expect(aluminum.price_per_lf_cents).toBe(500);

    expect(wood.sizes).toHaveLength(0);
    expect(wood.price_per_lf_cents).toBe(900);
  });

  it("keeps each merged row's Price, leaving the surviving Type its own", () => {
    const productId = insertProduct('Fascia', 1200);
    // The first row records no Dimensions, so it survives as the Type at its own Price;
    // the same-name row below becomes a Size and keeps its Price there.
    insertMaterial(productId, 'Aluminum', 900, {}, 0);
    insertMaterial(productId, 'Aluminum', 700, { width_in: 5, length_ft: 10 }, 1);

    migrateMaterialSizes(db);

    const materials = getMaterialsByProductId(db).get(productId) ?? [];
    expect(materials).toHaveLength(1);
    expect(materials[0].price_per_lf_cents).toBe(900);
    expect(materials[0].sizes.map((s) => s.price_per_lf_cents)).toEqual([700]);
  });

  it('leaves the legacy tables and columns untouched', () => {
    const productId = insertProduct('Fascia', 1200);
    const materialId = insertMaterial(productId, 'Aluminum', 500, { width_in: 5, length_ft: 5 });
    insertMaterial(productId, 'Aluminum', 700, { width_in: 5, length_ft: 10 }, 1);
    db.exec(`CREATE TABLE product_material_measures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL,
      width_in REAL,
      gauge TEXT,
      length_ft REAL,
      price_per_lf_cents INTEGER
    )`);
    db.prepare(
      'INSERT INTO product_material_measures (material_id, width_in, gauge, length_ft, price_per_lf_cents) VALUES (?, 5, NULL, 5, 500)'
    ).run(materialId);

    migrateMaterialSizes(db);

    const leftover = db
      .prepare('SELECT COUNT(*) AS cnt FROM product_material_measures')
      .get() as { cnt: number };
    expect(leftover.cnt).toBe(1);
    // The surviving row keeps every legacy column value it was written with.
    const material = db
      .prepare('SELECT name, price_per_lf_cents, width_in, gauge, length_ft FROM product_materials WHERE id = ?')
      .get(materialId);
    expect(material).toEqual({
      name: 'Aluminum',
      price_per_lf_cents: 500,
      width_in: 5,
      gauge: null,
      length_ft: 5,
    });
    const product = db
      .prepare('SELECT name, price_per_lf_cents, is_available FROM metal_products WHERE id = ?')
      .get(productId);
    expect(product).toEqual({ name: 'Fascia', price_per_lf_cents: 1200, is_available: 1 });
  });

  it('runs once, so re-saving a Material Type never resurrects a deleted Size', () => {
    const productId = insertProduct('Fascia', 1200);
    insertMaterial(productId, 'Aluminum', 500, { width_in: 5, length_ft: 5 });

    migrateMaterialSizes(db);
    migrateMaterialSizes(db);

    const [material] = getMaterialsByProductId(db).get(productId) ?? [];
    expect(material.sizes).toHaveLength(1);
  });
});
