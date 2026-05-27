import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { asNonEmptyString, parseSkillMarkdown } from "./frontmatter.js";
import { classifySkill } from "./scanner.js";
import type {
  AgentKind,
  CanonicalSyncStatus,
  RegistryInstance,
  RegistryInstancesIndex,
  RegistryManifest,
  SkillPackage,
  SyncForkResult,
  SyncMergeResult,
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

// =============================================================================
// R36-C22: merge subsystem. Multi-instance reconciliation requires reasoning
// about what each agent's edits actually do — the kind of judgment we delegate
// to a code agent, not to a diff algorithm. The flow:
//
//   1. Prepare a workspace under <repo>/.merges/<short-uid>/ that contains a
//      gitignored copy of each chosen instance plus an empty target/ dir and
//      an INSTRUCTIONS.md briefing.
//   2. Spawn the user's chosen agent CLI with cwd=workspace. The agent reads
//      INSTRUCTIONS.md, walks the source copies with its file tools, and
//      writes its merged version into target/. Single-shot CLI invocation —
//      claude -p / codex exec / opencode run / mavis ask are all agentic
//      (they run a full tool loop inside one CLI call).
//   3. Validate target/ against the same classifier scanSkills uses. If the
//      target fails strict validation (missing SKILL.md, bad frontmatter,
//      classifier returns "unsafe" / "invalid"), append the failure reasons
//      to INSTRUCTIONS.md and re-run the agent ONCE. After a second failure
//      we give up and surface the reasons — the workspace stays on disk so
//      the user can inspect what the agent produced.
//   4. On success: copy target/ → registry/skills/<name>/, git commit
//      `merge <name> (a + b)`, update manifest hash, refresh instance
//      statuses (now everyone is "drifted" against the new canonical;
//      that's the user's cue to run push-all).
//
// Skills are directories, so every read/write path walks the tree; the
// validateMergeTarget hash is computed via hashDirectory so the merge tells
// us "the canonical now equals this hash" the same way pull / push do.

// agent CLIs in non-interactive mode require explicit permission flags before
// they'll run filesystem tools — otherwise the model emits text but never
// writes target/. We pass minimal-but-sufficient flags rather than the
// blanket --dangerously-skip-permissions for claude (cwd is locked to the
// per-merge workspace by spawn options, so the blast radius is bounded).
//   - claude: --permission-mode bypassPermissions limits the agent to tools,
//             without bypassing safety checks like prompt injection guards.
//   - codex: --dangerously-bypass-approvals-and-sandbox (yes, the literal
//             flag name) — codex exec otherwise asks for tool approval and
//             stalls in non-interactive runs. Equivalent to claude's bypass.
//   - opencode / mavis: their run/ask non-interactive modes already auto-approve
//             tools in their own configs; no flag needed.
// Exported for tests / introspection — callers should use `runAgentMerge`, not
// look up commands themselves. The shape is intentionally readonly so a test
// can assert specific argv flags (e.g. permission bypass) without risking
// mutation from the test side.
export const AGENT_CLI_COMMANDS: Partial<Record<AgentKind, readonly string[]>> = {
  claude: ["claude", "-p", "--permission-mode", "bypassPermissions"],
  codex: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "-"],
  opencode: ["opencode", "run", "--dangerously-skip-permissions", "-"],
  mavis: ["mavis", "ask", "-"]
};

const MERGE_DEFAULT_TIMEOUT_MS = 600_000;

// Per-skill in-process mutex. Two concurrent merges on the same canonical
// would race on manifest writes and the canonical dir copy. Different skills
// are independent so we key by name. Same-process callers chain through the
// Map; cross-process callers would have to coordinate via filesystem lock
// (out of scope — single linka-skillhub daemon is the assumption).
//
// The cleanup compares against the SAME swallowed-error promise we stored,
// not a fresh `.catch(() => undefined)` — calling .catch twice creates two
// distinct Promise objects, and the `===` check would always be false. That
// would leak one Map entry per skill name ever merged.
const mergeLocks = new Map<string, Promise<unknown>>();
const withMergeLock = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
  const prior = mergeLocks.get(name) ?? Promise.resolve();
  const next = prior.then(run, run);
  const stored = next.catch(() => undefined);
  mergeLocks.set(name, stored);
  try {
    return await next;
  } finally {
    if (mergeLocks.get(name) === stored) mergeLocks.delete(name);
  }
};

