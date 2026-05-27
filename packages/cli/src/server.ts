import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  addSourceToProfile,
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
  loadSkillHubConfig,
  readRegistryManifest,
  readSkillHistory,
  reviewSkillWithAgent,
  reviewSkillWithRules,
  scanSkills,
  setRemote,
  summarizeSkills,
  validateRegistryPath,
  writeReviewResult,
  type AgentKind,
  type DistributionPlan,
  type SkillHubConfig,
  type SkillPackage,
  type SkillScope,
  type SkillSourceTemplate
} from "@linka-skillhub/core";

const PLAN_TTL_MS = 10 * 60 * 1000;

// R35-C4: validation helpers for POST /api/sources. The web modal lets users
// register arbitrary directories as skill sources; we mirror the codes here so
// humanizeError on the client can show a localized message per failure mode.
const VALID_SCOPES: readonly SkillScope[] = ["user", "private", "builtin", "system", "project", "unknown"];
const AGENT_KIND_PATTERN = /^[a-z][a-z0-9-]*$/;

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

const summarize = (skills: readonly SkillPackage[]) => summarizeSkills(skills);

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
  const reviewers: Array<{ kind: string; label: string; available: boolean; reason: string; reasonCode: "rules_only" | "available" | "unavailable_command"; command?: string; path?: string }> = [
    { kind: "rules", label: "Rules", available: true, reason: "Deterministic local checks; no Code Agent call.", reasonCode: "rules_only" }
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
      reason: path ? `Found ${command} at ${path}.` : `Command not found: ${command ?? agent.kind}.`,
      reasonCode: path ? "available" : "unavailable_command"
    });
  }
  return reviewers;
};

