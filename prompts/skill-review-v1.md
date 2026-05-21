# Skill Review Prompt v1

You are reviewing an agent skill package for cross-agent portability.

Classify the skill with these statuses:

- valid: `SKILL.md` exists, YAML frontmatter parses to an object, and `name` and `description` are non-empty strings.
- portable: valid, the skill name is lowercase kebab-case, the package can be copied without rewriting the public trigger name, and the instructions do not require one specific code agent runtime.
- agent_bound: the skill depends on one agent-specific binary, tool namespace, session system, or runtime-only feature such as Codex `functions.apply_patch`, Mavis-only commands, Claude-only tool names, or OpenCode-only slash commands.
- unsafe: the skill appears to include credentials, private keys, tokens, destructive commands without safeguards, or paths that should not be published.

Return a concise JSON object with:

```json
{
  "statuses": ["valid"],
  "summary": "short user-facing reason",
  "evidence": ["short snippets or rule names"],
  "recommendation": "share | keep-private | fix | reject"
}
```

Be conservative. If you are unsure whether a skill depends on a specific agent, mark `agent_bound` and explain why.
