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
  readonly stateDir?: string;
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
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
};

export const api = {
  agents: () => request<AgentsResponse>("/api/agents"),
  scan: (includeDefaultExcluded = true) => request<ScanResponse>("/api/scan", { method: "POST", body: JSON.stringify({ includeDefaultExcluded }) }),
  import: (repoPath?: string) => request<{ manifest: RegistryManifest; imported: number; skipped: number; repoPath: string }>("/api/import", { method: "POST", body: JSON.stringify({ repoPath }) }),
  skills: () => request<ScanResponse>("/api/skills"),
  reviewers: () => request<{ reviewers: ReviewerInfo[] }>("/api/reviewers"),
  review: (skillIds: string[], reviewer: string, language: "zh" | "en") => request<{ reviews: ReviewResult[] }>("/api/reviews/run", { method: "POST", body: JSON.stringify({ skillIds, reviewer, language }) }),
  distributionPlan: (targetAgents: string[], skillIds: string[]) =>
    request<{ plan: DistributionPlan }>("/api/distributions/plan", { method: "POST", body: JSON.stringify({ targetAgents, skillIds }) }),
  distributionApply: (targetAgents: string[], skillIds: string[]) =>
    request<DistributionRun>("/api/distributions/apply", { method: "POST", body: JSON.stringify({ targetAgents, skillIds }) }),
  repoStatus: () => request<{ status: string }>("/api/repo/status")
};
