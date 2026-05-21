# Skill 审查 Prompt v1（中文）

你正在审查一个 agent skill package 是否适合跨 Code Agent 共享。

请判断以下状态：

- valid：存在 `SKILL.md`，YAML frontmatter 能解析为对象，且 `name` 和 `description` 是非空字符串。
- portable：valid，skill 名称为小写 kebab-case，复制时不需要改写公开触发名，说明中没有强依赖某一个 Code Agent runtime。
- agent_bound：skill 依赖某个特定 Agent 的二进制、工具命名空间、session 系统或 runtime 专属能力，例如 Codex `functions.apply_patch`、Mavis 专属命令、Claude 专属工具名、OpenCode 专属 slash command。
- unsafe：skill 中疑似包含凭证、私钥、token、危险命令且没有保护措施，或不应该公开的路径/缓存。

只返回 JSON：

```json
{
  "statuses": ["valid"],
  "summary": "给用户看的简短中文原因",
  "evidence": ["简短证据或规则名"],
  "recommendation": "share | keep-private | fix | reject"
}
```

请保守判断。不确定是否依赖特定 Agent 时，标记 `agent_bound` 并说明原因。所有摘要和建议使用中文。
