import path from "node:path";
import { spawn } from "node:child_process";
import { sanitizePathSegment } from "./path-safety.js";
import type { AgentKind, SkillHistoryEntry, SkillHistoryAction } from "./types.js";

// R36-C20: parse the registry repo's git log for a single canonical skill
// into structured history entries. The whole point of this module is to keep
// raw git syntax OUT of the UI / CLI — users see "导入 (源自 Mavis)" not
// "import lark-mail (origin: mavis)". Internally we still use git as the
// version-of-truth; this is purely a presentation projection.

interface RawCommit {
  readonly shortSha: string;
  readonly ts: string;
  readonly subject: string;
}

// Stream `git log` for the canonical's directory. Format chosen so each line
// is a single self-contained record: <short-sha>\t<iso-ts>\t<subject>.
const runGitLog = (repoPath: string, relativePath: string): Promise<RawCommit[]> =>
  new Promise((resolve, reject) => {
    const args = [
      "log",
      "--no-merges",
      "--pretty=format:%h\t%aI\t%s",
      "--",
      relativePath
    ];
    const child = spawn("git", args, { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `git log exited with ${code ?? "unknown"}`));
        return;
      }
      const commits: RawCommit[] = [];
      for (const line of stdout.split("\n")) {
        if (!line) continue;
        const [shortSha, ts, ...rest] = line.split("\t");
        if (!shortSha || !ts) continue;
        commits.push({ shortSha, ts, subject: rest.join("\t") });
      }
      resolve(commits);
    });
  });

// Parse one git subject line into a structured action. Subjects follow the
// conventions established in R36-C19 / C21 / C22:
//   import <name> (origin: <agent>)
//   import <name> (origin: <agent>, restored)   ← C21 re-seed after canonical wipe
//   pull   <name> (from <agent>)
//   merge  <name> (<a1> + <a2>[ + ...])
//   fork   <new>  (from <old>, via <agent>)
// Agent tokens are matched with [^,)]+ (no commas, no parens) so trailing
// qualifiers like ", restored" don't get pulled into the agent slot. Anything
// that doesn't match falls back to action="other" with the raw subject so the
// user still sees SOMETHING even if a future commit (or a manual git commit)
// used a free-form message.
const SUBJECT_PATTERNS: ReadonlyArray<{
  readonly action: SkillHistoryAction;
  readonly regex: RegExp;
  readonly extract: (match: RegExpMatchArray) => { name?: string; agents: AgentKind[] };
}> = [
  {
    action: "import",
    regex: /^import\s+(\S+)\s+\(origin:\s+([^,)]+)(?:,\s*restored)?\)$/,
    extract: (m) => ({ name: m[1], agents: [(m[2] ?? "").trim() as AgentKind] })
  },
  {
    action: "pull",
    regex: /^pull\s+(\S+)\s+\(from\s+([^,)]+)\)$/,
    extract: (m) => ({ name: m[1], agents: [(m[2] ?? "").trim() as AgentKind] })
  },
  {
    action: "merge",
    regex: /^merge\s+(\S+)\s+\(([^)]+)\)$/,
    extract: (m) => ({
      name: m[1],
      agents: (m[2] ?? "").split("+").map((part) => part.trim() as AgentKind).filter((a) => a.length > 0)
    })
  },
  {
    action: "fork",
    regex: /^fork\s+(\S+)\s+\(from\s+(\S+),\s+via\s+([^,)]+)\)$/,
    extract: (m) => ({ name: m[1], agents: [(m[3] ?? "").trim() as AgentKind] })
  }
];

// Exported so tests can pin parsing rules without spinning up a git repo.
export const parseCommitSubject = (subject: string): { action: SkillHistoryAction; agents: AgentKind[] } => {
  for (const pattern of SUBJECT_PATTERNS) {
    const match = subject.match(pattern.regex);
    if (!match) continue;
    const { agents } = pattern.extract(match);
    return { action: pattern.action, agents };
  }
  return { action: "other", agents: [] };
};

export const readSkillHistory = async (repoPath: string, name: string): Promise<SkillHistoryEntry[]> => {
  // Use the v2 path inside registry/. The function intentionally does not
  // accept arbitrary directories — it's bound to the canonical-per-name model
  // C19 established, so callers can't accidentally ask for history of an
  // un-tracked file outside our write surface.
  const sanitized = sanitizePathSegment(name);
  const relativePath = path.posix.join("registry", "skills", sanitized);
  const raw = await runGitLog(repoPath, relativePath).catch(() => []);
  return raw.map((commit) => {
    const parsed = parseCommitSubject(commit.subject);
    return {
      shortSha: commit.shortSha,
      ts: commit.ts,
      action: parsed.action,
      agents: parsed.agents,
      rawSubject: commit.subject
    } satisfies SkillHistoryEntry;
  });
};
