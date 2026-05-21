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
  Settings,
  ShieldAlert,
  Sparkles,
  UploadCloud
} from "lucide-react";
import type { AgentDefinition, DistributionPlan, DistributionTarget, SkillPackage, SkillStatus } from "@linka-skillhub/core";
import { api, type Summary } from "./api.js";

type View = "overview" | "intersect" | "distribute" | "detail" | "repo";

const emptySummary: Summary = { total: 0, valid: 0, portable: 0, agentBound: 0, unsafe: 0, invalid: 0 };

const agentTone: Record<string, { label: string; mark: string; className: string }> = {
  mavis: { label: "Mavis", mark: "M", className: "agent-mavis" },
  opencode: { label: "OpenCode", mark: "O", className: "agent-opencode" },
  claude: { label: "Claude Code", mark: "C", className: "agent-claude" },
  codex: { label: "Codex", mark: "X", className: "agent-codex" },
  shared: { label: ".agents/skills", mark: "S", className: "agent-shared" }
};

const statusLabel: Record<SkillStatus, string> = {
  valid: "可共享",
  portable: "可共享",
  invalid: "存在问题",
  agent_bound: "仅限当前 Agent",
  unsafe: "存在风险",
  unreviewed: "未审查"
};

const statusClass = (skill: SkillPackage): string => {
  if (skill.status.includes("unsafe") || skill.status.includes("invalid")) return "status-danger";
  if (skill.status.includes("agent_bound")) return "status-warning";
  if (skill.status.includes("portable") && skill.status.includes("valid")) return "status-ok";
  return "status-muted";
};

const displayStatus = (skill: SkillPackage): string => {
  if (skill.status.includes("unsafe") || skill.status.includes("invalid")) return statusLabel.invalid;
  if (skill.status.includes("agent_bound")) return statusLabel.agent_bound;
  if (skill.status.includes("portable") && skill.status.includes("valid")) return statusLabel.portable;
  return statusLabel.unreviewed;
};

function AgentLogo({ agent }: { readonly agent: string }) {
  const tone = agentTone[agent] ?? { label: agent, mark: agent.slice(0, 1).toUpperCase(), className: "agent-generic" };
  return (
    <span className={`agent-logo ${tone.className}`} title={tone.label}>
      {tone.mark}
    </span>
  );
}

function StatCard({ title, value, sub, icon }: { readonly title: string; readonly value: number; readonly sub: string; readonly icon: React.ReactNode }) {
  return (
    <div className="stat-card">
      <div className="stat-icon">{icon}</div>
      <div>
        <p>{title}</p>
        <strong>{value}</strong>
        <span>{sub}</span>
      </div>
    </div>
  );
}

function SkillRow({ skill, selected, onToggle }: { readonly skill: SkillPackage; readonly selected: boolean; readonly onToggle: (id: string) => void }) {
  return (
    <button className={`skill-row ${selected ? "selected" : ""}`} onClick={() => onToggle(skill.id)}>
      <AgentLogo agent={skill.source.agent} />
      <span className="skill-main">
        <strong>{skill.name}</strong>
        <small>{skill.description || "No description"}</small>
      </span>
      <span className={`status-pill ${statusClass(skill)}`}>{displayStatus(skill)}</span>
    </button>
  );
}

function Sidebar({ view, setView }: { readonly view: View; readonly setView: (view: View) => void }) {
  const items: readonly [View, React.ReactNode, string][] = [
    ["overview", <Database size={16} />, "总览"],
    ["intersect", <GitCompareArrows size={16} />, "交汇中心"],
    ["distribute", <HardDriveDownload size={16} />, "分发管理"],
    ["detail", <PackageCheck size={16} />, "技能详情"],
    ["repo", <GitBranch size={16} />, "仓库管理"]
  ];
  return (
    <aside className="sidebar">
      <div className="brand-lockup">
        <div className="brand-cube">◆</div>
        <div>
          <strong>SkillHub</strong>
          <span>linka-skillhub</span>
        </div>
      </div>
      <nav>
        {items.map(([key, icon, label]) => (
          <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
            {icon}
            {label}
          </button>
        ))}
      </nav>
      <div className="agent-legend">
        {Object.keys(agentTone).map((agent) => (
          <span key={agent}>
            <AgentLogo agent={agent} /> {agentTone[agent]?.label}
          </span>
        ))}
      </div>
    </aside>
  );
}

