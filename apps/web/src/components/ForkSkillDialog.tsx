import { useEffect, useRef, useState } from "react";
import { GitFork, Loader2, X } from "lucide-react";
import type { RegistryInstance, SkillPackage } from "@linka-skillhub/core";
import { messages, type Language } from "../i18n.js";
import { AgentLogo, agentTone } from "./skillVisuals.js";
import { useModalFocusTrap } from "./useModalFocusTrap.js";

export interface ForkSkillDialogProps {
  readonly lang: Language;
  readonly skill: SkillPackage;
  readonly instance: RegistryInstance;
  readonly busy: boolean;
  readonly error?: string;
  readonly onFork: (newName: string) => void;
  readonly onClose: () => void;
}

const isValidSkillName = (value: string): boolean => /^[a-z][a-z0-9-]*$/.test(value);

export function ForkSkillDialog({ lang, skill, instance, busy, error, onFork, onClose }: ForkSkillDialogProps): JSX.Element {
  const t = messages[lang];
  const [name, setName] = useState(`${skill.name}-fork`);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef);
  const trimmed = name.trim();
  const isValid = isValidSkillName(trimmed);
  const agent = instance.viaAgents[0] ?? "?";

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [busy, onClose]);

  const submit = () => {
    if (busy || !isValid) return;
    onFork(trimmed);
  };

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fork-skill-title"
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div ref={dialogRef} tabIndex={-1} className="dialog fork-skill-dialog" onClick={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onClose} aria-label={t.cancel} disabled={busy}><X size={16} /></button>
        <h2 id="fork-skill-title">{t.syncForkPromptTitle}</h2>
        <p className="muted-copy">{t.syncForkPromptBody}</p>
        <div className="fork-source-card">
          <span className="instance-badge instance-badge-drifted">{t.instanceStatusDrifted}</span>
          <span className="fork-source-agent"><AgentLogo agent={agent} /> {agentTone[agent]?.label ?? agent}</span>
          <code>{instance.realPath}</code>
        </div>
        <label className="fork-name-field">
          <span>{lang === "zh" ? "新 skill 名" : "New skill name"}</span>
          <input
            value={name}
            autoFocus
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
          />
        </label>
        {!isValid && trimmed.length > 0 ? <p className="danger-line">{t.syncForkInvalidName}</p> : null}
        {error ? <p className="danger-line">{error}</p> : null}
        <div className="dialog-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>{t.cancel}</button>
          <button className="primary" onClick={submit} disabled={busy || !isValid}>
            {busy ? <Loader2 className="spin" size={16} /> : <GitFork size={16} />} {t.syncActionFork}
          </button>
        </div>
      </div>
    </div>
  );
}