// Letters from a-z (lowercase) only — kept readable so users debugging a
// merge can copy / paste the workspace dir without quoting woes.
const generateWorkspaceId = (): string => {
  const bytes = randomBytes(5);
  let out = "";
  for (const byte of bytes) {
    out += String.fromCharCode(97 + (byte % 26));
  }
  return out;
};

// Resolve which on-disk instance corresponds to each fromAgent. The user
// names agents in CLI / WebUI; we look them up against the manifest's live
// instances and reject upfront if any one is missing — saves spawning the
// agent only for the prompt to discover a broken path.
interface ResolvedFromInstance {
  readonly agent: AgentKind;
  readonly realPath: string;
  readonly subdir: string;            // "a" / "b" / ... in workspaceDir
}

const resolveFromInstances = (
  instancesIndex: RegistryInstancesIndex | null,
  name: string,
  fromAgents: readonly AgentKind[]
): ResolvedFromInstance[] => {
  if (fromAgents.length < 2) {
    throw new Error(`merge requires at least 2 source agents; got ${fromAgents.length}.`);
  }
  const seen = new Set<AgentKind>();
  const resolved: ResolvedFromInstance[] = [];
  for (let index = 0; index < fromAgents.length; index += 1) {
    const agent = fromAgents[index]!;
    if (seen.has(agent)) {
      throw new Error(`merge sources must be distinct; '${agent}' appears more than once.`);
    }
    seen.add(agent);
    const instance = findInstance(instancesIndex, name, agent);
    if (!instance) {
      throw new Error(`No live instance of '${name}' via agent '${agent}' to merge from.`);
    }
    // The subdir letter aligns with the order the user passed in: first agent
    // is `a/`, second is `b/`. This shows up in the commit subject too
    // (`merge <name> (a + b)`) so the timeline matches what the user typed.
    const letter = String.fromCharCode(97 + index);
    resolved.push({ agent, realPath: instance.realPath, subdir: letter });
  }
  return resolved;
};

const buildInstructionsMarkdown = (
  name: string,
  workspaceDir: string,
  sources: readonly ResolvedFromInstance[]
): string => {
  const lines: string[] = [
    `# Merge task: ${name}`,
    "",
    "You are reconciling a single skill that has diverged across multiple agents.",
    "Each source directory below is a complete copy of one agent's current",
    "version of this skill — they share a name but their contents differ.",
    "",
    "## Source directories (read these)",
    ""
  ];
  for (const source of sources) {
    lines.push(`- \`${source.subdir}/\` — from agent **${source.agent}** (originally at \`${source.realPath}\`)`);
    lines.push(`  - absolute: \`${path.join(workspaceDir, source.subdir)}\``);
  }
  lines.push("");
  lines.push("## Target directory (write your merged result here)");
  lines.push("");
  lines.push(`- \`target/\` — empty now, must contain your final merged skill when you exit`);
  lines.push(`  - absolute: \`${path.join(workspaceDir, "target")}\``);
  lines.push("");
  lines.push("## Rules");
  lines.push("");
  lines.push("1. **Skills are directories, not single files.** Walk the entire tree of each source. Read every file, not just SKILL.md.");
  lines.push("2. **Reason about function, not text.** Don't blindly concatenate or interleave. Understand what each version is doing, identify overlap vs. additive changes vs. genuine conflicts, then produce one coherent merged version.");
  lines.push("3. **Preserve the canonical name.** `target/SKILL.md` MUST have YAML frontmatter with `name: " + name + "` and a non-empty `description:`.");
  lines.push("4. **Keep it valid + portable.** Don't introduce absolute paths to a specific machine, agent-only environment variables, or commands that only one agent ships with. The merged skill will be redistributed to all agents.");
  lines.push("5. **Use your file tools.** Read source files via the workspace-relative paths above; write your output by creating files under `target/`.");
  lines.push("6. **Exit cleanly when done.** No interactive prompts; produce the final tree under `target/` and stop.");
  return lines.join("\n") + "\n";
};

