import { useEffect, useMemo, useRef, useState } from "react";
import { FolderPlus, Loader2, X } from "lucide-react";
import type { AgentDefinition, SkillScope } from "@linka-skillhub/core";
import { api, type AddSourceResponse } from "../api.js";
import { humanizeError } from "../humanize-error.js";
import { messages, type Language } from "../i18n.js";
import { scopeLabel } from "./skillVisuals.js";
import { useModalFocusTrap } from "./useModalFocusTrap.js";

export interface AddSourceDialogProps {
  readonly lang: Language;
  readonly agents: AgentDefinition[];
  readonly onAdded: (result: AddSourceResponse) => void;
  readonly onClose: () => void;
}

// Same shape as the server's VALID_SCOPES. Kept here so the dropdown stays in
// lockstep with the backend without an extra round-trip. If a future SkillScope
// is added, drop it into both places.
const SCOPE_OPTIONS: readonly SkillScope[] = ["user", "private", "builtin", "system", "project", "unknown"];

// Agent-kind validator — mirrors AGENT_KIND_PATTERN in server.ts so the user
// sees the same rule the backend will enforce. Surface client-side first so
// we don't burn a round-trip for a clearly invalid name.
const AGENT_KIND_PATTERN = /^[a-z][a-z0-9-]*$/;

// R35-C4: the modal that lets the user point at any directory on disk and
// register it as a managed skill source for the active profile.
//
// Two notable behaviours:
//   1. Agent kind is a dropdown over the *already-known* agent kinds plus a
//      "Custom name…" pseudo-option. Picking the pseudo-option reveals a
//      free-text field; the typed value becomes the kebab-case agent kind.
//      We validate it against ^[a-z][a-z0-9-]*$ before submitting so the
//      server's strictly-typed code/message never surfaces.
//   2. Submit calls api.addSource which the server validates a second time
//      (path exists, inside profile root, not duplicate). On success we close
//      the modal AND fire onAdded, which the parent uses to trigger a fresh
//      scan + loadShell so the new skills show up in the source-bars chart
//      without the user reloading.
export function AddSourceDialog({ lang, agents, onAdded, onClose }: AddSourceDialogProps): JSX.Element {
  const t = messages[lang];
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // "__custom__" is the pseudo-option for the "Custom name…" entry in the
  // agent dropdown. We never send this value to the API — instead it gates
  // the customAgentKind input.
  const CUSTOM_OPTION = "__custom__";
  const agentOptions = useMemo(() => agents.map((agent) => ({ kind: agent.kind, label: agent.label })), [agents]);
  const [agentKind, setAgentKind] = useState<string>(agentOptions[0]?.kind ?? CUSTOM_OPTION);
  const [customAgentKind, setCustomAgentKind] = useState<string>("");
  const [scope, setScope] = useState<SkillScope>("user");
  const [pathInput, setPathInput] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveAgentKind = (agentKind === CUSTOM_OPTION ? customAgentKind.trim() : agentKind).trim();
  // Disable submit until the form is at least syntactically valid. Server-side
  // existence/path-inside-profile checks still happen on submit; this is just
  // about the "Don't even let the user click yet" state.
  const canSubmit = (() => {
    if (busy) return false;
    if (!pathInput.trim()) return false;
    if (!effectiveAgentKind) return false;
    if (!AGENT_KIND_PATTERN.test(effectiveAgentKind)) return false;
    return true;
  })();

  const submit = async () => {
    setError(null);
    if (!pathInput.trim()) {
      setError(t.errorAddSourceMissingPath);
      return;
    }
    if (!effectiveAgentKind || !AGENT_KIND_PATTERN.test(effectiveAgentKind)) {
      setError(t.errorAddSourceInvalidAgentKind);
      return;
    }
    setBusy(true);
    try {
      const result = await api.addSource({
        agentKind: effectiveAgentKind,
        scope,
        path: pathInput.trim(),
        label: label.trim().length > 0 ? label.trim() : undefined
      });
      onAdded(result);
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
      aria-labelledby="add-source-title"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div ref={dialogRef} tabIndex={-1} className="dialog add-source-dialog" onClick={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onClose} aria-label={t.cancel}><X size={16} /></button>
        <h2 id="add-source-title"><FolderPlus size={18} /> {t.addSourceTitle}</h2>
        <p className="muted-copy">{t.addSourceBody}</p>
        <div className="add-source-form">
          <label className="add-source-field">
            <span className="add-source-field-label">{t.addSourcePathLabel}</span>
            <input
              type="text"
              value={pathInput}
              placeholder={t.addSourcePathPlaceholder}
              autoFocus
              onChange={(event) => setPathInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && canSubmit) void submit(); }}
            />
            <small className="add-source-field-help">{t.addSourcePathHelp}</small>
          </label>
          <label className="add-source-field">
            <span className="add-source-field-label">{t.addSourceAgentLabel}</span>
            <select value={agentKind} onChange={(event) => setAgentKind(event.target.value)}>
              {agentOptions.map((option) => (
                <option key={option.kind} value={option.kind}>{option.label} ({option.kind})</option>
              ))}
              <option value={CUSTOM_OPTION}>{t.addSourceAgentCustomOption}</option>
            </select>
          </label>
          {agentKind === CUSTOM_OPTION && (
            <label className="add-source-field">
              <span className="add-source-field-label">{t.addSourceCustomAgentLabel}</span>
              <input
                type="text"
                value={customAgentKind}
                placeholder={t.addSourceCustomAgentPlaceholder}
                onChange={(event) => setCustomAgentKind(event.target.value)}
              />
              <small className="add-source-field-help">{t.addSourceCustomAgentHelp}</small>
            </label>
          )}
          <label className="add-source-field">
            <span className="add-source-field-label">{t.addSourceScopeLabel}</span>
            <select value={scope} onChange={(event) => setScope(event.target.value as SkillScope)}>
              {SCOPE_OPTIONS.map((s) => (
                <option key={s} value={s}>{scopeLabel(s, lang)}</option>
              ))}
            </select>
          </label>
          <label className="add-source-field">
            <span className="add-source-field-label">{t.addSourceLabelLabel}</span>
            <input
              type="text"
              value={label}
              placeholder={t.addSourceLabelPlaceholder}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
        </div>
        {error ? <p className="danger-line add-source-error">{error}</p> : null}
        <div className="dialog-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>{t.cancel}</button>
          <button className="primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? <Loader2 className="spin" size={16} /> : <FolderPlus size={16} />} {busy ? t.addSourceSubmitting : t.addSourceSubmit}
          </button>
        </div>
      </div>
    </div>
  );
}
