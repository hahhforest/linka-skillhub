export type AgentKind = "mavis" | "opencode" | "claude" | "codex" | "shared";

export type SkillScope = "user" | "private" | "builtin" | "system" | "project" | "unknown";

export type SkillStatus = "valid" | "invalid" | "portable" | "agent_bound" | "unsafe" | "unreviewed";
export type ReviewLanguage = "zh" | "en";

export interface AgentDefinition {
  readonly kind: AgentKind;
  readonly label: string;
  readonly command?: string;
  readonly color: string;
  readonly defaultTargetDir: string;
  readonly sourceDirs: readonly SkillSourceTemplate[];
}

export interface SkillSourceTemplate {
  readonly path: string;
  readonly scope: SkillScope;
  readonly defaultSelected: boolean;
  readonly includeNested?: boolean;
  readonly note?: string;
}

export interface AgentPathConfig {
  readonly enabled?: boolean;
  readonly targetDir?: string;
  readonly sourceDirs?: readonly SkillSourceTemplate[];
}

export interface SkillHubProfile {
  readonly stateDir?: string;
  readonly registryRepo?: string;
  readonly agents?: Partial<Record<AgentKind, AgentPathConfig>>;
}

export interface SkillHubConfig {
  readonly version: 1;
  readonly activeProfile: string;
  readonly profiles: Record<string, SkillHubProfile>;
}

export interface ResolvedSkillHubConfig {
  readonly configPath?: string;
  readonly profileName: string;
  readonly profile: Required<Pick<SkillHubProfile, "stateDir" | "registryRepo">> & SkillHubProfile;
  readonly raw: SkillHubConfig;
}

export interface SkillSource {
  readonly id: string;
  readonly agent: AgentKind;
  readonly label: string;
  readonly rootPath: string;
  readonly scope: SkillScope;
  readonly defaultSelected: boolean;
  readonly exists: boolean;
  readonly includeNested: boolean;
  readonly note?: string;
}

export interface SkillFrontmatter {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly [key: string]: unknown;
}

export interface ParseIssue {
  readonly code: string;
  readonly message: string;
}

export interface SkillPackage {
  readonly id: string;
  readonly name: string;
  readonly directoryName: string;
  readonly description: string;
  readonly source: SkillSource;
  readonly skillDir: string;
  readonly skillFile: string;
  readonly realPath: string;
  readonly isSymlink: boolean;
  readonly hash: string;
  readonly variantId: string;
  readonly frontmatter: SkillFrontmatter;
  readonly status: readonly SkillStatus[];
  readonly issues: readonly ParseIssue[];
  readonly evidence: readonly string[];
  readonly updatedAt: string;
  readonly auto_fixed?: boolean;
}

export interface RegistryManifest {
  readonly version: 1;
  readonly generatedAt: string;
  readonly skills: readonly SkillPackage[];
}

export interface ImportResult {
  readonly repoPath: string;
  readonly manifestPath: string;
  readonly imported: number;
  readonly skipped: number;
  readonly manifest: RegistryManifest;
}

export interface ReviewResult {
  readonly skillId: string;
  readonly promptVersion: string;
  readonly reviewer: AgentKind | "rules";
  readonly statuses: readonly SkillStatus[];
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly recommendation: "share" | "keep-private" | "fix" | "reject";
  readonly createdAt: string;
}

export interface DistributionTarget {
  readonly agent: AgentKind;
  readonly label: string;
  readonly targetDir: string;
}

export type DistributionItemReasonCode =
  | "not_shareable"
  | "same_content"
  | "different_content_will_backup"
  | "new";

export interface DistributionItemPlan {
  readonly skill: SkillPackage;
  readonly target: DistributionTarget;
  readonly action: "copy" | "overwrite" | "skip";
  readonly reason: string;
  readonly reasonCode: DistributionItemReasonCode;
  readonly existingPath?: string;
  readonly backupPath?: string;
}

export interface DistributionPlan {
  readonly id: string;
  readonly createdAt: string;
  readonly items: readonly DistributionItemPlan[];
  readonly warnings: readonly string[];
}

export interface DistributionRun {
  readonly planId: string;
  readonly appliedAt: string;
  readonly copied: number;
  readonly skipped: number;
  readonly backups: readonly string[];
}

export interface ScanOptions {
  readonly cwd?: string;
  readonly config?: SkillHubConfig;
  readonly profileName?: string;
  readonly includeDefaultExcluded?: boolean;
  readonly selectedSourceIds?: readonly string[];
  readonly now?: Date;
}

export interface ImportOptions extends ScanOptions {
  readonly repoPath: string;
}

export interface DistributionOptions {
  readonly registryPath: string;
  readonly cwd?: string;
  readonly config?: SkillHubConfig;
  readonly profileName?: string;
  readonly backupDir?: string;
  readonly targetAgents: readonly AgentKind[];
  readonly skillIds?: readonly string[];
  readonly includeUnsafe?: boolean;
  readonly includeAgentBound?: boolean;
  readonly now?: Date;
}
