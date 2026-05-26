#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  applyDistributionPlan,
  applyFrontmatterFix,
  createDistributionPlan,
  gitCommitAll,
  gitPull,
  gitPush,
  gitStatus,
  importSkillsToRepository,
  loadSkillHubConfig,
  readRegistryManifest,
  reviewSkillWithAgent,
  reviewSkillWithRules,
  scanSkills,
  setRemote,
  writeRegistryManifest,
  writeReviewResult,
  type AgentKind,
  type ReviewLanguage,
  type ReviewResult,
  type SkillPackage
} from "@linka-skillhub/core";
import { defaultRepoPath, startServer } from "./server.js";
import { assertInteractiveOrYes, summarizeCopyForPrompt, summarizePlanForPrompt } from "./prompts.js";

const program = new Command();
const invocationCwd = process.env.INIT_CWD ?? process.cwd();

const resolveUserPath = (input: string): string => path.resolve(invocationCwd, input);

interface RootOptions {
  readonly config?: string;
  readonly profile?: string;
}

const loadRuntimeConfig = async () => {
  const opts = program.opts<RootOptions>();
  return loadSkillHubConfig({ cwd: invocationCwd, configPath: opts.config, profileName: opts.profile });
};

const resolveRepoOption = (repo: string | undefined, registryRepo: string): string => (repo ? resolveUserPath(repo) : registryRepo);

const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const parseAgents = (input: string): AgentKind[] =>
  input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean) as AgentKind[];

const KNOWN_AGENTS: readonly AgentKind[] = ["mavis", "opencode", "claude", "codex", "shared"];
const KNOWN_REVIEWERS = ["rules", "mavis", "opencode", "claude", "codex"] as const;
const KNOWN_LANGUAGES: readonly ReviewLanguage[] = ["zh", "en"];

type KnownReviewer = (typeof KNOWN_REVIEWERS)[number];

const reportInvalidFlag = (fieldLabel: string, value: string, allowed: readonly string[]): void => {
  process.stderr.write(`error: unknown ${fieldLabel} '${value}' (allowed: ${allowed.join(", ")})\n`);
  process.exitCode = 2;
};

const assertKnownAgent = (value: string, fieldLabel: string): AgentKind | undefined => {
  if (KNOWN_AGENTS.includes(value as AgentKind)) return value as AgentKind;
  reportInvalidFlag(fieldLabel, value, KNOWN_AGENTS);
  return undefined;
};

const assertKnownReviewer = (value: string): KnownReviewer | undefined => {
  if ((KNOWN_REVIEWERS as readonly string[]).includes(value)) return value as KnownReviewer;
  reportInvalidFlag("reviewer (--reviewer)", value, KNOWN_REVIEWERS);
  return undefined;
};

const assertKnownLanguage = (value: string): ReviewLanguage | undefined => {
  if ((KNOWN_LANGUAGES as readonly string[]).includes(value)) return value as ReviewLanguage;
  reportInvalidFlag("language (--language)", value, KNOWN_LANGUAGES);
  return undefined;
};

const parseAgentsStrict = (input: string, fieldLabel: string): AgentKind[] | undefined => {
  const items = input.split(",").map((s) => s.trim()).filter(Boolean);
  const result: AgentKind[] = [];
  for (const item of items) {
    const agent = assertKnownAgent(item, fieldLabel);
    if (!agent) return undefined;
    result.push(agent);
  }
  return result;
};

const summarize = (skills: Awaited<ReturnType<typeof scanSkills>>): Record<string, number> => ({
  total: skills.length,
  valid: skills.filter((skill) => skill.status.includes("valid")).length,
  portable: skills.filter((skill) => skill.status.includes("portable") && !skill.status.includes("agent_bound") && !skill.status.includes("unsafe")).length,
  agentBound: skills.filter((skill) => skill.status.includes("agent_bound")).length,
  unsafe: skills.filter((skill) => skill.status.includes("unsafe")).length,
  invalid: skills.filter((skill) => skill.status.includes("invalid")).length
});

