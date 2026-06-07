#!/usr/bin/env node
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.LINKA_SKILLHUB_URL ?? "http://127.0.0.1:4873";
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outDir = path.join(process.cwd(), ".sandbox", "ui-smoke");
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (error) => errors.push(error.message));

await page.goto(baseUrl, { waitUntil: "networkidle" });
await page.screenshot({ path: path.join(outDir, "overview.png"), fullPage: true });

const bodyText = await page.textContent("body");
if (!bodyText?.includes("测试镜像")) throw new Error("UI did not show the mirror profile label.");
if (!bodyText.includes("Skill 管理工具")) throw new Error("UI title missing.");

await page.getByRole("button", { name: /仓库管理/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("导入到 Registry"), undefined, { timeout: 10000 });
await page.waitForFunction(() => document.body.innerText.includes("Registry Skills"), undefined, { timeout: 10000 });
await page.getByRole("button", { name: /^导入到 Registry$/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("确认导入到 Registry"), undefined, { timeout: 10000 });
await page.screenshot({ path: path.join(outDir, "repo-import-confirm.png"), fullPage: true });
await page.locator(".dialog .ghost", { hasText: "取消" }).click();
await page.waitForFunction(() => !document.body.innerText.includes("确认导入到 Registry"), undefined, { timeout: 10000 });

await page.getByRole("button", { name: /总览/ }).click();
await page.getByPlaceholder("搜索 skills...").fill("1password");
await page.getByRole("button", { name: /1password/ }).first().click();
await page.getByRole("button", { name: /分发管理/ }).click();
await page.locator(".distribute-table-card .skill-row").first().locator(".skill-row-check").click();
await page.getByRole("button", { name: /预览复制结果/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("复制预览"), undefined, { timeout: 30000 });
await page.screenshot({ path: path.join(outDir, "distribution-plan.png"), fullPage: true });
await page.getByRole("button", { name: /^确认复制到选中的目标 Agent$/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("Plan Token"), undefined, { timeout: 30000 });
await page.screenshot({ path: path.join(outDir, "distribution-confirm.png"), fullPage: true });
await page.locator(".confirm-plan-dialog .dialog-actions button.ghost").click();
await page.waitForFunction(() => !document.body.innerText.includes("Plan Token"), undefined, { timeout: 10000 });

if (errors.length > 0) throw new Error(`Browser console/page errors:\n${errors.join("\n")}`);
await browser.close();
console.log(JSON.stringify({ ok: true, screenshots: outDir }, null, 2));