function Overview({ skills, summary, selected, toggleSkill, refresh, busy }: { readonly skills: SkillPackage[]; readonly summary: Summary; readonly selected: Set<string>; readonly toggleSkill: (id: string) => void; readonly refresh: () => void; readonly busy: boolean }) {
  const byAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of skills) counts.set(skill.source.agent, (counts.get(skill.source.agent) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [skills]);
  const donutStyle = {
    "--ok": summary.portable,
    "--warn": summary.agentBound,
    "--bad": summary.invalid + summary.unsafe,
    "--all": Math.max(summary.total, 1)
  } as React.CSSProperties;

  const recent = skills.slice(0, 8);
  return (
    <section className="panel-grid overview-grid">
      <div className="section-head span-all">
        <div>
          <h2>概览</h2>
          <p>汇总、分发、交汇、版本追溯</p>
        </div>
        <button className="icon-button" onClick={refresh} disabled={busy} title="刷新扫描">
          {busy ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
        </button>
      </div>

      <StatCard title="Skills" value={summary.total} sub={`${summary.valid} 合法`} icon={<PackageCheck size={18} />} />
      <StatCard title="可共享" value={summary.portable} sub="默认交汇范围" icon={<Check size={18} />} />
      <StatCard title="仅限 Agent" value={summary.agentBound} sub="需确认" icon={<AlertTriangle size={18} />} />
      <StatCard title="存在问题" value={summary.invalid + summary.unsafe} sub="默认阻断" icon={<ShieldAlert size={18} />} />

      <div className="work-card source-card">
        <h3>按来源分布</h3>
        <div className="source-bars">
          {byAgent.map(([agent, count]) => (
            <div key={agent}>
              <span>
                <AgentLogo agent={agent} /> {agentTone[agent]?.label ?? agent}
              </span>
              <strong>{count}</strong>
              <div className="bar-track">
                <i style={{ width: `${summary.total ? (count / summary.total) * 100 : 0}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="work-card donut-card">
        <h3>状态分布</h3>
        <div className="donut" style={donutStyle} />
        <div className="status-list">
          <span><i className="dot ok" />可共享 {summary.portable}</span>
          <span><i className="dot warn" />仅限 Agent {summary.agentBound}</span>
          <span><i className="dot bad" />存在问题 {summary.invalid + summary.unsafe}</span>
        </div>
      </div>

      <div className="work-card table-card span-all">
        <div className="card-head">
          <h3>最近扫描</h3>
          <span>{selected.size} selected</span>
        </div>
        <div className="skill-table">
          {recent.map((skill) => <SkillRow key={skill.id} skill={skill} selected={selected.has(skill.id)} onToggle={toggleSkill} />)}
        </div>
      </div>
    </section>
  );
}

function Intersect({ skills, selected, toggleSkill }: { readonly skills: SkillPackage[]; readonly selected: Set<string>; readonly toggleSkill: (id: string) => void }) {
  const [from, setFrom] = useState("mavis");
  const [to, setTo] = useState("claude");
  const left = skills.filter((skill) => skill.source.agent === from).slice(0, 12);
  const right = skills.filter((skill) => skill.source.agent === to).slice(0, 12);
  const selectedSkills = skills.filter((skill) => selected.has(skill.id));
  return (
    <section className="intersect-layout">
      <div className="section-head span-all">
        <div>
          <h2>交汇中心</h2>
          <p>从来源 Agent 到目标 Agent</p>
        </div>
        <div className="agent-selects">
          <select value={from} onChange={(event) => setFrom(event.target.value)}>
            {Object.keys(agentTone).map((agent) => <option key={agent} value={agent}>{agentTone[agent]?.label}</option>)}
          </select>
          <ArrowRight size={18} />
          <select value={to} onChange={(event) => setTo(event.target.value)}>
            {Object.keys(agentTone).map((agent) => <option key={agent} value={agent}>{agentTone[agent]?.label}</option>)}
          </select>
        </div>
      </div>
      <div className="work-card lane-card">
        <h3><AgentLogo agent={from} /> 来源 Skills</h3>
        <div className="skill-list compact">{left.map((skill) => <SkillRow key={skill.id} skill={skill} selected={selected.has(skill.id)} onToggle={toggleSkill} />)}</div>
      </div>
      <div className="drop-zone">
        <GitCompareArrows size={26} />
        <strong>{selectedSkills.length} Skills</strong>
        <div>{selectedSkills.slice(0, 5).map((skill) => <span key={skill.id}>{skill.name}</span>)}</div>
      </div>
      <div className="work-card lane-card">
        <h3><AgentLogo agent={to} /> 目标现有</h3>
        <div className="skill-list compact">{right.map((skill) => <SkillRow key={skill.id} skill={skill} selected={selected.has(skill.id)} onToggle={toggleSkill} />)}</div>
      </div>
    </section>
  );
}

function Distribute({ targets, selected, onPlan, onApply, plan, busy }: { readonly targets: DistributionTarget[]; readonly selected: Set<string>; readonly onPlan: (agents: string[]) => void; readonly onApply: (agents: string[]) => void; readonly plan?: DistributionPlan; readonly busy: boolean }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set(["codex", "claude"]));
  const toggle = (agent: string) => {
    const next = new Set(chosen);
    if (next.has(agent)) next.delete(agent);
    else next.add(agent);
    setChosen(next);
  };
  return (
    <section className="panel-grid distribute-grid">
      <div className="section-head span-all">
        <div>
          <h2>分发管理</h2>
          <p>目标 Agent 与覆盖计划</p>
        </div>
        <button className="primary" disabled={busy || selected.size === 0 || chosen.size === 0} onClick={() => onPlan([...chosen])}>
          {busy ? <Loader2 className="spin" size={16} /> : <UploadCloud size={16} />} 生成计划
        </button>
      </div>
      <div className="work-card target-card">
        <h3>目标 Agent</h3>
        <div className="target-grid">
          {targets.map((target) => (
            <button key={target.agent} className={chosen.has(target.agent) ? "target selected" : "target"} onClick={() => toggle(target.agent)}>
              <AgentLogo agent={target.agent} />
              <span>{target.label}<small>{target.targetDir}</small></span>
              {chosen.has(target.agent) && <Check size={16} />}
            </button>
          ))}
        </div>
      </div>
      <div className="work-card plan-card">
        <h3>计划摘要</h3>
        {plan ? (
          <div className="plan-list">
            <strong>{plan.items.filter((item) => item.action !== "skip").length} 待复制 / 覆盖</strong>
            {plan.items.slice(0, 10).map((item) => (
              <span key={`${item.target.agent}-${item.skill.id}`}>{item.action} · {item.skill.name} → {item.target.label}</span>
            ))}
            <button className="primary" disabled={busy || chosen.size === 0 || selected.size === 0} onClick={() => onApply([...chosen])}>
              <Check size={16} /> 执行分发
            </button>
          </div>
        ) : (
          <div className="empty-state"><Info size={18} />等待生成分发计划</div>
        )}
      </div>
    </section>
  );
}

function Detail({ skill }: { readonly skill?: SkillPackage }) {
  if (!skill) return <section className="work-card detail-empty"><PackageCheck size={24} /><h2>选择一个 Skill</h2></section>;
  return (
    <section className="detail-layout">
      <div className="section-head span-all">
        <div>
          <h2>{skill.name}</h2>
          <p>{skill.description}</p>
        </div>
        <span className={`status-pill ${statusClass(skill)}`}>{displayStatus(skill)}</span>
      </div>
      <div className="work-card">
        <h3>元信息</h3>
        <dl className="meta-list">
          <dt>来源</dt><dd><AgentLogo agent={skill.source.agent} /> {agentTone[skill.source.agent]?.label}</dd>
          <dt>Scope</dt><dd>{skill.source.scope}</dd>
          <dt>Hash</dt><dd>{skill.hash.slice(0, 16)}</dd>
          <dt>Variant</dt><dd>{skill.variantId}</dd>
        </dl>
      </div>
      <div className="work-card">
        <h3>状态证据</h3>
        <div className="evidence-list">
          {skill.issues.map((issue) => <span key={issue.code} className="danger-line">{issue.code}: {issue.message}</span>)}
          {skill.evidence.map((item) => <span key={item}>{item}</span>)}
          {skill.issues.length === 0 && skill.evidence.length === 0 && <span>无阻断证据</span>}
        </div>
      </div>
      <div className="work-card span-all path-card">
        <h3>路径</h3>
        <code>{skill.skillDir}</code>
      </div>
    </section>
  );
}

function RepoView({ onImport, onReview, busy, message }: { readonly onImport: () => void; readonly onReview: () => void; readonly busy: boolean; readonly message: string }) {
  return (
    <section className="panel-grid repo-grid">
      <div className="section-head span-all">
        <div>
          <h2>仓库管理</h2>
          <p>Git 版本化与审查缓存</p>
        </div>
      </div>
      <button className="action-card" onClick={onImport} disabled={busy}>
        <Database size={22} />
        <strong>汇总到仓库</strong>
        <span>复制原始包并更新 registry/skills.json</span>
      </button>
      <button className="action-card" onClick={onReview} disabled={busy}>
        <Sparkles size={22} />
        <strong>规则审查</strong>
        <span>写入 registry/reviews/*.json</span>
      </button>
      <div className="work-card span-all log-panel"><pre>{message || "Ready"}</pre></div>
    </section>
  );
}

export function App() {
  const [view, setView] = useState<View>("overview");
  const [skills, setSkills] = useState<SkillPackage[]>([]);
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [targets, setTargets] = useState<DistributionTarget[]>([]);
  const [profile, setProfile] = useState("unknown");
  const [registryRepo, setRegistryRepo] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<DistributionPlan | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");

  const refresh = async () => {
    setBusy(true);
    try {
      const [agentData, scan] = await Promise.all([api.agents(), api.scan(true)]);
      setAgents(agentData.agents);
      setTargets(agentData.targets);
      setProfile(agentData.profile ?? "unknown");
      setRegistryRepo(agentData.registryRepo ?? "");
      setSkills(scan.skills);
      setSummary(scan.summary);
      setMessage(`Scanned ${scan.summary.total} skills.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const toggleSkill = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((skill) => `${skill.name} ${skill.description} ${skill.source.agent}`.toLowerCase().includes(q));
  }, [query, skills]);

  const selectedSkill = filtered.find((skill) => selected.has(skill.id)) ?? filtered[0];

  const importRepo = async () => {
    setBusy(true);
    try {
      const result = await api.import();
      setMessage(`Imported ${result.imported} skills into ${result.repoPath}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const reviewSelected = async () => {
    setBusy(true);
    try {
      const ids = selected.size ? [...selected] : skills.slice(0, 20).map((skill) => skill.id);
      const result = await api.review(ids, "rules");
      setMessage(`Reviewed ${result.reviews.length} skills.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const planDistribution = async (targetAgents: string[]) => {
    setBusy(true);
    try {
      const result = await api.distributionPlan(targetAgents, [...selected]);
      setPlan(result.plan);
      setMessage(`Plan ${result.plan.id}: ${result.plan.items.length} items.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const applyDistribution = async (targetAgents: string[]) => {
    setBusy(true);
    try {
      const run = await api.distributionApply(targetAgents, [...selected]);
      setMessage(`Applied distribution: copied ${run.copied}, skipped ${run.skipped}.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="product-title">
          <div className="brand-cube large">◆</div>
          <div>
            <h1>Skill 管理工具</h1>
            <p>汇总 · 分发 · 交汇 · 版本追溯</p>
          </div>
        </div>
        <div className="top-actions">
          <div className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 skills..." /></div>
          <button className="ghost" onClick={refresh}>{busy ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />} 同步扫描</button>
        </div>
      </header>

      <div className="workspace">
        <Sidebar view={view} setView={setView} />
        <div className="content">
          <div className="mode-strip">
            <span><Database size={16} /> 统一管理</span>
            <span><GitBranch size={16} /> 版本可追溯</span>
            <span><Sparkles size={16} /> 智能校验</span>
            <span><GitCompareArrows size={16} /> 自由分发</span>
            <span className={profile === "local" ? "profile-danger" : "profile-safe"}>Profile: {profile}</span>
          </div>
          {view === "overview" && <Overview skills={filtered} summary={summary} selected={selected} toggleSkill={toggleSkill} refresh={refresh} busy={busy} />}
          {view === "intersect" && <Intersect skills={filtered} selected={selected} toggleSkill={toggleSkill} />}
          {view === "distribute" && <Distribute targets={targets} selected={selected} onPlan={planDistribution} onApply={applyDistribution} plan={plan} busy={busy} />}
          {view === "detail" && <Detail skill={selectedSkill} />}
          {view === "repo" && <RepoView onImport={importRepo} onReview={reviewSelected} busy={busy} message={message} />}
          <footer className="status-footer">
            <span>{agents.length} supported agents</span>
            <span>{registryRepo}</span>
            <span>{message}</span>
            <button onClick={() => setView("repo")}><Settings size={14} /> 设置</button>
          </footer>
        </div>
      </div>
    </main>
  );
}
