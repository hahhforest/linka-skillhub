# North Star Plan: linka-skillhub

状态：执行中  
更新时间：2026-05-22

## 北极星任务

做一个真正可用的 `linka-skillhub`：把用户本机多个 Code Agent 的 skills 统一扫描、汇总、审核、版本追溯、分发和交汇。

它必须满足：

- 支持 Mavis、Codex、Claude Code、OpenCode、`.agents/skills`。
- 默认在真实 skills 的 mirror 沙箱中运行和测试，不写真实 Agent 目录。
- 真实目录写入只在用户显式选择 `local` profile 并二次确认后发生。
- 用户能看懂每个动作：从哪里复制到哪里、会写什么、为什么跳过、为什么可共享或不可共享。
- 使用本机 Code Agent 审核必须由用户显式点击、选择 Agent、确认运行；不能静默执行。
- 审核 prompt、审核结果和 UI 支持中文/英文，默认中文。
- Registry 可以 Git 版本追溯，并可同步到 GitHub。
- 每次实现都必须通过状态机测试、核心逻辑测试、浏览器流程测试和浏览器巡检。

## 工作方式

主会话是 Owner，只负责：

- 制定计划。
- 明确分工和边界。
- 写验收标准。
- 指挥 worker / verifier。
- 审阅结果，打回不合格产物。
- 控制 commit 边界。

Commit message 必须遵守 `docs/commit-conventions.md`。格式使用
Conventional Commits，例如 `feat(intersection): ...`、
`fix(review): ...`、`docs(plan): ...`。有风险、测试或跨模块改动时，
commit body 必须写明 Why / What / Risk / Validation。

协作者负责：

- 独立审查代码和设计差距。
- 实现明确边界内的代码或测试。
- 写交付说明和证据。

禁止：

- 无限细分 phase。
- 无验收标准地堆 UI。
- 用“跑过 smoke”冒充真实使用。
- 未经用户确认写真实 skills 目录。
- 前端直接承载路径安全和业务判定。

## Commit 级 Phase

### Commit 1：重建核心工作流 UI

目标：把当前 UI 从“功能散点”改成围绕明确工作流的控制台。

范围：

- 总览：只承担扫描结果、来源筛选、选择 skill、进入下一步。
- 审核中心：独立页面或明确弹框，选择审核范围和审核器。
- 交汇中心：实现 A -> B 的可选复制工作流。
- 分发管理：实现 Registry -> 多目标的批量分发工作流。
- 技能详情：展示状态证据和可执行动作。
- 设置入口：没有完整实现前不放假按钮。

关键修复：

- 交汇中心必须显示来源绝对路径和目标绝对路径。
- 交汇中心选择 skill 后必须有“预览交汇复制”和“确认复制到目标 Agent”。
- 分发管理不能再裸写“生成分发计划 / 执行分发”，改为“预览复制结果 / 确认复制到选中的目标 Agent”。
- Copy / Overwrite / Skip 必须用中文解释原因。
- 最近扫描改为扫描结果，可滚动，选择用途明确。

验收：

- 浏览器流程测试覆盖：扫描确认、左侧 Agent 筛选、交汇 A -> B 预览、交汇确认复制、分发预览、分发确认复制。
- UI 巡检 issues 为 0，且截图显示无广告式静态文案。
- 状态统计与当前筛选范围一致。

### Commit 2：实现显式 Code Agent 审核

目标：把用户提出的“选择本机 Code Agent 去审核”做成完整流程。

范围：

- 检测本机 Codex、Claude Code、OpenCode、Mavis CLI 是否可用。
- 审核弹框显示可用/不可用状态和原因。
- 用户选择一个审核器后，才能点击开始审核。
- 中文 UI 使用中文 prompt，英文 UI 使用英文 prompt。
- 审核结果写入 Registry，并在列表/详情中显示摘要、证据和建议。

验收：

- 规则审核不调用任何 Code Agent。
- Code Agent 审核必须有用户确认。
- 没有可用 Agent 时，弹框提示安装或使用规则审核。
- 中英文 UI 下审核摘要语言正确。
- Agent 输出非法 JSON 时有 fallback 或明确失败提示。

### Commit 3：完善 Registry / GitHub 同步与安全确认

目标：让 Registry 成为真正可追溯的 skill 仓库，并让 GitHub 同步可控。

范围：

- Registry 页面显示当前 repo path、branch、remote、dirty status。
- 提交 Registry 变更时让用户输入或确认中文 commit message。
- 推送 GitHub 前显示仓库 URL、可见性、风险扫描结果。
- 支持加载已有 GitHub registry。
- local profile 写入真实目录必须二次确认，并显示真实 source/target/backup 路径。

验收：

- 在 mirror registry 上能完成 commit/push/pull 流程。
- API 拒绝越界 registry path 和 target path。
- local profile 下写入按钮必须出现二次确认。
- GitHub repo 默认 private。

### Commit 4：完整测试体系与产品收敛

目标：让每次迭代可以自动发现“看不懂、假功能、状态错乱”的问题。

范围：

- 状态机单测覆盖 scan/import/review/intersection/distribution/settings/github sync。
- 核心逻辑测试覆盖 mirror/local path safety、symlink、invalid skill、agent-bound、backup。
- 浏览器流程测试覆盖五个主要页面。
- 浏览器巡检把用户指出过的问题写成断言：无广告文案、按钮有解释、路径可见、选择后有下一步。

验收：

- `pnpm typecheck` 通过。
- `pnpm test` 通过。
- `node scripts/ui-audit.mjs` issues 为 0。
- `node scripts/ui-flow-test.mjs` 通过。
- 截图产物显示交汇、分发、审核流程都是真实可用的。

## 主动推进规则

- 每个 commit 完成后立即进入下一个 commit 级 phase，不等待用户说“继续”。
- 如果遇到设计冲突，Owner 先按北极星目标做保守决策，并在文档中记录假设。
- 每半小时检查一次：当前 phase 是否完成、测试是否通过、是否应该进入下一 phase。
- 用户醒来后应该能看到：已完成 commit、测试证据、剩余风险，而不是一堆未收敛碎片。

## 半小时检查内容

每次检查记录：

1. 当前 commit phase。
2. 已完成事项。
3. 正在阻塞的问题。
4. 最近一次测试结果。
5. 下一步动作。

记录位置：`.agents/team-work/nightly-progress.md`。

## 当前实现状态

截至 2026-05-22 01:25：

- Commit 1 已完成：交汇中心具备 A -> B 来源/目标路径展示、预览交汇复制、确认复制；分发管理文案改为预览/确认，并展示 action/reason/path。
- Commit 2 已完成：审查弹框显示规则审核和本机 Code Agent 可用性、审查范围、输出语言、写入位置。
- Commit 3 已完成：Registry 页面具备 Git 状态、pull、commit+push 入口。
- Commit 4 进行中：收敛测试矩阵和浏览器巡检，使用 `pnpm verify` 作为退出门槛。