export const startServer = (options: ServerOptions): http.Server => {
  let currentRepoPath = path.resolve(options.repoPath);
  let currentRepoIsExternal = false;
  const profileRepoRoot = path.resolve(options.repoPath);
  const profileRoot = options.stateDir ? path.dirname(path.resolve(options.stateDir)) : path.resolve(options.cwd);
  // R35-C4: mutable so POST /api/sources can refresh in-memory after writing
  // the new source to linka-skillhub.config.json. Without this the next /api/scan
  // call still uses the snapshot taken at server boot and the user's new
  // directory silently doesn't show up until the server is restarted.
  let currentConfig = options.config;
  const reloadConfigFromDisk = async (): Promise<void> => {
    const resolved = await loadSkillHubConfig({ cwd: options.cwd, profileName: options.profileName });
    currentConfig = resolved.raw;
  };
  const planCache = new Map<string, DistributionPlan>();
  const planCreatedAt = new Map<string, number>();
  const cachePlan = (plan: DistributionPlan): void => {
    planCache.set(plan.id, plan);
    planCreatedAt.set(plan.id, Date.now());
  };
  const lookupCachedPlan = (planId: string): DistributionPlan | undefined => {
    const createdAt = planCreatedAt.get(planId);
    if (!createdAt) return undefined;
    if (Date.now() - createdAt > PLAN_TTL_MS) {
      planCache.delete(planId);
      planCreatedAt.delete(planId);
      return undefined;
    }
    return planCache.get(planId);
  };
  const resolveRepoPath = (repoPath?: string): string => {
    if (!repoPath) return currentRepoPath;
    const resolved = path.resolve(options.cwd, repoPath);
    if (path.resolve(resolved) === currentRepoPath || path.resolve(resolved) === profileRepoRoot) {
      return resolved;
    }
    throw new Error(`Registry path is locked to the active session repo: ${currentRepoPath}`);
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${options.host}:${options.port}`);
      if (!url.pathname.startsWith("/api/")) {
        await serveStatic(request, response, options.cwd);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/agents") {
        const sources = await discoverSkillSources(options.cwd, currentConfig, options.profileName);
        sendJson(response, 200, {
          agents: getAgentDefinitions(options.cwd, currentConfig, options.profileName),
          targets: getDistributionTargets(options.cwd, currentConfig, options.profileName),
          sources,
          profile: options.profileName,
          registryRepo: currentRepoPath,
          registryRepoIsExternal: currentRepoIsExternal,
          stateDir: options.stateDir
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/registry/validate") {
        const body = await readJsonBody<{ repoPath: string }>(request);
        if (!body.repoPath || typeof body.repoPath !== "string") {
          sendJson(response, 400, { error: "repoPath is required", code: "missing_repo_path" });
          return;
        }
        const result = await validateRegistryPath(body.repoPath, { cwd: options.cwd, profileRoot });
        sendJson(response, result.ok ? 200 : 400, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/registry/load") {
        const body = await readJsonBody<{ repoPath: string }>(request);
        if (!body.repoPath || typeof body.repoPath !== "string") {
          sendJson(response, 400, { error: "repoPath is required", code: "missing_repo_path" });
          return;
        }
        const validation = await validateRegistryPath(body.repoPath, { cwd: options.cwd, profileRoot });
        if (!validation.ok) {
          sendJson(response, 400, { error: `Cannot load registry: ${validation.reason ?? "unknown"}`, code: validation.reason, repoPath: validation.repoPath });
          return;
        }
        currentRepoPath = validation.repoPath;
        currentRepoIsExternal = path.resolve(currentRepoPath) !== profileRepoRoot;
        const manifest = await readRegistryManifest(currentRepoPath);
        sendJson(response, 200, {
          ok: true,
          repoPath: currentRepoPath,
          isExternal: currentRepoIsExternal,
          profile: options.profileName,
          registryRepo: currentRepoPath,
          manifestVersion: manifest.version,
          skills: manifest.skills,
          summary: summarize(manifest.skills)
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/reviewers") {
        sendJson(response, 200, { reviewers: await listReviewers(options.cwd, currentConfig, options.profileName) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/scan") {
        const body = await readJsonBody<{ includeDefaultExcluded?: boolean }>(request);
        const skills = await scanSkills({ cwd: options.cwd, config: currentConfig, profileName: options.profileName, includeDefaultExcluded: body.includeDefaultExcluded ?? true });
        sendJson(response, 200, { skills, summary: summarize(skills) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sources") {
        // R35-C4: register a directory on disk as a managed skill source under
        // the active profile. Steps:
        //   1. Body-shape validation (agentKind / scope / path required + typed).
        //   2. agentKind must match ^[a-z][a-z0-9-]*$ so it stays a safe JSON key
        //      and fits the same conventions the built-in kinds use.
        //   3. scope must be one of the six SkillScope variants.
        //   4. Path is resolved against options.cwd, must exist, must be a
        //      directory, and its realpath must live under profileRoot. This is
        //      the same realpath-and-assertPathInside pattern that
        //      validateRegistryPath uses for the Switch Registry flow — keeps
        //      the user from accidentally pinning a source outside their
        //      profile (which would silently fail to scan).
        //   5. addSourceToProfile rewrites linka-skillhub.config.json atomically
        //      via fs.writeFile(.tmp) + fs.rename so a crash mid-write never
        //      bricks the JSON.
        // The endpoint returns enough info for the UI to surface a success
        // toast and trigger a fresh /api/scan + /api/agents pair.
        const body = await readJsonBody<{ agentKind?: string; label?: string; scope?: string; path?: string }>(request);
        if (!options.profileName) {
          sendJson(response, 500, { error: "Active profile name is required", code: "profile_not_found" });
          return;
        }
        if (!body.path || typeof body.path !== "string" || body.path.trim().length === 0) {
          sendJson(response, 400, { error: "path is required", code: "missing_path" });
          return;
        }
        if (!body.agentKind || typeof body.agentKind !== "string") {
          sendJson(response, 400, { error: "agentKind is required", code: "invalid_agent_kind" });
          return;
        }
        const agentKind = body.agentKind.trim();
        if (!AGENT_KIND_PATTERN.test(agentKind)) {
          sendJson(response, 400, {
            error: `Invalid agentKind: must match ${AGENT_KIND_PATTERN}`,
            code: "invalid_agent_kind"
          });
          return;
        }
        if (!body.scope || typeof body.scope !== "string" || !VALID_SCOPES.includes(body.scope as SkillScope)) {
          sendJson(response, 400, {
            error: `Invalid scope: must be one of ${VALID_SCOPES.join(", ")}`,
            code: "invalid_scope"
          });
          return;
        }
        const requested = path.resolve(options.cwd, body.path.trim());
        let stat: Awaited<ReturnType<typeof fs.lstat>>;
        try {
          stat = await fs.lstat(requested);
        } catch {
          sendJson(response, 400, { error: `Path not found: ${requested}`, code: "invalid_path", path: requested });
          return;
        }
        if (!stat.isDirectory() && !stat.isSymbolicLink()) {
          sendJson(response, 400, { error: `Not a directory: ${requested}`, code: "invalid_path", path: requested });
          return;
        }
        let realPath: string;
        try {
          realPath = await fs.realpath(requested);
        } catch {
          sendJson(response, 400, { error: `Path not resolvable: ${requested}`, code: "invalid_path", path: requested });
          return;
        }
        const realStat = await fs.stat(realPath);
        if (!realStat.isDirectory()) {
          sendJson(response, 400, { error: `Not a directory: ${realPath}`, code: "invalid_path", path: realPath });
          return;
        }
        try {
          let realProfileRoot = profileRoot;
          try {
            realProfileRoot = await fs.realpath(profileRoot);
          } catch {
            // profileRoot may not exist on disk yet; fall back to the resolved value.
          }
          const relative = path.relative(realProfileRoot, realPath);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            sendJson(response, 400, {
              error: `Path is outside the active profile root (${profileRoot})`,
              code: "outside_profile_root",
              path: realPath
            });
            return;
          }
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
            code: "outside_profile_root",
            path: realPath
          });
          return;
        }
        const source: SkillSourceTemplate = {
          path: realPath,
          scope: body.scope as SkillScope,
          defaultSelected: true,
          note: body.label && body.label.trim().length > 0 && body.label.trim() !== agentKind ? body.label.trim() : undefined
        };
        try {
          const result = await addSourceToProfile(options.profileName, agentKind, source, { cwd: options.cwd });
          // R35-C4: refresh in-memory currentConfig so the very next /api/scan
          // and /api/agents calls (which the web layer fires right after this
          // handler resolves) reflect the new source. Without this, the user's
          // new directory would only surface after the next server restart.
          await reloadConfigFromDisk();
          sendJson(response, 200, {
            ok: true,
            agentKind: result.agentKind,
            scope: source.scope,
            path: realPath,
            totalSources: result.totalSources,
            configPath: result.configPath
          });
        } catch (error) {
          const code = (error as { code?: string }).code ?? "invalid_path";
          const status = code === "duplicate_source" ? 409 : code === "profile_not_found" ? 404 : 400;
          sendJson(response, status, {
            error: error instanceof Error ? error.message : String(error),
            code
          });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/import") {
        const body = await readJsonBody<{ repoPath?: string; includeDefaultExcluded?: boolean }>(request);
        const result = await importSkillsToRepository({ repoPath: resolveRepoPath(body.repoPath), cwd: options.cwd, config: currentConfig, profileName: options.profileName, includeDefaultExcluded: body.includeDefaultExcluded ?? false });
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

      // R36-C20: structured projection of `git log` for one canonical. The
      // server runs the git command in the registry repo; the parser turns
      // each commit subject into action/agents/ts. UI never receives the
      // raw subject for non-"other" actions, so the rendering layer stays a
      // pure projection of the parsed data.
      const historyMatch = request.method === "GET" && url.pathname.match(/^\/api\/skills\/([^/]+)\/history$/);
      if (historyMatch) {
        const name = decodeURIComponent(historyMatch[1] ?? "");
        const registryPath = resolveRepoPath(url.searchParams.get("repo") ?? undefined);
        const entries = await readSkillHistory(registryPath, name);
        sendJson(response, 200, { name, entries });
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
          config: currentConfig,
          profileName: options.profileName,
          backupDir: options.stateDir ? path.join(options.stateDir, "backups") : undefined,
          targetAgents: body.targetAgents,
          skillIds: body.skillIds,
          includeUnsafe: body.includeUnsafe,
          includeAgentBound: body.includeAgentBound
        });
        cachePlan(plan);
        sendJson(response, 200, { plan, confirmToken: plan.id, ttlMs: PLAN_TTL_MS });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/distributions/apply") {
        const body = await readJsonBody<{
          registryPath?: string;
          targetAgents: AgentKind[];
          skillIds?: string[];
          includeUnsafe?: boolean;
          includeAgentBound?: boolean;
          confirmToken?: string;
          plan?: DistributionPlan;
        }>(request);
        if (!body.confirmToken) {
          sendJson(response, 400, {
            error: "confirmToken is required; call /api/distributions/plan first and resend its plan.id.",
            code: "confirmation_required"
          });
          return;
        }
        const cached = lookupCachedPlan(body.confirmToken);
        let plan: DistributionPlan;
        if (cached) {
          plan = cached;
        } else if (body.plan && body.plan.id === body.confirmToken) {
          plan = body.plan;
          cachePlan(plan);
        } else {
          const recomputed = await createDistributionPlan({
            registryPath: resolveRepoPath(body.registryPath),
            cwd: options.cwd,
            config: currentConfig,
            profileName: options.profileName,
            backupDir: options.stateDir ? path.join(options.stateDir, "backups") : undefined,
            targetAgents: body.targetAgents,
            skillIds: body.skillIds,
            includeUnsafe: body.includeUnsafe,
            includeAgentBound: body.includeAgentBound
          });
          if (recomputed.id !== body.confirmToken) {
            sendJson(response, 409, {
              error: `confirmToken does not match the current plan (${recomputed.id}); regenerate the preview and retry.`,
              code: "plan_id_mismatch",
              expected: body.confirmToken,
              actual: recomputed.id
            });
            return;
          }
          plan = recomputed;
          cachePlan(plan);
        }
        const cachedAt = planCreatedAt.get(plan.id);
        if (cachedAt && Date.now() - cachedAt > PLAN_TTL_MS) {
          planCache.delete(plan.id);
          planCreatedAt.delete(plan.id);
          sendJson(response, 410, {
            error: `Plan ${plan.id} expired after ${Math.round(PLAN_TTL_MS / 1000)}s; regenerate the preview and retry.`,
            code: "plan_expired"
          });
          return;
        }
        const run = await applyDistributionPlan(resolveRepoPath(body.registryPath), plan);
        sendJson(response, 200, { ...run, planId: plan.id });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/repo/status") {
        sendJson(response, 200, { status: await gitStatus(currentRepoPath) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/repo/connect") {
        const body = await readJsonBody<{ remoteUrl: string }>(request);
        await setRemote(currentRepoPath, body.remoteUrl);
        sendJson(response, 200, { ok: true, status: await gitStatus(currentRepoPath) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/repo/pull") {
        sendJson(response, 200, { output: await gitPull(currentRepoPath) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/repo/push") {
        const body = await readJsonBody<{ message?: string }>(request);
        sendJson(response, 200, { commit: await gitCommitAll(currentRepoPath, body.message ?? "更新技能仓库"), output: await gitPush(currentRepoPath) });
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

