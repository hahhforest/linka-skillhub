import fs from "node:fs/promises";
import path from "node:path";
import { scanSkills } from "./scanner.js";
import { ensureDir, pathExists } from "./fs-helpers.js";
import { hashDirectory } from "./hash.js";
import { assertNoPathSeparators, assertPathInside, sanitizePathSegment } from "./path-safety.js";
import { ensureGitRepository, gitCommitPaths } from "./repo.js";
import type {
  AgentKind,
  ImportOptions,
  ImportResult,
  RegistryInstance,
  RegistryInstancesIndex,
  RegistryManifest,
  SkillPackage
} from "./types.js";

export interface ValidateRegistryResult {
  readonly ok: boolean;
  readonly repoPath: string;
  readonly manifestVersion?: number;
  readonly skillCount?: number;
  readonly reason?: "missing_manifest" | "outside_profile_root" | "not_a_directory" | "invalid_manifest";
}

// R36-C19: canonical-per-name model. Each canonical lives at
// registry/skills/<name>/ (no variantId subdir). Directory IS the canonical
// content, git-tracked, hash = hashDirectory(). Same name across agents
// collapses to ONE canonical; per-realPath instances tracked separately in
// registry/instances.json. variantId stays on SkillPackage at scan time (a
// per-instance unique key still useful for "this file at this realpath") but
// does not drive registry storage paths anymore.
export const registryCanonicalPath = (repoPath: string, name: string): string => {
  assertNoPathSeparators(name, "skill.name");
  return path.join(repoPath, "skills", sanitizePathSegment(name));
};

// Back-compat helper: distribution still imports registrySkillPath; in v2 it
// resolves to the canonical dir (variantId ignored).
export const registrySkillPath = (repoPath: string, skill: SkillPackage): string =>
  registryCanonicalPath(repoPath, skill.name);

const copyCanonicalDir = async (sourceDir: string, destDir: string): Promise<void> => {
  await fs.rm(destDir, { recursive: true, force: true });
  await ensureDir(path.dirname(destDir));
  await fs.cp(sourceDir, destDir, {
    recursive: true,
    force: true,
    dereference: true,
    errorOnExist: false,
    filter: (src) => !src.endsWith(`${path.sep}.DS_Store`) && !src.includes(`${path.sep}.git${path.sep}`)
  });
};

const readJsonOrNull = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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

const instancesPath = (repoPath: string): string => path.join(repoPath, "registry", "instances.json");

export const writeInstancesIndex = async (repoPath: string, index: RegistryInstancesIndex): Promise<string> => {
  const registryDir = path.join(repoPath, "registry");
  await ensureDir(registryDir);
  const target = instancesPath(repoPath);
  await fs.writeFile(target, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return target;
};

export const readInstancesIndex = async (repoPath: string): Promise<RegistryInstancesIndex | null> =>
  readJsonOrNull<RegistryInstancesIndex>(instancesPath(repoPath));

interface PerCanonical {
  readonly name: string;
  readonly skills: SkillPackage[]; // every scanned instance that bears this name
}

const groupByName = (skills: readonly SkillPackage[]): PerCanonical[] => {
  const buckets = new Map<string, SkillPackage[]>();
  for (const skill of skills) {
    if (!skill.name) continue;
    const bucket = buckets.get(skill.name);
    if (bucket) bucket.push(skill);
    else buckets.set(skill.name, [skill]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bucketSkills]) => ({ name, skills: bucketSkills }));
};

// Build the instance list for a single canonical name. Multiple scanned
// SkillPackage entries can share the same realPath (one physical file
// surfaced via N agents' source dirs — e.g. ~/.agents/skills/lark-mail seen
// by both `shared` and `hermes`). De-dup by realPath; collect contributing
// agents into viaAgents. Status is computed against the canonical hash so
// `in-sync` means "this realPath matches the canonical content right now".
const buildInstances = (
  canonicalHash: string,
  scannedAt: string,
  scanned: readonly SkillPackage[]
): RegistryInstance[] => {
  const byRealPath = new Map<string, { hash: string; agents: Set<AgentKind> }>();
  for (const skill of scanned) {
    const real = skill.realPath;
    const entry = byRealPath.get(real);
    if (entry) entry.agents.add(skill.source.agent);
    else byRealPath.set(real, { hash: skill.hash, agents: new Set([skill.source.agent]) });
  }
  return [...byRealPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([realPath, entry]) => ({
      realPath,
      viaAgents: [...entry.agents].sort(),
      lastSeenHash: entry.hash,
      lastSeenAt: scannedAt,
      status: entry.hash === canonicalHash ? "in-sync" as const : "drifted" as const
    }));
};

