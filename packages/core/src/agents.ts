import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDefinition, AgentKind, DistributionTarget, SkillHubConfig, SkillSource } from "./types.js";

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

export const getAgentDefinitions = (cwd = process.cwd(), config?: SkillHubConfig, profileName?: string): AgentDefinition[] =>
  Object.values(DEFAULT_AGENTS)
    .map((agent) => configuredAgent(agent, cwd, config, profileName))
    .filter((agent): agent is AgentDefinition => Boolean(agent));

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
