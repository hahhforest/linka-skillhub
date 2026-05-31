import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, FileText, GitFork, GitMerge, PackageCheck } from "lucide-react";
import type { CanonicalSyncStatus, RegistryInstance, SkillHistoryEntry, SkillPackage, SyncMergeResult } from "@linka-skillhub/core";
import { api } from "../api.js";
import { humanizeError } from "../humanize-error.js";
import { messages, type Language } from "../i18n.js";
import { AgentLogo, agentTone, bucketLabel, statusClass } from "./skillVisuals.js";
import { MergeDialog } from "./MergeDialog.js";
import { FixFrontmatterDialog } from "./FixFrontmatterDialog.js";

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
  // R36-C21: drift state for this canonical. Same lazy-fetch pattern as
  // history. Re-fetched after any sync action so the UI reflects the new
  // hash + per-instance status without a full page reload.
  const [sync, setSync] = useState<CanonicalSyncStatus | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string>("");
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  // R36-C23: open only when the focused skill has at least one "invalid" issue
  // (missing name/description in SKILL.md, broken YAML, etc.). After a
  // successful apply we refetch the same skill so the issues list / status
  // pill / sync state all reflect the now-valid skill.
  const [fixOpen, setFixOpen] = useState(false);
  const isInvalid = skill?.status?.includes("invalid") ?? false;
  const refreshSync = (name: string): Promise<void> =>
    api.syncStatusFor(name)
      .then((result) => { setSync(result.status); })
      .catch(() => { setSync(null); });
  const refreshHistory = (name: string): Promise<void> =>
    api.skillHistory(name)
      .then((result) => { setHistory(result.entries); })
      .catch(() => { setHistory([]); });
  useEffect(() => {
    if (!skill) {
      setHistory(null);
      setSync(null);
      setSyncMessage("");
      return;
    }
    let cancelled = false;
    setHistory(null);
    setSync(null);
    setSyncMessage("");
    api.skillHistory(skill.name)
      .then((result) => { if (!cancelled) setHistory(result.entries); })
      .catch(() => { if (!cancelled) setHistory([]); });
    api.syncStatusFor(skill.name)
      .then((result) => { if (!cancelled) setSync(result.status); })
      .catch(() => { if (!cancelled) setSync(null); });
    return () => { cancelled = true; };
  }, [skill?.name]);

  // Each sync action refreshes BOTH history (a new commit landed) and the
  // sync state (canonical hash + per-instance status changed). Errors are
  // surfaced inline; we don't throw past the click handler.
  const runSyncAction = async (action: () => Promise<string>): Promise<void> => {
    if (!skill || syncBusy) return;
    setSyncBusy(true);
    setSyncMessage("");
    try {
      const message = await action();
      await Promise.all([refreshSync(skill.name), refreshHistory(skill.name)]);
      setSyncMessage(message);
    } catch (error) {
      setSyncMessage(humanizeError(error, lang));
    } finally {
      setSyncBusy(false);
    }
  };

  const handlePull = (instance: RegistryInstance) =>
    runSyncAction(async () => {
      const agent = instance.viaAgents[0]!;
      const result = await api.syncPull(skill!.name, agent);
      if (result.oldHash === result.newHash) {
        return t.syncDoneAlreadyInSync
          .replace("{name}", result.name)
          .replace("{agent}", agentTone[agent]?.label ?? agent);
      }
      return t.syncDonePulled
        .replace("{name}", result.name)
        .replace("{agent}", agentTone[agent]?.label ?? agent)
        .replace("{count}", String(result.otherDrifted.length));
    });

  const handlePush = (instance: RegistryInstance) =>
    runSyncAction(async () => {
      const agent = instance.viaAgents[0]!;
      const result = await api.syncPush(skill!.name, agent);
      return t.syncDonePushed
        .replace("{name}", result.name)
        .replace("{agent}", agentTone[agent]?.label ?? agent);
    });

  const handlePushAll = () =>
    runSyncAction(async () => {
      const result = await api.syncPushAll(skill!.name);
      if (result.results.length === 0) {
        return t.syncDoneNothing.replace("{name}", result.name);
      }
      return t.syncDonePushAll
        .replace("{name}", result.name)
        .replace("{count}", String(result.results.length));
    });

  const handleFork = (instance: RegistryInstance) => {
    // Use a native prompt for the fork name — keeps C21 scope tight; a
    // proper dialog would belong with the merge UI in C22. Empty or invalid
    // input simply aborts after surfacing a message.
    const proposed = window.prompt(`${t.syncForkPromptTitle}\n\n${t.syncForkPromptBody}`, `${skill!.name}-fork`);
    if (proposed == null) return;
    const newName = proposed.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(newName)) {
      setSyncMessage(t.syncForkInvalidName);
      return;
    }
    void runSyncAction(async () => {
      const agent = instance.viaAgents[0]!;
      const result = await api.syncFork(skill!.name, agent, newName);
      return t.syncDoneForked
        .replace("{name}", result.newName)
        .replace("{agent}", agentTone[agent]?.label ?? agent);
    });
  };

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
    <>
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
      <div className="work-card instances-card">
        <div className="instances-head">
          <h3>{t.instancesTitle}</h3>
          <div className="instances-head-actions">
            {/* R36-C22: merge is gated stricter than push-all because it
                spawns an agent and writes a new canonical — only show when
                there's actual drift across at least 2 instances to reconcile. */}
            {sync && sync.hasDrift && sync.instances.length >= 2 && (
              <button
                type="button"
                className="ghost instances-merge"
                onClick={() => setMergeDialogOpen(true)}
                disabled={syncBusy}
                title={t.syncActionMerge}
              >
                <GitMerge size={14} />
                {t.syncActionMerge}
              </button>
            )}
            {sync && (sync.hasDrift || sync.hasMissing) && (
              <button
                type="button"
                className="ghost instances-push-all"
                onClick={handlePushAll}
                disabled={syncBusy}
                title={t.syncActionPushAll}
              >
                <ArrowUpFromLine size={14} />
                {t.syncActionPushAll}
              </button>
            )}
          </div>
        </div>
        {sync === null && <p className="muted-copy">{t.historyLoading}</p>}
        {sync && sync.instances.length === 0 && (
          <p className="muted-copy">{t.instancesEmpty}</p>
        )}
        {sync && sync.instances.length > 0 && (
          <ul className="instance-list">
            {sync.instances.map((instance) => {
              // R36-C21: action-button gating mirrors the CLI:
              //   in-sync → no buttons (nothing to reconcile)
              //   drifted → pull / fork (consume the edits) + push (discard them)
              //   missing → push only (re-materialise canonical at realPath)
              const statusLabel =
                instance.status === "in-sync" ? t.instanceStatusInSync :
                instance.status === "drifted" ? t.instanceStatusDrifted :
                t.instanceStatusMissing;
              return (
                <li
                  key={instance.realPath}
                  className={`instance-row instance-status-${instance.status}`}
                >
                  <div className="instance-row-top">
                    <span className={`instance-badge instance-badge-${instance.status}`}>
                      {statusLabel}
                    </span>
                    <div className="instance-agents">
                      {instance.viaAgents.map((agent) => (
                        <AgentLogo key={agent} agent={agent} />
                      ))}
                    </div>
                  </div>
                  <code className="instance-path">{instance.realPath}</code>
                  {(instance.status === "drifted" || instance.status === "missing") && (
                    <div className="instance-actions">
                      {instance.status === "drifted" && (
                        <button
                          type="button"
                          className="ghost instance-action"
                          onClick={() => handlePull(instance)}
                          disabled={syncBusy}
                          title={t.syncActionPull}
                        >
                          <ArrowDownToLine size={14} />
                          {t.syncActionPull}
                        </button>
                      )}
                      {instance.status === "drifted" && (
                        <button
                          type="button"
                          className="ghost instance-action"
                          onClick={() => handleFork(instance)}
                          disabled={syncBusy}
                          title={t.syncActionFork}
                        >
                          <GitFork size={14} />
                          {t.syncActionFork}
                        </button>
                      )}
                      <button
                        type="button"
                        className="ghost instance-action"
                        onClick={() => handlePush(instance)}
                        disabled={syncBusy}
                        title={t.syncActionPush}
                      >
                        <ArrowUpFromLine size={14} />
                        {t.syncActionPush}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {syncBusy && <p className="muted-copy sync-busy">{t.syncRunning}</p>}
        {syncMessage && !syncBusy && <p className="sync-message">{syncMessage}</p>}
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
        {/* R36-C23: only when the skill is actually invalid (missing name/desc,
            broken YAML, etc.) does the auto-fix button make sense. The
            underlying core function copies inferred name + description into
            SKILL.md frontmatter and rewrites the manifest to clear the
            "invalid" status. */}
        {isInvalid && (
          <button
            type="button"
            className="ghost fix-frontmatter-button"
            onClick={() => setFixOpen(true)}
            title={t.fixFrontmatterAction}
          >
            <FileText size={14} /> {t.fixFrontmatterAction}
          </button>
        )}
      </div>
      <div className="work-card path-card">
        <h3>{t.path}</h3>
        <code>{skill.skillDir}</code>
      </div>
    </section>
    {mergeDialogOpen && sync && (
      <MergeDialog
        lang={lang}
        skill={skill}
        sync={sync}
        onClose={() => setMergeDialogOpen(false)}
        onMerged={(result: SyncMergeResult) => {
          setMergeDialogOpen(false);
          void Promise.all([refreshSync(skill.name), refreshHistory(skill.name)]);
          setSyncMessage(
            t.mergeDoneSuccess
              .replace("{name}", result.name)
              .replace("{from}", result.fromAgents.map((agent) => agentTone[agent]?.label ?? agent).join(" + "))
              .replace("{agent}", agentTone[result.byAgent]?.label ?? result.byAgent)
              .replace("{drifted}", String(result.otherDrifted.length))
          );
        }}
      />
    )}
    {fixOpen && (
      <FixFrontmatterDialog
        lang={lang}
        skill={skill}
        onClose={() => setFixOpen(false)}
        onApplied={() => {
          // The skill's issues are now empty and the manifest will list it
          // as valid. Reload both history (a new commit landed) and the
          // parent skill list so the Overview / table cells update too.
          void Promise.all([refreshSync(skill.name), refreshHistory(skill.name)]);
          setSyncMessage(t.fixFrontmatterAction);
        }}
      />
    )}
    </>
  );
}
