import { useEffect, useRef, useState } from "react";
import { HardDriveDownload, Loader2, X } from "lucide-react";
import { api, type RegistryLoadResponse } from "../api.js";
import { humanizeError } from "../humanize-error.js";
import { messages, type Language } from "../i18n.js";
import { useModalFocusTrap } from "./useModalFocusTrap.js";

export interface LoadRegistryDialogProps {
  readonly lang: Language;
  readonly currentRepoPath?: string;
  readonly onLoaded: (result: RegistryLoadResponse) => void;
  readonly onClose: () => void;
}

// R34 commit 5: the old inline LoadRegistryPanel sat in the Repo grid as a
// permanent card. It was hidden far down the page on first visit and silently
// shouted "what is this?" at every new user. As a modal it now only opens when
// the user clicks "切换 Registry" from the meta bar, which mirrors how the rest
// of the destructive actions (Confirm Plan, Scan Sources) gate themselves.
export function LoadRegistryDialog({ lang, currentRepoPath, onLoaded, onClose }: LoadRegistryDialogProps): JSX.Element {
  const t = messages[lang];
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathInputId = "load-registry-path";
  const pathHelpId = "load-registry-help";
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const submit = async () => {
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.loadRegistry(path.trim());
      onLoaded(result);
      onClose();
    } catch (err) {
      setError(`${t.loadRegistryError}: ${humanizeError(err, lang)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="load-registry-title"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div ref={dialogRef} tabIndex={-1} className="dialog" onClick={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onClose} aria-label={t.cancel}><X size={16} /></button>
        <h2 id="load-registry-title">{t.loadRegistryTitle}</h2>
        <p id={pathHelpId} className="muted-copy">{t.loadRegistryHelp}</p>
        {currentRepoPath ? (
          <p className="current-registry"><code>{currentRepoPath}</code></p>
        ) : null}
        <div className="load-registry-row">
          <input
            id={pathInputId}
            aria-label={t.loadRegistryTitle}
            aria-describedby={pathHelpId}
            value={path}
            placeholder={t.loadRegistryPlaceholder}
            autoFocus
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
          />
        </div>
        {error ? <p className="danger-line">{error}</p> : null}
        <div className="dialog-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>{t.cancel}</button>
          <button className="primary" onClick={() => void submit()} disabled={busy || !path.trim()}>
            {busy ? <Loader2 className="spin" size={16} /> : <HardDriveDownload size={16} />} {t.loadRegistryButton}
          </button>
        </div>
      </div>
    </div>
  );
}
