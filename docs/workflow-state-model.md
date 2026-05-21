# Workflow State Model

状态：草案 2026-05-22

本文定义 `linka-skillhub` 控制台和本地 API 的功能状态机。它是实现、UI 验收和测试用例的共同口径，不替代 `docs/product-flow.md`，而是把每个功能拆成明确的 states、events/actions、guards、side effects、error states、visible UI requirements 和 test cases。

## Shared Model

### Core Entities

- `Profile`：当前运行配置。默认安全 profile 是 `mirror`；`local` 指向真实本机目录，任何写入必须显式确认。
- `SkillSource`：一个 agent 下的来源目录，包含 `agent`、`scope`、`rootPath`、`defaultSelected`、`exists`、`includeNested`。
- `SkillPackage`：扫描出的 skill 包，包含来源、路径、hash、variant、frontmatter、status、issues、evidence。
- `RegistryManifest`：`registry/skills.json`，记录导入后的 skill 包清单。
- `ReviewResult`：`registry/reviews/*.json`，记录规则审查或 agent 审查结果。
- `DistributionPlan`：从 registry skill 包到目标 agent 目录的 copy / overwrite / skip 计划。
- `DistributionRun`：一次已执行分发的结果，包含 copied、skipped、backups。

### Shared Runtime States

- `idle`：无操作运行；可触发用户动作。
- `confirming`：等待用户确认动作范围或风险。
- `loading`：正在读取配置、扫描、读 registry、生成计划或 Git 查询。
- `running`：正在执行会写磁盘、调用审查器或 Git 的动作。
- `succeeded`：动作完成，并产生可展示结果。
- `failed`：动作失败，错误可恢复；保留之前已成功的数据。
- `blocked`：guard 未满足，动作不能开始。

### Shared Events And Actions

- `loadApp`：读取 agent 定义、target、profile、registry 路径，并可加载最近一次扫描结果。
- `confirmAction` / `cancelAction`：确认或取消一个需要用户明确授权的动作。
- `selectSkill` / `clearSelection`：更新后续 review / distribution 的 skill 范围。
- `retry`：从 `failed` 重新进入前一个可执行动作。
- `changeProfile`：切换 profile；必须清空依赖旧 profile 的 scan、selection、plan 和 transient error。

### Shared Guards

- 所有服务端路径必须从当前 profile/config 解析，不能信任前端传入的可执行 path。
- 写入真实本机目录前必须满足 `profile === local` 的二次确认；非 `local` profile 仍要显示写入目标。
- `skillIds`、`targetAgents`、`reviewer`、`language` 必须属于当前已知集合。
- UI 显示的统计必须基于当前可见筛选范围，主状态桶互斥：`invalid/unsafe` > `agent_bound` > `valid+portable` > other。
- 任何失败不得清空上一次成功结果，除非用户显式重新扫描或切换 profile。

### Shared Error States

- `config_missing`：找不到或无法读取 `linka-skillhub.config.json`，只能展示恢复指引。
- `profile_missing`：请求的 profile 不存在。
- `path_outside_allowed_root`：服务端检测到 registry、source 或 target path 越界。
- `network_or_process_failed`：本地 API、agent CLI、Git 或文件系统命令失败。
- `stale_view`：UI 结果对应的 profile/filter/registry 与当前选择不一致，必须提示重新生成。

## Scan

### States

- `empty`：没有当前 profile 的 scan result。
- `ready`：已有最近一次 scan result，可筛选、选择和导入。
- `confirming_scan`：弹框展示 profile、来源目录、scope、是否包含 builtin/system。
- `scanning`：服务端枚举来源目录、解析 `SKILL.md`、计算 hash、分类状态。
- `scan_succeeded`：更新 skill list、summary、source distribution、last scanned time。
- `scan_failed`：保留旧结果并显示失败原因。

### Events / Actions

