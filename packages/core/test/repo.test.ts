import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ensureGitRepository, gitCommitAll, gitPush, setRemote } from "../src/index.js";

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
};

describe("registry git helpers", () => {
  it("sets upstream on the first push to a newly bound remote", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "linka-skillhub-repo-"));
    const repoPath = path.join(cwd, "registry-repo");
    const remotePath = path.join(cwd, "remote.git");
    await fs.mkdir(path.join(repoPath, "registry"), { recursive: true });
    await fs.mkdir(path.join(repoPath, "prompts"), { recursive: true });
    await fs.writeFile(path.join(repoPath, "registry", "skills.json"), '{"version":2,"generatedAt":"2026-01-01T00:00:00.000Z","skills":[]}\n', "utf8");
    await fs.writeFile(path.join(repoPath, "prompts", ".gitkeep"), "", "utf8");
    await ensureGitRepository(repoPath);
    git(repoPath, ["config", "user.name", "linka-test"]);
    git(repoPath, ["config", "user.email", "linka-test@example.com"]);
    await gitCommitAll(repoPath, "seed registry");
    git(cwd, ["init", "--bare", remotePath]);
    await setRemote(repoPath, remotePath);

    await gitPush(repoPath);

    expect(git(repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).toBe("origin/main");
    expect(git(remotePath, ["show-ref", "--verify", "refs/heads/main"])).toContain("refs/heads/main");
  });
});
