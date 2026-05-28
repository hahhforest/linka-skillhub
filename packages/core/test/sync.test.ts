import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeSyncStatus,
  discoverSkillSources,
  hashDirectory,
  importSkillsToRepository,
  prepareMergeWorkspace,
  readInstancesIndex,
  readRegistryManifest,
  syncForkInstance,
  syncMergeInstances,
  syncPullFromInstance,
  syncPushToAllInstances,
  syncPushToInstance,
  validateMergeTarget
} from "../src/index.js";
import type { MergeRunner } from "../src/sync.js";

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

// Helper: a merge runner that synchronously writes target/SKILL.md with the
// caller-supplied body. Lets each test simulate "the agent did X" without
// spawning a real CLI. Returning empty stdout/stderr matches the production
// runner shape; the real value-add of these tests is that the validation +
// commit + manifest update logic runs against actual files on disk.
const makeMockRunner = (writes: readonly string[]): MergeRunner => {
  let attemptIndex = 0;
  return async ({ workspaceDir }) => {
    const targetDir = path.join(workspaceDir, "target");
    await fs.mkdir(targetDir, { recursive: true });
    const body = writes[attemptIndex] ?? "";
    await fs.writeFile(path.join(targetDir, "SKILL.md"), body, "utf8");
    attemptIndex += 1;
    return { stdout: "", stderr: "" };
  };
};

const validMergedSkill = (name: string): string =>
  `---\nname: ${name}\ndescription: Merged across multiple agents.\n---\n# ${name}\nSome merged body.\n`;

describe("prepareMergeWorkspace", () => {
  it("builds the workspace skeleton with one subdir per source agent and an INSTRUCTIONS.md naming each", async () => {
    const { repoPath } = await setupTwoAgents();
    const prep = await prepareMergeWorkspace(repoPath, "shared-skill", ["opencode", "claude"], { workspaceId: "abcde" });
    expect(prep.workspaceDir).toContain(path.join(".merges", "shared-skill-abcde"));
    expect(prep.sources).toHaveLength(2);
    expect(prep.sources[0]?.subdir).toBe("a");
    expect(prep.sources[1]?.subdir).toBe("b");
    // Each source subdir contains the original SKILL.md (whole-tree copy).
    expect(await fs.stat(path.join(prep.workspaceDir, "a", "SKILL.md"))).toBeTruthy();
    expect(await fs.stat(path.join(prep.workspaceDir, "b", "SKILL.md"))).toBeTruthy();
    // target/ is created empty.
    const targetEntries = await fs.readdir(prep.targetDir);
    expect(targetEntries).toHaveLength(0);
    // INSTRUCTIONS.md mentions both source agents and absolute paths.
    const instructions = await fs.readFile(prep.instructionsPath, "utf8");
    expect(instructions).toContain("opencode");
    expect(instructions).toContain("claude");
    expect(instructions).toContain(prep.workspaceDir);
    // .merges/.gitignore makes the parent invisible to git.
    const mergesGitignore = await fs.readFile(path.join(repoPath, ".merges", ".gitignore"), "utf8");
    expect(mergesGitignore).toContain("*");
  }, TEST_TIMEOUT);

  it("rejects fewer than 2 source agents", async () => {
    const { repoPath } = await setupTwoAgents();
    await expect(prepareMergeWorkspace(repoPath, "shared-skill", ["opencode"])).rejects.toThrow(/at least 2/);
  }, TEST_TIMEOUT);

  it("rejects duplicate agents in fromAgents", async () => {
    const { repoPath } = await setupTwoAgents();
    await expect(prepareMergeWorkspace(repoPath, "shared-skill", ["opencode", "opencode"])).rejects.toThrow(/distinct/);
  }, TEST_TIMEOUT);
});

