# linka-skillhub

`linka-skillhub` 是一个本地优先的 code-agent skill 管理工具，用来扫描、汇总、版本化、审查和分发 Mavis、OpenCode、Claude Code、Codex 的 skills。

主命令 `lsh`（兼容别名 `linka-skillhub`）。如果本机已有同名 `lsh`（如 openssh-lpk/lsh-utils），用 `pnpm lsh` 或 `npx lsh` 替代。

`pnpm lsh ...` 直接跑已构建的 `packages/cli/dist/index.js`，单次 invoke 约 100ms，不会重新 build。**首次 clone 仓库或刚清掉 dist 时，请先 `pnpm build`。** 如果需要源代码热运行（自动 build core + tsx 跑 TS），用开发模式 `pnpm lsh:dev ...`，但每次会多花 1-2 秒 build。

## 当前能力

- 扫描本机四类 agent 的 skill 目录，并识别 user/private/builtin/system/project 来源。
- 校验 `SKILL.md` frontmatter，识别 invalid YAML、缺失 `name`/`description`、agent 绑定和疑似敏感信息。
- 将 skill 原样复制到 registry 仓库，并写入 `registry/skills.json`。
- 保留同名 skill 的多 variant，不做破坏性改名。
- 从 registry 生成分发计划，默认只分发合法、可共享、非 agent-bound、非 unsafe 的 skill。
- 覆盖前备份目标目录到当前 profile 的 `stateDir/backups`。
- **所有写操作（CLI 与 Web）默认要求 `y/N` 确认；非交互必须显式 `--yes` 或 `confirmToken`。**
- **`lsh fix frontmatter` 可自动补缺失的 `SKILL.md` frontmatter（默认只写沙箱目录，写真实源需 `--allow-unsafe-source`）。**
- **Web 控制台支持加载已有 Registry 路径（必须位于当前 profile 范围内）。**
- 提供 CLI 和本地 Web 控制台。

## 配置与安全开发

路径全部放在 `linka-skillhub.config.json` 里。当前默认 profile 是 `mirror`，读取 `.sandbox/local-mirror/sources/...`，写入 `.sandbox/local-mirror/targets/...`，用于真实内容测试但不会写入你本机真实 skills 目录。

```bash
pnpm mirror:local                                    # 复制本机真实 skill packages 到 sandbox mirror
pnpm scan                                            # 默认扫描 mirror profile
pnpm lsh -- --profile local list                     # 显式扫描真实本机目录
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
pnpm serve
```

默认 Web/API 地址：`http://127.0.0.1:4873`。

`pnpm verify` 是每轮迭代的退出门槛：类型检查、单元测试、构建、浏览器巡检、浏览器流程测试都必须通过。

`pnpm review:smoke`（opt-in）对每个 reviewer（rules + codex/opencode/claude/mavis）跑一次端到端冒烟；rules 必须成功，外部 reviewer 任意 1 个成功即视为通过。不接入 `pnpm verify`。

`pnpm check:invalid` 列出当前 registry 中的 invalid skill，exit code 表示有/无。

## CLI

```bash
# 列出当前 profile 下扫描到的 skills
lsh list
lsh --profile local list --all --json
lsh scan           # alias，stderr 提示已 deprecated

# Registry
lsh registry import --yes
lsh registry list
lsh registry show <id>

# 审查
lsh review --reviewer rules
lsh review --reviewer codex --skill <id1>,<id2>
lsh review --reviewer claude --language en

# A→B 复制（单源单目标）
lsh copy preview --from mavis --to codex --skill <id>
lsh copy apply --from mavis --to codex --skill <id> --yes

# 多目标分发
lsh distribute preview --target codex,claude --skill <id>
lsh distribute apply --target codex,claude --skill <id> --yes

# Repo
lsh repo status
lsh repo push --message "feat: update skills" --yes

# 配置 / profile
lsh config list
lsh profile show

# 修复 invalid skill 的 frontmatter
lsh fix frontmatter <id> --dry-run
lsh fix frontmatter <id> --yes                                    # 写入 mirror sandbox source
lsh fix frontmatter <id> --allow-unsafe-source --yes              # 写入真实源（仅 local profile 必需）

# 启动 Web 控制台
lsh serve
```

写操作 (`registry import`、`copy apply`、`distribute apply`、`repo push`、`fix frontmatter`) 在非 TTY 下必须 `--yes` 或 `LINKA_SKILLHUB_FORCE_YES=1`，否则以 exit code 2 拒绝并打印预览到 stderr。

## Registry 结构

```text
registry/skills.json             # manifest：来源、hash、状态、variant、auto_fixed
registry/reviews/*.json          # 审查结果摘要
skills/<skill>/<variant>/...     # 原样复制的 skill 包
prompts/skill-review-v1.md       # 固化审查 prompt
```

## 默认安全策略

- builtin/system skills 会展示，但默认不导入、不分发。
- unsafe、invalid、agent-bound skills 默认不会进入一键分发。
- 目标已有同名 skill 时，计划显示 overwrite；执行前会备份再覆盖。
- LLM/agent 审查接口已预留；当前 deterministic rules 是默认可用审查器。
- 所有 Web 写操作需先 `POST /api/distributions/plan` 拿到 `plan.id`，再以 `confirmToken` 调 `POST /api/distributions/apply`；plan TTL 10 分钟，可幂等重放。
- `loadRegistry` 必须指向当前 profile 范围内的合法 manifest，路径逃逸由服务端 `validateRegistryPath` 拒绝。
