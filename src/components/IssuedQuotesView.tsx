import {
  ArrowUpDown,
  Copy,
  Eye,
  FileSpreadsheet,
  FileText,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { IssuedQuote, IssuedQuoteDetail } from '../types';
import { apiFetch, downloadProtectedFile } from '../utils/api';
import { formatCAD } from '../utils/format';
import { ConfirmModal } from './ConfirmModal';
import { ExportButtons } from './ExportButtons';
import { TableSkeleton } from './TableSkeleton';

interface IssuedQuotesViewProps {
  onOpenQuoteDetail: (detail: IssuedQuoteDetail) => void;
  onCopyToNewQuote: (quoteId: number) => void;
  onStartNewQuote: () => void;
  onNotify: (type: 'success' | 'error', text: string) => void;
  refreshSignal: number;
  canManage?: boolean;
  canExport?: boolean;
  canCreateQuote?: boolean;
}

type SortKey = 'quote_number' | 'quote_date' | 'customer_name' | 'total_cents';

export function IssuedQuotesView({
  onOpenQuoteDetail,
  onCopyToNewQuote,
  onStartNewQuote,
  onNotify,
  refreshSignal,
  canManage = true,
  canExport = true,
  canCreateQuote = true,
}: IssuedQuotesViewProps) {
  const [quotes, setQuotes] = useState<IssuedQuote[]>([]);
  const [loading, setLoading] = useState(true);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('quote_number');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('DESC');

  // Debounce the search box so we don't fire a request on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [deleteTarget, setDeleteTarget] = useState<IssuedQuote | null>(null);
  const [deleting, setDeleting] = useState(false);

  const buildQueryString = () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    params.set('sortBy', sortBy);
    params.set('sortDir', sortDir);
    return params.toString();
  };

  const fetchQuotes = async () => {
    setLoading(true);
    try {
      const qs = buildQueryString();
      const res = await apiFetch(`/api/quotes?${qs}`);
      if (!res.ok) throw new Error('Failed to load issued quotes.');
      const data = (await res.json()) as IssuedQuote[];
      setQuotes(data);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to load issued quotes.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchQuotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, dateFrom, dateTo, sortBy, sortDir, refreshSignal]);

  const toggleSort = (col: SortKey) => {
    if (sortBy === col) {
      setSortDir((prev) => (prev === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortBy(col);
      setSortDir(col === 'customer_name' ? 'ASC' : 'DESC');
    }
  };

  const handleViewQuote = async (quoteId: number) => {
    try {
      const res = await apiFetch(`/api/quotes/${quoteId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load quote.');
      onOpenQuoteDetail(data as IssuedQuoteDetail);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to open quote.');
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/quotes/${deleteTarget.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete quote.');
      onNotify('success', `Issued quote ${deleteTarget.quote_number} deleted.`);
      setDeleteTarget(null);
      await fetchQuotes();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to delete quote.');
    } finally {
      setDeleting(false);
    }
  };

  const hasFilters = Boolean(search.trim() || dateFrom || dateTo);
  const qs = buildQueryString();
  const registerTotalCents = quotes.reduce((acc, q) => acc + q.total_cents, 0);

  return (
    <div className="space-y-4">
      {/* Search, Filter & Export Toolbar */}
      <div className="ui-card p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-3 flex-1 min-w-[280px]">
            <div className="w-full sm:w-64">
              <label className="mb-1 block text-[11px] font-semibold text-slate-600">
                Search Quote # or Customer
              </label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="e.g. 2026-0001 or John..."
                  className="ui-input-sm pl-8"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-600">
                Date From
              </label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="ui-input-sm w-auto font-mono"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-600">
                Date To
              </label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="ui-input-sm w-auto font-mono"
              />
            </div>

            {hasFilters && (
              <button
                type="button"
                onClick={() => {
                  setSearchInput('');
                  setSearch('');
                  setDateFrom('');
                  setDateTo('');
                }}
                className="ui-btn-secondary h-9 px-3"
              >
                <X className="h-3 w-3" />
                Reset
              </button>
            )}
          </div>

          {canExport && (
            <div className="flex flex-wrap items-center gap-2.5">
              <ExportButtons
                baseUrl="/api/quotes/export"
                query={`?${qs}`}
                fallbackBaseName="adelco-issued-quotes"
                onError={(msg) => onNotify('error', msg)}
              />
            </div>
          )}
        </div>

        <div className="mt-3.5 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
          <span className="font-semibold text-slate-800">{quotes.length} issued quote(s)</span>
          <span className="text-slate-300" aria-hidden="true">·</span>
          <span>
            Register Total:{' '}
            <strong className="font-mono tabular-nums text-[#2a6f3b]">
              {formatCAD(registerTotalCents)} CAD
            </strong>
          </span>
          <span className="text-slate-300" aria-hidden="true">·</span>
          <span>Issued quotes are read-only snapshots</span>
        </div>
      </div>

      {/* Issued Quotes Table */}
      <div className="ui-card overflow-hidden">
        {loading ? (
          <TableSkeleton rows={3} rowHeightClass="h-11" cells={['h-4 w-24', 'h-4 w-24', 'h-4 w-44']} />
        ) : quotes.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <h3 className="text-sm font-semibold text-slate-900">
              {hasFilters ? 'No matching issued quotes' : 'No issued quotes yet'}
            </h3>
            <p className="mt-1 max-w-sm text-xs text-slate-500">
              {hasFilters
                ? 'Try clearing or adjusting your search term and date range.'
                : 'Build a quote in Customer Quote and click Issue Quote to store an immutable record here.'}
            </p>
            {!hasFilters && canCreateQuote && (
              <button type="button" onClick={onStartNewQuote} className="ui-btn-primary mt-4">
                <Plus className="h-3.5 w-3.5" />
                Create Customer Quote
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-left text-sm">
              <thead>
                <tr className="ui-table-head">
                  <th className="px-4 py-3 w-40 text-left">
                    <button
                      type="button"
                      onClick={() => toggleSort('quote_number')}
                      className="inline-flex cursor-pointer items-center gap-1 hover:text-slate-800"
                    >
                      Quote Number
                      <ArrowUpDown className="h-3 w-3 opacity-70" />
                    </button>
                  </th>
                  <th className="px-4 py-3 w-32 text-left">
                    <button
                      type="button"
                      onClick={() => toggleSort('quote_date')}
                      className="inline-flex cursor-pointer items-center gap-1 hover:text-slate-800"
                    >
                      Date
                      <ArrowUpDown className="h-3 w-3 opacity-70" />
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left">
                    <button
                      type="button"
                      onClick={() => toggleSort('customer_name')}
                      className="inline-flex cursor-pointer items-center gap-1 hover:text-slate-800"
                    >
                      Customer
                      <ArrowUpDown className="h-3 w-3 opacity-70" />
                    </button>
                  </th>
                  <th className="px-4 py-3 w-36 text-right">
                    <button
                      type="button"
                      onClick={() => toggleSort('total_cents')}
                      className="inline-flex cursor-pointer items-center justify-end gap-1 hover:text-slate-800"
                    >
                      Total (CAD)
                      <ArrowUpDown className="h-3 w-3 opacity-70" />
                    </button>
                  </th>
                  <th className="px-4 py-3 w-80 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {quotes.map((q) => (
                  <tr key={q.id} className="bg-white transition-colors hover:bg-slate-50/70">
                    <td className="px-4 py-3 text-left font-mono text-xs font-semibold text-[#084091]">
                      {q.quote_number}
                    </td>
                    <td className="px-4 py-3 text-left font-mono text-xs tabular-nums text-slate-500">
                      {q.quote_date}
                    </td>
                    <td className="px-4 py-3 text-left text-sm font-medium text-slate-900">
                      {q.customer_name || <span className="text-slate-400">Walk-in / General</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs font-semibold tabular-nums text-[#2a6f3b]">
                      {formatCAD(q.total_cents)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleViewQuote(q.id)}
                          className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap transition-colors"
                        >
                          <Eye className="h-3 w-3 text-[#084091]" />
                          View / Print
                        </button>
                        {canExport && (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                downloadProtectedFile(
                                  `/api/quotes/${q.id}/export/excel`,
                                  `${q.quote_number}.xlsx`
                                ).catch((err) =>
                                  onNotify('error', err instanceof Error ? err.message : 'Export failed.')
                                )
                              }
                              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap transition-colors"
                              title="Export Excel"
                            >
                              <FileSpreadsheet className="h-3 w-3 text-[#2a6f3b]" />
                              XLS
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                downloadProtectedFile(
                                  `/api/quotes/${q.id}/export/pdf`,
                                  `${q.quote_number}.pdf`
                                ).catch((err) =>
                                  onNotify('error', err instanceof Error ? err.message : 'Export failed.')
                                )
                              }
                              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap transition-colors"
                              title="Export PDF"
                            >
                              <FileText className="h-3 w-3 text-[#084091]" />
                              PDF
                            </button>
                          </>
                        )}
                        {canManage && canCreateQuote && (
                          <button
                            type="button"
                            onClick={() => onCopyToNewQuote(q.id)}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[#2a6f3b]/40 bg-white px-2.5 py-1.5 text-xs font-medium text-[#2a6f3b] hover:bg-[#2a6f3b] hover:text-white whitespace-nowrap transition-colors"
                            title="Copy to new quote using current prices"
                          >
                            <Copy className="h-3 w-3" />
                            Copy
                          </button>
                        )}
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(q)}
                            className="inline-flex cursor-pointer items-center rounded-lg border border-red-200/80 bg-white p-1.5 text-red-600 hover:bg-red-50 transition-colors"
                            title="Delete issued quote"
                            aria-label={`Delete quote ${q.quote_number}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmModal
        open={deleteTarget !== null}
        title="Delete Issued Quote?"
        message={`Are you sure you want to permanently delete issued quote ${deleteTarget?.quote_number ?? ''}? This cannot be undone, and future quote numbers will continue incrementing without reusing this number.`}
        confirmLabel="Delete Quote"
        tone="danger"
        busy={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
