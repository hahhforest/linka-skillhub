# Commit Conventions

状态：生效  
更新时间：2026-05-22

本项目从本文件生效后使用 Conventional Commits 风格。提交历史要让人能快速看出一次提交的意图、范围、风险和验证结果。

## 格式

```text
<type>(optional-scope): <short summary>

<body: why, what changed, risk, validation>

<footer: optional references or BREAKING CHANGE>
```

示例：

```text
feat(intersection): add source-to-target copy preview

Implement the A -> B intersection flow with source and target paths,
copy preview, and explicit confirmation before writing target dirs.

Validation:
- pnpm verify
```

## Type

| Type | 用途 |
| --- | --- |
| `feat` | 新增用户可见能力或完整功能切片 |
| `fix` | 修复 bug；不要使用 `bug` 作为 type |
| `docs` | 文档、设计说明、开发规则 |
| `test` | 测试、测试脚本、测试数据 |
| `refactor` | 不改变行为的结构调整 |
| `perf` | 性能优化 |
| `style` | 格式、排版、无行为影响的样式调整 |
| `build` | 构建系统或依赖管理 |
| `ci` | CI / 自动化流程 |
| `chore` | 维护性杂项，不应承载产品行为变化 |
| `revert` | 回滚提交 |

## Scope

scope 使用小写短词，描述主要影响边界。常用 scope：

- `workflow`
- `intersection`
- `distribution`
- `review`
- `registry`
- `github`
- `config`
- `ui`
- `tests`
- `docs`

不要把 issue id 当 scope。issue 或任务编号放在 footer。

## Summary

- 使用英文 type/scope，summary 可以用中文或英文，但必须清楚。
- summary 不以句号结尾。
- summary 尽量控制在 50 个字符附近，硬上限 72 个字符。
- 一个 commit 只表达一个完整意图。

## Body

有以下任一情况时必须写 body：

- 功能切片跨多个模块。
- 有状态机、数据流、安全边界或路径写入变化。
- 有取舍、风险或未完成事项。
- 用户明确要求“有细节时候不止标题行”。

body 必须包含：

- Why：为什么要改。
- What：主要改了什么。
- Risk：风险或剩余限制。
- Validation：跑过哪些测试或浏览器审查。

推荐模板：

```text
<type>(<scope>): <summary>

Why:
- ...

What:
- ...

Risk:
- ...

Validation:
- ...
```

## Breaking Changes

破坏性变更必须使用以下任一形式：

```text
feat(api)!: change registry manifest shape
```

或 footer：

```text
BREAKING CHANGE: registry manifest v1 is no longer accepted.
```

## Project Rules

- 所有新 commit 必须使用 Conventional Commit type。
- 北极星任务的 commit 应该是少数几个完整功能切片，不要无限细分。
- 每个 phase commit 必须在 body 中记录验收命令，通常是 `pnpm verify`。
- 如果浏览器审查发现 issue，先修到 issue 清零，再 commit。
- 中文 commit message 仍然可以使用，但 type/scope 必须保留英文标准前缀。
