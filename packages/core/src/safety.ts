export interface SafetyFinding {
  readonly code: string;
  readonly message: string;
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/, "private_key"],
  [/(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}/i, "credential_literal"],
  [/sk-[A-Za-z0-9]{20,}/, "openai_style_token"],
  [/gh[pousr]_[A-Za-z0-9_]{30,}/, "github_token"],
  [/AKIA[0-9A-Z]{16}/, "aws_access_key"]
];

const AGENT_BOUND_PATTERNS: readonly [RegExp, string][] = [
  [/functions\.apply_patch|namespace functions|Codex/i, "codex_runtime_reference"],
  [/mavis\s+(?:skill|mcp|agent|session|cron|hook|im)\b/i, "mavis_cli_reference"],
  [/claude\s+(?:mcp|skill|config)\b|Claude Code/i, "claude_cli_reference"],
  [/opencode\s+(?:serve|run|auth|agent)\b|OpenCode/i, "opencode_cli_reference"],
  [/~\/\.(?:codex|mavis|claude|config\/opencode)\//, "agent_specific_home_path"]
];

export const findSafetyIssues = (content: string): SafetyFinding[] => {
  const findings: SafetyFinding[] = [];
  for (const [pattern, code] of SECRET_PATTERNS) {
    if (pattern.test(content)) findings.push({ code, message: `Potential secret matched rule ${code}.` });
  }
  return findings;
};

export const findAgentBoundEvidence = (content: string): SafetyFinding[] => {
  const findings: SafetyFinding[] = [];
  for (const [pattern, code] of AGENT_BOUND_PATTERNS) {
    if (pattern.test(content)) findings.push({ code, message: `Agent-specific dependency matched rule ${code}.` });
  }
  return findings;
};

export const isKebabName = (name: string): boolean => /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) && !name.includes("--");
