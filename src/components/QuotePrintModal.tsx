import { Copy, FileSpreadsheet, FileText, Printer, X } from 'lucide-react';
import { formatMaterialSizeLine } from '../../shared/size.ts';
import type { IssuedQuoteDetail } from '../types';
import { downloadProtectedFile } from '../utils/api';
import { formatCAD } from '../utils/format';
import { ProductThumbnail } from './ProductThumbnail';

interface QuotePrintModalProps {
  detail: IssuedQuoteDetail | null;
  onClose: () => void;
  onCopyToNewQuote: (quoteId: number) => void;
  onNotify?: (type: 'success' | 'error', text: string) => void;
  canExport?: boolean;
  canCopy?: boolean;
}

export function QuotePrintModal({
  detail,
  onClose,
  onCopyToNewQuote,
  onNotify,
  canExport = true,
  canCopy = true,
}: QuotePrintModalProps) {
  if (!detail) return null;
  const { quote, items } = detail;

  // The same detail line the quote PDF prints under the Product name: the Material Type
  // with the Size's shared label beside it in the same line.
  const lines = items.map((item) => ({
    item,
    detailLine: formatMaterialSizeLine(item.material_type, item),
  }));

  return (
    // The overlay is the scroll container; the inner wrapper uses min-h-full so the
    // modal stays vertically centered when short, but grows with content when the
    // quote has many items — avoiding the flex-centering overflow that clipped the
    // top of tall reports and made them impossible to scroll.
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="w-full max-w-4xl rounded-lg border border-slate-200 bg-white shadow-2xl">
        {/* Modal Action Bar (hidden when printing) — sticky so it stays reachable on long quotes */}
        <div className="no-print sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-[#f7f7f7] px-6 py-3.5 rounded-t-lg">
          <div className="text-sm font-semibold text-slate-900">
            Issued Quote <span className="font-mono text-[#084091]">{quote.quote_number}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canExport && (
              <>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#084091] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#063273] whitespace-nowrap shrink-0"
                >
                  <Printer className="h-3.5 w-3.5" />
                  Print
                </button>
                <button
                  type="button"
                  onClick={() =>
                    downloadProtectedFile(`/api/quotes/${quote.id}/export/pdf`, `${quote.quote_number}.pdf`).catch(
                      (err) => onNotify?.('error', err instanceof Error ? err.message : 'Export failed.')
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  <FileText className="h-3.5 w-3.5 text-[#084091]" />
                  Export PDF
                </button>
                <button
                  type="button"
                  onClick={() =>
                    downloadProtectedFile(
                      `/api/quotes/${quote.id}/export/excel`,
                      `${quote.quote_number}.xlsx`
                    ).catch((err) =>
                      onNotify?.('error', err instanceof Error ? err.message : 'Export failed.')
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5 text-[#2a6f3b]" />
                  Export Excel
                </button>
              </>
            )}
            {canCopy && (
              <button
                type="button"
                onClick={() => onCopyToNewQuote(quote.id)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#2a6f3b] bg-white px-3.5 py-2 text-xs font-medium text-[#2a6f3b] hover:bg-[#2a6f3b] hover:text-white whitespace-nowrap shrink-0 transition-colors"
              >
                <Copy className="h-3.5 w-3.5" />
                Copy to New Quote
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="ml-1 rounded p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Printable Document Sheet */}
        <div id="printable-quote-sheet" className="p-8">
          {/* Brand Header */}
          <div className="flex items-start justify-between border-b-2 border-[#084091] pb-5">
            <div className="flex items-center gap-3.5">
              <img
                src="/assets/logo/Company_logo_1.0__Clean__no_black_shadow__bfc97f74.svg"
                alt="AdelCo Inc."
                className="h-12 w-12 object-contain"
              />
              <div>
                <h2 className="text-xl font-bold tracking-tight text-[#084091]">AdelCo Inc.</h2>
                <p className="text-xs text-slate-500">Products & Finishes · Customer Quote</p>
              </div>
            </div>

            <div className="text-right">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Quote Number
              </div>
              <div className="mt-0.5 font-mono text-lg font-bold text-[#084091]">
                {quote.quote_number}
              </div>
            </div>
          </div>

          {/* Quote Metadata */}
          <div className="mt-5 grid grid-cols-3 gap-4 rounded-md border border-slate-200 bg-[#f7f7f7] px-5 py-3.5 text-xs">
            <div>
              <div className="font-semibold text-slate-500">Customer</div>
              <div className="mt-0.5 text-sm font-semibold text-slate-900">
                {quote.customer_name || 'Walk-in / General Quote'}
              </div>
            </div>
            <div>
              <div className="font-semibold text-slate-500">Quote Date</div>
              <div className="mt-0.5 font-mono text-sm text-slate-900">{quote.quote_date}</div>
            </div>
            <div className="text-right">
              <div className="font-semibold text-slate-500">Currency</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-slate-900">CAD</div>
            </div>
          </div>

          {/* Snapshot Items Table */}
          <div className="mt-6 overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="divide-x divide-white/20 bg-[#084091] text-white">
                  <th className="px-3.5 py-2.5 w-14 text-left">Preview</th>
                  <th className="px-3.5 py-2.5 text-left">Product</th>
                  <th className="px-3.5 py-2.5 text-left">Color</th>
                  <th className="px-3.5 py-2.5 text-right">Product / lf</th>
                  <th className="px-3.5 py-2.5 text-right">Total / lf</th>
                  <th className="px-3.5 py-2.5 text-right">Linear ft</th>
                  <th className="px-3.5 py-2.5 text-right">Additional Costs</th>
                  <th className="px-3.5 py-2.5 text-right">Total Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {lines.map(({ item, detailLine }, idx) => (
                  <tr
                    key={item.id}
                    className={`divide-x divide-slate-200 ${idx % 2 === 1 ? 'bg-[#f7f7f7]/70' : 'bg-white'}`}
                  >
                    <td className="px-3.5 py-2.5 text-left">
                      <div className="flex items-center">
                        <ProductThumbnail
                          imagePath={item.product_image_path}
                          alt={item.product_name}
                          sizeClass="h-9 w-9"
                        />
                      </div>
                    </td>
                    <td className="px-3.5 py-2.5 text-left font-medium text-slate-900">
                      <div>{item.product_name}</div>
                      {detailLine && (
                        <div className="mt-0.5 text-[11px] font-normal text-[#084091]">{detailLine}</div>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5 text-left">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block h-4 w-5 shrink-0 rounded"
                          style={{ backgroundColor: item.color_hex }}
                        />
                        <span className="text-slate-800">{item.color_name}</span>
                      </div>
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono tabular-nums text-slate-700">
                      {formatCAD(item.product_price_per_lf_cents)}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono tabular-nums text-slate-900">
                      {formatCAD(item.combined_price_per_lf_cents)}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono tabular-nums text-slate-900">
                      {item.linear_feet}
                    </td>
                    <td className="px-3.5 py-2.5 text-right tabular-nums text-slate-900">
                      {item.additional_costs_description && (
                        <div className="mb-0.5 text-[11px] leading-tight text-slate-500">
                          {item.additional_costs_description}
                        </div>
                      )}
                      <div className="font-mono">{formatCAD(item.additional_costs_cents ?? 0)}</div>
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono font-semibold tabular-nums text-slate-900">
                      {formatCAD(item.line_total_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Grand Total Footer */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
            <p className="text-[11px] text-slate-500">
              Immutable snapshot issued on {quote.created_at.slice(0, 10)}. Prices quoted in Canadian Dollars (CAD).
            </p>
            <div className="flex items-center gap-5 rounded-md bg-[#2a6f3b] px-5 py-3 text-white">
              <span className="text-xs font-semibold uppercase tracking-wide">
                Grand Total
              </span>
              <span className="font-mono text-lg font-bold tabular-nums">
                {formatCAD(quote.total_cents)}
              </span>
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
