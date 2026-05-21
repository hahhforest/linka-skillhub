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

program
  .name("linka-skillhub")
  .description("Manage, version, review, and distribute agent skills across Mavis, OpenCode, Claude Code, and Codex.")
  .version("0.1.0")
  .option("--config <path>", "config file path; defaults to nearest linka-skillhub.config.json")
  .option("--profile <name>", "config profile name");

program
  .command("scan")
  .description("Scan local agent skill directories.")
  .option("--all", "include builtin/system sources that are excluded by default")
  .option("--json", "print full JSON")
  .action(async (options: { all?: boolean; json?: boolean }) => {
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

program
  .command("import")
  .description("Copy selected local skills into a registry repository.")
  .option("--repo <path>", "registry repository path; defaults to config profile registryRepo")
  .option("--all", "include builtin/system sources")
  .action(async (options: { repo?: string; all?: boolean }) => {
    const runtime = await loadRuntimeConfig();
    const result = await importSkillsToRepository({ repoPath: resolveRepoOption(options.repo, runtime.profile.registryRepo), cwd: invocationCwd, config: runtime.raw, profileName: runtime.profileName, includeDefaultExcluded: options.all ?? false });
    printJson({ repoPath: result.repoPath, manifestPath: result.manifestPath, imported: result.imported, skipped: result.skipped, total: result.manifest.skills.length });
  });

program
  .command("review")
  .description("Run deterministic or local-agent review for registry skills.")
  .option("--repo <path>", "registry repository path; defaults to config profile registryRepo")
  .option("--agent <agent>", "rules|codex|opencode|claude|mavis", "rules")
  .option("--skill <ids>", "comma-separated skill ids")
  .action(async (options: { repo?: string; agent: AgentKind | "rules"; skill?: string }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const manifest = await readRegistryManifest(repoPath);
    const selected = options.skill ? new Set(options.skill.split(",").map((item) => item.trim())) : undefined;
    const reviews = [];
    for (const skill of manifest.skills) {
      if (selected && !selected.has(skill.id)) continue;
      const review = options.agent === "rules" ? reviewSkillWithRules(skill) : await reviewSkillWithAgent(skill, options.agent);
      await writeReviewResult(repoPath, review);
      reviews.push(review);
    }
    printJson({ reviews });
  });

program
  .command("distribute")
  .description("Plan or apply skill distribution from a registry to target agents.")
  .option("--repo <path>", "registry repository path; defaults to config profile registryRepo")
  .requiredOption("--target <agents>", "comma-separated target agents: codex,claude,opencode,mavis")
  .option("--skill <ids>", "comma-separated skill ids")
  .option("--include-unsafe", "allow unsafe skills")
  .option("--include-agent-bound", "allow agent-bound skills")
  .option("--apply", "apply the generated plan")
  .action(async (options: { repo?: string; target: string; skill?: string; includeUnsafe?: boolean; includeAgentBound?: boolean; apply?: boolean }) => {
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
    if (!options.apply) {
      printJson({ plan: compactPlan(plan) });
      return;
    }
    const run = await applyDistributionPlan(repoPath, plan);
    printJson({ plan: compactPlan(plan), run });
  });

const repo = program.command("repo").description("Manage the registry Git repository.");

repo
  .command("status")
  .option("--repo <path>", "registry repository path; defaults to config profile registryRepo")
  .action(async (options: { repo?: string }) => {
    const runtime = await loadRuntimeConfig();
    process.stdout.write(`${await gitStatus(resolveRepoOption(options.repo, runtime.profile.registryRepo))}\n`);
  });

repo
  .command("connect")
  .option("--repo <path>", "registry repository path; defaults to config profile registryRepo")
  .requiredOption("--remote <url>", "GitHub repository URL")
  .action(async (options: { repo?: string; remote: string }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    await setRemote(repoPath, options.remote);
    process.stdout.write(`${await gitStatus(repoPath)}\n`);
  });

repo
  .command("pull")
  .option("--repo <path>", "registry repository path; defaults to config profile registryRepo")
  .action(async (options: { repo?: string }) => {
    const runtime = await loadRuntimeConfig();
    process.stdout.write(`${await gitPull(resolveRepoOption(options.repo, runtime.profile.registryRepo))}\n`);
  });

repo
  .command("push")
  .option("--repo <path>", "registry repository path; defaults to config profile registryRepo")
  .option("--message <message>", "commit message", "Update skill registry")
  .action(async (options: { repo?: string; message: string }) => {
    const runtime = await loadRuntimeConfig();
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo);
    const commit = await gitCommitAll(repoPath, options.message);
    const output = await gitPush(repoPath);
    printJson({ commit, output });
  });

program
  .command("serve")
  .description("Start the local Web console and API server.")
  .option("--host <host>", "host", "127.0.0.1")
  .option("--port <port>", "port", "4873")
  .option("--repo <path>", "registry repository path; defaults to config profile registryRepo")
  .action(async (options: { host: string; port: string; repo?: string }) => {
    const runtime = await loadRuntimeConfig();
    const port = Number.parseInt(options.port, 10);
    const repoPath = resolveRepoOption(options.repo, runtime.profile.registryRepo ?? defaultRepoPath(invocationCwd));
    startServer({ host: options.host, port, repoPath, cwd: invocationCwd, config: runtime.raw, profileName: runtime.profileName, stateDir: runtime.profile.stateDir });
    process.stdout.write(`linka-skillhub running at http://${options.host}:${port} (profile ${runtime.profileName}, repo ${repoPath})\n`);
  });

const argv = process.argv[2] === "--" ? [process.argv[0]!, process.argv[1]!, ...process.argv.slice(3)] : process.argv;
await program.parseAsync(argv);
