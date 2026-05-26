import type { AgentDefinition, DistributionPlan, DistributionRun, DistributionTarget, RegistryManifest, ReviewResult, SkillPackage, SkillScope, SkillSource } from "@linka-skillhub/core";

export interface ScanResponse {
  readonly skills: SkillPackage[];
  readonly summary: Summary;
  readonly manifest?: RegistryManifest;
  readonly missingRegistry?: boolean;
}

export interface Summary {
  readonly total: number;
  readonly valid: number;
  readonly portable: number;
  readonly agentBound: number;
  readonly unsafe: number;
  readonly invalid: number;
}

export interface AgentsResponse {
  readonly agents: AgentDefinition[];
  readonly targets: DistributionTarget[];
  readonly sources: SkillSource[];
  readonly profile?: string;
  readonly registryRepo?: string;
  readonly registryRepoIsExternal?: boolean;
  readonly stateDir?: string;
}

export interface RegistryValidation {
  readonly ok: boolean;
  readonly repoPath: string;
  readonly manifestVersion?: number;
  readonly skillCount?: number;
  readonly reason?: string;
}

export interface RegistryLoadResponse extends RegistryValidation {
  readonly skills?: SkillPackage[];
  readonly summary?: Summary;
  readonly profile?: string;
  readonly registryRepo?: string;
  readonly isExternal?: boolean;
}

export interface ReviewerInfo {
  readonly kind: string;
  readonly label: string;
  readonly available: boolean;
  readonly command?: string;
  readonly path?: string;
  readonly reason: string;
  readonly reasonCode?: "rules_only" | "available" | "unavailable_command";
}

const request = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers ?? {})
      }
    });
  } catch (err) {
    // Fetch itself failed (e.g. backend down, DNS, offline). Wrap into a
    // typed error so the UI layer can show a localized friendly message
    // via humanizeError() instead of the native "TypeError: Failed to fetch".
    const wrapped = new Error(err instanceof Error ? err.message : String(err)) as Error & { code?: string };
    wrapped.code = "network_unreachable";
    throw wrapped;
  }
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string"
      ? (parsed as { error: string }).error
      : `Request failed: ${response.status}`;
    const error = new Error(message);
    if (parsed && typeof parsed === "object" && "code" in parsed) {
      (error as Error & { code?: string }).code = String((parsed as { code: unknown }).code);
    }
    throw error;
  }
  return (parsed ?? {}) as T;
};

// R35-C4: AddSource is intentionally typed with `agentKind: string` (NOT the
// AgentKind union) because the modal lets users invent arbitrary kinds for
// directories that don't belong to a built-in agent. The server validates the
// string shape via ^[a-z][a-z0-9-]*$.
export interface AddSourcePayload {
  readonly agentKind: string;
  readonly scope: SkillScope;
  readonly path: string;
  readonly label?: string;
}

export interface AddSourceResponse {
  readonly ok: true;
  readonly agentKind: string;
  readonly scope: SkillScope;
  readonly path: string;
  readonly totalSources: number;
  readonly configPath: string;
}

export const api = {
  agents: () => request<AgentsResponse>("/api/agents"),
  scan: (includeDefaultExcluded = true) => request<ScanResponse>("/api/scan", { method: "POST", body: JSON.stringify({ includeDefaultExcluded }) }),
  import: (repoPath?: string) => request<{ manifest: RegistryManifest; imported: number; skipped: number; repoPath: string }>("/api/import", { method: "POST", body: JSON.stringify({ repoPath }) }),
  skills: () => request<ScanResponse>("/api/skills"),
  reviewers: () => request<{ reviewers: ReviewerInfo[] }>("/api/reviewers"),
  review: (skillIds: string[], reviewer: string, language: "zh" | "en") => request<{ reviews: ReviewResult[] }>("/api/reviews/run", { method: "POST", body: JSON.stringify({ skillIds, reviewer, language }) }),
  addSource: (payload: AddSourcePayload) => request<AddSourceResponse>("/api/sources", { method: "POST", body: JSON.stringify(payload) }),
  // skillIds is intentionally optional: an undefined value omits the key in the
  // JSON body, and the server treats a missing skillIds as "include every
  // skill in the registry". Callers that want "all registry skills" must pass
  // undefined rather than an empty array (an empty Set on the server filters
  // out every skill).
  distributionPlan: (targetAgents: string[], skillIds?: string[]) =>
    request<{ plan: DistributionPlan; confirmToken: string; ttlMs: number }>("/api/distributions/plan", { method: "POST", body: JSON.stringify({ targetAgents, skillIds }) }),
  distributionApply: (targetAgents: string[], skillIds: string[] | undefined, confirmToken: string, plan?: DistributionPlan) =>
    request<DistributionRun & { planId: string }>("/api/distributions/apply", { method: "POST", body: JSON.stringify({ targetAgents, skillIds, confirmToken, plan }) }),
  validateRegistry: (repoPath: string) =>
    request<RegistryValidation>("/api/registry/validate", { method: "POST", body: JSON.stringify({ repoPath }) }),
  loadRegistry: (repoPath: string) =>
    request<RegistryLoadResponse>("/api/registry/load", { method: "POST", body: JSON.stringify({ repoPath }) }),
  repoStatus: () => request<{ status: string }>("/api/repo/status"),
  repoPush: (message: string) => request<{ commit: string; output: string }>("/api/repo/push", { method: "POST", body: JSON.stringify({ message }) }),
  repoPull: () => request<{ output: string }>("/api/repo/pull", { method: "POST", body: JSON.stringify({}) })
};