const buildWorkspaceReadme = (name: string, sources: readonly ResolvedFromInstance[]): string => {
  const lines: string[] = [
    `# Merge workspace: ${name}`,
    "",
    "This directory is the scratch space linka-skillhub created for a merge run.",
    "It is **NOT** part of the registry git history (the parent `.merges/` is",
    "gitignored). Linka-skillhub keeps it on disk after the merge so you can",
    "inspect what the agent did. Remove it with `rm -rf` when you're done.",
    "",
    "## Layout",
    "",
    "- `INSTRUCTIONS.md` — task briefing the agent received.",
    "- `target/` — the agent's output (becomes the new canonical on success).",
    ""
  ];
  for (const source of sources) {
    lines.push(`- \`${source.subdir}/\` — copy of \`${source.agent}\`'s instance at the time the merge started.`);
  }
  return lines.join("\n") + "\n";
};

interface PrepareMergeWorkspaceResult {
  readonly workspaceDir: string;
  readonly targetDir: string;
  readonly instructionsPath: string;
  readonly sources: readonly ResolvedFromInstance[];
}

export const prepareMergeWorkspace = async (
  repoPath: string,
  name: string,
  fromAgents: readonly AgentKind[],
  options: { readonly workspaceId?: string } = {}
): Promise<PrepareMergeWorkspaceResult> => {
  const instancesIndex = await readInstancesIndex(repoPath);
  const sources = resolveFromInstances(instancesIndex, name, fromAgents);
  for (const source of sources) {
    if (!(await pathExists(source.realPath))) {
      throw new Error(`Source instance for agent '${source.agent}' missing on disk: ${source.realPath}`);
    }
  }
  const mergesRoot = path.join(repoPath, ".merges");
  await ensureDir(mergesRoot);
  // Single-line `*` makes the entire .merges/ subtree invisible to git from
  // its own .gitignore — no need for the parent repo to know the directory
  // exists. Writing every run is idempotent and cheap.
  await fs.writeFile(path.join(mergesRoot, ".gitignore"), "*\n", "utf8");
  const workspaceId = options.workspaceId ?? generateWorkspaceId();
  const workspaceDir = path.join(mergesRoot, `${sanitizePathSegment(name)}-${workspaceId}`);
  assertPathInside(mergesRoot, workspaceDir, "merge workspace path");
  await ensureDir(workspaceDir);
  for (const source of sources) {
    const destDir = path.join(workspaceDir, source.subdir);
    await copyTree(source.realPath, destDir);
  }
  const targetDir = path.join(workspaceDir, "target");
  await ensureDir(targetDir);
  const instructionsPath = path.join(workspaceDir, "INSTRUCTIONS.md");
  await fs.writeFile(instructionsPath, buildInstructionsMarkdown(name, workspaceDir, sources), "utf8");
  await fs.writeFile(path.join(workspaceDir, "README.md"), buildWorkspaceReadme(name, sources), "utf8");
  return { workspaceDir, targetDir, instructionsPath, sources };
};

// Runner abstraction: lets tests inject a mock that writes target/ directly
// without spawning a real agent CLI. Production code passes runAgentMerge as
// the default. The runner gets the prepared workspace + chosen agent and is
// expected to make the agent populate workspaceDir/target/ before resolving.
export type MergeRunner = (params: {
  readonly workspaceDir: string;
  readonly byAgent: AgentKind;
  readonly timeoutMs: number;
  readonly attempt: 1 | 2;
}) => Promise<{ stdout: string; stderr: string }>;

const agentCliPrompt = (workspaceDir: string): string =>
  [
    `You're running inside the merge workspace at ${workspaceDir}.`,
    `Step 1: read the file INSTRUCTIONS.md in this directory in full.`,
    `Step 2: follow it — read each source subdirectory, then write your merged result into target/.`,
    `Step 3: exit when target/ contains your final merged skill.`,
    `Do not stop to ask questions. Use your file tools.`
  ].join("\n");