- `clickScan`：进入 `confirming_scan`。
- `confirmScan(includeDefaultExcluded, selectedSourceIds?)`：调用 scan。
- `cancelScan`：回到 `ready` 或 `empty`。
- `scanCompleted(skills, summary)`：进入 `scan_succeeded`，再稳定为 `ready`。
- `scanFailed(error)`：进入 `scan_failed`。

### Guards

- 至少有一个 enabled source；不存在的 source 可显示但不阻塞扫描。
- `selectedSourceIds` 只能来自当前 profile 的 discovered sources。
- `includeDefaultExcluded=false` 时跳过 builtin/system 或 defaultSelected=false 的 source。
- 扫描只读 source，不写 registry、target 或真实 skills 目录。

### Side Effects

- 读取 source roots 和 nested skill dirs。
- 解析 frontmatter，生成 `issues` 和 `evidence`。
- 对整个 skill package 生成 hash 和 stable variant id。
- 更新 UI 内存中的 skills、summary、source counts、visible filters。

### Error States

- `source_read_failed`：某个 source 无法读取；该 source 标记失败，整体可继续时展示 partial result。
- `skill_parse_failed`：单个 skill YAML 或 metadata 无效；skill 进入 `invalid`，不让整次扫描失败。
- `scan_process_failed`：配置或遍历异常导致整次扫描失败。

### Visible UI Requirements

- 空状态必须说明“尚未扫描”，并提供“开始扫描”。
- 扫描确认框必须列出 profile、来源目录、scope、包含/排除策略。
- 扫描中按钮禁用并显示进度状态，不允许重复触发。
- 完成后展示总数、四个主状态桶、来源分布和可滚动 skill 列表。
- 每个 skill 行显示 source agent、name、description、主状态；选择含义必须写明是用于 review/distribution。

### Test Cases

- 无历史结果时展示 empty state，点击扫描后必须先出现确认框。
- `mirror` profile 扫描不会写入 registry 或 target。
- 缺失 `SKILL.md` 或 frontmatter 无效的包进入 `invalid`，不终止其他包扫描。
- source filter 改变后 summary 按可见范围重算，主状态桶总和等于 visible total。
- scan API 失败后旧结果仍保留，错误信息可见。

## Registry Import

### States

- `not_ready`：没有 scan result，不能导入。
- `ready_to_import`：已有 scan result 和当前 profile registry path。
- `confirming_import`：展示导入范围、registry path、会跳过的来源。
- `importing`：复制原始 skill package 并写 manifest。
- `import_succeeded`：展示 imported、skipped、manifest path。
- `import_failed`：导入失败，保留 scan result。

### Events / Actions

- `clickImport`：从 `ready_to_import` 进入 `confirming_import`。
- `confirmImport`：调用 import。
- `cancelImport`：回到 `ready_to_import`。
- `importCompleted(result)`：进入 `import_succeeded`。
- `importFailed(error)`：进入 `import_failed`。

### Guards

- 必须已有当前 profile 的 scan result；若没有，提示先扫描。
- registry path 必须锁定为当前 profile 的 `registryRepo` 或服务端允许的 repo root。
- 默认不导入 default excluded source，除非用户显式启用。
- 不导入 `invalid` 或 `unsafe` 的策略若被采用，必须在确认框中明确；当前实现可导入扫描结果但分发默认阻断风险 skill。

### Side Effects

- 确保 registry repo 目录和 `registry/` 存在。
- 将原始 package 复制到 `skills/<name>/<variant-id>`。
- 写入 `registry/skills.json`，包含 `generatedAt` 和 skill manifest。
- 不自动提交 Git，不自动推送 GitHub。

### Error States

- `registry_path_invalid`：repo path 越界或不可写。
- `package_copy_failed`：某个 package 复制失败；失败结果必须说明是否 partial。
- `manifest_write_failed`：manifest 写入失败；UI 提示 registry 可能不完整，需要重新导入。

### Visible UI Requirements

