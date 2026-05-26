#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command, CommanderError } from "commander";
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
  type FrontmatterFixResult,
  type ReviewLanguage,
  type ReviewResult,
  type SkillPackage
} from "@linka-skillhub/core";
import { defaultRepoPath, startServer } from "./server.js";
import { assertInteractiveOrYes, summarizeCopyForPrompt, summarizePlanForPrompt } from "./prompts.js";

// ANSI color helpers. Honor https://no-color.org/ and stdout TTY by default;
// FORCE_COLOR=1 opts in when stdout is piped (tests / wrappers). Re-evaluated
// every call so env changes mid-process and isTTY take immediate effect.
// JSON output never flows through these helpers (see printJson).
const useColors = (): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
};
const colorize = (text: string, code: string): string => (useColors() ? `\x1b[${code}m${text}\x1b[0m` : text);
const c = {
  red: (s: string) => colorize(s, "31"),
  green: (s: string) => colorize(s, "32"),
  yellow: (s: string) => colorize(s, "33"),
  blue: (s: string) => colorize(s, "34"),
  cyan: (s: string) => colorize(s, "36"),
  gray: (s: string) => colorize(s, "90"),
  bold: (s: string) => colorize(s, "1"),
  dim: (s: string) => colorize(s, "2")
};
const colorStatusToken = (token: string): string => {
  if (token === "valid" || token === "portable") return c.green(token);
  if (token === "agent_bound") return c.yellow(token);
  if (token === "invalid" || token === "unsafe") return c.red(token);
  return token;
};
const colorStatusList = (tokens: readonly string[], sep: string): string => tokens.map(colorStatusToken).join(sep);
const colorActionPadded = (action: string, padded: string): string => {
  if (action === "copy") return c.green(padded);
  if (action === "overwrite") return c.yellow(padded);
  if (action === "skip") return c.gray(padded);
  return padded;
};
const errorPrefix = (): string => c.bold(c.red("error:"));
const warningPrefix = (): string => c.yellow("warning:");

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

const KNOWN_AGENTS: readonly AgentKind[] = ["mavis", "opencode", "claude", "codex", "shared"];
const KNOWN_REVIEWERS = ["rules", "mavis", "opencode", "claude", "codex"] as const;
const KNOWN_LANGUAGES: readonly ReviewLanguage[] = ["zh", "en"];

type KnownReviewer = (typeof KNOWN_REVIEWERS)[number];

const reportInvalidFlag = (fieldLabel: string, value: string, allowed: readonly string[]): void => {
  process.stderr.write(`${errorPrefix()} unknown ${fieldLabel} '${value}' (allowed: ${allowed.join(", ")})\n`);
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

const parseSkillIds = (input: string | undefined): string[] | undefined => {
  if (!input) return undefined;
  const ids = input.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length === 0 ? undefined : ids;
};

// Filter user-supplied --skill ids against the active registry manifest.
// Returns:
//   - undefined when no ids were requested ("all" — preserve default behavior)
//   - string[] of known ids (warns to stderr for any unknown ids in the request)
//   - null when every requested id is unknown (sets exitCode=2; caller must abort)
const filterKnownSkillIds = (
  requested: string[] | undefined,
  manifest: { readonly skills: readonly { readonly id: string }[] }
): string[] | null | undefined => {
  if (!requested || requested.length === 0) return undefined;
  const validIds = new Set(manifest.skills.map((skill) => skill.id));
  const known: string[] = [];
  const unknown: string[] = [];
  for (const id of requested) {
    if (validIds.has(id)) known.push(id);
    else unknown.push(id);
  }
  for (const id of unknown) {
    process.stderr.write(`${warningPrefix()} unknown skill id: ${id}\n`);
  }
  if (known.length === 0) {
    process.stderr.write(`${errorPrefix()} no valid skill ids resolved\n`);
    process.exitCode = 2;
    return null;
  }
  return known;
};

const summarize = (skills: Awaited<ReturnType<typeof scanSkills>>): Record<string, number> => ({
  total: skills.length,
  valid: skills.filter((skill) => skill.status.includes("valid")).length,
  portable: skills.filter((skill) => skill.status.includes("portable") && !skill.status.includes("agent_bound") && !skill.status.includes("unsafe")).length,
  agentBound: skills.filter((skill) => skill.status.includes("agent_bound")).length,
  unsafe: skills.filter((skill) => skill.status.includes("unsafe")).length,
  invalid: skills.filter((skill) => skill.status.includes("invalid")).length
});

const byAgentCounts = (skills: Awaited<ReturnType<typeof scanSkills>>): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const skill of skills) {
    const agent = skill.source.agent;
    counts[agent] = (counts[agent] ?? 0) + 1;
  }
  return counts;
};

