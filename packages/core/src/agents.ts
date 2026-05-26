import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDefinition, AgentKind, DistributionTarget, SkillHubConfig, SkillSource, SkillSourceTemplate } from "./types.js";

const home = os.homedir();

export const expandHome = (input: string, cwd = process.cwd()): string => {
  const withHome = input.startsWith("~/") ? path.join(home, input.slice(2)) : input;
  const withCwd = withHome.replaceAll("${cwd}", cwd).replaceAll("$CWD", cwd);
  return path.isAbsolute(withCwd) ? path.resolve(withCwd) : path.resolve(cwd, withCwd);
};

export const DEFAULT_AGENTS: Record<AgentKind, AgentDefinition> = {
  mavis: {
    kind: "mavis",
    label: "Mavis",
    command: "mavis",
    color: "#2563eb",
    defaultTargetDir: "~/.mavis/skills",
    sourceDirs: [
      { path: "~/.mavis/skills", scope: "user", defaultSelected: true },
      { path: "~/.mavis/agents", scope: "private", defaultSelected: true, includeNested: true },
      { path: "~/.mavis/.builtin-skills", scope: "builtin", defaultSelected: false, note: "Mavis built-in skills are shown but excluded by default." }
    ]
  },
  opencode: {
    kind: "opencode",
    label: "OpenCode",
    command: "opencode",
    color: "#0ea5e9",
    defaultTargetDir: "~/.config/opencode/skills",
    sourceDirs: [
      { path: "~/.config/opencode/skills", scope: "user", defaultSelected: true },
      { path: "~/.opencode/skills", scope: "user", defaultSelected: true },
      { path: "${cwd}/.opencode/skills", scope: "project", defaultSelected: true },
      { path: "~/.agents/skills", scope: "user", defaultSelected: true, note: "Shared Agent Skills directory also consumed by OpenCode-compatible setups." }
    ]
  },
  claude: {
    kind: "claude",
    label: "Claude Code",
    command: "claude",
    color: "#f97316",
    defaultTargetDir: "~/.claude/skills",
    sourceDirs: [
      { path: "~/.claude/skills", scope: "user", defaultSelected: true },
      { path: "${cwd}/.claude/skills", scope: "project", defaultSelected: true }
    ]
  },
  codex: {
    kind: "codex",
    label: "Codex",
    command: "codex",
    color: "#111827",
    defaultTargetDir: "~/.codex/skills",
    sourceDirs: [
      { path: "~/.codex/skills", scope: "user", defaultSelected: true },
      { path: "~/.codex/skills/.system", scope: "system", defaultSelected: false, note: "Codex system skills are managed by Codex and excluded by default." }
    ]
  },
  cursor: {
    kind: "cursor",
    label: "Cursor",
    command: "cursor",
    color: "#6366f1",
    defaultTargetDir: "~/.cursor/skills-cursor",
    sourceDirs: [
      { path: "~/.cursor/skills-cursor", scope: "user", defaultSelected: true }
    ]
  },
  shared: {
    kind: "shared",
    label: ".agents/skills",
    color: "#64748b",
    defaultTargetDir: "~/.agents/skills",
    sourceDirs: [{ path: "~/.agents/skills", scope: "user", defaultSelected: true, note: "Shared Agent Skills directory. Kept as its own source instead of attributing to one agent." }]
  }
};

const configuredAgent = (
  agent: AgentDefinition,
  cwd: string,
  config?: SkillHubConfig,
  profileName?: string
): AgentDefinition | undefined => {
  const profile = config?.profiles[profileName ?? config.activeProfile];
  const override = profile?.agents?.[agent.kind];
  if (override?.enabled === false) return undefined;
  return {
    ...agent,
    defaultTargetDir: override?.targetDir ?? agent.defaultTargetDir,
    sourceDirs: override?.sourceDirs ?? agent.sourceDirs
  };
};

// R35-C4: agents declared only in the config (e.g. an arbitrary kind the user
// added via "Add Source Directory" from the Overview page) need to surface as
// first-class AgentDefinitions too. The DEFAULT_AGENTS loop above misses them
// because they aren't keys in that record. We synthesise a definition here:
// the label defaults to the agent kind itself (the AgentLogo fallback in the
// web layer renders a deterministic color tint + initial), targetDir defaults
// to the first source path (so a future Distribute action has a sensible
// guess), and sourceDirs come straight from the config. If the user later
// extends DEFAULT_AGENTS or a built-in ships with the same kind, that branch
// takes precedence — this helper only kicks in for truly-custom kinds.
const synthesizeCustomAgent = (
  agentKind: string,
  override: { readonly enabled?: boolean; readonly targetDir?: string; readonly sourceDirs?: readonly SkillSourceTemplate[] }
): AgentDefinition | undefined => {
  if (override.enabled === false) return undefined;
  const sourceDirs = override.sourceDirs ?? [];
  const firstSource = sourceDirs[0];
  return {
    kind: agentKind as AgentKind,
    label: agentKind,
    color: "#64748b",
    defaultTargetDir: override.targetDir ?? firstSource?.path ?? `~/${agentKind}/skills`,
    sourceDirs
  };
};

export const getAgentDefinitions = (cwd = process.cwd(), config?: SkillHubConfig, profileName?: string): AgentDefinition[] => {
  const built = Object.values(DEFAULT_AGENTS)
    .map((agent) => configuredAgent(agent, cwd, config, profileName))
    .filter((agent): agent is AgentDefinition => Boolean(agent));
  const profile = config?.profiles[profileName ?? config?.activeProfile ?? ""];
  if (!profile?.agents) return built;
  const knownKinds = new Set(Object.keys(DEFAULT_AGENTS));
  const customs: AgentDefinition[] = [];
  for (const [kind, override] of Object.entries(profile.agents)) {
    if (knownKinds.has(kind)) continue;
    if (!override) continue;
    const synth = synthesizeCustomAgent(kind, override);
    if (synth) customs.push(synth);
  }
  return [...built, ...customs];
};

export const getDistributionTargets = (cwd = process.cwd(), config?: SkillHubConfig, profileName?: string): DistributionTarget[] =>
  getAgentDefinitions(cwd, config, profileName).map((agent) => ({
    agent: agent.kind,
    label: agent.label,
    targetDir: expandHome(agent.defaultTargetDir, cwd)
  }));

export const discoverSources = (cwd = process.cwd(), config?: SkillHubConfig, profileName?: string): SkillSource[] =>
  getAgentDefinitions(cwd, config, profileName).flatMap((agent) =>
    agent.sourceDirs.map((template, index) => {
      const rootPath = expandHome(template.path, cwd);
      return {
        id: `${agent.kind}:${index}:${pathToFileURL(rootPath).href}`,
        agent: agent.kind,
        label: `${agent.label} ${template.scope}`,
        rootPath,
        scope: template.scope,
        defaultSelected: template.defaultSelected,
        exists: false,
        includeNested: template.includeNested ?? false,
        note: template.note
      } satisfies SkillSource;
    })
  );
