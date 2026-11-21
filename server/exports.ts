import {
  Cell,
  Column,
  Image,
  Row,
  Workbook,
  Worksheet,
  type CellValueInput,
} from 'documonster/excel';
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import {
  formatCAD,
  formatGaugeLabel,
  formatMaterialMeasures,
  formatMeasureDimensions,
} from '../shared/format.ts';
import { hexToArgb, normalizeHexDisplay } from '../shared/hex.ts';
import {
  type IssuedQuoteRow,
  type MetalColorRow,
  type MetalProductWithMaterials,
  resolveSafeImagePath,
} from './db.ts';

const BRAND_BLUE = '#084091';
const BRAND_GREEN = '#2A6F3B';
const NEUTRAL_BG = '#F7F7F7';
const TEXT_DARK = '#0F172A';
const TEXT_MUTED = '#475569';

// ---------------------------------------------------------------------------
// PDF text sanitizing: PDFKit's built-in fonts (Helvetica & co.) use
// WinAnsiEncoding (CP1252), which has NO Croatian diacritics (ć, č, đ ...).
// Unsupported chars get encoded as garbage bytes — e.g. "Aldin Borić (Test)"
// renders as "Aldin Bori<0x10>r<0x02>@est)". Transliterate everything outside
// WinAnsi to a safe base letter (NFD decomposition + strip combining marks),
// keep the CP1252 specials (… – ' ' " š ž ...), and replace the rest with '?'.
// Applied to text/width/height so measuring and rendering always agree.
// ---------------------------------------------------------------------------

/** Unicode chars CP1252 encodes in its 0x80–0x9F range (render correctly as-is). */
const WINANSI_CP1252_SPECIALS = new Set([
  '\u20AC', '\u201A', '\u0192', '\u201E', '\u2026', '\u2020', '\u2021',
  '\u02C6', '\u2030', '\u0160', '\u2039', '\u0152', '\u017D', '\u2018',
  '\u2019', '\u201C', '\u201D', '\u2022', '\u2013', '\u2014', '\u02DC',
  '\u2122', '\u0161', '\u203A', '\u0153', '\u017E', '\u0178',
]);

/** Letters without a canonical NFD decomposition that still need a mapping. */
const PDF_TRANSLITERATE: Record<string, string> = {
  '\u0111': 'd', // d-with-stroke
  '\u0110': 'D', // D-with-stroke
};
export function pdfSafeText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) {
      out += ch; // ASCII always safe
    } else if (code >= 0xa0 && code <= 0xff) {
      out += ch; // printable Latin-1 is identical in WinAnsi
    } else if (WINANSI_CP1252_SPECIALS.has(ch)) {
      out += ch; // CP1252 specials (…, –, quotes, š, ž, ...) are fine
    } else if (PDF_TRANSLITERATE[ch]) {
      out += PDF_TRANSLITERATE[ch];
    } else {
      // Strip diacritics via canonical decomposition: ć→c, č→c, đ→d, ...
      const base = ch.normalize('NFD').replace(/[\u0300-\u036F]/g, '');
      const baseCode = base.codePointAt(0) ?? 0;
      out += base.length === 1 && baseCode < 0x80 ? base : '?';
    }
  }
  return out;
}

/** PDFDocument factory that sanitizes all text input (render + measuring). */
function createPdfDocument(options: PDFKit.PDFDocumentOptions): PDFKit.PDFDocument {
  const doc = new PDFDocument(options);
  const origText = doc.text.bind(doc);
  const origWidthOfString = doc.widthOfString.bind(doc);
  const origHeightOfString = doc.heightOfString.bind(doc);
  const patched = doc as unknown as Record<string, unknown>;
  patched.text = (text: string, ...rest: unknown[]) =>
    origText(pdfSafeText(String(text)), ...(rest as [number?, number?, PDFKit.Mixins.TextOptions?]));
  patched.widthOfString = (text: string, options?: PDFKit.Mixins.TextOptions) =>
    origWidthOfString(pdfSafeText(String(text)), options);
  patched.heightOfString = (text: string, options?: PDFKit.Mixins.TextOptions) =>
    origHeightOfString(pdfSafeText(String(text)), options);
  return doc;
}

let cachedLogoPng: Buffer | null = null;

