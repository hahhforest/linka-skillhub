import fs from "node:fs/promises";
import path from "node:path";
import { expandHome } from "./agents.js";
import { pathExists } from "./fs-helpers.js";
import type { ResolvedSkillHubConfig, SkillHubConfig, SkillHubProfile } from "./types.js";

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
