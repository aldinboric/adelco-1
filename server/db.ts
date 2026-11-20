import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

export const DATA_DIR = process.env.ADELCO_DATA_DIR?.trim()
  ? path.resolve(process.env.ADELCO_DATA_DIR.trim())
  : path.resolve(process.cwd(), 'data');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
export const PRODUCT_IMAGES_DIR = path.join(IMAGES_DIR, 'products');
export const QUOTE_IMAGES_DIR = path.join(IMAGES_DIR, 'quotes');
export const DB_PATH = path.join(DATA_DIR, 'adelco.db');

export interface MetalColorRow {
  id: number;
  name: string;
  hex_code: string;
  price_per_lf_cents: number;
  is_available: number;
  sort_order: number;
  created_at: string;
}

export interface MetalProductRow {
  id: number;
  name: string;
  image_path: string | null;
  material_type: string | null;
  price_per_lf_cents: number;
  is_available: number;
  sort_order: number;
  created_at: string;
}

export interface IssuedQuoteRow {
  id: number;
  quote_number: string;
  quote_date: string;
  customer_name: string | null;
  total_cents: number;
  created_by: string | null;
  created_at: string;
}

export interface IssuedQuoteItemRow {
  id: number;
  quote_id: number;
  source_product_id: number | null;
  source_color_id: number | null;
  product_name: string;
  product_image_path: string | null;
  material_type: string | null;
  width_in: number | null;
  gauge: string | null;
  length_ft: number | null;
  color_name: string;
  color_hex: string;
  product_price_per_lf_cents: number;
  color_price_per_lf_cents: number;
  combined_price_per_lf_cents: number;
  linear_feet: number;
  additional_costs_cents: number;
  additional_costs_description: string | null;
  line_total_cents: number;
}

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: 'admin' | 'user';
  is_active: number;
  must_change_password: number;
  permissions_json: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export function ensureDataDirs(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PRODUCT_IMAGES_DIR, { recursive: true });
  fs.mkdirSync(QUOTE_IMAGES_DIR, { recursive: true });
}

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!dbInstance) {
    ensureDataDirs();
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');
    initSchema(dbInstance);
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function reloadDb(): Database.Database {
  closeDb();
  return getDb();
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metal_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      hex_code TEXT NOT NULL,
      price_per_lf_cents INTEGER NOT NULL CHECK (price_per_lf_cents >= 0),
      is_available INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metal_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      image_path TEXT,
      material_type TEXT,
      price_per_lf_cents INTEGER NOT NULL CHECK (price_per_lf_cents >= 0),
      is_available INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS issued_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_number TEXT UNIQUE NOT NULL,
      quote_date TEXT NOT NULL,
      customer_name TEXT,
      total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS issued_quote_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id INTEGER NOT NULL,
      source_product_id INTEGER,
      source_color_id INTEGER,
      product_name TEXT NOT NULL,
      product_image_path TEXT,
      material_type TEXT,
      width_in REAL,
      gauge TEXT,
      length_ft REAL,
      color_name TEXT NOT NULL,
      color_hex TEXT NOT NULL,
      product_price_per_lf_cents INTEGER NOT NULL,
      color_price_per_lf_cents INTEGER NOT NULL,
      combined_price_per_lf_cents INTEGER NOT NULL,
      linear_feet REAL NOT NULL,
      additional_costs_cents INTEGER NOT NULL DEFAULT 0,
      additional_costs_description TEXT,
      line_total_cents INTEGER NOT NULL,
      FOREIGN KEY (quote_id) REFERENCES issued_quotes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS quote_sequences (
      year INTEGER PRIMARY KEY,
      last_seq INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')) DEFAULT 'user',
      is_active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      permissions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
  `);

  const itemCols = db.prepare('PRAGMA table_info(issued_quote_items)').all() as Array<{ name: string }>;
  if (!itemCols.some((c) => c.name === 'additional_costs_cents')) {
    db.exec('ALTER TABLE issued_quote_items ADD COLUMN additional_costs_cents INTEGER NOT NULL DEFAULT 0;');
  }
  if (!itemCols.some((c) => c.name === 'additional_costs_description')) {
    db.exec('ALTER TABLE issued_quote_items ADD COLUMN additional_costs_description TEXT;');
  }
  if (!itemCols.some((c) => c.name === 'material_type')) {
    db.exec('ALTER TABLE issued_quote_items ADD COLUMN material_type TEXT;');
  }
  if (!itemCols.some((c) => c.name === 'width_in')) {
    db.exec('ALTER TABLE issued_quote_items ADD COLUMN width_in REAL;');
  }
  if (!itemCols.some((c) => c.name === 'gauge')) {
    db.exec('ALTER TABLE issued_quote_items ADD COLUMN gauge TEXT;');
  }
  if (!itemCols.some((c) => c.name === 'length_ft')) {
    db.exec('ALTER TABLE issued_quote_items ADD COLUMN length_ft REAL;');
  }

  // sort_order migrations for drag & drop reordering (backfill preserves id order)
  const colorCols = db.prepare('PRAGMA table_info(metal_colors)').all() as Array<{ name: string }>;
  if (!colorCols.some((c) => c.name === 'sort_order')) {
    db.exec('ALTER TABLE metal_colors ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;');
    db.exec(
      'UPDATE metal_colors SET sort_order = (SELECT COUNT(*) FROM metal_colors AS c2 WHERE c2.id < metal_colors.id);'
    );
  }
  const productCols = db.prepare('PRAGMA table_info(metal_products)').all() as Array<{ name: string }>;
  if (!productCols.some((c) => c.name === 'material_type')) {
    db.exec('ALTER TABLE metal_products ADD COLUMN material_type TEXT;');
  }
  if (!productCols.some((c) => c.name === 'sort_order')) {
    db.exec('ALTER TABLE metal_products ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;');
    db.exec(
      'UPDATE metal_products SET sort_order = (SELECT COUNT(*) FROM metal_products AS p2 WHERE p2.id < metal_products.id);'
    );
  }
}

async function createProfileThumbnail(filename: string, svgMarkup: string): Promise<string> {
  ensureDataDirs();
  const outPath = path.join(PRODUCT_IMAGES_DIR, filename);
  if (!fs.existsSync(outPath)) {
    await sharp(Buffer.from(svgMarkup))
      .resize(128, 128, { fit: 'contain', background: { r: 247, g: 247, b: 247, alpha: 1 } })
      .png()
      .toFile(outPath);
  }
  return `products/${filename}`;
}

export async function seedInitialDataIfEmpty(): Promise<void> {
  const db = getDb();
  const seededRow = db
    .prepare("SELECT value FROM app_settings WHERE key = 'initial_seeded'")
    .get() as { value: string } | undefined;

  if (seededRow?.value === '1') {
    return;
  }

  const colorCount = (db.prepare('SELECT COUNT(*) as cnt FROM metal_colors').get() as { cnt: number }).cnt;
  const productCount = (db.prepare('SELECT COUNT(*) as cnt FROM metal_products').get() as { cnt: number }).cnt;

  if (colorCount === 0 && productCount === 0) {
    const now = new Date().toISOString();

    const insertColor = db.prepare(`
      INSERT INTO metal_colors (name, hex_code, price_per_lf_cents, is_available, created_at)
      VALUES (?, ?, ?, 1, ?)
    `);

    const seedColors: Array<[string, string, number]> = [
      ['AdelCo Cobalt Blue', '#084091', 145],
      ['Forest Pine Green', '#2A6F3B', 145],
      ['Charcoal Slate', '#36414C', 135],
      ['Matte Obsidian Black', '#1B1F23', 155],
      ['Galvalume Silver', '#B8C2CC', 95],
    ];

    for (const [name, hex, cents] of seedColors) {
      insertColor.run(name, hex, cents, now);
    }

    const ribbedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <rect width="128" height="128" fill="#f7f7f7"/>
      <polyline points="8,88 24,88 32,48 48,48 56,88 72,88 80,48 96,48 104,88 120,88" fill="none" stroke="#084091" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>
      <line x1="8" y1="98" x2="120" y2="98" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 4"/>
    </svg>`;

    const seamSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <rect width="128" height="128" fill="#f7f7f7"/>
      <polyline points="10,88 34,88 34,38 42,38 42,88 86,88 86,38 94,38 94,88 118,88" fill="none" stroke="#084091" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>
      <line x1="10" y1="98" x2="118" y2="98" stroke="#2a6f3b" stroke-width="2"/>
    </svg>`;

    const corrugatedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <rect width="128" height="128" fill="#f7f7f7"/>
      <path d="M8,68 Q20,42 32,68 T56,68 T80,68 T104,68 T120,56" fill="none" stroke="#084091" stroke-width="6" stroke-linecap="round"/>
      <line x1="8" y1="92" x2="120" y2="92" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 4"/>
    </svg>`;

    const boardBattenSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <rect width="128" height="128" fill="#f7f7f7"/>
      <polyline points="8,86 22,86 22,46 38,46 38,86 64,86 64,46 80,46 80,86 106,86 106,46 120,46" fill="none" stroke="#2a6f3b" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;

    const p1 = await createProfileThumbnail('seed-ribbed-29ga.png', ribbedSvg);
    const p2 = await createProfileThumbnail('seed-standing-seam.png', seamSvg);
    const p3 = await createProfileThumbnail('seed-corrugated.png', corrugatedSvg);
    const p4 = await createProfileThumbnail('seed-board-batten.png', boardBattenSvg);

    const insertProduct = db.prepare(`
      INSERT INTO metal_products (name, image_path, price_per_lf_cents, is_available, created_at)
      VALUES (?, ?, ?, 1, ?)
    `);

    insertProduct.run('29 Ga Ribbed Roof Panel (36" Coverage)', p1, 425, now);
    insertProduct.run('16" Snap-Lock Standing Seam (26 Ga)', p2, 680, now);
    insertProduct.run('7/8" Structural Corrugated Sheet', p3, 510, now);
    insertProduct.run('12" Board & Batten Vertical Siding', p4, 595, now);
  }

  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('initial_seeded', '1')").run();
}

export function getSetting(key: string, fallback = ''): string {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}

export function getNextQuoteNumber(db: Database.Database, quoteDate: string): string {
  const parsedYear = Number.parseInt(quoteDate.slice(0, 4), 10);
  const year = Number.isFinite(parsedYear) && parsedYear >= 2000 && parsedYear <= 2999
    ? parsedYear
    : new Date().getFullYear();

  const existing = db.prepare('SELECT last_seq FROM quote_sequences WHERE year = ?').get(year) as
    | { last_seq: number }
    | undefined;

  let nextSeq = (existing?.last_seq ?? 0) + 1;

  // Ensure monotonic uniqueness even if quotes exist without sequence row
  const prefixRow = db.prepare("SELECT value FROM app_settings WHERE key = 'quote_prefix'").get() as
    | { value: string }
    | undefined;
  const rawPrefix = (prefixRow?.value ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const prefixPart = rawPrefix ? `${rawPrefix}-` : '';

  let candidate = `${year}-${prefixPart}${String(nextSeq).padStart(4, '0')}`;
  const checkStmt = db.prepare('SELECT 1 FROM issued_quotes WHERE quote_number = ?');
  while (checkStmt.get(candidate)) {
    nextSeq += 1;
    candidate = `${year}-${prefixPart}${String(nextSeq).padStart(4, '0')}`;
  }

  db.prepare('INSERT OR REPLACE INTO quote_sequences (year, last_seq) VALUES (?, ?)').run(year, nextSeq);
  return candidate;
}

export function resolveSafeImagePath(relPath: string | null | undefined): string | null {
  if (!relPath) return null;
  const cleaned = relPath.replace(/^\/+/, '');
  const full = path.resolve(IMAGES_DIR, cleaned);
  if (!full.startsWith(IMAGES_DIR + path.sep)) {
    return null;
  }
  return fs.existsSync(full) ? full : null;
}

export function copyProductImageToQuoteSnapshot(relPath: string | null): string | null {
  const srcFull = resolveSafeImagePath(relPath);
  if (!srcFull) return null;
  ensureDataDirs();
  const ext = path.extname(srcFull) || '.png';
  const snapshotName = `quote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const destFull = path.join(QUOTE_IMAGES_DIR, snapshotName);
  fs.copyFileSync(srcFull, destFull);
  return `quotes/${snapshotName}`;
}

export function removeImageFileIfUnused(relPath: string | null | undefined): void {
  if (!relPath) return;
  const db = getDb();
  const prodRef = db
    .prepare('SELECT 1 FROM metal_products WHERE image_path = ? LIMIT 1')
    .get(relPath);
  const quoteRef = db
    .prepare('SELECT 1 FROM issued_quote_items WHERE product_image_path = ? LIMIT 1')
    .get(relPath);
  if (prodRef || quoteRef) {
    return;
  }

  const full = resolveSafeImagePath(relPath);
  if (full && fs.existsSync(full)) {
    try {
      fs.unlinkSync(full);
    } catch {
      // ignore unlink error
    }
  }
}
