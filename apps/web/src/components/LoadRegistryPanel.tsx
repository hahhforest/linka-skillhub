import { useState } from "react";
import { HardDriveDownload, Loader2 } from "lucide-react";
import { api, type RegistryLoadResponse } from "../api.js";
import { humanizeError } from "../humanize-error.js";
import { messages, type Language } from "../i18n.js";

export interface LoadRegistryPanelProps {
  readonly lang: Language;
  readonly currentRepoPath?: string;
  readonly onLoaded: (result: RegistryLoadResponse) => void;
}

export function LoadRegistryPanel({ lang, currentRepoPath, onLoaded }: LoadRegistryPanelProps): JSX.Element {
  const t = messages[lang];
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submit = async () => {
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await api.loadRegistry(path.trim());
      setSuccess(`${t.loadRegistrySuccess}: ${result.repoPath} (${result.skillCount ?? result.skills?.length ?? 0})`);
      onLoaded(result);
    } catch (err) {
      setError(`${t.loadRegistryError}: ${humanizeError(err, lang)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="work-card load-registry-panel">
      <h3>{t.loadRegistryTitle}</h3>
      <p className="muted-copy">{t.loadRegistryHelp}</p>
      {currentRepoPath ? <p className="current-registry"><code>{currentRepoPath}</code></p> : null}
      <div className="load-registry-row">
        <input
          value={path}
          placeholder={t.loadRegistryPlaceholder}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
        />
        <button className="primary" onClick={() => void submit()} disabled={busy || !path.trim()}>
          {busy ? <Loader2 className="spin" size={16} /> : <HardDriveDownload size={16} />} {t.loadRegistryButton}
        </button>
      </div>
      {error ? <p className="danger-line">{error}</p> : null}
      {success ? <p className="success-line">{success}</p> : null}
    </div>
  );
}
