const request = async (path, options = {}) => {
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
    return (await response.json());
};
export const api = {
    agents: () => request("/api/agents"),
    scan: (includeDefaultExcluded = true) => request("/api/scan", { method: "POST", body: JSON.stringify({ includeDefaultExcluded }) }),
    import: (repoPath) => request("/api/import", { method: "POST", body: JSON.stringify({ repoPath }) }),
    skills: () => request("/api/skills"),
    review: (skillIds, reviewer) => request("/api/reviews/run", { method: "POST", body: JSON.stringify({ skillIds, reviewer }) }),
    distributionPlan: (targetAgents, skillIds) => request("/api/distributions/plan", { method: "POST", body: JSON.stringify({ targetAgents, skillIds }) }),
    distributionApply: (targetAgents, skillIds) => request("/api/distributions/apply", { method: "POST", body: JSON.stringify({ targetAgents, skillIds }) }),
    repoStatus: () => request("/api/repo/status")
};
//# sourceMappingURL=api.js.map