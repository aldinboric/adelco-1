import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GripVertical,
  ImagePlus,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { isPreview, productStatus, productStatusLabel } from '../../shared/preview.ts';
import { useReorderableList } from '../hooks/useReorderableList';
import type { MetalProduct } from '../types';
import { apiFetch } from '../utils/api';
import {
  centsToDollarsInput,
  dollarsInputToCents,
  formatCAD,
  formatSizeLabel,
  getImageUrl,
  type SizeDimensions,
} from '../utils/format';
import { sizesColumnLines, sizeCountLabel } from '../utils/sizeCounts';
import { ConfirmModal } from './ConfirmModal';
import { ExportButtons } from './ExportButtons';
import { ProductThumbnail } from './ProductThumbnail';
import { TableSkeleton } from './TableSkeleton';

interface MetalProductsViewProps {
  products: MetalProduct[];
  loading: boolean;
  canManage?: boolean;
  canReorder?: boolean;
  canExport?: boolean;
  onRefresh: () => Promise<void>;
  onNotify: (type: 'success' | 'error', text: string) => void;
}

// One editable Size row inside a Material Type in the Add/Edit Product modal.
interface SizeRowDraft {
  key: string;
  price: string;
  width: string;
  gauge: string;
  length: string;
}

// One editable Material Type row. Its own price is only editable while it has no
// Sizes; with Sizes it mirrors the first one, so removing every Size stays usable.
interface MaterialRowDraft {
  key: string;
  name: string;
  price: string;
  sizes: SizeRowDraft[];
  expanded: boolean;
}

/** A Size as the product endpoints receive it. */
interface SizePayload extends SizeDimensions {
  price_per_lf_cents: number;
}

// Same sanity ceiling the server applies to a Dimension's value.
const MAX_DIMENSION_VALUE = 1_000_000;

/** Says why a Preview cannot be quoted, for the Status cell's tooltip. */
const PREVIEW_STATUS_HINT = 'No material types yet — this product cannot be quoted';

function newSizeRow(pricePrefill = ''): SizeRowDraft {
  return {
    key: `size-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    price: pricePrefill,
    width: '',
    gauge: '',
    length: '',
  };
}

function newMaterialRow(pricePrefill = '', sizes: SizeRowDraft[] = []): MaterialRowDraft {
  return {
    key: `mat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: '',
    price: pricePrefill,
    sizes,
    expanded: true,
  };
}

/** A Material Type keeps its first Size's price as the general price whenever it has Sizes. */
function mirrorTypePrice(row: MaterialRowDraft, sizes: SizeRowDraft[]): string {
  return sizes.length > 0 ? sizes[0].price : row.price;
}

function isBlankSizeRow(size: SizeRowDraft): boolean {
  return !size.price.trim() && !size.width.trim() && !size.gauge.trim() && !size.length.trim();
}

/** A row nothing has been typed into: saving with only such rows means no Material Types. */
function isEmptyMaterialRow(row: MaterialRowDraft): boolean {
  return !row.name.trim() && !row.price.trim() && row.sizes.every(isBlankSizeRow);
}

/** Mirrors the server's Size rules so the editor refuses bad input with the same wording. */
function validateSizes(
  materialName: string,
  rows: SizeRowDraft[]
): { ok: true; sizes: SizePayload[] } | { ok: false; error: string } {
  const sizes: SizePayload[] = [];
  const seenLabels = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const label = `Size #${index + 1} of "${materialName}"`;
    const priceCents = dollarsInputToCents(row.price);
    if (priceCents === null) {
      return { ok: false, error: `${label} needs a valid non-negative price per linear ft.` };
    }
    let widthIn: number | null = null;
    if (row.width.trim()) {
      const w = Number(row.width.trim());
      if (!Number.isFinite(w) || w <= 0 || w > MAX_DIMENSION_VALUE) {
        return { ok: false, error: `Width (in) for ${label} must be a positive number.` };
      }
      widthIn = w;
    }
    let lengthFt: number | null = null;
    if (row.length.trim()) {
      const l = Number(row.length.trim());
      if (!Number.isFinite(l) || l <= 0 || l > MAX_DIMENSION_VALUE) {
        return { ok: false, error: `Length (ft) for ${label} must be a positive number.` };
      }
      lengthFt = l;
    }
    const gauge = row.gauge.trim() ? row.gauge.trim().slice(0, 20) : null;

    const rendered = formatSizeLabel({ gauge, width_in: widthIn, length_ft: lengthFt });
    if (!rendered) {
      return {
        ok: false,
        error: `${label} needs at least one of gauge, width, or length.`,
      };
    }
    const labelKey = rendered.toLowerCase();
    if (seenLabels.has(labelKey)) {
      return {
        ok: false,
        error: `Duplicate size "${rendered}" for material type "${materialName}".`,
      };
    }
    seenLabels.add(labelKey);

    sizes.push({ price_per_lf_cents: priceCents, width_in: widthIn, gauge, length_ft: lengthFt });
  }
  return { ok: true, sizes };
}

