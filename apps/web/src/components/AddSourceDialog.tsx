import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FolderPlus, Loader2, X } from "lucide-react";
import type { AgentDefinition, SkillScope } from "@linka-skillhub/core";
import { api, type AddSourceResponse } from "../api.js";
import { humanizeError } from "../humanize-error.js";
import { messages, type Language } from "../i18n.js";
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
const SCOPE_OPTIONS: readonly SkillScope[] = ["user", "private", "project", "builtin", "system", "unknown"];

// Agent-kind validator — mirrors AGENT_KIND_PATTERN in server.ts so the user
// sees the same rule the backend will enforce. Surface client-side first so
// we don't burn a round-trip for a clearly invalid name.
const AGENT_KIND_PATTERN = /^[a-z][a-z0-9-]*$/;

// R35-C4: register a directory on disk as a managed skill source.
// R35-C5 follow-up: the original form had four fields (path / agent / scope /
// label) which the user flagged as confusing — "label" was redundant with the
// custom-agent name, and "scope" exposed 6 raw enum values without explaining
// what they meant for distribution defaults. This rewrite collapses the form
// down to:
//
//   1. Path — required.
//   2. Group (旧"归属 Agent") — dropdown over existing agent kinds plus a
//      "新建分组" pseudo-option. When the pseudo-option is picked we reveal
//      a single text input that becomes BOTH the agent kind AND the chart
//      label — no separate "display name" field.
//   3. Scope — collapsed under an "Advanced" disclosure with per-option
//      explanations next to each radio. Defaults to "user" which is what
//      90% of users want; only opens if they actively need a different
//      scope. The help line tells them what scope decides (whether the
//      skills land in the default distribution set).
export function AddSourceDialog({ lang, agents, onAdded, onClose }: AddSourceDialogProps): JSX.Element {
  const t = messages[lang];
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // "__custom__" is the pseudo-option for the "新建分组" entry in the group
  // dropdown. We never send this value to the API — instead it gates the
  // customAgentKind input below.
  const CUSTOM_OPTION = "__custom__";
  const agentOptions = useMemo(() => agents.map((agent) => ({ kind: agent.kind, label: agent.label })), [agents]);
  const [agentKind, setAgentKind] = useState<string>(CUSTOM_OPTION);
  const [customAgentKind, setCustomAgentKind] = useState<string>("");
  const [scope, setScope] = useState<SkillScope>("user");
  const [pathInput, setPathInput] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathInputId = "add-source-path";
  const pathLabelId = "add-source-path-label";
  const pathHelpId = "add-source-path-help";
  const groupSelectId = "add-source-group";
  const groupLabelId = "add-source-group-label";
  const groupHelpId = "add-source-group-help";
  const customAgentInputId = "add-source-custom-agent";
  const customAgentLabelId = "add-source-custom-agent-label";
  const customAgentHelpId = "add-source-custom-agent-help";

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
        path: pathInput.trim()
      });
      onAdded(result);
      onClose();
    } catch (err) {
      setError(humanizeError(err, lang));
    } finally {
      setBusy(false);
    }
  };

  // Per-scope help is the table of options the user used to see as opaque
  // enum values. Localized via the existing scope_* keys so labels stay in
  // sync with the source-bars chip.
  const scopeHelpFor = (s: SkillScope): string => {
    const table = messages[lang] as Record<string, string>;
    return table[`scope_help_${s}`] ?? "";
  };
  const scopeLabelLocalized = (s: SkillScope): string => {
    const table = messages[lang] as Record<string, string>;
    return table[`scope_${s}`] ?? s;
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
          <label className="add-source-field" htmlFor={pathInputId}>
            <span id={pathLabelId} className="add-source-field-label">{t.addSourcePathLabel}</span>
            <input
              id={pathInputId}
              type="text"
              value={pathInput}
              placeholder={t.addSourcePathPlaceholder}
              aria-labelledby={pathLabelId}
              aria-describedby={pathHelpId}
              autoFocus
              onChange={(event) => setPathInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && canSubmit) void submit(); }}
            />
            <small id={pathHelpId} className="add-source-field-help">{t.addSourcePathHelp}</small>
          </label>
          <label className="add-source-field" htmlFor={groupSelectId}>
            <span id={groupLabelId} className="add-source-field-label">{t.addSourceGroupLabel}</span>
            <select id={groupSelectId} value={agentKind} aria-labelledby={groupLabelId} aria-describedby={groupHelpId} onChange={(event) => setAgentKind(event.target.value)}>
              <option value={CUSTOM_OPTION}>{t.addSourceGroupCustomOption}</option>
              {agentOptions.map((option) => (
                <option key={option.kind} value={option.kind}>{option.label}</option>
              ))}
            </select>
            <small id={groupHelpId} className="add-source-field-help">{t.addSourceGroupHelp}</small>
          </label>
          {agentKind === CUSTOM_OPTION && (
            <label className="add-source-field" htmlFor={customAgentInputId}>
              <span id={customAgentLabelId} className="add-source-field-label">{t.addSourceCustomAgentLabel}</span>
              <input
                id={customAgentInputId}
                type="text"
                value={customAgentKind}
                placeholder={t.addSourceCustomAgentPlaceholder}
                aria-labelledby={customAgentLabelId}
                aria-describedby={customAgentHelpId}
                onChange={(event) => setCustomAgentKind(event.target.value)}
              />
              <small id={customAgentHelpId} className="add-source-field-help">{t.addSourceCustomAgentHelp}</small>
            </label>
          )}
          <div className="add-source-advanced">
            <button
              type="button"
              className="add-source-advanced-toggle"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
            >
              {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {t.addSourceAdvanced}
              <em className="muted-copy add-source-advanced-value">
                ({t.addSourceScopeLabel}: {scopeLabelLocalized(scope)})
              </em>
            </button>
            {showAdvanced && (
              <div className="add-source-advanced-body">
                <p className="muted-copy add-source-advanced-help">{t.addSourceScopeHelp}</p>
                <div className="add-source-scope-options">
                  {SCOPE_OPTIONS.map((s) => (
                    <label key={s} className={`add-source-scope-option${scope === s ? " selected" : ""}`}>
                      <input
                        type="radio"
                        name="add-source-scope"
                        value={s}
                        checked={scope === s}
                        onChange={() => setScope(s)}
                      />
                      <div>
                        <strong>{scopeLabelLocalized(s)}</strong>
                        <small>{scopeHelpFor(s)}</small>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
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
