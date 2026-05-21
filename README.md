# linka-skillhub

`linka-skillhub` 是一个本地优先的 code-agent skill 管理工具，用来扫描、汇总、版本化、审查和分发 Mavis、OpenCode、Claude Code、Codex 的 skills。

## 当前能力

- 扫描本机四类 agent 的 skill 目录，并识别 user/private/builtin/system/project 来源。
- 校验 `SKILL.md` frontmatter，识别 invalid YAML、缺失 `name`/`description`、agent 绑定和疑似敏感信息。
- 将 skill 原样复制到 registry 仓库，并写入 `registry/skills.json`。
- 保留同名 skill 的多 variant，不做破坏性改名。
- 从 registry 生成分发计划，默认只分发合法、可共享、非 agent-bound、非 unsafe 的 skill。
- 覆盖前备份目标目录到当前 profile 的 `stateDir/backups`。
- 提供 CLI 和本地 Web 控制台。

## 配置与安全开发

路径全部放在 `linka-skillhub.config.json` 里。当前默认 profile 是 `mirror`，读取 `.sandbox/local-mirror/sources/...`，写入 `.sandbox/local-mirror/targets/...`，用于真实内容测试但不会写入你本机真实 skills 目录。

```bash
# 复制本机真实 skill packages 到 sandbox mirror
pnpm mirror:local

# 默认扫描 mirror profile
pnpm scan

# 显式扫描真实本机目录
pnpm --filter @linka-skillhub/cli start -- --profile local scan
```

`sandbox` profile 仍保留为小型合成 fixture。真实目录在 `local` profile 中配置。任何会写目标目录的分发操作，只有在显式使用 `--profile local` 时才会指向 `~/.codex/skills`、`~/.claude/skills`、`~/.mavis/skills` 等真实路径。

## 开发

```bash
pnpm install
pnpm mirror:local
pnpm typecheck
pnpm test
pnpm build
pnpm verify
pnpm --filter @linka-skillhub/cli start -- serve
```

默认 Web/API 地址：`http://127.0.0.1:4873`。

`pnpm verify` 是每轮迭代的退出门槛：类型检查、单元测试、构建、浏览器巡检、浏览器流程测试都必须通过。

## CLI

```bash
# 扫描默认来源
pnpm scan

# 扫描真实本机来源
pnpm --filter @linka-skillhub/cli start -- --profile local scan

# 使用小型合成 fixture
pnpm seed:sandbox
pnpm --filter @linka-skillhub/cli start -- --profile sandbox scan

# 扫描所有来源，包括 builtin/system
pnpm --filter @linka-skillhub/cli start -- scan --all --json

# 汇总到 registry 仓库
pnpm --filter @linka-skillhub/cli start -- import

# 汇总真实本机来源到 local profile 的 registry
pnpm --filter @linka-skillhub/cli start -- --profile local import

# 审查 registry 中的 skills
pnpm --filter @linka-skillhub/cli start -- review --agent rules

# 生成分发计划，不执行
pnpm --filter @linka-skillhub/cli start -- distribute --target codex,claude --skill <skill-id>

# 执行分发计划
pnpm --filter @linka-skillhub/cli start -- distribute --target codex,claude --skill <skill-id> --apply
```

## Registry 结构

```text
registry/skills.json             # manifest：来源、hash、状态、variant
registry/reviews/*.json          # 审查结果摘要
skills/<skill>/<variant>/...     # 原样复制的 skill 包
prompts/skill-review-v1.md       # 固化审查 prompt
```

## 默认安全策略

- builtin/system skills 会展示，但默认不导入、不分发。
- unsafe、invalid、agent-bound skills 默认不会进入一键分发。
- 目标已有同名 skill 时，计划显示 overwrite；执行前会备份再覆盖。
- LLM/agent 审查接口已预留；当前 deterministic rules 是默认可用审查器。
