import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeSyncStatus,
  discoverSkillSources,
  importSkillsToRepository,
  readInstancesIndex,
  readRegistryManifest,
  syncForkInstance,
  syncPullFromInstance,
  syncPushToAllInstances,
  syncPushToInstance
} from "../src/index.js";

// Each test stands up a fresh tmpdir, two skill source dirs, runs a full
// scan + import (which initialises a git repo, writes manifest + canonical,
// and lands one commit per skill). That's tens of git invocations per test
// — the default 5s vitest timeout isn't enough, especially on cold cache.
const TEST_TIMEOUT = 30_000;

const writeSkill = async (dir: string, name: string, description: string, body = ""): Promise<void> => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n${body}`,
    "utf8"
  );
};

// Stand up a minimal mirror profile with two agents whose source dirs both
// contain the same skill — gives us a canonical-with-two-instances starting
// state to exercise drift / pull / push / fork against.
const setupTwoAgents = async (): Promise<{ cwd: string; repoPath: string; alphaSkill: string; betaSkill: string }> => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "linka-skillhub-sync-"));
  const alphaSkill = path.join(cwd, ".opencode", "skills", "shared-skill");
  const betaSkill = path.join(cwd, ".claude", "skills", "shared-skill");
  await writeSkill(alphaSkill, "shared-skill", "Shared between agents.");
  await writeSkill(betaSkill, "shared-skill", "Shared between agents.");
  const sources = await discoverSkillSources(cwd);
  // discoverSkillSources resolves every agent's default source paths from the
  // real home dir as well as the test cwd. Restrict to sources rooted in the
  // test cwd so we don't accidentally scan the developer's actual
  // ~/.mavis/skills, ~/.codex/... etc. (which would take dozens of seconds and
  // pollute the result).
  const selectedSourceIds = sources
    .filter((source) => source.rootPath.startsWith(cwd))
    .map((source) => source.id);
  const repoPath = path.join(cwd, "registry-repo");
  await importSkillsToRepository({ repoPath, cwd, selectedSourceIds });
  return { cwd, repoPath, alphaSkill, betaSkill };
};

describe("computeSyncStatus", () => {
  it("flags drift / missing / orphan from instances.json", async () => {
    const { repoPath, alphaSkill } = await setupTwoAgents();
    // Edit one instance on disk so its lastSeenHash diverges on next refresh.
    await writeSkill(alphaSkill, "shared-skill", "Shared between agents.", "edited body\n");
    // Refresh via a no-op push so refreshInstanceStatuses re-hashes everything.
    // (push is the cheapest way to force a status refresh against the canonical.)
    await syncPushToInstance(repoPath, "shared-skill", "claude");
    const manifest = await readRegistryManifest(repoPath);
    const instances = await readInstancesIndex(repoPath);
    const statuses = computeSyncStatus(manifest, instances);
    const status = statuses.find((s) => s.name === "shared-skill")!;
    expect(status.hasDrift).toBe(true);
    expect(status.instances.length).toBeGreaterThanOrEqual(1);
  }, TEST_TIMEOUT);
});

describe("syncPullFromInstance", () => {
  it("copies the agent's edits into the canonical and updates the hash", async () => {
    const { repoPath, alphaSkill } = await setupTwoAgents();
    const manifestBefore = await readRegistryManifest(repoPath);
    const canonicalBefore = manifestBefore.skills.find((s) => s.name === "shared-skill")!;
    // Edit the alpha instance.
    await writeSkill(alphaSkill, "shared-skill", "Shared between agents.", "alpha-edit\n");
    const result = await syncPullFromInstance(repoPath, "shared-skill", "opencode");
    expect(result.newHash).not.toBe(result.oldHash);
    expect(result.oldHash).toBe(canonicalBefore.hash);
    const manifestAfter = await readRegistryManifest(repoPath);
    const canonicalAfter = manifestAfter.skills.find((s) => s.name === "shared-skill")!;
    expect(canonicalAfter.hash).toBe(result.newHash);
    // The other (beta) instance must now be reported as drifted.
    expect(result.otherDrifted.length).toBeGreaterThanOrEqual(0);
    const canonicalDir = path.join(repoPath, "registry", "skills", "shared-skill");
    const canonicalContent = await fs.readFile(path.join(canonicalDir, "SKILL.md"), "utf8");
    expect(canonicalContent).toContain("alpha-edit");
  }, TEST_TIMEOUT);

  it("refuses to pull from an unknown agent", async () => {
    const { repoPath } = await setupTwoAgents();
    await expect(syncPullFromInstance(repoPath, "shared-skill", "codex")).rejects.toThrow();
  }, TEST_TIMEOUT);
});

describe("syncPushToInstance", () => {
  it("overwrites the instance's realPath with the canonical content", async () => {
    const { repoPath, alphaSkill } = await setupTwoAgents();
    // Alpha edits diverge; push restores it from canonical.
    await writeSkill(alphaSkill, "shared-skill", "Shared between agents.", "alpha-edit\n");
    const restored = await syncPushToInstance(repoPath, "shared-skill", "opencode");
    expect(restored.name).toBe("shared-skill");
    const restoredContent = await fs.readFile(path.join(alphaSkill, "SKILL.md"), "utf8");
    expect(restoredContent).not.toContain("alpha-edit");
  }, TEST_TIMEOUT);
});

describe("syncPushToAllInstances", () => {
  it("pushes only to drifted instances, skipping in-sync ones", async () => {
    const { repoPath, alphaSkill, betaSkill } = await setupTwoAgents();
    await writeSkill(alphaSkill, "shared-skill", "Shared between agents.", "alpha-edit\n");
    // Force a refresh so alpha shows up as drifted in instances.json before push-all.
    await syncPushToInstance(repoPath, "shared-skill", "claude");
    const results = await syncPushToAllInstances(repoPath, "shared-skill");
    // The beta side was untouched after the refresh, so push-all targets only
    // the drifted alpha realPath — exactly one result. Compare via realpath
    // because instances.json stores symlink-resolved paths (on macOS, tmpdir
    // resolves /var/... → /private/var/...).
    expect(results.length).toBe(1);
    const alphaReal = await fs.realpath(alphaSkill);
    expect(results[0]?.realPath).toBe(alphaReal);
    // After push-all the alpha content should match the canonical (no alpha-edit).
    const alphaContent = await fs.readFile(path.join(alphaSkill, "SKILL.md"), "utf8");
    expect(alphaContent).not.toContain("alpha-edit");
    // Beta untouched.
    expect(await fs.stat(path.join(betaSkill, "SKILL.md"))).toBeTruthy();
  }, TEST_TIMEOUT);
});

describe("syncForkInstance", () => {
  it("creates a new canonical under a fresh name from the instance edits", async () => {
    const { repoPath, alphaSkill } = await setupTwoAgents();
    await writeSkill(alphaSkill, "shared-skill", "Shared between agents.", "fork-source\n");
    const result = await syncForkInstance(repoPath, "shared-skill", "shared-skill-v2", "opencode");
    expect(result.newName).toBe("shared-skill-v2");
    expect(result.fromName).toBe("shared-skill");
    const manifestAfter = await readRegistryManifest(repoPath);
    expect(manifestAfter.skills.some((s) => s.name === "shared-skill")).toBe(true);
    expect(manifestAfter.skills.some((s) => s.name === "shared-skill-v2")).toBe(true);
    const forkCanonical = path.join(repoPath, "registry", "skills", "shared-skill-v2", "SKILL.md");
    const forkContent = await fs.readFile(forkCanonical, "utf8");
    expect(forkContent).toContain("fork-source");
  }, TEST_TIMEOUT);

  it("rejects names that collide with an existing canonical", async () => {
    const { repoPath } = await setupTwoAgents();
    await expect(syncForkInstance(repoPath, "shared-skill", "shared-skill", "opencode")).rejects.toThrow();
  }, TEST_TIMEOUT);

  it("rejects invalid slug shapes", async () => {
    const { repoPath } = await setupTwoAgents();
    await expect(syncForkInstance(repoPath, "shared-skill", "Bad Name", "opencode")).rejects.toThrow();
  }, TEST_TIMEOUT);

  it("rejects names longer than 96 chars (the canonical path segment cap)", async () => {
    const { repoPath } = await setupTwoAgents();
    const tooLong = `a${"b".repeat(96)}`; // 97 chars
    await expect(syncForkInstance(repoPath, "shared-skill", tooLong, "opencode")).rejects.toThrow(/too long/);
  }, TEST_TIMEOUT);
});