export const runAgentMerge: MergeRunner = ({ workspaceDir, byAgent, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const command = AGENT_CLI_COMMANDS[byAgent];
    if (!command) {
      reject(new Error(`No CLI runner is wired for agent '${byAgent}'. Supported: ${Object.keys(AGENT_CLI_COMMANDS).join(", ")}.`));
      return;
    }
    const [bin, ...args] = command;
    if (!bin) {
      reject(new Error(`Empty CLI command for agent '${byAgent}'.`));
      return;
    }
    // cwd=workspaceDir so file tools resolve relative paths (`target/`,
    // `a/SKILL.md`) the same way the instructions document them. agents
    // like claude --print still respect cwd for their file tool.
    const child = spawn(bin, args, { cwd: workspaceDir, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Merge agent '${byAgent}' timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error((stderr.trim() || `${byAgent} exited with code ${code ?? "unknown"}.`)));
    });
    child.stdin.end(agentCliPrompt(workspaceDir));
  });

export interface ValidateMergeTargetResult {
  readonly ok: boolean;
  readonly hash: string;
  readonly reasons: readonly string[];
}

export const validateMergeTarget = async (
  targetDir: string,
  expectedName: string
): Promise<ValidateMergeTargetResult> => {
  const reasons: string[] = [];
  const skillFile = path.join(targetDir, "SKILL.md");
  if (!(await pathExists(skillFile))) {
    return { ok: false, hash: "", reasons: [`target/SKILL.md does not exist — write your merged skill into target/, not into a/, b/, or anywhere else.`] };
  }
  const content = await fs.readFile(skillFile, "utf8");
  const parsed = parseSkillMarkdown(content);
  const name = asNonEmptyString(parsed.frontmatter.name);
  const description = asNonEmptyString(parsed.frontmatter.description);
  if (name !== expectedName) {
    reasons.push(`target/SKILL.md frontmatter has name='${name ?? "(missing)"}'; must be name='${expectedName}'.`);
  }
  if (!description) {
    reasons.push(`target/SKILL.md frontmatter is missing a non-empty 'description:'.`);
  }
  const classification = classifySkill({
    name,
    description,
    directoryName: expectedName,
    content,
    issues: parsed.issues
  });
  if (classification.status.includes("unsafe")) {
    reasons.push(`target/SKILL.md classified as unsafe (${classification.issues.map((i) => i.code).join(", ") || "unspecified"}). Remove the unsafe content.`);
  }
  if (classification.status.includes("invalid")) {
    reasons.push(`target/SKILL.md classified as invalid (${classification.issues.map((i) => i.code).join(", ") || "unspecified"}).`);
  }
  if (!classification.status.includes("valid")) {
    reasons.push(`target/SKILL.md is not 'valid'. Frontmatter must include name + description and the body must be present.`);
  }
  if (!classification.status.includes("portable")) {
    reasons.push(`target/SKILL.md is not 'portable'. Remove machine-local paths, agent-only env vars, or single-agent commands so the merged skill can be redistributed.`);
  }
  const hash = await hashDirectory(targetDir);
  return { ok: reasons.length === 0, hash, reasons: reasons.length === 0 ? [] : reasons };
};

const appendRetryFeedback = async (
  instructionsPath: string,
  reasons: readonly string[]
): Promise<void> => {
  const block = [
    "",
    "## ⚠️ Previous attempt failed strict validation",
    "",
    "Your earlier output of `target/` did not pass linka-skillhub's checks. Fix the following before exiting again:",
    "",
    ...reasons.map((reason) => `- ${reason}`),
    "",
    "Re-read the source directories if you need to. Overwrite `target/` with the corrected merge."
  ].join("\n") + "\n";
  await fs.appendFile(instructionsPath, block, "utf8");
};

