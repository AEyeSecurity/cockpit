import { useEffect, useRef, useState } from "react";
import type { AppRuntime } from "../../core/types/module";
import { DIALOG_SERVICE_ID, type ActiveGlobalDialog, type DialogService } from "../../packages/core/modules/runtime/service/impl/DialogService";

interface GlobalDialogHostProps {
  runtime: AppRuntime;
}

export function GlobalDialogHost({ runtime }: GlobalDialogHostProps): JSX.Element | null {
  let dialogService: DialogService | null = null;
  try {
    dialogService = runtime.getService<DialogService>(DIALOG_SERVICE_ID);
  } catch {
    dialogService = null;
  }
  if (!dialogService) return null;

  const [activeDialog, setActiveDialog] = useState<ActiveGlobalDialog | null>(dialogService.getActiveDialog());
  const [promptValue, setPromptValue] = useState("");
  const promptInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => dialogService.subscribe((dialog) => setActiveDialog(dialog)), [dialogService]);

  useEffect(() => {
    setPromptValue(activeDialog?.defaultValue ?? "");
  }, [activeDialog]);

  useEffect(() => {
    if (activeDialog?.kind !== "prompt") return;
    promptInputRef.current?.focus();
    promptInputRef.current?.select();
  }, [activeDialog]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!activeDialog) return;
      if (event.key !== "Escape") return;
      dialogService.dismiss();
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDialog, dialogService]);

  if (!activeDialog) return null;

  const confirm = (): void => {
    if (activeDialog.kind === "prompt") {
      dialogService.accept(promptValue);
      return;
    }
    dialogService.accept();
  };
  const isConnectionLostDialog = activeDialog.kind === "alert" && activeDialog.title === "Conexión perdida";
  const isDangerConfirm = activeDialog.kind === "confirm" && activeDialog.danger;
  const isPromptDialog = activeDialog.kind === "prompt";
  const cardClassName = [
    "global-dialog-card",
    isConnectionLostDialog ? "global-dialog-card-connection-lost" : "",
    isDangerConfirm ? "global-dialog-card-danger" : "",
    isPromptDialog ? "global-dialog-card-prompt" : ""
  ].filter(Boolean).join(" ");

  return (
    <div className="global-dialog-overlay" role="dialog" aria-modal="true" onClick={() => dialogService.dismiss()}>
      <div className={cardClassName} onClick={(event) => event.stopPropagation()}>
        <div className="global-dialog-header-shell">
          <header className="global-dialog-header">
            <strong>{activeDialog.title}</strong>
          </header>
          <button
            type="button"
            className="global-dialog-close-btn"
            onClick={() => dialogService.dismiss()}
            aria-label="Cerrar"
          >
            ⛌
          </button>
        </div>
        <div className="global-dialog-body">
          {isDangerConfirm ? (
            <span className="global-dialog-danger-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none">
                <path d="M12 8v5" />
                <path d="M12 17h.01" />
                <path d="M10.2 4.7 2.9 17.3A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.7L13.8 4.7a2 2 0 0 0-3.6 0Z" />
              </svg>
            </span>
          ) : null}
          <p className="global-dialog-message">{activeDialog.message}</p>
          {activeDialog.kind === "prompt" ? (
            <input
              ref={promptInputRef}
              className="global-dialog-input"
              type="text"
              value={promptValue}
              onChange={(event) => setPromptValue(event.target.value)}
              placeholder={activeDialog.placeholder}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  confirm();
                  event.preventDefault();
                }
              }}
            />
          ) : null}
        </div>
        <footer className="global-dialog-actions">
          {activeDialog.kind !== "alert" ? (
            <button type="button" className="global-dialog-cancel-btn" onClick={() => dialogService.dismiss()}>
              {activeDialog.cancelLabel}
            </button>
          ) : null}
          <button type="button" className={activeDialog.danger ? "danger-btn" : ""} onClick={confirm}>
            {activeDialog.confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
