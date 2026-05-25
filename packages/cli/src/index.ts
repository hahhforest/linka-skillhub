#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import {
  applyDistributionPlan,
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
  writeReviewResult,
  type AgentKind
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
  .option("--yes", "Skip confirmation prompt (REQUIRED in non-interactive shells).")
  .action(async (options: { repo?: string; all?: boolean; yes?: boolean }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
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
  .action(async (options: { repo?: string }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    printJson({ repoPath, count: manifest.skills.length, skills: manifest.skills });
  });

registry
  .command("show <id>")
  .description("Show a single skill by id from the active registry.")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .action(async (id: string, options: { repo?: string }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    const skill = manifest.skills.find((entry) => entry.id === id);
    if (!skill) {
      process.stderr.write(`Skill not found in registry: ${id}\n`);
      process.exitCode = 2;
      return;
    }
    printJson(skill);
  });

program
  .command("review")
  .description("Run deterministic or local-agent review for registry skills.")
  .requiredOption("--reviewer <kind>", "rules | codex | opencode | claude | mavis")
  .option("--language <lang>", "zh | en", "zh")
  .option("--skill <ids>", "comma-separated skill ids")
  .option("--repo <path>", "registry path; defaults to profile registryRepo")
  .action(async (options: { reviewer: AgentKind | "rules"; language: "zh" | "en"; skill?: string; repo?: string }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    const selected = options.skill ? new Set(options.skill.split(",").map((item) => item.trim())) : undefined;
    const reviews = [];
    for (const skill of manifest.skills) {
      if (selected && !selected.has(skill.id)) continue;
      const review = options.reviewer === "rules" ? reviewSkillWithRules(skill, options.language) : await reviewSkillWithAgent(skill, options.reviewer, { language: options.language });
      await writeReviewResult(repoPath, review);
      reviews.push(review);
    }
    printJson({ reviews });
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
  .action(async (options: { target: string; skill?: string; includeUnsafe?: boolean; includeAgentBound?: boolean; repo?: string }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const plan = await createDistributionPlan({
      registryPath: repoPath,
      cwd: invocationCwd,
      config: runtime.raw,
      profileName: runtime.profileName,
      backupDir: path.join(runtime.profile.stateDir, "backups"),
      targetAgents: parseAgents(options.target),
      skillIds: options.skill ? options.skill.split(",").map((item) => item.trim()) : undefined,
      includeUnsafe: options.includeUnsafe ?? false,
      includeAgentBound: options.includeAgentBound ?? false
    });
    printJson({ plan: compactPlan(plan) });
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
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const targetAgents = parseAgents(options.target);
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
    printJson({ plan: compactPlan(plan), run, planIdEcho: options.plan });
  });

const copy = program.command("copy").description("Copy skills from one agent's source to a single target agent.");
copy
  .command("preview")
  .description("Plan A->B copy operations; do not write anything.")
  .requiredOption("--from <agent>", "source agent: mavis | opencode | claude | codex | shared")
  .requiredOption("--to <agent>", "target agent")
  .option("--skill <ids>", "comma-separated skill ids")
  .option("--repo <path>", "Registry path; defaults to profile registryRepo.")
  .action(async (options: { from: AgentKind; to: AgentKind; skill?: string; repo?: string }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    const filtered = manifest.skills.filter((skill) => skill.source.agent === options.from);
    const plan = await createDistributionPlan({
      registryPath: repoPath,
      cwd: invocationCwd,
      config: runtime.raw,
      profileName: runtime.profileName,
      backupDir: path.join(runtime.profile.stateDir, "backups"),
      targetAgents: [options.to],
      skillIds: options.skill ? options.skill.split(",").map((item) => item.trim()) : filtered.map((skill) => skill.id),
      includeUnsafe: false,
      includeAgentBound: false
    });
    printJson({ from: options.from, to: options.to, plan: compactPlan(plan) });
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
  .action(async (options: { from: AgentKind; to: AgentKind; skill?: string; plan?: string; repo?: string; yes?: boolean }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    const filtered = manifest.skills.filter((skill) => skill.source.agent === options.from);
    const plan = await createDistributionPlan({
      registryPath: repoPath,
      cwd: invocationCwd,
      config: runtime.raw,
      profileName: runtime.profileName,
      backupDir: path.join(runtime.profile.stateDir, "backups"),
      targetAgents: [options.to],
      skillIds: options.skill ? options.skill.split(",").map((item) => item.trim()) : filtered.map((skill) => skill.id),
      includeUnsafe: false,
      includeAgentBound: false
    });
    await handleConfirmationFailure(
      assertInteractiveOrYes({
        action: "copy apply",
        summary: summarizeCopyForPrompt(options.from, options.to, plan.items),
        totalItems: plan.items.length,
        targets: [options.to],
        yes: options.yes,
        skipOnEmpty: true
      })
    );
    const run = await applyDistributionPlan(repoPath, plan);
    printJson({ from: options.from, to: options.to, plan: compactPlan(plan), run, planIdEcho: options.plan });
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
await program.parseAsync(argv);