const formatByAgentLine = (skills: Awaited<ReturnType<typeof scanSkills>>): string => {
  const counts = byAgentCounts(skills);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const body = entries.length === 0 ? "(none)" : entries.map(([agent, n]) => `${agent} ${n}`).join("  ");
  return `${c.cyan("By agent:")} ${body}`;
};

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
  process.stderr.write(`${c.gray("[linka-skillhub]")} '${from}' is deprecated; use '${to}' instead.\n`);
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
  lines.push(`${c.bold("Registry")} ${c.cyan(repoPath)}: ${c.bold(`${total} skills`)} (auto_fixed: ${autoFixed})`);
  lines.push(`By agent: ${KNOWN_AGENTS.map((agent) => `${agent} ${byAgent.get(agent) ?? 0}`).join("  ")}`);
  lines.push("");
  if (total === 0) {
    lines.push(c.dim("(no skills imported; run 'lsh registry import' to populate this registry)"));
    return `${lines.join("\n")}\n`;
  }
  const W_ID = 18;
  const W_NAME = 24;
  const W_AGENT = 20;
  const headerRaw = `${"ID".padEnd(W_ID)}${"NAME".padEnd(W_NAME)}${"AGENT/SCOPE".padEnd(W_AGENT)}STATUS`;
  lines.push(c.bold(c.gray(headerRaw)));
  for (const skill of skills.slice(0, 30)) {
    const id = truncate(skill.id, W_ID - 1).padEnd(W_ID);
    const name = truncate(skill.name, W_NAME - 2).padEnd(W_NAME);
    const agentScope = truncate(`${skill.source.agent}/${skill.source.scope}`, W_AGENT - 2).padEnd(W_AGENT);
    const status = colorStatusList(skill.status, ",");
    lines.push(`${id}${name}${agentScope}${status}`);
  }
  if (total > 30) lines.push(c.dim(`... ${total - 30} more. Use --json for full output.`));
  return `${lines.join("\n")}\n`;
};

