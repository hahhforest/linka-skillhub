import fs from "node:fs/promises";
import path from "node:path";
import type { ImportOptions, ImportResult, RegistryManifest, SkillPackage } from "./types.js";
import { scanSkills } from "./scanner.js";
import { assertNoPathSeparators, assertPathInside, sanitizePathSegment } from "./path-safety.js";

const ensureDir = async (dir: string): Promise<void> => {
  await fs.mkdir(dir, { recursive: true });
};

const copyPackage = async (skill: SkillPackage, repoPath: string): Promise<void> => {
  assertNoPathSeparators(skill.name, "skill.name");
  assertNoPathSeparators(skill.variantId, "skill.variantId");
  const target = path.join(repoPath, "skills", sanitizePathSegment(skill.name), sanitizePathSegment(skill.variantId));
  assertPathInside(path.join(repoPath, "skills"), target, "registry package target");
  await fs.rm(target, { recursive: true, force: true });
  await ensureDir(path.dirname(target));
  await fs.cp(skill.realPath, target, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (src) => !src.endsWith(`${path.sep}.DS_Store`) && !src.includes(`${path.sep}.git${path.sep}`)
  });
};

export const writeRegistryManifest = async (repoPath: string, manifest: RegistryManifest): Promise<string> => {
  const registryDir = path.join(repoPath, "registry");
  await ensureDir(registryDir);
  const manifestPath = path.join(registryDir, "skills.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
};

export const readRegistryManifest = async (registryPath: string): Promise<RegistryManifest> => {
  const manifestPath = registryPath.endsWith(".json") ? registryPath : path.join(registryPath, "registry", "skills.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(raw) as RegistryManifest;
};

export const importSkillsToRepository = async (options: ImportOptions): Promise<ImportResult> => {
  const repoPath = path.resolve(options.repoPath);
  await ensureDir(repoPath);
  const promptSource = path.join(options.cwd ?? process.cwd(), "prompts");
  try {
    await fs.cp(promptSource, path.join(repoPath, "prompts"), { recursive: true, force: true, errorOnExist: false });
  } catch {
    // Prompt snapshots are best-effort for external registries; core import still works without them.
  }
  const skills = await scanSkills(options);
  let imported = 0;
  let skipped = 0;

  for (const skill of skills) {
    if (!options.includeDefaultExcluded && !skill.source.defaultSelected) {
      skipped += 1;
      continue;
    }
    await copyPackage(skill, repoPath);
    imported += 1;
  }

  const manifest: RegistryManifest = {
    version: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    skills: options.includeDefaultExcluded ? skills : skills.filter((skill) => skill.source.defaultSelected)
  };
  const manifestPath = await writeRegistryManifest(repoPath, manifest);
  return { repoPath, manifestPath, imported, skipped, manifest };
};

export const registrySkillPath = (repoPath: string, skill: SkillPackage): string =>
  path.join(repoPath, "skills", sanitizePathSegment(skill.name), sanitizePathSegment(skill.variantId));
