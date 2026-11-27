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
import { isPreview } from '../../shared/preview.ts';
import { formatSizeLabel, noSizeResolution, resolvePricePerLfCents } from '../../shared/size.ts';
import type {
  IssuedQuoteDetail,
  MetalColor,
  MetalProduct,
  ProductMaterial,
  ProductMaterialSize,
  QuoteDraftItem,
  QuoteDraftState,
  QuotePayloadItem,
  SizeFormInput,
} from '../types';
import { apiFetch } from '../utils/api';
import { centsToDollarsInput, dollarsInputToCents, downloadBlobResponse, formatCAD } from '../utils/format';
import { validateSize } from '../../shared/sizeValidation.ts';
import { ProductThumbnail } from './ProductThumbnail';

interface CustomerQuoteViewProps {
  draft: QuoteDraftState;
  onChangeDraft: (next: QuoteDraftState) => void;
  products: MetalProduct[];
  colors: MetalColor[];
  canExport?: boolean;
  /** Catalog-manage permission: without it the "add size" option is not shown at all. */
  canManageCatalog?: boolean;
  /** Reflects a Size just saved to the catalog into the local products state. */
  onMaterialSizeAdded?: (
    productId: number,
    materialId: number,
    added: { size: ProductMaterialSize; material: ProductMaterial }
  ) => void;
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
  canManageCatalog = false,
  onMaterialSizeAdded,
  onQuoteIssued,
  onClearDraftConfirmed,
  onNotify,
}: CustomerQuoteViewProps) {
  const [issuing, setIssuing] = useState(false);
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // The inline "add size" form open on one row: which row, its fields, and its error.
  const [addSizeRowKey, setAddSizeRowKey] = useState<string | null>(null);
  const [addSizeFields, setAddSizeFields] = useState<SizeFormInput>({ price: '', width: '', gauge: '', length: '' });
  const [addSizeError, setAddSizeError] = useState<string | null>(null);
  const [addSizeSaving, setAddSizeSaving] = useState(false);

  // The option exists only for catalog managers, and only when a saved Size can be
  // reflected into the local catalog state (App passes both together).
  const canAddSize = canManageCatalog && Boolean(onMaterialSizeAdded);

  // A Preview — a Product with no Material Types — has nothing to price a Line from, so it
  // never reaches the picker. It becomes selectable as soon as its first Material Type is saved.
  const availableProducts = products.filter((p) => p.is_available === 1 && !isPreview(p.materials));
  const availableColors = colors.filter((c) => c.is_available === 1);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const colorById = useMemo(() => new Map(colors.map((c) => [c.id, c])), [colors]);

  const addProductRow = () => {
    setValidationError(null);
    const nextItem: QuoteDraftItem = {
      rowKey: `row-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      product_id: null,
      material_type: '',
      sizeResolution: noSizeResolution(),
      color_id: null,
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

  const closeAddSizeFor = (rowKey: string) => {
    setAddSizeRowKey((current) => (current === rowKey ? null : current));
  };

  const removeRow = (rowKey: string) => {
    setValidationError(null);
    closeAddSizeFor(rowKey);
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

    // The Size list is exactly the selected Material Type's saved Sizes; a Size deleted
    // from the catalog after selection is flagged, the way a deleted Color already is.
    const materialSizes = selectedMaterial?.sizes ?? [];
    const selectedSize =
      item.sizeResolution.size_id !== null
        ? materialSizes.find((s) => s.id === item.sizeResolution.size_id) ?? null
        : null;
    const hasSizeIssue =
      Boolean(item.sizeResolution.sizeIssue) ||
      (item.sizeResolution.size_id !== null && selectedMaterial !== null && selectedSize === null);
    const sizeRequired = selectedMaterial !== null && materialSizes.length > 0;

    const productAvailable = Boolean(product && product.is_available === 1);
    const productIsPreview = Boolean(product && isPreview(productMaterials));
    const colorAvailable = Boolean(color && color.is_available === 1);

    // A Preview has nothing to quote from, so it is never usable, however much stock it has.
    const productUsable = productAvailable && !productIsPreview;
    const hasProductIssue = Boolean(item.productIssue) || (item.product_id !== null && !productUsable);
    const hasColorIssue = Boolean(item.colorIssue) || (item.color_id !== null && !colorAvailable);

    // Base price comes from the shared resolver: selected Size, else Material Type,
    // else the legacy product price (products that carry no material types).
    const basePriceCents = resolvePricePerLfCents({
      size: selectedSize,
      materialType: selectedMaterial,
      product,
      materialTypes: productMaterials,
    });
    const colorPriceCents = color ? color.price_per_lf_cents : null;

    const combinedPriceCents =
      productUsable && colorAvailable && basePriceCents !== null && colorPriceCents !== null
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
      materialSizes,
      selectedSize,
      hasSizeIssue,
      sizeRequired,
      basePriceCents,
      hasMaterialIssue,
      productAvailable,
      productIsPreview,
      productUsable,
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
  const hasAnySelectionError = computedRows.some(
    (r) => r.hasProductIssue || r.hasSizeIssue || r.hasColorIssue
  );

  const anyRowHasColorSelected = computedRows.some(
    (r) => (r.colorAvailable && r.productAvailable) || r.hasColorIssue
  );

  // --- Add a Size to the line's Material Type without leaving the quote ---------------

  const startAddSize = (row: (typeof computedRows)[number]) => {
    setAddSizeRowKey(row.item.rowKey);
    // A new Size starts at the Type's price, like the catalog editor's "Add size".
    setAddSizeFields({
      price: row.selectedMaterial ? centsToDollarsInput(row.selectedMaterial.price_per_lf_cents) : '',
      width: '',
      gauge: '',
      length: '',
    });
    setAddSizeError(null);
  };

  const cancelAddSize = () => {
    setAddSizeRowKey(null);
    setAddSizeError(null);
  };

  const handleSaveNewSize = async (row: (typeof computedRows)[number]) => {
    const product = row.product;
    const material = row.selectedMaterial;
    if (!product || !material || !onMaterialSizeAdded) return;

    // Validated exactly as in the catalog editor, numbered after the Sizes the Type
    // already has; the server re-validates with the same wording before writing.
    const seenLabels = new Set(
      row.materialSizes
        .map((s) => formatSizeLabel(s)?.toLowerCase())
        .filter((label): label is string => Boolean(label))
    );
    const result = validateSize({
      materialName: material.name,
      sizeNumber: row.materialSizes.length + 1,
      priceCents: dollarsInputToCents(addSizeFields.price),
      dimensions: { gauge: addSizeFields.gauge, width_in: addSizeFields.width, length_ft: addSizeFields.length },
      seenLabels,
    });
    if (!result.ok) {
      setAddSizeError(result.error);
      return;
    }

    setAddSizeSaving(true);
    setAddSizeError(null);
    try {
      const res = await apiFetch(`/api/products/${product.id}/materials/${material.id}/sizes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.size),
      });
      const data = (await res.json()) as {
        size: ProductMaterialSize;
        material: ProductMaterial;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to add size.');
      }

      // The saved Size reaches the local catalog at once, so the line selects it and the
      // total updates without a reload; the write persists for every later quote.
      onMaterialSizeAdded(product.id, material.id, data);
      updateRow(row.item.rowKey, {
        sizeResolution: {
          size_id: data.size.id,
          sizeIssue: null,
          fallbackSizeLabel: formatSizeLabel(data.size),
        },
      });
      setAddSizeRowKey(null);
      onNotify(
        'success',
        `Size ${formatSizeLabel(data.size) ?? `#${data.size.id}`} added to ${material.name} and saved to the catalog.`
      );
    } catch (err) {
      setAddSizeError(err instanceof Error ? err.message : 'Failed to add size.');
    } finally {
      setAddSizeSaving(false);
    }
  };

  const validateBeforeSubmit = (): QuotePayloadItem[] | null => {
    if (draft.items.length === 0) {
      setValidationError('Add at least one product before issuing or exporting.');
      return null;
    }

    const payloadItems: QuotePayloadItem[] = [];
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
      if (r.hasSizeIssue) {
        setValidationError(
          `Line #${i + 1}: Size "${r.item.sizeResolution.fallbackSizeLabel ?? `#${r.item.sizeResolution.size_id}`}}" is no longer available — please select a replacement.`
        );
        return null;
      }
      if (r.sizeRequired && r.item.sizeResolution.size_id === null) {
        setValidationError(
          `Line #${i + 1}: Please select a Size — material type "${r.item.material_type.trim()}" has sizes.`
        );
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
      payloadItems.push({
        product_id: r.item.product_id,
        material_type: r.item.material_type.trim() || null,
        size_id: r.item.sizeResolution.size_id,
        color_id: r.item.color_id,
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
          seller_name: draft.seller_name.trim() || null,
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
          seller_name: draft.seller_name.trim() || null,
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
      <div className="ui-card p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-3 lg:max-w-2xl">
            <div>
              <label className="ui-label">
                Customer Name <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                type="text"
                maxLength={120}
                value={draft.customer_name}
                onChange={(e) => onChangeDraft({ ...draft, customer_name: e.target.value })}
                placeholder="First & Last Name"
                className="ui-input"
              />
            </div>

            <div>
              <label className="ui-label">
                Seller Name <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                type="text"
                maxLength={120}
                value={draft.seller_name}
                onChange={(e) => onChangeDraft({ ...draft, seller_name: e.target.value })}
                placeholder="First & Last Name"
                className="ui-input"
              />
            </div>

            <div>
              <label className="ui-label">Quote Date</label>
              <input
                type="date"
                value={draft.quote_date}
                onChange={(e) => onChangeDraft({ ...draft, quote_date: e.target.value })}
                className="ui-input font-mono"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {draft.items.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={onClearDraftConfirmed}
                  className="ui-btn-secondary"
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
                      className="ui-btn-secondary"
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5 text-[#2a6f3b]" />
                      {exporting === 'excel' ? 'Exporting...' : 'Export Excel'}
                    </button>
                    <button
                      type="button"
                      disabled={exporting !== null}
                      onClick={() => handleExportDraft('pdf')}
                      className="ui-btn-secondary"
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
                  className="ui-btn-green"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {issuing ? 'Issuing Quote...' : 'Issue Quote'}
                </button>
              </>
            )}
          </div>
        </div>

        {draft.copiedFromQuoteNumber && (
          <div className="mt-3.5 flex items-center gap-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
            <span className="rounded-full bg-[#eef4fc] px-2.5 py-0.5 font-semibold text-[#084091]">
              Copied from Quote {draft.copiedFromQuoteNumber}
            </span>
            <span>Prices refreshed from current Products and Colors tables.</span>
          </div>
        )}
      </div>

      {/* Warnings / Errors */}
      {hasAnySelectionError && (
        <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <div>
            <span className="font-semibold">Action required before issuing:</span> One or more
            items from the copied quote are no longer available or were deleted. Please select a
            replacement in the highlighted red cells below.
          </div>
        </div>
      )}

      {validationError && (
        <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <span>{validationError}</span>
        </div>
      )}

      {/* Working Quote Table */}
      <div className="ui-card overflow-hidden">
        {draft.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <h3 className="text-xl font-semibold text-slate-900">Start a Customer Quote</h3>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
              Add one or more products from your catalog. For each item, choose the product, then its material type, size, and color, and finally enter the linear feet to calculate the total price in CAD
            </p>
            <button
              type="button"
              onClick={addProductRow}
              disabled={availableProducts.length === 0}
              className="ui-btn-primary mt-5 px-5 py-2.5 text-sm"
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
                  <tr className="ui-table-head">
                    <th className="px-4 py-3 w-12 text-left">#</th>
                    <th className="px-4 py-3 min-w-[260px] text-left">Product</th>
                    <th className="px-4 py-3 min-w-[150px] text-left">Material Type</th>
                    <th className="px-4 py-3 min-w-[190px] text-left">Size</th>
                    <th className="px-4 py-3 min-w-[210px] text-left">Color</th>
                    {anyRowHasColorSelected && (
                      <>
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
                <tbody className="divide-y divide-slate-100">
                  {computedRows.map((row, idx) => {
                    const { item, product, color, productMaterials, colorAvailable } = row;
                    const showProductDetails = Boolean(product && row.productUsable);
                    const showColorStage = showProductDetails || row.hasProductIssue;
                    const showPricingAndLfStage =
                      (showProductDetails && colorAvailable && color) || row.hasColorIssue;

                    return (
                      <tr
                        key={item.rowKey}
                        className="bg-white transition-colors hover:bg-slate-50/60"
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
                                closeAddSizeFor(item.rowKey);
                                updateRow(item.rowKey, {
                                  product_id: val,
                                  productIssue: null,
                                  material_type: '',
                                  sizeResolution: noSizeResolution(),
                                });
                              }}
                              className={`w-full rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-colors focus:outline-none ${
                                row.hasProductIssue
                                  ? 'border-red-500 bg-white text-red-800'
                                  : 'border-slate-300/90 bg-white text-slate-900 focus:border-[#084091] focus:ring-3 focus:ring-[#084091]/12'
                              }`}
                            >
                              <option value="">-- Select product --</option>
                              {availableProducts.map((p) => {
                                // Every product here has Material Types: a Preview is never offered.
                                const mats = p.materials;
                                const priceLabel = `${mats.length} material${
                                  mats.length === 1 ? '' : 's'
                                } · from ${formatCAD(
                                  Math.min(...mats.map((m) => m.price_per_lf_cents))
                                )}/lf`;
                                return (
                                  <option key={p.id} value={p.id}>
                                    {p.name} ({priceLabel})
                                  </option>
                                );
                              })}
                            </select>

                            {row.hasProductIssue && (
                              <div className="text-[11px] font-semibold text-red-700">
                                {row.productIsPreview ? (
                                  <>
                                    Product &ldquo;{product?.name ?? item.fallbackProductName}&rdquo; has
                                    no material types — a Preview cannot be quoted. Please select a
                                    replacement.
                                  </>
                                ) : (
                                  <>
                                    Product &ldquo;{item.fallbackProductName}&rdquo; is no longer
                                    available — please select a replacement.
                                  </>
                                )}
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
                                {row.basePriceCents !== null && (
                                  <span className="font-mono text-[11px] text-slate-500">
                                    ({formatCAD(row.basePriceCents)}/lf)
                                  </span>
                                )}
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
                                onChange={(e) => {
                                  closeAddSizeFor(item.rowKey);
                                  updateRow(item.rowKey, {
                                    material_type: e.target.value,
                                    sizeResolution: noSizeResolution(),
                                  });
                                }}
                                className={`w-full rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-colors focus:outline-none ${
                                  row.hasMaterialIssue
                                    ? 'border-red-500 bg-white text-red-800'
                                    : 'border-slate-300/90 bg-white text-slate-900 focus:border-[#084091] focus:ring-3 focus:ring-[#084091]/12'
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

                        {/* Step 1c: Size selection — exactly the sizes saved for the selected
                            material type. Required when the type has sizes; a type without
                            sizes shows "No sizes (Add or Skip)" and quotes at its
                            general price. */}
                        <td
                          className={`px-4 py-3 align-top text-left ${
                            row.hasSizeIssue ? 'bg-red-50' : ''
                          }`}
                        >
                          {showColorStage ? (
                            row.selectedMaterial ? (
                              <div className="space-y-2">
                                {row.materialSizes.length > 0 ? (
                                  <>
                                    <select
                                      value={item.sizeResolution.size_id ?? ''}
                                      onChange={(e) => {
                                        const val = e.target.value ? Number(e.target.value) : null;
                                        const size =
                                          val !== null
                                            ? row.materialSizes.find((s) => s.id === val) ?? null
                                            : null;
                                        updateRow(item.rowKey, {
                                          sizeResolution: {
                                            size_id: val,
                                            sizeIssue: null,
                                            fallbackSizeLabel: size ? formatSizeLabel(size) : null,
                                          },
                                        });
                                      }}
                                      className={`w-full rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-colors focus:outline-none ${
                                        row.hasSizeIssue
                                          ? 'border-red-500 bg-white text-red-800'
                                          : 'border-slate-300/90 bg-white text-slate-900 focus:border-[#084091] focus:ring-3 focus:ring-[#084091]/12'
                                      }`}
                                    >
                                      <option value="">-- Select size --</option>
                                      {row.materialSizes.map((s) => (
                                        <option key={s.id} value={s.id}>
                                          {formatSizeLabel(s) ?? `#${s.id}`}
                                        </option>
                                      ))}
                                    </select>

                                    {row.hasSizeIssue && (
                                      <div className="text-[11px] font-semibold text-red-700">
                                        Size &ldquo;
                                        {item.sizeResolution.fallbackSizeLabel ?? `#${item.sizeResolution.size_id}`}
                                        &rdquo; no longer available, please select a new one.
                                      </div>
                                    )}

                                    {row.selectedSize && !row.hasSizeIssue && (
                                      <div className="flex items-center gap-2 pt-0.5">
                                        <span className="text-xs font-medium text-slate-800">
                                          {formatSizeLabel(row.selectedSize)}
                                        </span>
                                        <span className="font-mono text-[11px] text-slate-500">
                                          ({formatCAD(row.selectedSize.price_per_lf_cents)}/lf)
                                        </span>
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <span className="block text-xs text-slate-400">
                                    No sizes (Add or Skip)
                                  </span>
                                )}

                                {/* A Material Type missing the needed Size offers to add one —
                                    only for users who can manage the catalog. */}
                                {canAddSize &&
                                  (addSizeRowKey === item.rowKey ? (
                                    <div className="space-y-1.5 rounded-md border border-slate-200 bg-[#f7f7f7] p-2">
                                      {addSizeError && (
                                        <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700">
                                          {addSizeError}
                                        </div>
                                      )}
                                      <div className="flex items-center gap-1">
                                        <input
                                          type="text"
                                          maxLength={20}
                                          value={addSizeFields.gauge}
                                          onChange={(e) =>
                                            setAddSizeFields((f) => ({ ...f, gauge: e.target.value }))
                                          }
                                          placeholder="Gauge"
                                          title="Gauge — optional"
                                          aria-label={`Gauge for new size of ${row.selectedMaterial.name}`}
                                          className="w-[64px] rounded-md border border-slate-300 bg-white px-2 py-1 text-center font-mono text-xs tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                                        />
                                        <input
                                          type="number"
                                          step="0.01"
                                          min="0"
                                          value={addSizeFields.width}
                                          onChange={(e) =>
                                            setAddSizeFields((f) => ({ ...f, width: e.target.value }))
                                          }
                                          placeholder='Width (in)'
                                          title="Width (in) — optional"
                                          aria-label={`Width (in) for new size of ${row.selectedMaterial.name}`}
                                          className="w-[76px] rounded-md border border-slate-300 bg-white px-2 py-1 text-right font-mono text-xs tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                                        />
                                        <input
                                          type="number"
                                          step="0.01"
                                          min="0"
                                          value={addSizeFields.length}
                                          onChange={(e) =>
                                            setAddSizeFields((f) => ({ ...f, length: e.target.value }))
                                          }
                                          placeholder="Length (ft)"
                                          title="Length (ft) — optional"
                                          aria-label={`Length (ft) for new size of ${row.selectedMaterial.name}`}
                                          className="w-[76px] rounded-md border border-slate-300 bg-white px-2 py-1 text-right font-mono text-xs tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                                        />
                                        <div className="relative w-[88px] shrink-0">
                                          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                                            $
                                          </span>
                                          <input
                                            type="number"
                                            step="0.01"
                                            min="0"
                                            value={addSizeFields.price}
                                            onChange={(e) =>
                                              setAddSizeFields((f) => ({ ...f, price: e.target.value }))
                                            }
                                            placeholder="0.00"
                                            title="Price per linear ft for this size (CAD)"
                                            aria-label={`Price per linear ft for new size of ${row.selectedMaterial.name}`}
                                            className="w-full rounded-md border border-slate-300 bg-white py-1 pl-5 pr-2 text-right font-mono text-xs tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                                          />
                                        </div>
                                      </div>
                                      <div className="flex items-center justify-end gap-1.5">
                                        <button
                                          type="button"
                                          onClick={cancelAddSize}
                                          disabled={addSizeSaving}
                                          className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                                        >
                                          Cancel
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => void handleSaveNewSize(row)}
                                          disabled={addSizeSaving}
                                          className="rounded bg-[#084091] px-2 py-1 text-[11px] font-semibold text-white hover:bg-[#063273] disabled:bg-slate-400"
                                        >
                                          {addSizeSaving ? 'Saving...' : 'Save size'}
                                        </button>
                                      </div>
                                      <p className="text-[10px] leading-snug text-slate-500">
                                        Saved to the catalog and selected on this line.
                                      </p>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => startAddSize(row)}
                                      className="inline-flex items-center gap-1 rounded border border-[#084091] bg-white px-2 py-0.5 text-[11px] font-semibold text-[#084091] hover:bg-[#084091] hover:text-white transition-colors"
                                    >
                                      <Plus className="h-3 w-3" />
                                      Add size
                                    </button>
                                  ))}
                              </div>
                            ) : (
                              <span className="block text-xs text-slate-400">
                                Select material type first
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
                                className={`w-full rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-colors focus:outline-none ${
                                  row.hasColorIssue
                                    ? 'border-red-500 bg-white text-red-800'
                                    : 'border-slate-300/90 bg-white text-slate-900 focus:border-[#084091] focus:ring-3 focus:ring-[#084091]/12'
                                }`}
                              >
                                <option value="">-- Select color --</option>
                                {availableColors.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name}
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

                        {/* Step 3: Linear Feet input, Additional Costs */}
                        {anyRowHasColorSelected && (
                          <>
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
                  <tr className="border-t border-slate-200 bg-slate-50/90">
                    <td colSpan={anyRowHasColorSelected ? 7 : 5} className="px-4 py-3.5 text-left">
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <button
                          type="button"
                          onClick={addProductRow}
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#084091] bg-white px-3.5 py-2 text-xs font-semibold text-[#084091] hover:bg-[#084091] hover:text-white transition-colors"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add product
                        </button>
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <span>{draft.items.length} item(s)</span>
                          <span className="text-slate-300" aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {totalLinearFeet.toLocaleString('en-CA', { maximumFractionDigits: 2 })} lf total
                          </span>
                        </div>
                      </div>
                    </td>

                    {anyRowHasColorSelected && (
                      <>
                        <td className="px-4 py-3.5 text-right text-xs font-bold uppercase tracking-wide text-slate-600">
                          Grand Total
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