const formatRegistryShowHuman = (skill: SkillPackage): string => {
  const lines: string[] = [];
  lines.push(c.bold(skill.name));
  if (skill.description) lines.push(skill.description);
  lines.push("");
  lines.push(`${c.cyan("Status:")}  ${colorStatusList(skill.status, ", ")}`);
  lines.push(`${c.cyan("Source:")}  ${skill.source.agent}/${skill.source.scope}`);
  lines.push(`${c.cyan("Path:")}    ${c.dim(c.gray(skill.skillDir))}`);
  lines.push(`${c.cyan("Hash:")}    ${c.dim(c.gray(skill.hash.slice(0, 16)))}`);
  lines.push(`${c.cyan("Variant:")} ${skill.variantId}`);
  lines.push(`${c.cyan("Updated:")} ${skill.updatedAt}`);
  if (skill.auto_fixed === true) lines.push(`${c.cyan("Auto-fixed:")} yes`);
  const issuesText =
    skill.issues.length === 0
      ? "(none)"
      : skill.issues.map((issue) => c.red(`${issue.code}: ${issue.message}`)).join("; ");
  lines.push(`${c.cyan("Issues:")}  ${issuesText}`);
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
  lines.push(c.bold(`Reviewed ${reviews.length} skills with ${reviewer} (language: ${language})`));
  lines.push(`- ${c.green(`shareable: ${shareable}`)}`);
  lines.push(`- ${c.yellow(`agent-bound: ${agentBound}`)}`);
  lines.push(`- ${c.red(`problematic: ${problematic}`)}`);
  lines.push(`- unreviewed: ${unreviewed}`);
  lines.push("");
  lines.push(`Wrote ${reviews.length} review records to ${c.dim(c.gray(reviewsDir))}`);
  const issues = reviews.filter((r) => r.recommendation === "fix" || r.recommendation === "reject").slice(0, 5);
  if (issues.length > 0) {
    lines.push("");
    lines.push(c.bold("Top issues:"));
    for (const review of issues) {
      const name = skillNamesById.get(review.skillId) ?? review.skillId;
      const statusText = review.statuses.length > 0 ? review.statuses.join(",") : review.recommendation;
      const evidenceText = review.evidence.length > 0 ? ` - ${review.evidence.slice(0, 5).join(", ")}` : "";
      lines.push(`  ${c.bold(name)} (${review.skillId}): ${c.red(statusText)}${evidenceText}`);
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
  lines.push(c.bold(`Plan: copy ${from} -> ${to} (${total} items)`));
  const W_ACTION = 11;
  const W_NAME = 24;
  for (const item of plan.items.slice(0, 30)) {
    const action = colorActionPadded(item.action, item.action.padEnd(W_ACTION));
    const name = truncate(item.skill.name, W_NAME - 2).padEnd(W_NAME);
    const reason = shortReason(item.action, item.reason);
    lines.push(`- ${action}${name}${reason}`);
  }
  if (total > 30) lines.push(c.dim(`... ${total - 30} more items. Use --json for full plan.`));
  lines.push("");
  lines.push(`${c.cyan("Plan id:")} ${plan.id}`);
  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push(c.yellow(`Warnings: ${plan.warnings.length}`));
    for (const warning of plan.warnings.slice(0, 5)) lines.push(`- ${c.yellow(warning)}`);
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
  lines.push(c.bold(`Plan: distribute to ${targetAgents.join(", ")} (${total} items)`));
  const W_ACTION = 11;
  const W_NAME = 24;
  const W_TARGET = 10;
  for (const item of plan.items.slice(0, 30)) {
    const action = colorActionPadded(item.action, item.action.padEnd(W_ACTION));
    const name = truncate(item.skill.name, W_NAME - 2).padEnd(W_NAME);
    const target = truncate(item.target.agent, W_TARGET - 1).padEnd(W_TARGET);
    const reason = shortReason(item.action, item.reason);
    lines.push(`- ${action}${name}-> ${target}${reason}`);
  }
  if (total > 30) lines.push(c.dim(`... ${total - 30} more items. Use --json for full plan.`));
  lines.push("");
  lines.push(`${c.cyan("Plan id:")} ${plan.id}`);
  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push(c.yellow(`Warnings: ${plan.warnings.length}`));
    for (const warning of plan.warnings.slice(0, 5)) lines.push(`- ${c.yellow(warning)}`);
  }
  lines.push("");
  lines.push(
    `Use 'lsh distribute apply --target ${targetAgents.join(",")} --yes' to write, or pass --json for full plan.`
  );
  return `${lines.join("\n")}\n`;
};

// Reason codes from FrontmatterFixResult are short enums; translate them to
// the single short phrase the human view shows after "No change for ...".
const frontmatterFixReasonText = (reason: FrontmatterFixResult["reason"] | undefined): string => {
  if (reason === "frontmatter_already_present") return "frontmatter already present";
  if (reason === "unsafe_source_blocked") return "unsafe source blocked";
  if (reason === "skill_not_found") return "skill not found";
  if (reason === "dry_run") return "dry run";
  return reason ?? "unknown";
};

const formatFrontmatterFixHuman = (
  skill: SkillPackage,
  manifestPath: string,
  result: FrontmatterFixResult
): string => {
  const lines: string[] = [];
  const nameAndId = `${c.bold(skill.name)} (${skill.id})`;
  if (result.applied) {
    lines.push(`${c.green("Fixed frontmatter for")} ${nameAndId}`);
    if (result.writtenPath) lines.push(`  ${c.cyan("Written to:")}       ${c.dim(c.gray(result.writtenPath))}`);
    lines.push(`  ${c.cyan("Manifest updated:")} ${c.dim(c.gray(manifestPath))}`);
    return `${lines.join("\n")}\n`;
  }
  if (result.reason === "dry_run") {
    lines.push(`${c.bold("Dry run for")} ${nameAndId}`);
    lines.push(`  ${c.cyan("Source:")} ${c.dim(c.gray(skill.skillDir))}`);
    if (skill.issues.length > 0) {
      lines.push(`  ${c.cyan("Issues:")}`);
      for (const issue of skill.issues) {
        lines.push(`    ${c.red(issue.code)}: ${issue.message}`);
      }
    }
    if (result.newFrontmatter) {
      lines.push(`  ${c.cyan("Would write frontmatter:")}`);
      lines.push(`    name: ${result.newFrontmatter.name}`);
      lines.push(`    description: ${result.newFrontmatter.description}`);
    }
    lines.push("");
    lines.push(c.dim("Pass --yes to apply (without --dry-run)."));
    return `${lines.join("\n")}\n`;
  }
  lines.push(`${c.bold("No change for")} ${nameAndId}: ${frontmatterFixReasonText(result.reason)}`);
  return `${lines.join("\n")}\n`;
};

const handleConfirmationFailure = async (promise: Promise<void>): Promise<boolean> => {
  try {
    await promise;
    return true;
  } catch (error) {
    process.stderr.write(`${errorPrefix()} ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return false;
  }
};

program
  .name("lsh")
  .alias("linka-skillhub")
  .description("Local-first registry for code-agent skills across Mavis, OpenCode, Claude Code, Codex, and .agents/skills.")
  .version("0.1.0+build.2026-05-26")
  .option("--config <path>", "Config file path; defaults to nearest linka-skillhub.config.json.")
  .option("--profile <name>", "Active profile name.");

// Hand all commander-driven exits to our outer try/catch so user-input
// errors (unknown option/command, missing required option) exit 2 instead
// of commander's default 1, while --help / --version still exit 0.
// Must be called BEFORE any program.command(...) so subcommands inherit
// the exit callback via copyInheritedSettings().
program.exitOverride();

program
  .command("list")
  .alias("scan")
  .description("List scanned skills from the active profile sources. (alias 'scan' is deprecated)")
  .option("--all", "Include builtin/system sources that are excluded by default.")
  .option("--json", "Print full JSON output.")
  .action(async (options: { all?: boolean; json?: boolean }) => {
    if (process.argv.includes("scan") && !process.argv.includes("list")) warnDeprecated("scan", "list");
    const runtime = await loadRuntimeConfig();
    const skills = await scanSkills({ cwd: invocationCwd, config: runtime.raw, profileName: runtime.profileName, includeDefaultExcluded: options.all ?? false });
    if (options.json) printJson({ summary: summarize(skills), skills });
    else {
      const summary = summarize(skills);
      process.stdout.write(
        `${c.cyan(`Profile ${runtime.profileName}.`)} Scanned ${c.bold(String(summary.total))} skills: ${c.green(`${summary.valid} valid`)}, ${c.green(`${summary.portable} portable`)}, ${c.yellow(`${summary.agentBound} agent-bound`)}, ${c.red(`${summary.unsafe} unsafe`)}, ${c.red(`${summary.invalid} invalid`)}.\n`
      );
      process.stdout.write(`${formatByAgentLine(skills)}\n`);
      for (const skill of skills.slice(0, 30)) {
        process.stdout.write(`${skill.id}  ${skill.name}  ${skill.source.agent}/${skill.source.scope}  ${colorStatusList(skill.status, ",")}\n`);
      }
      if (skills.length > 30) process.stdout.write(c.dim(`... ${skills.length - 30} more. Use --json for full output.\n`));
    }
  });

const registry = program.command("registry").description("Read and import registry contents.");

registry
  .command("import")
  .description("Copy selected local skills into a registry repository.")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--all", "Include builtin/system sources.")
  .option("--create", "Allow creating a new registry directory if --repo path does not exist.")
  .option("--yes", "Skip confirmation prompt. Required in non-interactive shells; LINKA_SKILLHUB_FORCE_YES=1 has the same effect.")
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
      process.stderr.write(`${errorPrefix()} --repo path exists but is not a directory: ${c.cyan(repoPath)}\n`);
      process.exitCode = 2;
      return;
    }
    if (!repoStat.exists && !options.create) {
      process.stderr.write(
        `${errorPrefix()} --repo path does not exist: ${c.cyan(repoPath)}\n       Pass --create to initialize a new registry directory there.\n`
      );
      process.exitCode = 2;
      return;
    }
    if (!repoStat.exists && options.create) {
      process.stderr.write(`Created new registry directory at ${c.cyan(repoPath)}\n`);
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
      process.stderr.write(`${errorPrefix()} skill not found in registry: ${id}\n`);
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
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--json", "Print full JSON output instead of the human summary.")
  .action(async (options: { reviewer: string; language: string; skill?: string; repo?: string; json?: boolean }) => {
    const reviewer = assertKnownReviewer(options.reviewer);
    if (!reviewer) return;
    const language = assertKnownLanguage(options.language);
    if (!language) return;
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    const requestedIds = parseSkillIds(options.skill);
    const filteredIds = filterKnownSkillIds(requestedIds, manifest);
    if (filteredIds === null) return;
    const selected = filteredIds ? new Set(filteredIds) : undefined;
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
  .requiredOption("--target <agents>", "comma-separated agents: mavis | opencode | claude | codex | shared")
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
    const requestedIds = parseSkillIds(options.skill);
    let skillIds: string[] | undefined;
    if (requestedIds) {
      const manifest = await readRegistryManifest(repoPath);
      const filteredIds = filterKnownSkillIds(requestedIds, manifest);
      if (filteredIds === null) return;
      skillIds = filteredIds;
    }
    const plan = await createDistributionPlan({
      registryPath: repoPath,
      cwd: invocationCwd,
      config: runtime.raw,
      profileName: runtime.profileName,
      backupDir: path.join(runtime.profile.stateDir, "backups"),
      targetAgents,
      skillIds,
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
  .requiredOption("--target <agents>", "comma-separated agents: mavis | opencode | claude | codex | shared")
  .option("--skill <ids>", "comma-separated skill ids")
  .option("--plan <id>", "plan id from 'distribute preview'; recomputes if omitted")
  .option("--include-unsafe", "allow unsafe skills")
  .option("--include-agent-bound", "allow agent-bound skills")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--yes", "Skip confirmation prompt. Required in non-interactive shells; LINKA_SKILLHUB_FORCE_YES=1 has the same effect.")
  .action(async (options: { target: string; skill?: string; plan?: string; includeUnsafe?: boolean; includeAgentBound?: boolean; repo?: string; yes?: boolean }) => {
    const targetAgents = parseAgentsStrict(options.target, "agent (--target)");
    if (!targetAgents) return;
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const requestedIds = parseSkillIds(options.skill);
    let skillIds: string[] | undefined;
    if (requestedIds) {
      const manifest = await readRegistryManifest(repoPath);
      const filteredIds = filterKnownSkillIds(requestedIds, manifest);
      if (filteredIds === null) return;
      skillIds = filteredIds;
    }
    const plan = await createDistributionPlan({
      registryPath: repoPath,
      cwd: invocationCwd,
      config: runtime.raw,
      profileName: runtime.profileName,
      backupDir: path.join(runtime.profile.stateDir, "backups"),
      targetAgents,
      skillIds,
      includeUnsafe: options.includeUnsafe ?? false,
      includeAgentBound: options.includeAgentBound ?? false
    });
    if (options.plan && options.plan !== plan.id) {
      process.stderr.write(
        `${errorPrefix()} --plan id mismatch (expected: ${options.plan}, got: ${plan.id})\n` +
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
      process.stdout.write(`${c.cyan("Plan id:")} ${plan.id}\n`);
    }
    printJson({ plan: compactPlan(plan), run });
  });

const copy = program.command("copy").description("Copy skills from one agent's source to a single target agent.");
copy
  .command("preview")
  .description("Plan A->B copy operations; do not write anything.")
  .requiredOption("--from <agent>", "source agent: mavis | opencode | claude | codex | shared")
  .requiredOption("--to <agent>", "target agent: mavis | opencode | claude | codex | shared")
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
    const requestedIds = parseSkillIds(options.skill);
    const filteredIds = filterKnownSkillIds(requestedIds, manifest);
    if (filteredIds === null) return;
    const plan = await createDistributionPlan({
      registryPath: repoPath,
      cwd: invocationCwd,
      config: runtime.raw,
      profileName: runtime.profileName,
      backupDir: path.join(runtime.profile.stateDir, "backups"),
      targetAgents: [to],
      skillIds: filteredIds ?? filtered.map((skill) => skill.id),
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
  .requiredOption("--from <agent>", "source agent: mavis | opencode | claude | codex | shared")
  .requiredOption("--to <agent>", "target agent: mavis | opencode | claude | codex | shared")
  .option("--skill <ids>", "comma-separated skill ids; default: all skills under --from")
  .option("--plan <id>", "plan id from 'copy preview'; recomputes if omitted")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--yes", "Skip confirmation prompt. Required in non-interactive shells; LINKA_SKILLHUB_FORCE_YES=1 has the same effect.")
  .action(async (options: { from: string; to: string; skill?: string; plan?: string; repo?: string; yes?: boolean }) => {
    const from = assertKnownAgent(options.from, "agent (--from)");
    if (!from) return;
    const to = assertKnownAgent(options.to, "agent (--to)");
    if (!to) return;
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    const filtered = manifest.skills.filter((skill) => skill.source.agent === from);
    const requestedIds = parseSkillIds(options.skill);
    const filteredIds = filterKnownSkillIds(requestedIds, manifest);
    if (filteredIds === null) return;
    const plan = await createDistributionPlan({
      registryPath: repoPath,
      cwd: invocationCwd,
      config: runtime.raw,
      profileName: runtime.profileName,
      backupDir: path.join(runtime.profile.stateDir, "backups"),
      targetAgents: [to],
      skillIds: filteredIds ?? filtered.map((skill) => skill.id),
      includeUnsafe: false,
      includeAgentBound: false
    });
    if (options.plan && options.plan !== plan.id) {
      process.stderr.write(
        `${errorPrefix()} --plan id mismatch (expected: ${options.plan}, got: ${plan.id})\n` +
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
      process.stdout.write(`${c.cyan("Plan id:")} ${plan.id}\n`);
    }
    printJson({ from, to, plan: compactPlan(plan), run });
  });

interface ParsedGitStatus {
  readonly branch: string;
  readonly upstream?: string;
  readonly clean: boolean;
  readonly modified: readonly string[];
  readonly untracked: readonly string[];
  readonly deleted: readonly string[];
}

const parseGitStatus = (raw: string): ParsedGitStatus => {
  const lines = raw.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { branch: "", upstream: undefined, clean: true, modified: [], untracked: [], deleted: [] };
  }
  const [branchLine, ...fileLines] = lines;
  const noCommitsMatch = branchLine!.match(/^## No commits yet on (\S+)/);
  const detachedMatch = branchLine!.match(/^## HEAD \(no branch\)/);
  const branchMatch = branchLine!.match(/^## ([^\s.]+)(?:\.\.\.(\S+?))?(?: \[.*\])?$/);
  let branch: string;
  let upstream: string | undefined;
  if (noCommitsMatch) {
    branch = `${noCommitsMatch[1]} (no commits yet)`;
  } else if (detachedMatch) {
    branch = "(detached HEAD)";
  } else {
    branch = branchMatch?.[1] ?? "?";
    upstream = branchMatch?.[2];
  }
  const modified: string[] = [];
  const untracked: string[] = [];
  const deleted: string[] = [];
  for (const line of fileLines) {
    const code = line.slice(0, 2);
    const name = line.slice(3);
    if (code === "??") untracked.push(name);
    else if (code.includes("D")) deleted.push(name);
    else modified.push(name);
  }
  return { branch, upstream, clean: fileLines.length === 0, modified, untracked, deleted };
};

const formatRepoStatusHuman = (repoPath: string, raw: string): string => {
  const parsed = parseGitStatus(raw);
  const lines: string[] = [];
  lines.push(`${c.bold("Registry")} ${c.cyan(repoPath)}`);
  const branchText = parsed.branch
    ? (parsed.upstream ? `${c.green(parsed.branch)} -> ${c.gray(parsed.upstream)}` : c.green(parsed.branch))
    : c.gray("(unknown)");
  lines.push(`Branch:    ${branchText}`);
  if (parsed.clean) {
    lines.push("");
    lines.push(c.green("Working tree clean."));
    return `${lines.join("\n")}\n`;
  }
  const summary: string[] = [];
  if (parsed.modified.length > 0) summary.push(c.yellow(`${parsed.modified.length} modified`));
  if (parsed.untracked.length > 0) summary.push(c.cyan(`${parsed.untracked.length} untracked`));
  if (parsed.deleted.length > 0) summary.push(c.red(`${parsed.deleted.length} deleted`));
  lines.push(`Changes:   ${summary.join(", ") || "(none)"}`);
  const renderGroup = (label: string, items: readonly string[], prefix: string): void => {
    if (items.length === 0) return;
    lines.push("");
    lines.push(c.bold(`${label}:`));
    for (const name of items.slice(0, 30)) lines.push(`  ${prefix} ${name}`);
    if (items.length > 30) lines.push(c.dim(`  ... ${items.length - 30} more`));
  };
  renderGroup("Modified", parsed.modified, "M ");
  renderGroup("Untracked", parsed.untracked, "??");
  renderGroup("Deleted", parsed.deleted, "D ");
  return `${lines.join("\n")}\n`;
};

const repo = program.command("repo").description("Manage the registry Git repository.");
repo
  .command("status")
  .description("Show working tree state of the registry repository.")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--json", "Print raw git output as a JSON object instead of the human view.")
  .action(async (options: { repo?: string; json?: boolean }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const status = await gitStatus(repoPath);
    if (options.json) {
      printJson({ status, repoPath });
      return;
    }
    process.stdout.write(formatRepoStatusHuman(repoPath, status));
  });
repo
  .command("connect")
  .description("Set the GitHub remote URL for the registry repository.")
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
  .description("Pull updates from the remote registry repository.")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .action(async (options: { repo?: string }) => {
    const runtime = await loadRuntimeConfig();
    process.stdout.write(`${await gitPull(resolveRepoOption(options.repo, runtime.profile.registryRepo))}\n`);
  });
repo
  .command("push")
  .description("Commit local changes and push to the registry remote.")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .option("--message <message>", "commit message", "Update skill registry")
  .option("--yes", "Skip confirmation prompt. Required in non-interactive shells; LINKA_SKILLHUB_FORCE_YES=1 has the same effect.")
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
  .option("--yes", "Skip confirmation prompt. Required in non-interactive shells; LINKA_SKILLHUB_FORCE_YES=1 has the same effect.")
  .option("--json", "Print full JSON output instead of the human summary.")
  .action(async (id: string, options: { repo?: string; allowUnsafeSource?: boolean; dryRun?: boolean; yes?: boolean; json?: boolean }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    const skill = manifest.skills.find((entry) => entry.id === id);
    if (!skill) {
      process.stderr.write(`${errorPrefix()} skill not found in registry: ${id}\n`);
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
    const manifestPath = path.join(repoPath, "registry", "skills.json");
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
            `Will rewrite manifest: ${manifestPath}`
          ],
          totalItems: 1,
          yes: options.yes
        })
      );
      const nextManifest = { ...manifest, skills: updatedSkills, generatedAt: new Date().toISOString() };
      await writeRegistryManifest(repoPath, nextManifest);
    }
    if (options.json) {
      printJson({ id, ...fixResult });
      return;
    }
    process.stdout.write(formatFrontmatterFixHuman(skill, manifestPath, fixResult));
  });

program
  .command("serve")
  .description("Start the local Web console and API server.")
  .option("--host <host>", "host", "127.0.0.1")
  .option("--port <port>", "port", "4873")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
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
  const e = errorPrefix();
  const profileMatch = raw.match(/Profile not found in linka-skillhub config:\s*(\S+)/);
  if (profileMatch) return `${e} profile '${profileMatch[1]}' not found in linka-skillhub.config.json`;
  if (raw.includes("ENOENT") && /spawn (?:git|.* git)\b/.test(raw)) {
    return `${e} git command failed; directory may not exist or is not a git repo`;
  }
  const enoentPath = raw.match(/ENOENT[^']*'([^']+)'/) ?? raw.match(/ENOENT[^"]*"([^"]+)"/);
  if (enoentPath) return `${e} path not found: ${enoentPath[1]}`;
  if (raw.includes("ENOENT")) return `${e} path not found`;
  const firstLine = raw.split("\n", 1)[0]?.trim() ?? raw;
  return `${e} ${firstLine}`;
};

try {
  await program.parseAsync(argv);
} catch (error) {
  // Commander errors: messages were already written by commander itself
  // (errors to stderr, --help/--version to stdout). We only need to set
  // the exit code so shell scripts can distinguish user input errors (2)
  // from successful help/version output (0).
  if (error instanceof CommanderError) {
    if (
      error.code === "commander.help" ||
      error.code === "commander.helpDisplayed" ||
      error.code === "commander.version"
    ) {
      process.exit(0);
    }
    process.exit(2);
  }
  process.stderr.write(`${friendlyMessage(error)}\n`);
  if (process.env.LINKA_SKILLHUB_DEBUG === "1" && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(2);
}
