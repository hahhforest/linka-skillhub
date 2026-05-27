export type AgentKind = "mavis" | "opencode" | "claude" | "codex" | "cursor" | "openclaw" | "hermes" | "shared";

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
  // R36-C19: bumped to 2 — canonical-per-name model. v1 stored every (agent,
  // scope) variant as a separate skills/<name>/<variantId>/ package; v2
  // collapses to one canonical per skill name at registry/skills/<name>/.
  // skills[] still uses SkillPackage shape (UI consumes it via /api/skills)
  // but `source` now denotes the canonical's ORIGIN (first-import agent +
  // scope), not the current on-disk source. Live instance locations live in
  // registry/instances.json — see RegistryInstancesIndex. No v1→v2 migration
  // shipped: the sandbox fixture is wiped and rebuilt; users haven't run a
  // production import yet. Layout under repoPath:
  //   registry/skills/<name>/...  ← canonical content, git-tracked
  //   registry/skills.json        ← manifest (this type)
  //   registry/instances.json     ← live realPath ↔ canonical map
  //   prompts/                    ← snapshot of prompt files (best-effort)
  // linka-skillhub only ever writes inside registry/ + prompts/ — repo
  // top-level (e.g. a stray skills/) is intentionally off-limits.
  readonly version: 2;
  readonly generatedAt: string;
  readonly skills: readonly SkillPackage[];
}

// Where this canonical is materialised on disk right now. instances.json is
// rewritten on every scan — it's derived state, not history. History lives in
// the git log of registry/skills/<name>/.
export interface RegistryInstance {
  readonly realPath: string;             // canonical key — symlink-deduped
  readonly viaAgents: readonly AgentKind[]; // agents whose source dirs surface this realPath
  readonly lastSeenHash: string;
  readonly lastSeenAt: string;
  readonly status: "in-sync" | "drifted" | "missing";
}

export interface RegistryInstancesIndex {
  readonly version: 1;
  readonly generatedAt: string;
  readonly byName: Record<string, readonly RegistryInstance[]>;
}

// R36-C21: aggregated sync state per canonical, computed from the manifest
// + instances.json on demand. UI / CLI render this; internal sync actions
// produce it as a side-effect of operations like pull / push.
export interface CanonicalSyncStatus {
  readonly name: string;
  readonly canonicalHash: string;
  readonly instances: readonly RegistryInstance[];
  readonly hasDrift: boolean;        // at least one instance hash != canonical
  readonly hasMissing: boolean;      // at least one instance realPath disappeared
  readonly isOrphan: boolean;        // zero live instances surfaced this scan
}

export interface SyncPullResult {
  readonly name: string;
  readonly fromAgent: AgentKind;
  readonly fromRealPath: string;
  readonly oldHash: string;
  readonly newHash: string;
  readonly shortSha: string;          // git commit short sha
  readonly otherDrifted: readonly string[]; // realPaths now diverging from updated canonical
}

export interface SyncPushResult {
  readonly name: string;
  readonly realPath: string;
  readonly viaAgents: readonly AgentKind[];
  readonly newHash: string;
}

export interface SyncForkResult {
  readonly newName: string;
  readonly fromName: string;
  readonly viaAgent: AgentKind;
  readonly canonicalDir: string;
  readonly shortSha: string;
}

// R36-C20: structured projection of a canonical's git history. Action is
// derived from the commit subject pattern that registry.ts / sync.ts /
// merge.ts use; "other" catches anything that doesn't match (e.g. a manual
// git commit outside our flows). Consumers (CLI table, WebUI timeline) render
// this directly — they never see the raw git subject unless action == "other"
// in which case rawSubject is the safe fallback.
export type SkillHistoryAction = "import" | "pull" | "merge" | "fork" | "other";

export interface SkillHistoryEntry {
  readonly shortSha: string;
  readonly ts: string;                 // ISO 8601
  readonly action: SkillHistoryAction;
  readonly agents: readonly AgentKind[]; // origin for import; sources for pull/merge; via-agent for fork
  readonly rawSubject: string;          // shown only when action == "other"
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
