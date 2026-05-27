#!/usr/bin/env node
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.LINKA_SKILLHUB_URL ?? "http://127.0.0.1:4873";
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outDir = path.join(process.cwd(), ".sandbox", "ui-audit", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check"
  ]
});
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const issues = [];
const consoleMessages = [];

page.on("console", (msg) => {
  consoleMessages.push({ type: msg.type(), text: msg.text() });
  if (msg.type() === "error") issues.push({ severity: "high", area: "console", text: msg.text() });
});
page.on("pageerror", (error) => issues.push({ severity: "high", area: "pageerror", text: error.message }));

const shot = async (name) => {
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
};

const visibleText = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();

const auditNoMarketingCopy = async (name) => {
  const text = await visibleText();
  for (const phrase of ["统一管理", "版本可追溯", "智能校验", "自由分发", "汇总 · 分发 · 交汇 · 版本追溯"]) {
    if (text.includes(phrase)) issues.push({ severity: "medium", area: name, text: `存在无操作价值的宣传文案：${phrase}` });
  }
};

const auditViewport = async (name) => {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    topText: document.elementFromPoint(20, 20)?.textContent?.slice(0, 120) ?? ""
  }));
  if (metrics.scrollWidth > metrics.clientWidth + 2) issues.push({ severity: "high", area: name, text: `水平溢出 ${metrics.scrollWidth}/${metrics.clientWidth}` });
  if (!metrics.topText.includes("Skill") && !metrics.topText.includes("技能") && !metrics.topText.includes("SkillHub")) {
    issues.push({ severity: "high", area: name, text: `首屏顶部不像应用界面，topText=${metrics.topText}` });
  }
};

await page.goto(baseUrl, { waitUntil: "networkidle" });
await shot("01-overview");
await auditViewport("overview");
await auditNoMarketingCopy("overview");

const overviewText = await visibleText();
if (overviewText.includes("Profile: mirror") || overviewText.includes("profile mirror")) issues.push({ severity: "medium", area: "overview", text: "profile 以英文技术名展示，用户不懂 mirror 是什么" });
if (!overviewText.includes("focused") && !overviewText.includes("已查看")) issues.push({ severity: "low", area: "overview", text: "未显示已查看 (focus) 状态" });

const navButtons = ["交汇中心", "分发管理", "仓库管理"];
for (const label of navButtons) {
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await page.waitForTimeout(350);
  await shot(`page-${label}`);
  await auditViewport(label);
  await auditNoMarketingCopy(label);
}

await page.getByRole("button", { name: /仓库管理/ }).click();
const repoText = await visibleText();
for (const unclear of ["汇总到仓库", "Ready"]) {
  if (repoText.includes(unclear)) issues.push({ severity: "high", area: "repo", text: `仓库管理存在不清楚文案：${unclear}` });
}
// R34 commit 5: RepoBrowser collapsed the four-card layout into an inline
// action bar; the "不调用 LLM" line lived on a now-removed action card. The
// per-action description still surfaces via button title (tooltip), so we
// only require the action labels themselves to be present.
for (const required of ["导入到 Registry", "审查", "Registry Skills", "切换 Registry"]) {
  if (!repoText.includes(required)) issues.push({ severity: "high", area: "repo", text: `仓库管理缺少必要解释：${required}` });
}

await page.getByRole("button", { name: /总览/ }).click();
await page.getByPlaceholder("搜索 skills...").fill("lark");
await page.waitForTimeout(300);
await shot("02-search-lark");
const searchText = await visibleText();
if (!searchText.includes("lark")) issues.push({ severity: "medium", area: "search", text: "搜索后没有明显反馈当前筛选条件" });

await page.getByRole("button", { name: /交汇中心/ }).click();
const intersectText = await visibleText();
for (const required of ["来源路径", "目标路径", "预览交汇复制"]) {
  if (!intersectText.includes(required)) issues.push({ severity: "high", area: "intersect", text: `交汇中心缺少必要元素：${required}` });
}

await page.getByRole("button", { name: /分发管理/ }).click();
const distributeText = await visibleText();
for (const unclear of ["生成分发计划", "执行分发"]) {
  if (distributeText.includes(unclear)) issues.push({ severity: "high", area: "distribution", text: `分发管理存在不清楚文案：${unclear}` });
}
for (const required of ["预览复制结果", "确认复制到选中的目标 Agent"]) {
  if (!distributeText.includes(required)) issues.push({ severity: "high", area: "distribution", text: `分发管理缺少必要文案：${required}` });
}

await page.getByRole("button", { name: /仓库管理/ }).click();
const repoFinalText = await visibleText();
// R34 commit 5: git-card got renamed into a meta-bar branch chip + a compact
// repo-git-status pre that only renders after a manual refresh. So instead of
// asserting "Git 状态" is always on screen, we assert the Registry sync verbs
// (which are always-visible buttons in the action bar).
for (const required of ["刷新 Git 状态", "提交并推送 Registry", "从 GitHub 拉取 Registry"]) {
  if (!repoFinalText.includes(required)) issues.push({ severity: "high", area: "repo-git", text: `Registry/GitHub 区域缺少必要元素：${required}` });
}

await fs.writeFile(path.join(outDir, "audit.json"), JSON.stringify({ baseUrl, outDir, issues, consoleMessages }, null, 2), "utf8");
await browser.close();
console.log(JSON.stringify({ outDir, issues }, null, 2));
