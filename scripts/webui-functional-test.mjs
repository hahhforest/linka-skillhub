#!/usr/bin/env node
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const headless = process.env.LINKA_SKILLHUB_HEADLESS !== "0";
const reuseServer = process.env.LINKA_SKILLHUB_REUSE_SERVER === "1";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const sandboxRoot = path.join(root, ".sandbox", "webui-functional-test", runId);
const outDir = path.join(sandboxRoot, "artifacts");
const configPath = path.join(sandboxRoot, "linka-skillhub.config.json");
const registryRepo = path.join(sandboxRoot, "registry-main");
const externalRegistryRepo = path.join(sandboxRoot, "registry-external");
const bareRemote = path.join(sandboxRoot, "remote.git");
const sourcesRoot = path.join(sandboxRoot, "sources");
const targetsRoot = path.join(sandboxRoot, "targets");
const stateDir = path.join(sandboxRoot, "state");
const failures = [];
const stepResults = [];
const screenshots = [];
let browser;
let serverProcess;
let serverProcessGroup;
let page;
let baseUrl = reuseServer ? process.env.LINKA_SKILLHUB_URL : undefined;

const rel = (p) => path.relative(root, p) || ".";
const log = (message) => process.stdout.write(`[webui-functional] ${message}\n`);
const exists = async (p) => fs.access(p).then(() => true, () => false);
const json = async (p) => JSON.parse(await fs.readFile(p, "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (bin, args, options = {}) => {
  const result = spawnSync(bin, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    input: options.input,
    stdio: options.stdio ?? "pipe"
  });
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim());
  }
  return result.stdout?.trim() ?? "";
};
const fetchJson = async (urlPath, options = {}) => {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) }
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${urlPath} failed ${response.status}: ${JSON.stringify(parsed)}`);
  return parsed;
};
const writeSkill = async (dir, name, description, body, extraFiles = {}) => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\n${body}\n`, "utf8");
  for (const [file, content] of Object.entries(extraFiles)) {
    const filePath = path.join(dir, file);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
};
const replaceInSkill = async (dir, from, to) => {
  const file = path.join(dir, "SKILL.md");
  const raw = await fs.readFile(file, "utf8");
  await fs.writeFile(file, raw.replace(from, to), "utf8");
};
const screenshot = async (name) => {
  const target = path.join(outDir, `${String(screenshots.length + 1).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: target, fullPage: true });
  screenshots.push(target);
};
const bodyText = async () => page.locator("body").innerText();
const expectBody = async (text, label = text) => {
  const body = await bodyText();
  if (!body.includes(text)) throw new Error(`Missing ${label}: ${text}`);
};
const expectFileIncludes = async (file, text, label = rel(file)) => {
  const raw = await fs.readFile(file, "utf8");
  if (!raw.includes(text)) throw new Error(`${label} did not include ${text}`);
};
const waitForFileIncludes = async (file, text, label = rel(file), timeoutMs = 10000) => {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      await expectFileIncludes(file, text, label);
      return;
    } catch (error) {
      lastError = error;
      await sleep(150);
    }
  }
  throw lastError ?? new Error(`${label} did not include ${text}`);
};
const waitForText = async (text, timeout = 15000) => {
  await page.waitForFunction((needle) => document.body.innerText.includes(needle), text, { timeout });
};
const waitForNoText = async (text, timeout = 15000) => {
  await page.waitForFunction((needle) => !document.body.innerText.includes(needle), text, { timeout });
};
const selectedCountText = async (selector) => (await page.locator(selector).innerText()).replace(/\s+/g, " ").trim();
const step = async (name, fn) => {
  const started = Date.now();
  log(`START ${name}`);
  try {
    await fn();
    const durationMs = Date.now() - started;
    stepResults.push({ name, ok: true, durationMs });
    log(`PASS  ${name} (${durationMs}ms)`);
  } catch (error) {
    const durationMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    stepResults.push({ name, ok: false, durationMs, message });
    failures.push(`${name}: ${message}`);
    log(`FAIL  ${name}: ${message}`);
    try { if (page) await screenshot(`failure-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`); } catch {}
    throw error;
  }
};

const getFreePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => resolve(port));
  });
});

const waitForHttp = async (url, timeoutMs = 45000) => {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
};

const stopServerProcess = async () => {
  if (!serverProcess) return;
  const child = serverProcess;
  const group = serverProcessGroup;
  serverProcess = undefined;
  serverProcessGroup = undefined;
  const waitForClose = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(undefined);
      return;
    }
    child.once("close", () => resolve(undefined));
  });
  try {
    if (group) process.kill(-group, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // Process may already be gone.
  }
  const stopped = await Promise.race([waitForClose.then(() => true), sleep(1500).then(() => false)]);
  if (stopped) return;
  try {
    if (group) process.kill(-group, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // Process may already be gone.
  }
  await Promise.race([waitForClose, sleep(500)]);
};

const prepareFixtures = async () => {
  await fs.rm(sandboxRoot, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const skillDirs = {
    sharedMavis: path.join(sourcesRoot, "mavis", "shared-alpha"),
    sharedClaude: path.join(sourcesRoot, "claude", "shared-alpha"),
    syncMavis: path.join(sourcesRoot, "mavis", "sync-target"),
    syncClaude: path.join(sourcesRoot, "claude", "sync-target"),
    syncCodex: path.join(sourcesRoot, "codex", "sync-target"),
    distributeOnly: path.join(sourcesRoot, "mavis", "distribute-only"),
    codexHelper: path.join(sourcesRoot, "codex", "codex-helper"),
    claudeOnly: path.join(sourcesRoot, "claude", "claude-only"),
    customSourceRoot: path.join(sandboxRoot, "custom-source", "custom-added")
  };
  await writeSkill(skillDirs.sharedMavis, "shared-alpha", "Shared Alpha from Mavis.", "Mavis original body for shared-alpha.");
  await writeSkill(skillDirs.sharedClaude, "shared-alpha", "Shared Alpha from Claude.", "Claude original body for shared-alpha.");
  await writeSkill(skillDirs.syncMavis, "sync-target", "Sync target from Mavis.", "Canonical seed version.\nmarker: seed");
  await writeSkill(skillDirs.syncClaude, "sync-target", "Sync target from Claude.", "Canonical seed version.\nmarker: seed");
  await writeSkill(skillDirs.syncCodex, "sync-target", "Sync target from Codex.", "Canonical seed version.\nmarker: seed");
  await writeSkill(skillDirs.distributeOnly, "distribute-only", "Skill used to test distribution.", "Distribution body from registry.");
  await writeSkill(skillDirs.codexHelper, "codex-helper", "Codex helper fixture.", "Codex helper body.");
  await writeSkill(skillDirs.claudeOnly, "claude-only", "Claude only fixture.", "Claude only body.");
  await writeSkill(skillDirs.customSourceRoot, "custom-added", "Custom source fixture.", "Added through WebUI custom source flow.");
  for (const agent of ["mavis", "claude", "codex"]) {
    await fs.mkdir(path.join(targetsRoot, agent), { recursive: true });
  }
  const config = {
    version: 1,
    activeProfile: "functional",
    profiles: {
      functional: {
        stateDir,
        registryRepo,
        agents: {
          mavis: {
            targetDir: path.join(targetsRoot, "mavis"),
            sourceDirs: [{ path: path.join(sourcesRoot, "mavis"), scope: "user", defaultSelected: true }]
          },
          claude: {
            targetDir: path.join(targetsRoot, "claude"),
            sourceDirs: [{ path: path.join(sourcesRoot, "claude"), scope: "user", defaultSelected: true }]
          },
          codex: {
            targetDir: path.join(targetsRoot, "codex"),
            sourceDirs: [{ path: path.join(sourcesRoot, "codex"), scope: "user", defaultSelected: true }]
          },
          opencode: { enabled: false },
          cursor: { enabled: false },
          openclaw: { enabled: false },
          hermes: { enabled: false },
          shared: { enabled: false }
        }
      }
    }
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  run("pnpm", ["--filter", "@linka-skillhub/cli", "start", "--", "--config", configPath, "registry", "import", "--create", "--yes"], { env: { LINKA_SKILLHUB_FORCE_YES: "1" } });
  await fs.mkdir(externalRegistryRepo, { recursive: true });
  run("pnpm", ["--filter", "@linka-skillhub/cli", "start", "--", "--config", configPath, "registry", "import", "--repo", externalRegistryRepo, "--create", "--yes"], { env: { LINKA_SKILLHUB_FORCE_YES: "1" } });
  run("git", ["init", "--bare", bareRemote], { cwd: sandboxRoot });
  return skillDirs;
};

const startServerIfNeeded = async () => {
  if (baseUrl) {
    await waitForHttp(baseUrl);
    log(`Using existing WebUI at ${baseUrl}`);
    return;
  }
  const port = Number(process.env.LINKA_SKILLHUB_PORT ?? await getFreePort());
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn("pnpm", ["--filter", "@linka-skillhub/cli", "start", "--", "--config", configPath, "serve", "--port", String(port), "--host", "127.0.0.1"], {
    cwd: root,
    env: { ...process.env, LINKA_SKILLHUB_CONFIG: configPath },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverProcessGroup = serverProcess.pid;
  let stdout = "";
  let stderr = "";
  serverProcess.stdout.setEncoding("utf8");
  serverProcess.stderr.setEncoding("utf8");
  serverProcess.stdout.on("data", (chunk) => { stdout += chunk; });
  serverProcess.stderr.on("data", (chunk) => { stderr += chunk; });
  serverProcess.on("exit", (code) => {
    if (code !== null && code !== 0 && failures.length === 0) {
      failures.push(`server exited early with ${code}: ${stderr || stdout}`);
    }
  });
  await waitForHttp(baseUrl);
  await fs.writeFile(path.join(outDir, "server.log"), `${stdout}\n--- stderr ---\n${stderr}`, "utf8");
  log(`Started isolated WebUI at ${baseUrl}`);
};

const loadRegistryThroughUi = async (repoPath) => {
  await page.getByRole("button", { name: /仓库管理|Repository/ }).click();
  await page.getByRole("button", { name: /切换 Registry|Switch Registry/ }).click();
  await waitForText("加载已有 Registry");
  await page.locator(".dialog .load-registry-row input").fill(repoPath);
  await page.locator(".dialog .primary").click();
  await page.waitForFunction((p) => document.body.innerText.includes(p), repoPath, { timeout: 15000 });
  await waitForNoText("加载已有 Registry");
};

const focusRepoSkill = async (name) => {
  await page.getByRole("button", { name: /仓库管理|Repository/ }).click();
  const row = page.locator(".repo-table-card .skill-row", { hasText: name }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await page.waitForTimeout(150);
  if (await page.locator(".repo-detail-panel .detail-empty").count()) {
    await row.click();
  }
  await page.locator(".repo-detail-panel .detail-inline").waitFor({ state: "visible", timeout: 10000 });
  await page.locator(".repo-detail-panel .detail-head h2", { hasText: name }).waitFor({ state: "visible", timeout: 10000 });
  return row;
};

const selectFirstTargetOnly = async (targetName) => {
  const targets = page.locator(".target-grid .target");
  const count = await targets.count();
  for (let i = 0; i < count; i += 1) {
    const target = targets.nth(i);
    const text = await target.innerText();
    const selected = (await target.getAttribute("class"))?.includes("selected");
    const isWanted = new RegExp(targetName, "i").test(text);
    if (selected !== isWanted) await target.click();
  }
};

const apiSkills = async () => (await fetchJson("/api/skills")).skills;
const apiSync = async (name) => (await fetchJson(`/api/skills/${encodeURIComponent(name)}/sync`)).status;

try {
  await step("prepare disposable fixtures", async () => {
    await prepareFixtures();
    const manifest = await json(path.join(registryRepo, "registry", "skills.json"));
    if (manifest.skills.length < 5) throw new Error(`Expected at least 5 registry skills, got ${manifest.skills.length}`);
  });

  await step("build web bundle", async () => {
    run("pnpm", ["--filter", "@linka-skillhub/web", "build"], { stdio: "pipe" });
  });

  await step("start WebUI", async () => {
    await startServerIfNeeded();
  });

  await step("launch browser", async () => {
    browser = await chromium.launch({ executablePath: chromePath, headless, args: ["--disable-extensions", "--no-first-run", "--no-default-browser-check"] });
    page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    page.on("console", (msg) => {
      if (msg.type() === "error") failures.push(`browser console error: ${msg.text()}`);
    });
    page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await screenshot("initial");
  });

  await step("language toggle works", async () => {
    await expectBody("Skill 管理工具", "Chinese app title");
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expectBody("Skill Manager", "English app title");
    await page.getByRole("button", { name: "中文", exact: true }).click();
    await expectBody("Skill 管理工具", "Chinese app title after toggle back");
  });

  await step("load disposable registry via WebUI", async () => {
    await loadRegistryThroughUi(externalRegistryRepo);
    await screenshot("loaded-external-registry");
    const agentData = await fetchJson("/api/agents");
    if (path.resolve(agentData.registryRepo) !== path.resolve(externalRegistryRepo)) {
      throw new Error(`Server did not load external registry: ${agentData.registryRepo}`);
    }
    await loadRegistryThroughUi(registryRepo);
    const restored = await fetchJson("/api/agents");
    if (path.resolve(restored.registryRepo) !== path.resolve(registryRepo)) {
      throw new Error(`Server did not restore main registry: ${restored.registryRepo}`);
    }
  });

  await step("overview search, focus, and add-source flow", async () => {
    await page.getByRole("button", { name: /总览/ }).click();
    await page.getByPlaceholder("搜索 skills...").fill("sync-target");
    await page.locator(".overview-results-row .skill-row", { hasText: "sync-target" }).first().click();
    await page.locator(".overview-detail-panel .detail-head h2", { hasText: "sync-target" }).waitFor({ state: "visible", timeout: 10000 });
    await page.getByPlaceholder("搜索 skills...").fill("");
    const before = (await fetchJson("/api/scan", { method: "POST", body: JSON.stringify({ includeDefaultExcluded: false }) })).skills.length;
    await page.getByRole("button", { name: /添加自定义目录/ }).click();
    await expectBody("添加自定义来源目录");
    await page.locator('.add-source-dialog input[placeholder="my-skills"]').fill("custom-agent");
    const pathInput = page.locator('.add-source-dialog input[placeholder*="sources/shared-agents"]');
    await pathInput.fill(path.join(sandboxRoot, "custom-source"));
    await page.locator(".add-source-dialog .primary").click();
    await waitForText("custom-agent", 15000);
    await screenshot("added-custom-source");
    const after = (await fetchJson("/api/scan", { method: "POST", body: JSON.stringify({ includeDefaultExcluded: false }) })).skills.length;
    if (after <= before) throw new Error(`Expected add-source scan count to increase, before=${before}, after=${after}`);
  });

  await step("scan confirmation dialog can run", async () => {
    await page.getByRole("button", { name: /扫描 skills/ }).click();
    await expectBody("确认扫描来源");
    await page.locator(".dialog .primary").click();
    await page.waitForFunction(() => /扫描 skills?: \d+|扫描: \d+/.test(document.body.innerText), undefined, { timeout: 15000 });
  });

  await step("repo import confirm performs real import", async () => {
    await page.getByRole("button", { name: /仓库管理/ }).click();
    await page.getByRole("button", { name: /^导入到 Registry$/ }).click();
    await expectBody("确认导入到 Registry");
    await page.locator(".dialog .primary").click();
    await page.waitForFunction(() => document.body.innerText.includes("已导入") || document.body.innerText.includes("imported"), undefined, { timeout: 30000 });
    const skills = await apiSkills();
    if (!skills.some((skill) => skill.name === "custom-added")) throw new Error("Imported registry did not include custom-added from added source");
    await screenshot("imported-registry");
  });

  await step("distribution preview and apply write target directory", async () => {
    await fs.rm(path.join(targetsRoot, "codex", "distribute-only"), { recursive: true, force: true });
    await page.getByRole("button", { name: /分发管理/ }).click();
    await selectFirstTargetOnly("Codex");
    const row = page.locator(".distribute-table-card .skill-row", { hasText: "distribute-only" }).first();
    await row.scrollIntoViewIfNeeded();
    await row.locator(".skill-row-check").click();
    const counter = await selectedCountText(".distribute-action-bar .action-bar-counter");
    if (!counter.startsWith("1 ")) throw new Error(`Expected one selected distribute skill, got: ${counter}`);
    await page.getByRole("button", { name: /预览复制结果/ }).click();
    await page.waitForFunction(() => document.querySelectorAll(".distribute-action-bar .plan-item").length > 0, undefined, { timeout: 30000 });
    await page.getByRole("button", { name: /^确认复制到选中的目标 Agent$/ }).click();
    await page.locator(".confirm-plan-dialog").waitFor({ state: "visible", timeout: 10000 });
    await waitForText("确认写入");
    await page.locator(".confirm-plan-dialog .primary").click();
    await waitForFileIncludes(path.join(targetsRoot, "codex", "distribute-only", "SKILL.md"), "Distribution body from registry", "codex distribute target", 30000);
    await screenshot("distribution-applied");
  });

  await step("intersection preview and apply write target directory", async () => {
    await fs.rm(path.join(targetsRoot, "claude", "distribute-only"), { recursive: true, force: true });
    await page.getByRole("button", { name: /交汇中心/ }).click();
    const fromTrigger = page.locator(".agent-selects .agent-select-button").first();
    await fromTrigger.click();
    await page.locator(".agent-select-popover .agent-select-option", { hasText: "Mavis" }).click();
    const toTrigger = page.locator(".agent-selects .agent-select-button").nth(1);
    await toTrigger.click();
    await page.locator(".agent-select-popover .agent-select-option", { hasText: "Claude" }).click();
    const row = page.locator(".intersect-table-card .skill-row", { hasText: "distribute-only" }).first();
    await row.scrollIntoViewIfNeeded();
    await row.locator(".skill-row-check").click();
    await page.getByRole("button", { name: /预览交汇复制/ }).click();
    await page.waitForFunction(() => document.querySelectorAll(".intersect-action-bar .plan-item").length > 0, undefined, { timeout: 30000 });
    const apply = page.locator(".intersect-action-bar button", { hasText: "确认复制到目标 Agent" });
    await apply.waitFor({ state: "visible", timeout: 10000 });
    await apply.click();
    await page.locator(".confirm-plan-dialog").waitFor({ state: "visible", timeout: 10000 });
    await waitForText("确认写入");
    await page.locator(".confirm-plan-dialog .primary").click();
    await waitForFileIncludes(path.join(targetsRoot, "claude", "distribute-only", "SKILL.md"), "Distribution body from registry", "claude intersection target", 30000);
    await screenshot("intersection-applied");
  });

  await step("sync pull pulls live drift into canonical", async () => {
    await replaceInSkill(path.join(sourcesRoot, "mavis", "sync-target"), "marker: seed", "marker: pulled-from-mavis");
    await fetchJson("/api/import", { method: "POST", body: JSON.stringify({}) });
    const sync = await apiSync("sync-target");
    const mavis = sync.instances.find((entry) => entry.viaAgents.includes("mavis"));
    if (mavis?.status !== "drifted") throw new Error(`Expected mavis drifted before pull, got ${mavis?.status}`);
    await focusRepoSkill("sync-target");
    const instance = page.locator(".repo-detail-panel .instance-row", { hasText: path.join(sourcesRoot, "mavis", "sync-target") });
    await instance.locator("button", { hasText: "把这份改动拉回中心" }).click();
    await waitForFileIncludes(path.join(registryRepo, "registry", "skills", "sync-target", "SKILL.md"), "marker: pulled-from-mavis", "canonical after pull", 30000);
  });

  await step("sync push restores missing instance", async () => {
    await fs.rm(path.join(sourcesRoot, "codex", "sync-target"), { recursive: true, force: true });
    let sync = await apiSync("sync-target");
    const codex = sync.instances.find((entry) => entry.viaAgents.includes("codex"));
    if (codex?.status !== "drifted" && codex?.status !== "missing") throw new Error(`Expected codex pushable before push, got ${codex?.status}`);
    await focusRepoSkill("sync-target");
    const instance = page.locator(".repo-detail-panel .instance-row", { hasText: path.join(sourcesRoot, "codex", "sync-target") });
    await instance.locator("button", { hasText: "用中心覆盖这份" }).click();
    await waitForFileIncludes(path.join(sourcesRoot, "codex", "sync-target", "SKILL.md"), "marker: pulled-from-mavis", "codex restored instance", 30000);
  });

  await step("sync push-all restores all drifted instances", async () => {
    await replaceInSkill(path.join(sourcesRoot, "mavis", "sync-target"), "marker: pulled-from-mavis", "marker: drift-for-push-all-mavis");
    await replaceInSkill(path.join(sourcesRoot, "claude", "sync-target"), "marker: seed", "marker: drift-for-push-all-claude");
    await fetchJson("/api/import", { method: "POST", body: JSON.stringify({}) });
    await focusRepoSkill("sync-target");
    await page.locator(".repo-detail-panel .instances-push-all").click();
    await waitForFileIncludes(path.join(sourcesRoot, "mavis", "sync-target", "SKILL.md"), "marker: pulled-from-mavis", "mavis after push-all", 30000);
    await waitForFileIncludes(path.join(sourcesRoot, "claude", "sync-target", "SKILL.md"), "marker: pulled-from-mavis", "claude after push-all", 30000);
  });

  await step("merge dialog is gated and cancellable for two drifted instances", async () => {
    await replaceInSkill(path.join(sourcesRoot, "mavis", "sync-target"), "marker: pulled-from-mavis", "marker: merge-drift-mavis");
    await replaceInSkill(path.join(sourcesRoot, "claude", "sync-target"), "marker: pulled-from-mavis", "marker: merge-drift-claude");
    await fetchJson("/api/import", { method: "POST", body: JSON.stringify({}) });
    await focusRepoSkill("sync-target");
    await page.locator(".repo-detail-panel .instances-merge").click();
    await expectBody("合并 sync-target");
    await expectBody("从哪些实例合并");
    const start = page.getByRole("button", { name: /开始合并/ });
    await start.waitFor({ state: "visible", timeout: 10000 });
    await page.locator(".merge-dialog .dialog-close").click();
    await waitForNoText("合并 sync-target");
    await expectFileIncludes(path.join(registryRepo, "registry", "skills", "sync-target", "SKILL.md"), "marker: pulled-from-mavis", "canonical unchanged after merge cancel");
  });

  await step("repo remote connect and push use disposable bare remote", async () => {
    await page.getByRole("button", { name: /仓库管理/ }).click();
    await page.getByRole("button", { name: /绑定到 GitHub remote/ }).click();
    await expectBody("绑定到 GitHub remote");
    await page.locator(".connect-remote-input").fill(bareRemote);
    await page.locator(".connect-remote-dialog .primary").click();
    await waitForText("已绑定到", 15000);
    await page.locator(".repo-commit-message input").fill("functional webui test push");
    await page.getByRole("button", { name: /^提交并推送 Registry$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes("No changes to commit") || /[0-9a-f]{7,}/.test(document.body.innerText), undefined, { timeout: 30000 });
    const remotes = run("git", ["remote", "-v"], { cwd: registryRepo });
    if (!remotes.includes(bareRemote)) throw new Error(`origin was not set to bare remote: ${remotes}`);
    await screenshot("repo-push");
  });

  await step("final API consistency checks", async () => {
    const skills = await apiSkills();
    for (const name of ["shared-alpha", "sync-target", "distribute-only", "custom-added"]) {
      if (!skills.some((skill) => skill.name === name)) throw new Error(`Missing registry skill ${name}`);
    }
    const sync = await apiSync("sync-target");
    if (!sync || sync.instances.length < 3) throw new Error("sync-target should have at least three tracked instances");
  });
} catch (error) {
  if (failures.length === 0) failures.push(error instanceof Error ? error.message : String(error));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopServerProcess();
  const result = {
    ok: failures.length === 0,
    baseUrl,
    sandboxRoot,
    outDir,
    screenshots: screenshots.map(rel),
    steps: stepResults,
    failures
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (failures.length > 0) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}
