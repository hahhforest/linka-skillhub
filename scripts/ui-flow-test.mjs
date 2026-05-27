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

await page.getByRole("button", { name: "English", exact: true }).click();
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
// R35-C11: the dropdown is now a custom AgentSelect (button + popover) so the
// logo can render next to each label; selectOption() doesn't work — click the
// trigger, then click the option row.
await page.locator(".overview-agent-filter .agent-select-button").click();
await page.waitForSelector(".agent-select-popover", { state: "visible", timeout: 3000 });
await page.locator(".agent-select-popover .agent-select-option").filter({ hasText: "Mavis" }).first().click();
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
// R35-C11: popover-based AgentSelect — click trigger to open, then click the
// "全部来源" row. Force a state reset with a slight pause so React commits.
await page.locator(".overview-agent-filter .agent-select-button").click({ force: true });
await page.waitForTimeout(150);
await page.locator(".overview-agent-filter .agent-select-popover .agent-select-option").filter({ hasText: "全部来源" }).first().click({ force: true });
await page.waitForTimeout(200);

await page.getByRole("button", { name: /仓库管理/ }).click();
// R34 commit 5: RepoBrowser replaces RepoView. Verify the new meta bar, the
// inline action bar (buttons now visible without scrolling), and that the
// Registry SkillTable renders. Old card-style action layout is gone.
await expectText("导入到 Registry", "import action");
// R35-C12: merged "运行确定性规则审查" + "使用 Code Agent 审查" into one
// "审查" button. The reviewer choice now happens inside the dialog, not at
// the button level.
await expectText("审查", "review skills action");
await expectText("Registry Skills", "registry browser title");
await expectText("切换 Registry", "switch registry button");
await expectText("刷新 Git 状态", "refresh git status button");
await expectText("提交并推送 Registry", "push registry button");
const repoTableRows = await page.locator(".repo-table-card .skill-row").count();
if (repoTableRows === 0) failures.push("RepoBrowser table is empty — Registry skills should be listed");
const legacyActionCards = await page.locator(".action-card").count();
if (legacyActionCards > 0) failures.push(`RepoBrowser should not render legacy .action-card (got ${legacyActionCards})`);
await screenshot("05-repo");

// Import confirm dialog gates the destructive write (was fire-on-click pre-R34).
await page.getByRole("button", { name: /^导入到 Registry$/ }).click();
await expectText("确认导入到 Registry", "import confirm dialog title");
await expectText("目标 Registry", "import confirm target label");
await page.locator(".dialog .ghost", { hasText: "取消" }).click();
let importDialogText = await page.locator("body").innerText();
if (importDialogText.includes("确认导入到 Registry")) failures.push("Import confirm dialog did not close on cancel");

// Switch Registry button opens a modal (LoadRegistryDialog) — old inline
// LoadRegistryPanel is gone.
await page.getByRole("button", { name: /切换 Registry/ }).click();
await expectText("加载已有 Registry", "switch registry dialog opens");
await page.locator(".dialog .dialog-close").click();
let switchDialogText = await page.locator("body").innerText();
if (switchDialogText.includes("加载已有 Registry")) failures.push("Switch Registry dialog did not close on dialog-close");

await page.getByRole("button", { name: /^审查$/ }).click();
await expectText("选择审查方式", "review dialog");
await expectText("规则审查", "reviewer choice");
await expectText("审查范围", "review scope");
await expectText("全部 Registry", "review default scope is the entire registry");
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
// R34 commit 5: LoadRegistryPanel is now LoadRegistryDialog. Open via the
// "切换 Registry" button in the meta bar, then fill+submit inside the modal.
await page.getByRole("button", { name: /切换 Registry/ }).click();
await expectText("加载已有 Registry", "load registry dialog");
await page.locator(".dialog .load-registry-row input").fill("./.sandbox/my-skills-registry");
await page.locator(".dialog .primary", { hasText: "加载" }).click();
await page.waitForFunction(() => document.body.innerText.includes("已切换到 Registry"), undefined, { timeout: 10000 });
await expectText("已切换到 Registry", "load registry success message");
await screenshot("10-load-registry");