// Reshape a SkillPackage so it represents the CANONICAL view (registry-rooted
// paths, origin agent in `source`, canonical hash). The manifest entries used
// by /api/skills are still SkillPackage-shaped for UI compatibility (Overview
// agent filter, source-distribution bars, DetailPanel all assume that shape)
// but the meaning of `source` becomes "where this canonical was first imported
// from" — live on-disk locations live in instances.json.
const toCanonicalSkillPackage = (
  source: SkillPackage,
  canonicalDir: string,
  canonicalHash: string,
  scannedAt: string
): SkillPackage => ({
  ...source,
  id: source.name,           // canonical id = name (v2)
  directoryName: source.name,
  skillDir: canonicalDir,
  skillFile: path.join(canonicalDir, "SKILL.md"),
  realPath: canonicalDir,
  isSymlink: false,
  hash: canonicalHash,
  variantId: `${source.name}-canonical`,
  updatedAt: scannedAt
});

const commitMessageImport = (name: string, originAgent: AgentKind): string =>
  `import ${name} (origin: ${originAgent})`;

export const importSkillsToRepository = async (options: ImportOptions): Promise<ImportResult> => {
  const repoPath = path.resolve(options.repoPath);
  await ensureDir(repoPath);
  await ensureGitRepository(repoPath);

  // Prompts snapshot is best-effort and lives outside the registry/ subtree;
  // unchanged from v1.
  const promptSource = path.join(options.cwd ?? process.cwd(), "prompts");
  try {
    await fs.cp(promptSource, path.join(repoPath, "prompts"), { recursive: true, force: true, errorOnExist: false });
  } catch {
    // Prompt snapshots are best-effort for external registries; core import still works without them.
  }

  const scannedAt = (options.now ?? new Date()).toISOString();
  const allScanned = await scanSkills(options);
  const selected = options.includeDefaultExcluded
    ? allScanned
    : allScanned.filter((skill) => skill.source.defaultSelected);
  const skipped = allScanned.length - selected.length;

  // Load existing manifest so a re-import keeps origin + canonicalHash for
  // names that haven't drifted. v1 manifests are tolerated (read as raw) and
  // then dropped — re-import recreates them at v2.
  const existingManifest = await readJsonOrNull<RegistryManifest>(path.join(repoPath, "registry", "skills.json"));
  const existingByName = new Map<string, SkillPackage>();
  if (existingManifest) {
    if (existingManifest.version === 2) {
      for (const entry of existingManifest.skills) existingByName.set(entry.name, entry);
    } else {
      // R36-C19: a v1 (or other unknown) manifest is silently dropped — no
      // migration was shipped because the only existing registry was the
      // sandbox fixture. Warn so a user who upgrades catches the reset
      // instead of wondering why origins look wrong after re-import.
      console.warn(`[registry] dropping legacy manifest (version=${(existingManifest as { version?: unknown }).version ?? "?"}); rebuilding at v2.`);
    }
  }

  const canonicalEntries: SkillPackage[] = [];
  const instancesByName: Record<string, readonly RegistryInstance[]> = {};
  let imported = 0;

  for (const { name, skills } of groupByName(selected)) {
    // Origin = first scanned package alphabetically by (agent, scope, realPath)
    // so the pick is deterministic across runs and across config reorders. The
    // user can override later via the sync subsystem (C21). The first scanned
    // package's content seeds the canonical only if no canonical exists yet.
    const ordered = [...skills].sort((a, b) =>
      `${a.source.agent}:${a.source.scope}:${a.realPath}`.localeCompare(`${b.source.agent}:${b.source.scope}:${b.realPath}`)
    );
    const seed = ordered[0]!;
    const canonicalDir = registryCanonicalPath(repoPath, name);
    assertPathInside(path.join(repoPath, "skills"), canonicalDir, "registry package target");

    const existing = existingByName.get(name);
    let canonicalHash: string;
    let originAgent: AgentKind;
    let originScannedAt: string;
    let didCommit = false;

    if (!existing) {
      // First-time canonical: copy seed's content into the registry tree, git
      // commit it. Per-skill commit gives `git log -- skills/<name>/` a clean
      // history line. We only bump the imported counter when the commit
      // actually happened — a bit-identical recreation hits gitCommitPaths's
      // empty-status path and returns "", which we treat as a no-op.
      await copyCanonicalDir(seed.realPath, canonicalDir);
      canonicalHash = await hashDirectory(canonicalDir);
      originAgent = seed.source.agent;
      originScannedAt = scannedAt;
      const sha = await gitCommitPaths(repoPath, [path.relative(repoPath, canonicalDir)], commitMessageImport(name, originAgent));
      didCommit = sha !== "";
      if (didCommit) imported += 1;
    } else {
      // Canonical already exists in registry. Keep its content untouched:
      // re-import is NOT a sync — drift resolution belongs to the sync
      // subsystem (R36-C21). We just refresh the hash from disk in case the
      // on-disk canonical was edited by a tool outside this code path.
      // TODO(R36-C21): if pathExists(canonicalDir) returns false here, we
      // currently fall back to existing.hash (stale). A live scan instance
      // could re-seed the canonical, but that decision is sync-scope.
      canonicalHash = await pathExists(canonicalDir)
        ? await hashDirectory(canonicalDir)
        : existing.hash;
      originAgent = existing.source.agent;
      originScannedAt = existing.updatedAt;
    }

    const canonicalView = toCanonicalSkillPackage(seed, canonicalDir, canonicalHash, didCommit ? scannedAt : originScannedAt);
    canonicalEntries.push(canonicalView);
    instancesByName[name] = buildInstances(canonicalHash, scannedAt, ordered);
  }

  // Carry forward canonicals that no scan source surfaced this run (skill was
  // removed from disk or filter excluded it). They stay in the registry — the
  // canonical content + git history is the source of truth, scan absence just
  // means no live instance.
  for (const [name, entry] of existingByName.entries()) {
    if (canonicalEntries.some((skill) => skill.name === name)) continue;
    canonicalEntries.push(entry);
    instancesByName[name] = [];
  }

  canonicalEntries.sort((a, b) => a.name.localeCompare(b.name));

  const manifest: RegistryManifest = {
    version: 2,
    generatedAt: scannedAt,
    skills: canonicalEntries
  };
  const manifestPath = await writeRegistryManifest(repoPath, manifest);
  await writeInstancesIndex(repoPath, {
    version: 1,
    generatedAt: scannedAt,
    byName: instancesByName
  });

  return { repoPath, manifestPath, imported, skipped, manifest };
};

