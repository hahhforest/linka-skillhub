import type { AgentDefinition, DistributionPlan, DistributionRun, DistributionTarget, RegistryManifest, ReviewResult, SkillPackage, SkillSource } from "@linka-skillhub/core";
export interface ScanResponse {
    readonly skills: SkillPackage[];
    readonly summary: Summary;
    readonly manifest?: RegistryManifest;
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
export declare const api: {
    agents: () => Promise<AgentsResponse>;
    scan: (includeDefaultExcluded?: boolean) => Promise<ScanResponse>;
    import: (repoPath?: string) => Promise<{
        manifest: RegistryManifest;
        imported: number;
        skipped: number;
        repoPath: string;
    }>;
    skills: () => Promise<ScanResponse>;
    review: (skillIds: string[], reviewer: string) => Promise<{
        reviews: ReviewResult[];
    }>;
    distributionPlan: (targetAgents: string[], skillIds: string[]) => Promise<{
        plan: DistributionPlan;
    }>;
    distributionApply: (targetAgents: string[], skillIds: string[]) => Promise<DistributionRun>;
    repoStatus: () => Promise<{
        status: string;
    }>;
};
//# sourceMappingURL=api.d.ts.map