import { Download, Save, Upload, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch, downloadProtectedFile } from '../utils/api';
import { ConfirmModal } from './ConfirmModal';

interface SettingsBackupModalProps {
  open: boolean;
  onClose: () => void;
  onRestored: () => Promise<void>;
  onNotify: (type: 'success' | 'error', text: string) => void;
}

export function SettingsBackupModal({
  open,
  onClose,
  onRestored,
  onNotify,
}: SettingsBackupModalProps) {
  const [quotePrefix, setQuotePrefix] = useState('');
  const [savingPrefix, setSavingPrefix] = useState(false);

  const [pendingZipFile, setPendingZipFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (!open) return;
    apiFetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setQuotePrefix(d.quote_prefix ?? '');
      })
      .catch(() => undefined);
  }, [open]);

  if (!open) return null;

  const handleSavePrefix = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPrefix(true);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quote_prefix: quotePrefix }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save settings.');
      setQuotePrefix(data.quote_prefix);
      onNotify('success', 'Workstation settings saved.');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSavingPrefix(false);
    }
  };

  const handleConfirmRestore = async () => {
    if (!pendingZipFile) return;
    setRestoring(true);
    try {
      const formData = new FormData();
      formData.append('backup', pendingZipFile);
      const res = await apiFetch('/api/backup/restore', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Restore failed.');
      setPendingZipFile(null);
      await onRestored();
      onNotify('success', 'Backup restored successfully.');
      onClose();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Restore failed.');
      setPendingZipFile(null);
    } finally {
      setRestoring(false);
    }
  };

  const sampleNumber = quotePrefix.trim()
    ? `${new Date().getFullYear()}-${quotePrefix.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '')}-0001`
    : `${new Date().getFullYear()}-0001`;

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 px-4"
        role="dialog"
        aria-modal="true"
      >
        <div className="w-full max-w-lg rounded-lg border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h3 className="text-base font-semibold text-slate-900">
              Backup, Restore & Workstation Settings
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="divide-y divide-slate-200 px-5 py-2">
            {/* Backup Section */}
            <div className="py-4">
              <h4 className="text-sm font-semibold text-slate-900">
                Save & Transfer Data Backup
              </h4>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                Packages your entire SQLite database (colors, products, issued quotes) and all product & quote images into a single <code className="font-mono">.zip</code> file. Use this to back up your computer or copy catalogs to another workstation.
              </p>

              <div className="mt-3.5 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                    downloadProtectedFile('/api/backup/download', 'adelco-backup.zip').catch((err) =>
                      onNotify('error', err instanceof Error ? err.message : 'Backup download failed.')
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#084091] px-4 py-2 text-xs font-semibold text-white hover:bg-[#063273] whitespace-nowrap"
                >
                  <Download className="h-3.5 w-3.5" />
                  Save Backup (.zip)
                </button>

                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-[#f7f7f7] whitespace-nowrap">
                  <Upload className="h-3.5 w-3.5 text-[#2a6f3b]" />
                  Restore Backup (.zip)
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      e.target.value = '';
                      if (f) setPendingZipFile(f);
                    }}
                    className="sr-only"
                  />
                </label>
              </div>
            </div>

            {/* Workstation Prefix Section */}
            <form onSubmit={handleSavePrefix} className="py-4">
              <h4 className="text-sm font-semibold text-slate-900">
                Optional Workstation Prefix
              </h4>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                Leave blank for standard numbering (<span className="font-mono">2026-0001</span>), or set a short workstation letter (e.g. <span className="font-mono">A</span> or <span className="font-mono">B</span>) if multiple local computers issue quotes independently without collision.
              </p>

              <div className="mt-3 flex items-center gap-3">
                <input
                  type="text"
                  maxLength={8}
                  value={quotePrefix}
                  onChange={(e) => setQuotePrefix(e.target.value.toUpperCase())}
                  placeholder="Optional (e.g. A)"
                  className="w-40 rounded-md border border-slate-300 px-3 py-1.5 font-mono text-xs uppercase text-slate-900 focus:border-[#084091] focus:outline-none"
                />
                <span className="text-xs text-slate-500">
                  Next format preview: <strong className="font-mono text-slate-800">{sampleNumber}</strong>
                </span>
                <button
                  type="submit"
                  disabled={savingPrefix}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-[#2a6f3b] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#21572e] disabled:bg-slate-400 whitespace-nowrap"
                >
                  <Save className="h-3.5 w-3.5" />
                  {savingPrefix ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      <ConfirmModal
        open={pendingZipFile !== null}
        title="Restore From Backup?"
        message={`Restoring "${pendingZipFile?.name ?? ''}" will replace all current Colors, Products, images, and Issued Quotes on this workstation. Make sure you have saved a backup first if needed.`}
        confirmLabel="Restore Backup"
        tone="danger"
        busy={restoring}
        onConfirm={handleConfirmRestore}
        onCancel={() => setPendingZipFile(null)}
      />
    </>
  );
}