export const validateRegistryPath = async (
  repoPath: string,
  options: { readonly cwd: string; readonly profileRoot: string }
): Promise<ValidateRegistryResult> => {
  const requested = path.resolve(options.cwd, repoPath);
  let realProfileRoot = options.profileRoot;
  try {
    realProfileRoot = await fs.realpath(options.profileRoot);
  } catch {
    // profileRoot may not exist on disk yet; fall back to the resolved value
  }
  let real = requested;
  try {
    real = await fs.realpath(requested);
  } catch {
    return { ok: false, repoPath: requested, reason: "missing_manifest" };
  }
  try {
    assertPathInside(realProfileRoot, real, "external registry path");
  } catch {
    return { ok: false, repoPath: real, reason: "outside_profile_root" };
  }
  const stat = await fs.lstat(real);
  if (!stat.isDirectory()) return { ok: false, repoPath: real, reason: "not_a_directory" };
  const manifestPath = path.join(real, "registry", "skills.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return { ok: false, repoPath: real, reason: "missing_manifest" };
  }
  let manifest: RegistryManifest;
  try {
    manifest = JSON.parse(raw) as RegistryManifest;
  } catch {
    return { ok: false, repoPath: real, reason: "invalid_manifest" };
  }
  if (manifest.version !== 2 || !Array.isArray(manifest.skills)) {
    return { ok: false, repoPath: real, reason: "invalid_manifest" };
  }
  return { ok: true, repoPath: real, manifestVersion: manifest.version, skillCount: manifest.skills.length };
};
