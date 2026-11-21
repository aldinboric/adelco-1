import {
  Ban,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  GripVertical,
  ImagePlus,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useReorderableList } from '../hooks/useReorderableList';
import type { MetalProduct } from '../types';
import { apiFetch, downloadProtectedFile } from '../utils/api';
import {
  centsToDollarsInput,
  dollarsInputToCents,
  formatCAD,
  getImageUrl,
} from '../utils/format';
import { ConfirmModal } from './ConfirmModal';
import { ProductThumbnail } from './ProductThumbnail';

interface MetalProductsViewProps {
  products: MetalProduct[];
  loading: boolean;
  canManage?: boolean;
  canReorder?: boolean;
  canExport?: boolean;
  onRefresh: () => Promise<void>;
  onNotify: (type: 'success' | 'error', text: string) => void;
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
  const [materialInput, setMaterialInput] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<MetalProduct | null>(null);
  const [deleting, setDeleting] = useState(false);

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
    setMaterialInput('');
    setPriceInput('');
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
    setMaterialInput(product.material_type ?? '');
    setPriceInput(centsToDollarsInput(product.price_per_lf_cents));
    setImageFile(null);
    setImagePreviewUrl(getImageUrl(product.image_path));
    setRemoveImage(false);
    setFormError(null);
  };

  const closeModal = () => {
    setAddModalOpen(false);
    setEditingProduct(null);
    setNameInput('');
    setMaterialInput('');
    setPriceInput('');
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

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedName = nameInput.trim();
    const cents = dollarsInputToCents(priceInput);

    if (!trimmedName) {
      setFormError('Please enter a product name.');
      return;
    }
    if (cents === null) {
      setFormError('Please enter a valid price per linear foot.');
      return;
    }

    setSaving(true);
    try {
      const formData = new FormData();
      formData.append('name', trimmedName);
      formData.append('material_type', materialInput.trim());
      formData.append('price_per_lf_cents', String(cents));
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
      onNotify('success', editingProduct ? 'Product updated.' : 'Product added.');
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

  const availableCount = products.filter((p) => p.is_available === 1).length;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white px-5 py-3.5">
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="font-medium text-slate-700">{products.length} total products</span>
          <span aria-hidden="true">·</span>
          <span>{availableCount} available for new quotes</span>
          <span aria-hidden="true">·</span>
          <span>Base product prices in CAD / linear ft</span>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {canExport && (
            <>
              <button
                type="button"
                onClick={() =>
                  downloadProtectedFile('/api/products/export/excel', 'adelco-products.xlsx').catch(
                    (err) => onNotify('error', err instanceof Error ? err.message : 'Export failed.')
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-[#f7f7f7] whitespace-nowrap shrink-0"
              >
                <FileSpreadsheet className="h-3.5 w-3.5 text-[#2a6f3b]" />
                Export Excel
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadProtectedFile('/api/products/export/pdf', 'adelco-products.pdf').catch(
                    (err) => onNotify('error', err instanceof Error ? err.message : 'Export failed.')
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-[#f7f7f7] whitespace-nowrap shrink-0"
              >
                <FileText className="h-3.5 w-3.5 text-[#084091]" />
                Export PDF
              </button>
            </>
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

      {/* Table (ID, Product, Price per linear ft, Status, Actions — NO Color column) */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {loading ? (
          <div className="divide-y divide-slate-100 p-4">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="flex h-12 items-center gap-4 py-2">
                <div className="h-4 w-8 animate-pulse rounded bg-slate-200" />
                <div className="h-10 w-10 animate-pulse rounded bg-slate-200" />
                <div className="h-4 w-56 animate-pulse rounded bg-slate-200" />
                <div className="ml-auto h-4 w-20 animate-pulse rounded bg-slate-200" />
              </div>
            ))}
          </div>
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
                  <th className="px-4 py-3 w-48 text-left">Material Type</th>
                  <th className="px-4 py-3 w-44 text-right">Price per linear ft</th>
                  <th className="px-4 py-3 w-28 text-left">Status</th>
                  {canManage && <th className="px-4 py-3 w-52 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {orderedProducts.map((product, idx) => {
                  const unavailable = product.is_available === 0;
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
                        className={`px-4 py-2 text-left text-xs ${
                          unavailable ? 'text-slate-400' : 'text-slate-700'
                        }`}
                      >
                        {product.material_type?.trim() ? (
                          <span className="inline-flex flex-wrap gap-1">
                            {product.material_type
                              .split(',')
                              .map((m) => m.trim())
                              .filter(Boolean)
                              .map((m) => (
                                <span
                                  key={m}
                                  className="inline-flex items-center rounded-full border border-[#084091]/20 bg-[#084091]/5 px-2 py-0.5 text-[11px] font-medium text-[#084091]"
                                >
                                  {m}
                                </span>
                              ))}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs font-medium tabular-nums text-slate-900">
                        {formatCAD(product.price_per_lf_cents)}
                      </td>
                      <td className="px-4 py-2 text-left text-xs font-medium">
                        {unavailable ? (
                          <span className="text-red-700">Unavailable</span>
                        ) : (
                          <span className="text-[#2a6f3b]">Available</span>
                        )}
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

      {/* Add / Edit Product Modal */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 px-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
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

            <form onSubmit={handleSave} className="space-y-4 px-5 py-4">
              {formError && (
                <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                  {formError}
                </div>
              )}

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
                <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                  Material Type <span className="font-normal text-slate-400">(optional)</span>
                </label>
                <input
                  type="text"
                  maxLength={200}
                  value={materialInput}
                  onChange={(e) => setMaterialInput(e.target.value)}
                  placeholder="e.g. Steel, Aluminum, Copper"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-[#084091] focus:outline-none"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Separate multiple material types with commas. These appear as choices in the
                  Customer Quote when this product is selected.
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                  Price per linear ft (CAD)
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-slate-400">
                    $
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={priceInput}
                    onChange={(e) => setPriceInput(e.target.value)}
                    placeholder="4.25"
                    className="w-full rounded-md border border-slate-300 py-2 pl-7 pr-3 font-mono text-sm tabular-nums text-slate-900 focus:border-[#084091] focus:outline-none"
                    required
                  />
                </div>
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

              <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
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
                  {saving ? 'Saving...' : editingProduct ? 'Save Changes' : 'Add Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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
