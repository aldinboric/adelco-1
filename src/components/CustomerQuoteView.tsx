import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  IssuedQuoteDetail,
  MetalColor,
  MetalProduct,
  QuoteDraftItem,
  QuoteDraftState,
} from '../types';
import { apiFetch } from '../utils/api';
import { dollarsInputToCents, downloadBlobResponse, formatCAD } from '../utils/format';
import { ProductThumbnail } from './ProductThumbnail';

interface CustomerQuoteViewProps {
  draft: QuoteDraftState;
  onChangeDraft: (next: QuoteDraftState) => void;
  products: MetalProduct[];
  colors: MetalColor[];
  canExport?: boolean;
  onQuoteIssued: (detail: IssuedQuoteDetail) => void;
  onClearDraftConfirmed: () => void;
  onNotify: (type: 'success' | 'error', text: string) => void;
}

export function CustomerQuoteView({
  draft,
  onChangeDraft,
  products,
  colors,
  canExport = true,
  onQuoteIssued,
  onClearDraftConfirmed,
  onNotify,
}: CustomerQuoteViewProps) {
  const [issuing, setIssuing] = useState(false);
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const availableProducts = products.filter((p) => p.is_available === 1);
  const availableColors = colors.filter((c) => c.is_available === 1);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const colorById = useMemo(() => new Map(colors.map((c) => [c.id, c])), [colors]);

  const addProductRow = () => {
    setValidationError(null);
    const nextItem: QuoteDraftItem = {
      rowKey: `row-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      product_id: null,
      material_type: '',
      color_id: null,
      width_input: '',
      gauge_input: '',
      length_input: '',
      linear_feet_input: '',
      additional_costs_input: '',
      additional_costs_description: '',
      note_input: '',
    };
    onChangeDraft({
      ...draft,
      items: [...draft.items, nextItem],
    });
  };

  const updateRow = (rowKey: string, patch: Partial<QuoteDraftItem>) => {
    setValidationError(null);
    onChangeDraft({
      ...draft,
      items: draft.items.map((item) => (item.rowKey === rowKey ? { ...item, ...patch } : item)),
    });
  };

  const removeRow = (rowKey: string) => {
    setValidationError(null);
    onChangeDraft({
      ...draft,
      items: draft.items.filter((item) => item.rowKey !== rowKey),
    });
  };

  // Compute live line metrics (memoized — only recompute when draft or catalogs change)
  const computedRows = useMemo(() => draft.items.map((item) => {
    const product = item.product_id ? productById.get(item.product_id) ?? null : null;
    const color = item.color_id ? colorById.get(item.color_id) ?? null : null;

    const productMaterials = product?.materials ?? [];
    const hasMaterialIssue = Boolean(
      product && productMaterials.length > 0 && !item.material_type.trim()
    );
    const selectedMaterial =
      productMaterials.find((m) => m.name === item.material_type.trim()) ?? null;

    const productAvailable = Boolean(product && product.is_available === 1);
    const colorAvailable = Boolean(color && color.is_available === 1);

    const hasProductIssue = Boolean(item.productIssue) || (item.product_id !== null && !productAvailable);
    const hasColorIssue = Boolean(item.colorIssue) || (item.color_id !== null && !colorAvailable);

    // Base price: the selected material type's own price per lf; products without
    // material types fall back to the product-level price (legacy behavior).
    const basePriceCents = selectedMaterial
      ? selectedMaterial.price_per_lf_cents
      : productMaterials.length === 0 && product
        ? product.price_per_lf_cents
        : null;
    const colorPriceCents = color ? color.price_per_lf_cents : null;

    const combinedPriceCents =
      productAvailable && colorAvailable && basePriceCents !== null && colorPriceCents !== null
        ? basePriceCents + colorPriceCents
        : null;

    const parsedLf = Number(item.linear_feet_input);
    const validLf = Number.isFinite(parsedLf) && parsedLf > 0 ? parsedLf : 0;

    const trimmedAddCosts = item.additional_costs_input.trim();
    const parsedAddCostsCents =
      trimmedAddCosts === '' ? 0 : dollarsInputToCents(trimmedAddCosts);
    const hasInvalidAddCosts = parsedAddCostsCents === null;
    const validAddCostsCents = parsedAddCostsCents ?? 0;

    const lineTotalCents =
      combinedPriceCents !== null && validLf > 0
        ? Math.round(validLf * combinedPriceCents) + validAddCostsCents
        : 0;

    return {
      item,
      product,
      color,
      productMaterials,
      selectedMaterial,
      basePriceCents,
      hasMaterialIssue,
      productAvailable,
      colorAvailable,
      hasProductIssue,
      hasColorIssue,
      combinedPriceCents,
      validLf,
      hasInvalidAddCosts,
      validAddCostsCents,
      lineTotalCents,
    };
  }), [draft.items, productById, colorById]);

  const grandTotalCents = computedRows.reduce((acc, r) => acc + r.lineTotalCents, 0);
  const totalLinearFeet = computedRows.reduce((acc, r) => acc + r.validLf, 0);
  const hasAnySelectionError = computedRows.some((r) => r.hasProductIssue || r.hasColorIssue);

  const anyRowHasColorSelected = computedRows.some(
    (r) => (r.colorAvailable && r.productAvailable) || r.hasColorIssue
  );

  const validateBeforeSubmit = (): Array<{
    product_id: number;
    material_type: string | null;
    color_id: number;
    width_in: number | null;
    gauge: string | null;
    length_ft: number | null;
    linear_feet: number;
    additional_costs_cents: number;
    additional_costs_description: string | null;
    note: string | null;
  }> | null => {
    if (draft.items.length === 0) {
      setValidationError('Add at least one product before issuing or exporting.');
      return null;
    }

    const payloadItems: Array<{
      product_id: number;
      material_type: string | null;
      color_id: number;
      width_in: number | null;
      gauge: string | null;
      length_ft: number | null;
      linear_feet: number;
      additional_costs_cents: number;
      additional_costs_description: string | null;
      note: string | null;
    }> = [];
    for (let i = 0; i < computedRows.length; i++) {
      const r = computedRows[i];
      if (r.hasProductIssue || !r.productAvailable || !r.item.product_id) {
        setValidationError(`Line #${i + 1}: Please select an available product.`);
        return null;
      }
      if (r.hasMaterialIssue) {
        setValidationError(`Line #${i + 1}: Please select a Material Type.`);
        return null;
      }
      if (r.hasColorIssue || !r.colorAvailable || !r.item.color_id) {
        setValidationError(`Line #${i + 1}: Please select an available color.`);
        return null;
      }
      if (r.validLf <= 0) {
        setValidationError(`Line #${i + 1}: Please enter Linear Feet greater than 0.`);
        return null;
      }
      if (r.hasInvalidAddCosts) {
        setValidationError(
          `Line #${i + 1}: Please enter a valid non-negative amount for Additional Costs.`
        );
        return null;
      }
      const widthRaw = r.item.width_input.trim();
      const lengthRaw = r.item.length_input.trim();
      const widthNum = Number(widthRaw);
      const lengthNum = Number(lengthRaw);
      if (widthRaw !== '' && (!Number.isFinite(widthNum) || widthNum <= 0)) {
        setValidationError(`Line #${i + 1}: Width (in) must be a positive number.`);
        return null;
      }
      if (lengthRaw !== '' && (!Number.isFinite(lengthNum) || lengthNum <= 0)) {
        setValidationError(`Line #${i + 1}: Length (ft) must be a positive number.`);
        return null;
      }
      payloadItems.push({
        product_id: r.item.product_id,
        material_type: r.item.material_type.trim() || null,
        color_id: r.item.color_id,
        width_in: widthRaw !== '' ? widthNum : null,
        gauge: r.item.gauge_input.trim() || null,
        length_ft: lengthRaw !== '' ? lengthNum : null,
        linear_feet: r.validLf,
        additional_costs_cents: r.validAddCostsCents,
        additional_costs_description: r.item.additional_costs_description.trim() || null,
        note: r.item.note_input.trim() ? r.item.note_input.trim().slice(0, 500) : null,
      });
    }
    return payloadItems;
  };

  const handleIssueQuote = async () => {
    setValidationError(null);
    const items = validateBeforeSubmit();
    if (!items) return;

    setIssuing(true);
    try {
      const res = await apiFetch('/api/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quote_date: draft.quote_date,
          customer_name: draft.customer_name.trim() || null,
          items,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to issue quote.');
      }
      onNotify('success', `Quote ${data.quote.quote_number} issued and saved.`);
      onQuoteIssued(data as IssuedQuoteDetail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to issue quote.';
      setValidationError(msg);
      onNotify('error', msg);
    } finally {
      setIssuing(false);
    }
  };

  const handleExportDraft = async (format: 'excel' | 'pdf') => {
    setValidationError(null);
    const items = validateBeforeSubmit();
    if (!items) return;

    setExporting(format);
    try {
      const res = await apiFetch(`/api/quotes/draft/export/${format}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quote_date: draft.quote_date,
          customer_name: draft.customer_name.trim() || null,
          items,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Export failed.');
      }
      const blob = await res.blob();
      const ext = format === 'excel' ? 'xlsx' : 'pdf';
      downloadBlobResponse(blob, `AdelCo-Draft-Quote-${draft.quote_date}.${ext}`);
      onNotify('success', `Draft quote exported to ${format.toUpperCase()}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Export failed.';
      setValidationError(msg);
      onNotify('error', msg);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Quote Header Metadata Bar */}
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2 lg:max-w-xl">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                Customer Name <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                type="text"
                maxLength={120}
                value={draft.customer_name}
                onChange={(e) => onChangeDraft({ ...draft, customer_name: e.target.value })}
                placeholder="First & Last Name"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-[#084091] focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                Quote Date
              </label>
              <input
                type="date"
                value={draft.quote_date}
                onChange={(e) => onChangeDraft({ ...draft, quote_date: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-[#084091] focus:outline-none"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {draft.items.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={onClearDraftConfirmed}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-[#f7f7f7] whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Clear Draft
                </button>
                {canExport && (
                  <>
                    <button
                      type="button"
                      disabled={exporting !== null}
                      onClick={() => handleExportDraft('excel')}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-[#f7f7f7] whitespace-nowrap shrink-0"
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5 text-[#2a6f3b]" />
                      {exporting === 'excel' ? 'Exporting...' : 'Export Excel'}
                    </button>
                    <button
                      type="button"
                      disabled={exporting !== null}
                      onClick={() => handleExportDraft('pdf')}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-[#f7f7f7] whitespace-nowrap shrink-0"
                    >
                      <FileText className="h-3.5 w-3.5 text-[#084091]" />
                      {exporting === 'pdf' ? 'Exporting...' : 'Export PDF'}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  disabled={issuing || hasAnySelectionError}
                  onClick={handleIssueQuote}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#2a6f3b] px-4 py-2 text-xs font-semibold text-white hover:bg-[#21572e] disabled:bg-slate-400 whitespace-nowrap shrink-0 transition-colors"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {issuing ? 'Issuing Quote...' : 'Issue Quote'}
                </button>
              </>
            )}
          </div>
        </div>

        {draft.copiedFromQuoteNumber && (
          <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
            <span className="font-semibold text-[#084091]">
              Copied from Quote {draft.copiedFromQuoteNumber}
            </span>
            <span aria-hidden="true">·</span>
            <span>Prices refreshed from current Products and Colors tables.</span>
          </div>
        )}
      </div>

      {/* Warnings / Errors */}
      {hasAnySelectionError && (
        <div className="flex items-start gap-2.5 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <div>
            <span className="font-semibold">Action required before issuing:</span> One or more
            items from the copied quote are no longer available or were deleted. Please select a
            replacement in the highlighted red cells below.
          </div>
        </div>
      )}

      {validationError && (
        <div className="flex items-start gap-2.5 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-xs font-medium text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <span>{validationError}</span>
        </div>
      )}

      {/* Working Quote Table */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {draft.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <h3 className="text-base font-semibold text-slate-900">Start a Customer Quote</h3>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
              Add one or more products from your catalog. For each item, first choose the product, then choose its color, and finally enter the linear feet to calculate the total price in CAD.
            </p>
            <button
              type="button"
              onClick={addProductRow}
              disabled={availableProducts.length === 0}
              className="mt-5 inline-flex items-center gap-2 rounded-md bg-[#084091] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#063273] disabled:bg-slate-300 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Add product
            </button>
            {availableProducts.length === 0 && (
              <p className="mt-3 text-xs font-medium text-red-600">
                No available products found. Enable or add products in Products first.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-max border-collapse text-left text-sm">
                <thead>
                  <tr className="divide-x divide-white/20 border-b border-slate-200 bg-[#084091] text-xs font-semibold text-white">
                    <th className="px-4 py-3 w-12 text-left">#</th>
                    <th className="px-4 py-3 min-w-[260px] text-left">Product</th>
                    <th className="px-4 py-3 min-w-[150px] text-left">Material Type</th>
                    <th className="px-4 py-3 min-w-[210px] text-left">Color</th>
                    <th className="px-4 py-3 min-w-[230px] text-left">Measures</th>
                    {anyRowHasColorSelected && (
                      <>
                        <th className="px-4 py-3 w-40 text-right">Total / lf (with Color)</th>
                        <th className="px-4 py-3 w-36 text-right">Linear Feet</th>
                        <th className="px-4 py-3 w-48 text-right">Additional Costs</th>
                      </>
                    )}
                    <th className="px-4 py-3 w-48 text-left">Notes</th>
                    {anyRowHasColorSelected && (
                      <th className="px-4 py-3 w-36 text-right">Total Price</th>
                    )}
                    <th className="px-4 py-3 w-14 text-right" aria-label="Remove row" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {computedRows.map((row, idx) => {
                    const { item, product, color, productMaterials, productAvailable, colorAvailable } = row;
                    const showProductDetails = productAvailable && product;
                    const showColorStage = showProductDetails || row.hasProductIssue;
                    const showPricingAndLfStage =
                      (showProductDetails && colorAvailable && color) || row.hasColorIssue;

                    return (
                      <tr
                        key={item.rowKey}
                        className={`divide-x divide-slate-200 ${idx % 2 === 1 ? 'bg-[#f7f7f7]/60' : 'bg-white'}`}
                      >
                        <td className="px-4 py-3 align-top text-left font-mono text-xs text-slate-500">
                          {idx + 1}
                        </td>

                        {/* Step 1: Product selection & info */}
                        <td
                          className={`px-4 py-3 align-top text-left ${
                            row.hasProductIssue ? 'bg-red-50' : ''
                          }`}
                        >
                          <div className="space-y-2">
                            <select
                              value={item.product_id ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null;
                                updateRow(item.rowKey, {
                                  product_id: val,
                                  productIssue: null,
                                  material_type: '',
                                });
                              }}
                              className={`w-full rounded-md border px-2.5 py-2 text-left text-xs font-medium focus:outline-none ${
                                row.hasProductIssue
                                  ? 'border-red-500 bg-white text-red-800'
                                  : 'border-slate-300 bg-white text-slate-900 focus:border-[#084091]'
                              }`}
                            >
                              <option value="">-- Select product --</option>
                              {availableProducts.map((p, pIdx) => {
                                const mats = p.materials ?? [];
                                const priceLabel =
                                  mats.length > 0
                                    ? `${mats.length} material${mats.length === 1 ? '' : 's'} · from ${formatCAD(
                                        Math.min(...mats.map((m) => m.price_per_lf_cents))
                                      )}/lf`
                                    : `${formatCAD(p.price_per_lf_cents)}/lf`;
                                return (
                                  <option key={p.id} value={p.id}>
                                    #{pIdx + 1} · {p.name} ({priceLabel})
                                  </option>
                                );
                              })}
                            </select>

                            {row.hasProductIssue && (
                              <div className="text-[11px] font-semibold text-red-700">
                                Product &ldquo;{item.fallbackProductName}&rdquo; is no longer available — please select a replacement.
                              </div>
                            )}

                            {showProductDetails && product && (
                              <div className="flex items-center gap-2.5 pt-0.5">
                                <ProductThumbnail
                                  imagePath={product.image_path}
                                  alt={product.name}
                                  sizeClass="h-9 w-9"
                                />
                                <span className="text-xs font-medium text-slate-800">
                                  {product.name}
                                </span>
                                <span className="font-mono text-[11px] text-slate-500">
                                  ({row.basePriceCents !== null ? formatCAD(row.basePriceCents) : formatCAD(product.price_per_lf_cents)}/lf)
                                </span>
                              </div>
                            )}
                          </div>
                        </td>

                        {/* Step 1b: Material Type selection (options come from the selected product) */}
                        <td className="px-4 py-3 align-top text-left">
                          {showProductDetails && product ? (
                            productMaterials.length > 0 ? (
                              <select
                                value={item.material_type}
                                onChange={(e) =>
                                  updateRow(item.rowKey, { material_type: e.target.value })
                                }
                                className={`w-full rounded-md border px-2.5 py-2 text-left text-xs font-medium focus:outline-none ${
                                  row.hasMaterialIssue
                                    ? 'border-red-500 bg-white text-red-800'
                                    : 'border-slate-300 bg-white text-slate-900 focus:border-[#084091]'
                                }`}
                              >
                                <option value="">-- Select material type --</option>
                                {productMaterials.map((m) => (
                                  <option key={m.id} value={m.name}>
                                    {m.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="block text-xs text-slate-400">
                                No materials defined for this product
                              </span>
                            )
                          ) : (
                            <span className="block text-xs text-slate-400">Select product first</span>
                          )}
                        </td>

                        {/* Step 2: Color selection (hidden until product selected) */}
                        <td
                          className={`px-4 py-3 align-top text-left ${
                            row.hasColorIssue ? 'bg-red-50' : ''
                          }`}
                        >
                          {showColorStage ? (
                            <div className="space-y-2">
                              <select
                                value={item.color_id ?? ''}
                                onChange={(e) => {
                                  const val = e.target.value ? Number(e.target.value) : null;
                                  updateRow(item.rowKey, {
                                    color_id: val,
                                    colorIssue: null,
                                  });
                                }}
                                className={`w-full rounded-md border px-2.5 py-2 text-left text-xs font-medium focus:outline-none ${
                                  row.hasColorIssue
                                    ? 'border-red-500 bg-white text-red-800'
                                    : 'border-slate-300 bg-white text-slate-900 focus:border-[#084091]'
                                }`}
                              >
                                <option value="">-- Select color --</option>
                                {availableColors.map((c, cIdx) => (
                                  <option key={c.id} value={c.id}>
                                    #{cIdx + 1} · {c.name} (+{formatCAD(c.price_per_lf_cents)}/lf)
                                  </option>
                                ))}
                              </select>

                              {row.hasColorIssue && (
                                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-red-700">
                                  {item.fallbackColorHex && (
                                    <span
                                      className="inline-block h-3 w-4 shrink-0 rounded border border-red-300"
                                      style={{ backgroundColor: item.fallbackColorHex }}
                                    />
                                  )}
                                  <span>
                                    Color &ldquo;{item.fallbackColorName}&rdquo; no longer available, please select a new one.
                                  </span>
                                </div>
                              )}

                              {colorAvailable && color && !row.hasColorIssue && (
                                <div className="flex items-center gap-2 pt-0.5">
                                  <span
                                    className="inline-block h-4 w-6 shrink-0 rounded border border-slate-200"
                                    style={{ backgroundColor: color.hex_code }}
                                  />
                                  <span className="text-xs font-medium text-slate-800">
                                    {color.name}
                                  </span>
                                  <span className="font-mono text-[11px] text-slate-500">
                                    (+{formatCAD(color.price_per_lf_cents)})
                                  </span>
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="block text-xs text-slate-400">
                              Select product first
                            </span>
                          )}
                        </td>

                        {/* Step 2b: Measures — Width (in), Gauge (ga), Length (ft).
                            Datalists offer the saved measures of the selected material type;
                            custom values are allowed and apply only to this quote. */}
                        <td className="px-4 py-3 align-top text-left">
                          {showColorStage ? (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <datalist id={`dl-width-${item.rowKey}`}>
                                {row.selectedMaterial?.width_in != null && (
                                  <option value={row.selectedMaterial.width_in} />
                                )}
                              </datalist>
                              <datalist id={`dl-gauge-${item.rowKey}`}>
                                {row.selectedMaterial?.gauge && (
                                  <option value={row.selectedMaterial.gauge} />
                                )}
                              </datalist>
                              <datalist id={`dl-length-${item.rowKey}`}>
                                {row.selectedMaterial?.length_ft != null && (
                                  <option value={row.selectedMaterial.length_ft} />
                                )}
                              </datalist>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                list={`dl-width-${item.rowKey}`}
                                value={item.width_input}
                                onChange={(e) =>
                                  updateRow(item.rowKey, { width_input: e.target.value })
                                }
                                placeholder='Width (in)'
                                title="Width (in) — saved value available for the selected material type"
                                aria-label="Width (in)"
                                className="w-[92px] rounded-md border border-slate-300 bg-white px-2 py-1.5 text-right font-mono text-xs tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                              />
                              <input
                                type="text"
                                maxLength={20}
                                list={`dl-gauge-${item.rowKey}`}
                                value={item.gauge_input}
                                onChange={(e) =>
                                  updateRow(item.rowKey, { gauge_input: e.target.value })
                                }
                                placeholder="Gauge (ga)"
                                title="Gauge (ga) — saved value available for the selected material type"
                                aria-label="Gauge (ga)"
                                className="w-[86px] rounded-md border border-slate-300 bg-white px-2 py-1.5 text-center font-mono text-xs tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                              />
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                list={`dl-length-${item.rowKey}`}
                                value={item.length_input}
                                onChange={(e) =>
                                  updateRow(item.rowKey, { length_input: e.target.value })
                                }
                                placeholder="Length (ft)"
                                title="Length (ft) — saved value available for the selected material type"
                                aria-label="Length (ft)"
                                className="w-[92px] rounded-md border border-slate-300 bg-white px-2 py-1.5 text-right font-mono text-xs tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                              />
                            </div>
                          ) : (
                            <span className="block text-xs text-slate-400">Select product first</span>
                          )}
                        </td>

                        {/* Step 3: Combined / lf, Linear Feet input, Additional Costs */}
                        {anyRowHasColorSelected && (
                          <>
                            <td className="px-4 py-3 align-top text-right font-mono text-xs font-semibold tabular-nums text-slate-900">
                              {showPricingAndLfStage && row.combinedPriceCents !== null ? (
                                <div>{formatCAD(row.combinedPriceCents)}</div>
                              ) : (
                                <span className="block text-slate-300">—</span>
                              )}
                            </td>

                            <td className="px-4 py-3 align-top text-right">
                              {showPricingAndLfStage ? (
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0.01"
                                  value={item.linear_feet_input}
                                  onChange={(e) =>
                                    updateRow(item.rowKey, { linear_feet_input: e.target.value })
                                  }
                                  placeholder="0.00"
                                  className="ml-auto block w-28 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-right font-mono text-xs tabular-nums text-slate-900 focus:border-[#084091] focus:outline-none"
                                />
                              ) : (
                                <span className="block text-xs text-slate-300">—</span>
                              )}
                            </td>

                            <td className="px-4 py-3 align-top text-right">
                              {showPricingAndLfStage ? (
                                <div className="ml-auto flex w-40 flex-col gap-1.5">
                                  <input
                                    type="text"
                                    value={item.additional_costs_description}
                                    onChange={(e) =>
                                      updateRow(item.rowKey, {
                                        additional_costs_description: e.target.value,
                                      })
                                    }
                                    placeholder="Reason / description"
                                    aria-label="Additional Costs Description"
                                    maxLength={120}
                                    className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1 text-left text-xs text-slate-800 placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                                  />
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs font-medium text-slate-400">$</span>
                                    <input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      value={item.additional_costs_input}
                                      onChange={(e) =>
                                        updateRow(item.rowKey, {
                                          additional_costs_input: e.target.value,
                                        })
                                      }
                                      placeholder="0.00"
                                      aria-label="Additional Costs"
                                      className={`w-full rounded-md border bg-white px-2.5 py-1.5 text-right font-mono text-xs tabular-nums text-slate-900 focus:outline-none ${
                                        row.hasInvalidAddCosts
                                          ? 'border-red-500 focus:border-red-600'
                                          : 'border-slate-300 focus:border-[#084091]'
                                      }`}
                                    />
                                  </div>
                                </div>
                              ) : (
                                <span className="block text-xs text-slate-300">—</span>
                              )}
                            </td>
                          </>
                        )}

                        {/* Step 3b: Notes — per-line note, printed as-is (empty stays empty) */}
                        <td className="px-4 py-3 align-top text-left">
                          <textarea
                            rows={2}
                            maxLength={500}
                            value={item.note_input}
                            onChange={(e) =>
                              updateRow(item.rowKey, { note_input: e.target.value })
                            }
                            placeholder="Note (optional)"
                            aria-label="Additional note"
                            className="mx-auto block w-[90%] resize-y rounded-md border border-slate-300 bg-white px-2 py-1.5 text-left text-xs leading-snug text-slate-800 [text-align:justify] placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                          />
                        </td>

                        {/* Step 3c: Line Total */}
                        {anyRowHasColorSelected && (
                          <>
                            <td className="px-4 py-3 align-top text-right font-mono text-sm font-semibold tabular-nums text-[#2a6f3b]">
                              {showPricingAndLfStage && row.lineTotalCents > 0 ? (
                                <div>{formatCAD(row.lineTotalCents)}</div>
                              ) : (
                                <span className="block text-xs font-normal text-slate-300">
                                  $0.00
                                </span>
                              )}
                            </td>
                          </>
                        )}

                        <td className="px-4 py-3 align-top text-right">
                          <button
                            type="button"
                            onClick={() => removeRow(item.rowKey)}
                            className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                            title="Remove line item"
                            aria-label="Remove line item"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>

                {/* Bottom Action + Grand Total Row */}
                <tfoot>
                  <tr className="divide-x divide-slate-200 border-t-2 border-slate-200 bg-[#f7f7f7]">
                    <td colSpan={anyRowHasColorSelected ? 8 : 6} className="px-4 py-3.5 text-left">
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <button
                          type="button"
                          onClick={addProductRow}
                          className="inline-flex items-center gap-1.5 rounded-md border border-[#084091] bg-white px-3.5 py-2 text-xs font-semibold text-[#084091] hover:bg-[#084091] hover:text-white transition-colors"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add product
                        </button>
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <span>{draft.items.length} item(s)</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {totalLinearFeet.toLocaleString('en-CA', { maximumFractionDigits: 2 })} lf total
                          </span>
                        </div>
                      </div>
                    </td>

                    {anyRowHasColorSelected && (
                      <>
                        <td className="px-4 py-3.5 text-right text-xs font-bold uppercase tracking-wide text-slate-600">
                          Total (CAD)
                        </td>
                        <td className="px-4 py-3.5 text-right font-mono text-base font-bold tabular-nums text-[#2a6f3b]">
                          {formatCAD(grandTotalCents)}
                        </td>
                      </>
                    )}
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