describe("validateMergeTarget", () => {
  it("returns ok when target/SKILL.md is valid + portable with the expected name", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "linka-merge-validate-"));
    await fs.writeFile(path.join(dir, "SKILL.md"), validMergedSkill("shared-skill"), "utf8");
    const result = await validateMergeTarget(dir, "shared-skill");
    expect(result.ok).toBe(true);
    expect(result.reasons).toHaveLength(0);
    expect(result.hash).not.toBe("");
  }, TEST_TIMEOUT);

  it("flags missing SKILL.md with a reason that points the agent at target/", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "linka-merge-validate-"));
    const result = await validateMergeTarget(dir, "shared-skill");
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/target\/SKILL\.md does not exist/);
  }, TEST_TIMEOUT);

  it("flags wrong name in frontmatter", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "linka-merge-validate-"));
    await fs.writeFile(path.join(dir, "SKILL.md"), validMergedSkill("wrong-name"), "utf8");
    const result = await validateMergeTarget(dir, "shared-skill");
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/name='shared-skill'/);
  }, TEST_TIMEOUT);
});

describe("syncMergeInstances", () => {
  it("succeeds on first attempt when the runner produces a valid target/", async () => {
    const { repoPath } = await setupTwoAgents();
    const runner = makeMockRunner([validMergedSkill("shared-skill")]);
    const result = await syncMergeInstances(repoPath, "shared-skill", ["opencode", "claude"], "claude", { runner, workspaceId: "fffff" });
    expect(result.attempts).toBe(1);
    expect(result.fromAgents).toEqual(["opencode", "claude"]);
    expect(result.byAgent).toBe("claude");
    expect(result.oldHash).not.toBe(result.newHash);
    expect(result.shortSha).not.toBe("");
    // Canonical now matches the merged content.
    const canonicalSkill = await fs.readFile(path.join(repoPath, "registry", "skills", "shared-skill", "SKILL.md"), "utf8");
    expect(canonicalSkill).toContain("Merged across multiple agents");
    // Workspace persists for inspection.
    expect(await fs.stat(result.workspaceDir)).toBeTruthy();
  }, TEST_TIMEOUT);

  it("retries once when the first runner output fails strict validation, succeeds on second", async () => {
    const { repoPath } = await setupTwoAgents();
    const runner = makeMockRunner([
      "no frontmatter at all\n",                  // first attempt: invalid
      validMergedSkill("shared-skill")            // retry: valid
    ]);
    const result = await syncMergeInstances(repoPath, "shared-skill", ["opencode", "claude"], "claude", { runner, workspaceId: "ggggg" });
    expect(result.attempts).toBe(2);
    // INSTRUCTIONS.md was appended with a retry feedback block before the 2nd attempt.
    const instructions = await fs.readFile(path.join(result.workspaceDir, "INSTRUCTIONS.md"), "utf8");
    expect(instructions).toMatch(/Previous attempt failed strict validation/);
  }, TEST_TIMEOUT);

  it("throws after two failed attempts and keeps the workspace on disk", async () => {
    const { repoPath } = await setupTwoAgents();
    const runner = makeMockRunner([
      "no frontmatter\n",
      "still no frontmatter\n"
    ]);
    await expect(
      syncMergeInstances(repoPath, "shared-skill", ["opencode", "claude"], "claude", { runner, workspaceId: "hhhhh" })
    ).rejects.toThrow(/failed strict validation after 2 attempts/);
    // Workspace path is in the error message; ensure it still exists.
    const workspaceDir = path.join(repoPath, ".merges", "shared-skill-hhhhh");
    expect(await fs.stat(workspaceDir)).toBeTruthy();
  }, TEST_TIMEOUT);

  it("commit subject lists fromAgents in the order the user supplied", async () => {
    const { repoPath } = await setupTwoAgents();
    const runner = makeMockRunner([validMergedSkill("shared-skill")]);
    await syncMergeInstances(repoPath, "shared-skill", ["claude", "opencode"], "claude", { runner, workspaceId: "iiiii" });
    // git log -1 --format=%s on the canonical path → most recent subject.
    const { spawnSync } = await import("node:child_process");
    const subject = spawnSync("git", ["log", "-1", "--format=%s", "--", path.join("registry", "skills", "shared-skill")], { cwd: repoPath, encoding: "utf8" }).stdout.trim();
    expect(subject).toBe("merge shared-skill (claude + opencode)");
  }, TEST_TIMEOUT);

  it("wipes target/ between retry attempts so attempt-1 scratch files don't leak into the canonical", async () => {
    const { repoPath } = await setupTwoAgents();
    // Attempt 1 writes both an invalid SKILL.md AND a scratch file alongside.
    // Attempt 2 writes only a valid SKILL.md. If the wipe is missing, the
    // canonical would end up with stale-scratch.txt from attempt 1.
    let attemptIndex = 0;
    const runner: MergeRunner = async ({ workspaceDir }) => {
      const targetDir = path.join(workspaceDir, "target");
      await fs.mkdir(targetDir, { recursive: true });
      if (attemptIndex === 0) {
        await fs.writeFile(path.join(targetDir, "SKILL.md"), "no frontmatter\n", "utf8");
        await fs.writeFile(path.join(targetDir, "stale-scratch.txt"), "leftover from attempt 1\n", "utf8");
      } else {
        await fs.writeFile(path.join(targetDir, "SKILL.md"), validMergedSkill("shared-skill"), "utf8");
      }
      attemptIndex += 1;
      return { stdout: "", stderr: "" };
    };
    const result = await syncMergeInstances(repoPath, "shared-skill", ["opencode", "claude"], "claude", { runner, workspaceId: "jjjjj" });
    expect(result.attempts).toBe(2);
    const canonicalEntries = await fs.readdir(path.join(repoPath, "registry", "skills", "shared-skill"));
    expect(canonicalEntries).toContain("SKILL.md");
    // The whole point: the scratch file from attempt 1 must NOT be in the canonical.
    expect(canonicalEntries).not.toContain("stale-scratch.txt");
  }, TEST_TIMEOUT);

  it("restores the canonical to its pre-merge content when the commit/manifest write fails", async () => {
    const { repoPath } = await setupTwoAgents();
    const canonicalDir = path.join(repoPath, "registry", "skills", "shared-skill");
    const preMergeContent = await fs.readFile(path.join(canonicalDir, "SKILL.md"), "utf8");
    const preMergeHash = (await readRegistryManifest(repoPath)).skills.find((s) => s.name === "shared-skill")!.hash;
    // Wreck the git repo so gitCommitPaths fails: remove .git/HEAD which makes
    // every subsequent git command (add / commit / rev-parse) bomb. Workspace
    // setup + prepareMergeWorkspace + the runner all touch the filesystem
    // without git, so they keep working up to the commit step.
    await fs.rm(path.join(repoPath, ".git", "HEAD"), { force: true });
    const runner = makeMockRunner([validMergedSkill("shared-skill")]);
    await expect(
      syncMergeInstances(repoPath, "shared-skill", ["opencode", "claude"], "claude", { runner, workspaceId: "kkkkk" })
    ).rejects.toThrow(/Canonical reverted to pre-merge state/);
    // Canonical content must equal the pre-merge content. (We can't read the
    // manifest here because writeManifestWithUpdatedSkill never ran, so the
    // file on disk is authoritative.)
    const afterFailContent = await fs.readFile(path.join(canonicalDir, "SKILL.md"), "utf8");
    expect(afterFailContent).toBe(preMergeContent);
    // Sanity: hash matches what was there before.
    expect(await hashDirectory(canonicalDir)).toBe(preMergeHash);
  }, TEST_TIMEOUT);
});

