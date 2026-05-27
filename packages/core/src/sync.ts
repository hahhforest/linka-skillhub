import fs from "node:fs/promises";
import path from "node:path";
import { hashDirectory } from "./hash.js";
import { ensureDir, pathExists } from "./fs-helpers.js";
import { assertPathInside, sanitizePathSegment } from "./path-safety.js";
import { gitCommitPaths } from "./repo.js";
import {
  readInstancesIndex,
  readRegistryManifest,
  registryCanonicalPath,
  writeInstancesIndex,
  writeRegistryManifest
} from "./registry.js";
import type {
  AgentKind,
  CanonicalSyncStatus,
  RegistryInstance,
  RegistryInstancesIndex,
  RegistryManifest,
  SkillPackage,
  SyncForkResult,
  SyncPullResult,
  SyncPushResult
} from "./types.js";

// R36-C21: sync subsystem. Drift detection is already baked into the
// instances.json that import writes (each entry carries lastSeenHash +
// "in-sync" / "drifted" / "missing"). This module turns that derived state
// into actionable verbs:
//   pull  — copy a single agent's edit BACK into the canonical (registry/
//           skills/<name>/), git commit `pull <name> (from <agent>)`. Other
//           in-sync instances will now drift from the new canonical.
//   push  — copy canonical FORWARD into a specific agent's realPath,
//           overwriting whatever was there.
//   push-all — push to every drifted instance in one go.
//   fork  — create a new canonical from a drifted instance under a fresh
//           name. The old canonical and old instance link stay untouched.
//
// Skills are directories, not single files. Every action operates on the
// whole tree: hashDirectory is the truth, fs.cp with recursive:true is the
// write path. Symlinks inside an instance dir are dereferenced on copy
// (skill content needs to be a real, portable tree once it lands at the
// destination).
//
// All canonical-mutating actions land in their own git commit using the
// established subject convention so the C20 history view tells a clean
// story without us needing a separate event log.

const copyTree = async (sourceDir: string, destDir: string): Promise<void> => {
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

export const computeSyncStatus = (
  manifest: RegistryManifest,
  instances: RegistryInstancesIndex | null
): CanonicalSyncStatus[] =>
  manifest.skills.map((skill) => {
    const entries = instances?.byName[skill.name] ?? [];
    const hasDrift = entries.some((entry) => entry.status === "drifted");
    const hasMissing = entries.some((entry) => entry.status === "missing");
    const isOrphan = entries.length === 0;
    return {
      name: skill.name,
      canonicalHash: skill.hash,
      instances: entries,
      hasDrift,
      hasMissing,
      isOrphan
    };
  });

// Re-walk every instance after a canonical changes, recomputing each
// realPath's hash against the *new* canonical hash. Other in-sync instances
// flip to "drifted" automatically; the pulled-from instance becomes "in-sync"
// (we just made canonical match its content); a vanished realPath becomes
// "missing". This is the same status computation buildInstances does at
// import time, just decoupled from a scan invocation.
const refreshInstanceStatuses = async (
  byName: Record<string, RegistryInstance[]>,
  name: string,
  newCanonicalHash: string,
  now: string
): Promise<void> => {
  const entries = byName[name];
  if (!entries) return;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!(await pathExists(entry.realPath))) {
      entries[index] = { ...entry, status: "missing", lastSeenAt: now };
      continue;
    }
    const liveHash = await hashDirectory(entry.realPath);
    entries[index] = {
      ...entry,
      lastSeenHash: liveHash,
      lastSeenAt: now,
      status: liveHash === newCanonicalHash ? "in-sync" : "drifted"
    };
  }
};

const findInstance = (
  index: RegistryInstancesIndex | null,
  name: string,
  agent: AgentKind
): RegistryInstance | undefined =>
  index?.byName[name]?.find((entry) => entry.viaAgents.includes(agent));

const ensureManifestEntry = (manifest: RegistryManifest, name: string): SkillPackage => {
  const entry = manifest.skills.find((skill) => skill.name === name);
  if (!entry) throw new Error(`No canonical named '${name}' in registry manifest.`);
  return entry;
};

const writeManifestWithUpdatedSkill = async (
  repoPath: string,
  manifest: RegistryManifest,
  updated: SkillPackage,
  scannedAt: string
): Promise<void> => {
  const next: RegistryManifest = {
    ...manifest,
    generatedAt: scannedAt,
    skills: manifest.skills.map((skill) => (skill.name === updated.name ? updated : skill))
  };
  await writeRegistryManifest(repoPath, next);
};