async function getCompanyLogoPng(): Promise<Buffer | null> {
  if (cachedLogoPng) return cachedLogoPng;
  try {
    const svgPath = path.resolve(
      process.cwd(),
      'public/assets/logo/Company_logo_1.0__Clean__no_black_shadow__bfc97f74.svg'
    );
    if (!fs.existsSync(svgPath)) return null;
    cachedLogoPng = await sharp(fs.readFileSync(svgPath))
      .resize(216, 200, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png()
      .toBuffer();
    return cachedLogoPng;
  } catch {
    return null;
  }
}

// Small LRU-ish cache so repeated exports don't re-run sharp on the same file.
const imageBufferCache = new Map<string, Buffer | null>();
const IMAGE_CACHE_MAX = 200;

async function loadImageBuffer(relPath: string | null | undefined, size = 72): Promise<Buffer | null> {
  const key = `${size}:${relPath ?? ''}`;
  if (imageBufferCache.has(key)) {
    return imageBufferCache.get(key) ?? null;
  }
  const full = resolveSafeImagePath(relPath);
  let buf: Buffer | null = null;
  if (full) {
    try {
      buf = await sharp(full)
        .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .png()
        .toBuffer();
    } catch {
      buf = null;
    }
  }
  if (imageBufferCache.size >= IMAGE_CACHE_MAX) {
    imageBufferCache.clear();
  }
  imageBufferCache.set(key, buf);
  return buf;
}

function sanitizeExcelText(value: string): string {
  if (!value) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Material names for a product (falls back to the legacy comma-separated column). */
function productMaterialNames(p: MetalProductWithMaterials): string[] {
  if (p.materials.length > 0) return p.materials.map((m) => m.name);
  return (p.material_type ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

/** Per-material measures lines, e.g. "Aluminum: 36\" · 26 Ga · 10'". */
function productMeasuresText(p: MetalProductWithMaterials): string {
  if (p.materials.length === 0) return '—';
  const lines = p.materials.map((m) => {
    const measures = formatMaterialMeasures(m);
    return measures ? `${m.name}: ${measures}` : m.name;
  });
  return lines.join('\n');
}

/** Per-material price lines, e.g. "Aluminum: $5.10"; falls back to the product price. */
function productPriceText(p: MetalProductWithMaterials): string {
  if (p.materials.length === 0) return formatCAD(p.price_per_lf_cents);
  return p.materials.map((m) => `${m.name}: ${formatCAD(m.price_per_lf_cents)}`).join('\n');
}

function productMaterialTypeText(p: MetalProductWithMaterials): string {
  const names = productMaterialNames(p);
  return names.length > 0 ? names.join(', ') : '—';
}

function pdfToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

async function drawPdfBrandHeader(
  doc: PDFKit.PDFDocument,
  title: string,
  subtitle: string
): Promise<number> {
  const logoBuf = await getCompanyLogoPng();
  const startX = 40;
  const startY = 32;

  // Match logo vertical height (50pt: from startY + 2 to startY + 52)
  // to the 4-line text block (AdelCo Inc., subtitle, Phone, Email)
  const logoH = 50;
  const logoW = 54;
  if (logoBuf) {
    doc.image(logoBuf, startX, startY + 2, { width: logoW, height: logoH });
  }

  const textX = logoBuf ? startX + logoW + 10 : startX;
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(BRAND_BLUE)
    .text('AdelCo Inc.', textX, startY);

  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(TEXT_MUTED)
    .text(subtitle, textX, startY + 19);

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(TEXT_DARK)
    .text('Phone (Office): +1 (604) 676 2155', textX, startY + 32);

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(TEXT_DARK)
    .text('Phone (WhatSapp): +1 (604) 369 9634', textX, startY + 43);

  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor(TEXT_DARK)
    .text(title, 40, startY + 6, { align: 'right', width: doc.page.width - 80 });

  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(TEXT_MUTED)
    .text(`Generated ${new Date().toISOString().slice(0, 10)} · Currency: CAD`, 40, startY + 25, {
      align: 'right',
      width: doc.page.width - 80,
    });

  const lineY = startY + 62;
  doc
    .moveTo(40, lineY)
    .lineTo(doc.page.width - 40, lineY)
    .lineWidth(1.5)
    .strokeColor(BRAND_BLUE)
    .stroke();

  return lineY + 14;
}

function applyExcelHeaderBanner(
  ws: Worksheet.Handle,
  wb: Workbook.Handle,
  logoBuf: Buffer | null,
  title: string,
  subtitle: string,
  colCount: number
): number {
  Worksheet.merge(ws, 1, 1, 2, colCount);
  Cell.setValue(ws, { row: 1, col: 1 }, `AdelCo Inc.  —  ${title}`);
  Cell.setStyle(ws, { row: 1, col: 1 }, {
    font: { name: 'Calibri', size: 15, bold: true, color: { argb: 'FF084091' } },
    alignment: { vertical: 'middle', horizontal: logoBuf ? 'center' : 'left' },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F7' } },
  });

  Row.setHeight(ws, 1, 24);
  Row.setHeight(ws, 2, 20);

  Worksheet.merge(ws, 3, 1, 3, colCount);
  Cell.setValue(ws, { row: 3, col: 1 }, subtitle);
  Cell.setStyle(ws, { row: 3, col: 1 }, {
    font: { name: 'Calibri', size: 10, color: { argb: 'FF475569' } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });
  Row.setHeight(ws, 3, 18);

  if (logoBuf) {
    const logoId = Image.add(wb, { buffer: logoBuf, extension: 'png' });
    Image.place(ws, logoId, {
      tl: { col: 0.15, row: 0.15 },
      ext: { width: 42, height: 38 },
    });
  }

  return 5; // table header row index
}

// ---------------------------------------------------------------------------
// Shared Excel cell renderers — the four export builders all draw the same
// blue header row and striped/bordered data rows.
// ---------------------------------------------------------------------------

type CellPos = { row: number; col: number };

function excelHeaderCell(
  ws: Worksheet.Handle,
  pos: CellPos,
  label: string,
  align: 'left' | 'right' = 'left',
  fontSize = 11
): void {
  Cell.setValue(ws, pos, label);
  Cell.setStyle(ws, pos, {
    font: { name: 'Calibri', size: fontSize, bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF084091' } },
    alignment: { vertical: 'middle', horizontal: align },
    border: {
      top: { style: 'thin', color: { argb: 'FF084091' } },
      bottom: { style: 'thin', color: { argb: 'FF084091' } },
      left: { style: 'thin', color: { argb: 'FF3563A8' } },
      right: { style: 'thin', color: { argb: 'FF3563A8' } },
    },
  });
}

interface ExcelDataCellOpts {
  align?: 'left' | 'right';
  numFmt?: string;
  bold?: boolean;
  colorArgb?: string;
  fillArgb?: string;
  wrapText?: boolean;
}

function excelDataCell(
  ws: Worksheet.Handle,
  pos: CellPos,
  value: CellValueInput,
  opts: ExcelDataCellOpts = {}
): void {
  Cell.setValue(ws, pos, value);
  Cell.setStyle(ws, pos, {
    font: {
      name: 'Calibri',
      size: 10.5,
      bold: opts.bold ?? false,
      color: { argb: opts.colorArgb ?? 'FF0F172A' },
    },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fillArgb ?? 'FFFFFFFF' } },
    border: {
      bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    },
    alignment: {
      vertical: 'middle',
      horizontal: opts.align ?? 'left',
      ...(opts.wrapText ? { wrapText: true } : {}),
    },
    ...(opts.numFmt ? { numFmt: opts.numFmt } : {}),
  });
}

function drawPdfColumnDividers(
  doc: PDFKit.PDFDocument,
  topY: number,
  rowH: number,
  cols: ReadonlyArray<{ x: number; w: number }>,
  strokeHex: string
): void {
  doc.save();
  doc.lineWidth(0.5).strokeColor(strokeHex);
  doc.moveTo(40, topY).lineTo(40, topY + rowH).stroke();
  for (let i = 1; i < cols.length; i++) {
    doc.moveTo(cols[i].x, topY).lineTo(cols[i].x, topY + rowH).stroke();
  }
  const rightX = doc.page.width - 40;
  doc.moveTo(rightX, topY).lineTo(rightX, topY + rowH).stroke();
  doc.restore();
}

export interface PdfColumn {
  label: string;
  x: number;
  w: number;
  align: 'left' | 'right' | 'center';
}

/** Shared blue table header renderer used by all PDF exports. */
function drawPdfTableHeader(
  doc: PDFKit.PDFDocument,
  topY: number,
  headerH: number,
  cols: PdfColumn[],
  opts?: { fontSize?: number; padX?: number; lineGap?: number; dividerHex?: string }
): number {
  const fontSize = opts?.fontSize ?? 9.5;
  const padX = opts?.padX ?? 6;
  const dividerHex = opts?.dividerHex ?? '#3863A8';
  doc.rect(40, topY, doc.page.width - 80, headerH).fill(BRAND_BLUE);
  drawPdfColumnDividers(doc, topY, headerH, cols, dividerHex);
  doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#FFFFFF');
  for (const c of cols) {
    drawPdfCenteredText(doc, c.label, c.x + padX, topY, headerH, {
      width: c.w - padX * 2,
      align: c.align,
      ...(opts?.lineGap ? { lineGap: opts.lineGap } : {}),
    });
  }
  return topY + headerH;
}

/** Shared row border renderer: column dividers + bottom line. */
function drawPdfRowBorders(
  doc: PDFKit.PDFDocument,
  y: number,
  rowH: number,
  cols: ReadonlyArray<{ x: number; w: number }>,
  dividerHex = '#E2E8F0'
): void {
  drawPdfColumnDividers(doc, y, rowH, cols, dividerHex);
  doc
    .moveTo(40, y + rowH)
    .lineTo(doc.page.width - 40, y + rowH)
    .lineWidth(0.5)
    .strokeColor(dividerHex)
    .stroke();
}

function measurePdfVisualTextHeight(
  doc: PDFKit.PDFDocument,
  text: string,
  options: PDFKit.Mixins.TextOptions
): number {
  const measuredH = doc.heightOfString(text, options);
  const trailingGap = Math.max(0, doc.currentLineHeight(true) - doc.currentLineHeight(false));
  return Math.max(doc.currentLineHeight(false), measuredH - trailingGap);
}

function drawPdfCenteredText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  rowTop: number,
  rowH: number,
  options: PDFKit.Mixins.TextOptions
): void {
  const visualH = measurePdfVisualTextHeight(doc, text, options);
  const maxHeight = options.height ?? rowH - 4;
  const effectiveH = Math.min(visualH, maxHeight);
  const textY = rowTop + Math.max(2, (rowH - effectiveH) / 2);
  doc.text(text, x, textY, options);
}

// ---------------------------------------------------------------------------
// Dynamic column fitting: every column is at least as wide as its widest
// single-line content (so cell text never wraps / gets "squished"), and when
// that does not fit the portrait page width, the widest columns are shrunk
// proportionally down to their floor. The table always ends exactly at the
// right margin. Ellipsis in the cell renderers is the last-resort fallback.
// ---------------------------------------------------------------------------

interface PdfFitColumnSpec {
  label: string;
  align: 'left' | 'right' | 'center';
  /** Width below which the column is never shrunk. */
  minW: number;
  /** Horizontal padding reserved for cell content (both sides). */
  padX: number;
  /** Padding used when measuring the header label (defaults to padX). */
  headerPadX?: number;
  headerFontSize: number;
  /** Cell values used to measure the natural single-line content width. */
  cells: Array<{ text: string; bold?: boolean; fontSize: number }>;
}

function measurePdfTextWidth(
  doc: PDFKit.PDFDocument,
  text: string,
  bold: boolean,
  fontSize: number
): number {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
  // Multi-line labels (e.g. "Total / lf\n(with Color)") are as wide as their widest line.
  return text
    .split('\n')
    .reduce((m, line) => Math.max(m, doc.widthOfString(line)), 0);
}

/**
 * Hard-wrap text to a fixed pixel width: breaks on spaces, and splits words that
 * are on their own longer than a full line mid-word. PDFKit only wraps at
 * whitespace, so a long unbroken token would otherwise overflow the cell into
 * the neighbouring column. Returns the text with '\n' inserted at wrap points.
 */
function wrapPdfTextToWidth(
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
  fontSize: number,
  bold = false
): string {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
  const fits = (s: string) => doc.widthOfString(s) <= width;
  const lines: string[] = [];
  let line = '';
  for (const rawWord of text.split(/\s+/).filter(Boolean)) {
    let word = rawWord;
    // Split a word that cannot fit on a line of its own.
    while (word.length > 1 && !fits(word)) {
      let k = word.length;
      while (k > 1 && !fits(word.slice(0, k))) k--;
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(word.slice(0, k));
      word = word.slice(k);
    }
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function fitPdfColumns(
  doc: PDFKit.PDFDocument,
  usableW: number,
  specs: PdfFitColumnSpec[]
): PdfColumn[] {
  // Floor = max(minW, header width): a column never shrinks below the width its
  // own header label needs, so headers keep their explicit line count (max 2)
  // even when long cell text pressures the layout.
  const headerWidths = specs.map((s) => {
    const headerPad = s.headerPadX ?? s.padX;
    return measurePdfTextWidth(doc, s.label, true, s.headerFontSize) + headerPad;
  });
  const minWidths = specs.map((s, i) => Math.max(s.minW, headerWidths[i]));
  const widths = specs.map((s, i) => {
    const contentW = s.cells.reduce(
      (m, c) =>
        Math.max(
          m,
          measurePdfTextWidth(doc, c.text, !!c.bold, c.fontSize) + s.padX
        ),
      0
    );
    return Math.max(minWidths[i], contentW);
  });

  let sum = widths.reduce((a, b) => a + b, 0);
  if (sum < usableW) {
    // Distribute leftover space proportionally so the table still fills the page.
    const leftover = usableW - sum;
    for (let i = 0; i < widths.length; i++) widths[i] += (leftover * widths[i]) / sum;
  } else if (sum > usableW) {
    // Shrink the widest columns proportionally to their room above the floor.
    const shrinkable = widths.map((w, i) => Math.max(0, w - minWidths[i]));
    const totalShrinkable = shrinkable.reduce((a, b) => a + b, 0);
    if (totalShrinkable > 0) {
      const f = Math.min(1, (sum - usableW) / totalShrinkable);
      for (let i = 0; i < widths.length; i++) widths[i] -= shrinkable[i] * f;
    } else {
      widths.splice(0, widths.length, ...minWidths);
    }
  }

  // Assign x positions; the last column absorbs rounding so the table ends
  // exactly at 40 + usableW (the right page margin).
  const cols: PdfColumn[] = [];
  let x = 40;
  for (let i = 0; i < specs.length; i++) {
    const w =
      i === specs.length - 1
        ? Math.max(minWidths[i], 40 + usableW - x)
        : widths[i];
    cols.push({ label: specs[i].label, x, w, align: specs[i].align });
    x += w;
  }
  return cols;
}

// ============================================================================
// 1. METAL COLORS EXPORTS
// ============================================================================

export async function buildColorsExcel(colors: MetalColorRow[]): Promise<Buffer> {
  const wb = Workbook.create();
  wb.creator = 'AdelCo Inc.';
  const ws = Workbook.addWorksheet(wb, 'Colors');
  const logoBuf = await getCompanyLogoPng();

  Column.setDefinitions(ws, [
    { key: 'id', width: 10 },
    { key: 'swatch', width: 14 },
    { key: 'name', width: 32 },
    { key: 'hex', width: 14 },
    { key: 'price', width: 22 },
    { key: 'status', width: 16 },
  ]);

  const headerRowIdx = applyExcelHeaderBanner(
    ws,
    wb,
    logoBuf,
    'Colors Catalog',
    `Exported ${new Date().toISOString().slice(0, 10)} · All prices in CAD per linear foot`,
    6
  );

  const headers = ['ID', 'Color', 'Name', 'HEX', 'Price per linear ft', 'Status'];
  Row.setHeight(ws, headerRowIdx, 26);
  headers.forEach((label, idx) => {
    excelHeaderCell(ws, { row: headerRowIdx, col: idx + 1 }, label, idx === 4 ? 'right' : 'left');
  });

  colors.forEach((c, idx) => {
    const rowIdx = headerRowIdx + 1 + idx;
    Row.setHeight(ws, rowIdx, 24);
    const values = [
      c.id,
      '',
      sanitizeExcelText(c.name),
      c.hex_code.toUpperCase(),
      c.price_per_lf_cents / 100,
      c.is_available ? 'Available' : 'Unavailable',
    ];
    const rowBg = idx % 2 === 1 ? 'FFF7F7F7' : 'FFFFFFFF';

    values.forEach((val, vIdx) => {
      const col = vIdx + 1;
      excelDataCell(ws, { row: rowIdx, col }, val, {
        align: col === 5 ? 'right' : 'left',
        numFmt: col === 5 ? '$#,##0.00' : undefined,
        colorArgb: c.is_available ? 'FF0F172A' : 'FF64748B',
        fillArgb: col === 2 ? hexToArgb(c.hex_code) : rowBg,
      });
    });
  });

  const out = await Workbook.toBuffer(wb);
  return Buffer.from(out);
}

export async function buildColorsPdf(colors: MetalColorRow[]): Promise<Buffer> {
  const doc = createPdfDocument({ size: 'LETTER', margin: 40 });
  let y = await drawPdfBrandHeader(
    doc,
    'Colors Catalog',
    'WorkSafeBC: 201 255 418'
  );

  const cols = fitPdfColumns(doc, doc.page.width - 80, [
    {
      label: 'ID',
      align: 'left',
      minW: 30,
      padX: 12,
      headerFontSize: 9.5,
      cells: colors.map((_, i) => ({ text: String(i + 1), fontSize: 9.5 })),
    },
    {
      label: 'Color',
      align: 'left',
      minW: 90,
      padX: 42, // swatch box + gap
      headerFontSize: 9.5,
      cells: colors.map((c) => ({ text: c.name, fontSize: 9.5 })),
    },
    {
      label: 'HEX',
      align: 'left',
      minW: 55,
      padX: 12,
      headerFontSize: 9.5,
      cells: colors.map((c) => ({ text: c.hex_code.toUpperCase(), fontSize: 9.5 })),
    },
    {
      label: 'Price / lf',
      align: 'right',
      minW: 70,
      padX: 12,
      headerFontSize: 9.5,
      cells: colors.map((c) => ({ text: formatCAD(c.price_per_lf_cents), fontSize: 9.5 })),
    },
    {
      label: 'Status',
      align: 'left',
      minW: 70,
      padX: 12,
      headerFontSize: 9.5,
      cells: [
        { text: 'Available', fontSize: 9.5 },
        { text: 'Unavailable', fontSize: 9.5 },
      ],
    },
  ]);

  const drawHeader = (topY: number) => drawPdfTableHeader(doc, topY, 26, cols);

  y = drawHeader(y);

  for (let i = 0; i < colors.length; i++) {
    if (y > doc.page.height - 70) {
      doc.addPage();
      y = drawHeader(40);
    }

    const item = colors[i];
    const rowH = 28;
    if (i % 2 === 1) {
      doc.rect(40, y, doc.page.width - 80, rowH).fill(NEUTRAL_BG);
    }

    // Swatch box + color name inside merged Color column (thin border — matches web tables)
    doc.save();
    doc.lineWidth(0.5).strokeColor('#CBD5E1');
    doc
      .rect(cols[1].x + 6, y + (rowH - 16) / 2, 24, 16)
      .fillAndStroke(normalizeHexDisplay(item.hex_code), '#CBD5E1');
    doc.restore();

    const textColor = item.is_available ? TEXT_DARK : '#64748B';
    doc.font('Helvetica').fontSize(9.5).fillColor(textColor);
    drawPdfCenteredText(doc, String(i + 1), cols[0].x + 6, y, rowH, {
      width: cols[0].w - 12,
      height: rowH - 6,
      ellipsis: true,
    });
    drawPdfCenteredText(doc, item.name, cols[1].x + 36, y, rowH, {
      width: cols[1].w - 42,
      height: rowH - 6,
      ellipsis: true,
    });
    drawPdfCenteredText(doc, item.hex_code.toUpperCase(), cols[2].x + 6, y, rowH, {
      width: cols[2].w - 12,
      height: rowH - 6,
      ellipsis: true,
    });
    drawPdfCenteredText(doc, formatCAD(item.price_per_lf_cents), cols[3].x + 6, y, rowH, {
      width: cols[3].w - 12,
      align: 'right',
      height: rowH - 6,
      ellipsis: true,
    });
    doc.fillColor(item.is_available ? BRAND_GREEN : '#DC2626');
    drawPdfCenteredText(
      doc,
      item.is_available ? 'Available' : 'Unavailable',
      cols[4].x + 6,
      y,
      rowH,
      { width: cols[4].w - 12, height: rowH - 6, ellipsis: true }
    );

    drawPdfRowBorders(doc, y, rowH, cols);

    y += rowH;
  }

  return pdfToBuffer(doc);
}

// ============================================================================
// 2. METAL PRODUCTS EXPORTS
// ============================================================================

export async function buildProductsExcel(products: MetalProductWithMaterials[]): Promise<Buffer> {
  const wb = Workbook.create();
  wb.creator = 'AdelCo Inc.';
  const ws = Workbook.addWorksheet(wb, 'Products');
  const logoBuf = await getCompanyLogoPng();

  Column.setDefinitions(ws, [
    { key: 'id', width: 10 },
    { key: 'image', width: 14 },
    { key: 'name', width: 34 },
    { key: 'material', width: 20 },
    { key: 'measures', width: 24 },
    { key: 'price', width: 22 },
    { key: 'status', width: 16 },
  ]);

  const headerRowIdx = applyExcelHeaderBanner(
    ws,
    wb,
    logoBuf,
    'Products Catalog',
    `Exported ${new Date().toISOString().slice(0, 10)} · Prices in CAD per linear foot (per material type when defined)`,
    7
  );

  const headers = ['ID', 'Product', 'Name', 'Material Type', 'Measures', 'Price per linear ft', 'Status'];
  Row.setHeight(ws, headerRowIdx, 26);
  headers.forEach((label, idx) => {
    excelHeaderCell(ws, { row: headerRowIdx, col: idx + 1 }, label, idx === 5 ? 'right' : 'left');
  });

  // Pre-load all product thumbnails in parallel (sharp is async) instead of
  // awaiting each one inside the row loop.
  const imageBuffers = await Promise.all(products.map((p) => loadImageBuffer(p.image_path, 72)));

  for (let idx = 0; idx < products.length; idx++) {
    const p = products[idx];
    const rowIdx = headerRowIdx + 1 + idx;
    const hasMaterials = p.materials.length > 0;
    Row.setHeight(ws, rowIdx, hasMaterials ? Math.max(42, 16 * p.materials.length) : 42);

    const values = [
      p.id,
      '',
      sanitizeExcelText(p.name),
      sanitizeExcelText(productMaterialTypeText(p)),
      productMeasuresText(p),
      hasMaterials ? productPriceText(p) : p.price_per_lf_cents / 100,
      p.is_available ? 'Available' : 'Unavailable',
    ];
    const rowBg = idx % 2 === 1 ? 'FFF7F7F7' : 'FFFFFFFF';

    values.forEach((val, vIdx) => {
      const col = vIdx + 1;
      excelDataCell(ws, { row: rowIdx, col }, val, {
        align: col === 6 ? 'right' : 'left',
        wrapText: col === 3 || col === 4 || col === 5 || col === 6,
        numFmt: col === 6 && !hasMaterials ? '$#,##0.00' : undefined,
        colorArgb: p.is_available ? 'FF0F172A' : 'FF64748B',
        fillArgb: rowBg,
      });
    });

    const imgBuf = imageBuffers[idx];
    if (imgBuf) {
      const imgId = Image.add(wb, { buffer: imgBuf, extension: 'png' });
      Image.place(ws, imgId, {
        tl: { col: 1.28, row: rowIdx - 0.8 },
        ext: { width: 34, height: 34 },
      });
    }
  }

  const out = await Workbook.toBuffer(wb);
  return Buffer.from(out);
}

export async function buildProductsPdf(products: MetalProductWithMaterials[]): Promise<Buffer> {
  const doc = createPdfDocument({ size: 'LETTER', margin: 40 });
  let y = await drawPdfBrandHeader(
    doc,
    'Products Catalog',
    'WorkSafeBC: 201 255 418'
  );

  const cols = fitPdfColumns(doc, doc.page.width - 80, [
    {
      label: 'ID',
      align: 'left',
      minW: 30,
      padX: 12,
      headerFontSize: 9.5,
      cells: products.map((_, i) => ({ text: String(i + 1), fontSize: 9.5 })),
    },
    {
      label: 'Product',
      align: 'left',
      minW: 90,
      padX: 54, // thumbnail + gap
      headerFontSize: 9.5,
      cells: products.map((p) => ({ text: p.name, fontSize: 9.5 })),
    },
    {
      label: 'Material Type',
      align: 'left',
      minW: 60,
      padX: 12,
      headerFontSize: 9.5,
      cells: products.map((p) => ({ text: productMaterialTypeText(p), fontSize: 8.5 })),
    },
    {
      label: 'Measures',
      align: 'left',
      minW: 70,
      padX: 12,
      headerFontSize: 9.5,
      cells: products.map((p) => ({ text: productMeasuresText(p), fontSize: 8 })),
    },
    {
      label: 'Price / lf',
      align: 'right',
      minW: 70,
      padX: 12,
      headerFontSize: 9.5,
      cells: products.map((p) => ({ text: productPriceText(p), fontSize: 8.5 })),
    },
    {
      label: 'Status',
      align: 'left',
      minW: 70,
      padX: 12,
      headerFontSize: 9.5,
      cells: [
        { text: 'Available', fontSize: 9.5 },
        { text: 'Unavailable', fontSize: 9.5 },
      ],
    },
  ]);

  const drawHeader = (topY: number) => drawPdfTableHeader(doc, topY, 26, cols);

  y = drawHeader(y);

  // Pre-load all thumbnails in parallel (sharp is async) before the row loop.
  const productImageBuffers = await Promise.all(products.map((p) => loadImageBuffer(p.image_path, 72)));

  for (let i = 0; i < products.length; i++) {
    if (y > doc.page.height - 80) {
      doc.addPage();
      y = drawHeader(40);
    }

    const item = products[i];
    const rowH = 40;
    if (i % 2 === 1) {
      doc.rect(40, y, doc.page.width - 80, rowH).fill(NEUTRAL_BG);
    }

    const imgX = cols[1].x + 8;
    const imgY = y + (rowH - 32) / 2;
    const imgBuf = productImageBuffers[i];
    if (imgBuf) {
      doc.image(imgBuf, imgX, imgY, { width: 32, height: 32 });
    } else {
      doc.rect(imgX, imgY, 32, 32).fill(NEUTRAL_BG);
    }
    // Thin border around the thumbnail — matches web tables
    doc.save();
    doc.lineWidth(0.5).strokeColor('#CBD5E1');
    doc.rect(imgX, imgY, 32, 32).stroke();
    doc.restore();

    const textColor = item.is_available ? TEXT_DARK : '#64748B';
    doc.font('Helvetica').fontSize(9.5).fillColor(textColor);
    drawPdfCenteredText(doc, String(i + 1), cols[0].x + 6, y, rowH, {
      width: cols[0].w - 12,
      height: rowH - 8,
      ellipsis: true,
    });
    drawPdfCenteredText(doc, item.name, cols[1].x + 48, y, rowH, {
      width: cols[1].w - 54,
      height: rowH - 8,
      ellipsis: true,
    });
    drawPdfCenteredText(doc, productMaterialTypeText(item), cols[2].x + 6, y, rowH, {
      width: cols[2].w - 12,
      height: rowH - 8,
      ellipsis: true,
    });
    drawPdfCenteredText(doc, productMeasuresText(item), cols[3].x + 6, y, rowH, {
      width: cols[3].w - 12,
      height: rowH - 8,
      ellipsis: true,
    });
    drawPdfCenteredText(doc, productPriceText(item), cols[4].x + 6, y, rowH, {
      width: cols[4].w - 12,
      align: 'right',
      height: rowH - 8,
      ellipsis: true,
    });
    doc.fillColor(item.is_available ? BRAND_GREEN : '#DC2626');
    drawPdfCenteredText(
      doc,
      item.is_available ? 'Available' : 'Unavailable',
      cols[5].x + 6,
      y,
      rowH,
      { width: cols[5].w - 12, height: rowH - 8, ellipsis: true }
    );

    drawPdfRowBorders(doc, y, rowH, cols);

    y += rowH;
  }

  return pdfToBuffer(doc);
}

// ============================================================================
// 3. SINGLE QUOTE (DRAFT OR ISSUED) EXPORTS
// ============================================================================

export interface ExportQuotePayload {
  quote_number: string;
  quote_date: string;
  customer_name: string | null;
  seller_name?: string | null;
  total_cents: number;
  items: Array<{
    product_name: string;
    product_image_path: string | null;
    material_type?: string | null;
    width_in?: number | null;
    gauge?: string | null;
    length_ft?: number | null;
    color_name: string;
    color_hex: string;
    product_price_per_lf_cents: number;
    color_price_per_lf_cents: number;
    combined_price_per_lf_cents: number;
    linear_feet: number;
    additional_costs_cents: number;
    additional_costs_description?: string | null;
    note?: string | null;
    line_total_cents: number;
  }>;
}

export async function buildSingleQuoteExcel(quote: ExportQuotePayload): Promise<Buffer> {
  const wb = Workbook.create();
  wb.creator = 'AdelCo Inc.';
  const ws = Workbook.addWorksheet(wb, 'Customer Quote');
  const logoBuf = await getCompanyLogoPng();

  const hasAddCostDesc = quote.items.some((it) => Boolean(it.additional_costs_description?.trim()));

  Column.setDefinitions(
    ws,
    hasAddCostDesc
      ? [
          { key: 'img', width: 11 },
          { key: 'product', width: 26 },
          { key: 'material', width: 16 },
          { key: 'swatch', width: 8 },
          { key: 'color', width: 18 },
          { key: 'measures', width: 18 },
          { key: 'prodPrice', width: 13 },
          { key: 'combPrice', width: 15 },
          { key: 'lf', width: 12 },
          { key: 'addCostsDesc', width: 22 },
          { key: 'addCosts', width: 15 },
          { key: 'note', width: 24 },
          { key: 'total', width: 15 },
        ]
      : [
          { key: 'img', width: 11 },
          { key: 'product', width: 26 },
          { key: 'material', width: 16 },
          { key: 'swatch', width: 8 },
          { key: 'color', width: 18 },
          { key: 'measures', width: 18 },
          { key: 'prodPrice', width: 13 },
          { key: 'combPrice', width: 15 },
          { key: 'lf', width: 12 },
          { key: 'addCosts', width: 15 },
          { key: 'note', width: 24 },
          { key: 'total', width: 15 },
        ]
  );

  const totalCols = hasAddCostDesc ? 13 : 12;
  const lastColLetter = hasAddCostDesc ? 'M' : 'L';
  const prevColLetter = hasAddCostDesc ? 'L' : 'K';

  // Top brand block
  Worksheet.merge(ws, `A1:${lastColLetter}1`);
  Cell.setValue(ws, 'A1', 'AdelCo Inc.  —  Customer Quote');
  Cell.setStyle(ws, 'A1', {
    font: { name: 'Calibri', size: 16, bold: true, color: { argb: 'FF084091' } },
    alignment: { vertical: 'middle', horizontal: 'center' },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F7' } },
  });
  Row.setHeight(ws, 1, 34);

  if (logoBuf) {
    const logoId = Image.add(wb, { buffer: logoBuf, extension: 'png' });
    Image.place(ws, logoId, {
      tl: { col: 0.15, row: 0.15 },
      ext: { width: 42, height: 38 },
    });
  }

  Row.setHeight(ws, 2, 8);
  Row.setHeight(ws, 3, 20);
  Row.setHeight(ws, 4, 20);

  Cell.setValue(ws, 'A3', 'Quote Number:');
  Cell.setStyle(ws, 'A3', {
    font: { bold: true, size: 10.5, color: { argb: 'FF475569' } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });
  Cell.setValue(ws, 'B3', quote.quote_number);
  Cell.setStyle(ws, 'B3', {
    font: { bold: true, size: 11, color: { argb: 'FF084091' } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });

  Cell.setValue(ws, 'D3', 'Date:');
  Cell.setStyle(ws, 'D3', {
    font: { bold: true, size: 10.5, color: { argb: 'FF475569' } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });
  Cell.setValue(ws, 'E3', quote.quote_date);
  Cell.setStyle(ws, 'E3', {
    font: { size: 10.5, color: { argb: 'FF0F172A' } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });

  Cell.setValue(ws, `${prevColLetter}3`, 'Currency:');
  Cell.setStyle(ws, `${prevColLetter}3`, {
    font: { bold: true, size: 10.5, color: { argb: 'FF475569' } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });
  Cell.setValue(ws, `${lastColLetter}3`, 'CAD');
  Cell.setStyle(ws, `${lastColLetter}3`, {
    font: { bold: true, size: 10.5, color: { argb: 'FF0F172A' } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });

  Cell.setValue(ws, 'A4', 'Customer:');
  Cell.setStyle(ws, 'A4', {
    font: { bold: true, size: 10.5, color: { argb: 'FF475569' } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });
  Cell.setValue(ws, 'B4', sanitizeExcelText(quote.customer_name?.trim() || 'Walk-in / General Quote'));
  Cell.setStyle(ws, 'B4', {
    font: { bold: true, size: 11, color: { argb: 'FF0F172A' } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });

  Row.setHeight(ws, 5, 10);

  const headerRowIdx = 6;
  const headers = hasAddCostDesc
    ? [
        'Preview',
        'Product',
        'Material Type',
        'Color',
        'Color Name',
        'Measures',
        'Product / lf',
        'Total / lf',
        'Linear ft',
        'Additional Costs Reason',
        'Additional Costs',
        'Additional Notes',
        'Total Price',
      ]
    : [
        'Preview',
        'Product',
        'Material Type',
        'Color',
        'Color Name',
        'Measures',
        'Product / lf',
        'Total / lf',
        'Linear ft',
        'Additional Costs',
        'Additional Notes',
        'Total Price',
      ];
  const noteCol = hasAddCostDesc ? 12 : 11;
  const isRightAlignedCol = (colNum: number) =>
    hasAddCostDesc ? colNum >= 7 && colNum !== 10 && colNum !== noteCol : colNum >= 7 && colNum !== noteCol;

  Row.setHeight(ws, headerRowIdx, 26);
  headers.forEach((label, idx) => {
    const col = idx + 1;
    excelHeaderCell(ws, { row: headerRowIdx, col }, label, isRightAlignedCol(col) ? 'right' : 'left', 10.5);
  });

  // Pre-load all line-item thumbnails in parallel (sharp is async).
  const itemImageBuffers = await Promise.all(quote.items.map((it) => loadImageBuffer(it.product_image_path, 72)));

  for (let idx = 0; idx < quote.items.length; idx++) {
    const item = quote.items[idx];
    const rowIdx = headerRowIdx + 1 + idx;
    Row.setHeight(ws, rowIdx, 40);

    const measuresText =
      [formatGaugeLabel(item.gauge), formatMeasureDimensions(item.width_in, item.length_ft)]
        .filter(Boolean)
        .join(' · ') || '—';

    const values = hasAddCostDesc
      ? [
          '',
          sanitizeExcelText(item.product_name),
          sanitizeExcelText(item.material_type?.trim() || '—'),
          '',
          sanitizeExcelText(item.color_name),
          measuresText,
          item.product_price_per_lf_cents / 100,
          item.combined_price_per_lf_cents / 100,
          item.linear_feet,
          sanitizeExcelText(item.additional_costs_description?.trim() || '—'),
          (item.additional_costs_cents ?? 0) / 100,
          sanitizeExcelText(item.note?.trim() || ''),
          item.line_total_cents / 100,
        ]
      : [
          '',
          sanitizeExcelText(item.product_name),
          sanitizeExcelText(item.material_type?.trim() || '—'),
          '',
          sanitizeExcelText(item.color_name),
          measuresText,
          item.product_price_per_lf_cents / 100,
          item.combined_price_per_lf_cents / 100,
          item.linear_feet,
          (item.additional_costs_cents ?? 0) / 100,
          sanitizeExcelText(item.note?.trim() || ''),
          item.line_total_cents / 100,
        ];

    const rowBg = idx % 2 === 1 ? 'FFF7F7F7' : 'FFFFFFFF';
    values.forEach((val, vIdx) => {
      const col = vIdx + 1;
      let numFmt: string | undefined;
      if (col === 7 || col === 8 || col === totalCols - 1 || col === totalCols) {
        numFmt = '$#,##0.00';
      } else if (col === 9) {
        numFmt = '#,##0.##';
      }

      excelDataCell(ws, { row: rowIdx, col }, val, {
        align: isRightAlignedCol(col) ? 'right' : 'left',
        wrapText:
          col === 2 || col === 3 || col === 5 || col === 6 || col === noteCol || (hasAddCostDesc && col === 10),
        bold: col === totalCols,
        numFmt,
        fillArgb: col === 4 ? hexToArgb(item.color_hex) : rowBg,
      });
    });

    const imgBuf = itemImageBuffers[idx];
    if (imgBuf) {
      const imgId = Image.add(wb, { buffer: imgBuf, extension: 'png' });
      Image.place(ws, imgId, {
        tl: { col: 0.25, row: rowIdx - 0.8 },
        ext: { width: 32, height: 32 },
      });
    }
  }

  // Grand Total Row
  const totalRowIdx = headerRowIdx + 1 + quote.items.length;
  Row.setHeight(ws, totalRowIdx, 28);

  for (let col = 1; col <= totalCols; col++) {
    const isGreen = col >= totalCols - 1;
    Cell.setStyle(ws, { row: totalRowIdx, col }, {
      fill: {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: isGreen ? 'FF2A6F3B' : 'FFF7F7F7' },
      },
      border: {
        top: { style: 'medium', color: { argb: 'FF084091' } },
        bottom: { style: 'medium', color: { argb: 'FF084091' } },
      },
    });
  }

  Cell.setValue(ws, { row: totalRowIdx, col: totalCols - 1 }, 'GRAND TOTAL (CAD):');
  Cell.setFont(ws, { row: totalRowIdx, col: totalCols - 1 }, {
    name: 'Calibri',
    size: 11,
    bold: true,
    color: { argb: 'FFFFFFFF' },
  });
  Cell.setAlignment(ws, { row: totalRowIdx, col: totalCols - 1 }, { vertical: 'middle', horizontal: 'right' });

  Cell.setValue(ws, { row: totalRowIdx, col: totalCols }, quote.total_cents / 100);
  Cell.setNumFmt(ws, { row: totalRowIdx, col: totalCols }, '$#,##0.00');
  Cell.setFont(ws, { row: totalRowIdx, col: totalCols }, {
    name: 'Calibri',
    size: 12,
    bold: true,
    color: { argb: 'FFFFFFFF' },
  });
  Cell.setAlignment(ws, { row: totalRowIdx, col: totalCols }, { vertical: 'middle', horizontal: 'right' });

  const out = await Workbook.toBuffer(wb);
  return Buffer.from(out);
}

export async function buildSingleQuotePdf(quote: ExportQuotePayload): Promise<Buffer> {
  const doc = createPdfDocument({ size: 'LETTER', margin: 40 });
  let y = await drawPdfBrandHeader(
    doc,
    'Customer Quote',
    'WorkSafeBC: 201 255 418'
  );

  // Customer & Quote metadata card — taller box: top row holds quote number,
  // date, customer and seller (with clear gaps between columns); below them two
  // thin signature lines, one for the customer and one for the seller.
  const metaBoxH = 74;
  doc.rect(40, y, doc.page.width - 80, metaBoxH).fillAndStroke(NEUTRAL_BG, '#E2E8F0');
  doc.font('Helvetica-Bold').fontSize(9).fillColor(TEXT_MUTED);
  doc.text('QUOTE NUMBER', 54, y + 9);
  doc.text('DATE', 192, y + 9);
  doc.text('CUSTOMER', 290, y + 9);
  doc.text('SELLER', 428, y + 9);

  doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND_BLUE);
  doc.text(quote.quote_number, 54, y + 23, { width: 128 });
  doc.font('Helvetica').fontSize(10.5).fillColor(TEXT_DARK);
  doc.text(quote.quote_date, 192, y + 23, { width: 88 });
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(TEXT_DARK);
  doc.text(quote.customer_name?.trim() || '//', 290, y + 23, {
    width: 128,
    ellipsis: true,
  });
  doc.text(quote.seller_name?.trim() || '//', 428, y + 23, {
    width: 130,
    ellipsis: true,
  });

  // Signature lines below the customer/seller row — two thin lines of equal,
  // adequate width, each with a small caption underneath.
  const sigLineY = y + 54;
  doc.save();
  doc.lineWidth(0.7).strokeColor('#64748B');
  doc.moveTo(54, sigLineY).lineTo(294, sigLineY).stroke();
  doc.moveTo(318, sigLineY).lineTo(558, sigLineY).stroke();
  doc.restore();
  doc.font('Helvetica').fontSize(6.8).fillColor(TEXT_MUTED);
  doc.text('Customer signature', 54, sigLineY + 5, { width: 240 });
  doc.text('Seller signature', 318, sigLineY + 5, { width: 240 });

  y += metaBoxH + 14;

  const cols = fitPdfColumns(doc, doc.page.width - 80, [
    {
      label: '#',
      align: 'left',
      minW: 24,
      padX: 8,
      headerPadX: 8,
      headerFontSize: 8,
      cells: quote.items.map((_, i) => ({ text: String(i + 1), fontSize: 8.5 })),
    },
    {
      label: 'Product',
      align: 'left',
      minW: 130,
      padX: 44, // thumbnail + gap
      headerPadX: 8,
      headerFontSize: 8,
      cells: quote.items.flatMap((it) => {
        const gaugeLabel = formatGaugeLabel(it.gauge);
        const materialLabel = it.material_type?.trim() || null;
        const detailLine = [gaugeLabel, materialLabel].filter(Boolean).join('. ');
        const measuresLabel = formatMeasureDimensions(it.width_in, it.length_ft);
        return [
          { text: it.product_name, bold: true, fontSize: 8.3 },
          ...(detailLine ? [{ text: detailLine, fontSize: 7.6 }] : []),
          ...(measuresLabel ? [{ text: measuresLabel, bold: true, fontSize: 7.6 }] : []),
          { text: `(${formatCAD(it.product_price_per_lf_cents)})`, fontSize: 7.6 },
        ];
      }),
    },
    {
      label: 'Color',
      align: 'left',
      minW: 60,
      padX: 29, // swatch box + gap
      headerPadX: 8,
      headerFontSize: 8,
      cells: quote.items.flatMap((it) => [
        { text: it.color_name, fontSize: 8.3 },
        { text: `(+${formatCAD(it.color_price_per_lf_cents)})`, fontSize: 7.6 },
      ]),
    },
    {
      label: 'Linear\nFeet',
      align: 'right',
      minW: 40,
      padX: 8,
      headerPadX: 8,
      headerFontSize: 8,
      cells: quote.items.map((it) => ({ text: String(it.linear_feet), fontSize: 8.5 })),
    },
    {
      label: 'Additional\nCosts',
      align: 'right',
      minW: 50,
      padX: 8,
      headerPadX: 8,
      headerFontSize: 8,
      cells: quote.items.flatMap((it) => {
        const desc = it.additional_costs_description?.trim();
        return [
          // Measure only a capped prefix of long descriptions — the full text is
          // wrapped inside the cell at render time and must not inflate the column
          // (which would squeeze other columns and wrap their headers to 3 lines).
          ...(desc ? [{ text: desc.slice(0, 24), fontSize: 7 }] : []),
          { text: formatCAD(it.additional_costs_cents ?? 0), fontSize: 8.5 },
        ];
      }),
    },
    {
      label: 'Notes',
      align: 'right',
      minW: 40,
      padX: 8,
      headerPadX: 8,
      headerFontSize: 8,
      cells: quote.items.map((it) => ({
        // Measure only a capped prefix of long notes so the column WIDTH stays
        // stable (a full-length note must not inflate the column and squeeze
        // Total Price). The full text is hard-wrapped inside the cell at render
        // time and the row height grows to fit it (see the row loop below).
        text: (it.note?.trim() || '').slice(0, 24),
        fontSize: 7.5,
      })),
    },
    {
      label: 'Total\nPrice',
      align: 'right',
      // Floor fits the bold 10.5pt grand-total amount in the footer
      // (~52.5pt text + 8pt padding), so amounts never wrap to a second line.
      minW: 61,
      padX: 8,
      headerPadX: 8,
      headerFontSize: 8,
      cells: quote.items.map((it) => ({
        text: formatCAD(it.line_total_cents),
        bold: true,
        fontSize: 8.8,
      })),
    },
  ]);

  const drawHeader = (topY: number) =>
    drawPdfTableHeader(doc, topY, 28, cols, { fontSize: 8, padX: 4, lineGap: 1 });

  y = drawHeader(y);

  let totalLinearFeet = 0;

  // Pre-load all line-item thumbnails in parallel (sharp is async).
  const quoteImageBuffers = await Promise.all(quote.items.map((it) => loadImageBuffer(it.product_image_path, 64)));

  for (let i = 0; i < quote.items.length; i++) {
    const item = quote.items[i];
    totalLinearFeet += item.linear_feet;

    // Dynamic row height: a row whose Notes text wraps onto more lines grows so
    // the full note fits — no more "..." truncation. The Notes column width is
    // fitted from a capped prefix (see above), so only the row height adapts.
    const noteText = item.note?.trim() ?? '';
    doc.font('Helvetica').fontSize(7.5);
    const noteW = cols[5].w - 8;
    const wrappedNote = noteText ? wrapPdfTextToWidth(doc, noteText, noteW, 7.5) : '';
    const noteH = wrappedNote
      ? measurePdfVisualTextHeight(doc, wrappedNote, { width: noteW })
      : 0;
    const rowH = Math.max(56, Math.ceil(noteH) + 10);

    if (y + rowH > doc.page.height - 40) {
      doc.addPage();
      y = drawHeader(40);
    }

    if (i % 2 === 1) {
      doc.rect(40, y, doc.page.width - 80, rowH).fill(NEUTRAL_BG);
    }

    // Col 0: #
    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED);
    drawPdfCenteredText(doc, String(i + 1), cols[0].x + 4, y, rowH, {
      width: cols[0].w - 8,
      align: 'left',
      height: rowH - 6,
      ellipsis: true,
    });

    // Col 1: Product (thumbnail + vertically centered name + ($price) stack)
    const thumbX = cols[1].x + 5;
    const thumbY = y + (rowH - 30) / 2;
    const imgBuf = quoteImageBuffers[i];
    if (imgBuf) {
      doc.image(imgBuf, thumbX, thumbY, { width: 30, height: 30 });
    } else {
      doc.rect(thumbX, thumbY, 30, 30).fill(NEUTRAL_BG);
    }
    // Thin border around the thumbnail — matches web tables
    doc.save();
    doc.lineWidth(0.5).strokeColor('#CBD5E1');
    doc.rect(thumbX, thumbY, 30, 30).stroke();
    doc.restore();

    const prodTextW = cols[1].w - 44;
    const gaugeLabel = formatGaugeLabel(item.gauge);
    const materialLabel = item.material_type?.trim() || null;
    const measuresLabel = formatMeasureDimensions(item.width_in, item.length_ft);
    const detailLine = [gaugeLabel, materialLabel].filter(Boolean).join('. ');
    const prodPriceText = `(${formatCAD(item.product_price_per_lf_cents)})`;

    doc.font('Helvetica-Bold').fontSize(8.3);
    const prodNameH = Math.min(
      measurePdfVisualTextHeight(doc, item.product_name, { width: prodTextW }),
      19
    );
    doc.font('Helvetica').fontSize(7.6);
    const detailH = detailLine ? measurePdfVisualTextHeight(doc, detailLine, { width: prodTextW }) : 0;
    const measuresH = measuresLabel
      ? measurePdfVisualTextHeight(doc, measuresLabel, { width: prodTextW })
      : 0;
    const prodPriceH = measurePdfVisualTextHeight(doc, prodPriceText, { width: prodTextW });
    const prodStackH =
      prodNameH +
      (detailLine ? 3 + detailH : 0) +
      (measuresLabel ? 3 + measuresH : 0) +
      3 +
      prodPriceH;
    let prodCursorY = y + Math.max(3, (rowH - prodStackH) / 2);

    doc.font('Helvetica-Bold').fontSize(8.3).fillColor(TEXT_DARK);
    doc.text(item.product_name, cols[1].x + 40, prodCursorY, {
      width: prodTextW,
      height: prodNameH + 2,
      ellipsis: true,
    });
    prodCursorY += prodNameH + 3;
    if (detailLine) {
      doc.font('Helvetica').fontSize(7.6).fillColor(BRAND_BLUE);
      doc.text(detailLine, cols[1].x + 40, prodCursorY, {
        width: prodTextW,
        height: detailH + 2,
        ellipsis: true,
      });
      prodCursorY += detailH + 3;
    }
    if (measuresLabel) {
      doc.font('Helvetica-Bold').fontSize(7.6).fillColor(TEXT_DARK);
      doc.text(measuresLabel, cols[1].x + 40, prodCursorY, {
        width: prodTextW,
        height: measuresH + 2,
        ellipsis: true,
      });
      prodCursorY += measuresH + 3;
    }
    doc.font('Helvetica').fontSize(7.6).fillColor(TEXT_MUTED);
    doc.text(prodPriceText, cols[1].x + 40, prodCursorY, {
      width: prodTextW,
    });

    // Col 2: Color (centered swatch + vertically centered name + (+$price) stack) — thin border matches web tables
    doc.save();
    doc.lineWidth(0.5).strokeColor('#CBD5E1');
    doc
      .rect(cols[2].x + 5, y + (rowH - 13) / 2, 15, 13)
      .fillAndStroke(normalizeHexDisplay(item.color_hex), '#CBD5E1');
    doc.restore();

    const colorTextW = cols[2].w - 29;
    doc.font('Helvetica').fontSize(8.3);
    const colorNameH = Math.min(
      measurePdfVisualTextHeight(doc, item.color_name, { width: colorTextW }),
      19
    );
    doc.font('Helvetica').fontSize(7.6);
    const colorPriceText = `(+${formatCAD(item.color_price_per_lf_cents)})`;
    const colorPriceH = measurePdfVisualTextHeight(doc, colorPriceText, { width: colorTextW });
    const colorStackH = colorNameH + 3 + colorPriceH;
    const colorStartY = y + Math.max(3, (rowH - colorStackH) / 2);

    doc.font('Helvetica').fontSize(8.3).fillColor(TEXT_DARK);
    doc.text(item.color_name, cols[2].x + 25, colorStartY, {
      width: colorTextW,
      height: colorNameH + 2,
      ellipsis: true,
    });
    doc.font('Helvetica').fontSize(7.6).fillColor(TEXT_MUTED);
    doc.text(colorPriceText, cols[2].x + 25, colorStartY + colorNameH + 3, {
      width: colorTextW,
    });

    // Col 3: Linear Feet
    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_DARK);
    drawPdfCenteredText(doc, String(item.linear_feet), cols[3].x + 4, y, rowH, {
      width: cols[3].w - 8,
      align: 'right',
      height: rowH - 6,
      ellipsis: true,
    });

    // Col 4: Additional Costs (vertically centered description + amount stack)
    const addCostsDesc = item.additional_costs_description?.trim();
    const addCostsW = cols[4].w - 8;
    if (addCostsDesc) {
      doc.font('Helvetica').fontSize(7);
      const descH = Math.min(
        measurePdfVisualTextHeight(doc, addCostsDesc, { width: addCostsW }),
        18
      );
      doc.font('Helvetica').fontSize(8.5);
      const amtText = formatCAD(item.additional_costs_cents ?? 0);
      const amtH = measurePdfVisualTextHeight(doc, amtText, { width: addCostsW });
      const addStackH = descH + 3 + amtH;
      const addStartY = y + Math.max(3, (rowH - addStackH) / 2);

      doc.font('Helvetica').fontSize(7).fillColor(TEXT_MUTED);
      doc.text(addCostsDesc, cols[4].x + 4, addStartY, {
        width: addCostsW,
        align: 'right',
        height: descH + 2,
        ellipsis: true,
      });
      doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_DARK);
      doc.text(amtText, cols[4].x + 4, addStartY + descH + 3, {
        width: addCostsW,
        align: 'right',
      });
    } else {
      doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_DARK);
      drawPdfCenteredText(doc, formatCAD(item.additional_costs_cents ?? 0), cols[4].x + 4, y, rowH, {
        width: addCostsW,
        align: 'right',
      });
    }

    // Col 5: Notes — justified and vertically centered; uniform 4pt padding on
    // all four sides (top/bottom gap equals left/right gap), so the text block is
    // equally distant from the left and right edges of its own column. The text
    // is hard-wrapped to the inner width (long words split mid-word) so it can
    // never bleed into the Total Price column. The row height was already grown
    // above to fit the full wrapped note, so no ellipsis is applied — the whole
    // note is always printed.
    if (noteText) {
      doc.font('Helvetica').fontSize(7.5).fillColor(TEXT_MUTED);
      drawPdfCenteredText(doc, wrappedNote, cols[5].x + 4, y, rowH, {
        width: noteW,
        height: rowH - 8,
        align: 'justify',
      });
    }

    // Col 6: Total Price
    doc.font('Helvetica-Bold').fontSize(8.8).fillColor(BRAND_GREEN);
    drawPdfCenteredText(doc, formatCAD(item.line_total_cents), cols[6].x + 4, y, rowH, {
      width: cols[6].w - 8,
      align: 'right',
      height: rowH - 6,
      ellipsis: true,
    });

    drawPdfRowBorders(doc, y, rowH, cols);

    y += rowH;
  }

  // Table Footer Summary & Grand Total Row (matching Customer Quote tfoot)
  if (y > doc.page.height - 80) {
    doc.addPage();
    y = 40;
  }

  const footerH = 30;
  doc.rect(40, y, cols[5].x - 40, footerH).fill(NEUTRAL_BG);
  doc.rect(cols[5].x, y, doc.page.width - 40 - cols[5].x, footerH).fill(BRAND_GREEN);

  doc
    .moveTo(40, y)
    .lineTo(doc.page.width - 40, y)
    .lineWidth(1.2)
    .strokeColor(BRAND_BLUE)
    .stroke();

  // Bottom + side borders match the table rows above (drawPdfRowBorders: 0.5, #E2E8F0)
  doc
    .moveTo(40, y + footerH)
    .lineTo(doc.page.width - 40, y + footerH)
    .lineWidth(0.5)
    .strokeColor('#E2E8F0')
    .stroke();

  doc
    .moveTo(40, y)
    .lineTo(40, y + footerH)
    .lineWidth(0.5)
    .strokeColor('#E2E8F0')
    .stroke();

  doc
    .moveTo(doc.page.width - 40, y)
    .lineTo(doc.page.width - 40, y + footerH)
    .lineWidth(0.5)
    .strokeColor('#E2E8F0')
    .stroke();

  doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED);
  drawPdfCenteredText(
    doc,
    `${quote.items.length} item(s)  ·  ${totalLinearFeet.toLocaleString('en-CA', {
      maximumFractionDigits: 2,
    })} lf total`,
    50,
    y,
    footerH,
    { width: cols[5].x - 60, height: footerH - 6, ellipsis: true }
  );

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
  drawPdfCenteredText(doc, 'GRAND TOTAL (CAD)', cols[5].x + 4, y, footerH, {
    width: cols[5].w - 8,
    align: 'right',
  });

  // Grand total: shrink the font size dynamically so a large amount always
  // fits on a single line instead of wrapping to two.
  const totalText = formatCAD(quote.total_cents);
  let totalFontSize = 10.5;
  doc.font('Helvetica-Bold');
  while (
    totalFontSize > 6 &&
    doc.fontSize(totalFontSize).widthOfString(totalText) > cols[6].w - 8
  ) {
    totalFontSize -= 0.5;
  }
  doc.font('Helvetica-Bold').fontSize(totalFontSize).fillColor('#FFFFFF');
  drawPdfCenteredText(doc, totalText, cols[6].x + 4, y, footerH, {
    width: cols[6].w - 8,
    align: 'right',
  });

  // Signatures sit directly below the table footer (not at the bottom of the page),
  // with a gap of 51pt (34 + half of it).
  let sigY = y + footerH + 51;
  if (sigY + 50 > doc.page.height - 40) {
    doc.addPage();
    sigY = 40;
  }
  const halfW = ((doc.page.width - 80) / 2 - 16) / 2;
  const sigCols = [
    { x: 40, label: 'Customer Signature' },
    { x: 40 + halfW + 32, label: 'Seller Signature' },
  ];
  doc.save();
  doc.lineWidth(0.7).strokeColor('#64748B');
  for (const c of sigCols) {
    doc.moveTo(c.x, sigY).lineTo(c.x + halfW, sigY).stroke();
  }
  doc.restore();
  doc.font('Helvetica').fontSize(8).fillColor(TEXT_MUTED);
  for (const c of sigCols) {
    doc.text(c.label, c.x, sigY + 5, { width: halfW });
  }

  return pdfToBuffer(doc);
}

// ============================================================================
// 4. ISSUED QUOTES TABLE EXPORTS
// ============================================================================

export async function buildIssuedQuotesExcel(quotes: IssuedQuoteRow[]): Promise<Buffer> {
  const wb = Workbook.create();
  wb.creator = 'AdelCo Inc.';
  const ws = Workbook.addWorksheet(wb, 'Issued Quotes');
  const logoBuf = await getCompanyLogoPng();

  Column.setDefinitions(ws, [
    { key: 'quote_number', width: 20 },
    { key: 'quote_date', width: 16 },
    { key: 'customer_name', width: 34 },
    { key: 'total', width: 20 },
  ]);

  const headerRowIdx = applyExcelHeaderBanner(
    ws,
    wb,
    logoBuf,
    'Issued Quotes Register',
    `Exported ${new Date().toISOString().slice(0, 10)} · ${quotes.length} quote(s) · CAD`,
    4
  );

  const headers = ['Quote Number', 'Date', 'Customer', 'Total (CAD)'];
  Row.setHeight(ws, headerRowIdx, 26);
  headers.forEach((label, idx) => {
    excelHeaderCell(ws, { row: headerRowIdx, col: idx + 1 }, label, idx === 3 ? 'right' : 'left');
  });

  let sumCents = 0;
  quotes.forEach((q, idx) => {
    sumCents += q.total_cents;
    const rowIdx = headerRowIdx + 1 + idx;
    Row.setHeight(ws, rowIdx, 24);
    const values = [
      q.quote_number,
      q.quote_date,
      sanitizeExcelText(q.customer_name || '—'),
      q.total_cents / 100,
    ];
    const rowBg = idx % 2 === 1 ? 'FFF7F7F7' : 'FFFFFFFF';
    values.forEach((val, vIdx) => {
      const col = vIdx + 1;
      excelDataCell(ws, { row: rowIdx, col }, val, {
        align: col === 4 ? 'right' : 'left',
        numFmt: col === 4 ? '$#,##0.00' : undefined,
        fillArgb: rowBg,
      });
    });
  });

  const totalRowIdx = headerRowIdx + 1 + quotes.length;
  Row.setHeight(ws, totalRowIdx, 26);
  for (let c = 1; c <= 4; c++) {
    Cell.setFill(ws, { row: totalRowIdx, col: c }, {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: c >= 3 ? 'FF2A6F3B' : 'FFF7F7F7' },
    });
  }
  Cell.setValue(ws, { row: totalRowIdx, col: 3 }, 'REGISTER TOTAL (CAD):');
  Cell.setFont(ws, { row: totalRowIdx, col: 3 }, { bold: true, color: { argb: 'FFFFFFFF' } });
  Cell.setAlignment(ws, { row: totalRowIdx, col: 3 }, { vertical: 'middle', horizontal: 'right' });
  Cell.setValue(ws, { row: totalRowIdx, col: 4 }, sumCents / 100);
  Cell.setNumFmt(ws, { row: totalRowIdx, col: 4 }, '$#,##0.00');
  Cell.setFont(ws, { row: totalRowIdx, col: 4 }, { bold: true, color: { argb: 'FFFFFFFF' } });
  Cell.setAlignment(ws, { row: totalRowIdx, col: 4 }, { vertical: 'middle', horizontal: 'right' });

  const out = await Workbook.toBuffer(wb);
  return Buffer.from(out);
}

export async function buildIssuedQuotesPdf(quotes: IssuedQuoteRow[]): Promise<Buffer> {
  const doc = createPdfDocument({ size: 'LETTER', margin: 40 });
  let y = await drawPdfBrandHeader(
    doc,
    'Issued Quotes Register',
    'WorkSafeBC: 201 255 418'
  );

  const cols = fitPdfColumns(doc, doc.page.width - 80, [
    {
      label: 'Quote Number',
      align: 'left',
      minW: 90,
      padX: 12,
      headerFontSize: 9.5,
      cells: quotes.map((q) => ({ text: q.quote_number, bold: true, fontSize: 9.5 })),
    },
    {
      label: 'Date',
      align: 'left',
      minW: 70,
      padX: 12,
      headerFontSize: 9.5,
      cells: quotes.map((q) => ({ text: q.quote_date, fontSize: 9.5 })),
    },
    {
      label: 'Customer',
      align: 'left',
      minW: 90,
      padX: 12,
      headerFontSize: 9.5,
      cells: quotes.map((q) => ({ text: q.customer_name || '—', fontSize: 9.5 })),
    },
    {
      label: 'Total (CAD)',
      align: 'right',
      minW: 80,
      padX: 12,
      headerFontSize: 9.5,
      cells: quotes.map((q) => ({ text: formatCAD(q.total_cents), bold: true, fontSize: 9.5 })),
    },
  ]);

  const drawHeader = (topY: number) => drawPdfTableHeader(doc, topY, 26, cols);

  y = drawHeader(y);

  let sumCents = 0;
  for (let i = 0; i < quotes.length; i++) {
    if (y > doc.page.height - 70) {
      doc.addPage();
      y = drawHeader(40);
    }

    const q = quotes[i];
    sumCents += q.total_cents;
    const rowH = 26;
    if (i % 2 === 1) {
      doc.rect(40, y, doc.page.width - 80, rowH).fill(NEUTRAL_BG);
    }

    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND_BLUE);
    drawPdfCenteredText(doc, q.quote_number, cols[0].x + 6, y, rowH, {
      width: cols[0].w - 12,
      height: rowH - 6,
      ellipsis: true,
    });

    doc.font('Helvetica').fontSize(9.5).fillColor(TEXT_DARK);
    drawPdfCenteredText(doc, q.quote_date, cols[1].x + 6, y, rowH, {
      width: cols[1].w - 12,
      height: rowH - 6,
      ellipsis: true,
    });
    drawPdfCenteredText(doc, q.customer_name || '—', cols[2].x + 6, y, rowH, {
      width: cols[2].w - 12,
      height: rowH - 6,
      ellipsis: true,
    });
    doc.font('Helvetica-Bold');
    drawPdfCenteredText(doc, formatCAD(q.total_cents), cols[3].x + 6, y, rowH, {
      width: cols[3].w - 12,
      align: 'right',
      height: rowH - 6,
      ellipsis: true,
    });

    drawPdfRowBorders(doc, y, rowH, cols);

    y += rowH;
  }

  y += 10;
  const regFooterH = 28;
  const footerX = cols[2].x;
  const footerW = cols[2].w + cols[3].w;
  doc.rect(footerX, y, footerW, regFooterH).fill(BRAND_GREEN);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#FFFFFF');
  drawPdfCenteredText(doc, 'REGISTER TOTAL (CAD)', cols[2].x + 10, y, regFooterH, {
    width: cols[2].w - 20,
    align: 'left',
    height: regFooterH - 6,
    ellipsis: true,
  });
  drawPdfCenteredText(doc, formatCAD(sumCents), cols[3].x + 10, y, regFooterH, {
    width: cols[3].w - 20,
    align: 'right',
    height: regFooterH - 6,
    ellipsis: true,
  });

  return pdfToBuffer(doc);
}
