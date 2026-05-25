import type { AgentDefinition, DistributionPlan, DistributionRun, DistributionTarget, RegistryManifest, ReviewResult, SkillPackage, SkillSource } from "@linka-skillhub/core";

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
}

const request = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    }
  });
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

export const api = {
  agents: () => request<AgentsResponse>("/api/agents"),
  scan: (includeDefaultExcluded = true) => request<ScanResponse>("/api/scan", { method: "POST", body: JSON.stringify({ includeDefaultExcluded }) }),
  import: (repoPath?: string) => request<{ manifest: RegistryManifest; imported: number; skipped: number; repoPath: string }>("/api/import", { method: "POST", body: JSON.stringify({ repoPath }) }),
  skills: () => request<ScanResponse>("/api/skills"),
  reviewers: () => request<{ reviewers: ReviewerInfo[] }>("/api/reviewers"),
  review: (skillIds: string[], reviewer: string, language: "zh" | "en") => request<{ reviews: ReviewResult[] }>("/api/reviews/run", { method: "POST", body: JSON.stringify({ skillIds, reviewer, language }) }),
  distributionPlan: (targetAgents: string[], skillIds: string[]) =>
    request<{ plan: DistributionPlan; confirmToken: string; ttlMs: number }>("/api/distributions/plan", { method: "POST", body: JSON.stringify({ targetAgents, skillIds }) }),
  distributionApply: (targetAgents: string[], skillIds: string[], confirmToken: string, plan?: DistributionPlan) =>
    request<DistributionRun & { planId: string }>("/api/distributions/apply", { method: "POST", body: JSON.stringify({ targetAgents, skillIds, confirmToken, plan }) }),
  validateRegistry: (repoPath: string) =>
    request<RegistryValidation>("/api/registry/validate", { method: "POST", body: JSON.stringify({ repoPath }) }),
  loadRegistry: (repoPath: string) =>
    request<RegistryLoadResponse>("/api/registry/load", { method: "POST", body: JSON.stringify({ repoPath }) }),
  repoStatus: () => request<{ status: string }>("/api/repo/status"),
  repoPush: (message: string) => request<{ commit: string; output: string }>("/api/repo/push", { method: "POST", body: JSON.stringify({ message }) }),
  repoPull: () => request<{ output: string }>("/api/repo/pull", { method: "POST", body: JSON.stringify({}) })
};
