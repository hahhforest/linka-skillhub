import type { SkillPackage } from "./types.js";

export interface SkillSummary {
  readonly total: number;
  readonly valid: number;
  readonly portable: number;
  readonly agentBound: number;
  readonly unsafe: number;
  readonly invalid: number;
}

// Single source of truth for counting buckets across CLI, server, and web.
// Semantics:
//   - valid     = manifest's parser said the skill is structurally valid
//   - portable  = valid + portable + NOT agent_bound + NOT unsafe
//                 (i.e. shareable without explicit opt-in flags)
//   - agentBound= status.includes("agent_bound") (independent of portable)
//   - unsafe    = status.includes("unsafe")
//   - invalid   = status.includes("invalid")
//                 (kept as a single-status check; unsafe is counted under unsafe)
export const summarizeSkills = (skills: readonly SkillPackage[]): SkillSummary => ({
  total: skills.length,
  valid: skills.filter((skill) => skill.status.includes("valid")).length,
  portable: skills.filter(
    (skill) =>
      skill.status.includes("portable") &&
      !skill.status.includes("agent_bound") &&
      !skill.status.includes("unsafe")
  ).length,
  agentBound: skills.filter((skill) => skill.status.includes("agent_bound")).length,
  unsafe: skills.filter((skill) => skill.status.includes("unsafe")).length,
  invalid: skills.filter((skill) => skill.status.includes("invalid")).length
});