/** Sizes cell: one line per Material Type, e.g. "Aluminum · 5 sizes" / "Wood · no sizes". */
function SizesCell({ product }: { product: MetalProduct }) {
  // A tall Product would otherwise stretch the row, so the cell scrolls past a few lines.
  return (
    <span className="block max-h-24 space-y-0.5 overflow-y-auto">
      {sizesColumnLines(product.materials).map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </span>
  );
}

export function MetalProductsView({
  products,
  loading,
  canManage = true,
  canReorder = false,
  canExport = true,
  onRefresh,
  onNotify,
}: MetalProductsViewProps) {
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<MetalProduct | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [materialRows, setMaterialRows] = useState<MaterialRowDraft[]>([]);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<MetalProduct | null>(null);
  const [deleting, setDeleting] = useState(false);

  // The Material Type whose removal would demote the Product, awaiting confirmation.
  const [materialRemoval, setMaterialRemoval] = useState<MaterialRowDraft | null>(null);

  // Locally reordered list (optimistic drag & drop, synced from server props)
  const {
    ordered: orderedProducts,
    dragId,
    setDragId,
    overId,
    setOverId,
    savingOrder,
    handleDrop,
  } = useReorderableList(products, '/api/products/reorder', 'Product', canReorder, onRefresh, onNotify);

  const isModalOpen = addModalOpen || editingProduct !== null;

  // Nothing named: the save creates a Preview, which is an explicit action, never a silent save.
  const willSaveAsPreview = materialRows.every(isEmptyMaterialRow);

  // The Product as stored is quotable today, so removing its last Material Type demotes it.
  const savedHasMaterialTypes = Boolean(
    editingProduct &&
      (editingProduct.materials.length > 0 || (editingProduct.material_type ?? '').trim())
  );

  useEffect(() => {
    return () => {
      if (imagePreviewUrl && imagePreviewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(imagePreviewUrl);
      }
    };
  }, [imagePreviewUrl]);

  const openAddModal = () => {
    setEditingProduct(null);
    setNameInput('');
    setMaterialRows([newMaterialRow()]);
    setImageFile(null);
    setImagePreviewUrl(null);
    setRemoveImage(false);
    setFormError(null);
    setAddModalOpen(true);
  };

  const openEditModal = (product: MetalProduct) => {
    setAddModalOpen(false);
    setEditingProduct(product);
    setNameInput(product.name);
    const productPrice = centsToDollarsInput(product.price_per_lf_cents);
    const mats = product.materials ?? [];
    const rows: MaterialRowDraft[] =
      mats.length > 0
        ? mats.map((m) => ({
            key: `mat-${m.id}`,
            name: m.name,
            price: centsToDollarsInput(m.price_per_lf_cents),
            sizes: (m.sizes ?? []).map((s) => ({
              key: `size-${s.id}`,
              price: centsToDollarsInput(s.price_per_lf_cents),
              width: s.width_in != null ? String(s.width_in) : '',
              gauge: s.gauge ?? '',
              length: s.length_ft != null ? String(s.length_ft) : '',
            })),
            expanded: false,
          }))
        : (product.material_type ?? '')
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean)
            .map((name, i) => ({
              key: `legacy-${i}`,
              name,
              price: productPrice,
              sizes: [],
              expanded: false,
            }));
    setMaterialRows(rows.length > 0 ? rows : [newMaterialRow()]);
    setImageFile(null);
    setImagePreviewUrl(getImageUrl(product.image_path));
    setRemoveImage(false);
    setFormError(null);
  };

  const closeModal = () => {
    setAddModalOpen(false);
    setEditingProduct(null);
    setNameInput('');
    setMaterialRows([]);
    setMaterialRemoval(null);
    setImageFile(null);
    setImagePreviewUrl(null);
    setRemoveImage(false);
    setFormError(null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;
    if (imagePreviewUrl && imagePreviewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(imagePreviewUrl);
    }
    setImageFile(file);
    setRemoveImage(false);
    setImagePreviewUrl(URL.createObjectURL(file));
  };

  const updateMaterialRow = (key: string, patch: Partial<MaterialRowDraft>) => {
    setMaterialRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const addMaterialRow = () => {
    setMaterialRows((prev) => [...prev, newMaterialRow()]);
  };

  const removeMaterialRow = (key: string) => {
    setMaterialRows((prev) => prev.filter((r) => r.key !== key));
  };

  // Removing the last Material Type demotes the Product to a Preview, so it is confirmed
  // rather than done silently (ADR-0001).
  const requestRemoveMaterialRow = (row: MaterialRowDraft) => {
    const namedNow = materialRows.filter((r) => r.name.trim()).length;
    const remainingNamed = materialRows.filter((r) => r.key !== row.key && r.name.trim()).length;
    if (savedHasMaterialTypes && namedNow > 0 && remainingNamed === 0) {
      setMaterialRemoval(row);
      return;
    }
    removeMaterialRow(row.key);
  };

  const confirmRemoveMaterialRow = () => {
    if (materialRemoval) removeMaterialRow(materialRemoval.key);
    setMaterialRemoval(null);
  };

  const toggleMaterialExpanded = (key: string) => {
    setMaterialRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, expanded: !r.expanded } : r))
    );
  };

  const addSizeRow = (materialKey: string) => {
    setMaterialRows((prev) =>
      prev.map((r) => {
        if (r.key !== materialKey) return r;
        // A new Size starts at the Type's price: the common case is a second length at the same rate.
        const nextSizes = [...r.sizes, newSizeRow(r.price)];
        return { ...r, expanded: true, sizes: nextSizes, price: mirrorTypePrice(r, nextSizes) };
      })
    );
  };

  const updateSizeRow = (materialKey: string, sizeKey: string, patch: Partial<SizeRowDraft>) => {
    setMaterialRows((prev) =>
      prev.map((r) => {
        if (r.key !== materialKey) return r;
        const nextSizes = r.sizes.map((s) => (s.key === sizeKey ? { ...s, ...patch } : s));
        return { ...r, sizes: nextSizes, price: mirrorTypePrice(r, nextSizes) };
      })
    );
  };

  const removeSizeRow = (materialKey: string, sizeKey: string) => {
    setMaterialRows((prev) =>
      prev.map((r) => {
        if (r.key !== materialKey) return r;
        const nextSizes = r.sizes.filter((s) => s.key !== sizeKey);
        // While Sizes remain the general price follows the first one; removing the last
        // Size keeps its price, so the Type stays sellable instead of needing a re-entry.
        const removedPrice = r.sizes.find((s) => s.key === sizeKey)?.price ?? r.price;
        const price = nextSizes.length > 0 ? nextSizes[0].price : removedPrice;
        return { ...r, sizes: nextSizes, price };
      })
    );
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedName = nameInput.trim();

    if (!trimmedName) {
      setFormError('Please enter a product name.');
      return;
    }

    // Validate material types: name required, sizes validated exactly as the server does,
    // and the general price required only while the type has no sizes (otherwise mirrored).
    const materialsPayload: Array<{
      name: string;
      price_per_lf_cents: number;
      sizes: SizePayload[];
    }> = [];
    const seenNames = new Set<string>();
    for (const row of materialRows) {
      // The same rule the Save button reads, so "Save as Preview" and the payload agree.
      if (isEmptyMaterialRow(row)) continue;

      const name = row.name.trim();
      const sizeRows = row.sizes.filter((s) => !isBlankSizeRow(s));
      if (!name) {
        setFormError('Every material type needs a name (or remove the empty row).');
        return;
      }
      if (seenNames.has(name.toLowerCase())) {
        setFormError(`Duplicate material type "${name}".`);
        return;
      }
      seenNames.add(name.toLowerCase());

      const sizesResult = validateSizes(name, sizeRows);
      if (!sizesResult.ok) {
        setFormError(sizesResult.error);
        return;
      }
      const sizes = sizesResult.sizes;
      const priceCents = sizes.length > 0 ? sizes[0].price_per_lf_cents : dollarsInputToCents(row.price);
      if (priceCents === null) {
        setFormError(`Material type "${name}" needs a valid non-negative price per linear ft.`);
        return;
      }

      materialsPayload.push({ name, price_per_lf_cents: priceCents, sizes });
    }

    setSaving(true);
    try {
      const formData = new FormData();
      formData.append('name', trimmedName);
      formData.append('materials', JSON.stringify(materialsPayload));
      if (imageFile) {
        formData.append('image', imageFile);
      }
      if (removeImage) {
        formData.append('remove_image', 'true');
      }

      const endpoint = editingProduct ? `/api/products/${editingProduct.id}` : '/api/products';
      const method = editingProduct ? 'PUT' : 'POST';
      const res = await apiFetch(endpoint, { method, body: formData });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save product.');
      }

      await onRefresh();
      onNotify(
        'success',
        willSaveAsPreview
          ? `${trimmedName} saved as a Preview — add a material type to make it quotable.`
          : editingProduct
            ? 'Product updated.'
            : 'Product added.'
      );
      closeModal();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save product.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleAvailability = async (product: MetalProduct) => {
    try {
      const next = product.is_available === 1 ? false : true;
      const res = await apiFetch(`/api/products/${product.id}/availability`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_available: next }),
      });
      if (!res.ok) throw new Error('Failed to update availability.');
      await onRefresh();
      onNotify(
        'success',
        next ? `${product.name} is now Available.` : `${product.name} marked Unavailable.`
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Availability update failed.');
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/products/${deleteTarget.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete product.');
      await onRefresh();
      onNotify('success', `${deleteTarget.name} permanently deleted.`);
      setDeleteTarget(null);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeleting(false);
    }
  };

  const previewCount = products.filter((p) => isPreview(p.materials)).length;
  const availableCount = products.filter(
    (p) => p.is_available === 1 && !isPreview(p.materials)
  ).length;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white px-5 py-3.5">
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="font-medium text-slate-700">{products.length} total products</span>
          <span aria-hidden="true">·</span>
          <span>{availableCount} available for new quotes</span>
          {previewCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-medium text-amber-700">
                {previewCount} preview{previewCount === 1 ? '' : 's'}
              </span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>Prices per linear ft live on each size, falling back to its material type</span>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {canExport && (
            <ExportButtons
              baseUrl="/api/products/export"
              fallbackBaseName="adelco-products"
              onError={(msg) => onNotify('error', msg)}
            />
          )}
          {canManage && (
            <button
              type="button"
              onClick={openAddModal}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#2a6f3b] px-4 py-2 text-xs font-medium text-white hover:bg-[#21572e] whitespace-nowrap shrink-0 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Product
            </button>
          )}
        </div>
      </div>

      {/* Table (ID, Product, Sizes, Status, Actions — prices stay out of Sizes) */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {loading ? (
          <TableSkeleton rows={4} cells={['h-4 w-8', 'h-10 w-10', 'h-4 w-56']} />
        ) : products.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded border border-slate-200 bg-[#f7f7f7] text-slate-400">
              <ImagePlus className="h-5 w-5" />
            </div>
            <h3 className="text-sm font-semibold text-slate-900">No products yet</h3>
            <p className="mt-1 max-w-sm text-xs text-slate-500">
              Add products or profiles with base prices per linear foot. Colors are selected later during quoting.
            </p>
            {canManage && (
              <button
                type="button"
                onClick={openAddModal}
                className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-[#084091] px-4 py-2 text-xs font-medium text-white hover:bg-[#063273]"
              >
                <Plus className="h-3.5 w-3.5" />
                Add First Product
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-left text-sm">
              <thead>
                <tr className="divide-x divide-white/20 border-b border-slate-200 bg-[#084091] text-xs font-semibold text-white">
                  {canReorder && <th className="px-2 py-3 w-10" aria-label="Reorder" />}
                  <th className="px-4 py-3 w-16 text-left">#</th>
                  <th className="px-4 py-3 text-left">Product</th>
                  <th className="px-4 py-3 w-56 text-left">Sizes</th>
                  <th className="px-4 py-3 w-28 text-left">Status</th>
                  {canManage && <th className="px-4 py-3 w-52 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {orderedProducts.map((product, idx) => {
                  const unavailable = product.is_available === 0;
                  const status = productStatus(product.materials, product.is_available === 1);
                  const isDragging = dragId === product.id;
                  const isDropTarget = overId === product.id && dragId !== null && dragId !== product.id;
                  return (
                    <tr
                      key={product.id}
                      draggable={canReorder}
                      onDragStart={() => canReorder && setDragId(product.id)}
                      onDragOver={(e) => {
                        if (!canReorder) return;
                        e.preventDefault();
                        setOverId(product.id);
                      }}
                      onDrop={(e) => {
                        if (!canReorder) return;
                        e.preventDefault();
                        handleDrop(product.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverId(null);
                      }}
                      className={`divide-x divide-slate-200 transition-colors ${
                        isDragging
                          ? 'opacity-40'
                          : isDropTarget
                          ? 'bg-[#084091]/10'
                          : unavailable
                          ? 'bg-slate-100/80 text-slate-400'
                          : idx % 2 === 1
                          ? 'bg-[#f7f7f7]/60 hover:bg-slate-100/60'
                          : 'bg-white hover:bg-slate-50'
                      }`}
                    >
                      {canReorder && (
                        <td className="px-2 py-2 text-left">
                          <span
                            className="inline-flex cursor-grab text-slate-400 hover:text-slate-600 active:cursor-grabbing"
                            title="Drag to reorder"
                          >
                            <GripVertical className="h-4 w-4" />
                          </span>
                        </td>
                      )}
                      <td className="px-4 py-2 text-left font-mono text-xs tabular-nums text-slate-500">
                        {idx + 1}
                      </td>
                      <td className="px-4 py-2 text-left">
                        <div className="flex items-center gap-3">
                          <div className={`shrink-0 ${unavailable ? 'opacity-50' : ''}`}>
                            <ProductThumbnail imagePath={product.image_path} alt={product.name} />
                          </div>
                          <span
                            className={`font-medium ${
                              unavailable ? 'text-slate-500 line-through' : 'text-slate-900'
                            }`}
                          >
                            {product.name}
                          </span>
                        </div>
                      </td>
                      <td
                        className={`px-4 py-2 text-left text-xs leading-relaxed ${
                          unavailable ? 'text-slate-400' : 'text-slate-700'
                        }`}
                      >
                        <SizesCell product={product} />
                      </td>
                      <td className="px-4 py-2 text-left text-xs font-medium">
                        <span
                          className={
                            status === 'preview'
                              ? 'text-amber-700'
                              : status === 'unavailable'
                                ? 'text-red-700'
                                : 'text-[#2a6f3b]'
                          }
                          title={status === 'preview' ? PREVIEW_STATUS_HINT : undefined}
                        >
                          {productStatusLabel(status)}
                        </span>
                      </td>
                      {canManage && (
                        <td className="px-4 py-2 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => openEditModal(product)}
                              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                            >
                              <Pencil className="h-3 w-3" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => handleToggleAvailability(product)}
                              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                            >
                              {unavailable ? (
                                <>
                                  <CheckCircle2 className="h-3 w-3 text-[#2a6f3b]" />
                                  Enable
                                </>
                              ) : (
                                <>
                                  <Ban className="h-3 w-3 text-amber-600" />
                                  Disable
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(product)}
                              className="inline-flex items-center rounded border border-red-200 bg-white p-1.5 text-red-600 hover:bg-red-50"
                              title="Delete product"
                              aria-label={`Delete ${product.name}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add / Edit Product Modal — centered, compact width, scrollable body */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 px-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
            <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-4">
              <h3 className="text-base font-semibold text-slate-900">
                {editingProduct
                  ? `Edit Product #${orderedProducts.findIndex((p) => p.id === editingProduct.id) + 1}`
                  : 'Add Product'}
              </h3>
              <button
                type="button"
                onClick={closeModal}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
              <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {formError && (
                <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                  {formError}
                </div>
              )}

              {willSaveAsPreview && (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <span className="font-semibold">
                    Saving without material types creates a Preview.
                  </span>{' '}
                  A Preview stays visibly incomplete and cannot be quoted until its first material
                  type is added.
                </div>
              )}

              {/* ADR-0001: prices live on Material Types and Sizes, so this form asks for
                  none. The legacy product-level price stays in the schema, unwritten, so
                  nothing already recorded is lost. */}
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                  Product Name
                </label>
                <input
                  type="text"
                  maxLength={120}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder='e.g. 29 Ga Ribbed Roof Panel (36" Coverage)'
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-[#084091] focus:outline-none"
                  required
                />
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <label className="block text-xs font-semibold text-slate-700">
                    Material Types <span className="font-normal text-slate-400">(optional)</span>
                  </label>
                  <button
                    type="button"
                    onClick={addMaterialRow}
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-[#084091] bg-white px-2 py-1 text-[11px] font-semibold text-[#084091] hover:bg-[#084091] hover:text-white transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                    Add material
                  </button>
                </div>

                <div className="space-y-2">
                  {materialRows.map((row, idx) => {
                    const hasSizes = row.sizes.length > 0;
                    const mirrorCents = dollarsInputToCents(row.price);
                    return (
                      <div
                        key={row.key}
                        className="rounded-md border border-slate-200 bg-[#f7f7f7] p-2.5"
                      >
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => toggleMaterialExpanded(row.key)}
                            aria-expanded={row.expanded}
                            title={row.expanded ? 'Hide sizes' : 'Show sizes'}
                            aria-label={`${row.expanded ? 'Hide' : 'Show'} sizes for material #${idx + 1}`}
                            className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-200"
                          >
                            {row.expanded ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <input
                            type="text"
                            maxLength={100}
                            value={row.name}
                            onChange={(e) => updateMaterialRow(row.key, { name: e.target.value })}
                            placeholder={`Material #${idx + 1} — e.g. Aluminum`}
                            aria-label={`Material type name #${idx + 1}`}
                            className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-900 placeholder:font-normal placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                          />
                          {hasSizes ? (
                            <span
                              title="This price follows the first size"
                              className="w-28 shrink-0 truncate rounded-md border border-dashed border-slate-300 bg-white px-2 py-1.5 text-right font-mono text-xs tabular-nums text-slate-500"
                            >
                              {mirrorCents === null ? '—' : formatCAD(mirrorCents)}
                            </span>
                          ) : (
                            <div className="relative w-28 shrink-0">
                              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                                $
                              </span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={row.price}
                                onChange={(e) => updateMaterialRow(row.key, { price: e.target.value })}
                                placeholder="0.00"
                                title="Price per linear ft for this material (CAD)"
                                aria-label={`Price per linear ft for material #${idx + 1}`}
                                className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-5 pr-2 text-right font-mono text-xs tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                              />
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => requestRemoveMaterialRow(row)}
                            className="shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                            title="Remove material type"
                            aria-label={`Remove material type #${idx + 1}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        <div className="mt-1.5 flex items-center justify-between gap-2 pl-7">
                          <span className="text-[10px] text-slate-500">
                            {hasSizes
                              ? `${sizeCountLabel(row.sizes.length)} · price follows the first size`
                              : 'No sizes — quoted at the price above.'}
                          </span>
                          <button
                            type="button"
                            onClick={() => addSizeRow(row.key)}
                            className="inline-flex shrink-0 items-center gap-1 rounded border border-[#084091] bg-white px-2 py-0.5 text-[11px] font-semibold text-[#084091] hover:bg-[#084091] hover:text-white transition-colors"
                          >
                            <Plus className="h-3 w-3" />
                            Add size
                          </button>
                        </div>

                        {row.expanded && hasSizes && (
                          <div className="mt-1.5 space-y-1.5 border-t border-slate-200 pt-1.5 pl-7">
                            {row.sizes.map((size, sizeIdx) => (
                              <div key={size.key} className="flex items-center gap-1.5">
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={size.width}
                                  onChange={(e) =>
                                    updateSizeRow(row.key, size.key, { width: e.target.value })
                                  }
                                  placeholder='Width (in)'
                                  title="Width (in) — optional"
                                  aria-label={`Width (in) for size #${sizeIdx + 1} of material #${idx + 1}`}
                                  className="w-[82px] rounded-md border border-slate-300 bg-white px-2 py-1 text-right font-mono text-xs tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                                />
                                <input
                                  type="text"
                                  maxLength={20}
                                  value={size.gauge}
                                  onChange={(e) =>
                                    updateSizeRow(row.key, size.key, { gauge: e.target.value })
                                  }
                                  placeholder="Gauge"
                                  title="Gauge — optional"
                                  aria-label={`Gauge for size #${sizeIdx + 1} of material #${idx + 1}`}
                                  className="w-[72px] rounded-md border border-slate-300 bg-white px-2 py-1 text-center font-mono text-xs tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                                />
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={size.length}
                                  onChange={(e) =>
                                    updateSizeRow(row.key, size.key, { length: e.target.value })
                                  }
                                  placeholder="Length (ft)"
                                  title="Length (ft) — optional"
                                  aria-label={`Length (ft) for size #${sizeIdx + 1} of material #${idx + 1}`}
                                  className="w-[82px] rounded-md border border-slate-300 bg-white px-2 py-1 text-right font-mono text-xs tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                                />
                                <div className="relative w-[92px]">
                                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                                    $
                                  </span>
                                  <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={size.price}
                                    onChange={(e) =>
                                      updateSizeRow(row.key, size.key, { price: e.target.value })
                                    }
                                    placeholder="0.00"
                                    title="Price per linear ft for this size (CAD)"
                                    aria-label={`Price per linear ft for size #${sizeIdx + 1} of material #${idx + 1}`}
                                    className="w-full rounded-md border border-slate-300 bg-white py-1 pl-5 pr-2 text-right font-mono text-xs tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-[#084091] focus:outline-none"
                                  />
                                </div>
                                <button
                                  type="button"
                                  onClick={() => removeSizeRow(row.key, size.key)}
                                  className="shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                                  title="Remove size"
                                  aria-label={`Remove size #${sizeIdx + 1} of material #${idx + 1}`}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {materialRows.length === 0 && (
                    <p className="rounded-md border border-dashed border-slate-200 px-3 py-2 text-[11px] text-slate-500">
                      No material types — add one to make this product quotable.
                    </p>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  Expand a material type to add its sizes — each size records gauge, width, length, and
                  its own price. A material type with no sizes quotes at its own price. Both appear as
                  choices in the Customer Quote.
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                  Product Thumbnail Image
                </label>
                <div className="flex items-center gap-4 rounded-md border border-slate-200 bg-[#f7f7f7] p-3">
                  {imagePreviewUrl && !removeImage ? (
                    <img
                      src={imagePreviewUrl}
                      alt="Product preview"
                      className="h-14 w-14 shrink-0 rounded border border-slate-300 bg-white object-contain p-1"
                    />
                  ) : (
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded border border-dashed border-slate-300 bg-white text-slate-400">
                      <ImagePlus className="h-5 w-5" />
                    </div>
                  )}

                  <div className="min-w-0 flex-1 space-y-1.5">
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                      <ImagePlus className="h-3.5 w-3.5 text-[#084091]" />
                      Choose Image
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleFileChange}
                        className="sr-only"
                      />
                    </label>
                    <p className="text-[11px] text-slate-500">
                      Automatically resized to a compact 128×128 thumbnail for tables & PDFs.
                    </p>
                    {imagePreviewUrl && !removeImage && (
                      <button
                        type="button"
                        onClick={() => {
                          setImageFile(null);
                          setImagePreviewUrl(null);
                          setRemoveImage(true);
                        }}
                        className="text-[11px] font-medium text-red-600 hover:underline"
                      >
                        Remove image
                      </button>
                    )}
                  </div>
                </div>
              </div>

              </div>

              <div className="flex shrink-0 items-center justify-end gap-3 border-t border-slate-200 px-5 py-4">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={saving}
                  className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-md bg-[#084091] px-4 py-2 text-sm font-medium text-white hover:bg-[#063273] disabled:bg-slate-400"
                >
                  {saving
                    ? 'Saving...'
                    : willSaveAsPreview
                      ? 'Save as Preview'
                      : editingProduct
                        ? 'Save Changes'
                        : 'Add Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmModal
        open={materialRemoval !== null}
        title="Remove the last material type?"
        message={`${
          materialRemoval?.name.trim() ? `"${materialRemoval.name.trim()}"` : 'This material type'
        } is the last material type of "${editingProduct?.name ?? 'this product'}". Saving without it makes the product a Preview, and a Preview can no longer be quoted until a material type is added back.`}
        confirmLabel="Remove Material Type"
        tone="danger"
        onConfirm={confirmRemoveMaterialRow}
        onCancel={() => setMaterialRemoval(null)}
      />

      <ConfirmModal
        open={deleteTarget !== null}
        title="Delete Product?"
        message={`Are you sure you want to permanently delete "${deleteTarget?.name ?? ''}"? Past issued quotes keep their own saved copy of the name, price, and image.`}
        confirmLabel="Delete Permanently"
        tone="danger"
        busy={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
