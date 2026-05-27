import type { SkillPackage, SkillScope, SkillStatus } from "@linka-skillhub/core";
import { messages, type Language } from "../i18n.js";
import { OfficialLogo, OfficialLogoImage } from "./agentLogos.js";

// Stable display metadata per agent (label only — color/SVG live elsewhere).
// SkillTable rows, DetailPanel header, Sidebar legend, Intersect select labels
// and the Distribute target grid all read `label` from here. Unknown agents
// fall back to the raw `agent` string so user-added directories (R35-C4) and
// future agents added via config still surface a readable name.
//
// R35-C2: the per-agent `mark` / `className` fields are gone; rendering now
// goes through OfficialLogo (inline SVG) or agentColor (random-color avatar).
export const agentTone: Record<string, { label: string }> = {
  mavis: { label: "Mavis" },
  opencode: { label: "OpenCode" },
  claude: { label: "Claude Code" },
  codex: { label: "Codex" },
  cursor: { label: "Cursor" },
  openclaw: { label: "OpenClaw" },
  hermes: { label: "Hermes" },
  shared: { label: ".agents/skills" }
};

// Fixed palette of high-contrast tints for the random-color fallback. Picked
// to be visually distinguishable from each other AND from the four official
// brand colors (Anthropic orange, OpenAI near-black, SST cyan, Mavis blue)
// so a user-added agent never accidentally mimics an official one. White text
// stays legible on every background here (all are sat ≥45% / lum ≤55%).
const FALLBACK_PALETTE: readonly { background: string; foreground: string }[] = [
  { background: "#7c3aed", foreground: "#ffffff" }, // violet
  { background: "#db2777", foreground: "#ffffff" }, // pink
  { background: "#059669", foreground: "#ffffff" }, // emerald
  { background: "#dc2626", foreground: "#ffffff" }, // red
  { background: "#ca8a04", foreground: "#ffffff" }, // amber
  { background: "#0891b2", foreground: "#ffffff" }, // teal-cyan (distinct from SST)
  { background: "#65a30d", foreground: "#ffffff" }, // lime
  { background: "#9333ea", foreground: "#ffffff" }, // purple
  { background: "#475569", foreground: "#ffffff" }, // slate
  { background: "#b91c1c", foreground: "#ffffff" }  // brick
];

// DJB2 hash — small, fast, deterministic. We only need a uniform-ish
// distribution across 10 buckets, not a cryptographic property. The unsigned
// >>> 0 normalises so negative ints don't reverse the modulo result. Pure
// function (no clock, no Math.random) so the same label always picks the
// same palette entry across reloads — that's what the unit test pins.
const djb2 = (input: string): number => {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return hash >>> 0;
};

// agentColor: pure helper for the random-color fallback. Same input always
// returns the same { background, foreground }. Exported so the colocated
// vitest can assert determinism and the official-vs-fallback split without
// having to render React.
export const agentColor = (label: string): { background: string; foreground: string } => {
  const key = label.length > 0 ? label : "?";
  const index = djb2(key) % FALLBACK_PALETTE.length;
  // noUncheckedIndexedAccess guards us — FALLBACK_PALETTE is non-empty so
  // this lookup is always defined, but TS still wants the fallback.
  return FALLBACK_PALETTE[index] ?? FALLBACK_PALETTE[0]!;
};

export function AgentLogo({ agent }: { readonly agent: string }): JSX.Element {
  const tone = agentTone[agent];
  const label = tone?.label ?? agent;
  // Resolution order: image asset (e.g. mavis's app icon PNG) first, then
  // any inline SVG mark, then deterministic random-color avatar.
  const imageUrl = OfficialLogoImage[agent];
  if (imageUrl) {
    return (
      <span className="agent-logo agent-official agent-image" title={label} aria-label={label}>
        <img src={imageUrl} alt="" />
      </span>
    );
  }
  const OfficialMark = OfficialLogo[agent];
  if (OfficialMark) {
    return (
      <span className="agent-logo agent-official" title={label} aria-label={label}>
        <OfficialMark />
      </span>
    );
  }
  // Fallback: user-added or unknown agent. Deterministic color tint + first
  // letter (uppercased) on top. Inline style keeps the random color out of
  // the static CSS file — there's no need for a per-agent rule because the
  // tone is computed from the label string itself.
  const { background, foreground } = agentColor(label);
  const initial = (label || agent || "?").slice(0, 1).toUpperCase();
  return (
    <span
      className="agent-logo agent-custom"
      title={label}
      aria-label={label}
      style={{ background, color: foreground }}
    >
      {initial}
    </span>
  );
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

// R35-C3: localised label for a skill's source scope (user / private /
// builtin / system / project / unknown). Used by Overview's source-distribution
// bars where each (agent, scope) pair is rendered as its own row. Kept here
// so the bars and any future scope chip read from the same lookup.
export const scopeLabel = (scope: SkillScope, lang: Language): string => {
  const table = messages[lang] as Record<string, string>;
  const key = `scope_${scope}`;
  const value = table[key];
  return typeof value === "string" ? value : scope;
};