const compactPlan = (plan: Awaited<ReturnType<typeof createDistributionPlan>>) => ({
  id: plan.id,
  createdAt: plan.createdAt,
  copy: plan.items.filter((item) => item.action === "copy").length,
  overwrite: plan.items.filter((item) => item.action === "overwrite").length,
  skip: plan.items.filter((item) => item.action === "skip").length,
  warnings: plan.warnings,
  items: plan.items.map((item) => ({
    skillId: item.skill.id,
    skill: item.skill.name,
    target: item.target.agent,
    action: item.action,
    reason: item.reason,
    backupPath: item.backupPath
  }))
});

const warnDeprecated = (from: string, to: string): void => {
  process.stderr.write(`[linka-skillhub] '${from}' is deprecated; use '${to}' instead.\n`);
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

const formatRegistryListHuman = (repoPath: string, skills: readonly SkillPackage[]): string => {
  const total = skills.length;
  const autoFixed = skills.filter((skill) => skill.auto_fixed === true).length;
  const byAgent = new Map<AgentKind, number>(KNOWN_AGENTS.map((agent) => [agent, 0] as const));
  for (const skill of skills) {
    byAgent.set(skill.source.agent, (byAgent.get(skill.source.agent) ?? 0) + 1);
  }
  const lines: string[] = [];
  lines.push(`Registry ${repoPath}: ${total} skills (auto_fixed: ${autoFixed})`);
  lines.push(`By agent: ${KNOWN_AGENTS.map((agent) => `${agent} ${byAgent.get(agent) ?? 0}`).join("  ")}`);
  lines.push("");
  if (total === 0) {
    lines.push("(no skills imported; run 'lsh registry import' to populate this registry)");
    return `${lines.join("\n")}\n`;
  }
  const W_ID = 18;
  const W_NAME = 24;
  const W_AGENT = 20;
  lines.push(`${"ID".padEnd(W_ID)}${"NAME".padEnd(W_NAME)}${"AGENT/SCOPE".padEnd(W_AGENT)}STATUS`);
  for (const skill of skills.slice(0, 30)) {
    const id = truncate(skill.id, W_ID - 1).padEnd(W_ID);
    const name = truncate(skill.name, W_NAME - 2).padEnd(W_NAME);
    const agentScope = truncate(`${skill.source.agent}/${skill.source.scope}`, W_AGENT - 2).padEnd(W_AGENT);
    const status = skill.status.join(",");
    lines.push(`${id}${name}${agentScope}${status}`);
  }
  if (total > 30) lines.push(`... ${total - 30} more. Use --json for full output.`);
  return `${lines.join("\n")}\n`;
};

const formatRegistryShowHuman = (skill: SkillPackage): string => {
  const lines: string[] = [];
  lines.push(skill.name);
  if (skill.description) lines.push(skill.description);
  lines.push("");
  lines.push(`Status:  ${skill.status.join(", ")}`);
  lines.push(`Source:  ${skill.source.agent}/${skill.source.scope}`);
  lines.push(`Path:    ${skill.skillDir}`);
  lines.push(`Hash:    ${skill.hash.slice(0, 16)}`);
  lines.push(`Variant: ${skill.variantId}`);
  lines.push(`Updated: ${skill.updatedAt}`);
  if (skill.auto_fixed === true) lines.push(`Auto-fixed: yes`);
  const issuesText =
    skill.issues.length === 0
      ? "(none)"
      : skill.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
  lines.push(`Issues:  ${issuesText}`);
  return `${lines.join("\n")}\n`;
};

const formatReviewSummaryHuman = (
  reviews: readonly ReviewResult[],
  reviewer: string,
  language: ReviewLanguage,
  reviewsDir: string,
  skillNamesById: ReadonlyMap<string, string>
): string => {
  const lines: string[] = [];
  const shareable = reviews.filter((r) => r.recommendation === "share").length;
  const agentBound = reviews.filter((r) => r.recommendation === "keep-private").length;
  const problematic = reviews.filter((r) => r.recommendation === "fix" || r.recommendation === "reject").length;
  const unreviewed = reviews.filter((r) => r.statuses.length === 0 || r.statuses.includes("unreviewed")).length;
  lines.push(`Reviewed ${reviews.length} skills with ${reviewer} (language: ${language})`);
  lines.push(`- shareable: ${shareable}`);
  lines.push(`- agent-bound: ${agentBound}`);
  lines.push(`- problematic: ${problematic}`);
  lines.push(`- unreviewed: ${unreviewed}`);
  lines.push("");
  lines.push(`Wrote ${reviews.length} review records to ${reviewsDir}`);
  const issues = reviews.filter((r) => r.recommendation === "fix" || r.recommendation === "reject").slice(0, 5);
  if (issues.length > 0) {
    lines.push("");
    lines.push("Top issues:");
    for (const review of issues) {
      const name = skillNamesById.get(review.skillId) ?? review.skillId;
      const statusText = review.statuses.length > 0 ? review.statuses.join(",") : review.recommendation;
      const evidenceText = review.evidence.length > 0 ? ` - ${review.evidence.slice(0, 5).join(", ")}` : "";
      lines.push(`  ${name} (${review.skillId}): ${statusText}${evidenceText}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const shortReason = (action: string, reason: string): string => {
  if (action === "copy") return "new";
  if (reason.startsWith("Target already has the same content")) return "target already has same content";
  if (reason.startsWith("Skill is not valid")) return "not portable/shareable by default";
  if (reason.startsWith("Target has different content")) return "different content (backup will be created)";
  const cleaned = reason.replace(/\.$/, "");
  return truncate(cleaned, 60);
};

const formatCopyPreviewHuman = (
  from: AgentKind,
  to: AgentKind,
  plan: Awaited<ReturnType<typeof createDistributionPlan>>
): string => {
  const lines: string[] = [];
  const total = plan.items.length;
  lines.push(`Plan: copy ${from} -> ${to} (${total} items)`);
  const W_ACTION = 11;
  const W_NAME = 24;
  for (const item of plan.items.slice(0, 30)) {
    const action = item.action.padEnd(W_ACTION);
    const name = truncate(item.skill.name, W_NAME - 2).padEnd(W_NAME);
    const reason = shortReason(item.action, item.reason);
    lines.push(`- ${action}${name}${reason}`);
  }
  if (total > 30) lines.push(`... ${total - 30} more items. Use --json for full plan.`);
  lines.push("");
  lines.push(`Plan id: ${plan.id}`);
  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push(`Warnings: ${plan.warnings.length}`);
    for (const warning of plan.warnings.slice(0, 5)) lines.push(`- ${warning}`);
  }
  lines.push("");
  lines.push(
    `Use 'lsh copy apply --from ${from} --to ${to} --yes' to write, or pass --json for full plan.`
  );
  return `${lines.join("\n")}\n`;
};

const formatDistributePreviewHuman = (
  targetAgents: readonly AgentKind[],
  plan: Awaited<ReturnType<typeof createDistributionPlan>>
): string => {
  const lines: string[] = [];
  const total = plan.items.length;
  lines.push(`Plan: distribute to ${targetAgents.join(", ")} (${total} items)`);
  const W_ACTION = 11;
  const W_NAME = 24;
  const W_TARGET = 10;
  for (const item of plan.items.slice(0, 30)) {
    const action = item.action.padEnd(W_ACTION);
    const name = truncate(item.skill.name, W_NAME - 2).padEnd(W_NAME);
    const target = truncate(item.target.agent, W_TARGET - 1).padEnd(W_TARGET);
    const reason = shortReason(item.action, item.reason);
    lines.push(`- ${action}${name}-> ${target}${reason}`);
  }
  if (total > 30) lines.push(`... ${total - 30} more items. Use --json for full plan.`);
  lines.push("");
  lines.push(`Plan id: ${plan.id}`);
  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push(`Warnings: ${plan.warnings.length}`);
    for (const warning of plan.warnings.slice(0, 5)) lines.push(`- ${warning}`);
  }
  lines.push("");
  lines.push(
    `Use 'lsh distribute apply --target ${targetAgents.join(",")} --yes' to write, or pass --json for full plan.`
  );
  return `${lines.join("\n")}\n`;
};

const handleConfirmationFailure = async (promise: Promise<void>): Promise<boolean> => {
  try {
    await promise;
    return true;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return false;
  }
};

program
  .name("lsh")
  .alias("linka-skillhub")
  .description("Local-first registry for code-agent skills across Mavis, OpenCode, Claude Code, Codex, and .agents/skills.")
  .version("0.1.0")
  .option("--config <path>", "Config file path; defaults to nearest linka-skillhub.config.json.")
  .option("--profile <name>", "Active profile name.");

program
  .command("list")
  .alias("scan")
  .description("List scanned skills from the active profile sources.")
  .option("--all", "Include builtin/system sources that are excluded by default.")
  .option("--json", "Print full JSON output.")
  .action(async (options: { all?: boolean; json?: boolean }) => {
    if (process.argv.includes("scan") && !process.argv.includes("list")) warnDeprecated("scan", "list");
    const runtime = await loadRuntimeConfig();
    const skills = await scanSkills({ cwd: invocationCwd, config: runtime.raw, profileName: runtime.profileName, includeDefaultExcluded: options.all ?? false });
    if (options.json) printJson({ summary: summarize(skills), skills });
    else {
      const summary = summarize(skills);
      process.stdout.write(`Profile ${runtime.profileName}. Scanned ${summary.total} skills: ${summary.valid} valid, ${summary.portable} portable, ${summary.agentBound} agent-bound, ${summary.unsafe} unsafe, ${summary.invalid} invalid.\n`);
      for (const skill of skills.slice(0, 30)) {
        process.stdout.write(`${skill.id}  ${skill.name}  ${skill.source.agent}/${skill.source.scope}  ${skill.status.join(",")}\n`);
      }
      if (skills.length > 30) process.stdout.write(`... ${skills.length - 30} more. Use --json for full output.\n`);
    }
  });

const registry = program.command("registry").description("Read and import registry contents.");

registry
  .command("import")
  .description("Copy selected local skills into a registry repository.")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--all", "Include builtin/system sources.")
  .option("--create", "Allow creating a new registry directory if --repo path does not exist.")
  .option("--yes", "Skip confirmation prompt (REQUIRED in non-interactive shells).")
  .action(async (options: { repo?: string; all?: boolean; create?: boolean; yes?: boolean }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const repoStat = await fs.stat(repoPath).then(
      (s) => ({ exists: true, isDir: s.isDirectory() }),
      (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return { exists: false, isDir: false };
        throw err;
      }
    );
    if (repoStat.exists && !repoStat.isDir) {
      process.stderr.write(`error: --repo path exists but is not a directory: ${repoPath}\n`);
      process.exitCode = 2;
      return;
    }
    if (!repoStat.exists && !options.create) {
      process.stderr.write(
        `error: --repo path does not exist: ${repoPath}\n       Pass --create to initialize a new registry directory there.\n`
      );
      process.exitCode = 2;
      return;
    }
    if (!repoStat.exists && options.create) {
      process.stderr.write(`Created new registry directory at ${repoPath}\n`);
    }
    const skills = await scanSkills({ cwd: invocationCwd, config: runtime.raw, profileName: runtime.profileName, includeDefaultExcluded: options.all ?? false });
    await handleConfirmationFailure(
      assertInteractiveOrYes({
        action: "registry import",
        summary: [`Repo: ${repoPath}`, `Will scan: ${skills.length} skills from profile '${runtime.profileName}'`],
        totalItems: skills.length,
        yes: options.yes
      })
    );
    const result = await importSkillsToRepository({ repoPath, cwd: invocationCwd, config: runtime.raw, profileName: runtime.profileName, includeDefaultExcluded: options.all ?? false });
    printJson({ repoPath: result.repoPath, manifestPath: result.manifestPath, imported: result.imported, skipped: result.skipped, total: result.manifest.skills.length });
  });

registry
  .command("list")
  .description("List skills already imported into the active registry.")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--json", "Print full JSON output instead of the human summary.")
  .action(async (options: { repo?: string; json?: boolean }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    if (options.json) {
      printJson({ repoPath, count: manifest.skills.length, skills: manifest.skills });
      return;
    }
    process.stdout.write(formatRegistryListHuman(repoPath, manifest.skills));
  });

registry
  .command("show <id>")
  .description("Show a single skill by id from the active registry.")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--json", "Print full JSON output instead of the human summary.")
  .action(async (id: string, options: { repo?: string; json?: boolean }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    const skill = manifest.skills.find((entry) => entry.id === id);
    if (!skill) {
      process.stderr.write(`Skill not found in registry: ${id}\n`);
      process.exitCode = 2;
      return;
    }
    if (options.json) {
      printJson(skill);
      return;
    }
    process.stdout.write(formatRegistryShowHuman(skill));
  });

program
  .command("review")
  .description("Run deterministic or local-agent review for registry skills.")
  .requiredOption("--reviewer <kind>", "rules | codex | opencode | claude | mavis")
  .option("--language <lang>", "zh | en", "zh")
  .option("--skill <ids>", "comma-separated skill ids")
  .option("--repo <path>", "registry path; defaults to profile registryRepo")
  .option("--json", "Print full JSON output instead of the human summary.")
  .action(async (options: { reviewer: string; language: string; skill?: string; repo?: string; json?: boolean }) => {
    const reviewer = assertKnownReviewer(options.reviewer);
    if (!reviewer) return;
    const language = assertKnownLanguage(options.language);
    if (!language) return;
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    const selected = options.skill ? new Set(options.skill.split(",").map((item) => item.trim())) : undefined;
    const reviews = [];
    for (const skill of manifest.skills) {
      if (selected && !selected.has(skill.id)) continue;
      const review = reviewer === "rules" ? reviewSkillWithRules(skill, language) : await reviewSkillWithAgent(skill, reviewer, { language });
      await writeReviewResult(repoPath, review);
      reviews.push(review);
    }
    if (options.json) {
      printJson({ reviews });
      return;
    }
    const reviewsDir = path.join(repoPath, "registry", "reviews");
    const skillNamesById = new Map(manifest.skills.map((s) => [s.id, s.name] as const));
    process.stdout.write(formatReviewSummaryHuman(reviews, reviewer, language, reviewsDir, skillNamesById));
  });

const distribute = program.command("distribute").description("Distribute registry skills to one or more target agents.");
distribute
  .command("preview")
  .description("Plan distribution to multiple target agents; do not write anything.")
  .requiredOption("--target <agents>", "comma-separated agents: mavis,opencode,claude,codex,shared")
  .option("--skill <ids>", "comma-separated skill ids")
  .option("--include-unsafe", "allow unsafe skills")
  .option("--include-agent-bound", "allow agent-bound skills")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--json", "Print full JSON output instead of the human summary.")
  .action(async (options: { target: string; skill?: string; includeUnsafe?: boolean; includeAgentBound?: boolean; repo?: string; json?: boolean }) => {
    const targetAgents = parseAgentsStrict(options.target, "agent (--target)");
    if (!targetAgents) return;
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const plan = await createDistributionPlan({
      registryPath: repoPath,
      cwd: invocationCwd,
      config: runtime.raw,
      profileName: runtime.profileName,
      backupDir: path.join(runtime.profile.stateDir, "backups"),
      targetAgents,
      skillIds: options.skill ? options.skill.split(",").map((item) => item.trim()) : undefined,
      includeUnsafe: options.includeUnsafe ?? false,
      includeAgentBound: options.includeAgentBound ?? false
    });
    if (options.json) {
      printJson({ plan: compactPlan(plan) });
      return;
    }
    process.stdout.write(formatDistributePreviewHuman(targetAgents, plan));
  });

distribute
  .command("apply")
  .description("Apply a previously planned distribution. Requires --yes in non-interactive shells.")
  .requiredOption("--target <agents>", "comma-separated target agents")
  .option("--skill <ids>", "comma-separated skill ids")
  .option("--plan <id>", "plan id from 'distribute preview'; recomputes if omitted")
  .option("--include-unsafe", "allow unsafe skills")
  .option("--include-agent-bound", "allow agent-bound skills")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--yes", "Skip confirmation prompt (REQUIRED in non-interactive shells).")
  .action(async (options: { target: string; skill?: string; plan?: string; includeUnsafe?: boolean; includeAgentBound?: boolean; repo?: string; yes?: boolean }) => {
    const targetAgents = parseAgentsStrict(options.target, "agent (--target)");
    if (!targetAgents) return;
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const plan = await createDistributionPlan({
      registryPath: repoPath,
      cwd: invocationCwd,
      config: runtime.raw,
      profileName: runtime.profileName,
      backupDir: path.join(runtime.profile.stateDir, "backups"),
      targetAgents,
      skillIds: options.skill ? options.skill.split(",").map((item) => item.trim()) : undefined,
      includeUnsafe: options.includeUnsafe ?? false,
      includeAgentBound: options.includeAgentBound ?? false
    });
    if (options.plan && options.plan !== plan.id) {
      process.stderr.write(
        `error: --plan id mismatch (expected: ${options.plan}, got: ${plan.id})\n` +
          `       The registry or target may have changed since 'distribute preview'. Re-run 'distribute preview' and pass the new plan id.\n`
      );
      process.exitCode = 2;
      return;
    }
    await handleConfirmationFailure(
      assertInteractiveOrYes({
        action: "distribute apply",
        summary: summarizePlanForPrompt(plan),
        totalItems: plan.items.length,
        targets: targetAgents,
        yes: options.yes,
        skipOnEmpty: true
      })
    );
    const run = await applyDistributionPlan(repoPath, plan);
    if (!options.plan) {
      process.stdout.write(`Plan id: ${plan.id}\n`);
    }
    printJson({ plan: compactPlan(plan), run });
  });

const copy = program.command("copy").description("Copy skills from one agent's source to a single target agent.");
copy
  .command("preview")
  .description("Plan A->B copy operations; do not write anything.")
  .requiredOption("--from <agent>", "source agent: mavis | opencode | claude | codex | shared")
  .requiredOption("--to <agent>", "target agent")
  .option("--skill <ids>", "comma-separated skill ids")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--json", "Print full JSON output instead of the human summary.")
  .action(async (options: { from: string; to: string; skill?: string; repo?: string; json?: boolean }) => {
    const from = assertKnownAgent(options.from, "agent (--from)");
    if (!from) return;
    const to = assertKnownAgent(options.to, "agent (--to)");
    if (!to) return;
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    const filtered = manifest.skills.filter((skill) => skill.source.agent === from);
    const plan = await createDistributionPlan({
      registryPath: repoPath,
      cwd: invocationCwd,
      config: runtime.raw,
      profileName: runtime.profileName,
      backupDir: path.join(runtime.profile.stateDir, "backups"),
      targetAgents: [to],
      skillIds: options.skill ? options.skill.split(",").map((item) => item.trim()) : filtered.map((skill) => skill.id),
      includeUnsafe: false,
      includeAgentBound: false
    });
    if (options.json) {
      printJson({ from, to, plan: compactPlan(plan) });
      return;
    }
    process.stdout.write(formatCopyPreviewHuman(from, to, plan));
  });

copy
  .command("apply")
  .description("Apply a previously previewed plan. Requires --yes in non-interactive shells.")
  .requiredOption("--from <agent>", "source agent")
  .requiredOption("--to <agent>", "target agent")
  .option("--skill <ids>", "comma-separated skill ids; default: all skills under --from")
  .option("--plan <id>", "plan id from 'copy preview'; recomputes if omitted")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--yes", "Skip confirmation prompt (REQUIRED in non-interactive shells).")
  .action(async (options: { from: string; to: string; skill?: string; plan?: string; repo?: string; yes?: boolean }) => {
    const from = assertKnownAgent(options.from, "agent (--from)");
    if (!from) return;
    const to = assertKnownAgent(options.to, "agent (--to)");
    if (!to) return;
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    const filtered = manifest.skills.filter((skill) => skill.source.agent === from);
    const plan = await createDistributionPlan({
      registryPath: repoPath,
      cwd: invocationCwd,
      config: runtime.raw,
      profileName: runtime.profileName,
      backupDir: path.join(runtime.profile.stateDir, "backups"),
      targetAgents: [to],
      skillIds: options.skill ? options.skill.split(",").map((item) => item.trim()) : filtered.map((skill) => skill.id),
      includeUnsafe: false,
      includeAgentBound: false
    });
    if (options.plan && options.plan !== plan.id) {
      process.stderr.write(
        `error: --plan id mismatch (expected: ${options.plan}, got: ${plan.id})\n` +
          `       The registry or target may have changed since 'copy preview'. Re-run 'copy preview' and pass the new plan id.\n`
      );
      process.exitCode = 2;
      return;
    }
    await handleConfirmationFailure(
      assertInteractiveOrYes({
        action: "copy apply",
        summary: summarizeCopyForPrompt(from, to, plan.items),
        totalItems: plan.items.length,
        targets: [to],
        yes: options.yes,
        skipOnEmpty: true
      })
    );
    const run = await applyDistributionPlan(repoPath, plan);
    if (!options.plan) {
      process.stdout.write(`Plan id: ${plan.id}\n`);
    }
    printJson({ from, to, plan: compactPlan(plan), run });
  });

const repo = program.command("repo").description("Manage the registry Git repository.");
repo
  .command("status")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .action(async (options: { repo?: string }) => {
    const runtime = await loadRuntimeConfig();
    process.stdout.write(`${await gitStatus(resolveRepoOption(options.repo, runtime.profile.registryRepo))}\n`);
  });
repo
  .command("connect")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .requiredOption("--remote <url>", "GitHub repository URL")
  .action(async (options: { repo?: string; remote: string }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    await setRemote(repoPath, options.remote);
    process.stdout.write(`${await gitStatus(repoPath)}\n`);
  });
repo
  .command("pull")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .action(async (options: { repo?: string }) => {
    const runtime = await loadRuntimeConfig();
    process.stdout.write(`${await gitPull(resolveRepoOption(options.repo, runtime.profile.registryRepo))}\n`);
  });
repo
  .command("push")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--message <message>", "commit message", "Update skill registry")
  .option("--yes", "Skip confirmation prompt (REQUIRED in non-interactive shells).")
  .action(async (options: { repo?: string; message: string; yes?: boolean }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const status = await gitStatus(repoPath);
    await handleConfirmationFailure(
      assertInteractiveOrYes({
        action: "repo push",
        summary: [`Repo: ${repoPath}`, `Message: ${options.message}`, status ? `Git status:\n${status}` : "Working tree clean"],
        totalItems: 1,
        yes: options.yes
      })
    );
    const commit = await gitCommitAll(repoPath, options.message);
    const output = await gitPush(repoPath);
    printJson({ commit, output });
  });

const configCmd = program.command("config").description("Read resolved linka-skillhub configuration.");
configCmd
  .command("list")
  .description("Print active profile and resolved paths.")
  .action(async () => {
    const runtime = await loadRuntimeConfig();
    printJson({
      activeProfile: runtime.profileName,
      stateDir: runtime.profile.stateDir,
      registryRepo: runtime.profile.registryRepo,
      agents: Object.entries(runtime.profile.agents ?? {}).map(([kind, agent]) => ({
        kind,
        targetDir: agent?.targetDir,
        sourceDirs: agent?.sourceDirs?.map((source) => ({ path: source.path, scope: source.scope, defaultSelected: source.defaultSelected })) ?? []
      }))
    });
  });

const profileCmd = program.command("profile").description("Print the active profile summary.");
profileCmd
  .command("show")
  .description("Print the active profile name and resolved paths.")
  .action(async () => {
    const runtime = await loadRuntimeConfig();
    printJson({ activeProfile: runtime.profileName, stateDir: runtime.profile.stateDir, registryRepo: runtime.profile.registryRepo });
  });

const fix = program.command("fix").description("Repair or annotate registry content in place.");
fix
  .command("frontmatter <id>")
  .description("Auto-fill SKILL.md frontmatter for an invalid skill. By default, only writes under the active profile's sandbox sources.")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--allow-unsafe-source", "Allow writing to skill sources outside the active profile's sandbox.")
  .option("--dry-run", "Print what would be written without modifying any files.")
  .option("--yes", "Skip confirmation prompt (REQUIRED in non-interactive shells).")
  .action(async (id: string, options: { repo?: string; allowUnsafeSource?: boolean; dryRun?: boolean; yes?: boolean }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    const skill = manifest.skills.find((entry) => entry.id === id);
    if (!skill) {
      process.stderr.write(`Skill not found in registry: ${id}\n`);
      process.exitCode = 2;
      return;
    }
    const profileRoot = options.dryRun
      ? undefined
      : runtime.profileName === "mirror"
        ? path.resolve(invocationCwd, ".sandbox")
        : options.allowUnsafeSource
          ? invocationCwd
          : runtime.profile.stateDir;
    const fixResult = await applyFrontmatterFix(skill, {
      cwd: invocationCwd,
      profileRoot,
      allowUnsafeSource: options.allowUnsafeSource === true || options.dryRun === true || runtime.profileName === "mirror",
      dryRun: options.dryRun
    });
    if (fixResult.applied) {
      const updatedSkills = manifest.skills.map((entry) => {
        if (entry.id !== id) return entry;
        return {
          ...entry,
          frontmatter: { ...(fixResult.newFrontmatter ?? {}) },
          issues: [],
          status: entry.status.filter((s) => s !== "invalid"),
          auto_fixed: true
        };
      });
      await handleConfirmationFailure(
        assertInteractiveOrYes({
          action: "fix frontmatter",
          summary: [
            `Skill: ${skill.name} (${id})`,
            `Source dir: ${skill.skillDir}`,
            `New frontmatter: ${JSON.stringify(fixResult.newFrontmatter)}`,
            `Will rewrite manifest: ${repoPath}/registry/skills.json`
          ],
          totalItems: 1,
          yes: options.yes
        })
      );
      const nextManifest = { ...manifest, skills: updatedSkills, generatedAt: new Date().toISOString() };
      await writeRegistryManifest(repoPath, nextManifest);
      process.stdout.write(`Frontmatter applied to ${skill.skillFile}\n`);
    } else {
      process.stdout.write(`No change: ${fixResult.reason ?? "unknown"}\n`);
      if (fixResult.reason === "dry_run" && fixResult.newFrontmatter) {
        process.stdout.write(`Would write frontmatter: ${JSON.stringify(fixResult.newFrontmatter)}\n`);
      }
    }
    printJson({ id, ...fixResult });
  });

program
  .command("serve")
  .description("Start the local Web console and API server.")
  .option("--host <host>", "host", "127.0.0.1")
  .option("--port <port>", "port", "4873")
  .option("--repo <path>", "registry path; defaults to profile registryRepo")
  .action(async (options: { host: string; port: string; repo?: string }) => {
    const runtime = await loadRuntimeConfig();
    const port = Number.parseInt(options.port, 10);
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo ?? defaultRepoPath(invocationCwd));
    startServer({ host: options.host, port, repoPath, cwd: invocationCwd, config: runtime.raw, profileName: runtime.profileName, stateDir: runtime.profile.stateDir });
    process.stdout.write(`linka-skillhub running at http://${options.host}:${port} (profile ${runtime.profileName}, repo ${repoPath})\n`);
  });

const argv = process.argv[2] === "--" ? [process.argv[0]!, process.argv[1]!, ...process.argv.slice(3)] : process.argv;

const friendlyMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  const profileMatch = raw.match(/Profile not found in linka-skillhub config:\s*(\S+)/);
  if (profileMatch) return `error: profile '${profileMatch[1]}' not found in linka-skillhub.config.json`;
  if (raw.includes("ENOENT") && /spawn (?:git|.* git)\b/.test(raw)) {
    return "error: git command failed; directory may not exist or is not a git repo";
  }
  const enoentPath = raw.match(/ENOENT[^']*'([^']+)'/) ?? raw.match(/ENOENT[^"]*"([^"]+)"/);
  if (enoentPath) return `error: path not found: ${enoentPath[1]}`;
  if (raw.includes("ENOENT")) return "error: path not found";
  const firstLine = raw.split("\n", 1)[0]?.trim() ?? raw;
  return `error: ${firstLine}`;
};

try {
  await program.parseAsync(argv);
} catch (error) {
  process.stderr.write(`${friendlyMessage(error)}\n`);
  if (process.env.LINKA_SKILLHUB_DEBUG === "1" && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(2);
}