- 按钮文案使用“导入到 Registry”。
- 按钮下方说明“复制原始包并更新 `registry/skills.json`”。
- 确认框展示导入数量、跳过数量、registry path 和 profile。
- 完成提示必须包含 imported、skipped、manifest path。
- 导入中禁止重复导入、切换 profile 或执行分发。

### Test Cases

- 没有 scan result 时导入按钮禁用或点击后进入 blocked，并提示先扫描。
- 导入成功后 registry 中存在 `registry/skills.json` 和 skill package 副本。
- `repoPath` 被前端篡改到 profile registry 之外时服务端拒绝。
- 导入失败后 scan result 和 selection 不丢失。
- 重复导入同一 scan result 生成稳定 manifest 和 variant path。

## Review

### States

- `not_ready`：没有 registry manifest 或没有可审查 skill。
- `selecting_review_scope`：用户选择 selected skills 或 all visible skills。
- `confirming_reviewer`：弹框选择 `rules` 或可用 agent reviewer。
- `reviewing`：执行规则审查或 agent 审查。
- `review_succeeded`：写入 review 文件并更新 skill review status display。
- `review_failed`：审查失败或 fallback 后需展示原因。

### Events / Actions

- `selectReviewScope(skillIds | visible)`：确定审查范围。
- `chooseReviewer(reviewer)`：选择 `rules`、`codex`、`claude`、`opencode` 或 `mavis`。
- `confirmReview(language)`：调用 review。
- `reviewCompleted(reviews)`：进入 `review_succeeded`。
- `reviewFailed(error)`：进入 `review_failed`。

### Guards

- 审查读取 registry 中的 skill；若 registry 不存在，提示先导入。
- `reviewer` 必须可用；不可用 agent 只能展示为 disabled，并提供原因。
- 没有显式选择 skill 时，“审查全部可见”必须让用户确认数量。
- `language` 必须与当前 UI language 同步，允许用户在确认框内查看。
- Agent review 超时或返回非法 JSON 时，必须使用规则审查 fallback 或明确失败策略。

### Side Effects

- 规则审查不调用 LLM，只检查 YAML、名称、路径、敏感信息、agent-bound 线索。
- Agent 审查构建固定 prompt，并调用本地 agent CLI。
- 写入 `registry/reviews/<skillId>-<reviewer>.json`。
- 更新 UI 中 review summary、recommendation、evidence 和 reviewed marker。

### Error States

- `registry_missing`：没有 manifest 或 registry package。
- `reviewer_unavailable`：agent CLI 未安装或未配置 command。
- `review_timeout`：agent 审查超时。
- `review_output_invalid`：agent 返回不能解析或不符合 schema 的结果。
- `review_write_failed`：review 文件写入失败。

### Visible UI Requirements

- “运行审查”必须先打开审查器选择弹框，不静默调用 code agent。
- 规则审查说明必须写明“不调用 LLM”。
- 弹框显示审查范围、数量、reviewer、输出语言和会写入的目录。
- 审查中显示正在处理的数量，禁用重复提交。
- 结果用当前 UI 语言展示，失败和 fallback 都必须可见。

### Test Cases

- 选择 `rules` 时不会调用任何 agent CLI，并写入 review JSON。
- 英文 UI 发起 review 时 summary/recommendation 使用英文口径。
- Agent reviewer 不可用时，选项 disabled，并提示安装或使用规则审查。
- Agent 返回非法 JSON 时 fallback 或失败提示可验证。
- 没有 selected skills 时，“审查全部可见”确认框展示正确数量。

## Distribution

### States

- `not_ready`：没有 registry manifest 或没有 selection。
- `selecting_targets`：用户选择一个或多个 target agents。
- `planning`：服务端根据当前 profile 和 registry 生成 plan。
- `plan_ready`：显示 copy / overwrite / skip 明细和 warnings。
- `confirming_apply`：执行前确认，`local` profile 必须二次确认。
- `applying`：备份冲突目录并复制 package。
- `apply_succeeded`：展示 copied、skipped、backups。
- `apply_failed`：执行失败，展示 partial result 风险。

