import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir, pathExists } from "./fs-helpers.js";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

const run = (bin: string, args: readonly string[], options: { readonly cwd?: string; readonly input?: string } = {}): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(stderr.trim() || `${bin} ${args.join(" ")} exited with ${code ?? "unknown"}`));
    });
    child.stdin.end(options.input ?? "");
  });

export const ensureGitRepository = async (repoPath: string): Promise<void> => {
  await ensureDir(repoPath);
  if (!(await pathExists(path.join(repoPath, ".git")))) await run("git", ["init"], { cwd: repoPath });
};

export const gitStatus = async (repoPath: string): Promise<string> => (await run("git", ["status", "--short", "--branch"], { cwd: repoPath })).stdout;

export const gitCommitAll = async (repoPath: string, message = "Update skill registry"): Promise<string> => {
  await ensureGitRepository(repoPath);
  await run("git", ["add", "registry", "skills", "prompts"], { cwd: repoPath });
  const status = (await run("git", ["status", "--porcelain"], { cwd: repoPath })).stdout;
  if (!status) return "No changes to commit.";
  await run("git", ["commit", "-m", message], { cwd: repoPath });
  return (await run("git", ["rev-parse", "--short", "HEAD"], { cwd: repoPath })).stdout;
};

export const gitPull = async (repoPath: string): Promise<string> => (await run("git", ["pull", "--ff-only"], { cwd: repoPath })).stdout;

export const gitPush = async (repoPath: string): Promise<string> => (await run("git", ["push"], { cwd: repoPath })).stdout;

export const setRemote = async (repoPath: string, url: string, name = "origin"): Promise<void> => {
  await ensureGitRepository(repoPath);
  const remotes = (await run("git", ["remote"], { cwd: repoPath })).stdout.split("\n").filter(Boolean);
  if (remotes.includes(name)) await run("git", ["remote", "set-url", name, url], { cwd: repoPath });
  else await run("git", ["remote", "add", name, url], { cwd: repoPath });
};