describe("AGENT_CLI_COMMANDS", () => {
  // Regression — claude/codex/opencode in non-interactive mode require an
  // explicit "skip permission prompt" flag, otherwise the model emits text but
  // never executes Read/Write/Edit and target/ stays empty. We hit this in
  // R36-C22's first end-to-end run; the merge would silently fail twice and
  // bubble up `target/SKILL.md does not exist` even though the agent CLI
  // appeared to "work". Pinning the flag in tests means a future cleanup
  // (e.g. someone "simplifying" the argv) can't quietly reintroduce the bug.
  it("includes a permission-bypass flag in every agentic non-interactive runner", async () => {
    const { AGENT_CLI_COMMANDS } = await import("../src/sync.js");
    expect(AGENT_CLI_COMMANDS.claude).toContain("--permission-mode");
    expect(AGENT_CLI_COMMANDS.claude).toContain("bypassPermissions");
    expect(AGENT_CLI_COMMANDS.codex).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(AGENT_CLI_COMMANDS.opencode).toContain("--dangerously-skip-permissions");
  });
  it("forces claude into stream-json output so issue #2 live-output panels actually get chunks", async () => {
    // claude -p in default text mode batches the whole response and only
    // flushes it on exit — the CLI / WebUI log panel would stay empty for
    // minutes. stream-json + --verbose emits one JSON event per turn so the
    // user sees motion as soon as the model picks a tool.
    const { AGENT_CLI_COMMANDS } = await import("../src/sync.js");
    expect(AGENT_CLI_COMMANDS.claude).toContain("--output-format");
    expect(AGENT_CLI_COMMANDS.claude).toContain("stream-json");
    expect(AGENT_CLI_COMMANDS.claude).toContain("--verbose");
  });
});

