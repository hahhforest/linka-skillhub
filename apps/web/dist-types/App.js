import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Check, Database, GitBranch, GitCompareArrows, HardDriveDownload, Info, Loader2, PackageCheck, RefreshCw, Search, Settings, ShieldAlert, Sparkles, UploadCloud } from "lucide-react";
import { api } from "./api.js";
const emptySummary = { total: 0, valid: 0, portable: 0, agentBound: 0, unsafe: 0, invalid: 0 };
const agentTone = {
    mavis: { label: "Mavis", mark: "M", className: "agent-mavis" },
    opencode: { label: "OpenCode", mark: "O", className: "agent-opencode" },
    claude: { label: "Claude Code", mark: "C", className: "agent-claude" },
    codex: { label: "Codex", mark: "X", className: "agent-codex" },
    shared: { label: ".agents/skills", mark: "S", className: "agent-shared" }
};
const statusLabel = {
    valid: "可共享",
    portable: "可共享",
    invalid: "存在问题",
    agent_bound: "仅限当前 Agent",
    unsafe: "存在风险",
    unreviewed: "未审查"
};
const statusClass = (skill) => {
    if (skill.status.includes("unsafe") || skill.status.includes("invalid"))
        return "status-danger";
    if (skill.status.includes("agent_bound"))
        return "status-warning";
    if (skill.status.includes("portable") && skill.status.includes("valid"))
        return "status-ok";
    return "status-muted";
};
const displayStatus = (skill) => {
    if (skill.status.includes("unsafe") || skill.status.includes("invalid"))
        return statusLabel.invalid;
    if (skill.status.includes("agent_bound"))
        return statusLabel.agent_bound;
    if (skill.status.includes("portable") && skill.status.includes("valid"))
        return statusLabel.portable;
    return statusLabel.unreviewed;
};
function AgentLogo({ agent }) {
    const tone = agentTone[agent] ?? { label: agent, mark: agent.slice(0, 1).toUpperCase(), className: "agent-generic" };
    return (_jsx("span", { className: `agent-logo ${tone.className}`, title: tone.label, children: tone.mark }));
}
function StatCard({ title, value, sub, icon }) {
    return (_jsxs("div", { className: "stat-card", children: [_jsx("div", { className: "stat-icon", children: icon }), _jsxs("div", { children: [_jsx("p", { children: title }), _jsx("strong", { children: value }), _jsx("span", { children: sub })] })] }));
}
function SkillRow({ skill, selected, onToggle }) {
    return (_jsxs("button", { className: `skill-row ${selected ? "selected" : ""}`, onClick: () => onToggle(skill.id), children: [_jsx(AgentLogo, { agent: skill.source.agent }), _jsxs("span", { className: "skill-main", children: [_jsx("strong", { children: skill.name }), _jsx("small", { children: skill.description || "No description" })] }), _jsx("span", { className: `status-pill ${statusClass(skill)}`, children: displayStatus(skill) })] }));
}
function Sidebar({ view, setView }) {
    const items = [
        ["overview", _jsx(Database, { size: 16 }), "总览"],
        ["intersect", _jsx(GitCompareArrows, { size: 16 }), "交汇中心"],
        ["distribute", _jsx(HardDriveDownload, { size: 16 }), "分发管理"],
        ["detail", _jsx(PackageCheck, { size: 16 }), "技能详情"],
        ["repo", _jsx(GitBranch, { size: 16 }), "仓库管理"]
    ];
    return (_jsxs("aside", { className: "sidebar", children: [_jsxs("div", { className: "brand-lockup", children: [_jsx("div", { className: "brand-cube", children: "\u25C6" }), _jsxs("div", { children: [_jsx("strong", { children: "SkillHub" }), _jsx("span", { children: "linka-skillhub" })] })] }), _jsx("nav", { children: items.map(([key, icon, label]) => (_jsxs("button", { className: view === key ? "active" : "", onClick: () => setView(key), children: [icon, label] }, key))) }), _jsx("div", { className: "agent-legend", children: Object.keys(agentTone).map((agent) => (_jsxs("span", { children: [_jsx(AgentLogo, { agent: agent }), " ", agentTone[agent]?.label] }, agent))) })] }));
}
function Overview({ skills, summary, selected, toggleSkill, refresh, busy }) {
    const byAgent = useMemo(() => {
        const counts = new Map();
        for (const skill of skills)
            counts.set(skill.source.agent, (counts.get(skill.source.agent) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    }, [skills]);
    const donutStyle = {
        "--ok": summary.portable,
        "--warn": summary.agentBound,
        "--bad": summary.invalid + summary.unsafe,
        "--all": Math.max(summary.total, 1)
    };
    const recent = skills.slice(0, 8);
    return (_jsxs("section", { className: "panel-grid overview-grid", children: [_jsxs("div", { className: "section-head span-all", children: [_jsxs("div", { children: [_jsx("h2", { children: "\u6982\u89C8" }), _jsx("p", { children: "\u6C47\u603B\u3001\u5206\u53D1\u3001\u4EA4\u6C47\u3001\u7248\u672C\u8FFD\u6EAF" })] }), _jsx("button", { className: "icon-button", onClick: refresh, disabled: busy, title: "\u5237\u65B0\u626B\u63CF", children: busy ? _jsx(Loader2, { className: "spin", size: 16 }) : _jsx(RefreshCw, { size: 16 }) })] }), _jsx(StatCard, { title: "Skills", value: summary.total, sub: `${summary.valid} 合法`, icon: _jsx(PackageCheck, { size: 18 }) }), _jsx(StatCard, { title: "\u53EF\u5171\u4EAB", value: summary.portable, sub: "\u9ED8\u8BA4\u4EA4\u6C47\u8303\u56F4", icon: _jsx(Check, { size: 18 }) }), _jsx(StatCard, { title: "\u4EC5\u9650 Agent", value: summary.agentBound, sub: "\u9700\u786E\u8BA4", icon: _jsx(AlertTriangle, { size: 18 }) }), _jsx(StatCard, { title: "\u5B58\u5728\u95EE\u9898", value: summary.invalid + summary.unsafe, sub: "\u9ED8\u8BA4\u963B\u65AD", icon: _jsx(ShieldAlert, { size: 18 }) }), _jsxs("div", { className: "work-card source-card", children: [_jsx("h3", { children: "\u6309\u6765\u6E90\u5206\u5E03" }), _jsx("div", { className: "source-bars", children: byAgent.map(([agent, count]) => (_jsxs("div", { children: [_jsxs("span", { children: [_jsx(AgentLogo, { agent: agent }), " ", agentTone[agent]?.label ?? agent] }), _jsx("strong", { children: count }), _jsx("div", { className: "bar-track", children: _jsx("i", { style: { width: `${summary.total ? (count / summary.total) * 100 : 0}%` } }) })] }, agent))) })] }), _jsxs("div", { className: "work-card donut-card", children: [_jsx("h3", { children: "\u72B6\u6001\u5206\u5E03" }), _jsx("div", { className: "donut", style: donutStyle }), _jsxs("div", { className: "status-list", children: [_jsxs("span", { children: [_jsx("i", { className: "dot ok" }), "\u53EF\u5171\u4EAB ", summary.portable] }), _jsxs("span", { children: [_jsx("i", { className: "dot warn" }), "\u4EC5\u9650 Agent ", summary.agentBound] }), _jsxs("span", { children: [_jsx("i", { className: "dot bad" }), "\u5B58\u5728\u95EE\u9898 ", summary.invalid + summary.unsafe] })] })] }), _jsxs("div", { className: "work-card table-card span-all", children: [_jsxs("div", { className: "card-head", children: [_jsx("h3", { children: "\u6700\u8FD1\u626B\u63CF" }), _jsxs("span", { children: [selected.size, " selected"] })] }), _jsx("div", { className: "skill-table", children: recent.map((skill) => _jsx(SkillRow, { skill: skill, selected: selected.has(skill.id), onToggle: toggleSkill }, skill.id)) })] })] }));
}
function Intersect({ skills, selected, toggleSkill }) {
    const [from, setFrom] = useState("mavis");
    const [to, setTo] = useState("claude");
    const left = skills.filter((skill) => skill.source.agent === from).slice(0, 12);
    const right = skills.filter((skill) => skill.source.agent === to).slice(0, 12);
    const selectedSkills = skills.filter((skill) => selected.has(skill.id));
    return (_jsxs("section", { className: "intersect-layout", children: [_jsxs("div", { className: "section-head span-all", children: [_jsxs("div", { children: [_jsx("h2", { children: "\u4EA4\u6C47\u4E2D\u5FC3" }), _jsx("p", { children: "\u4ECE\u6765\u6E90 Agent \u5230\u76EE\u6807 Agent" })] }), _jsxs("div", { className: "agent-selects", children: [_jsx("select", { value: from, onChange: (event) => setFrom(event.target.value), children: Object.keys(agentTone).map((agent) => _jsx("option", { value: agent, children: agentTone[agent]?.label }, agent)) }), _jsx(ArrowRight, { size: 18 }), _jsx("select", { value: to, onChange: (event) => setTo(event.target.value), children: Object.keys(agentTone).map((agent) => _jsx("option", { value: agent, children: agentTone[agent]?.label }, agent)) })] })] }), _jsxs("div", { className: "work-card lane-card", children: [_jsxs("h3", { children: [_jsx(AgentLogo, { agent: from }), " \u6765\u6E90 Skills"] }), _jsx("div", { className: "skill-list compact", children: left.map((skill) => _jsx(SkillRow, { skill: skill, selected: selected.has(skill.id), onToggle: toggleSkill }, skill.id)) })] }), _jsxs("div", { className: "drop-zone", children: [_jsx(GitCompareArrows, { size: 26 }), _jsxs("strong", { children: [selectedSkills.length, " Skills"] }), _jsx("div", { children: selectedSkills.slice(0, 5).map((skill) => _jsx("span", { children: skill.name }, skill.id)) })] }), _jsxs("div", { className: "work-card lane-card", children: [_jsxs("h3", { children: [_jsx(AgentLogo, { agent: to }), " \u76EE\u6807\u73B0\u6709"] }), _jsx("div", { className: "skill-list compact", children: right.map((skill) => _jsx(SkillRow, { skill: skill, selected: selected.has(skill.id), onToggle: toggleSkill }, skill.id)) })] })] }));
}
function Distribute({ targets, selected, onPlan, onApply, plan, busy }) {
    const [chosen, setChosen] = useState(new Set(["codex", "claude"]));
    const toggle = (agent) => {
        const next = new Set(chosen);
        if (next.has(agent))
            next.delete(agent);
        else
            next.add(agent);
        setChosen(next);
    };
    return (_jsxs("section", { className: "panel-grid distribute-grid", children: [_jsxs("div", { className: "section-head span-all", children: [_jsxs("div", { children: [_jsx("h2", { children: "\u5206\u53D1\u7BA1\u7406" }), _jsx("p", { children: "\u76EE\u6807 Agent \u4E0E\u8986\u76D6\u8BA1\u5212" })] }), _jsxs("button", { className: "primary", disabled: busy || selected.size === 0 || chosen.size === 0, onClick: () => onPlan([...chosen]), children: [busy ? _jsx(Loader2, { className: "spin", size: 16 }) : _jsx(UploadCloud, { size: 16 }), " \u751F\u6210\u8BA1\u5212"] })] }), _jsxs("div", { className: "work-card target-card", children: [_jsx("h3", { children: "\u76EE\u6807 Agent" }), _jsx("div", { className: "target-grid", children: targets.map((target) => (_jsxs("button", { className: chosen.has(target.agent) ? "target selected" : "target", onClick: () => toggle(target.agent), children: [_jsx(AgentLogo, { agent: target.agent }), _jsxs("span", { children: [target.label, _jsx("small", { children: target.targetDir })] }), chosen.has(target.agent) && _jsx(Check, { size: 16 })] }, target.agent))) })] }), _jsxs("div", { className: "work-card plan-card", children: [_jsx("h3", { children: "\u8BA1\u5212\u6458\u8981" }), plan ? (_jsxs("div", { className: "plan-list", children: [_jsxs("strong", { children: [plan.items.filter((item) => item.action !== "skip").length, " \u5F85\u590D\u5236 / \u8986\u76D6"] }), plan.items.slice(0, 10).map((item) => (_jsxs("span", { children: [item.action, " \u00B7 ", item.skill.name, " \u2192 ", item.target.label] }, `${item.target.agent}-${item.skill.id}`))), _jsxs("button", { className: "primary", disabled: busy || chosen.size === 0 || selected.size === 0, onClick: () => onApply([...chosen]), children: [_jsx(Check, { size: 16 }), " \u6267\u884C\u5206\u53D1"] })] })) : (_jsxs("div", { className: "empty-state", children: [_jsx(Info, { size: 18 }), "\u7B49\u5F85\u751F\u6210\u5206\u53D1\u8BA1\u5212"] }))] })] }));
}
function Detail({ skill }) {
    if (!skill)
        return _jsxs("section", { className: "work-card detail-empty", children: [_jsx(PackageCheck, { size: 24 }), _jsx("h2", { children: "\u9009\u62E9\u4E00\u4E2A Skill" })] });
    return (_jsxs("section", { className: "detail-layout", children: [_jsxs("div", { className: "section-head span-all", children: [_jsxs("div", { children: [_jsx("h2", { children: skill.name }), _jsx("p", { children: skill.description })] }), _jsx("span", { className: `status-pill ${statusClass(skill)}`, children: displayStatus(skill) })] }), _jsxs("div", { className: "work-card", children: [_jsx("h3", { children: "\u5143\u4FE1\u606F" }), _jsxs("dl", { className: "meta-list", children: [_jsx("dt", { children: "\u6765\u6E90" }), _jsxs("dd", { children: [_jsx(AgentLogo, { agent: skill.source.agent }), " ", agentTone[skill.source.agent]?.label] }), _jsx("dt", { children: "Scope" }), _jsx("dd", { children: skill.source.scope }), _jsx("dt", { children: "Hash" }), _jsx("dd", { children: skill.hash.slice(0, 16) }), _jsx("dt", { children: "Variant" }), _jsx("dd", { children: skill.variantId })] })] }), _jsxs("div", { className: "work-card", children: [_jsx("h3", { children: "\u72B6\u6001\u8BC1\u636E" }), _jsxs("div", { className: "evidence-list", children: [skill.issues.map((issue) => _jsxs("span", { className: "danger-line", children: [issue.code, ": ", issue.message] }, issue.code)), skill.evidence.map((item) => _jsx("span", { children: item }, item)), skill.issues.length === 0 && skill.evidence.length === 0 && _jsx("span", { children: "\u65E0\u963B\u65AD\u8BC1\u636E" })] })] }), _jsxs("div", { className: "work-card span-all path-card", children: [_jsx("h3", { children: "\u8DEF\u5F84" }), _jsx("code", { children: skill.skillDir })] })] }));
}
function RepoView({ onImport, onReview, busy, message }) {
    return (_jsxs("section", { className: "panel-grid repo-grid", children: [_jsx("div", { className: "section-head span-all", children: _jsxs("div", { children: [_jsx("h2", { children: "\u4ED3\u5E93\u7BA1\u7406" }), _jsx("p", { children: "Git \u7248\u672C\u5316\u4E0E\u5BA1\u67E5\u7F13\u5B58" })] }) }), _jsxs("button", { className: "action-card", onClick: onImport, disabled: busy, children: [_jsx(Database, { size: 22 }), _jsx("strong", { children: "\u6C47\u603B\u5230\u4ED3\u5E93" }), _jsx("span", { children: "\u590D\u5236\u539F\u59CB\u5305\u5E76\u66F4\u65B0 registry/skills.json" })] }), _jsxs("button", { className: "action-card", onClick: onReview, disabled: busy, children: [_jsx(Sparkles, { size: 22 }), _jsx("strong", { children: "\u89C4\u5219\u5BA1\u67E5" }), _jsx("span", { children: "\u5199\u5165 registry/reviews/*.json" })] }), _jsx("div", { className: "work-card span-all log-panel", children: _jsx("pre", { children: message || "Ready" }) })] }));
}
export function App() {
    const [view, setView] = useState("overview");
    const [skills, setSkills] = useState([]);
    const [summary, setSummary] = useState(emptySummary);
    const [agents, setAgents] = useState([]);
    const [targets, setTargets] = useState([]);
    const [profile, setProfile] = useState("unknown");
    const [registryRepo, setRegistryRepo] = useState("");
    const [selected, setSelected] = useState(new Set());
    const [plan, setPlan] = useState();
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
        }
        catch (error) {
            setMessage(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    useEffect(() => {
        void refresh();
    }, []);
    const toggleSkill = (id) => {
        const next = new Set(selected);
        if (next.has(id))
            next.delete(id);
        else
            next.add(id);
        setSelected(next);
    };
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q)
            return skills;
        return skills.filter((skill) => `${skill.name} ${skill.description} ${skill.source.agent}`.toLowerCase().includes(q));
    }, [query, skills]);
    const selectedSkill = filtered.find((skill) => selected.has(skill.id)) ?? filtered[0];
    const importRepo = async () => {
        setBusy(true);
        try {
            const result = await api.import();
            setMessage(`Imported ${result.imported} skills into ${result.repoPath}.`);
        }
        catch (error) {
            setMessage(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    const reviewSelected = async () => {
        setBusy(true);
        try {
            const ids = selected.size ? [...selected] : skills.slice(0, 20).map((skill) => skill.id);
            const result = await api.review(ids, "rules");
            setMessage(`Reviewed ${result.reviews.length} skills.`);
        }
        catch (error) {
            setMessage(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    const planDistribution = async (targetAgents) => {
        setBusy(true);
        try {
            const result = await api.distributionPlan(targetAgents, [...selected]);
            setPlan(result.plan);
            setMessage(`Plan ${result.plan.id}: ${result.plan.items.length} items.`);
        }
        catch (error) {
            setMessage(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    const applyDistribution = async (targetAgents) => {
        setBusy(true);
        try {
            const run = await api.distributionApply(targetAgents, [...selected]);
            setMessage(`Applied distribution: copied ${run.copied}, skipped ${run.skipped}.`);
            await refresh();
        }
        catch (error) {
            setMessage(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs("main", { className: "app-shell", children: [_jsxs("header", { className: "topbar", children: [_jsxs("div", { className: "product-title", children: [_jsx("div", { className: "brand-cube large", children: "\u25C6" }), _jsxs("div", { children: [_jsx("h1", { children: "Skill \u7BA1\u7406\u5DE5\u5177" }), _jsx("p", { children: "\u6C47\u603B \u00B7 \u5206\u53D1 \u00B7 \u4EA4\u6C47 \u00B7 \u7248\u672C\u8FFD\u6EAF" })] })] }), _jsxs("div", { className: "top-actions", children: [_jsxs("div", { className: "search-box", children: [_jsx(Search, { size: 16 }), _jsx("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: "\u641C\u7D22 skills..." })] }), _jsxs("button", { className: "ghost", onClick: refresh, children: [busy ? _jsx(Loader2, { className: "spin", size: 16 }) : _jsx(RefreshCw, { size: 16 }), " \u540C\u6B65\u626B\u63CF"] })] })] }), _jsxs("div", { className: "workspace", children: [_jsx(Sidebar, { view: view, setView: setView }), _jsxs("div", { className: "content", children: [_jsxs("div", { className: "mode-strip", children: [_jsxs("span", { children: [_jsx(Database, { size: 16 }), " \u7EDF\u4E00\u7BA1\u7406"] }), _jsxs("span", { children: [_jsx(GitBranch, { size: 16 }), " \u7248\u672C\u53EF\u8FFD\u6EAF"] }), _jsxs("span", { children: [_jsx(Sparkles, { size: 16 }), " \u667A\u80FD\u6821\u9A8C"] }), _jsxs("span", { children: [_jsx(GitCompareArrows, { size: 16 }), " \u81EA\u7531\u5206\u53D1"] }), _jsxs("span", { className: profile === "local" ? "profile-danger" : "profile-safe", children: ["Profile: ", profile] })] }), view === "overview" && _jsx(Overview, { skills: filtered, summary: summary, selected: selected, toggleSkill: toggleSkill, refresh: refresh, busy: busy }), view === "intersect" && _jsx(Intersect, { skills: filtered, selected: selected, toggleSkill: toggleSkill }), view === "distribute" && _jsx(Distribute, { targets: targets, selected: selected, onPlan: planDistribution, onApply: applyDistribution, plan: plan, busy: busy }), view === "detail" && _jsx(Detail, { skill: selectedSkill }), view === "repo" && _jsx(RepoView, { onImport: importRepo, onReview: reviewSelected, busy: busy, message: message }), _jsxs("footer", { className: "status-footer", children: [_jsxs("span", { children: [agents.length, " supported agents"] }), _jsx("span", { children: registryRepo }), _jsx("span", { children: message }), _jsxs("button", { onClick: () => setView("repo"), children: [_jsx(Settings, { size: 14 }), " \u8BBE\u7F6E"] })] })] })] })] }));
}
//# sourceMappingURL=App.js.map