import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Database,
  GitBranch,
  GitCompareArrows,
  HardDriveDownload,
  Info,
  Loader2,
  PackageCheck,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  UploadCloud,
  X
} from "lucide-react";
import type { AgentDefinition, DistributionPlan, DistributionTarget, SkillPackage, SkillStatus } from "@linka-skillhub/core";
import { api, type ReviewerInfo, type Summary } from "./api.js";
import { messages, type Language } from "./i18n.js";
import { ConfirmPlanModal } from "./components/ConfirmPlanModal.js";
import { LoadRegistryPanel } from "./components/LoadRegistryPanel.js";

type View = "overview" | "intersect" | "distribute" | "detail" | "repo";
type Dialog = "scan" | "review" | "confirmPlan" | null;

const emptySummary: Summary = { total: 0, valid: 0, portable: 0, agentBound: 0, unsafe: 0, invalid: 0 };

const agentTone: Record<string, { label: string; mark: string; className: string }> = {
  mavis: { label: "Mavis", mark: "M", className: "agent-mavis" },
  opencode: { label: "OpenCode", mark: "O", className: "agent-opencode" },
  claude: { label: "Claude Code", mark: "C", className: "agent-claude" },
  codex: { label: "Codex", mark: "X", className: "agent-codex" },
  shared: { label: ".agents/skills", mark: "S", className: "agent-shared" }
};

const statusLabel = (lang: Language): Record<SkillStatus, string> => ({
  valid: messages[lang].shareable,
  portable: messages[lang].shareable,
  invalid: messages[lang].problematic,
  agent_bound: messages[lang].agentBound,
  unsafe: messages[lang].problematic,
  unreviewed: lang === "zh" ? "未审查" : "Unreviewed"
});

const statusClass = (skill: SkillPackage): string => {
  if (skill.status.includes("unsafe") || skill.status.includes("invalid")) return "status-danger";
  if (skill.status.includes("agent_bound")) return "status-warning";
  if (skill.status.includes("portable") && skill.status.includes("valid")) return "status-ok";
  return "status-muted";
};

const bucket = (skill: SkillPackage): "problem" | "agentBound" | "shareable" | "other" => {
  if (skill.status.includes("unsafe") || skill.status.includes("invalid")) return "problem";
  if (skill.status.includes("agent_bound")) return "agentBound";
  if (skill.status.includes("valid") && skill.status.includes("portable")) return "shareable";
  return "other";
};

const bucketLabel = (skill: SkillPackage, lang: Language): string => {
  const t = messages[lang];
  switch (bucket(skill)) {
    case "shareable": return t.shareable;
    case "agentBound": return t.agentBound;
    case "problem": return t.problematic;
    default: return t.unreviewedBucket;
  }
};

const summarizeSkills = (skills: readonly SkillPackage[]): Summary => ({
  total: skills.length,
  valid: skills.filter((skill) => skill.status.includes("valid")).length,
  portable: skills.filter((skill) => bucket(skill) === "shareable").length,
  agentBound: skills.filter((skill) => bucket(skill) === "agentBound").length,
  unsafe: skills.filter((skill) => skill.status.includes("unsafe")).length,
  invalid: skills.filter((skill) => bucket(skill) === "problem").length
});

function AgentLogo({ agent }: { readonly agent: string }) {
  const tone = agentTone[agent] ?? { label: agent, mark: agent.slice(0, 1).toUpperCase(), className: "agent-generic" };
  return <span className={`agent-logo ${tone.className}`} title={tone.label}>{tone.mark}</span>;
}

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

function SkillRow({ skill, selected, onToggle, lang }: { readonly skill: SkillPackage; readonly selected: boolean; readonly onToggle: (id: string) => void; readonly lang: Language }) {
  const labels = statusLabel(lang);
  const displayStatus = skill.status.includes("unsafe") || skill.status.includes("invalid")
    ? labels.invalid
    : skill.status.includes("agent_bound")
      ? labels.agent_bound
      : skill.status.includes("portable") && skill.status.includes("valid")
        ? labels.portable
        : labels.unreviewed;
  return (
    <button className={`skill-row ${selected ? "selected" : ""}`} onClick={() => onToggle(skill.id)} title={messages[lang].selectionHint}>
      <AgentLogo agent={skill.source.agent} />
      <span className="skill-main">
        <strong>{skill.name}</strong>
        <small>{skill.description || messages[lang].noDescription}</small>
      </span>
      <span className={`status-pill ${statusClass(skill)}`}>{displayStatus}</span>
    </button>
  );
}

