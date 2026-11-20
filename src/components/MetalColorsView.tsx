import {
  Ban,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  GripVertical,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useReorderableList } from '../hooks/useReorderableList';
import type { MetalColor } from '../types';
import { apiFetch, downloadProtectedFile } from '../utils/api';
import {
  centsToDollarsInput,
  dollarsInputToCents,
  formatCAD,
  normalizeHexPreview,
} from '../utils/format';
import { ConfirmModal } from './ConfirmModal';

interface MetalColorsViewProps {
  colors: MetalColor[];
  loading: boolean;
  canManage?: boolean;
  canReorder?: boolean;
  canExport?: boolean;
  onRefresh: () => Promise<void>;
  onNotify: (type: 'success' | 'error', text: string) => void;
}

export function MetalColorsView({
  colors,
  loading,
  canManage = true,
  canReorder = false,
  canExport = true,
  onRefresh,
  onNotify,
}: MetalColorsViewProps) {
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [editingColor, setEditingColor] = useState<MetalColor | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [hexInput, setHexInput] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<MetalColor | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Locally reordered list (optimistic drag & drop, synced from server props)
  const {
    ordered: orderedColors,
    dragId,
    setDragId,
    overId,
    setOverId,
    savingOrder,
    handleDrop,
  } = useReorderableList(colors, '/api/colors/reorder', 'Color', canReorder, onRefresh, onNotify);

  const isModalOpen = addModalOpen || editingColor !== null;

  const openAddModal = () => {
    setEditingColor(null);
    setNameInput('');
    setHexInput('');
    setPriceInput('');
    setFormError(null);
    setAddModalOpen(true);
  };

  const openEditModal = (color: MetalColor) => {
    setAddModalOpen(false);
    setEditingColor(color);
    setNameInput(color.name);
    setHexInput(color.hex_code);
    setPriceInput(centsToDollarsInput(color.price_per_lf_cents));
    setFormError(null);
  };

  const closeModal = () => {
    setAddModalOpen(false);
    setEditingColor(null);
    setFormError(null);
  };

  const previewHex = normalizeHexPreview(hexInput);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedName = nameInput.trim();
    const validHex = normalizeHexPreview(hexInput);
    const cents = dollarsInputToCents(priceInput);

    if (!trimmedName) {
      setFormError('Please enter a color name.');
      return;
    }
    if (!validHex) {
      setFormError('Please enter a valid 6-digit HEX code (e.g. #084091).');
      return;
    }
    if (cents === null) {
      setFormError('Please enter a valid price per linear foot (0.00 or higher).');
      return;
    }

    setSaving(true);
    try {
      const endpoint = editingColor ? `/api/colors/${editingColor.id}` : '/api/colors';
      const method = editingColor ? 'PUT' : 'POST';
      const res = await apiFetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          hex_code: validHex,
          price_per_lf_cents: cents,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save color.');
      }
      await onRefresh();
      onNotify('success', editingColor ? 'Color updated.' : 'Color added.');
      closeModal();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save color.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleAvailability = async (color: MetalColor) => {
    try {
      const next = color.is_available === 1 ? false : true;
      const res = await apiFetch(`/api/colors/${color.id}/availability`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_available: next }),
      });
      if (!res.ok) throw new Error('Failed to update availability.');
      await onRefresh();
      onNotify(
        'success',
        next ? `${color.name} is now Available.` : `${color.name} marked Unavailable.`
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Availability update failed.');
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/colors/${deleteTarget.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete color.');
      await onRefresh();
      onNotify('success', `${deleteTarget.name} permanently deleted.`);
      setDeleteTarget(null);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeleting(false);
    }
  };

  const availableCount = colors.filter((c) => c.is_available === 1).length;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white px-5 py-3.5">
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="font-medium text-slate-700">{colors.length} total colors</span>
          <span aria-hidden="true">·</span>
          <span>{availableCount} available for new quotes</span>
          <span aria-hidden="true">·</span>
          <span>Currency: CAD / linear ft</span>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {canExport && (
            <>
              <button
                type="button"
                onClick={() =>
                  downloadProtectedFile('/api/colors/export/excel', 'adelco-colors.xlsx').catch(
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
                  downloadProtectedFile('/api/colors/export/pdf', 'adelco-colors.pdf').catch(
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
              Add Color
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {loading ? (
          <div className="divide-y divide-slate-100 p-4">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="flex h-11 items-center gap-4 py-2">
                <div className="h-4 w-8 animate-pulse rounded bg-slate-200" />
                <div className="h-6 w-10 animate-pulse rounded bg-slate-200" />
                <div className="h-4 w-48 animate-pulse rounded bg-slate-200" />
                <div className="ml-auto h-4 w-20 animate-pulse rounded bg-slate-200" />
              </div>
            ))}
          </div>
        ) : colors.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <div className="mb-3 h-10 w-10 rounded border border-slate-200 bg-[#f7f7f7]" />
            <h3 className="text-sm font-semibold text-slate-900">No colors yet</h3>
            <p className="mt-1 max-w-sm text-xs text-slate-500">
              Add your finish colors with HEX codes and linear-foot pricing to make them selectable on customer quotes.
            </p>
            {canManage && (
              <button
                type="button"
                onClick={openAddModal}
                className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-[#084091] px-4 py-2 text-xs font-medium text-white hover:bg-[#063273]"
              >
                <Plus className="h-3.5 w-3.5" />
                Add First Color
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="divide-x divide-white/20 border-b border-slate-200 bg-[#084091] text-xs font-semibold text-white">
                  {canReorder && <th className="px-2 py-3 w-10" aria-label="Reorder" />}
                  <th className="px-4 py-3 w-16 text-left">#</th>
                  <th className="px-4 py-3 text-left">Color</th>
                  <th className="px-4 py-3 w-28 text-left">HEX</th>
                  <th className="px-4 py-3 w-40 text-right">Price per linear ft</th>
                  <th className="px-4 py-3 w-28 text-left">Status</th>
                  {canManage && <th className="px-4 py-3 w-52 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {orderedColors.map((color, idx) => {
                  const unavailable = color.is_available === 0;
                  const isDragging = dragId === color.id;
                  const isDropTarget = overId === color.id && dragId !== null && dragId !== color.id;
                  return (
                    <tr
                      key={color.id}
                      draggable={canReorder}
                      onDragStart={() => canReorder && setDragId(color.id)}
                      onDragOver={(e) => {
                        if (!canReorder) return;
                        e.preventDefault();
                        setOverId(color.id);
                      }}
                      onDrop={(e) => {
                        if (!canReorder) return;
                        e.preventDefault();
                        handleDrop(color.id);
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
                        <td className="px-2 py-2.5 text-left">
                          <span
                            className="inline-flex cursor-grab text-slate-400 hover:text-slate-600 active:cursor-grabbing"
                            title="Drag to reorder"
                          >
                            <GripVertical className="h-4 w-4" />
                          </span>
                        </td>
                      )}
                      <td className="px-4 py-2.5 text-left font-mono text-xs tabular-nums text-slate-500">
                        {idx + 1}
                      </td>
                      <td className="px-4 py-2.5 text-left">
                        <div className="flex items-center gap-3">
                          <div
                            className={`h-6 w-10 shrink-0 rounded border border-slate-200 ${
                              unavailable ? 'opacity-50' : ''
                            }`}
                            style={{ backgroundColor: color.hex_code }}
                            title={color.hex_code}
                          />
                          <span
                            className={`font-medium ${
                              unavailable ? 'text-slate-500 line-through' : 'text-slate-900'
                            }`}
                          >
                            {color.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-left font-mono text-xs tabular-nums text-slate-600">
                        {color.hex_code}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs font-medium tabular-nums text-slate-900">
                        {formatCAD(color.price_per_lf_cents)}
                      </td>
                      <td className="px-4 py-2.5 text-left text-xs font-medium">
                        {unavailable ? (
                          <span className="text-red-700">Unavailable</span>
                        ) : (
                          <span className="text-[#2a6f3b]">Available</span>
                        )}
                      </td>
                      {canManage && (
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => openEditModal(color)}
                              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                            >
                              <Pencil className="h-3 w-3" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => handleToggleAvailability(color)}
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
                              onClick={() => setDeleteTarget(color)}
                              className="inline-flex items-center rounded border border-red-200 bg-white p-1.5 text-red-600 hover:bg-red-50"
                              title="Delete color"
                              aria-label={`Delete ${color.name}`}
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

      {/* Add / Edit Modal */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 px-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h3 className="text-base font-semibold text-slate-900">
                {editingColor
                  ? `Edit Color #${orderedColors.findIndex((c) => c.id === editingColor.id) + 1}`
                  : 'Add Color'}
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

              {/* Live Color Swatch Preview (starts neutral gray until valid HEX entered) */}
              <div className="flex items-center gap-4 rounded-md border border-slate-200 bg-[#f7f7f7] p-3">
                <div
                  className="h-12 w-16 shrink-0 rounded border border-slate-300 transition-colors"
                  style={{ backgroundColor: previewHex ?? '#D4D4D8' }}
                />
                <div className="min-w-0 text-xs">
                  <div className="font-semibold text-slate-800">
                    {previewHex ? `Preview: ${previewHex}` : 'Neutral Preview'}
                  </div>
                  <div className="mt-0.5 text-slate-500">
                    {previewHex
                      ? 'Swatch updated from HEX code.'
                      : 'Enter a 6-digit HEX code (e.g. #084091) to display the exact color.'}
                  </div>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                  Color Name
                </label>
                <input
                  type="text"
                  maxLength={120}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="e.g. AdelCo Cobalt Blue"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-[#084091] focus:outline-none"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                    HEX Code
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={hexInput}
                      onChange={(e) => setHexInput(e.target.value)}
                      placeholder="#084091"
                      maxLength={7}
                      className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm uppercase text-slate-900 focus:border-[#084091] focus:outline-none"
                      required
                    />
                    <input
                      type="color"
                      value={previewHex ?? '#D4D4D8'}
                      onChange={(e) => setHexInput(e.target.value.toUpperCase())}
                      className="h-9 w-10 shrink-0 cursor-pointer rounded border border-slate-300 bg-white p-0.5"
                      title="Pick color"
                    />
                  </div>
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
                      placeholder="1.45"
                      className="w-full rounded-md border border-slate-300 py-2 pl-7 pr-3 font-mono text-sm tabular-nums text-slate-900 focus:border-[#084091] focus:outline-none"
                      required
                    />
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
                  {saving ? 'Saving...' : editingColor ? 'Save Changes' : 'Add Color'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmModal
        open={deleteTarget !== null}
        title="Delete Color?"
        message={`Are you sure you want to permanently delete "${deleteTarget?.name ?? ''}"? Past issued quotes will keep their saved snapshot copy, and any copied draft referencing this color will prompt you to pick a replacement.`}
        confirmLabel="Delete Permanently"
        tone="danger"
        busy={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
