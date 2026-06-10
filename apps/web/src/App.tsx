import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  Database,
  FolderPlus,
  GitBranch,
  GitCompareArrows,
  HardDriveDownload,
  Info,
  Loader2,
  PackageCheck,
  RefreshCw,
  Search,
  ShieldAlert,
  UploadCloud,
  X
} from "lucide-react";
import type { AgentDefinition, DistributionPlan, DistributionTarget, SkillPackage, SkillScope } from "@linka-skillhub/core";
import { api, type ReviewerInfo, type Summary } from "./api.js";
import { messages, tReason, type Language } from "./i18n.js";
import { AddSourceDialog } from "./components/AddSourceDialog.js";
import { ConfirmPlanModal } from "./components/ConfirmPlanModal.js";
import { useModalFocusTrap } from "./components/useModalFocusTrap.js";
import { AgentLogo, agentTone, scopeLabel } from "./components/skillVisuals.js";
import { AgentSelect } from "./components/AgentSelect.js";
import { SkillTable } from "./components/SkillTable.js";
import { DetailPanel } from "./components/DetailPanel.js";
import { RepoBrowser } from "./components/RepoBrowser.js";
import { humanizeError } from "./humanize-error.js";

type View = "overview" | "intersect" | "distribute" | "repo";
type Dialog = "scan" | "review" | "confirmPlan" | "addSource" | null;

// Mirrors @linka-skillhub/core's summarizeSkills semantics (kept local because
// the core barrel imports node:* modules that don't survive a browser bundle).
// CLI and server both go through core's summarizeSkills; this stays in lockstep.
const summarizeSkills = (skills: readonly SkillPackage[]): Summary => ({
  total: skills.length,
  valid: skills.filter((skill) => skill.status.includes("valid")).length,
  portable: skills.filter(
    (skill) =>
      skill.status.includes("portable") &&
      !skill.status.includes("agent_bound") &&
      !skill.status.includes("unsafe")
  ).length,
  agentBound: skills.filter((skill) => skill.status.includes("agent_bound")).length,
  unsafe: skills.filter((skill) => skill.status.includes("unsafe")).length,
  invalid: skills.filter((skill) => skill.status.includes("invalid")).length
});

function profileLabel(profile: string, lang: Language): string {
  if (profile === "mirror") return messages[lang].profileMirror;
  if (profile === "sandbox") return messages[lang].profileSandbox;
  if (profile === "local") return messages[lang].profileLocal;
  return profile;
}

function StatCard({ title, value, sub, icon, tone = "neutral" }: { readonly title: string; readonly value: number; readonly sub: string; readonly icon: React.ReactNode; readonly tone?: "neutral" | "success" | "warning" | "danger" }) {
  return (
    <div className="stat-card">
      <div className={`stat-icon tone-${tone}`}>{icon}</div>
      <div>
        <p>{title}</p>
        <strong>{value}</strong>
        <span>{sub}</span>
      </div>
    </div>
  );
}

function actionLabel(action: string, lang: Language): string {
  const t = messages[lang];
  if (action === "copy") return t.copyAction;
  if (action === "overwrite") return t.overwriteAction;
  if (action === "skip") return t.skipAction;
  return action;
}

function localizedPlanReason(item: DistributionPlan["items"][number], lang: Language): string {
  return tReason(lang, item.reasonCode, item.reason);
}

function localizedReviewerReason(reviewer: ReviewerInfo, lang: Language): string {
  const t = messages[lang] as Record<string, string>;
  if (!reviewer.reasonCode) return reviewer.reason;
  const key = `reviewer_reason_${reviewer.reasonCode}`;
  const template = t[key];
  if (typeof template !== "string") return reviewer.reason;
  return template
    .replace("{command}", reviewer.command ?? "")
    .replace("{path}", reviewer.path ?? "");
}

function PlanItems({ plan, lang }: { readonly plan: DistributionPlan; readonly lang: Language }) {
  const t = messages[lang];
  return (
    <div className="plan-items">
      {plan.items.map((item) => (
        <div key={`${item.target.agent}-${item.skill.id}`} className={`plan-item plan-${item.action}`}>
          <div className="plan-item-title">
            <strong>{actionLabel(item.action, lang)}</strong>
            <span>{item.skill.name} → {item.target.label}</span>
          </div>
          <dl>
            <dt>{t.reason}</dt><dd>{localizedPlanReason(item, lang)}</dd>
            {item.existingPath && <><dt>{t.existingPath}</dt><dd><code>{item.existingPath}</code></dd></>}
            {item.backupPath && <><dt>{t.backupPath}</dt><dd><code>{item.backupPath}</code></dd></>}
          </dl>
        </div>
      ))}
    </div>
  );
}

function Sidebar({ view, setView, lang }: {
  readonly view: View;
  readonly setView: (view: View) => void;
  readonly lang: Language;
}) {
  const t = messages[lang];
  const items: readonly [View, React.ReactNode, string][] = [
    ["overview", <Database size={16} />, t.navOverview],
    ["intersect", <GitCompareArrows size={16} />, t.navIntersect],
    ["distribute", <HardDriveDownload size={16} />, t.navDistribute],
    ["repo", <GitBranch size={16} />, t.navRepo]
  ];
  return (
    <aside className="sidebar">
      <div className="brand-lockup">
        <div className="brand-cube">◆</div>
        <div><strong>SkillHub</strong><span>linka-skillhub</span></div>
      </div>
      <div className="sidebar-group-label">{t.navGroupLabel}</div>
      <nav>{items.map(([key, icon, label]) => <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>{icon}{label}</button>)}</nav>
    </aside>
  );
}