function actionLabel(action: string, lang: Language): string {
  const t = messages[lang];
  if (action === "copy") return t.copyAction;
  if (action === "overwrite") return t.overwriteAction;
  if (action === "skip") return t.skipAction;
  return action;
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
            <dt>{t.reason}</dt><dd>{item.reason}</dd>
            {item.existingPath && <><dt>{t.existingPath}</dt><dd><code>{item.existingPath}</code></dd></>}
            {item.backupPath && <><dt>{t.backupPath}</dt><dd><code>{item.backupPath}</code></dd></>}
          </dl>
        </div>
      ))}
    </div>
  );
}

function Sidebar({ view, setView, agents, selectedAgent, setSelectedAgent, lang }: {
  readonly view: View;
  readonly setView: (view: View) => void;
  readonly agents: AgentDefinition[];
  readonly selectedAgent: string | null;
  readonly setSelectedAgent: (agent: string | null) => void;
  readonly lang: Language;
}) {
  const t = messages[lang];
  const items: readonly [View, React.ReactNode, string][] = [
    ["overview", <Database size={16} />, t.navOverview],
    ["intersect", <GitCompareArrows size={16} />, t.navIntersect],
    ["distribute", <HardDriveDownload size={16} />, t.navDistribute],
    ["detail", <PackageCheck size={16} />, t.navDetail],
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
      <div className="sidebar-group-label">{t.filterGroupLabel}</div>
      <div className="agent-legend selectable">
        <button className={selectedAgent === null ? "agent-filter active" : "agent-filter"} onClick={() => setSelectedAgent(null)}><span className="agent-logo agent-all" aria-hidden="true" />{t.allSources}</button>
        {agents.map((agent) => (
          <button key={agent.kind} className={selectedAgent === agent.kind ? "agent-filter active" : "agent-filter"} onClick={() => setSelectedAgent(selectedAgent === agent.kind ? null : agent.kind)}>
            <AgentLogo agent={agent.kind} /> {agentTone[agent.kind]?.label ?? agent.label}
          </button>
        ))}
      </div>
    </aside>
  );
}

