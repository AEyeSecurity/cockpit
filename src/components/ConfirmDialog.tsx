import { AlertTriangle, X } from 'lucide-react';

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'neutral';
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancelar',
  tone = 'neutral',
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  if (!open) {
    return null;
  }

  const danger = tone === 'danger';

  return (
    <div className="fixed inset-0 z-[1000] grid place-items-center bg-ink/30 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="reveal panel w-full max-w-md p-6 shadow-pop">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={`grid h-11 w-11 place-items-center rounded-xl ${danger ? 'bg-danger/10 text-danger' : 'bg-brand-soft text-brand'}`}>
              <AlertTriangle size={24} />
            </div>
            <h2 className="text-xl font-extrabold tracking-tight text-ink">{title}</h2>
          </div>
          <button className="ctl h-10 w-10 text-ink-faint" onClick={onCancel} type="button">
            <X size={20} />
            <span className="sr-only">Cerrar</span>
          </button>
        </div>

        <p className="mt-4 text-[15px] font-medium leading-7 text-ink-soft">{message}</p>

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button className="ctl px-5 py-3 text-sm font-bold text-ink-soft" onClick={onCancel} type="button">
            {cancelLabel}
          </button>
          <button
            className={`px-5 py-3 text-sm font-bold text-white transition active:scale-[0.985] ${
              danger ? 'rounded-xl bg-danger hover:bg-danger/90' : 'rounded-xl bg-brand hover:bg-brand-ink'
            }`}
            onClick={onConfirm}
            type="button"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
