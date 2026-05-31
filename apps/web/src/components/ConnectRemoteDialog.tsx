import { useEffect, useRef, useState } from "react";
import { Check, GitBranch, X } from "lucide-react";
import { api } from "../api.js";
import { humanizeError } from "../humanize-error.js";
import { messages, type Language } from "../i18n.js";
import { useModalFocusTrap } from "./useModalFocusTrap.js";

export interface ConnectRemoteDialogProps {
  readonly lang: Language;
  readonly registryRepo: string;
  readonly onClose: () => void;
  // fired with the post-connect git status text so the parent can update the
  // branch chip and git-status pre without a full page reload.
  readonly onConnected: (newGitStatus: string, boundUrl: string) => void;
}

// Light URL shape check: protocol-relative or ssh-style remote. We don't try
// to be exhaustive — the user is the one who pastes a real git URL and the
// server's setRemote will reject anything bogus anyway. The point of the
// check here is to keep the user from one-shot submitting `hello world`.
const isPlausibleRemoteUrl = (s: string): boolean =>
  /^(https?:\/\/|git@|ssh:\/\/|\/).+/.test(s) && s.length >= 8 && !/\s/.test(s);

export function ConnectRemoteDialog({ lang, registryRepo, onClose, onConnected }: ConnectRemoteDialogProps): JSX.Element {
  const t = messages[lang];
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const submit = async () => {
    if (!isPlausibleRemoteUrl(url)) {
      setError(t.connectRemoteInvalidUrl);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api.repoConnect(url);
      onConnected(result.status, url);
      onClose();
    } catch (err) {
      setError(humanizeError(err, lang));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="connect-remote-title"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div ref={dialogRef} tabIndex={-1} className="dialog connect-remote-dialog" onClick={(e) => e.stopPropagation()}>
        <button className="dialog-close" onClick={onClose} disabled={busy} aria-label={t.cancel}><X size={16} /></button>
        <h2 id="connect-remote-title"><GitBranch size={18} /> {t.connectRemoteTitle}</h2>
        <p className="muted-copy">{t.connectRemoteBody}</p>
        <p className="muted-copy">Registry: <code>{registryRepo || "-"}</code></p>
        <input
          className="connect-remote-input"
          type="text"
          value={url}
          placeholder={t.connectRemotePlaceholder}
          onChange={(e) => { setUrl(e.target.value); if (error) setError(""); }}
          disabled={busy}
          autoFocus
        />
        {error && <p className="danger-line"><X size={14} /> {error}</p>}
        <div className="dialog-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>{t.cancel}</button>
          <button className="primary" onClick={() => void submit()} disabled={busy || !url.trim()}>
            <Check size={16} /> {t.connectRemoteApply}
          </button>
        </div>
      </div>
    </div>
  );
}
