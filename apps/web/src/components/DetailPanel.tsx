import { PackageCheck } from "lucide-react";
import type { SkillPackage } from "@linka-skillhub/core";
import { messages, type Language } from "../i18n.js";
import { AgentLogo, agentTone, bucketLabel, statusClass } from "./skillVisuals.js";

// Typed key into the messages map so callers cannot pass a string that does
// not exist in i18n. Both `zh` and `en` share the same shape.
type MessageKey = keyof (typeof messages)["zh"];

export interface DetailPanelProps {
  readonly skill: SkillPackage | undefined;
  readonly lang: Language;
  // Overrides the default "click a skill to see its details" empty hint. Used
  // by pages where the empty state means something more specific (e.g. Repo
  // wants "pick a skill from the registry to inspect").
  readonly emptyTextKey?: MessageKey;
}

// Sticky right-side panel that mirrors the focused skill's metadata. Every
// page that has a skill list pairs a SkillTable with one of these — Overview
// today, Intersect after this commit, Distribute and Repo in later commits.
export function DetailPanel({ skill, lang, emptyTextKey }: DetailPanelProps): JSX.Element {
  const t = messages[lang];
  if (!skill) {
    const emptyText = emptyTextKey ? t[emptyTextKey] : t.selectSkillToInspect;
    return (
      <section className="work-card detail-empty">
        <PackageCheck size={24} />
        <h2>{emptyText}</h2>
      </section>
    );
  }
  return (
    <section className="detail-inline">
      <div className="detail-head">
        <div>
          <h2>{skill.name}</h2>
          <p>{skill.description}</p>
        </div>
        <span className={`status-pill ${statusClass(skill)}`}>{bucketLabel(skill, lang)}</span>
      </div>
      <div className="work-card">
        <h3>{t.metadata}</h3>
        <dl className="meta-list">
          <dt>{t.source}</dt>
          <dd><AgentLogo agent={skill.source.agent} /> {agentTone[skill.source.agent]?.label}</dd>
          <dt>{t.scope}</dt>
          <dd>{skill.source.scope}</dd>
          <dt>{t.hash}</dt>
          <dd><code>{skill.hash.slice(0, 16)}</code></dd>
        </dl>
      </div>
      <div className="work-card">
        <h3>{t.evidence}</h3>
        <div className="evidence-list">
          {skill.issues.map((issue) => <span key={issue.code} className="danger-line">{issue.code}: {issue.message}</span>)}
          {skill.evidence.map((item) => <span key={item}>{item}</span>)}
          {skill.issues.length === 0 && skill.evidence.length === 0 && (
            <span>{lang === "zh" ? "无阻断证据" : "No blocking evidence"}</span>
          )}
        </div>
      </div>
      <div className="work-card path-card">
        <h3>{t.path}</h3>
        <code>{skill.skillDir}</code>
      </div>
    </section>
  );
}
