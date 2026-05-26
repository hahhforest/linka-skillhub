import fs from "node:fs/promises";
import path from "node:path";
import { expandHome } from "./agents.js";
import { pathExists } from "./fs-helpers.js";
import type { ResolvedSkillHubConfig, SkillHubConfig, SkillHubProfile, SkillSourceTemplate } from "./types.js";

const defaultConfig = (cwd: string): SkillHubConfig => ({
  version: 1,
  activeProfile: "local",
  profiles: {
    local: {
      stateDir: "~/.linka-skillhub",
      registryRepo: path.join(cwd, ".linka-skillhub", "registry-repo")
    }
  }
});

export const findConfigPath = async (cwd = process.cwd(), explicitPath?: string): Promise<string | undefined> => {
  if (explicitPath) return expandHome(explicitPath, cwd);
  if (process.env.LINKA_SKILLHUB_CONFIG) return expandHome(process.env.LINKA_SKILLHUB_CONFIG, cwd);

  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, "linka-skillhub.config.json");
    if (await pathExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

export const loadSkillHubConfig = async (options: {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly profileName?: string;
} = {}): Promise<ResolvedSkillHubConfig> => {
  const cwd = options.cwd ?? process.cwd();
  const configPath = await findConfigPath(cwd, options.configPath);
  const baseDir = configPath ? path.dirname(configPath) : cwd;
  const raw = configPath
    ? (JSON.parse(await fs.readFile(configPath, "utf8")) as SkillHubConfig)
    : defaultConfig(cwd);
  const profileName = options.profileName ?? raw.activeProfile;
  const profile = raw.profiles[profileName];
  if (!profile) throw new Error(`Profile not found in linka-skillhub config: ${profileName}`);

  const resolveProfilePath = (value: string): string => {
    if (value.includes("${cwd}") || value.includes("$CWD")) return expandHome(value, cwd);
    return expandHome(value, baseDir);
  };

  const normalizedAgents = Object.fromEntries(
    Object.entries(profile.agents ?? {}).map(([agent, config]) => [
      agent,
      {
        ...config,
        targetDir: config?.targetDir ? resolveProfilePath(config.targetDir) : undefined,
        sourceDirs: config?.sourceDirs?.map((source) => ({
          ...source,
          path: resolveProfilePath(source.path)
        }))
      }
    ])
  ) as SkillHubProfile["agents"];

  const normalized: Required<Pick<SkillHubProfile, "stateDir" | "registryRepo">> & SkillHubProfile = {
    ...profile,
    stateDir: resolveProfilePath(profile.stateDir ?? "~/.linka-skillhub"),
    registryRepo: resolveProfilePath(profile.registryRepo ?? path.join(baseDir, ".linka-skillhub", "registry-repo")),
    agents: normalizedAgents
  };
  const normalizedRaw: SkillHubConfig = {
    ...raw,
    profiles: {
      ...raw.profiles,
      [profileName]: normalized
    }
  };
  return { configPath, profileName, profile: normalized, raw: normalizedRaw };
};

/**
 * Atomically rewrite a linka-skillhub.config.json on disk.
 *
 * The whole point of this helper is to make sure a crash mid-write never
 * leaves the file half-rewritten (which would brick the next `loadSkillHubConfig`
 * call and lock the user out of every Skill operation). We:
 *
 *   1. Serialize the config to JSON (2-space indent + trailing newline so the
 *      file diffs cleanly against the hand-edited seed in git).
 *   2. Write the bytes to `${configPath}.tmp` first (same directory, so the
 *      eventual rename stays on the same filesystem and stays atomic).
 *   3. `fs.rename` the temp file into place. On POSIX rename(2) is atomic for
 *      same-filesystem moves, so readers either see the old file or the new
 *      file — never a torn write.
 *
 * The caller owns the SkillHubConfig object — we do NOT re-normalize paths
 * back into ~ form here. addSourceToProfile feeds us the raw (unmodified)
 * config it read from disk, with just the new entry appended, so the rest
 * of the file round-trips byte-for-byte except for the appended source.
 */
export const writeSkillHubConfig = async (configPath: string, raw: SkillHubConfig): Promise<void> => {
  const serialized = `${JSON.stringify(raw, null, 2)}\n`;
  const tmpPath = `${configPath}.tmp`;
  await fs.writeFile(tmpPath, serialized, "utf8");
  await fs.rename(tmpPath, configPath);
};

export interface AddSourceOptions {
  readonly configPath?: string;
  readonly cwd?: string;
  /**
   * When true, treat an unknown profile as an error. We always pass true from
   * the server; the option exists mainly so tests can fall back to "create the
   * profile if missing" semantics down the road without changing the signature.
   */
  readonly strictProfile?: boolean;
}

export interface AddSourceResult {
  readonly configPath: string;
  readonly profileName: string;
  readonly agentKind: string;
  readonly totalSources: number;
  readonly source: SkillSourceTemplate;
}

/**
 * Append a single SkillSourceTemplate to a profile's `agents[agentKind].sourceDirs`
 * list and persist the updated config to disk via writeSkillHubConfig.
 *
 * Behaviours worth pinning down:
 *
 *   - Reads the current config from disk (NOT from a cached resolution). This
 *     means callers can't accidentally clobber concurrent edits made by another
 *     `lsh` invocation between the resolve-config and the add-source step.
 *   - If the profile doesn't have an `agents` map, we create one.
 *   - If the profile doesn't have an entry for `agentKind`, we create one with
 *     `sourceDirs: [newSource]` and leave `targetDir`/`enabled` undefined so
 *     the default-agent logic still picks reasonable values when the agent is
 *     a built-in (e.g. claude/codex/mavis). For genuinely-custom agent kinds,
 *     leaving targetDir undefined lets getAgentDefinitions fall back to a
 *     synthesised default (added in agents.ts).
 *   - Persists the entire config back via writeSkillHubConfig (atomic rename).
 *
 * The pure functional concern (mutating an in-memory SkillHubConfig) is also
 * exposed via `addSourceToConfig` below so callers that already have a
 * SkillHubConfig in memory (or unit tests) don't need to hit the filesystem.
 */
export const addSourceToProfile = async (
  profileName: string,
  agentKind: string,
  source: SkillSourceTemplate,
  options: AddSourceOptions = {}
): Promise<AddSourceResult> => {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? (await findConfigPath(cwd));
  if (!configPath) {
    throw Object.assign(new Error("No linka-skillhub.config.json found"), { code: "missing_config" });
  }
  const rawText = await fs.readFile(configPath, "utf8");
  const raw = JSON.parse(rawText) as SkillHubConfig;
  const next = addSourceToConfig(raw, profileName, agentKind, source);
  await writeSkillHubConfig(configPath, next.config);
  return {
    configPath,
    profileName,
    agentKind,
    totalSources: next.totalSources,
    source
  };
};

/**
 * Pure helper: returns a new SkillHubConfig with `source` appended to
 * `profiles[profileName].agents[agentKind].sourceDirs`. Used by
 * addSourceToProfile but exported so unit tests (and any future "batch
 * edit" flows) can verify the merge logic without touching disk.
 *
 * Throws with a typed `code` so the server can map directly to a humanized
 * UI string without re-parsing the error message:
 *   - profile_not_found   (the named profile is not in config.profiles)
 *   - duplicate_source    (this agentKind already has a source with the same path)
 */
export const addSourceToConfig = (
  raw: SkillHubConfig,
  profileName: string,
  agentKind: string,
  source: SkillSourceTemplate
): { readonly config: SkillHubConfig; readonly totalSources: number } => {
  const profile = raw.profiles[profileName];
  if (!profile) {
    throw Object.assign(new Error(`Profile not found: ${profileName}`), { code: "profile_not_found" });
  }
  // The original SkillHubProfile.agents type is keyed by AgentKind. We
  // intentionally widen to Record<string, ...> at runtime so custom kinds can
  // be persisted; the file is JSON so the key type is whatever the user wrote.
  const existingAgents = (profile.agents ?? {}) as Record<string, { readonly enabled?: boolean; readonly targetDir?: string; readonly sourceDirs?: readonly SkillSourceTemplate[] }>;
  const existingAgent = existingAgents[agentKind];
  const existingSources = existingAgent?.sourceDirs ?? [];
  if (existingSources.some((entry) => entry.path === source.path)) {
    throw Object.assign(new Error(`Source path already registered for ${agentKind}: ${source.path}`), {
      code: "duplicate_source"
    });
  }
  const nextSources = [...existingSources, source];
  const nextAgent = { ...(existingAgent ?? {}), sourceDirs: nextSources };
  const nextAgents = { ...existingAgents, [agentKind]: nextAgent };
  const nextProfile: SkillHubProfile = { ...profile, agents: nextAgents as SkillHubProfile["agents"] };
  const nextConfig: SkillHubConfig = {
    ...raw,
    profiles: { ...raw.profiles, [profileName]: nextProfile }
  };
  return { config: nextConfig, totalSources: nextSources.length };
};
