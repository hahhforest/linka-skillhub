import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyDistributionPlan,
  createDistributionPlan,
  discoverSkillSources,
  getAgentDefinitions,
  getDistributionTargets,
  gitCommitAll,
  gitPull,
  gitPush,
  gitStatus,
  importSkillsToRepository,
  readRegistryManifest,
  reviewSkillWithAgent,
  reviewSkillWithRules,
  scanSkills,
  setRemote,
  writeReviewResult,
  type AgentKind,
  type SkillHubConfig,
  type SkillPackage
} from "@linka-skillhub/core";

interface ServerOptions {
  readonly port: number;
  readonly host: string;
  readonly repoPath: string;
  readonly cwd: string;
  readonly config?: SkillHubConfig;
  readonly profileName?: string;
  readonly stateDir?: string;
}

const readJsonBody = async <T>(request: http.IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as T) : ({} as T);
};

const sendJson = (response: http.ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
};

const contentType = (filePath: string): string => {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
};

const webDistPath = (cwd: string): string => path.join(cwd, "apps", "web", "dist");

const serveStatic = async (request: http.IncomingMessage, response: http.ServerResponse, cwd: string): Promise<void> => {
  const base = webDistPath(cwd);
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.resolve(base, `.${requested}`);
  if (!resolved.startsWith(path.resolve(base))) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(resolved);
    response.writeHead(200, { "content-type": contentType(resolved) });
    response.end(data);
  } catch {
    try {
      const index = await fs.readFile(path.join(base, "index.html"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(index);
    } catch {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<h1>linka-skillhub API is running</h1><p>Build apps/web to enable the console.</p>");
    }
  }
};

const summarize = (skills: readonly SkillPackage[]) => ({
  total: skills.length,
  valid: skills.filter((skill) => skill.status.includes("valid")).length,
  portable: skills.filter((skill) => skill.status.includes("portable") && !skill.status.includes("agent_bound") && !skill.status.includes("unsafe")).length,
  agentBound: skills.filter((skill) => skill.status.includes("agent_bound")).length,
  unsafe: skills.filter((skill) => skill.status.includes("unsafe")).length,
  invalid: skills.filter((skill) => skill.status.includes("invalid")).length
});

const reviewerCommand: Partial<Record<AgentKind, string>> = {
  codex: "codex",
  claude: "claude",
  opencode: "opencode",
  mavis: "mavis"
};

const commandExists = (command: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile("sh", ["-lc", `command -v ${command}`], (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  });

const listReviewers = async (cwd: string, config?: SkillHubConfig, profileName?: string) => {
  const agents = getAgentDefinitions(cwd, config, profileName).filter((agent) => agent.kind !== "shared");
  const reviewers: Array<{ kind: string; label: string; available: boolean; reason: string; command?: string; path?: string }> = [
    { kind: "rules", label: "Rules", available: true, reason: "Deterministic local checks; no Code Agent call." }
  ];
  for (const agent of agents) {
    const command = reviewerCommand[agent.kind];
    const path = command ? await commandExists(command) : undefined;
    reviewers.push({
      kind: agent.kind,
      label: agent.label,
      available: Boolean(path),
      command,
      path,
      reason: path ? `Found ${command} at ${path}.` : `Command not found: ${command ?? agent.kind}.`
    });
  }
  return reviewers;
};

export const startServer = (options: ServerOptions): http.Server => {
  const allowedRepoRoot = path.resolve(options.repoPath);
  const resolveRepoPath = (repoPath?: string): string => {
    const resolved = repoPath ? path.resolve(options.cwd, repoPath) : options.repoPath;
    if (path.resolve(resolved) !== allowedRepoRoot) {
      throw new Error(`Registry path is locked to the active profile repo: ${allowedRepoRoot}`);
    }
    return resolved;
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${options.host}:${options.port}`);
      if (!url.pathname.startsWith("/api/")) {
        await serveStatic(request, response, options.cwd);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/agents") {
        const sources = await discoverSkillSources(options.cwd, options.config, options.profileName);
        sendJson(response, 200, {
          agents: getAgentDefinitions(options.cwd, options.config, options.profileName),
          targets: getDistributionTargets(options.cwd, options.config, options.profileName),
          sources,
          profile: options.profileName,
          registryRepo: options.repoPath,
          stateDir: options.stateDir
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/reviewers") {
        sendJson(response, 200, { reviewers: await listReviewers(options.cwd, options.config, options.profileName) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/scan") {
        const body = await readJsonBody<{ includeDefaultExcluded?: boolean }>(request);
        const skills = await scanSkills({ cwd: options.cwd, config: options.config, profileName: options.profileName, includeDefaultExcluded: body.includeDefaultExcluded ?? true });
        sendJson(response, 200, { skills, summary: summarize(skills) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/import") {
        const body = await readJsonBody<{ repoPath?: string; includeDefaultExcluded?: boolean }>(request);
        const result = await importSkillsToRepository({ repoPath: resolveRepoPath(body.repoPath), cwd: options.cwd, config: options.config, profileName: options.profileName, includeDefaultExcluded: body.includeDefaultExcluded ?? false });
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/skills") {
        const registryPath = resolveRepoPath(url.searchParams.get("repo") ?? undefined);
        try {
          const manifest = await readRegistryManifest(registryPath);
          sendJson(response, 200, { skills: manifest.skills, summary: summarize(manifest.skills), manifest });
        } catch {
          sendJson(response, 200, { skills: [], summary: summarize([]), missingRegistry: true });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reviews/run") {
        const body = await readJsonBody<{ repoPath?: string; skillIds?: string[]; reviewer?: AgentKind | "rules"; language?: "zh" | "en" }>(request);
        const repoPath = resolveRepoPath(body.repoPath);
        const manifest = await readRegistryManifest(repoPath);
        const selected = body.skillIds ? new Set(body.skillIds) : undefined;
        const reviews = [];
        for (const skill of manifest.skills) {
          if (selected && !selected.has(skill.id)) continue;
          const review = body.reviewer && body.reviewer !== "rules" ? await reviewSkillWithAgent(skill, body.reviewer, { language: body.language ?? "zh" }) : reviewSkillWithRules(skill, body.language ?? "zh");
          await writeReviewResult(repoPath, review);
          reviews.push(review);
        }
        sendJson(response, 200, { reviews });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/distributions/plan") {
        const body = await readJsonBody<{ registryPath?: string; targetAgents: AgentKind[]; skillIds?: string[]; includeUnsafe?: boolean; includeAgentBound?: boolean }>(request);
        const plan = await createDistributionPlan({
          registryPath: resolveRepoPath(body.registryPath),
          cwd: options.cwd,
          config: options.config,
          profileName: options.profileName,
          backupDir: options.stateDir ? path.join(options.stateDir, "backups") : undefined,
          targetAgents: body.targetAgents,
          skillIds: body.skillIds,
          includeUnsafe: body.includeUnsafe,
          includeAgentBound: body.includeAgentBound
        });
        sendJson(response, 200, { plan });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/distributions/apply") {
        const body = await readJsonBody<{ registryPath?: string; targetAgents: AgentKind[]; skillIds?: string[]; includeUnsafe?: boolean; includeAgentBound?: boolean }>(request);
        const plan = await createDistributionPlan({
          registryPath: resolveRepoPath(body.registryPath),
          cwd: options.cwd,
          config: options.config,
          profileName: options.profileName,
          backupDir: options.stateDir ? path.join(options.stateDir, "backups") : undefined,
          targetAgents: body.targetAgents,
          skillIds: body.skillIds,
          includeUnsafe: body.includeUnsafe,
          includeAgentBound: body.includeAgentBound
        });
        const run = await applyDistributionPlan(resolveRepoPath(body.registryPath), plan);
        sendJson(response, 200, run);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/repo/status") {
        sendJson(response, 200, { status: await gitStatus(options.repoPath) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/repo/connect") {
        const body = await readJsonBody<{ remoteUrl: string }>(request);
        await setRemote(options.repoPath, body.remoteUrl);
        sendJson(response, 200, { ok: true, status: await gitStatus(options.repoPath) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/repo/pull") {
        sendJson(response, 200, { output: await gitPull(options.repoPath) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/repo/push") {
        sendJson(response, 200, { commit: await gitCommitAll(options.repoPath), output: await gitPush(options.repoPath) });
        return;
      }

      sendJson(response, 404, { error: `No route for ${request.method} ${url.pathname}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
  });

  server.listen(options.port, options.host);
  return server;
};

export const defaultRepoPath = (cwd = process.env.INIT_CWD ?? process.cwd()): string => path.join(cwd, ".linka-skillhub", "registry-repo");

export const currentCliFile = fileURLToPath(import.meta.url);