export const syncMergeInstances = async (
  repoPath: string,
  name: string,
  fromAgents: readonly AgentKind[],
  byAgent: AgentKind,
  options: { readonly now?: Date; readonly timeoutMs?: number; readonly runner?: MergeRunner; readonly workspaceId?: string } = {}
): Promise<SyncMergeResult> =>
  withMergeLock(name, async () => {
    const manifest = await readRegistryManifest(repoPath);
    const canonical = ensureManifestEntry(manifest, name);
    const prep = await prepareMergeWorkspace(repoPath, name, fromAgents, { workspaceId: options.workspaceId });
    const runner = options.runner ?? runAgentMerge;
    const timeoutMs = options.timeoutMs ?? MERGE_DEFAULT_TIMEOUT_MS;
    let attempts: 1 | 2 = 1;
    let validation: ValidateMergeTargetResult;
    await runner({ workspaceDir: prep.workspaceDir, byAgent, timeoutMs, attempt: 1 });
    validation = await validateMergeTarget(prep.targetDir, name);
    if (!validation.ok) {
      await appendRetryFeedback(prep.instructionsPath, validation.reasons);
      // Wipe target/ before the retry. The first run may have written
      // scratch files we don't catch (validateMergeTarget only inspects
      // SKILL.md). Without a wipe, garbage from attempt 1 plus a
      // freshly-rewritten SKILL.md from attempt 2 would both end up copied
      // into the canonical.
      await fs.rm(prep.targetDir, { recursive: true, force: true });
      await ensureDir(prep.targetDir);
      attempts = 2;
      await runner({ workspaceDir: prep.workspaceDir, byAgent, timeoutMs, attempt: 2 });
      validation = await validateMergeTarget(prep.targetDir, name);
      if (!validation.ok) {
        throw new Error(
          `Merge of '${name}' failed strict validation after 2 attempts. Workspace kept at ${prep.workspaceDir}. Reasons: ${validation.reasons.join(" | ")}`
        );
      }
    }
    const canonicalDir = registryCanonicalPath(repoPath, name);
    assertPathInside(path.join(repoPath, "registry", "skills"), canonicalDir, "registry canonical path");
    // Stash the old canonical content to a sibling tmp dir BEFORE overwriting,
    // so a later git-commit / manifest-write failure can restore the canonical
    // to the pre-merge state. Without this rollback the canonical dir would
    // hold the agent's output while manifest still records the old hash —
    // an inconsistency the user can only fix via manual `git restore` and a
    // wasted agent CLI run.
    const stashDir = path.join(prep.workspaceDir, ".canonical-pre-merge");
    if (await pathExists(canonicalDir)) {
      await copyTree(canonicalDir, stashDir);
    }
    let newHash: string;
    let sha: string;
    const oldHash = canonical.hash;
    const scannedAt = (options.now ?? new Date()).toISOString();
    const agentList = prep.sources.map((source) => source.agent).join(" + ");
    try {
      await copyTree(prep.targetDir, canonicalDir);
      newHash = await hashDirectory(canonicalDir);
      sha = await gitCommitPaths(
        repoPath,
        [path.relative(repoPath, canonicalDir)],
        `merge ${name} (${agentList})`
      );
      const updatedCanonical: SkillPackage = {
        ...canonical,
        hash: newHash,
        updatedAt: scannedAt
      };
      await writeManifestWithUpdatedSkill(repoPath, manifest, updatedCanonical, scannedAt);
    } catch (error) {
      // Roll back: restore the canonical to its pre-merge content. We
      // intentionally leave the stash + workspace + INSTRUCTIONS.md on disk
      // so the user can inspect what the agent produced.
      if (await pathExists(stashDir)) {
        await copyTree(stashDir, canonicalDir);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Merge of '${name}' produced a valid target/ but commit/manifest write failed (${reason}). Canonical reverted to pre-merge state. Workspace kept at ${prep.workspaceDir}.`
      );
    }
    const instancesIndex = await readInstancesIndex(repoPath);
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
      .filter((entry) => entry.status === "drifted")
      .map((entry) => entry.realPath);
    return {
      name,
      fromAgents: prep.sources.map((source) => source.agent),
      byAgent,
      workspaceDir: prep.workspaceDir,
      oldHash,
      newHash,
      shortSha: sha,
      attempts,
      otherDrifted
    };
  });
