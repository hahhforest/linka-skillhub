import type { SkillPackage, SkillStatus } from "@linka-skillhub/core";
import { messages, type Language } from "../i18n.js";

// Stable visual identity per agent (mark + tint class) used everywhere a skill
// or agent gets surfaced — SkillTable rows, DetailPanel header, Sidebar legend,
// Intersect select labels. Centralising it here avoids per-component drift if
// we ever rebrand an agent or add a new one. Unknown agents fall back to a
// neutral chip via the `agent-generic` className.
export const agentTone: Record<string, { label: string; mark: string; className: string }> = {
  mavis: { label: "Mavis", mark: "M", className: "agent-mavis" },
  opencode: { label: "OpenCode", mark: "O", className: "agent-opencode" },
  claude: { label: "Claude Code", mark: "C", className: "agent-claude" },
  codex: { label: "Codex", mark: "X", className: "agent-codex" },
  shared: { label: ".agents/skills", mark: "S", className: "agent-shared" }
};

export function AgentLogo({ agent }: { readonly agent: string }): JSX.Element {
  const tone = agentTone[agent] ?? { label: agent, mark: agent.slice(0, 1).toUpperCase(), className: "agent-generic" };
  return <span className={`agent-logo ${tone.className}`} title={tone.label}>{tone.mark}</span>;
}

// statusClass / bucketLabel are kept in lockstep so the row pill colour and the
// detail panel pill text always agree. Both collapse the multi-status array
// (e.g. ["valid", "portable"]) into a single user-facing bucket; precedence
// follows the same order — unsafe/invalid > agent_bound > shareable > other.
export const statusClass = (skill: SkillPackage): string => {
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

export const bucketLabel = (skill: SkillPackage, lang: Language): string => {
  const t = messages[lang];
  switch (bucket(skill)) {
    case "shareable": return t.shareable;
    case "agentBound": return t.agentBound;
    case "problem": return t.problematic;
    default: return t.unreviewedBucket;
  }
};

// statusLabel keeps the SkillTable row pill phrasing aligned with bucketLabel:
// rows show the same wording the DetailPanel pill uses, so the user does not
// see "Shareable" in the table and "Portable" in the detail for the same skill.
export const statusLabel = (lang: Language): Record<SkillStatus, string> => ({
  valid: messages[lang].shareable,
  portable: messages[lang].shareable,
  invalid: messages[lang].problematic,
  agent_bound: messages[lang].agentBound,
  unsafe: messages[lang].problematic,
  unreviewed: lang === "zh" ? "未审查" : "Unreviewed"
});