export const syncPullFromInstance = async (
  repoPath: string,
  name: string,
  fromAgent: AgentKind,
  options: { readonly now?: Date } = {}
): Promise<SyncPullResult> => {
  const manifest = await readRegistryManifest(repoPath);
  const instancesIndex = await readInstancesIndex(repoPath);
  const canonical = ensureManifestEntry(manifest, name);
  const instance = findInstance(instancesIndex, name, fromAgent);
  if (!instance) throw new Error(`No live instance of '${name}' via agent '${fromAgent}' to pull from.`);
  if (!(await pathExists(instance.realPath))) {
    throw new Error(`Instance path no longer exists on disk: ${instance.realPath}`);
  }
  const canonicalDir = registryCanonicalPath(repoPath, name);
  assertPathInside(path.join(repoPath, "registry", "skills"), canonicalDir, "registry canonical path");
  // No-op short-circuit: if the live instance hash already matches canonical
  // there's nothing to write. Skipping the copy / git commit / manifest rewrite
  // keeps generatedAt timestamps and instances.json untouched so a no-op pull
  // doesn't appear in the history view or make it look like progress happened.
  // The CLI / WebUI tells the user the canonical was unchanged via `oldHash ===
  // newHash` plus `shortSha === ""`.
  const liveHash = await hashDirectory(instance.realPath);
  if (liveHash === canonical.hash) {
    return {
      name,
      fromAgent,
      fromRealPath: instance.realPath,
      oldHash: canonical.hash,
      newHash: canonical.hash,
      shortSha: "",
      otherDrifted: []
    };
  }
  await copyTree(instance.realPath, canonicalDir);
  const newHash = await hashDirectory(canonicalDir);
  const oldHash = canonical.hash;
  const scannedAt = (options.now ?? new Date()).toISOString();
  const sha = await gitCommitPaths(
    repoPath,
    [path.relative(repoPath, canonicalDir)],
    `pull ${name} (from ${fromAgent})`
  );
  const updatedCanonical: SkillPackage = {
    ...canonical,
    hash: newHash,
    updatedAt: scannedAt
  };
  await writeManifestWithUpdatedSkill(repoPath, manifest, updatedCanonical, scannedAt);
  const byName: Record<string, RegistryInstance[]> = Object.fromEntries(
    Object.entries(instancesIndex?.byName ?? {}).map(([key, list]) => [key, [...list]])
  );
  await refreshInstanceStatuses(byName, name, newHash, scannedAt);
  await writeInstancesIndex(repoPath, {
    version: 1,
    generatedAt: scannedAt,
    byName
  });
  const otherDrifted = (byName[name] ?? [])
    .filter((entry) => entry.realPath !== instance.realPath && entry.status === "drifted")
    .map((entry) => entry.realPath);
  return {
    name,
    fromAgent,
    fromRealPath: instance.realPath,
    oldHash,
    newHash,
    shortSha: sha,
    otherDrifted
  };
};

export const syncPushToInstance = async (
  repoPath: string,
  name: string,
  toAgent: AgentKind,
  options: { readonly now?: Date } = {}
): Promise<SyncPushResult> => {
  const manifest = await readRegistryManifest(repoPath);
  const instancesIndex = await readInstancesIndex(repoPath);
  const canonical = ensureManifestEntry(manifest, name);
  const instance = findInstance(instancesIndex, name, toAgent);
  if (!instance) throw new Error(`No registered instance of '${name}' via agent '${toAgent}'.`);
  const canonicalDir = registryCanonicalPath(repoPath, name);
  if (!(await pathExists(canonicalDir))) {
    throw new Error(`Canonical directory missing: ${canonicalDir}`);
  }
  // Push writes the agent's realPath. If the agent's source was symlinked
  // (e.g. hermes/lark-mail -> .agents/skills/lark-mail), writing realPath
  // updates the file every symlink-via path sees. That's correct behaviour:
  // realPath dedup means one canonical maps to one physical write target.
  await copyTree(canonicalDir, instance.realPath);
  const scannedAt = (options.now ?? new Date()).toISOString();
  const byName: Record<string, RegistryInstance[]> = Object.fromEntries(
    Object.entries(instancesIndex?.byName ?? {}).map(([key, list]) => [key, [...list]])
  );
  await refreshInstanceStatuses(byName, name, canonical.hash, scannedAt);
  await writeInstancesIndex(repoPath, {
    version: 1,
    generatedAt: scannedAt,
    byName
  });
  return {
    name,
    realPath: instance.realPath,
    viaAgents: instance.viaAgents,
    newHash: canonical.hash
  };
};

