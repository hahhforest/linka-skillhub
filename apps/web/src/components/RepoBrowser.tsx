import { useMemo, useState } from "react";
import {
  Database,
  GitBranch,
  HardDriveDownload,
  Info,
  Link2,
  Loader2,
  RefreshCw,
  Sparkles,
  UploadCloud
} from "lucide-react";
import type { AgentDefinition, SkillPackage } from "@linka-skillhub/core";
import type { RegistryLoadResponse } from "../api.js";
import { messages, type Language } from "../i18n.js";
import { DetailPanel } from "./DetailPanel.js";
import { SkillTable } from "./SkillTable.js";
import { agentTone } from "./skillVisuals.js";
import { AgentSelect } from "./AgentSelect.js";
import { LoadRegistryDialog } from "./LoadRegistryDialog.js";
import { ImportConfirmDialog } from "./ImportConfirmDialog.js";
import { ConnectRemoteDialog } from "./ConnectRemoteDialog.js";

export interface RepoBrowserProps {
  readonly skills: SkillPackage[];
  readonly allSkills: SkillPackage[];
  readonly totalSkillCount: number;
  readonly agents: AgentDefinition[];
  readonly focusedSkillId: string | null;
  readonly onFocus: (id: string) => void;
  readonly lang: Language;
  readonly registryRepo: string;
  readonly busy: boolean;
  readonly message: string;
  readonly query: string;
  readonly gitStatus: string;
  readonly commitMessage: string;
  readonly setCommitMessage: (value: string) => void;
  readonly onImport: () => Promise<void> | void;
  // ids: empty array means "no scope checked, fall back to all registry skills".
  // The dialog itself handles reviewer selection; the parent just needs to
  // know which subset to run against. Distribute uses an explicit set for the
  // same reason — keeping every page's selection local to that page.
  readonly onReview: (ids: string[]) => void;
  readonly onRefreshGit: () => void;
  readonly onPull: () => void;
  readonly onPush: () => void;
  readonly onRegistryLoaded: (result: RegistryLoadResponse) => void;
  // R36-C23: fired after ConnectRemoteDialog succeeds, carrying the new
  // post-setRemote git status text. The parent uses it to update the meta
  // bar's branch chip + git-status pre without a full reload.
  readonly onRemoteConnected: (newGitStatus: string, boundUrl: string) => void;
}

// First line of `git status --short --branch` is `## <branch>...<remote>` (or
// `## <branch>` for a branch without an upstream). We surface just the branch
// name as a meta chip; the full status pre is still available below for users
// who need the per-file detail.
function extractBranch(gitStatus: string): string | null {
  const first = gitStatus.split("\n", 1)[0]?.trim();
  if (!first || !first.startsWith("##")) return null;
  const rest = first.slice(2).trim();
  if (!rest) return null;
  const dotIdx = rest.indexOf("...");
  return dotIdx === -1 ? rest : rest.slice(0, dotIdx);
}

