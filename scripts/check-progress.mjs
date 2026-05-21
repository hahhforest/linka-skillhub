#!/usr/bin/env node
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

const now = new Date().toISOString();
let status = "unknown";
let log = "";
try {
  status = execFileSync("git", ["status", "--short", "--branch"], { encoding: "utf8" }).trim();
  log = execFileSync("git", ["log", "--oneline", "-3"], { encoding: "utf8" }).trim();
} catch (error) {
  status = error instanceof Error ? error.message : String(error);
}
const entry = `\n## ${now}\n\n- 当前 phase：查看 docs/north-star-plan.md 的当前 commit phase。\n- Git 状态：\n\n\`\`\`\n${status}\n\`\`\`\n\n- 最近 commit：\n\n\`\`\`\n${log}\n\`\`\`\n\n- 下一步：若工作区干净则推进下一 phase；若不干净则先完成当前 phase 的测试和提交。\n`;
await fs.appendFile(".agents/team-work/nightly-progress.md", entry, "utf8");
console.log("progress checkpoint written");