export const syncPushToAllInstances = async (
  repoPath: string,
  name: string,
  options: { readonly now?: Date } = {}
): Promise<readonly SyncPushResult[]> => {
  const instancesIndex = await readInstancesIndex(repoPath);
  const entries = instancesIndex?.byName[name] ?? [];
  const results: SyncPushResult[] = [];
  for (const entry of entries) {
    if (entry.status === "in-sync") continue;
    // Pick any agent the realPath is reached via — pushTo doesn't actually
    // care which agent label, since the realPath is the write target.
    const agent = entry.viaAgents[0];
    if (!agent) continue;
    results.push(await syncPushToInstance(repoPath, name, agent, options));
  }
  return results;
};

export const syncForkInstance = async (
  repoPath: string,
  fromName: string,
  newName: string,
  viaAgent: AgentKind,
  options: { readonly now?: Date } = {}
): Promise<SyncForkResult> => {
  if (!/^[a-z][a-z0-9-]*$/.test(newName)) {
    throw new Error(`Invalid skill name '${newName}': must match ^[a-z][a-z0-9-]*$.`);
  }
  // sanitizePathSegment caps directory names at 96 chars. Reject longer
  // newNames upfront so manifest.name and the on-disk dir stay aligned
  // (otherwise the canonical lands at <truncated> while the manifest stores
  // the full name, and subsequent reads can't find it).
  if (newName.length > 96) {
    throw new Error(`Skill name '${newName}' is too long (${newName.length} > 96 characters).`);
  }
  if (newName === fromName) throw new Error(`Fork target name must differ from source: ${fromName}`);
  const manifest = await readRegistryManifest(repoPath);
  if (manifest.skills.some((skill) => skill.name === newName)) {
    throw new Error(`Canonical '${newName}' already exists — pick a different fork name.`);
  }
  const instancesIndex = await readInstancesIndex(repoPath);
  const instance = findInstance(instancesIndex, fromName, viaAgent);
  if (!instance) throw new Error(`No live instance of '${fromName}' via agent '${viaAgent}' to fork from.`);
  if (!(await pathExists(instance.realPath))) {
    throw new Error(`Instance path missing on disk: ${instance.realPath}`);
  }
  const sourceCanonical = ensureManifestEntry(manifest, fromName);
  const newCanonicalDir = registryCanonicalPath(repoPath, newName);
  assertPathInside(path.join(repoPath, "registry", "skills"), newCanonicalDir, "fork canonical path");
  await copyTree(instance.realPath, newCanonicalDir);
  const newHash = await hashDirectory(newCanonicalDir);
  const scannedAt = (options.now ?? new Date()).toISOString();
  const sha = await gitCommitPaths(
    repoPath,
    [path.relative(repoPath, newCanonicalDir)],
    `fork ${newName} (from ${fromName}, via ${viaAgent})`
  );
  // Add a manifest entry for the new canonical. Reuse the source's source
  // metadata wholesale but override identity + hash + skillDir so the UI
  // treats it as its own canonical going forward.
  const newSkillPackage: SkillPackage = {
    ...sourceCanonical,
    id: newName,
    name: newName,
    directoryName: newName,
    skillDir: newCanonicalDir,
    skillFile: path.join(newCanonicalDir, "SKILL.md"),
    realPath: newCanonicalDir,
    isSymlink: false,
    hash: newHash,
    variantId: `${newName}-canonical`,
    updatedAt: scannedAt
  };
  const nextManifest: RegistryManifest = {
    ...manifest,
    generatedAt: scannedAt,
    skills: [...manifest.skills, newSkillPackage].sort((a, b) => a.name.localeCompare(b.name))
  };
  await writeRegistryManifest(repoPath, nextManifest);
  // Don't yet register an instance for the fork — there isn't one on the
  // user's filesystem until they distribute it. They can run scan/import
  // again later if they want to surface forks per agent.
  return {
    newName,
    fromName,
    viaAgent,
    canonicalDir: newCanonicalDir,
    shortSha: sha
  };
};