### Events / Actions

- `selectDistributionSkills(skillIds)`：设置分发范围。
- `selectTargets(targetAgents)`：设置目标 agents。
- `clickGeneratePlan`：进入 `planning`。
- `planCompleted(plan)`：进入 `plan_ready`。
- `clickApply`：进入 `confirming_apply`。
- `confirmApply`：重新生成或校验 plan 后执行。
- `applyCompleted(run)`：进入 `apply_succeeded`。
- `applyFailed(error)`：进入 `apply_failed`。

### Guards

- 必须至少选择一个 skill 和一个 target agent。
- Plan 必须由服务端用当前 registry/profile 重新生成，不能信任前端传入 path。
- 默认跳过 `unsafe`、`invalid`、`agent_bound`，除非用户显式启用对应 override。
- `local` profile 执行写入必须二次确认，并展示真实 target path。
- Apply 前 plan 的 `profile`、`registryPath`、`skillIds`、`targetAgents` 必须未过期；否则进入 `stale_view` 并要求重新生成。

### Side Effects

- 读取 `registry/skills.json` 和 package path。
- 为每个 skill/target 生成 `copy`、`overwrite` 或 `skip` item。
- 覆盖前将已有 target skill dir 备份到当前 profile `stateDir/backups`。
- 将 registry package 复制到 target agent skill 目录。
- Apply 后刷新 scan result 或提示用户重新扫描。

### Error States

- `manifest_missing`：registry manifest 不存在。
- `target_not_configured`：选择的 target agent 在当前 profile 中不可用。
- `blocked_status`：skill 因 unsafe/invalid/agent_bound 被默认跳过。
- `backup_failed`：覆盖前备份失败，必须停止该 item 的 copy。
- `copy_failed`：复制失败，保留已成功项结果并提示 partial。

### Visible UI Requirements

- 计划页必须显示 action、skill、target、reason、existing path、backup path。
- Warnings 必须显示在执行按钮附近。
- `skip` 不应混在成功复制数里，必须单独计数。
- `local` profile 的执行确认必须比非 local 更显眼，展示“真实本机目录”。
- Apply 完成后展示 copied、skipped、backup paths，并提供重新扫描入口。

### Test Cases

- 没有 selection 或 target 时生成计划按钮 disabled。
- `unsafe` skill 默认进入 skip，开启 override 后才可计划 copy/overwrite。
- 已存在 target dir 时 plan action 为 `overwrite` 且包含 backup path。
- Apply 前切换 profile 后旧 plan 不能执行，必须要求重新生成。
- 备份失败时对应 item 不复制，并显示失败原因。

## Agent Source Filter

### States

- `all_sources`：未选中 agent filter，显示全部 scan result。
- `filtered_by_agent`：选中一个 agent，只显示该来源 skills。
- `filtered_empty`：选中 agent 但没有匹配 skills。
- `filter_stale`：filter 对应的 agent 在切换 profile 或重新加载后不存在。

### Events / Actions

- `clickAgent(agent)`：设置 filter。
- `clickActiveAgent(agent)`：取消 filter，回到 `all_sources`。
- `scanCompleted`：保留仍存在的 filter，否则进入 `filter_stale`。
- `clearFilter`：回到 `all_sources`。

### Guards

- agent 必须存在于当前 profile 的 discovered agents。
- Filter 只影响 UI 可见范围、summary 和默认 “all visible” 动作，不改变原始 scan result。
- Selection 中不可见 skills 必须可被保留但要在执行 review/distribution 时明确数量，或在切换 filter 时提示清理。

### Side Effects

- 重新计算 visible skills、summary、source distribution、status distribution。
- 更新 “审查全部可见” 和 “分发所选” 的范围说明。
- 不触发 scan、不写 registry、不修改 selection，除非用户选择清空不可见项。

### Error States

- `unknown_agent_filter`：URL/local state 中保存的 agent 不存在。
- `filter_no_results`：filter 有效但无结果，不是系统错误。

