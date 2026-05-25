import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertInteractiveOrYes,
  ConfirmationRequiredError,
  summarizeCopyForPrompt,
  summarizePlanForPrompt
} from "../src/prompts.js";
import type { DistributionItemPlan, DistributionPlan, DistributionTarget, SkillPackage } from "@linka-skillhub/core";

const buildSkill = (overrides: Partial<SkillPackage>): SkillPackage => ({
  id: overrides.id ?? "skill-id",
  name: overrides.name ?? "sample-skill",
  directoryName: overrides.directoryName ?? "sample-skill",
  description: overrides.description ?? "test skill",
  source: overrides.source ?? ({
    id: "claude:0",
    agent: "claude",
    label: "Claude",
    rootPath: "/tmp/skills",
    scope: "user",
    defaultSelected: true,
    exists: true,
    includeNested: false
  } as SkillPackage["source"]),
  skillDir: overrides.skillDir ?? "/tmp/skills/sample-skill",
  skillFile: overrides.skillFile ?? "/tmp/skills/sample-skill/SKILL.md",
  realPath: overrides.realPath ?? "/tmp/skills/sample-skill",
  isSymlink: false,
  hash: overrides.hash ?? "abc",
  variantId: overrides.variantId ?? "variant",
  frontmatter: overrides.frontmatter ?? {},
  status: overrides.status ?? ["valid", "portable"],
  issues: overrides.issues ?? [],
  evidence: overrides.evidence ?? [],
  updatedAt: "2026-05-22T00:00:00.000Z"
});

const buildTarget = (agent: string): DistributionTarget => ({ agent: agent as DistributionTarget["agent"], label: agent, targetDir: `/tmp/targets/${agent}/skills` });

const buildItem = (overrides: Partial<DistributionItemPlan>): DistributionItemPlan => ({
  skill: overrides.skill ?? buildSkill({ name: overrides.skill?.name ?? "alpha" }),
  target: overrides.target ?? buildTarget("codex"),
  action: overrides.action ?? "copy",
  reason: overrides.reason ?? "test",
  existingPath: overrides.existingPath,
  backupPath: overrides.backupPath
});

describe("prompts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("summarizes a distribution plan", () => {
    const plan: DistributionPlan = {
      id: "plan-1",
      createdAt: "2026-05-22T00:00:00.000Z",
      items: [
        buildItem({ action: "copy", skill: buildSkill({ name: "alpha" }), target: buildTarget("codex") }),
        buildItem({ action: "overwrite", skill: buildSkill({ name: "beta" }), target: buildTarget("claude"), existingPath: "/tmp/t/claude/skills/beta", backupPath: "/tmp/backup/claude/beta" }),
        buildItem({ action: "skip", skill: buildSkill({ name: "gamma" }), target: buildTarget("mavis"), reason: "Already same" })
      ],
      warnings: []
    };
    const lines = summarizePlanForPrompt(plan);
    expect(lines.some((line) => line.includes("alpha"))).toBe(true);
    expect(lines.some((line) => line.includes("beta"))).toBe(true);
    expect(lines.some((line) => line.includes("backup"))).toBe(true);
  });

  it("summarizes copy items with from/to header", () => {
    const items = [buildItem({ action: "copy", skill: buildSkill({ name: "alpha" }) }), buildItem({ action: "overwrite", skill: buildSkill({ name: "beta" }), existingPath: "/tmp/t/claude/skills/beta" })];
    const lines = summarizeCopyForPrompt("claude", "codex", items);
    expect(lines[0]).toContain("From: claude");
    expect(lines[1]).toContain("To:   codex");
    expect(lines[2]).toContain("Items: 2");
  });

  it("throws ConfirmationRequiredError when env says non-interactive and no --yes", async () => {
    vi.stubEnv("LINKA_SKILLHUB_FORCE_YES", "");
    vi.stubEnv("CI", "1");
    await expect(assertInteractiveOrYes({ action: "copy apply", summary: ["item1"], totalItems: 1 })).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });

  it("skips when totalItems is 0 and skipOnEmpty=true", async () => {
    vi.stubEnv("LINKA_SKILLHUB_FORCE_YES", "");
    vi.stubEnv("CI", "1");
    await expect(assertInteractiveOrYes({ action: "copy apply", summary: [], totalItems: 0, skipOnEmpty: true })).resolves.toBeUndefined();
  });

  it("respects --yes regardless of env", async () => {
    vi.stubEnv("LINKA_SKILLHUB_FORCE_YES", "");
    vi.stubEnv("CI", "1");
    await expect(assertInteractiveOrYes({ action: "copy apply", summary: ["item1"], totalItems: 1, yes: true })).resolves.toBeUndefined();
  });

  it("respects LINKA_SKILLHUB_FORCE_YES=1 escape hatch", async () => {
    vi.stubEnv("LINKA_SKILLHUB_FORCE_YES", "1");
    await expect(assertInteractiveOrYes({ action: "copy apply", summary: ["item1"], totalItems: 1 })).resolves.toBeUndefined();
  });
});
