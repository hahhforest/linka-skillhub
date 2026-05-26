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
await page.locator(".dialog .ghost", { hasText: "取消" }).click();
let body = await page.locator("body").innerText();
if (body.includes("确认扫描来源")) failures.push("Scan dialog did not close after cancel");

const allTotal = await page.locator(".stat-card strong").first().innerText();
// R34 commit 2: agent filtering is now an Overview header dropdown, not a
// clickable sidebar legend. Pick Mavis from the select and confirm the table
// + cards narrow accordingly.
await page.locator(".overview-agent-filter select").selectOption("mavis");
await page.waitForTimeout(200);
await screenshot("04-mavis-filter");
const mavisTotal = await page.locator(".stat-card strong").first().innerText();
if (Number(mavisTotal) >= Number(allTotal)) failures.push(`Agent filter did not reduce total: all=${allTotal}, mavis=${mavisTotal}`);
await expectText("当前范围: Mavis", "Mavis scope label");
// Sidebar legend should now be pure-display chips (no clickable agent-filter
// buttons). If the old class survives, the dual-filter regression is back.
const legacyAgentFilters = await page.locator(".sidebar .agent-filter").count();
if (legacyAgentFilters > 0) failures.push(`Sidebar still renders ${legacyAgentFilters} agent-filter buttons`);
// Reset for the rest of the flow so subsequent assertions see the full set.
await page.locator(".overview-agent-filter select").selectOption("all");
await page.waitForTimeout(150);

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
await page.locator(".dialog .ghost", { hasText: "取消" }).click();

await page.getByRole("button", { name: /交汇中心/ }).click();
await expectText("来源路径", "intersection source path");
await expectText("目标路径", "intersection target path");
await expectText("预览交汇复制", "intersection preview button");
// R34 commit 3: Intersect's old left/right dual-lane layout collapsed into a
// single SkillTable + sticky DetailPanel + bottom action bar. Row click only
// focuses (DetailPanel mirrors). To queue a row for the copy plan we click
// the checkbox on the row.
const intersectFirstRow = page.locator(".intersect-table-card .skill-row").first();
await intersectFirstRow.click();
await page.locator(".intersect-detail-panel .detail-inline").waitFor({ state: "visible", timeout: 5000 });
await intersectFirstRow.locator(".skill-row-check").click();
await page.getByRole("button", { name: /预览交汇复制/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("复制预览"), undefined, { timeout: 30000 });
await expectText("复制预览", "intersection copy preview");
// The right "目标现有" lane is gone after R34 C3 — guard against regressions.
const targetExistingLane = await page.locator("text=目标现有").count();
if (targetExistingLane > 0) failures.push("Intersect right lane '目标现有' should be removed");
await screenshot("07-intersection-preview");

await page.getByRole("button", { name: /分发管理/ }).click();
await expectText("预览复制结果", "distribution preview button");
await expectText("确认复制到选中的目标 Agent", "distribution apply button text");
// R34 commit 4: Distribute is now self-contained. The Registry skills table
// lives inside the page (not borrowed from Overview's selection) and the
// multi-target picker sits above it. Sanity-check both pieces are present
// and that the action bar starts in an "empty selection" state.
await expectText("Registry Skills", "distribute table title");
await expectText("目标 Agent", "distribute target picker heading");
const distributeRowCount = await page.locator(".distribute-table-card .skill-row").count();
if (distributeRowCount === 0) failures.push("Distribute table is empty — Registry should expose skills");
await screenshot("08-distribution-copy");

// New: confirm-plan modal flow + load registry
await page.getByRole("button", { name: /总览/ }).click();
await page.waitForTimeout(200);
const overviewRows = await page.locator(".skill-row").count();
if (overviewRows === 0) failures.push("Overview shows no skill rows after clearing filter");
// R34 commit 1: Overview is single-focus. Clicking a row should focus it and
// reveal the inline detail panel — no per-row checkbox, no footer counter.
await page.locator(".skill-row").first().click();
await page.locator(".overview-detail-panel .detail-inline").waitFor({ state: "visible", timeout: 5000 });
const overviewFocusedName = await page.locator(".overview-detail-panel .detail-head h2").innerText();
// R34 commit 4: Distribute supplies its own selectedForDistribute set; the
// user clicks the row to focus (DetailPanel mirrors) and the checkbox to
// queue. Preview button stays disabled until both a target is chosen and at
// least one skill is checked.
await page.getByRole("button", { name: /分发管理/ }).click();
await page.waitForTimeout(200);
// Focus should follow the user across pages (App owns focusedSkillId now).
const distributeFocusedName = await page.locator(".distribute-detail-panel .detail-head h2").innerText();
if (distributeFocusedName !== overviewFocusedName) {
  failures.push(`Focused skill did not survive page switch: overview=${overviewFocusedName}, distribute=${distributeFocusedName}`);
}
const previewButton = page.getByRole("button", { name: /预览复制结果/ });
if (await previewButton.isEnabled()) failures.push("Distribute preview should be disabled before any skill is queued");
// Queue the first row's checkbox so the action bar's selection counter > 0.
await page.locator(".distribute-table-card .skill-row").first().locator(".skill-row-check").click();
await previewButton.click();
await page.waitForFunction(() => document.body.innerText.includes("复制预览"), undefined, { timeout: 10000 });
const planItemCount = await page.locator(".distribute-action-bar .plan-item").count();
if (planItemCount === 0) failures.push("Distribute action bar did not render any plan items after preview");
await page.getByRole("button", { name: /^确认复制到选中的目标 Agent$/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("Plan Token"), undefined, { timeout: 10000 });
await expectText("Plan Token", "confirm modal plan token");
await expectText("条目合计", "confirm modal total label");
await screenshot("09-confirm-plan-modal");
await page.locator(".confirm-plan-dialog .dialog-actions button.ghost").click();
let modalText = await page.locator("body").innerText();
if (modalText.includes("Plan Token")) failures.push("Confirm modal did not close on cancel");
// Switching away from Distribute and back must reset selectedForDistribute
// (per-page operational selection). focusedSkillId is a separate concern and
// is asserted above to survive page switches.
await page.getByRole("button", { name: /总览/ }).click();
await page.waitForTimeout(150);
await page.getByRole("button", { name: /分发管理/ }).click();
await page.waitForTimeout(150);
const refreshedCounter = await page.locator(".distribute-action-bar .action-bar-counter strong").innerText();
if (refreshedCounter.trim() !== "0") failures.push(`Distribute selection should reset on re-entry, got counter=${refreshedCounter}`);

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
