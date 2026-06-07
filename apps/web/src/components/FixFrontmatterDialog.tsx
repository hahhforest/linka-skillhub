import { useEffect, useRef, useState } from "react";
import { Check, FileText, Loader2, X } from "lucide-react";
import type { SkillPackage } from "@linka-skillhub/core";
import { api } from "../api.js";
import { humanizeError } from "../humanize-error.js";
import { messages, type Language } from "../i18n.js";
import { useModalFocusTrap } from "./useModalFocusTrap.js";

export interface FixFrontmatterDialogProps {
  readonly lang: Language;
  readonly skill: SkillPackage;
  readonly onClose: () => void;
  // fired after a successful apply so the caller can refresh its view of the
  // skill (issues are now empty, status no longer contains "invalid").
  readonly onApplied: (committedSha: string | undefined) => void;
}

interface FixFrontmatterPreviewResult {
  readonly skillId: string;
  readonly applied: boolean;
  readonly reason?: string;
  readonly previousIssues: readonly { readonly code: string; readonly message: string }[];
  readonly newFrontmatter?: Record<string, unknown>;
  readonly writtenPath?: string;
  readonly auto_fixed: true;
}

type Phase = "loading" | "preview" | "applying" | "done" | "error";

export function FixFrontmatterDialog({ lang, skill, onClose, onApplied }: FixFrontmatterDialogProps): JSX.Element {
  const t = messages[lang];
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef);
  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<FixFrontmatterPreviewResult | null>(null);
  const [allowUnsafe, setAllowUnsafe] = useState(false);
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<{ committed: boolean; committedSha?: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    api.fixFrontmatterPreview(skill.id, false)
      .then((res) => {
        if (cancelled) return;
        setPreview(res.result as FixFrontmatterPreviewResult);
        setPhase("preview");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(humanizeError(err, lang));
        setPhase("error");
      });
    return () => { cancelled = true; };
  }, [skill.id, lang]);

  const apply = async () => {
    setPhase("applying");
    try {
      const res = await api.fixFrontmatterApply(skill.id, allowUnsafe);
      const r = res.result as FixFrontmatterPreviewResult;
      if (!r.applied) {
        setError(t.fixFrontmatterNoop);
        setPhase("error");
        return;
      }
      setResult({ committed: res.committed, committedSha: res.committedSha });
      setPhase("done");
      onApplied(res.committedSha);
    } catch (err) {
      setError(humanizeError(err, lang));
      setPhase("error");
    }
  };

  const title = t.fixFrontmatterTitle.replace("{name}", skill.name);

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fix-frontmatter-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={dialogRef} tabIndex={-1} className="dialog fix-frontmatter-dialog" onClick={(e) => e.stopPropagation()}>
        <button className="dialog-close" onClick={onClose} aria-label={t.cancel}><X size={16} /></button>
        <h2 id="fix-frontmatter-title"><FileText size={18} /> {title}</h2>

        {phase === "loading" && (
          <p className="muted-copy"><Loader2 className="spin" size={14} /> {t.fixFrontmatterLoading}</p>
        )}

        {phase === "error" && (
          <>
            <p className="danger-line"><X size={14} /> {error}</p>
            <div className="dialog-actions">
              <button className="ghost" onClick={onClose}>{t.cancel}</button>
            </div>
          </>
        )}

        {phase === "preview" && preview && (
          <>
            {/* Real noop reasons — "already valid" or "not found" — short-
                circuit the proposed-fix view. dry_run is NOT a noop: it's
                the success path for a preview, which carries newFrontmatter
                that we should still show. */}
            {preview.applied === false && preview.reason && preview.reason !== "dry_run" && (
              <p className="muted-copy">
                {preview.reason === "frontmatter_already_present" ? t.fixFrontmatterNoop : preview.reason}
              </p>
            )}
            {(preview.applied === true || preview.reason === "dry_run") && preview.newFrontmatter && (
              <>
                <h3>{t.fixFrontmatterIssues}</h3>
                <ul className="fix-issues">
                  {preview.previousIssues.map((issue) => (
                    <li key={issue.code}><code>{issue.code}</code> {issue.message}</li>
                  ))}
                </ul>
                <h3>{t.fixFrontmatterProposed}</h3>
                <pre className="fix-frontmatter-preview">{JSON.stringify(preview.newFrontmatter, null, 2)}</pre>
                <p className="muted-copy">{t.fixFrontmatterTarget}: <code>{preview.writtenPath ?? skill.skillDir}</code></p>
                <label className="checkbox-line">
                  <input type="checkbox" checked={allowUnsafe} onChange={(e) => setAllowUnsafe(e.target.checked)} />
                  {t.fixFrontmatterAllowUnsafe}
                </label>
                {allowUnsafe && <p className="warning-line">{t.fixFrontmatterUnsafeSource}</p>}
                <div className="dialog-actions">
                  <button className="ghost" onClick={onClose}>{t.cancel}</button>
                  <button className="primary" onClick={() => void apply()}><Check size={16} /> {t.fixFrontmatterApply}</button>
                </div>
              </>
            )}
          </>
        )}

        {phase === "applying" && (
          <p className="muted-copy"><Loader2 className="spin" size={14} /> {t.syncRunning}</p>
        )}

        {phase === "done" && result && (
          <>
            <p className="success-line">
              <Check size={14} />{" "}
              {t.fixFrontmatterSuccess
                .replace("{name}", skill.name)
                .replace("{status}", result.committed ? (t.fixFrontmatterCommitted.replace("{sha}", result.committedSha ?? "")) : t.fixFrontmatterNotCommitted)}
            </p>
            <div className="dialog-actions">
              <button className="primary" onClick={onClose}>{t.cancel}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
