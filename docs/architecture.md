# Architecture

## Boundary

`linka-skillhub` 是独立仓库，不依赖 Linka 主项目包结构。它只复用 Linka 的本地优先产品方向和 UI 角色感。

## Packages

- `packages/core`: 扫描、frontmatter 解析、状态分类、registry 写入、审查、分发、Git 辅助。
- `packages/cli`: `linka-skillhub` 命令和本地 HTTP API/static server。
- `apps/web`: React/Vite 控制台。

## Config Profiles

`linka-skillhub.config.json` owns all source and target paths. The default profile is `sandbox`, which resolves every agent source and target under `.sandbox/` for development and tests. The `local` profile points at the user's real agent directories and must be selected explicitly with `--profile local`.

## Data Flow

1. Scan adapters enumerate known skill roots for Mavis/OpenCode/Claude/Codex.
2. Core parses each `SKILL.md`, hashes the whole package, and assigns a stable variant id.
3. Import copies original packages to `skills/<name>/<variant-id>` and writes `registry/skills.json`.
4. Review writes compact JSON summaries under `registry/reviews`.
5. Distribution creates a plan from registry packages to selected target agent dirs.
6. Apply backs up conflicting target dirs under `~/.linka-skillhub/backups` before copying.

## Compatibility Rule

The default portable set is the strict intersection: `SKILL.md` exists, YAML frontmatter is an object, `name` and `description` are strings, `name` is lowercase kebab-case, and deterministic checks do not find agent-specific runtime dependencies or high-risk secrets.