function Overview({ skills, summary, selected, toggleSkill, lang, selectedAgent, totalSkillCount }: {
  readonly skills: SkillPackage[];
  readonly summary: Summary;
  readonly selected: Set<string>;
  readonly toggleSkill: (id: string) => void;
  readonly lang: Language;
  readonly selectedAgent: string | null;
  readonly totalSkillCount: number;
}) {
  const t = messages[lang];
  const byAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of skills) counts.set(skill.source.agent, (counts.get(skill.source.agent) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [skills]);
  const donutStyle = { "--ok": summary.portable, "--warn": summary.agentBound, "--bad": summary.invalid, "--all": Math.max(summary.total, 1) } as React.CSSProperties;

  if (totalSkillCount === 0) {
    return <section className="work-card empty-state span-all"><Info size={24} /><h2>{t.noScanTitle}</h2><p>{t.noScanBody}</p></section>;
  }
  if (summary.total === 0) {
    return <section className="work-card empty-state span-all"><Info size={24} /><h2>{t.noMatchTitle}</h2><p>{t.noMatchBody}</p></section>;
  }

  return (
    <section className="panel-grid overview-grid">
      <div className="section-head span-all"><div><h2>{t.overview}</h2><p>{t.currentScope}: {selectedAgent ? agentTone[selectedAgent]?.label : t.allSources}</p></div></div>
      <StatCard tone="neutral" title={t.totalSkills} value={summary.total} sub={`${summary.valid} ${t.valid}`} icon={<PackageCheck size={18} />} />
      <StatCard tone="success" title={t.shareable} value={summary.portable} sub={t.defaultDistributionScope} icon={<Check size={18} />} />
      <StatCard tone="warning" title={t.agentBound} value={summary.agentBound} sub={t.needsConfirmation} icon={<AlertTriangle size={18} />} />
      <StatCard tone="danger" title={t.problematic} value={summary.invalid} sub={t.blockedByDefault} icon={<ShieldAlert size={18} />} />

      <div className="work-card source-card">
        <h3>{t.sourceDistribution}</h3>
        <div className="source-bars">
          {byAgent.map(([agent, count]) => (
            <div key={agent}><span><AgentLogo agent={agent} /> {agentTone[agent]?.label ?? agent}</span><strong>{count}</strong><div className="bar-track"><i style={{ width: `${summary.total ? (count / summary.total) * 100 : 0}%` }} /></div></div>
          ))}
        </div>
      </div>
      <div className="work-card donut-card">
        <h3>{t.statusDistribution}</h3><div className="donut" style={donutStyle} />
        <div className="status-list"><span><i className="dot ok" />{t.shareable} {summary.portable}</span><span><i className="dot warn" />{t.agentBound} {summary.agentBound}</span><span><i className="dot bad" />{t.problematic} {summary.invalid}</span></div>
      </div>
      <div className="work-card table-card span-all">
        <div className="card-head"><div><h3>{t.scanResults}</h3><p>{t.selectionHint}</p></div><span>{selected.size} {t.selectedCount}</span></div>
        <div className="skill-table scrollable-list">{skills.map((skill) => <SkillRow key={skill.id} skill={skill} selected={selected.has(skill.id)} onToggle={toggleSkill} lang={lang} />)}</div>
      </div>
    </section>
  );
}

function RepoView({ onImport, onReview, onAgentReview, onRefreshGit, onPull, onPush, gitStatus, commitMessage, setCommitMessage, busy, message, lang, registryRepo, onRegistryLoaded }: { readonly onImport: () => void; readonly onReview: () => void; readonly onAgentReview: () => void; readonly onRefreshGit: () => void; readonly onPull: () => void; readonly onPush: () => void; readonly gitStatus: string; readonly commitMessage: string; readonly setCommitMessage: (value: string) => void; readonly busy: boolean; readonly message: string; readonly lang: Language; readonly registryRepo: string; readonly onRegistryLoaded: (result: import("./api.js").RegistryLoadResponse) => void }) {
  const t = messages[lang];
  return (
    <section className="panel-grid repo-grid">
      <div className="section-head span-all"><div><h2>{t.repositoryTitle}</h2><p>{t.repositoryDesc}</p></div></div>
      <button className="action-card" onClick={onImport} disabled={busy}><Database size={22} /><strong>{t.importToRegistry}</strong><span>{t.importToRegistryDesc}</span></button>
      <button className="action-card" onClick={onReview} disabled={busy}><Sparkles size={22} /><strong>{t.runRuleReview}</strong><span>{t.runRuleReviewDesc}</span></button>
      <button className="action-card" onClick={onAgentReview} disabled={busy}><Sparkles size={22} /><strong>{t.runAgentReview}</strong><span>{t.runAgentReviewDesc}</span></button>
      <LoadRegistryPanel lang={lang} currentRepoPath={registryRepo} onLoaded={onRegistryLoaded} />
      <div className="work-card git-card">
        <h3>{t.gitStatus}</h3>
        <p className="muted-copy">{t.remoteSyncDesc}</p>
        <pre>{gitStatus || t.waitingOperation}</pre>
        <label className="field-label">{t.commitMessage}<input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} /></label>
        <div className="button-row"><button className="ghost" onClick={onRefreshGit} disabled={busy}>{t.refreshGitStatus}</button><button className="ghost" onClick={onPull} disabled={busy}>{t.pullRegistry}</button><button className="primary" onClick={onPush} disabled={busy}>{t.pushRegistry}</button></div>
      </div>
      <div className="work-card span-all log-panel"><h3>{t.operationLog}</h3><pre>{message || t.waitingOperation}</pre></div>
    </section>
  );
}