// Replaces RepoView. The page is now organised around the Registry itself:
//   meta bar  -> "what registry am I looking at?"
//   action bar -> "what can I do to it?"
//   table+detail -> "what's in it?"
//   log         -> "what was the last thing I did?"
// The old layout dumped four equal-weight action cards and a black git pre
// onto the screen with no explanation of how the Registry related to the
// Overview's local-machine skills. R34's plan made this restructure
// non-negotiable: until the user can see the Registry contents from the Repo
// page, "import" / "distribute" are abstract verbs.
export function RepoBrowser({
  skills,
  allSkills,
  totalSkillCount,
  agents,
  focusedSkillId,
  onFocus,
  lang,
  registryRepo,
  busy,
  message,
  query,
  gitStatus,
  commitMessage,
  setCommitMessage,
  onImport,
  onReview,
  onRefreshGit,
  onPull,
  onPush,
  onRegistryLoaded,
  onRemoteConnected
}: RepoBrowserProps): JSX.Element {
  const t = messages[lang];
  // Selection scope for "Run review on these skills". Empty Set means "all
  // Registry skills" — same convention as Distribute / api.review's omitted
  // skillIds. Local to RepoBrowser so a switch to another tab doesn't carry
  // an old review scope with it.
  const [selectedForReview, setSelectedForReview] = useState<Set<string>>(new Set());
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [showConnectDialog, setShowConnectDialog] = useState(false);

  const branch = useMemo(() => extractBranch(gitStatus), [gitStatus]);
  const matchesAgent = (skill: SkillPackage) => agentFilter === "all" || skill.source.agent === agentFilter;
  const displayedSkills = useMemo(() => skills.filter(matchesAgent), [skills, agentFilter]);
  const focusedSkill = focusedSkillId ? allSkills.find((skill) => skill.id === focusedSkillId) : undefined;
  const focusedHidden = focusedSkill ? !displayedSkills.some((skill) => skill.id === focusedSkill.id) : false;
  const toggleSelectForReview = (id: string) => {
    setSelectedForReview((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const reviewIds = [...selectedForReview];
  // Display the count even when 0 so the user understands the default scope
  // (= entire Registry). The dialog also surfaces "N registry skills".
  const reviewScopeLabel = selectedForReview.size === 0
    ? t.reviewScopeAllRegistry.replace("{n}", String(totalSkillCount))
    : t.reviewScopeSelected.replace("{n}", String(selectedForReview.size));
  const tableCount = displayedSkills.length === totalSkillCount
    ? `${totalSkillCount}`
    : `${displayedSkills.length} / ${totalSkillCount}`;
  const handleImportClick = () => setShowImportConfirm(true);
  const confirmImport = async () => {
    setShowImportConfirm(false);
    await onImport();
  };
  const isEmpty = totalSkillCount === 0;

  return (
    <section className="repo-browser-layout">
      <div className="section-head">
        <div>
          <h2>{t.repositoryTitle}</h2>
          <p>{t.repositoryDesc}</p>
        </div>
      </div>

      {/* Meta bar — pure-display chips for "what is this page operating on?".
          Clickable affordance is just "switch registry"; everything else is a
          status read-out. Keeping it as one row keeps the eye glide light. */}
      <div className="work-card repo-meta-bar">
        <div className="repo-meta-chips">
          <span className="repo-meta-chip" title={registryRepo}>
            <Database size={14} /> <code>{registryRepo || "-"}</code>
          </span>
          {branch && (
            <span className="repo-meta-chip">
              <GitBranch size={14} /> {branch}
            </span>
          )}
          <span className="repo-meta-chip">
            {totalSkillCount} {t.metaSkillsSuffix}
          </span>
        </div>
        <button className="ghost" type="button" onClick={() => setShowLoadDialog(true)} disabled={busy}>
          <HardDriveDownload size={14} /> {t.switchRegistry}
        </button>
      </div>

      {/* Action bar — every Registry write/sync action lives here. Each button
          is a verb pinned to the meta target above; commit message is inline
          so the user sees what's about to ship before clicking push. */}
      <div className="work-card repo-action-bar">
        <div className="repo-action-row">
          <button className="primary" onClick={handleImportClick} disabled={busy} title={t.importToRegistryDesc}>
            {busy ? <Loader2 className="spin" size={14} /> : <Database size={14} />} {t.importToRegistry}
          </button>
          {/* R35-C12: a single "Review Skills" entry point — the previous two
              buttons (deterministic rules vs. code-agent) only differed in which
              radio was preselected inside the same dialog, so they collapsed
              into pure UI noise (same icon, same handler shape, same disabled
              rules). The dialog still lets the user pick any available reviewer. */}
          <button className="ghost" onClick={() => onReview(reviewIds)} disabled={busy || isEmpty} title={t.reviewSkillsDesc}>
            <Sparkles size={14} /> {t.reviewSkills}
          </button>
          <span className="repo-action-spacer" />
          <button className="ghost" onClick={onRefreshGit} disabled={busy}>
            <RefreshCw size={14} /> {t.refreshGitStatus}
          </button>
          {/* R36-C23: bind this Registry repo to a GitHub remote. The CLI's
              `lsh repo connect --remote <url>` was the only entry point before
              — WebUI users had to drop to a terminal. Pairs with the
              refresh / pull / push trio as the other half of the same flow. */}
          <button className="ghost" onClick={() => setShowConnectDialog(true)} disabled={busy} title={t.connectRemote}>
            <Link2 size={14} /> {t.connectRemote}
          </button>
          <button className="ghost" onClick={onPull} disabled={busy}>
            <HardDriveDownload size={14} /> {t.pullRegistry}
          </button>
          <button className="primary" onClick={onPush} disabled={busy}>
            <UploadCloud size={14} /> {t.pushRegistry}
          </button>
        </div>
        <div className="repo-action-row repo-action-row-compact">
          <label className="repo-commit-message">
            <span>{t.commitMessage}:</span>
            <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} />
          </label>
          <span className="repo-action-spacer" />
          <span className="repo-review-scope">{t.reviewScope}: {reviewScopeLabel}</span>
        </div>
      </div>

      {/* Body — same SkillTable + DetailPanel pairing as Overview/Distribute,
          so the Registry view feels like a sibling rather than a strange page
          built out of different primitives. Checkbox column scopes review. */}
      <div className="repo-body">
        <div className="work-card repo-table-card">
          <div className="card-head">
            <div>
              <h3>{t.registryBrowserTitle}<span className="title-count">{tableCount}</span></h3>
              <p>{t.registryBrowserHint}</p>
            </div>
            <div className="overview-agent-filter">
              <span className="overview-agent-filter-label">{t.overviewAgentFilterLabel}</span>
              <AgentSelect
                value={agentFilter}
                onChange={setAgentFilter}
                ariaLabel={t.overviewAgentFilterLabel}
                className="is-compact"
                options={[
                  { value: "all", label: t.allSources },
                  ...agents.map((agent) => ({ value: agent.kind, label: agentTone[agent.kind]?.label ?? agent.label }))
                ]}
              />
            </div>
          </div>
          {isEmpty ? (
            <div className="skill-table-empty muted-copy">
              <Info size={16} /> {t.registryEmptyBody}
            </div>
          ) : (
            <SkillTable
              skills={displayedSkills}
              lang={lang}
              focusedId={focusedSkillId}
              onFocus={onFocus}
              selectedIds={selectedForReview}
              onToggleSelect={toggleSelectForReview}
              emptyText={query.trim() ? t.noMatchTitle : t.registryEmptyTitle}
            />
          )}
        </div>
        <div className="repo-detail-panel">
          <DetailPanel skill={focusedSkill} lang={lang} />
          {focusedSkill && focusedHidden && (
            <p className="muted-copy">{t.focusedHidden}</p>
          )}
        </div>
      </div>

      {/* Git status pre is collapsed into a single utility card below the
          main body. It used to be a full-grid black box, which felt like a
          terminal had been embedded mid-page. Keep it light, monospaced,
          and out of the primary visual flow. */}
      {gitStatus && (
        <div className="work-card repo-git-status">
          <h3>{t.gitStatus}</h3>
          <pre>{gitStatus}</pre>
        </div>
      )}

      {/* Operation log only renders when there's actually something to show.
          Pre-R34 this was always-visible "等待操作" placeholder noise. */}
      {message && (
        <div className="work-card repo-log-card">
          <h3>{t.operationLog}</h3>
          <pre>{message}</pre>
        </div>
      )}

      {showLoadDialog && (
        <LoadRegistryDialog
          lang={lang}
          currentRepoPath={registryRepo}
          onLoaded={(result) => { onRegistryLoaded(result); }}
          onClose={() => setShowLoadDialog(false)}
        />
      )}
      {showImportConfirm && (
        <ImportConfirmDialog
          lang={lang}
          registryRepo={registryRepo}
          skillCount={totalSkillCount}
          busy={busy}
          onConfirm={() => void confirmImport()}
          onCancel={() => setShowImportConfirm(false)}
        />
      )}
      {showConnectDialog && (
        <ConnectRemoteDialog
          lang={lang}
          registryRepo={registryRepo}
          onConnected={(status, url) => onRemoteConnected(status, url)}
          onClose={() => setShowConnectDialog(false)}
        />
      )}
    </section>
  );
}
