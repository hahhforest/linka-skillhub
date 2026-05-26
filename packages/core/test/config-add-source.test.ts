import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  addSourceToConfig,
  addSourceToProfile,
  getAgentDefinitions,
  writeSkillHubConfig
} from "../src/index.js";
import type { SkillHubConfig, SkillSourceTemplate } from "../src/types.js";

const baseConfig = (cwd: string): SkillHubConfig => ({
  version: 1,
  activeProfile: "test",
  profiles: {
    test: {
      stateDir: path.join(cwd, "state"),
      registryRepo: path.join(cwd, "registry-repo"),
      agents: {
        claude: {
          sourceDirs: [{ path: "${cwd}/.claude/skills", scope: "user", defaultSelected: true }]
        }
      }
    }
  }
});

describe("addSourceToConfig", () => {
  it("appends a new source to an existing agent kind", () => {
    const config = baseConfig("/tmp/x");
    const source: SkillSourceTemplate = { path: "/tmp/x/extra", scope: "user", defaultSelected: true };
    const result = addSourceToConfig(config, "test", "claude", source);
    expect(result.totalSources).toBe(2);
    expect(result.config.profiles.test?.agents?.claude?.sourceDirs).toEqual([
      { path: "${cwd}/.claude/skills", scope: "user", defaultSelected: true },
      source
    ]);
  });

  it("creates a new agent entry for an unknown kind without disturbing existing ones", () => {
    const config = baseConfig("/tmp/x");
    const source: SkillSourceTemplate = { path: "/tmp/x/custom", scope: "user", defaultSelected: true };
    const result = addSourceToConfig(config, "test", "my-custom-agent", source);
    expect(result.totalSources).toBe(1);
    expect(result.config.profiles.test?.agents?.["my-custom-agent" as never]).toEqual({
      sourceDirs: [source]
    });
    // Existing agent entries should not be mutated.
    expect(result.config.profiles.test?.agents?.claude?.sourceDirs).toHaveLength(1);
  });

  it("rejects an unknown profile name", () => {
    const config = baseConfig("/tmp/x");
    expect(() =>
      addSourceToConfig(config, "no-such-profile", "claude", {
        path: "/tmp/x/extra",
        scope: "user",
        defaultSelected: true
      })
    ).toThrowError(/Profile not found/);
  });

  it("rejects a duplicate source path", () => {
    const config = baseConfig("/tmp/x");
    expect(() =>
      addSourceToConfig(config, "test", "claude", {
        path: "${cwd}/.claude/skills",
        scope: "user",
        defaultSelected: true
      })
    ).toThrowError(/already registered/);
  });
});

describe("writeSkillHubConfig + addSourceToProfile (disk round-trip)", () => {
  it("writes atomically via .tmp + rename and survives a subsequent read", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "linka-skillhub-config-write-"));
    const configPath = path.join(cwd, "linka-skillhub.config.json");
    await writeSkillHubConfig(configPath, baseConfig(cwd));
    // .tmp must not linger on disk after the successful write.
    await expect(fs.access(`${configPath}.tmp`)).rejects.toThrow();
    const result = await addSourceToProfile(
      "test",
      "my-custom-agent",
      { path: path.join(cwd, "custom-skills"), scope: "user", defaultSelected: true },
      { configPath, cwd }
    );
    expect(result.totalSources).toBe(1);
    const round = JSON.parse(await fs.readFile(configPath, "utf8")) as SkillHubConfig;
    const newAgent = (round.profiles.test?.agents as Record<string, { sourceDirs?: { path: string }[] }>)?.["my-custom-agent"];
    expect(newAgent?.sourceDirs?.[0]?.path).toBe(path.join(cwd, "custom-skills"));
  });

  it("makes the custom agent visible via getAgentDefinitions", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "linka-skillhub-custom-agent-"));
    const config = baseConfig(cwd);
    const next = addSourceToConfig(config, "test", "my-custom-agent", {
      path: path.join(cwd, "abc"),
      scope: "user",
      defaultSelected: true
    });
    const agents = getAgentDefinitions(cwd, next.config, "test");
    const kinds = agents.map((agent) => agent.kind);
    expect(kinds).toContain("my-custom-agent");
    const synth = agents.find((agent) => agent.kind === ("my-custom-agent" as never));
    expect(synth?.sourceDirs).toHaveLength(1);
    expect(synth?.sourceDirs[0]?.path).toBe(path.join(cwd, "abc"));
  });
});
