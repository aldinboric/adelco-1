import { useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';

/**
 * Shared optimistic drag & drop reordering logic for catalog tables
 * (used by both MetalColorsView and MetalProductsView).
 */
export function useReorderableList<T extends { id: number }>(
  items: T[],
  endpoint: string,
  itemLabel: string,
  canReorder: boolean,
  onRefresh: () => Promise<void>,
  onNotify: (type: 'success' | 'error', text: string) => void
) {
  const [ordered, setOrdered] = useState<T[]>(items);
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);

  useEffect(() => {
    setOrdered(items);
  }, [items]);

  const handleDrop = async (targetId: number) => {
    if (!canReorder || dragId === null || dragId === targetId || savingOrder) return;
    const fromIdx = ordered.findIndex((c) => c.id === dragId);
    const toIdx = ordered.findIndex((c) => c.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;

    const next = [...ordered];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    setOrdered(next);
    setSavingOrder(true);
    try {
      const res = await apiFetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: next.map((c) => c.id) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save order.');
      await onRefresh();
      onNotify('success', `${itemLabel} order saved.`);
    } catch (err) {
      setOrdered(items);
      onNotify('error', err instanceof Error ? err.message : 'Reorder failed.');
    } finally {
      setDragId(null);
      setOverId(null);
      setSavingOrder(false);
    }
  };

  return { ordered, dragId, setDragId, overId, setOverId, savingOrder, handleDrop };
}