// R35-C4: Add Source Directory flow. Verify the modal opens from Overview,
// keeps the submit button disabled while the form is invalid, rejects a path
// that doesn't exist on disk (server-side invalid_path), then submits a real
// path pointing at a throwaway fixture under .sandbox. After submission the
// modal closes, the source-bars chart picks up a new (agent, scope) row for
// "my-custom-agent / 用户", and the footer shows the addSourceSuccess
// message. We clean up afterwards by reading linka-skillhub.config.json,
// deleting the my-custom-agent entry from the mirror profile, and writing
// the file back atomically so subsequent runs start from the same state.
//
// Bootstrap the fixture directory if it's missing — .sandbox/ is gitignored
// so a fresh clone won't have it. Skipping this step would silently fail
// the next assertion.
const fixtureDir = path.join(process.cwd(), ".sandbox/local-mirror/sources/custom-test/example-skill");
await fs.mkdir(fixtureDir, { recursive: true });
await fs.writeFile(
  path.join(fixtureDir, "SKILL.md"),
  "---\nname: example-skill\ndescription: Throwaway fixture for R35-C4 add-source flow.\n---\n# example-skill\n",
  "utf8"
);
await page.getByRole("button", { name: /总览/ }).click();
await page.waitForTimeout(150);
const initiallyPresent = await page.locator(".source-bars .source-bar-row span").filter({ hasText: "my-custom-agent" }).count();
await page.getByRole("button", { name: /添加自定义目录/ }).click();
await expectText("添加自定义来源目录", "add source dialog title");
// Empty path → primary button should be disabled (form-level validation).
const primaryButton = page.locator(".add-source-dialog .primary");
if (await primaryButton.isEnabled()) failures.push("Add Source primary button should stay disabled while path is empty");
// R35-C5 follow-up: the group dropdown now defaults to "新建分组…" so the
// custom-name input is already visible. Just fill the name + path.
await page.locator(".add-source-dialog input[placeholder=\"my-skills\"]").fill("my-custom-agent");
const pathInput = page.locator(".add-source-dialog input[placeholder*=\"sources/shared-agents\"]");
// First try a path that doesn't exist on disk — server should respond with
// invalid_path and the inline error should surface.
await pathInput.fill("./.sandbox/no-such-directory-r35-c4");
await primaryButton.click();
await page.waitForFunction(() => {
  const el = document.querySelector(".add-source-error");
  return el && /路径|path/i.test(el.textContent ?? "");
}, undefined, { timeout: 5000 });
const badPathError = await page.locator(".add-source-error").innerText();
if (!badPathError) failures.push("Add Source dialog should surface a server-side error for a missing path");
// Now fill a real fixture path and submit successfully. Scope stays at the
// default "user" — the advanced disclosure is collapsed by design so we
// don't have to interact with it for the common case.
await pathInput.fill("./.sandbox/local-mirror/sources/custom-test/example-skill");
await screenshot("11-add-source-form");
await primaryButton.click();
// If the agent was already in the server's cached config (e.g. a previous
// flow run left it behind without restarting the server), the duplicate
// guard fires. Either branch is acceptable for this assertion: success
// closes the dialog, duplicate shows the inline error. We accept both and
// move on to verify the source-bars list AFTER the add.
await page.waitForFunction(() => {
  const dialogOpen = document.body.innerText.includes("添加自定义来源目录");
  const errorVisible = document.querySelector(".add-source-error");
  return !dialogOpen || (errorVisible && /已注册|already/i.test(errorVisible.textContent ?? ""));
}, undefined, { timeout: 10000 });
const dialogStillOpen = await page.locator(".add-source-dialog").count();
if (dialogStillOpen > 0) {
  // Duplicate case: close the dialog explicitly so the rest of the flow can continue.
  await page.locator(".add-source-dialog .dialog-close").click();
}
// In the success branch the footer flips to addSourceSuccess; in the duplicate
// branch the footer is unchanged. Verify the new (agent, scope) row exists in
// the source-bars chart regardless, since that's the user-visible outcome
// that matters.
await page.waitForFunction(() => {
  const rows = Array.from(document.querySelectorAll(".source-bars .source-bar-row span"));
  return rows.some((span) => span.textContent && span.textContent.includes("my-custom-agent"));
}, undefined, { timeout: 5000 });
const finallyPresent = await page.locator(".source-bars .source-bar-row span").filter({ hasText: "my-custom-agent" }).count();
if (finallyPresent === 0) {
  failures.push("Add Source should leave at least one my-custom-agent row in source-bars");
}
if (initiallyPresent === 0 && finallyPresent === 0) {
  failures.push("Add Source should add a my-custom-agent row when none existed before");
}
await screenshot("12-add-source-after");

