import { useEffect, useRef } from "react";
import { Check, Database, X } from "lucide-react";
import { messages, type Language } from "../i18n.js";
import { useModalFocusTrap } from "./useModalFocusTrap.js";

export interface ImportConfirmDialogProps {
  readonly lang: Language;
  readonly registryRepo: string;
  readonly skillCount: number;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

// Importing is the only Repo-page action that writes to the Registry on disk
// outside of the existing Distribute / Push flows. Pre-R34 the action card
// fired the request the moment the button was clicked — once the user clicked,
// the registry was rewritten with no preview. This dialog inserts the same
// confirm-before-write rule the other write paths already enforce (Confirm
// Plan, Confirm Scan), and surfaces the target path so the user knows where
// the files are going.
export function ImportConfirmDialog({ lang, registryRepo, skillCount, busy, onConfirm, onCancel }: ImportConfirmDialogProps): JSX.Element {
  const t = messages[lang];
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);
  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-confirm-title"
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div ref={dialogRef} tabIndex={-1} className="dialog" onClick={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onCancel} aria-label={t.cancel}><X size={16} /></button>
        <h2 id="import-confirm-title"><Database size={18} /> {t.importConfirmTitle}</h2>
        <p>{t.importConfirmBody.replace("{n}", String(skillCount))}</p>
        <p className="muted-copy">
          {t.importConfirmTarget}: <code>{registryRepo || "-"}</code>
        </p>
        <div className="dialog-actions">
          <button className="ghost" onClick={onCancel} disabled={busy}>{t.cancel}</button>
          <button className="primary" onClick={onConfirm} disabled={busy}><Check size={16} /> {t.importConfirmApply}</button>
        </div>
      </div>
    </div>
  );
}
