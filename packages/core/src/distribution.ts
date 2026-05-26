import fs from "node:fs/promises";
import path from "node:path";
import { getDistributionTargets } from "./agents.js";
import { ensureDir, pathExists } from "./fs-helpers.js";
import { hashDirectory, sha256 } from "./hash.js";
import { assertNoPathSeparators, assertPathInside, sanitizePathSegment } from "./path-safety.js";
import { readRegistryManifest, registrySkillPath } from "./registry.js";
import type { AgentKind, DistributionItemPlan, DistributionOptions, DistributionPlan, DistributionRun, DistributionTarget, SkillPackage } from "./types.js";

const backupRoot = (options: DistributionOptions): string =>
  options.backupDir ?? path.join(options.cwd ?? process.cwd(), ".sandbox", "state", "backups");

const isShareable = (skill: SkillPackage, options: DistributionOptions): boolean => {
  if (!skill.status.includes("valid") || !skill.status.includes("portable")) return false;
  if (!options.includeUnsafe && skill.status.includes("unsafe")) return false;
  if (!options.includeAgentBound && skill.status.includes("agent_bound")) return false;
  return true;
};

const pickTargets = (options: DistributionOptions): DistributionTarget[] => {
  const all = getDistributionTargets(options.cwd ?? process.cwd(), options.config, options.profileName);
  const agents = options.targetAgents;
  const wanted = new Set(agents);
  return all.filter((target) => wanted.has(target.agent));
};

export const createDistributionPlan = async (options: DistributionOptions): Promise<DistributionPlan> => {
  const createdAt = (options.now ?? new Date()).toISOString();
  const manifest = await readRegistryManifest(options.registryPath);
  const repoPath = options.registryPath.endsWith(".json") ? path.dirname(path.dirname(options.registryPath)) : options.registryPath;
  const selectedIds = options.skillIds ? new Set(options.skillIds) : undefined;
  const targets = pickTargets(options);
  const backupBase = backupRoot(options);
  const warnings: string[] = [];
  const items: DistributionItemPlan[] = [];

  for (const target of targets) {
    for (const skill of manifest.skills) {
      if (selectedIds && !selectedIds.has(skill.id)) continue;
      assertNoPathSeparators(skill.name, "skill.name");
      const sourcePath = registrySkillPath(repoPath, skill);
      assertPathInside(repoPath, sourcePath, "registry skill path");
      if (!(await pathExists(sourcePath))) {
        warnings.push(`Missing registry package for ${skill.name} (${skill.variantId}).`);
        continue;
      }
      const targetPath = path.join(target.targetDir, sanitizePathSegment(skill.name));
      assertPathInside(target.targetDir, targetPath, "distribution target path");
      const existing = await pathExists(targetPath);
      const shareable = isShareable(skill, options);
      if (!shareable) {
        items.push({ skill, target, action: "skip", reason: "Skill is not valid, portable, and shareable by default.", reasonCode: "not_shareable", existingPath: existing ? targetPath : undefined });
        continue;
      }
      if (existing) {
        const existingHash = await hashDirectory(targetPath).catch(() => "unreadable");
        if (existingHash === skill.hash) {
          items.push({ skill, target, action: "skip", reason: "Target already has the same content.", reasonCode: "same_content", existingPath: targetPath });
        } else {
          const backupPath = path.join(backupBase, sha256(createdAt).slice(0, 12), target.agent, sanitizePathSegment(skill.name));
          assertPathInside(backupBase, backupPath, "backup path");
          items.push({ skill, target, action: "overwrite", reason: "Target has different content; backup will be created before overwrite.", reasonCode: "different_content_will_backup", existingPath: targetPath, backupPath });
        }
      } else {
        items.push({ skill, target, action: "copy", reason: "Target does not have this skill yet.", reasonCode: "new" });
      }
    }
  }

  return {
    id: sha256(`${createdAt}:${JSON.stringify(options.targetAgents)}:${JSON.stringify(options.skillIds ?? [])}`).slice(0, 16),
    createdAt,
    items,
    warnings
  };
};

export const applyDistributionPlan = async (registryPath: string, plan: DistributionPlan): Promise<DistributionRun> => {
  const repoPath = registryPath.endsWith(".json") ? path.dirname(path.dirname(registryPath)) : registryPath;
  let copied = 0;
  let skipped = 0;
  const backups: string[] = [];

  for (const item of plan.items) {
    if (item.action === "skip") {
      skipped += 1;
      continue;
    }
    assertNoPathSeparators(item.skill.name, "skill.name");
    const sourcePath = registrySkillPath(repoPath, item.skill);
    assertPathInside(repoPath, sourcePath, "registry skill path");
    const targetPath = path.join(item.target.targetDir, sanitizePathSegment(item.skill.name));
    assertPathInside(item.target.targetDir, targetPath, "distribution target path");
    await ensureDir(path.dirname(targetPath));
    if (item.action === "overwrite" && item.existingPath && item.backupPath) {
      await ensureDir(path.dirname(item.backupPath));
      await fs.rm(item.backupPath, { recursive: true, force: true });
      await fs.cp(item.existingPath, item.backupPath, { recursive: true, force: true, errorOnExist: false });
      backups.push(item.backupPath);
      await fs.rm(targetPath, { recursive: true, force: true });
    }
    await fs.cp(sourcePath, targetPath, { recursive: true, force: true, errorOnExist: false });
    copied += 1;
  }

  return {
    planId: plan.id,
    appliedAt: new Date().toISOString(),
    copied,
    skipped,
    backups
  };
};