### Visible UI Requirements

- 左侧 agent 列表必须呈现为可点击 filter，active 状态清晰。
- 再次点击 active agent 必须取消筛选。
- 统计卡、来源分布、状态分布、列表都随 filter 改变。
- 空结果状态必须说明当前筛选条件，并提供清除筛选。

### Test Cases

- 点击 agent 后列表只包含该 agent 的 skills。
- 再次点击同一 agent 后恢复全部 skills。
- Filter 后四个主状态桶总和等于 filtered total。
- 切换 profile 后不存在的 filter 自动清除或显示 stale 并可恢复。
- Filter 不会触发新的 scan API 调用。

## Language Switch

### States

- `zh`：中文 UI、中文 review 默认 prompt/summary。
- `en`：英文 UI、英文 review 默认 prompt/summary。
- `switching_language`：正在切换并重渲染文本。
- `language_persist_failed`：语言已切换但持久化失败。

### Events / Actions

- `clickLanguageSwitch`：切换 `zh <-> en`。
- `setLanguage(language)`：更新 UI dictionary、review default language、local preference。
- `reviewStarted`：读取当前 language 作为 review language。

### Guards

- 所有 UI 文案必须来自统一字典，不能在组件内散写。
- Language switch 只改变文本和后续 review 输出语言，不改变 scan/import/distribution 数据。
- Review 运行中禁止切换影响当前任务；可允许切换 UI，但 running review 的 language 固定为启动时值。

### Side Effects

- 更新按钮、状态、弹框、错误、空状态文案。
- 持久化用户语言偏好。
- 后续 review 请求传递 `language: zh | en`。

### Error States

- `missing_translation_key`：某个 key 缺失时显示 fallback 并记录开发错误。
- `language_persist_failed`：local storage 或配置写入失败，不阻止当前 UI 切换。

### Visible UI Requirements

- 顶部 banner 提供语言切换入口；中文下显示 “English”，英文下显示 “中文”。
- 切换后当前页面、弹框和状态提示立即更新。
- Review 确认框必须显示本次输出语言。
- 不允许中英文混杂的核心按钮文案。

### Test Cases

- 从中文切到英文后 overview、repo、distribution 主要按钮全部变英文。
- 英文 UI 发起 rules review 时 API 参数为 `language: en`。
- 切换语言不清空 scan result、filter、selection 或 plan。
- 缺失翻译 key 时测试能捕获，UI 不崩溃。
- Review running 时切换 UI 不改变该次 review 的 language 参数。

## Settings / Profile

### States

- `settings_closed`：设置入口未打开。
- `settings_open`：展示当前 language、profile、registry path、include builtin/system、default reviewer。
- `editing_settings`：用户修改尚未应用的设置。
- `confirming_profile_change`：切换 profile 前提示会清空当前 scan/selection/plan。
- `applying_settings`：应用设置。
- `settings_applied`：设置生效。
- `settings_failed`：设置保存或加载失败。

### Events / Actions

- `openSettings` / `closeSettings`：打开或关闭设置。
- `changeLanguage`：委托给 language switch 状态机。
- `chooseProfile(profile)`：进入 `confirming_profile_change`。
- `confirmProfileChange`：重新加载 config、agents、targets、registry path。
- `toggleIncludeDefaultExcluded`：更新默认扫描范围。
- `setDefaultReviewer(reviewer)`：更新 review 默认值。

### Guards

- 设置入口必须是真设置弹框或独立页，不能跳转到仓库管理。
- Profile 必须存在于 config。
- 从非 `local` 切到 `local` 时必须明确标记真实本机目录风险。
- Profile 改变后必须清空旧 profile 的 scan result、selection、distribution plan 和 transient messages。
- Registry path 在 UI 可读但不能由前端任意改写为 profile 之外路径。

### Side Effects

- 重新读取 `/api/agents` 或等价配置 endpoint。
- 更新 profile badge、registry path、source dirs、targets。
- 持久化 settings preference，或仅更新当前 session，取决于实现策略。
- 清空 stale data 并要求重新扫描。

