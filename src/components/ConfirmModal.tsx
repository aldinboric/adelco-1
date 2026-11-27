import { AlertTriangle, X } from 'lucide-react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null;

  return (
    <div
      className="ui-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="ui-modal-panel max-w-md">
          <div className="ui-modal-header">
            <div className="flex items-center gap-2.5">
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  tone === 'danger' ? 'bg-red-50 text-red-600' : 'bg-[#eef4fc] text-[#084091]'
                }`}
              >
                <AlertTriangle className="h-4 w-4" />
              </div>
              <h3 id="confirm-modal-title" className="text-base font-semibold text-slate-900">
                {title}
              </h3>
            </div>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="ui-icon-btn"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="px-6 py-4 text-sm leading-relaxed text-slate-600">{message}</div>
          <div className="ui-modal-footer">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="ui-btn-secondary"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className={tone === 'danger' ? 'ui-btn-danger' : 'ui-btn-primary'}
            >
              {busy ? 'Processing...' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
