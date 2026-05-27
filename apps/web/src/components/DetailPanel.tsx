import { useEffect, useState } from "react";
import { PackageCheck } from "lucide-react";
import type { SkillHistoryEntry, SkillPackage } from "@linka-skillhub/core";
import { api } from "../api.js";
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

// R36-C20: format one parsed history entry into a single human sentence. We
// never expose raw git syntax — the action chip + detail line is the whole
// story for "merged", "pulled", etc. The "other" branch falls back to the
// raw subject so users still see SOMETHING for any commit that didn't follow
// our subject conventions (manual git commits, future actions we haven't
// taught the parser yet).
const formatAgentList = (agents: readonly string[]): string =>
  agents
    .map((agent) => agentTone[agent]?.label ?? agent)
    .join(" · ");

const renderHistoryDetail = (entry: SkillHistoryEntry, lang: Language): string => {
  const t = messages[lang];
  const agents = formatAgentList(entry.agents);
  switch (entry.action) {
    case "import": return t.historyDetailImport.replace("{agents}", agents || "?");
    case "pull":   return t.historyDetailPull.replace("{agents}", agents || "?");
    case "merge":  return t.historyDetailMerge.replace("{agents}", agents || "?");
    case "fork":   return t.historyDetailFork.replace("{agents}", agents || "?");
    default:       return t.historyDetailOther.replace("{subject}", entry.rawSubject);
  }
};

const renderHistoryAction = (entry: SkillHistoryEntry, lang: Language): string => {
  const t = messages[lang];
  switch (entry.action) {
    case "import": return t.historyActionImport;
    case "pull":   return t.historyActionPull;
    case "merge":  return t.historyActionMerge;
    case "fork":   return t.historyActionFork;
    default:       return t.historyActionOther;
  }
};

const formatTimestamp = (iso: string, lang: Language): string => {
  // Local-time short form. Avoid the user's TZ guess showing up as UTC drift.
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
};

// Sticky right-side panel that mirrors the focused skill's metadata. Every
// page that has a skill list pairs a SkillTable with one of these — Overview
// today, Intersect after this commit, Distribute and Repo in later commits.
export function DetailPanel({ skill, lang, emptyTextKey }: DetailPanelProps): JSX.Element {
  const t = messages[lang];
  // R36-C20: history is fetched lazily per focused skill. Cancelled across
  // focus changes via the request-id race guard so a slow earlier request
  // can't overwrite a faster later one. Empty array = "fetched + nothing
  // there"; null = "haven't fetched yet / loading"; the rendering
  // differentiates between the two so we don't flash "no history" briefly.
  const [history, setHistory] = useState<SkillHistoryEntry[] | null>(null);
  useEffect(() => {
    if (!skill) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    setHistory(null);
    api.skillHistory(skill.name)
      .then((result) => { if (!cancelled) setHistory(result.entries); })
      .catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
  }, [skill?.name]);

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
      <div className="work-card history-card">
        <h3>{t.historyTitle}</h3>
        {history === null && <p className="muted-copy">{t.historyLoading}</p>}
        {history !== null && history.length === 0 && <p className="muted-copy">{t.historyEmpty}</p>}
        {history !== null && history.length > 0 && (
          <ol className="history-timeline">
            {history.map((entry) => (
              <li key={entry.shortSha} className={`history-entry history-action-${entry.action}`}>
                <div className="history-marker" aria-hidden />
                <div className="history-body">
                  <div className="history-row-top">
                    <span className="history-action">{renderHistoryAction(entry, lang)}</span>
                    <time className="history-ts" dateTime={entry.ts}>{formatTimestamp(entry.ts, lang)}</time>
                  </div>
                  <div className="history-detail">
                    {entry.agents.length > 0 && entry.action !== "other" ? (
                      <>
                        {entry.agents.map((agent, index) => (
                          // Index suffix on the key guards against a parser
                          // producing duplicate agents (e.g. `merge x (a + a)`
                          // from a malformed subject) — React would otherwise
                          // warn on the key collision.
                          <AgentLogo key={`${agent}-${index}`} agent={agent} />
                        ))}
                        <span>{renderHistoryDetail(entry, lang)}</span>
                      </>
                    ) : (
                      <span>{renderHistoryDetail(entry, lang)}</span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
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