### Error States

- `profile_load_failed`：目标 profile 配置无法加载。
- `settings_save_failed`：偏好持久化失败。
- `local_profile_unconfirmed`：用户未确认真实目录风险，切换被取消。

### Visible UI Requirements

- 设置内容至少包括 language、profile、registry path、include builtin/system、default reviewer。
- 当前 profile badge 明确区分 `mirror/sandbox` 与 `local`，`local` 使用危险样式。
- 切换 profile 的确认框说明会清空当前结果，并列出新 profile 的 source/target 概要。
- 未实现设置前不显示设置按钮；已显示就必须可完成上述操作。

### Test Cases

- 点击设置打开独立弹框，而不是切到 repo view。
- 切换到 `local` profile 必须出现真实目录确认。
- 确认 profile change 后 scan result、selection、plan 被清空，agents/targets 更新。
- 取消 profile change 后所有当前数据不变。
- Registry path 越界输入不能被应用到服务端动作。

## GitHub Sync

### States

- `repo_unknown`：尚未读取 registry Git 状态。
- `repo_clean`：工作区干净，远端已配置或未配置均需展示。
- `repo_dirty`：registry 有未提交变更。
- `remote_missing`：没有 GitHub remote。
- `sync_checking`：读取 git status / remote。
- `pulling`：执行 `git pull --ff-only`。
- `committing`：执行 add/commit registry 相关文件。
- `pushing`：执行 `git push`。
- `sync_succeeded`：展示 Git 输出摘要。
- `sync_failed`：展示失败原因和下一步。

### Events / Actions

- `refreshGitStatus`：读取 status、branch、remote。
- `setRemote(url)`：配置 GitHub remote。
- `pull`：从 remote 快进更新。
- `commit(message)`：提交 registry、skills、prompts 变更。
- `push`：推送当前 branch 到 remote。
- `syncToGitHub`：推荐顺序为 status -> pull -> commit if dirty -> push。

### Guards

- GitHub sync 只能作用于当前 profile `registryRepo`。
- Commit 只应 add registry 仓库内允许的目录：`registry`、`skills`、`prompts`。
- `pull --ff-only` 失败时不能自动 merge 或 rebase，必须让用户处理。
- 没有 remote 时不能 push，必须先 set remote。
- 不得提交 linka-skillhub app 代码改动；Git 操作 cwd 必须是 registry repo。

### Side Effects

- 读取 Git 状态和 remote。
- 可写 `.git/config` remote。
- 可创建 commit。
- 可向 GitHub remote push。
- 不改变 scan result；成功后可刷新 registry status。

### Error States

- `git_not_repo`：registry path 不是 Git 仓库。
- `remote_missing`：未配置 remote。
- `auth_failed`：GitHub 凭证无效或权限不足。
- `non_fast_forward`：pull/push 需要人工处理冲突或先同步。
- `nothing_to_commit`：提交时无变更；作为非致命结果展示。

### Visible UI Requirements

- 仓库管理页必须有明确的“推送到 GitHub”或同步入口，说明会提交 registry 变更并推送远端。
- 显示当前 branch、dirty 状态、remote URL 状态和最近一次 sync 结果。
- Git 输出必须摘要化展示，不把长日志塞满主界面。
- 失败时给出具体动作建议：配置 remote、登录 GitHub、先 pull、手动解决冲突。
- 同步中禁用 import/review/distribution 写操作，避免 registry 状态变化。

### Test Cases

- registry 不是 Git 仓库时显示 `git_not_repo`，不会运行 commit/push。
- 没有 remote 时 push 按钮 disabled，并提供 set remote。
- dirty registry 执行 sync 后产生 commit，并调用 push。
- `pull --ff-only` 失败时不会自动 merge/rebase，错误可见。
- GitHub sync 不会 add 或提交 linka-skillhub app 工作区文件。