function Overview({ skills, focusedSkillId, focusSkill, lang, totalSkillCount, allSkills, query, agents, overviewAgentFilter, setOverviewAgentFilter, onOpenAddSource, onSkillChanged }: {
  readonly skills: SkillPackage[];
  readonly focusedSkillId: string | null;
  readonly focusSkill: (id: string) => void;
  readonly lang: Language;
  readonly totalSkillCount: number;
  readonly allSkills: SkillPackage[];
  readonly query: string;
  readonly agents: AgentDefinition[];
  readonly overviewAgentFilter: string;
  readonly setOverviewAgentFilter: (value: string) => void;
  readonly onOpenAddSource: () => void;
  readonly onSkillChanged: () => Promise<void> | void;
}) {
  const t = messages[lang];
  // R34 commit 2: agent filtering moved off the sidebar and into this header
  // dropdown. The state lives in App so it survives view switches, but only
  // Overview reads/writes it — Intersect / Distribute / Repo each manage
  // their own scope and never see this value.
  const agentMatches = (skill: SkillPackage) => overviewAgentFilter === "all" || skill.source.agent === overviewAgentFilter;
  // R35-C5: source-bar selection — a click on a (agent, scope) row narrows
  // the stat cards + donut + table to only skills coming from that source.
  // Clicking the same row again clears the narrow. The state is local to
  // Overview because no other page consumes it; reset on agent-filter change
  // so the user does not end up with a "selected Mavis/user" pin that
  // suddenly contradicts a "claude only" dropdown choice.
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null);
  const sourceKeyOf = (agent: string, scope: SkillScope) => `${agent}::${scope}`;
  const sourceMatches = (skill: SkillPackage) =>
    !selectedSourceKey || sourceKeyOf(skill.source.agent, skill.source.scope) === selectedSourceKey;
  useEffect(() => { setSelectedSourceKey(null); }, [overviewAgentFilter]);
  const displayedSkills = useMemo(
    () => skills.filter((skill) => agentMatches(skill) && sourceMatches(skill)),
    [skills, overviewAgentFilter, selectedSourceKey]
  );
  const summary = useMemo(() => summarizeSkills(displayedSkills), [displayedSkills]);
  // When the combined filter empties the table, fall back to the agent-only
  // scope for the stat cards / charts so the page does not collapse to one
  // empty state. The table still shows the no-match message on its own.
  const agentOnlySkills = useMemo(() => allSkills.filter(agentMatches), [allSkills, overviewAgentFilter]);
  const agentOnlySummary = useMemo(() => summarizeSkills(agentOnlySkills), [agentOnlySkills]);
  const tableEmpty = summary.total === 0;
  // R35-C5: when the user has explicitly selected a source bar, honor that
  // even if the result is empty — otherwise the cards would silently jump
  // back to the wider agent scope and lie about what they're showing.
  const cardsSkills = (!tableEmpty || selectedSourceKey) ? displayedSkills : agentOnlySkills;
  const cardsSummary = (!tableEmpty || selectedSourceKey) ? summary : agentOnlySummary;
  const selectedSourceLabel = selectedSourceKey ? (() => {
    const [agent, scope] = selectedSourceKey.split("::") as [string, SkillScope];
    return `${agentTone[agent]?.label ?? agent} / ${scopeLabel(scope, lang)}`;
  })() : null;
  const isAgentFiltered = overviewAgentFilter !== "all";
  const sourceLabel = selectedSourceLabel ?? (isAgentFiltered ? (agentTone[overviewAgentFilter]?.label ?? overviewAgentFilter) : t.allSources);
  // R35-C8: the "已筛选 X / Y · 来源 X · 分布 Y · 清除筛选" banner was deleted.
  // Every piece of info it surfaced is already visible on the page after R35-C5
  // + R35-C7: the selected source-bar carries `.selected` styling, the donut
  // card grows a path strip naming the (agent, scope) bucket, the stat cards
  // numbers already reflect the narrow, and the agent dropdown shows its own
  // value. "Clear" works by clicking the same bar again or resetting the
  // dropdown. One info channel is enough.
  // R35-C3: replace single-agent counts with (agent, scope) buckets so the
  // user can see "Mavis/builtin 19", "Mavis/user 7", "codex/system 5", etc.
  // Seeded from each agent's declared sourceDirs (zero rows for empty scopes
  // like opencode/user) so missing skills produce a visible 0 row rather than
  // silently disappearing.
  const bySource = useMemo(() => {
    type Row = { readonly agent: string; readonly scope: SkillScope; count: number };
    const counts = new Map<string, Row>();
    const keyOf = (agent: string, scope: SkillScope) => `${agent}${scope}`;
    for (const agent of agents) {
      for (const source of agent.sourceDirs) {
        counts.set(keyOf(agent.kind, source.scope), { agent: agent.kind, scope: source.scope, count: 0 });
      }
    }
    // Source bars follow the same scope the stat cards + table are showing
    // (search + agent + source-key), not the agent-only subset. When the
    // search box has "lark-approval" in it, the cards already say "1"; the
    // bars saying "Hermes 88" was a stale view that contradicted the table.
    // When a single (agent, scope) source-key is selected, the unselected
    // bars correctly go to 0 — that visual emptiness IS the "you narrowed
    // here" signal.
    for (const skill of displayedSkills) {
      const key = keyOf(skill.source.agent, skill.source.scope);
      const row = counts.get(key) ?? { agent: skill.source.agent, scope: skill.source.scope, count: 0 };
      row.count += 1;
      counts.set(key, row);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [displayedSkills, agents]);
  // R35-C5: bar fill widths use the largest single-bucket count as 100%, NOT
  // cardsSummary.total. When a small bucket is selected cardsSummary.total
  // drops to that bucket's count, which would visually rescale every bar to
  // 100% width and make the chart look like the data changed.
  const sourceBarMax = bySource.reduce((max, row) => Math.max(max, row.count), 0);
  const toggleSourceSelection = (agent: string, scope: SkillScope) => {
    const key = sourceKeyOf(agent, scope);
    setSelectedSourceKey((prev) => (prev === key ? null : key));
  };
  const donutStyle = { "--ok": cardsSummary.portable, "--warn": cardsSummary.agentBound, "--bad": cardsSummary.invalid, "--all": Math.max(cardsSummary.total, 1) } as React.CSSProperties;
  // The Overview row is now single-focus: the focused skill drives the inline
  // detail panel below. Focus survives changes to the agent filter so the user
  // can switch dropdown values without losing their inspection target.
  const focusedSkill = useMemo(
    () => (focusedSkillId ? allSkills.find((skill) => skill.id === focusedSkillId) ?? null : null),
    [focusedSkillId, allSkills]
  );
  const focusedHidden = focusedSkill ? !displayedSkills.some((skill) => skill.id === focusedSkill.id) : false;

  const agentDropdown = (
    <div className="overview-agent-filter">
      <span className="overview-agent-filter-label">{t.overviewAgentFilterLabel}</span>
      <AgentSelect
        value={overviewAgentFilter}
        onChange={setOverviewAgentFilter}
        ariaLabel={t.overviewAgentFilterLabel}
        className="is-compact"
        options={[
          { value: "all", label: t.allSources },
          ...agents.map((agent) => ({ value: agent.kind, label: agentTone[agent.kind]?.label ?? agent.label }))
        ]}
      />
    </div>
  );

  if (totalSkillCount === 0) {
    return (
      <section className="panel-grid overview-grid">
        <div className="section-head span-all"><div><h2>{t.overview}</h2><p>{t.currentScope}: {sourceLabel}</p></div><button className="ghost overview-add-source" type="button" onClick={onOpenAddSource}><FolderPlus size={16} /> {t.addSourceButton}</button></div>
        <section className="work-card empty-state span-all"><Info size={24} /><h2>{t.noScanTitle}</h2><p>{t.noScanBody}</p></section>
      </section>
    );
  }
  if (cardsSummary.total === 0) {
    return (
      <section className="panel-grid overview-grid">
        <div className="section-head span-all"><div><h2>{t.overview}</h2><p>{t.currentScope}: {sourceLabel}</p></div><button className="ghost overview-add-source" type="button" onClick={onOpenAddSource}><FolderPlus size={16} /> {t.addSourceButton}</button></div>
        <section className="work-card empty-state span-all"><Info size={24} /><h2>{t.noMatchTitle}</h2><p>{t.noMatchBody}</p></section>
      </section>
    );
  }

  return (
    <section className="panel-grid overview-grid">
      <div className="section-head span-all"><div><h2>{t.overview}</h2><p>{t.currentScope}: {sourceLabel}</p></div><button className="ghost overview-add-source" type="button" onClick={onOpenAddSource}><FolderPlus size={16} /> {t.addSourceButton}</button></div>
      <StatCard tone="neutral" title={t.totalSkills} value={cardsSummary.total} sub={`${cardsSummary.valid} ${t.valid}`} icon={<PackageCheck size={18} />} />
      <StatCard tone="success" title={t.shareable} value={cardsSummary.portable} sub={t.defaultDistributionScope} icon={<Check size={18} />} />
      <StatCard tone="warning" title={t.agentBound} value={cardsSummary.agentBound} sub={t.needsConfirmation} icon={<AlertTriangle size={18} />} />
      <StatCard tone="danger" title={t.problematic} value={cardsSummary.invalid} sub={t.blockedByDefault} icon={<ShieldAlert size={18} />} />

      <div className="work-card source-card">
        <h3>{t.sourceDistribution}</h3>
        <p className="source-bars-hint muted-copy">{t.sourceBarFilterHint}</p>
        <div className="source-bars">
          {bySource.map(({ agent, scope, count }) => {
            const isSelected = selectedSourceKey === sourceKeyOf(agent, scope);
            return (
              <button
                key={`${agent}-${scope}`}
                type="button"
                className={`source-bar-row${isSelected ? " selected" : ""}`}
                onClick={() => toggleSourceSelection(agent, scope)}
                aria-pressed={isSelected}
              >
                <span>
                  <AgentLogo agent={agent} /> {agentTone[agent]?.label ?? agent}
                  <em className="scope-tag">{scopeLabel(scope, lang)}</em>
                </span>
                <strong>{count}</strong>
                <div className="bar-track"><i style={{ width: `${sourceBarMax ? (count / sourceBarMax) * 100 : 0}%` }} /></div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="work-card donut-card">
        {/* R35-C7: when a source bar is selected, the donut-card grows a small
            path strip on top so the user sees which directories actually feed
            the bucket they just narrowed to. paths come from the agent's
            declared sourceDirs filtered by the selected scope — already
            expandHome'd by the server. Multiple paths are listed (e.g. an
            opencode/user scope can be 4 dirs). */}
        {selectedSourceKey && (() => {
          const [selAgent, selScope] = selectedSourceKey.split("::") as [string, SkillScope];
          const def = agents.find((entry) => entry.kind === selAgent);
          const paths = def ? def.sourceDirs.filter((s) => s.scope === selScope).map((s) => s.path) : [];
          return (
            <div className="selected-source-paths">
              <div className="selected-source-head">
                <AgentLogo agent={selAgent} />
                <strong>{agentTone[selAgent]?.label ?? selAgent}</strong>
                <em className="scope-tag">{scopeLabel(selScope, lang)}</em>
              </div>
              {paths.length === 0 ? (
                <p className="muted-copy">{t.selectedSourceNoPaths}</p>
              ) : (
                <ul className="source-path-list">
                  {paths.map((p) => (
                    <li key={p}>
                      <code title={p}>{p}</code>
                      <button
                        type="button"
                        className="ghost source-path-copy"
                        onClick={() => { void navigator.clipboard.writeText(p); }}
                        aria-label={t.copyPath}
                        title={t.copyPath}
                      >
                        <Copy size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })()}
        <h3>{t.statusDistribution}</h3>
        {/* R36-C16: donut + legend laid out side-by-side inside a wrapper.
            Previously the donut-card's 2-column grid put h3 in col-1 and
            donut in col-2 of row 1, then legend in col-1 of row 2 with
            col-2 empty — that wasted ~half the card's vertical space when
            sitting next to the dense source-bars card on the left. Now the
            h3 is full-width on top and the body row uses flex so donut and
            legend share the remaining height without one stretching past
            the other. */}
        <div className="donut-body">
          <div className="donut" style={donutStyle} />
          {/* R35-C15: the donut already paints a trailing grey wedge for any
              skills that don't fall into portable / agent_bound / invalid (i.e.
              valid+unreviewed only). The legend used to skip that wedge, so a
              user who filtered to a tiny scope like openclaw (1 unreviewed
              skill) would see "可共享 0 · Agent 限定 0 · 存在问题 0" with no
              hint of where the 1 skill went. The fourth row makes that bucket
              explicit and matches the bucketLabel("other") wording elsewhere. */}
          <div className="status-list"><span><i className="dot ok" />{t.shareable} {cardsSummary.portable}</span><span><i className="dot warn" />{t.agentBound} {cardsSummary.agentBound}</span><span><i className="dot bad" />{t.problematic} {cardsSummary.invalid}</span><span><i className="dot other" />{t.unreviewedBucket} {Math.max(0, cardsSummary.total - cardsSummary.portable - cardsSummary.agentBound - cardsSummary.invalid)}</span></div>
        </div>
      </div>
      <div className="overview-results-row span-all">
        <div className="work-card table-card">
          {/* R35-C7 cleanup: dropped the "点击条目可加入审查/分发选择" subtitle —
              Overview has no checkbox column (R34-C1 made it single-focus),
              so the hint was a lie. Card head now only shows the count +
              agent dropdown. The selectionHint i18n key still drives the row
              tooltip in Intersect / Distribute where checkboxes do exist. */}
          <div className="card-head"><div><h3>{t.scanResults}<span className="title-count">{displayedSkills.length === totalSkillCount ? totalSkillCount : `${displayedSkills.length} / ${totalSkillCount}`}</span></h3></div>{agentDropdown}</div>
          {/* SkillTable handles both the row markup and the empty-state hint
              when displayedSkills is empty. Overview never passes selectedIds
              so the table renders in pure-browse mode (no checkbox column). */}
          <SkillTable
            skills={displayedSkills}
            lang={lang}
            focusedId={focusedSkillId}
            onFocus={focusSkill}
          />
        </div>
        <div className="overview-detail-panel">
          <DetailPanel skill={focusedSkill ?? undefined} lang={lang} onSkillChanged={onSkillChanged} />
          {focusedSkill && focusedHidden && (
            <p className="muted-copy">{t.focusedHidden}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function DialogFrame({ title, children, onClose, closeLabel }: { readonly title: string; readonly children: React.ReactNode; readonly onClose: () => void; readonly closeLabel?: string }) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef);
  return (
    <div className="dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} tabIndex={-1} className="dialog" onClick={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onClose} aria-label={closeLabel ?? "Close"}><X size={16} /></button>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function App() {
  const [lang, setLang] = useState<Language>("zh");
  const t = messages[lang];
  const [view, setView] = useState<View>("overview");
  const [skills, setSkills] = useState<SkillPackage[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [targets, setTargets] = useState<DistributionTarget[]>([]);
  const [profile, setProfile] = useState("unknown");
  const [registryRepo, setRegistryRepo] = useState("");
  // focusedSkillId is the "browse" semantic: which single skill is currently
  // open in the Overview detail panel. It is no longer used to drive
  // multi-select operations -- Intersect and Distribute each manage their own
  // per-page selection sets internally. R34 commit 1 splits these.
  const [focusedSkillId, setFocusedSkillId] = useState<string | null>(null);
  // Overview's agent filter is conceptually owned by the Overview page — only
  // Overview reads or writes it. It lives in App state so it survives view
  // switches (otherwise Overview unmounts and the dropdown resets on every
  // tab change). Intersect / Distribute / Repo never see this value.
  const [overviewAgentFilter, setOverviewAgentFilter] = useState<string>("all");
  const [plan, setPlan] = useState<DistributionPlan | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [includeBuiltin, setIncludeBuiltin] = useState(false);
  const [reviewer, setReviewer] = useState("rules");
  const [reviewers, setReviewers] = useState<ReviewerInfo[]>([]);
  const [gitStatusText, setGitStatusText] = useState("");
  const [commitMessage, setCommitMessage] = useState<string>(t.commitMessageDefault);
  const [pendingPlan, setPendingPlan] = useState<{ plan: DistributionPlan; confirmToken: string; targetAgents: string[]; skillIds: string[] | undefined } | null>(null);
  // Review scope selection: ids the Repo page checkboxes have queued. Empty
  // array means "no explicit scope" so runReview falls back to the entire
  // registry. The dialog also displays the count so the user knows which
  // subset is about to run.
  const [reviewScopeIds, setReviewScopeIds] = useState<string[]>([]);

  const loadShell = async () => {
    const [agentData, registry] = await Promise.all([api.agents(), api.skills()]);
    setAgents(agentData.agents); setTargets(agentData.targets); setProfile(agentData.profile ?? "unknown"); setRegistryRepo(agentData.registryRepo ?? ""); setSkills(registry.skills);
    if (registry.missingRegistry) setMessage(lang === "zh" ? "Registry 还没有导入记录，请先扫描或导入。" : "Registry is empty. Scan or import first.");
  };
  const loadShellMeta = async () => {
    const agentData = await api.agents();
    setAgents(agentData.agents); setTargets(agentData.targets); setProfile(agentData.profile ?? "unknown"); setRegistryRepo(agentData.registryRepo ?? "");
  };

  useEffect(() => { setCommitMessage(messages[lang].commitMessageDefault); }, [lang]);

  useEffect(() => { void loadShell().catch((error) => setMessage(humanizeError(error, lang))); }, []);

  // Clear transient footer/log message when the user switches views so a
  // distribute-page preview line (e.g. "复制预览: 4") doesn't bleed into the
  // repo page footer. loadShell sets its own message on mount and after
  // import/load, so this only nukes the in-page transient strings.
  useEffect(() => { setMessage(""); }, [view]);

  // R35-C14: officially-supported agents whose source has zero skills on
  // disk shouldn't pollute the read-side lists (Overview agent filter, source-
  // distribution bars, Intersect from/to selectors, RepoBrowser filter, status
  // footer). A user who doesn't run mavis or openclaw shouldn't see them
  // everywhere with "0". Computed off the full registry skill set (not the
  // query-filtered subset) so typing in the topbar search doesn't make agents
  // briefly vanish from the dropdowns. Targets (write-side, in Distribute)
  // intentionally still show every configured agent — initializing an empty
  // agent by copying skills into it is a real use case.
  const populatedAgents = useMemo(
    () => agents.filter((agent) => skills.some((skill) => skill.source.agent === agent.kind)),
    [agents, skills]
  );

  // R34 commit 2: the global agent filter that used to live in the sidebar is
  // gone. visibleSkills now only narrows by the topbar search query; agent
  // narrowing happens inside Overview / Intersect / Distribute / Repo, each
  // owning their own scope. summary is computed in Overview from its own
  // displayedSkills, so it no longer needs to live in App state.
  const visibleSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((skill) => `${skill.name} ${skill.description} ${skill.source.agent}`.toLowerCase().includes(q));
  }, [query, skills]);

  // Single-focus toggle: clicking the row that is already focused clears it
  // (so the detail panel returns to the empty state), otherwise replace.
  const focusSkill = (id: string) => setFocusedSkillId(id === focusedSkillId ? null : id);
  const runScan = async () => { setBusy(true); try { const scan = await api.scan(includeBuiltin); setSkills(scan.skills); setMessage(`${t.scan}: ${scan.summary.total}`); setDialog(null); } catch (error) { setMessage(humanizeError(error, lang)); } finally { setBusy(false); } };
  const importRepo = async () => { setBusy(true); try { const result = await api.import(); setMessage(`${t.imported} ${result.imported} skills → ${result.repoPath}`); await loadShell(); } catch (error) { setMessage(humanizeError(error, lang)); } finally { setBusy(false); } };
  const runReview = async () => {
    setBusy(true);
    try {
      // Scope precedence: Repo page checkboxes win when present, otherwise
      // fall back to every Registry skill. This restores the "review the
      // whole Registry" default that the four-action-card layout used to
      // implicitly mean, while letting power users narrow it via the
      // checkbox column added in R34 commit 5.
      const ids = reviewScopeIds.length > 0 ? reviewScopeIds : skills.map((skill) => skill.id);
      const result = await api.review(ids, reviewer, lang);
      setMessage(`${t.reviewed} ${result.reviews.length} skills`);
      setDialog(null);
    } catch (error) {
      setMessage(humanizeError(error, lang));
    } finally {
      setBusy(false);
    }
  };
  const openReviewDialog = async (preferred = "rules", scopeIds: string[] = []) => {
    setReviewer(preferred);
    setReviewScopeIds(scopeIds);
    setDialog("review");
    try {
      const result = await api.reviewers();
      setReviewers(result.reviewers);
    } catch (error) {
      setMessage(humanizeError(error, lang));
    }
  };
  // skillIds is passed through verbatim: undefined means "all registry skills"
  // (the server omits the filter). Intersect supplies an explicit list from
  // its local selectedForCopy; Distribute now also supplies an explicit list
  // from its local selectedForDistribute (R34 commit 4 ends the placeholder
  // omission that briefly distributed the whole registry by default).
  const planDistribution = async (targetAgents: string[], skillIds?: string[]) => {
    setBusy(true);
    try {
      const result = await api.distributionPlan(targetAgents, skillIds);
      setPlan(result.plan);
      setMessage(`${t.planSummary}: ${result.plan.items.length}`);
    } catch (error) {
      setMessage(humanizeError(error, lang));
    } finally {
      setBusy(false);
    }
  };
  const applyDistribution = async (targetAgents: string[], skillIds?: string[]) => {
    setBusy(true);
    try {
      const result = await api.distributionPlan(targetAgents, skillIds);
      setPlan(result.plan);
      setPendingPlan({ plan: result.plan, confirmToken: result.confirmToken, targetAgents, skillIds });
      setDialog("confirmPlan");
      setMessage(`${t.planSummary}: ${result.plan.items.length}`);
    } catch (error) {
      setMessage(humanizeError(error, lang));
    } finally {
      setBusy(false);
    }
  };
  const confirmApplyPending = async () => {
    if (!pendingPlan) return;
    setBusy(true);
    try {
      const run = await api.distributionApply(pendingPlan.targetAgents, pendingPlan.skillIds, pendingPlan.confirmToken);
      setMessage(`${t.copied} ${run.copied}, ${t.skipped} ${run.skipped}`);
      setPendingPlan(null);
      setDialog(null);
      await loadShell();
    } catch (error) {
      setMessage(humanizeError(error, lang));
    } finally {
      setBusy(false);
    }
  };
  const refreshGit = async () => { setBusy(true); try { const result = await api.repoStatus(); setGitStatusText(result.status || "clean"); } catch (error) { setMessage(humanizeError(error, lang)); } finally { setBusy(false); } };
  const pullRegistry = async () => { setBusy(true); try { const result = await api.repoPull(); setMessage(result.output || "pull ok"); await refreshGit(); } catch (error) { setMessage(humanizeError(error, lang)); } finally { setBusy(false); } };
  const pushRegistry = async () => { setBusy(true); try { const result = await api.repoPush(commitMessage || t.commitMessageDefault); setMessage(`${result.commit}\n${result.output}`); await refreshGit(); } catch (error) { setMessage(humanizeError(error, lang)); } finally { setBusy(false); } };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="product-title"><div className="brand-cube large">◆</div><div><h1>{t.appTitle}</h1><p title={`${profileLabel(profile, lang)} · ${t.registry}: ${registryRepo || "-"}`}>{profileLabel(profile, lang)} · {t.registry}: {registryRepo || "-"}</p></div></div>
        <div className="top-actions"><div className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.search} />{query && (<button className="search-clear" onClick={() => setQuery("")} aria-label={t.clearSearch} type="button"><X size={14} /></button>)}</div><button className="ghost" onClick={() => setDialog("scan")}>{busy ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />} {busy ? t.scanning : t.scan}</button><button className="ghost" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>{t.language}</button></div>
      </header>
      <div className="workspace">
        <Sidebar view={view} setView={setView} lang={lang} />
        <div className="content">
          {view === "overview" && <Overview skills={visibleSkills} focusedSkillId={focusedSkillId} focusSkill={focusSkill} lang={lang} totalSkillCount={skills.length} allSkills={skills} query={query} agents={populatedAgents} overviewAgentFilter={overviewAgentFilter} setOverviewAgentFilter={setOverviewAgentFilter} onOpenAddSource={() => setDialog("addSource")} onSkillChanged={loadShell} />}
          {view === "repo" && (
            <RepoBrowser
              skills={visibleSkills}
              allSkills={skills}
              totalSkillCount={skills.length}
              agents={populatedAgents}
              focusedSkillId={focusedSkillId}
              onFocus={focusSkill}
              lang={lang}
              registryRepo={registryRepo}
              busy={busy}
              message={message}
              query={query}
              gitStatus={gitStatusText}
              commitMessage={commitMessage}
              setCommitMessage={setCommitMessage}
              onImport={importRepo}
              onReview={(ids) => void openReviewDialog("rules", ids)}
              onRefreshGit={refreshGit}
              onPull={pullRegistry}
              onPush={pushRegistry}
              onRegistryLoaded={(result) => { setRegistryRepo(result.repoPath); if (result.skills) setSkills(result.skills); setMessage(`${messages[lang].loadRegistrySuccess}: ${result.repoPath} (${result.skillCount ?? result.skills?.length ?? 0})`); }}
              onRemoteConnected={(status, url) => { setGitStatusText(status); setMessage(messages[lang].connectRemoteSuccess.replace("{url}", url)); }}
              onSkillChanged={loadShell}
            />
          )}
          {view === "intersect" && <Intersect skills={visibleSkills} allSkills={skills} targets={targets} lang={lang} plan={plan} onPlan={planDistribution} onApply={applyDistribution} agents={populatedAgents} focusedSkillId={focusedSkillId} onFocus={focusSkill} onSkillChanged={loadShell} />}
          {view === "distribute" && <Distribute skills={visibleSkills} allSkills={skills} totalSkillCount={skills.length} targets={targets} onPlan={planDistribution} onApply={applyDistribution} plan={plan} busy={busy} lang={lang} focusedSkillId={focusedSkillId} onFocus={focusSkill} query={query} onSkillChanged={loadShell} />}
          <footer className="status-footer"><span>{populatedAgents.length} agents</span><span>{focusedSkillId ? 1 : 0} {t.focusedCount}</span><span className="status-message" title={message}>{message}</span></footer>
        </div>
      </div>
      {dialog === "scan" && <DialogFrame title={t.scanDialogTitle} onClose={() => setDialog(null)} closeLabel={t.cancel}><p>{t.scanDialogBody}</p><label className="checkbox-line"><input type="checkbox" checked={includeBuiltin} onChange={(event) => setIncludeBuiltin(event.target.checked)} /> {t.includeBuiltin}</label><div className="dialog-actions"><button className="ghost" onClick={() => setDialog(null)}>{t.cancel}</button><button className="primary" onClick={runScan} disabled={busy}>{t.confirmScan}</button></div></DialogFrame>}
      {dialog === "review" && <DialogFrame title={t.reviewDialogTitle} onClose={() => setDialog(null)} closeLabel={t.cancel}><p>{t.reviewDialogBody}</p><div className="review-meta"><span>{t.reviewScope}: {reviewScopeIds.length > 0 ? t.reviewScopeSelected.replace("{n}", String(reviewScopeIds.length)) : t.reviewScopeAllRegistry.replace("{n}", String(skills.length))}</span><span>{t.reviewOutputLanguage}: {lang === "zh" ? "中文" : "English"}</span><span>{t.reviewWriteTarget}: registry/reviews/*.json</span></div><div className="reviewer-list">{reviewers.map((item) => <label key={item.kind} className={`reviewer-option ${reviewer === item.kind ? "active" : ""} ${!item.available ? "disabled" : ""}`}><input type="radio" name="reviewer" value={item.kind} checked={reviewer === item.kind} disabled={!item.available} onChange={() => setReviewer(item.kind)} /><strong>{item.kind === "rules" ? t.reviewerRules : item.label}</strong><span>{item.available ? t.reviewerAvailable : t.reviewerUnavailable}</span><small>{localizedReviewerReason(item, lang)}</small></label>)}</div><p className="muted-copy">{t.agentUnavailable}</p><div className="dialog-actions"><button className="ghost" onClick={() => setDialog(null)}>{t.cancel}</button><button className="primary" onClick={runReview} disabled={busy || !reviewers.find((item) => item.kind === reviewer)?.available}>{t.startReview}</button></div></DialogFrame>}
      {dialog === "confirmPlan" && pendingPlan && (
        <ConfirmPlanModal
          plan={pendingPlan.plan}
          confirmToken={pendingPlan.confirmToken}
          lang={lang}
          busy={busy}
          onConfirm={() => void confirmApplyPending()}
          onCancel={() => { setDialog(null); setPendingPlan(null); }}
        />
      )}
      {dialog === "addSource" && (
        <AddSourceDialog
          lang={lang}
          agents={agents}
          onAdded={async (result) => {
            // Re-issue scan + reload the agents/skills shell so the new source
            // immediately appears in the source-bars chart and the skill table.
            // Server has already reloaded its own config snapshot in /api/sources.
            try {
              const scan = await api.scan(includeBuiltin);
              await loadShellMeta();
              setSkills(scan.skills);
              setMessage(`${t.addSourceSuccess} (${result.agentKind} / ${scopeLabel(result.scope, lang)})`);
            } catch (error) {
              setMessage(humanizeError(error, lang));
            }
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </main>
  );
}

function Intersect({ skills, allSkills, targets, lang, plan, onPlan, onApply, agents: agentDefs, focusedSkillId, onFocus, onSkillChanged }: { readonly skills: SkillPackage[]; readonly allSkills: SkillPackage[]; readonly targets: DistributionTarget[]; readonly lang: Language; readonly plan?: DistributionPlan; readonly onPlan: (agents: string[], skillIds?: string[]) => void; readonly onApply: (agents: string[], skillIds?: string[]) => void; readonly agents: AgentDefinition[]; readonly focusedSkillId: string | null; readonly onFocus: (id: string) => void; readonly onSkillChanged: () => Promise<void> | void }) {
  const t = messages[lang];
  // R35-C14 follow-up: defaults derive from the populated-agent list passed in
  // (agentDefs is App's populatedAgents filter), not hardcoded "mavis" /
  // "claude". A user whose registry has neither agent populated would
  // otherwise land on a select with no matching option — the browser would
  // render the first option visually while `from` state still said "mavis",
  // and the source-skills lane would silently look empty until the user
  // touched the dropdown. The snap-back useEffect below handles agent-list
  // changes after mount (e.g. switching to a registry where the previously
  // selected from/to disappear).
  const [from, setFrom] = useState<string>(() => agentDefs[0]?.kind ?? "mavis");
  const [to, setTo] = useState<string>(() => agentDefs.find((agent) => agent.kind !== (agentDefs[0]?.kind ?? "mavis"))?.kind ?? "claude");
  useEffect(() => {
    if (agentDefs.length === 0) return;
    const kinds: string[] = agentDefs.map((agent) => agent.kind);
    let nextFrom = from;
    let nextTo = to;
    if (!kinds.includes(nextFrom)) nextFrom = kinds[0]!;
    if (!kinds.includes(nextTo) || nextTo === nextFrom) {
      nextTo = kinds.find((kind) => kind !== nextFrom) ?? nextFrom;
    }
    if (nextFrom !== from) setFrom(nextFrom);
    if (nextTo !== to) setTo(nextTo);
  }, [agentDefs]);
  // Per-page selection for "which source skills do I want to copy to the
  // target agent". This used to live in App's global `selected`, sharing
  // state with Overview's focus and Distribute's selection. R34 commit 1
  // localises it so other pages can't pollute the copy plan.
  const [selectedForCopy, setSelectedForCopy] = useState<Set<string>>(new Set());
  // R34 commit 4: focus is now a single App-level state shared across all
  // four pages. The previous local `focusedId` in Intersect lost the user's
  // inspection target on every tab switch; promoting it to App means clicking
  // a row on Overview, jumping to Intersect, then back to Overview keeps the
  // same skill open in the DetailPanel.
  const toggleSelectForCopy = (id: string) => {
    setSelectedForCopy((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const agents = agentDefs.map((agent) => agent.kind);
  const handleFromChange = (newFrom: string) => {
    setFrom(newFrom);
    if (newFrom === to) {
      const next = agents.find((agent) => agent !== newFrom);
      if (next) setTo(next);
    }
  };
  const sameSourceTarget = from === to;
  const left = skills.filter((skill) => skill.source.agent === from).slice(0, 40);
  // selectedSkills filters local selectedForCopy by the current `from` agent.
  // Switching `from` therefore yields a fresh-feeling lane even if the user
  // checked rows under a different `from` earlier in the same Intersect visit.
  const selectedSkills = skills.filter((skill) => selectedForCopy.has(skill.id) && skill.source.agent === from);
  const selectedIds = selectedSkills.map((skill) => skill.id);
  const sourcePath = left[0]?.source.rootPath ?? "-";
  const targetPath = targets.find((target) => target.agent === to)?.targetDir ?? "-";
  // The right sticky panel mirrors `focusedSkillId` from App. We resolve
  // against `allSkills` so a focus coming from another page (e.g. Overview
  // showed a Claude skill, user jumped to Intersect with from=Mavis) still
  // surfaces the skill the user explicitly opened — even if it's not in the
  // current left lane. We flag that "out of lane" case below so the user
  // sees why the focused row isn't highlighted in the table.
  const focusedSkill = focusedSkillId ? allSkills.find((skill) => skill.id === focusedSkillId) : undefined;
  const focusedHidden = focusedSkill ? !left.some((skill) => skill.id === focusedSkill.id) : false;
  return (
    <section className="intersect-layout">
      <div className="section-head">
        <div><h2>{t.navIntersect}</h2><p>{t.intersectDesc}</p></div>
        <div className="agent-selects">
          <AgentSelect
            value={from}
            onChange={handleFromChange}
            ariaLabel={t.intersectDesc}
            options={agentDefs.map((agent) => ({ value: agent.kind, label: agentTone[agent.kind]?.label ?? agent.label }))}
          />
          <ArrowRight size={18} />
          <AgentSelect
            value={to}
            onChange={setTo}
            ariaLabel={t.intersectDesc}
            options={agentDefs.map((agent) => ({ value: agent.kind, label: agentTone[agent.kind]?.label ?? agent.label, disabled: agent.kind === from }))}
          />
        </div>
      </div>
      {/* R36-C17 layout: the previous side-by-side "skill list left + detail
          panel right" caused horizontal drift — skill descriptions vary
          wildly in length, so clicking different rows resized the right
          column and shoved the left column around. Moved the detail panel
          to a full-width row at the bottom (variable height now affects only
          what's below it, not the list above), and moved the copy-operation
          action bar to the LEFT of the skill list (where it stays anchored
          regardless of detail content). User feedback:
          "把skill的展示放在下面，交汇复制的操作放到skill列表的左边". */}
      <div className="intersect-body">
        <div className="work-card intersect-action-bar">
          {sameSourceTarget && <p className="warning-line" role="alert">{t.sameSourceTargetWarning}</p>}
          <div className="action-bar-counter">
            <strong>{selectedSkills.length}</strong>
            <span>{t.selectedCount} / {left.length}</span>
          </div>
          <p className="target-path-line">{t.targetPath}:</p>
          <code className="target-path-code" title={targetPath}>{targetPath}</code>
          <button className="primary action-bar-button" disabled={selectedSkills.length === 0 || sameSourceTarget} onClick={() => onPlan([to], selectedIds)}><UploadCloud size={16} /> {t.previewIntersection}</button>
          {plan && selectedSkills.length > 0 && !sameSourceTarget && <button className="primary action-bar-button" onClick={() => onApply([to], selectedIds)}><Check size={16} /> {t.applyIntersection}</button>}
          {selectedSkills.length === 0 && <p className="muted-copy">{t.noSourceSelection}</p>}
          {plan && (
            <div className="action-bar-plan">
              <h3>{t.planSummary}</h3>
              <PlanItems plan={plan} lang={lang} />
            </div>
          )}
        </div>
        <div className="work-card intersect-table-card">
          <div className="card-head">
            <div>
              <h3><AgentLogo agent={from} /> {t.sourceSkills}<span className="title-count">{left.length}</span></h3>
              <p className="path-line">{t.sourcePath}: <code title={sourcePath}>{sourcePath}</code></p>
            </div>
          </div>
          {/* SkillTable handles row markup, focused highlight, checkbox click,
              and the no-rows fallback. Passing selectedIds + onToggleSelect
              flips it into multi-select mode for the copy queue. focusedId
              comes from App so a focus set on Overview survives the jump. */}
          <SkillTable
            skills={left}
            lang={lang}
            focusedId={focusedSkillId}
            onFocus={onFocus}
            selectedIds={selectedForCopy}
            onToggleSelect={toggleSelectForCopy}
          />
        </div>
      </div>
      <div className="intersect-detail-panel">
        <DetailPanel skill={focusedSkill} lang={lang} onSkillChanged={onSkillChanged} />
        {focusedSkill && focusedHidden && (
          <p className="muted-copy">{t.focusedHidden}</p>
        )}
      </div>
    </section>
  );
}

function Distribute({ skills, allSkills, totalSkillCount, targets, onPlan, onApply, plan, busy, lang, focusedSkillId, onFocus, query, onSkillChanged }: {
  readonly skills: SkillPackage[];
  readonly allSkills: SkillPackage[];
  readonly totalSkillCount: number;
  readonly targets: DistributionTarget[];
  readonly onPlan: (agents: string[], skillIds?: string[]) => void;
  readonly onApply: (agents: string[], skillIds?: string[]) => void;
  readonly plan?: DistributionPlan;
  readonly busy: boolean;
  readonly lang: Language;
  readonly focusedSkillId: string | null;
  readonly onFocus: (id: string) => void;
  readonly query: string;
  readonly onSkillChanged: () => Promise<void> | void;
}) {
  const t = messages[lang];
  // chosen = which target agents to distribute to. Defaults to codex+claude
  // because the most common operation users land on this page for is "spread
  // a curated Registry to my two coding assistants"; the user can still
  // uncheck either.
  const [chosen, setChosen] = useState<Set<string>>(new Set(["codex", "claude"]));
  // selectedForDistribute is the per-skill action queue (which Registry skills
  // do I want to push to the chosen target agents?). Local to this page so a
  // tab switch fully resets it — focus survives via App.focusedSkillId, but
  // operational selection should never silently persist into a later visit.
  const [selectedForDistribute, setSelectedForDistribute] = useState<Set<string>>(new Set());
  const toggleTarget = (agent: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent); else next.add(agent);
      return next;
    });
  };
  const toggleSelectForDistribute = (id: string) => {
    setSelectedForDistribute((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  // The DetailPanel mirrors App.focusedSkillId so a focus set on Overview /
  // Intersect remains active here. Resolve against allSkills (not the query-
  // filtered `skills`) so a focused skill the user just searched away from is
  // still inspectable on the right.
  const focusedSkill = focusedSkillId ? allSkills.find((skill) => skill.id === focusedSkillId) : undefined;
  const focusedHidden = focusedSkill ? !skills.some((skill) => skill.id === focusedSkill.id) : false;
  const selectedIds = useMemo(() => [...selectedForDistribute], [selectedForDistribute]);
  const targetAgents = useMemo(() => [...chosen], [chosen]);
  // Empty registry beats any other state — until the user imports there's
  // nothing to distribute regardless of how many target agents they pick.
  if (totalSkillCount === 0) {
    return (
      <section className="distribute-layout">
        <div className="section-head">
          <div><h2>{t.navDistribute}</h2><p>{t.distributeDesc}</p></div>
        </div>
        <section className="work-card empty-state">
          <Info size={24} />
          <h2>{t.registryEmptyTitle}</h2>
          <p>{t.registryEmptyBody}</p>
        </section>
      </section>
    );
  }
  const canPreview = !busy && chosen.size > 0 && selectedForDistribute.size > 0;
  const canApply = !busy && !!plan && chosen.size > 0 && selectedForDistribute.size > 0;
  const tableCount = skills.length === totalSkillCount ? `${totalSkillCount}` : `${skills.length} / ${totalSkillCount}`;
  return (
    <section className="distribute-layout">
      <div className="section-head">
        <div><h2>{t.navDistribute}</h2><p>{t.distributeDesc}</p></div>
      </div>
      {/* Multi-target picker pinned to the top: it's a precondition for the
          action bar at the bottom, so we surface it before the skill list. */}
      <div className="work-card target-card">
        <h3>{t.targets}</h3>
        <div className="target-grid">
          {targets.map((target) => (
            <button
              key={target.agent}
              className={chosen.has(target.agent) ? "target selected" : "target"}
              onClick={() => toggleTarget(target.agent)}
              type="button"
            >
              <AgentLogo agent={target.agent} />
              <span>{target.label}<small title={target.targetDir}>{target.targetDir}</small></span>
              {chosen.has(target.agent) && <Check size={16} />}
            </button>
          ))}
        </div>
      </div>
      <div className="distribute-body">
        <div className="work-card distribute-table-card">
          <div className="card-head">
            <div>
              <h3>{t.distributeSkillsTitle}<span className="title-count">{tableCount}</span></h3>
              <p>{t.distributeSelectionHint}</p>
            </div>
          </div>
          {/* SkillTable in multi-select mode. focusedId is shared via App so
              the right DetailPanel reflects the same skill across all four
              pages. selectedForDistribute is local — the action bar reads
              its count to size the distribution plan. */}
          <SkillTable
            skills={skills}
            lang={lang}
            focusedId={focusedSkillId}
            onFocus={onFocus}
            selectedIds={selectedForDistribute}
            onToggleSelect={toggleSelectForDistribute}
            emptyText={query.trim() ? t.noMatchTitle : t.registryEmptyTitle}
          />
        </div>
        <div className="distribute-detail-panel">
          <DetailPanel skill={focusedSkill} lang={lang} onSkillChanged={onSkillChanged} />
          {focusedSkill && focusedHidden && (
            <p className="muted-copy">{t.focusedHidden}</p>
          )}
        </div>
      </div>
      <div className="work-card distribute-action-bar">
        <div className="action-bar-row">
          <span className="action-bar-counter">
            <strong>{selectedForDistribute.size}</strong> {t.selectedCount} / {totalSkillCount}
          </span>
          <span className="action-bar-spacer" />
          <button className="primary" disabled={!canPreview} onClick={() => onPlan(targetAgents, selectedIds)}><UploadCloud size={16} /> {t.generatePlan}</button>
          <button className="primary" disabled={!canApply} onClick={() => onApply(targetAgents, selectedIds)}><Check size={16} /> {t.applyDistribution}</button>
        </div>
        {chosen.size === 0 && <p className="muted-copy">{t.noTargetSelection}</p>}
        {chosen.size > 0 && selectedForDistribute.size === 0 && <p className="muted-copy">{t.noDistributeSelection}</p>}
        {plan && (
          <div className="action-bar-plan">
            <h3>{t.planSummary}<span className="title-count">{plan.items.filter((item) => item.action !== "skip").length} {t.toCopyOrOverwrite}</span></h3>
            <PlanItems plan={plan} lang={lang} />
          </div>
        )}
      </div>
    </section>
  );
}
