import { type Request, type Response, Router } from 'express';
import { type AuthenticatedRequest, requireAuth, requirePermission } from '../auth.ts';
import {
  copyProductImageToQuoteSnapshot,
  getDb,
  getNextQuoteNumber,
  type IssuedQuoteItemRow,
  type IssuedQuoteRow,
  type MetalColorRow,
  type MetalProductRow,
  removeImageFileIfUnused,
} from '../db.ts';
import {
  buildIssuedQuotesExcel,
  buildIssuedQuotesPdf,
  buildSingleQuoteExcel,
  buildSingleQuotePdf,
  type ExportQuotePayload,
} from '../exports.ts';
import {
  parseIsoDate,
  parseOptionalCustomerName,
  parsePositiveInt,
  sendBufferDownload,
  validateAndBuildQuoteLines,
  ValidationError,
} from '../validation.ts';

// Returns a user-safe message for validation errors; logs and hides anything unexpected.
function errorMessageOrLog(err: unknown, fallback: string, logContext: string): string {
  if (err instanceof ValidationError) return err.message;
  console.error(logContext, err);
  return fallback;
}

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function queryIssuedQuotes(query: Request['query']): IssuedQuoteRow[] {
  const db = getDb();
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 120) : '';
  const dateFrom = typeof query.dateFrom === 'string' ? query.dateFrom.trim() : '';
  const dateTo = typeof query.dateTo === 'string' ? query.dateTo.trim() : '';
  const sortByRaw = typeof query.sortBy === 'string' ? query.sortBy : 'created_at';
  const sortDirRaw = typeof query.sortDir === 'string' ? query.sortDir.toUpperCase() : 'DESC';

  const sortColMap: Record<string, string> = {
    quote_number: 'quote_number',
    quote_date: 'quote_date',
    customer_name: "COALESCE(customer_name, '')",
    total_cents: 'total_cents',
    created_at: 'created_at',
  };
  const orderCol = sortColMap[sortByRaw] ?? 'created_at';
  const orderDir = sortDirRaw === 'ASC' ? 'ASC' : 'DESC';

  const where: string[] = [];
  const params: unknown[] = [];

  if (search) {
    // Escape LIKE wildcards so user input cannot act as wildcards
    const escaped = search.replace(/[\\%_]/g, (m) => `\\${m}`);
    where.push("(quote_number LIKE ? ESCAPE '\\' OR COALESCE(customer_name, '') LIKE ? ESCAPE '\\')");
    params.push(`%${escaped}%`, `%${escaped}%`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
    where.push('quote_date >= ?');
    params.push(dateFrom);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    where.push('quote_date <= ?');
    params.push(dateTo);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM issued_quotes ${whereClause} ORDER BY ${orderCol} ${orderDir}, id DESC`)
    .all(...params) as IssuedQuoteRow[];
}

function buildDraftPayloadForExport(body: Record<string, unknown>): ExportQuotePayload {
  const quoteDate = parseIsoDate(body.quote_date);
  const customerName = parseOptionalCustomerName(body.customer_name);
  const { items, totalCents } = validateAndBuildQuoteLines(body.items, { requireAvailable: false });

  return {
    quote_number: 'DRAFT',
    quote_date: quoteDate,
    customer_name: customerName,
    total_cents: totalCents,
    items,
  };
}

export function createQuoteRouter(): Router {
  const router = Router();

  // Draft Quote Exports (before issuing)
  router.post(
    '/quotes/draft/export/excel',
    requireAuth,
    requirePermission('customer_quote', 'exports'),
    async (req: Request, res: Response) => {
      try {
        const payload = buildDraftPayloadForExport(req.body ?? {});
        const buf = await buildSingleQuoteExcel(payload);
        sendBufferDownload(res, EXCEL_MIME, 'AdelCo-Draft-Quote.xlsx', buf);
      } catch (err) {
        res.status(400).json({ error: errorMessageOrLog(err, 'Export failed.', 'Draft quote Excel export failed:') });
      }
    }
  );

  router.post(
    '/quotes/draft/export/pdf',
    requireAuth,
    requirePermission('customer_quote', 'exports'),
    async (req: Request, res: Response) => {
      try {
        const payload = buildDraftPayloadForExport(req.body ?? {});
        const buf = await buildSingleQuotePdf(payload);
        sendBufferDownload(res, 'application/pdf', 'AdelCo-Draft-Quote.pdf', buf);
      } catch (err) {
        res.status(400).json({ error: errorMessageOrLog(err, 'Export failed.', 'Draft quote PDF export failed:') });
      }
    }
  );

  // Issued Quotes Register Exports & Listing
  router.get(
    '/quotes/export/excel',
    requireAuth,
    requirePermission('issued_quotes_view', 'exports'),
    async (req: Request, res: Response) => {
      const quotes = queryIssuedQuotes(req.query);
      const buf = await buildIssuedQuotesExcel(quotes);
      sendBufferDownload(res, EXCEL_MIME, 'AdelCo-Issued-Quotes.xlsx', buf);
    }
  );

  router.get(
    '/quotes/export/pdf',
    requireAuth,
    requirePermission('issued_quotes_view', 'exports'),
    async (req: Request, res: Response) => {
      const quotes = queryIssuedQuotes(req.query);
      const buf = await buildIssuedQuotesPdf(quotes);
      sendBufferDownload(res, 'application/pdf', 'AdelCo-Issued-Quotes.pdf', buf);
    }
  );

  router.get('/quotes', requireAuth, requirePermission('issued_quotes_view'), (req: Request, res: Response) => {
    res.json(queryIssuedQuotes(req.query));
  });

  router.get('/quotes/:id', requireAuth, requirePermission('issued_quotes_view'), (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid quote ID.' });
      return;
    }
    const db = getDb();
    const quote = db.prepare('SELECT * FROM issued_quotes WHERE id = ?').get(id) as
      | IssuedQuoteRow
      | undefined;
    if (!quote) {
      res.status(404).json({ error: 'Issued quote not found.' });
      return;
    }
    const items = db
      .prepare('SELECT * FROM issued_quote_items WHERE quote_id = ? ORDER BY id ASC')
      .all(id) as IssuedQuoteItemRow[];
    res.json({ quote, items });
  });

  router.post(
    '/quotes',
    requireAuth,
    requirePermission('customer_quote'),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const quoteDate = parseIsoDate(req.body?.quote_date);
        const customerName = parseOptionalCustomerName(req.body?.customer_name);
        const { items: validatedItems, totalCents } = validateAndBuildQuoteLines(req.body?.items, {
          requireAvailable: true,
        });

        const db = getDb();
        const result = db.transaction(() => {
          const quoteNumber = getNextQuoteNumber(db, quoteDate);
          const now = new Date().toISOString();

          const quoteInfo = db
            .prepare(
              'INSERT INTO issued_quotes (quote_number, quote_date, customer_name, total_cents, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            )
            .run(quoteNumber, quoteDate, customerName, totalCents, req.authUser?.username ?? null, now);

          const quoteId = Number(quoteInfo.lastInsertRowid);
          const insertItem = db.prepare(`
            INSERT INTO issued_quote_items (
              quote_id, source_product_id, source_color_id,
              product_name, product_image_path, material_type, width_in, gauge, length_ft,
              color_name, color_hex,
              product_price_per_lf_cents, color_price_per_lf_cents, combined_price_per_lf_cents,
              linear_feet, additional_costs_cents, additional_costs_description, line_total_cents
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const item of validatedItems) {
            const snapshotImagePath = copyProductImageToQuoteSnapshot(item.product_image_path);
            insertItem.run(
              quoteId,
              item.source_product_id,
              item.source_color_id,
              item.product_name,
              snapshotImagePath,
              item.material_type,
              item.width_in,
              item.gauge,
              item.length_ft,
              item.color_name,
              item.color_hex,
              item.product_price_per_lf_cents,
              item.color_price_per_lf_cents,
              item.combined_price_per_lf_cents,
              item.linear_feet,
              item.additional_costs_cents,
              item.additional_costs_description,
              item.line_total_cents
            );
          }

          const quote = db.prepare('SELECT * FROM issued_quotes WHERE id = ?').get(quoteId) as IssuedQuoteRow;
          const items = db
            .prepare('SELECT * FROM issued_quote_items WHERE quote_id = ? ORDER BY id ASC')
            .all(quoteId) as IssuedQuoteItemRow[];

          return { quote, items };
        })();

        res.status(201).json(result);
      } catch (err) {
        res.status(400).json({ error: errorMessageOrLog(err, 'Failed to issue quote.', 'Failed to issue quote:') });
      }
    }
  );

  router.post(
    '/quotes/:id/copy',
    requireAuth,
    requirePermission('issued_quotes_manage', 'customer_quote'),
    (req: Request, res: Response) => {
      const id = parsePositiveInt(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Invalid quote ID.' });
        return;
      }
      const db = getDb();
      const quote = db.prepare('SELECT * FROM issued_quotes WHERE id = ?').get(id) as
        | IssuedQuoteRow
        | undefined;
      if (!quote) {
        res.status(404).json({ error: 'Issued quote not found.' });
        return;
      }

      const oldItems = db
        .prepare('SELECT * FROM issued_quote_items WHERE quote_id = ? ORDER BY id ASC')
        .all(id) as IssuedQuoteItemRow[];

      const getProd = db.prepare('SELECT * FROM metal_products WHERE id = ?');
      const getColor = db.prepare('SELECT * FROM metal_colors WHERE id = ?');

      const draftItems = oldItems.map((old) => {
        const prod = old.source_product_id
          ? (getProd.get(old.source_product_id) as MetalProductRow | undefined)
          : undefined;
        const color = old.source_color_id
          ? (getColor.get(old.source_color_id) as MetalColorRow | undefined)
          : undefined;

        const productOk = Boolean(prod && prod.is_available === 1);
        const colorOk = Boolean(color && color.is_available === 1);

        return {
          product_id: productOk && prod ? prod.id : null,
          material_type: old.material_type ?? '',
          color_id: colorOk && color ? color.id : null,
          width_in: old.width_in ?? null,
          gauge: old.gauge ?? '',
          length_ft: old.length_ft ?? null,
          linear_feet: old.linear_feet,
          additional_costs_cents: old.additional_costs_cents ?? 0,
          additional_costs_description: old.additional_costs_description ?? '',
          productIssue: productOk ? null : prod ? 'unavailable' : 'deleted',
          colorIssue: colorOk ? null : color ? 'unavailable' : 'deleted',
          fallbackProductName: old.product_name,
          fallbackColorName: old.color_name,
          fallbackColorHex: old.color_hex,
        };
      });

      res.json({
        customer_name: quote.customer_name ?? '',
        quote_date: new Date().toISOString().slice(0, 10),
        source_quote_number: quote.quote_number,
        items: draftItems,
      });
    }
  );

  router.delete(
    '/quotes/:id',
    requireAuth,
    requirePermission('issued_quotes_manage'),
    (req: Request, res: Response) => {
      const id = parsePositiveInt(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Invalid quote ID.' });
        return;
      }
      const db = getDb();
      const existing = db.prepare('SELECT * FROM issued_quotes WHERE id = ?').get(id);
      if (!existing) {
        res.status(404).json({ error: 'Issued quote not found.' });
        return;
      }

      const items = db
        .prepare('SELECT product_image_path FROM issued_quote_items WHERE quote_id = ?')
        .all(id) as Array<{ product_image_path: string | null }>;

      db.prepare('DELETE FROM issued_quotes WHERE id = ?').run(id);
      for (const item of items) {
        removeImageFileIfUnused(item.product_image_path);
      }

      res.json({ deleted: true });
    }
  );

  router.get(
    '/quotes/:id/export/excel',
    requireAuth,
    requirePermission('issued_quotes_view', 'exports'),
    async (req: Request, res: Response) => {
      const id = parsePositiveInt(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Invalid quote ID.' });
        return;
      }
      const db = getDb();
      const quote = db.prepare('SELECT * FROM issued_quotes WHERE id = ?').get(id) as
        | IssuedQuoteRow
        | undefined;
      if (!quote) {
        res.status(404).json({ error: 'Quote not found.' });
        return;
      }
      const items = db
        .prepare('SELECT * FROM issued_quote_items WHERE quote_id = ? ORDER BY id ASC')
        .all(id) as IssuedQuoteItemRow[];
      const buf = await buildSingleQuoteExcel({
        quote_number: quote.quote_number,
        quote_date: quote.quote_date,
        customer_name: quote.customer_name,
        total_cents: quote.total_cents,
        items,
      });
      sendBufferDownload(res, EXCEL_MIME, `AdelCo-Quote-${quote.quote_number}.xlsx`, buf);
    }
  );

  router.get(
    '/quotes/:id/export/pdf',
    requireAuth,
    requirePermission('issued_quotes_view', 'exports'),
    async (req: Request, res: Response) => {
      const id = parsePositiveInt(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Invalid quote ID.' });
        return;
      }
      const db = getDb();
      const quote = db.prepare('SELECT * FROM issued_quotes WHERE id = ?').get(id) as
        | IssuedQuoteRow
        | undefined;
      if (!quote) {
        res.status(404).json({ error: 'Quote not found.' });
        return;
      }
      const items = db
        .prepare('SELECT * FROM issued_quote_items WHERE quote_id = ? ORDER BY id ASC')
        .all(id) as IssuedQuoteItemRow[];
      const buf = await buildSingleQuotePdf({
        quote_number: quote.quote_number,
        quote_date: quote.quote_date,
        customer_name: quote.customer_name,
        total_cents: quote.total_cents,
        items,
      });
      sendBufferDownload(res, 'application/pdf', `AdelCo-Quote-${quote.quote_number}.pdf`, buf);
    }
  );

  return router;
}