// R35-C5: source-bar click narrows the donut + stat cards to that
// (agent, scope) bucket; clicking the same row again clears the narrow.
// Capture the totalSkills stat before, click the largest bar, verify the
// stat drops AND the bar gets the `.selected` class, then click again and
// verify the stat snaps back.
const totalBefore = Number(await page.locator(".stat-card strong").first().innerText());
const firstBar = page.locator(".source-bars .source-bar-row").first();
const firstBarLabel = (await firstBar.locator("span").first().innerText()).replace(/\s+/g, " ").trim();
await firstBar.click();
await page.waitForTimeout(150);
const totalAfterClick = Number(await page.locator(".stat-card strong").first().innerText());
if (!(totalAfterClick < totalBefore)) {
  failures.push(`Source-bar click should narrow stat cards; before=${totalBefore} after=${totalAfterClick} (clicked "${firstBarLabel}")`);
}
const selectedCount = await page.locator(".source-bars .source-bar-row.selected").count();
if (selectedCount !== 1) {
  failures.push(`Exactly one source-bar should carry .selected after click; got ${selectedCount}`);
}
// R35-C7: the donut-card grows a "selected-source-paths" strip listing the
// configured sourceDir.path entries for the (agent, scope) the user clicked.
const pathBlockVisible = await page.locator(".donut-card .selected-source-paths").count();
if (pathBlockVisible !== 1) {
  failures.push(`Donut card should show the path block after source-bar click; got ${pathBlockVisible}`);
}
const pathItems = await page.locator(".donut-card .source-path-list li code").count();
if (pathItems === 0) {
  failures.push("Path block should list at least one configured path for the selected source");
}
await screenshot("13-source-bar-selected");
// Click again to deselect.
await firstBar.click();
await page.waitForTimeout(150);
const totalAfterDeselect = Number(await page.locator(".stat-card strong").first().innerText());
if (totalAfterDeselect !== totalBefore) {
  failures.push(`Source-bar second click should clear the narrow; before=${totalBefore} after=${totalAfterDeselect}`);
}
const selectedAfter = await page.locator(".source-bars .source-bar-row.selected").count();
if (selectedAfter !== 0) {
  failures.push(`No source-bar should carry .selected after deselect; got ${selectedAfter}`);
}
const pathBlockAfter = await page.locator(".donut-card .selected-source-paths").count();
if (pathBlockAfter !== 0) {
  failures.push(`Path block should disappear after deselect; got ${pathBlockAfter}`);
}

// Cleanup: read linka-skillhub.config.json, drop the my-custom-agent entry,
// write atomically so the next run starts from a clean state. We do this
// after the assertions so a partial run still surfaces the new entry — the
// final cleanup only runs when everything else passed.
const configPath = path.join(process.cwd(), "linka-skillhub.config.json");
const configRaw = await fs.readFile(configPath, "utf8");
const config = JSON.parse(configRaw);
if (config?.profiles?.mirror?.agents && Object.prototype.hasOwnProperty.call(config.profiles.mirror.agents, "my-custom-agent")) {
  delete config.profiles.mirror.agents["my-custom-agent"];
  const tmp = `${configPath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.rename(tmp, configPath);
}

await browser.close();
await fs.writeFile(path.join(outDir, "result.json"), JSON.stringify({ failures }, null, 2), "utf8");
if (failures.length > 0) {
  console.error(JSON.stringify({ outDir, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, outDir }, null, 2));
