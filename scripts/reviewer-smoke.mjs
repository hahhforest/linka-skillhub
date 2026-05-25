#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const cwd = process.cwd();
const cli = path.join(cwd, "packages/cli/dist/index.js");
const args = process.argv.slice(2);
if (!args.includes("--yes")) {
  process.stderr.write(
    "reviewer-smoke is opt-in. Re-run as `pnpm review:smoke` or with --yes.\n" +
      "This script invokes 4 external Code Agent CLIs (codex/opencode/claude/mavis); each call may take seconds.\n"
  );
  process.exit(1);
}

const reviewers = ["rules", "codex", "opencode", "claude", "mavis"];
const skills = ["a59223a028c278c1", "76a9425a59f90d35"];
const results = [];

const runOne = (reviewer, skillId) => {
  const start = Date.now();
  const res = spawnSync(
    "node",
    [cli, "review", "--reviewer", reviewer, "--skill", skillId],
    { cwd, encoding: "utf8", timeout: 60_000 }
  );
  const elapsedMs = Date.now() - start;
  if (res.status !== 0) {
    return { reviewer, skillId, status: "fail", elapsedMs, exitCode: res.status, stderr: res.stderr?.slice(0, 400) ?? "" };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    return { reviewer, skillId, status: "fail", elapsedMs, reason: "stdout not JSON", stdout: res.stdout?.slice(0, 200) ?? "" };
  }
  const review = parsed.reviews?.[0];
  if (!review || !Array.isArray(review.statuses) || typeof review.summary !== "string") {
    return { reviewer, skillId, status: "fail", elapsedMs, reason: "review shape invalid" };
  }
  return { reviewer, skillId, status: "ok", elapsedMs, recommendation: review.recommendation };
};

for (const reviewer of reviewers) {
  const skillId = skills[0];
  const result = runOne(reviewer, skillId);
  results.push(result);
}

const okExternal = results.filter((r) => r.status === "ok" && r.reviewer !== "rules").length;
const rulesOk = results.find((r) => r.reviewer === "rules")?.status === "ok";

const outDir = path.join(cwd, ".sandbox", "reviewer-smoke", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "results.json"), JSON.stringify({ results, summary: { rulesOk, okExternal } }, null, 2), "utf8");

process.stdout.write(JSON.stringify({ outDir, results, rulesOk, okExternal }, null, 2) + "\n");

if (!rulesOk) {
  process.stderr.write("rules reviewer must succeed.\n");
  process.exit(2);
}
if (okExternal === 0) {
  process.stderr.write("Degraded: no external reviewer succeeded; rules only.\n");
  process.exit(0);
}
process.exit(0);