function DialogFrame({ title, children, onClose }: { readonly title: string; readonly children: React.ReactNode; readonly onClose: () => void }) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onClose}><X size={16} /></button>
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
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
  const [pendingPlan, setPendingPlan] = useState<{ plan: DistributionPlan; confirmToken: string; targetAgents: string[]; skillIds: string[] } | null>(null);

  const loadShell = async () => {
    const [agentData, registry] = await Promise.all([api.agents(), api.skills()]);
    setAgents(agentData.agents); setTargets(agentData.targets); setProfile(agentData.profile ?? "unknown"); setRegistryRepo(agentData.registryRepo ?? ""); setSkills(registry.skills);
    if (registry.missingRegistry) setMessage(lang === "zh" ? "Registry 还没有导入记录，请先扫描或导入。" : "Registry is empty. Scan or import first.");
  };

  useEffect(() => { setCommitMessage(messages[lang].commitMessageDefault); }, [lang]);

  useEffect(() => { void loadShell().catch((error) => setMessage(error instanceof Error ? error.message : String(error))); }, []);

  const visibleSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((skill) => (!selectedAgent || skill.source.agent === selectedAgent) && (!q || `${skill.name} ${skill.description} ${skill.source.agent}`.toLowerCase().includes(q)));
  }, [query, selectedAgent, skills]);
  const summary = useMemo(() => summarizeSkills(visibleSkills), [visibleSkills]);
  const selectedSkill = visibleSkills.find((skill) => selected.has(skill.id)) ?? visibleSkills[0];

  const toggleSkill = (id: string) => { const next = new Set(selected); next.has(id) ? next.delete(id) : next.add(id); setSelected(next); };

  const runScan = async () => { setBusy(true); try { const scan = await api.scan(includeBuiltin); setSkills(scan.skills); setMessage(`${t.scan}: ${scan.summary.total}`); setDialog(null); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const importRepo = async () => { setBusy(true); try { const result = await api.import(); setMessage(`${t.imported} ${result.imported} skills → ${result.repoPath}`); await loadShell(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const runReview = async () => { setBusy(true); try { const ids = selected.size ? [...selected] : visibleSkills.map((skill) => skill.id); const result = await api.review(ids, reviewer, lang); setMessage(`${t.reviewed} ${result.reviews.length} skills`); setDialog(null); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const openReviewDialog = async (preferred = "rules") => {
    setReviewer(preferred);
    setDialog("review");
    try {
      const result = await api.reviewers();
      setReviewers(result.reviewers);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const planDistribution = async (targetAgents: string[], skillIds?: string[]) => { setBusy(true); try { const result = await api.distributionPlan(targetAgents, skillIds ?? [...selected]); setPlan(result.plan); setMessage(`${t.planSummary}: ${result.plan.items.length}`); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const applyDistribution = async (targetAgents: string[], skillIds?: string[]) => {
    const ids = skillIds ?? [...selected];
    setBusy(true);
    try {
      const result = await api.distributionPlan(targetAgents, ids);
      setPlan(result.plan);
      setPendingPlan({ plan: result.plan, confirmToken: result.confirmToken, targetAgents, skillIds: ids });
      setDialog("confirmPlan");
      setMessage(`${t.planSummary}: ${result.plan.items.length}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const confirmApplyPending = async () => {
    if (!pendingPlan) return;
    setBusy(true);
    try {
      const run = await api.distributionApply(pendingPlan.targetAgents, pendingPlan.skillIds, pendingPlan.confirmToken, pendingPlan.plan);
      setMessage(`${t.copied} ${run.copied}, ${t.skipped} ${run.skipped}`);
      setPendingPlan(null);
      setDialog(null);
      await loadShell();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const refreshGit = async () => { setBusy(true); try { const result = await api.repoStatus(); setGitStatusText(result.status || "clean"); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const pullRegistry = async () => { setBusy(true); try { const result = await api.repoPull(); setMessage(result.output || "pull ok"); await refreshGit(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const pushRegistry = async () => { setBusy(true); try { const result = await api.repoPush(commitMessage || t.commitMessageDefault); setMessage(`${result.commit}\n${result.output}`); await refreshGit(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="product-title"><div className="brand-cube large">◆</div><div><h1>{t.appTitle}</h1><p title={`${profileLabel(profile, lang)} · ${t.registry}: ${registryRepo || "-"}`}>{profileLabel(profile, lang)} · {t.registry}: {registryRepo || "-"}</p></div></div>
        <div className="top-actions"><div className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.search} /></div><button className="ghost" onClick={() => setDialog("scan")}>{busy ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />} {busy ? t.scanning : t.scan}</button><button className="ghost" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>{t.language}</button></div>
      </header>
      <div className="workspace">
        <Sidebar view={view} setView={setView} agents={agents} selectedAgent={selectedAgent} setSelectedAgent={setSelectedAgent} lang={lang} />
        <div className="content">
          {view === "overview" && <Overview skills={visibleSkills} summary={summary} selected={selected} toggleSkill={toggleSkill} lang={lang} selectedAgent={selectedAgent} totalSkillCount={skills.length} />}
          {view === "repo" && <RepoView onImport={importRepo} onReview={() => void openReviewDialog("rules")} onAgentReview={() => void openReviewDialog("codex")} onRefreshGit={refreshGit} onPull={pullRegistry} onPush={pushRegistry} gitStatus={gitStatusText} commitMessage={commitMessage} setCommitMessage={setCommitMessage} busy={busy} message={message} lang={lang} registryRepo={registryRepo} onRegistryLoaded={(result) => { setRegistryRepo(result.repoPath); if (result.skills) setSkills(result.skills); setMessage(`${messages[lang].loadRegistrySuccess}: ${result.repoPath} (${result.skillCount ?? result.skills?.length ?? 0})`); }} />}
          {view !== "overview" && view !== "repo" && <Placeholder view={view} lang={lang} skills={visibleSkills} targets={targets} selected={selected} toggleSkill={toggleSkill} plan={plan} onPlan={planDistribution} onApply={applyDistribution} selectedSkill={selectedSkill} />}
          <footer className="status-footer"><span>{agents.length} agents</span><span>{selected.size} {t.selectedCount}</span><span>{message}</span></footer>
        </div>
      </div>
      {dialog === "scan" && <DialogFrame title={t.scanDialogTitle} onClose={() => setDialog(null)}><p>{t.scanDialogBody}</p><label className="checkbox-line"><input type="checkbox" checked={includeBuiltin} onChange={(event) => setIncludeBuiltin(event.target.checked)} /> {t.includeBuiltin}</label><div className="dialog-actions"><button className="ghost" onClick={() => setDialog(null)}>{t.cancel}</button><button className="primary" onClick={runScan} disabled={busy}>{t.confirmScan}</button></div></DialogFrame>}
      {dialog === "review" && <DialogFrame title={t.reviewDialogTitle} onClose={() => setDialog(null)}><p>{t.reviewDialogBody}</p><div className="review-meta"><span>{t.reviewScope}: {selected.size ? `${selected.size} ${t.selectedCount}` : `${visibleSkills.length} visible`}</span><span>{t.reviewOutputLanguage}: {lang === "zh" ? "中文" : "English"}</span><span>{t.reviewWriteTarget}: registry/reviews/*.json</span></div><div className="reviewer-list">{reviewers.map((item) => <label key={item.kind} className={`reviewer-option ${reviewer === item.kind ? "active" : ""} ${!item.available ? "disabled" : ""}`}><input type="radio" name="reviewer" value={item.kind} checked={reviewer === item.kind} disabled={!item.available} onChange={() => setReviewer(item.kind)} /><strong>{item.kind === "rules" ? t.reviewerRules : item.label}</strong><span>{item.available ? t.reviewerAvailable : t.reviewerUnavailable}</span><small>{item.reason}</small></label>)}</div><p className="muted-copy">{t.agentUnavailable}</p><div className="dialog-actions"><button className="ghost" onClick={() => setDialog(null)}>{t.cancel}</button><button className="primary" onClick={runReview} disabled={busy || !reviewers.find((item) => item.kind === reviewer)?.available}>{t.startReview}</button></div></DialogFrame>}
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
    </main>
  );
}

function Placeholder(props: { readonly view: View; readonly lang: Language; readonly skills: SkillPackage[]; readonly targets: DistributionTarget[]; readonly selected: Set<string>; readonly toggleSkill: (id: string) => void; readonly plan?: DistributionPlan; readonly onPlan: (agents: string[], skillIds?: string[]) => void; readonly onApply: (agents: string[], skillIds?: string[]) => void; readonly selectedSkill?: SkillPackage }) {
  const t = messages[props.lang];
  if (props.view === "distribute") return <Distribute targets={props.targets} selected={props.selected} onPlan={props.onPlan} onApply={props.onApply} plan={props.plan} busy={false} lang={props.lang} />;
  if (props.view === "detail") return <Detail skill={props.selectedSkill} lang={props.lang} />;
  return <Intersect skills={props.skills} targets={props.targets} selected={props.selected} toggleSkill={props.toggleSkill} lang={props.lang} plan={props.plan} onPlan={props.onPlan} onApply={props.onApply} />;
}

function Intersect({ skills, targets, selected, toggleSkill, lang, plan, onPlan, onApply }: { readonly skills: SkillPackage[]; readonly targets: DistributionTarget[]; readonly selected: Set<string>; readonly toggleSkill: (id: string) => void; readonly lang: Language; readonly plan?: DistributionPlan; readonly onPlan: (agents: string[], skillIds?: string[]) => void; readonly onApply: (agents: string[], skillIds?: string[]) => void }) {
  const t = messages[lang];
  const [from, setFrom] = useState("mavis");
  const [to, setTo] = useState("claude");
  const left = skills.filter((skill) => skill.source.agent === from).slice(0, 40);
  const right = skills.filter((skill) => skill.source.agent === to).slice(0, 40);
  const selectedSkills = skills.filter((skill) => selected.has(skill.id) && skill.source.agent === from);
  const selectedIds = selectedSkills.map((skill) => skill.id);
  const sourcePath = left[0]?.source.rootPath ?? "-";
  const targetPath = targets.find((target) => target.agent === to)?.targetDir ?? "-";
  const agents = Object.keys(agentTone);
  return (
    <section className="intersect-layout">
      <div className="section-head span-all">
        <div><h2>{t.navIntersect}</h2><p>{t.intersectDesc}</p></div>
        <div className="agent-selects">
          <select value={from} onChange={(event) => setFrom(event.target.value)}>{agents.map((agent) => <option key={agent} value={agent}>{agentTone[agent]?.label}</option>)}</select>
          <ArrowRight size={18} />
          <select value={to} onChange={(event) => setTo(event.target.value)}>{agents.map((agent) => <option key={agent} value={agent}>{agentTone[agent]?.label}</option>)}</select>
        </div>
      </div>
      <div className="work-card lane-card">
        <h3><AgentLogo agent={from} /> {t.sourceSkills}</h3>
        <div className="path-note"><strong>{t.sourcePath}</strong><code title={sourcePath}>{sourcePath}</code></div>
        <div className="skill-list compact scrollable-list">{left.map((skill) => <SkillRow key={skill.id} skill={skill} selected={selected.has(skill.id)} onToggle={toggleSkill} lang={lang} />)}</div>
      </div>
      <div className="work-card intersection-actions">
        <GitCompareArrows size={26} />
        <strong>{selectedSkills.length} {t.selectedSkills}</strong>
        <div className="selected-chip-list">{selectedSkills.slice(0, 8).map((skill) => <span key={skill.id}>{skill.name}</span>)}</div>
        {selectedSkills.length === 0 && <p className="muted-copy">{t.noSourceSelection}</p>}
        <button className="primary" disabled={selectedSkills.length === 0} onClick={() => onPlan([to], selectedIds)}><UploadCloud size={16} /> {t.previewIntersection}</button>
        {plan && selectedSkills.length > 0 && <button className="primary" onClick={() => onApply([to], selectedIds)}><Check size={16} /> {t.applyIntersection}</button>}
        {plan && <><h3>{t.planSummary}</h3><PlanItems plan={plan} lang={lang} /></>}
      </div>
      <div className="work-card lane-card">
        <h3><AgentLogo agent={to} /> {t.targetExisting}</h3>
        <div className="path-note"><strong>{t.targetPath}</strong><code title={targetPath}>{targetPath}</code></div>
        <div className="skill-list compact scrollable-list">{right.map((skill) => <SkillRow key={skill.id} skill={skill} selected={selected.has(skill.id)} onToggle={toggleSkill} lang={lang} />)}</div>
      </div>
    </section>
  );
}

function Distribute({ targets, selected, onPlan, onApply, plan, busy, lang }: { readonly targets: DistributionTarget[]; readonly selected: Set<string>; readonly onPlan: (agents: string[], skillIds?: string[]) => void; readonly onApply: (agents: string[], skillIds?: string[]) => void; readonly plan?: DistributionPlan; readonly busy: boolean; readonly lang: Language }) {
  const t = messages[lang];
  const [chosen, setChosen] = useState<Set<string>>(new Set(["codex", "claude"]));
  const toggle = (agent: string) => { const next = new Set(chosen); next.has(agent) ? next.delete(agent) : next.add(agent); setChosen(next); };
  return <section className="panel-grid distribute-grid"><div className="section-head span-all"><div><h2>{t.navDistribute}</h2><p>{t.distributeDesc}</p></div><button className="primary" disabled={busy || selected.size === 0 || chosen.size === 0} onClick={() => onPlan([...chosen])}><UploadCloud size={16} /> {t.generatePlan}</button></div><div className="work-card target-card"><h3>{t.targets}</h3><div className="target-grid">{targets.map((target) => <button key={target.agent} className={chosen.has(target.agent) ? "target selected" : "target"} onClick={() => toggle(target.agent)}><AgentLogo agent={target.agent} /><span>{target.label}<small>{target.targetDir}</small></span>{chosen.has(target.agent) && <Check size={16} />}</button>)}</div></div><div className="work-card plan-card"><h3>{t.planSummary}</h3>{plan ? <div className="plan-list"><strong>{plan.items.filter((item) => item.action !== "skip").length} {t.toCopyOrOverwrite}</strong><PlanItems plan={plan} lang={lang} /><button className="primary" disabled={busy || chosen.size === 0 || selected.size === 0} onClick={() => onApply([...chosen])}><Check size={16} /> {t.applyDistribution}</button></div> : <div className="empty-state"><Info size={18} />{t.waitingPlan}<button className="primary" disabled><Check size={16} /> {t.applyDistribution}</button></div>}</div></section>;
}

function Detail({ skill, lang }: { readonly skill?: SkillPackage; readonly lang: Language }) {
  const t = messages[lang];
  if (!skill) return <section className="work-card detail-empty"><PackageCheck size={24} /><h2>{t.detailEmpty}</h2></section>;
  return <section className="detail-layout"><div className="section-head span-all"><div><h2>{skill.name}</h2><p>{skill.description}</p></div><span className={`status-pill ${statusClass(skill)}`}>{bucketLabel(skill, lang)}</span></div><div className="work-card"><h3>{t.metadata}</h3><dl className="meta-list"><dt>{t.source}</dt><dd><AgentLogo agent={skill.source.agent} /> {agentTone[skill.source.agent]?.label}</dd><dt>{t.scope}</dt><dd>{skill.source.scope}</dd><dt>{t.hash}</dt><dd><code>{skill.hash.slice(0, 16)}</code></dd><dt>{t.variant}</dt><dd><code>{skill.variantId}</code></dd></dl></div><div className="work-card"><h3>{t.evidence}</h3><div className="evidence-list">{skill.issues.map((issue) => <span key={issue.code} className="danger-line">{issue.code}: {issue.message}</span>)}{skill.evidence.map((item) => <span key={item}>{item}</span>)}{skill.issues.length === 0 && skill.evidence.length === 0 && <span>{lang === "zh" ? "无阻断证据" : "No blocking evidence"}</span>}</div></div><div className="work-card span-all path-card"><h3>{t.path}</h3><code>{skill.skillDir}</code></div></section>;
}
