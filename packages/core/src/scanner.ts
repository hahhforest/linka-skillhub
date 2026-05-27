import fs from "node:fs/promises";
import path from "node:path";
import { discoverSources } from "./agents.js";
import { pathExists } from "./fs-helpers.js";
import { asNonEmptyString, parseSkillMarkdown } from "./frontmatter.js";
import { hashDirectory, makeVariantId, sha256 } from "./hash.js";
import { findAgentBoundEvidence, findSafetyIssues, isKebabName } from "./safety.js";
import type { ParseIssue, ScanOptions, SkillPackage, SkillSource, SkillStatus } from "./types.js";

const withExists = async (source: SkillSource): Promise<SkillSource> => ({
  ...source,
  exists: await pathExists(source.rootPath)
});

const findSkillDirs = async (source: SkillSource): Promise<string[]> => {
  if (!source.exists) return [];
  const dirs = new Set<string>();
  const sourceRealPath = await fs.realpath(source.rootPath).catch(() => source.rootPath);

  // R35-C13: when a source opts into includeNested it has explicitly told the
  // scanner "walk freely" — that includes following symlinks that point
  // outside the source root. Hermes is the canonical case: ~/.hermes/skills/
  // contains a mix of real packages (apple/, productivity/, ...) AND symlinks
  // back to ~/.agents/skills/lark-* (the user's central lark-skill bundle).
  // Without this, the scanner silently drops the 25-ish symlinked lark skills
  // even though `find -L` sees them, because realpath escapes the source root
  // and the containment guard rejects the entry. Sources without
  // includeNested still get the tight check — that's the safe-by-default
  // behavior for flat sources where wandering through a symlink would be a
  // bug, not a feature.
  const isContainedSkillDir = async (dir: string): Promise<boolean> => {
    if (source.includeNested) return true;
    const real = await fs.realpath(dir).catch(() => dir);
    const relative = path.relative(sourceRealPath, real);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const rootSkill = path.join(source.rootPath, "SKILL.md");
  if ((await pathExists(rootSkill)) && (await isContainedSkillDir(source.rootPath))) dirs.add(source.rootPath);

  const walk = async (current: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const absolute = path.join(current, entry.name);
      const skillFile = path.join(absolute, "SKILL.md");
      const contained = await isContainedSkillDir(absolute);
      if (!contained) continue;
      if (await pathExists(skillFile)) dirs.add(absolute);
      if (source.includeNested && depth < 5 && entry.isDirectory()) await walk(absolute, depth + 1);
    }
  };

  await walk(source.rootPath, 0);
  return [...dirs].sort((a, b) => a.localeCompare(b));
};

const inferScope = (source: SkillSource, skillDir: string): SkillSource => {
  if (skillDir.includes(`${path.sep}.builtin-skills${path.sep}`)) return { ...source, scope: "builtin", defaultSelected: false };
  if (skillDir.includes(`${path.sep}.system${path.sep}`)) return { ...source, scope: "system", defaultSelected: false };
  return source;
};

// R36-C22: exported because the merge subsystem needs to validate the
// agent's output target/ directory the same way a scan would (status must
// include valid + portable for the merge to land). Keeping the body and
// callsite identical so a single source of truth governs both flows.
export const classifySkill = (input: {
  readonly name?: string;
  readonly description?: string;
  readonly directoryName: string;
  readonly content: string;
  readonly issues: readonly ParseIssue[];
}): { readonly status: readonly SkillStatus[]; readonly issues: readonly ParseIssue[]; readonly evidence: readonly string[] } => {
  const issues: ParseIssue[] = [...input.issues];
  const evidence: string[] = [];
  const status = new Set<SkillStatus>();

  if (!input.name) issues.push({ code: "missing_name", message: "frontmatter.name must be a non-empty string." });
  if (!input.description) issues.push({ code: "missing_description", message: "frontmatter.description must be a non-empty string." });

  if (issues.length > 0) {
    status.add("invalid");
  } else {
    status.add("valid");
    if (input.name && isKebabName(input.name)) {
      status.add("portable");
    } else {
      evidence.push("name_not_kebab_case");
    }
    if (input.name && input.directoryName !== input.name) {
      evidence.push(`source_directory_differs_from_name:${input.directoryName}`);
    }
  }

  const safety = findSafetyIssues(input.content);
  for (const finding of safety) evidence.push(finding.code);
  if (safety.length > 0) status.add("unsafe");

  const agentBound = findAgentBoundEvidence(input.content);
  for (const finding of agentBound) evidence.push(finding.code);
  if (agentBound.length > 0) status.add("agent_bound");

  status.add("unreviewed");
  return { status: [...status], issues, evidence };
};

export const scanSkills = async (options: ScanOptions = {}): Promise<SkillPackage[]> => {
  const cwd = options.cwd ?? process.cwd();
  const now = (options.now ?? new Date()).toISOString();
  const rawSources = await Promise.all(discoverSources(cwd, options.config, options.profileName).map(withExists));
  const selected = options.selectedSourceIds ? new Set(options.selectedSourceIds) : undefined;
  const sources = rawSources.filter((source) => {
    if (selected) return selected.has(source.id);
    return options.includeDefaultExcluded ? source.exists : source.exists && source.defaultSelected;
  });

  const skills: SkillPackage[] = [];
  for (const source of sources) {
    const skillDirs = await findSkillDirs(source);
    for (const skillDir of skillDirs) {
      const scopedSource = inferScope(source, skillDir);
      const skillFile = path.join(skillDir, "SKILL.md");
      const lstat = await fs.lstat(skillDir);
      const realPath = await fs.realpath(skillDir);
      const content = await fs.readFile(skillFile, "utf8");
      const parsed = parseSkillMarkdown(content);
      const name = asNonEmptyString(parsed.frontmatter.name) ?? path.basename(skillDir);
      const description = asNonEmptyString(parsed.frontmatter.description) ?? "";
      const directoryName = path.basename(skillDir);
      const hash = await hashDirectory(realPath);
      const variantId = makeVariantId(scopedSource.agent, scopedSource.scope, hash);
      const classification = classifySkill({
        name: asNonEmptyString(parsed.frontmatter.name),
        description: asNonEmptyString(parsed.frontmatter.description),
        directoryName,
        content,
        issues: parsed.issues
      });

      skills.push({
        id: sha256(`${scopedSource.id}:${realPath}:${hash}`).slice(0, 16),
        name,
        directoryName,
        description,
        source: scopedSource,
        skillDir,
        skillFile,
        realPath,
        isSymlink: lstat.isSymbolicLink(),
        hash,
        variantId,
        frontmatter: parsed.frontmatter,
        status: classification.status,
        issues: classification.issues,
        evidence: classification.evidence,
        updatedAt: now
      });
    }
  }

  const byId = new Map<string, SkillPackage>();
  for (const skill of skills) byId.set(skill.id, skill);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.source.agent.localeCompare(b.source.agent));
};

export const discoverSkillSources = async (cwd = process.cwd(), config?: ScanOptions["config"], profileName?: string): Promise<SkillSource[]> =>
  Promise.all(discoverSources(cwd, config, profileName).map(withExists));
