#!/usr/bin/env node
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.LINKA_SKILLHUB_URL ?? "http://127.0.0.1:4873";
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outDir = path.join(process.cwd(), ".sandbox", "ui-flow", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--disable-extensions", "--no-first-run", "--no-default-browser-check"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const failures = [];
const expectText = async (text, label = text) => {
  const body = await page.locator("body").innerText();
  if (!body.includes(text)) failures.push(`Missing ${label}: ${text}`);
};
const screenshot = async (name) => page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });

await page.goto(baseUrl, { waitUntil: "networkidle" });
await screenshot("01-initial");
await expectText("测试镜像", "Chinese profile label");
await expectText("扫描 skills", "scan button");

await page.getByRole("button", { name: /English/ }).click();
await expectText("Skill Manager", "English app title");
await expectText("Scan skills", "English scan button");
await screenshot("02-english");
await page.getByRole("button", { name: "中文", exact: true }).click();
await expectText("Skill 管理工具", "Chinese app title after switch back");

await page.getByRole("button", { name: /扫描 skills/ }).click();
await expectText("确认扫描来源", "scan confirmation dialog");
await screenshot("03-scan-dialog");
await page.getByRole("button", { name: /取消/ }).click();
let body = await page.locator("body").innerText();
if (body.includes("确认扫描来源")) failures.push("Scan dialog did not close after cancel");

const allTotal = await page.locator(".stat-card strong").first().innerText();
await page.locator(".agent-filter").filter({ hasText: "Mavis" }).click();
await screenshot("04-mavis-filter");
const mavisTotal = await page.locator(".stat-card strong").first().innerText();
if (Number(mavisTotal) >= Number(allTotal)) failures.push(`Agent filter did not reduce total: all=${allTotal}, mavis=${mavisTotal}`);
await expectText("当前范围: Mavis", "Mavis scope label");

await page.getByRole("button", { name: /仓库管理/ }).click();
await expectText("导入到 Registry", "import action");
await expectText("运行确定性规则审查", "rule review action");
await expectText("不调用 LLM", "rule review explanation");
await expectText("Git 状态", "git status panel");
await expectText("刷新 Git 状态", "refresh git status button");
await expectText("提交并推送 Registry", "push registry button");
await screenshot("05-repo");

await page.getByRole("button", { name: /运行确定性规则审查/ }).click();
await expectText("选择审查方式", "review dialog");
await expectText("规则审查", "reviewer choice");
await expectText("审查范围", "review scope");
await expectText("输出语言", "review output language");
await expectText("写入位置", "review write target");
await expectText("Codex", "codex reviewer option");
await screenshot("06-review-dialog");
await page.getByRole("button", { name: /取消/ }).click();

await page.getByRole("button", { name: /交汇中心/ }).click();
await expectText("来源路径", "intersection source path");
await expectText("目标路径", "intersection target path");
await expectText("预览交汇复制", "intersection preview button");
await page.locator(".lane-card").first().locator(".skill-row").first().click();
await page.getByRole("button", { name: /预览交汇复制/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("复制预览"), undefined, { timeout: 30000 });
await expectText("复制预览", "intersection copy preview");
await screenshot("07-intersection-preview");

await page.getByRole("button", { name: /分发管理/ }).click();
await expectText("预览复制结果", "distribution preview button");
await expectText("确认复制到选中的目标 Agent", "distribution apply button text");
await screenshot("08-distribution-copy");

// New: confirm-plan modal flow + load registry
await page.getByRole("button", { name: /^全部来源$/ }).click();
await page.getByRole("button", { name: /总览/ }).click();
await page.waitForTimeout(200);
const overviewRows = await page.locator(".skill-row").count();
if (overviewRows === 0) failures.push("Overview shows no skill rows after clearing filter");
// Ensure we end up with at least one selection by toggling row 0 + row 1 if needed.
const ensureSelected = async () => {
  const counter = await page.locator(".status-footer").innerText();
  const match = counter.match(/(\d+)\s*已选择/);
  if (match && Number(match[1]) > 0) return;
  await page.locator(".skill-row").nth(1).click();
};
await ensureSelected();
await page.getByRole("button", { name: /分发管理/ }).click();
await page.waitForTimeout(200);
await page.getByRole("button", { name: /预览复制结果/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("复制预览"), undefined, { timeout: 10000 });
await page.getByRole("button", { name: /^确认复制到选中的目标 Agent$/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("Plan Token"), undefined, { timeout: 10000 });
await expectText("Plan Token", "confirm modal plan token");
await expectText("条目合计", "confirm modal total label");
await screenshot("09-confirm-plan-modal");
await page.locator(".confirm-plan-dialog .dialog-actions button.ghost").click();
let modalText = await page.locator("body").innerText();
if (modalText.includes("Plan Token")) failures.push("Confirm modal did not close on cancel");

await page.getByRole("button", { name: /仓库管理/ }).click();
await expectText("加载已有 Registry", "load registry panel");
await page.locator(".load-registry-row input").fill("./.sandbox/my-skills-registry");
await page.getByRole("button", { name: /^加载$/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("已切换到 Registry"), undefined, { timeout: 10000 });
await expectText("已切换到 Registry", "load registry success message");
await screenshot("10-load-registry");

await browser.close();
await fs.writeFile(path.join(outDir, "result.json"), JSON.stringify({ failures }, null, 2), "utf8");
if (failures.length > 0) {
  console.error(JSON.stringify({ outDir, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, outDir }, null, 2));
