import { useEffect, useRef } from "react";
import { Check, X } from "lucide-react";
import type { DistributionPlan } from "@linka-skillhub/core";
import { messages, tReason, type Language } from "../i18n.js";
import { useModalFocusTrap } from "./useModalFocusTrap.js";

export interface ConfirmPlanModalProps {
  readonly plan: DistributionPlan;
  readonly confirmToken: string;
  readonly lang: Language;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmPlanModal({ plan, confirmToken, lang, busy, onConfirm, onCancel }: ConfirmPlanModalProps): JSX.Element {
  const t = messages[lang];
  const counts = {
    copy: plan.items.filter((item) => item.action === "copy").length,
    overwrite: plan.items.filter((item) => item.action === "overwrite").length,
    skip: plan.items.filter((item) => item.action === "skip").length
  };
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef);
  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-plan-title"
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div ref={dialogRef} tabIndex={-1} className="dialog confirm-plan-dialog" onClick={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onCancel} aria-label={t.cancel}><X size={16} /></button>
        <h2 id="confirm-plan-title">{t.confirmTitle}</h2>
        <p className="muted-copy">{t.confirmBody}</p>
        <div className="confirm-plan-meta">
          <span><strong>{counts.copy}</strong> {t.confirmCopy}</span>
          <span><strong>{counts.overwrite}</strong> {t.confirmOverwrite}</span>
          <span><strong>{counts.skip}</strong> {t.confirmSkip}</span>
          <span>{t.confirmTotal}: <strong>{plan.items.length}</strong></span>
        </div>
        <div className="confirm-plan-items scrollable-list">
          {plan.items.map((item) => (
            <div key={`${item.target.agent}-${item.skill.id}`} className={`confirm-plan-item action-${item.action}`}>
              <strong>{item.action === "copy" ? t.confirmCopy : item.action === "overwrite" ? t.confirmOverwrite : t.confirmSkip}</strong>
              <span>{item.skill.name} → {item.target.label}</span>
              <small>{tReason(lang, item.reasonCode, item.reason)}</small>
              {item.existingPath ? <code>{item.existingPath}</code> : null}
              {item.backupPath ? <code className="backup-hint">backup {item.backupPath}</code> : null}
            </div>
          ))}
        </div>
        <p className="confirm-token-line">{t.confirmTokenLabel}: <code>{confirmToken}</code></p>
        <div className="dialog-actions">
          <button className="ghost" onClick={onCancel} disabled={busy}>{t.cancel}</button>
          <button className="primary" onClick={onConfirm} disabled={busy}><Check size={16} /> {t.confirmApply}</button>
        </div>
      </div>
    </div>
  );
}
