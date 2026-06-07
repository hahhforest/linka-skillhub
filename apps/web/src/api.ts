import type { AgentDefinition, CanonicalSyncStatus, DistributionPlan, DistributionRun, DistributionTarget, RegistryManifest, ReviewResult, SkillHistoryEntry, SkillPackage, SkillScope, SkillSource, SyncForkResult, SyncMergeResult, SyncPullResult, SyncPushResult } from "@linka-skillhub/core";

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
  // R36-C20: fetch parsed git history for one canonical (action/agents/ts).
  // Server returns [] gracefully for unknown names or repos with no git log.
  skillHistory: (name: string) => request<{ name: string; entries: SkillHistoryEntry[] }>(`/api/skills/${encodeURIComponent(name)}/history`),
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
  distributionApply: (targetAgents: string[], skillIds: string[] | undefined, confirmToken: string) =>
    request<DistributionRun & { planId: string }>("/api/distributions/apply", { method: "POST", body: JSON.stringify({ targetAgents, skillIds, confirmToken }) }),
  validateRegistry: (repoPath: string) =>
    request<RegistryValidation>("/api/registry/validate", { method: "POST", body: JSON.stringify({ repoPath }) }),
  loadRegistry: (repoPath: string) =>
    request<RegistryLoadResponse>("/api/registry/load", { method: "POST", body: JSON.stringify({ repoPath }) }),
  repoStatus: () => request<{ status: string }>("/api/repo/status"),
  repoPush: (message: string) => request<{ commit: string; output: string }>("/api/repo/push", { method: "POST", body: JSON.stringify({ message }) }),
  repoPull: () => request<{ output: string }>("/api/repo/pull", { method: "POST", body: JSON.stringify({}) }),
  // R36-C21: sync subsystem. status reads instances.json + manifest and
  // returns drift state per canonical; pull/push/fork wrap core/sync.ts.
  syncStatus: () => request<{ statuses: CanonicalSyncStatus[]; missingRegistry?: boolean }>("/api/sync/status"),
  syncStatusFor: (name: string) =>
    request<{ name: string; status: CanonicalSyncStatus | null; missingRegistry?: boolean }>(`/api/skills/${encodeURIComponent(name)}/sync`),
  syncPull: (name: string, fromAgent: string) =>
    request<SyncPullResult>("/api/sync/pull", { method: "POST", body: JSON.stringify({ name, fromAgent }) }),
  syncPush: (name: string, toAgent: string) =>
    request<SyncPushResult>("/api/sync/push", { method: "POST", body: JSON.stringify({ name, toAgent }) }),
  syncPushAll: (name: string) =>
    request<{ name: string; results: SyncPushResult[] }>("/api/sync/push-all", { method: "POST", body: JSON.stringify({ name }) }),
  syncFork: (name: string, viaAgent: string, newName: string) =>
    request<SyncForkResult>("/api/sync/fork", { method: "POST", body: JSON.stringify({ name, viaAgent, newName }) }),
  // R36-C22: merge action runs an agent over multiple instance copies in
  // a workspace, then validates target/ and updates the canonical. Default
  // timeout is 600s; merge may legitimately take a few minutes so the UI
  // shouldn't enforce an aggressive client-side timeout.
  syncMerge: (name: string, fromAgents: string[], byAgent: string, timeoutMs?: number) =>
    request<SyncMergeResult>("/api/sync/merge", { method: "POST", body: JSON.stringify({ name, fromAgents, byAgent, timeoutMs }) }),
  // issue #2: streaming variant — same shape, but the response is NDJSON
  // (one event per line). onChunk fires for every stdout/stderr chunk the
  // server forwards from the agent; the promise resolves with the final
  // SyncMergeResult or rejects with the agent error. The fetch abort signal
  // lets callers cancel mid-stream (e.g. dialog close while merging).
  syncMergeStream: async (
    name: string,
    fromAgents: string[],
    byAgent: string,
    onChunk: (kind: "stdout" | "stderr", data: string) => void,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}
  ): Promise<SyncMergeResult> => {
    const response = await fetch("/api/sync/merge/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, fromAgents, byAgent, timeoutMs: options.timeoutMs }),
      signal: options.signal
    });
    if (!response.ok || !response.body) {
      // Validation errors come back as a regular JSON error body (the
      // streaming handler only kicks in after validation passes). Re-use the
      // same shape humanizeError() reads off the error code.
      const text = await response.text();
      let message = `Stream request failed: ${response.status}`;
      let code: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: string; code?: string };
        if (parsed.error) message = parsed.error;
        if (parsed.code) code = parsed.code;
      } catch { /* keep default */ }
      const err = new Error(message) as Error & { code?: string };
      if (code) err.code = code;
      throw err;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Parses any complete NDJSON lines accumulated in `buffer`, dispatching
    // chunk events to onChunk and returning the terminal `result` event when
    // it arrives. A partial trailing line stays in `buffer` for the next read.
    let finalResult: SyncMergeResult | null = null;
    let finalError: string | null = null;
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt).trim();
        buffer = buffer.slice(newlineAt + 1);
        if (line) {
          try {
            const event = JSON.parse(line) as
              | { kind: "stdout" | "stderr"; data: string }
              | { kind: "result"; ok: true; result: SyncMergeResult }
              | { kind: "result"; ok: false; error: string };
            if (event.kind === "stdout" || event.kind === "stderr") {
              onChunk(event.kind, event.data);
            } else if (event.kind === "result" && event.ok) {
              finalResult = event.result;
            } else if (event.kind === "result") {
              finalError = event.error;
            }
          } catch { /* skip unparseable line — server bug, but don't crash UI */ }
        }
        newlineAt = buffer.indexOf("\n");
      }
      if (done) break;
    }
    if (finalError !== null) {
      const err = new Error(finalError);
      throw err;
    }
    if (!finalResult) {
      throw new Error("Merge stream ended without a result event");
    }
    return finalResult;
  },
  // R36-C23: fix frontmatter — preview returns the proposed new frontmatter
  // and reasons; apply re-issues with confirmToken="apply" to actually write
  // the registry and commit. The two-step pattern matches the distribution
  // plan/apply split so the user sees what will change before committing.
  fixFrontmatterPreview: (skillId: string, allowUnsafeSource = false) =>
    request<{ result: unknown; skill: unknown }>("/api/fix/frontmatter/preview", {
      method: "POST",
      body: JSON.stringify({ skillId, allowUnsafeSource })
    }),
  fixFrontmatterApply: (skillId: string, allowUnsafeSource = false) =>
    request<{ result: unknown; committed: boolean; committedSha?: string }>("/api/fix/frontmatter", {
      method: "POST",
      body: JSON.stringify({ skillId, allowUnsafeSource, confirmToken: "apply" })
    }),
  // R36-C23: connect the registry repo to a new GitHub remote. The CLI
  // already had this; the WebUI just never surfaced it.
  repoConnect: (remoteUrl: string) =>
    request<{ ok: boolean; status: string }>("/api/repo/connect", {
      method: "POST",
      body: JSON.stringify({ remoteUrl })
    })
};