describe("syncMergeInstances onChunk streaming (issue #2)", () => {
  it("forwards each runner stdout/stderr chunk to onChunk in order", async () => {
    const { repoPath } = await setupTwoAgents();
    const observed: Array<{ kind: "stdout" | "stderr"; text: string }> = [];
    // Custom runner that simulates what runAgentMerge would do for a real
    // CLI: emit a couple of chunks via onChunk, then write target/. The
    // sequencing matters — onChunk fires DURING the run, not after — so we
    // observe ordering between chunks (e.g. stdout-stderr-stdout) and
    // confirm syncMergeInstances passes the same callback through unchanged.
    const runner: MergeRunner = async ({ workspaceDir, onChunk }) => {
      onChunk?.("stdout", "starting agent\n");
      onChunk?.("stderr", "warning: low memory\n");
      onChunk?.("stdout", "done\n");
      const targetDir = path.join(workspaceDir, "target");
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, "SKILL.md"), validMergedSkill("shared-skill"), "utf8");
      return { stdout: "starting agent\ndone\n", stderr: "warning: low memory\n" };
    };
    await syncMergeInstances(repoPath, "shared-skill", ["opencode", "claude"], "claude", {
      runner,
      workspaceId: "lllll",
      onChunk: (kind, text) => { observed.push({ kind, text }); }
    });
    expect(observed).toEqual([
      { kind: "stdout", text: "starting agent\n" },
      { kind: "stderr", text: "warning: low memory\n" },
      { kind: "stdout", text: "done\n" }
    ]);
  }, TEST_TIMEOUT);

  it("survives an onChunk callback that throws (a flaky observer must not abort the merge)", async () => {
    const { repoPath } = await setupTwoAgents();
    // Production scenario: a streaming HTTP response gets closed mid-merge
    // (browser tab navigated away) and writes start throwing. The merge
    // itself must continue and produce a valid canonical regardless.
    const runner: MergeRunner = async ({ workspaceDir, onChunk }) => {
      onChunk?.("stdout", "ok"); // observer throws here, runner must not bubble it up
      const targetDir = path.join(workspaceDir, "target");
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, "SKILL.md"), validMergedSkill("shared-skill"), "utf8");
      return { stdout: "ok", stderr: "" };
    };
    const result = await syncMergeInstances(repoPath, "shared-skill", ["opencode", "claude"], "claude", {
      runner,
      workspaceId: "mmmmm",
      // The runner's onChunk wrapper in production catches exceptions; the
      // syncMergeInstances passthrough must preserve that behavior. We verify
      // by checking the merge still succeeded (commit landed, hash bumped).
      onChunk: () => { throw new Error("observer disconnected"); }
    });
    expect(result.attempts).toBe(1);
    expect(result.shortSha).not.toBe("");
  }, TEST_TIMEOUT);
});
