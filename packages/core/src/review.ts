import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentKind, ReviewResult, SkillPackage, SkillStatus } from "./types.js";

export const PROMPT_VERSION = "skill-review-v1";

export const reviewSkillWithRules = (skill: SkillPackage): ReviewResult => {
  const statuses = skill.status.filter((status) => status !== "unreviewed");
  const hasInvalid = statuses.includes("invalid");
  const hasUnsafe = statuses.includes("unsafe");
  const hasAgentBound = statuses.includes("agent_bound");
  const shareable = statuses.includes("valid") && statuses.includes("portable") && !hasUnsafe && !hasAgentBound;
  const recommendation: ReviewResult["recommendation"] = hasInvalid || hasUnsafe ? "reject" : hasAgentBound ? "keep-private" : shareable ? "share" : "fix";

  return {
    skillId: skill.id,
    promptVersion: PROMPT_VERSION,
    reviewer: "rules",
    statuses,
    summary: shareable
      ? "Looks valid and portable by deterministic checks."
      : "Needs attention before default cross-agent distribution.",
    evidence: [...skill.issues.map((issue) => issue.code), ...skill.evidence],
    recommendation,
    createdAt: new Date().toISOString()
  };
};

export const buildReviewPrompt = async (skill: SkillPackage): Promise<string> => {
  const content = await fs.readFile(skill.skillFile, "utf8");
  return [
    "Review this agent skill for cross-agent portability.",
    "Return only JSON matching the configured prompt schema.",
    "",
    `Skill id: ${skill.id}`,
    `Name: ${skill.name}`,
    `Source agent: ${skill.source.agent}`,
    `Source scope: ${skill.source.scope}`,
    `Path: ${skill.skillDir}`,
    "",
    "```markdown",
    content.slice(0, 30000),
    "```"
  ].join("\n");
};

const defaultAgentCommand = (agent: AgentKind): readonly string[] | undefined => {
  if (agent === "claude") return ["claude", "-p"];
  if (agent === "codex") return ["codex", "exec", "-"];
  if (agent === "opencode") return ["opencode", "run", "-"];
  if (agent === "mavis") return ["mavis", "ask", "-"];
  return undefined;
};

const runCommand = (command: readonly string[], stdin: string, timeoutMs: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const [bin, ...args] = command;
    if (!bin) {
      reject(new Error("Missing command binary."));
      return;
    }
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Review command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Review command exited with code ${code ?? "unknown"}.`));
    });
    child.stdin.end(stdin);
  });

const coerceStatuses = (input: unknown, fallback: readonly SkillStatus[]): SkillStatus[] => {
  const allowed = new Set<SkillStatus>(["valid", "invalid", "portable", "agent_bound", "unsafe", "unreviewed"]);
  if (!Array.isArray(input)) return [...fallback];
  return input.filter((item): item is SkillStatus => typeof item === "string" && allowed.has(item as SkillStatus));
};

export const reviewSkillWithAgent = async (
  skill: SkillPackage,
  agent: AgentKind,
  options: { readonly command?: readonly string[]; readonly timeoutMs?: number } = {}
): Promise<ReviewResult> => {
  const fallback = reviewSkillWithRules(skill);
  const command = options.command ?? defaultAgentCommand(agent);
  if (!command) return { ...fallback, reviewer: agent, summary: `No default runner is configured for ${agent}; used rule review.` };

  try {
    const output = await runCommand(command, await buildReviewPrompt(skill), options.timeoutMs ?? 120000);
    const parsed = JSON.parse(output) as Partial<ReviewResult> & { statuses?: unknown; evidence?: unknown };
    return {
      skillId: skill.id,
      promptVersion: PROMPT_VERSION,
      reviewer: agent,
      statuses: coerceStatuses(parsed.statuses, fallback.statuses),
      summary: typeof parsed.summary === "string" ? parsed.summary : fallback.summary,
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter((item): item is string => typeof item === "string") : fallback.evidence,
      recommendation:
        parsed.recommendation === "share" || parsed.recommendation === "keep-private" || parsed.recommendation === "fix" || parsed.recommendation === "reject"
          ? parsed.recommendation
          : fallback.recommendation,
      createdAt: new Date().toISOString()
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...fallback,
      reviewer: agent,
      summary: `Agent review failed (${message}); used deterministic rule review.`
    };
  }
};

export const writeReviewResult = async (repoPath: string, review: ReviewResult): Promise<string> => {
  const reviewsDir = path.join(repoPath, "registry", "reviews");
  await fs.mkdir(reviewsDir, { recursive: true });
  const filePath = path.join(reviewsDir, `${review.skillId}-${review.reviewer}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  return filePath;
};
