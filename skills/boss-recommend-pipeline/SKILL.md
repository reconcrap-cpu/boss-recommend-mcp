---
name: "boss-recommend-pipeline"
description: "Use when users ask to run Boss recommend-page filtering and screening via boss-recommend-mcp; confirm filters, criteria, optional target_count, and run-level post_action (plus max_greet_count when post_action=greet) before execution."
---

# Boss Recommend Pipeline Skill

## Purpose

当用户希望在 Boss 推荐页按条件筛选候选人时，优先调用 MCP 工具 `start_recommend_pipeline_run` 完成端到端任务：

1. 解析推荐页筛选指令
2. 第一阶段仅确认非岗位参数（filters / criteria / target_count / post_action / max_greet_count）
3. 先执行页面就绪检查（端口、登录态、是否在 recommend 页面）
4. 页面就绪后再提取岗位列表，列出全部岗位并让用户确认本次岗位
5. 用户确认岗位后先点击该岗位，再执行 recommend-search-cli 与 recommend-screen-cli
6. 返回结果摘要

严格顺序约束（必须遵守）：

- 在页面就绪前，禁止询问“岗位（job）要选哪个”
- 只有在工具返回 `job_options` 后，才允许发起岗位确认
- 岗位确认时必须展示 `job_options` 里的全部岗位，禁止只列一部分或让用户盲填

路由约束（必须遵守）：

- 当用户请求中出现 “recommend / 推荐页 / boss recommend / recommend page / /web/chat/recommend” 语义时，只能走 `boss-recommend-pipeline`
- 只有当用户**明确指向搜索页面**（如 “搜索页 / boss search page / /web/chat/search / 在搜索页找人”）时，才允许转交 `boss-recruit-pipeline` 并调用 `run_recruit_pipeline`
- 不要调用 `boss-recruit-pipeline`，也不要调用 `run_recruit_pipeline`，除非上一条（明确 search 页面语义）命中
- 提到“搜索条件 / 搜索弹窗 / 搜索关键词”但上下文仍是推荐页时，仍属于 recommend 流程，禁止误切到 recruit
- 当 recommend 流程返回任何错误（包括 `JOB_TRIGGER_NOT_FOUND` / `NO_RECOMMEND_IFRAME` / `BOSS_LOGIN_REQUIRED`）时，禁止把 recommend 请求降级到 recruit 流程；必须先修复 recommend 的页面就绪或登录态问题

路由示例（中英文都要兼容）：

- “通过 Boss 推荐页面帮我找人” -> `boss-recommend-pipeline`
- “Help me find candidates on Boss recommend page” -> `boss-recommend-pipeline`
- “在 Boss 搜索页面帮我找人” -> `boss-recruit-pipeline`
- “Find candidates on Boss search page” -> `boss-recruit-pipeline`

## Required Confirmation

在真正执行前，按两个阶段确认：

阶段 A（页面就绪前，禁止问岗位）：

- 学校标签（`school_tag`，支持多选）
  - 若输入混合了有效与无效选项（如 `985,211,qs100`），必须忽略无效项并保留有效项；不要直接回退到“不限”
- 学历（`degree`）
- 性别（`gender`）
- 是否过滤近14天已看（`recent_not_view`）
- screening criteria 是否正确
- `criteria` 必须是用户输入的开放式自然语言描述，禁止用“严格执行/宽松执行”等预设选项代替
- 若之前步骤未收到 `criteria`，必须先让用户填写后再继续
- 即使已在之前步骤提取到 `criteria`（含 instruction / overrides），执行前也必须再次向用户复述并确认，可让用户直接改写
- `target_count`（目标筛选人数）是否需要设置（可不设上限）
- `post_action` 是否确定为 `favorite` 或 `greet`
- 当 `post_action=greet` 时，`max_greet_count`（最多打招呼人数）是否确定
  - 严禁在未询问用户的情况下自动把 `max_greet_count` 设为 `target_count` 或其他默认值

阶段 B（页面就绪后，且已拿到岗位列表）：

- 岗位（`job`）是否确定
  - 必须先列出 recommend 页岗位栏里识别到的全部岗位（来自工具返回的 `job_options`），让用户明确选择
  - 即使前序步骤已提取到 `job` 参数，执行前也必须再次展示岗位列表并让用户二次确认
  - 用户确认后必须先点击该岗位，再开始 search 和 screen
- 正式开始 search/screen 前，必须做最后一轮“全参数总确认”
  - 需要向用户复述并确认：岗位、school_tag、degree、gender、recent_not_view、criteria、target_count、post_action、max_greet_count
  - 只有用户明确最终确认后才允许执行

禁止行为（必须避免）：

- 第一轮就问“你要绑定哪个岗位”
- 让用户在未登录或未进入推荐页时先填岗位
- 在岗位确认时只展示部分岗位

`post_action` 的确认是**单次运行级别**的：

- 若用户确认 `favorite`，则本次运行中所有通过人选都统一收藏
- 若用户确认 `greet`，则本次运行中先按 `max_greet_count` 执行打招呼，超出上限后自动改为收藏
- 不要在每位候选人通过后再次逐个确认

## Instruction 原文锁定与执行前回显校验（必须遵守）

- 第一次收到用户自然语言需求时，必须把该条 `instruction` 原文锁定为 `locked_instruction_raw`。
- 后续所有调用（包括二轮确认、最终执行、重试）都必须复用同一条 `locked_instruction_raw`，禁止改写、扩写、摘要、同义替换、翻译。
- 未经用户明确要求，禁止 agent 自行生成新的 `instruction` 文案。
- 最终执行前（即准备提交 `job_confirmed=true` 与 `final_confirmed=true` 的那次调用），必须先向用户逐字回显本次将提交的 `instruction`，并明确提示“将按以下原文执行”。
- 回显校验规则：若当前待提交 `instruction` 与 `locked_instruction_raw` 不一致（按原样字符串比对），必须停止调用工具，先修正为原文后再执行。
- 仅当用户明确要求修改 `instruction` 时，才允许更新 `locked_instruction_raw`；更新后仍需再次逐字回显并确认。

## Tool Contract

- Tool name: `start_recommend_pipeline_run`
- Input:
  - `instruction` (required)
  - `confirmation`
    - `filters_confirmed`
    - `school_tag_confirmed`
    - `school_tag_value`（建议回传最终确认值，避免二轮调用丢失）
    - `degree_confirmed`
    - `degree_value`
    - `gender_confirmed`
    - `gender_value`
    - `recent_not_view_confirmed`
    - `recent_not_view_value`
    - `criteria_confirmed`
    - `target_count_confirmed`
    - `target_count_value` (integer, optional)
    - `post_action_confirmed`
    - `post_action_value` (`favorite|greet`)
    - `final_confirmed`
    - `job_confirmed`
    - `job_value` (string)
    - `max_greet_count_confirmed`
    - `max_greet_count_value` (integer)
  - `overrides`
  - `school_tag`（可传单值或数组，如 `["985","211"]`）
    - `degree`（可传单值或数组；如“本科及以上”应展开为 `["本科","硕士","博士"]`）
    - `gender`
    - `recent_not_view`
    - `criteria`
    - `job`
    - `target_count`
    - `post_action`
    - `max_greet_count`

长耗时宿主兼容（推荐）：

- 默认调用 `start_recommend_pipeline_run` 启动异步流程（状态查询按“用户触发”执行，不自动轮询）。
- `start_recommend_pipeline_run` 会先走同步一致的前置门禁（登录/页面就绪/岗位确认/最终确认）。
- 只有门禁通过后才会返回 `ACCEPTED + run_id`；否则会先返回 `NEED_INPUT/NEED_CONFIRMATION/FAILED`，必须先按提示补齐。
- 若宿主要显式拆成三步，也可使用：
  - `start_recommend_pipeline_run`
  - `get_recommend_pipeline_run`
  - `cancel_recommend_pipeline_run`
  - `pause_recommend_pipeline_run`
  - `resume_recommend_pipeline_run`
- 建议轮询间隔 5~15 秒。
- 已有 `run_id` 时不要重复 start，优先继续轮询同一个 run。
- 若宿主明确需要阻塞式返回，再传 `execution_mode=sync`。
- 暂停后继续必须复用同一 `run_id`：先 `pause_recommend_pipeline_run`，轮询到 `run.state=paused` 后再 `resume_recommend_pipeline_run`。
- `pause_recommend_pipeline_run` 返回 `PAUSE_REQUESTED` 仅表示已接收请求；真正暂停点在“当前候选人处理完成后”。
- `resume_recommend_pipeline_run` 会复用暂停前的 CSV 与 checkpoint，无需重新 start。

异步状态查询策略（必须遵守）：

- 默认是“被动查询”模式：拿到 `ACCEPTED + run_id` 后，本轮到此结束，不要在同一轮自动 `sleep + get_recommend_pipeline_run`。
- 只有当用户明确要求“查询进度/继续跟进/持续监控”时，才调用 `get_recommend_pipeline_run`。
- 禁止在无用户指令时进行循环 `Start-Sleep` 或自动轮询并主动播报进度。
- 若用户明确要求持续监控，再按 5~15 秒间隔轮询，并在用户要求停止后立即停止轮询。

## Execution Notes

- 推荐页筛选入口在 recommend 页面，不是 search 页面。
- 页面就绪后，必须先读取岗位栏并展示全部岗位供用户确认；若未确认岗位，禁止开始 search/screen。
- recommend-search-cli 只负责应用推荐页筛选项。
- recommend-screen-cli 负责滚动推荐列表、打开详情、提取完整简历图、调用多模态模型判断，并按单次确认的 `post_action` 执行收藏或打招呼。
- 详情页处理完成后必须关闭详情页并确认已关闭。

## Fallback

如果 MCP 不可用，改用：

`npx -y @reconcrap/boss-recommend-mcp@latest run --instruction "..." [--confirmation-json '{...}'] [--overrides-json '{...}']`

禁止错误回退：

- 不能把 recommend 请求回退到 `boss-recruit-mcp` / `run_recruit_pipeline`
- 不能执行 `boss-recruit-mcp doctor` 作为 recommend 流程的环境检查
- 若检测到当前环境只有 recruit MCP，应先修复 recommend MCP 配置，再继续

CLI fallback 的状态机与 MCP 保持一致：

- `NEED_INPUT`
- `NEED_CONFIRMATION`
- `COMPLETED`
- `FAILED`

## Setup Checklist

执行前先检查：

- `boss-recommend-mcp` 是否已安装
- `screening-config.json` 是否存在（安装后通常会自动生成模板）
- `baseUrl/apiKey/model` 是否已由用户填写为可用值（不能是模板占位符）
- Chrome 远程调试端口是否可连
- 当前 Chrome 是否停留在 `https://www.zhipin.com/web/chat/recommend`

在开始执行 recommend-search-cli / recommend-screen-cli 前，必须做页面就绪门禁：

- 检查 Chrome DevTools 端口是否可连接
- 检查 Boss 是否已登录
- 检查当前页面是否已停留在 recommend 页面
- 若检测到当前 URL 为 `https://www.zhipin.com/web/user/?ka=bticket`（或同类登录页 URL），立即判定为“未登录”，只提示用户登录；不要继续做页面脚本修改
- 若端口不可连接：先自动尝试启动 Chrome，并且必须使用 `--remote-debugging-port=<port>` + `--user-data-dir=<profile>`
- 若检测到 Boss 已登录但不在 recommend 页面：先自动 navigate 到 `https://www.zhipin.com/web/chat/recommend`
- 若检测到 Boss 未登录：提示用户先登录；用户登录后先 navigate 到 recommend 页面再继续
- 自动修复后仍失败时，才提示用户介入并等待“已就绪”后重试

## Preflight 失败自动修复

当工具返回 `status=FAILED` 且 `error.code=PIPELINE_PREFLIGHT_FAILED` 时：

1. 若 `diagnostics.checks` 中 `screen_config` 失败，优先引导用户填写 `screening-config.json` 的 `baseUrl/apiKey/model`（必须让用户提供真实值，不可保留模板值）。
   - 若 `required_user_action=confirm_screening_config_updated`，表示检测到默认占位词未替换。
   - 这时必须先把 `guidance.config_dir` / `guidance.config_path` 告诉用户，让用户去该目录修改后明确回复“已修改完成”，再继续下一步。
   - 禁止 agent 自行代填或猜测示例值（如 `test-key` / `mock-key` / `https://example.com` / `gpt-4` 占位等）
   - 必须逐项向用户确认 `baseUrl`、`apiKey`、`model` 后再写入
2. 优先查看 `diagnostics.auto_repair`，若有自动修复动作则先基于其结果继续执行或给出最小化补救提示。
3. 若自动修复后仍失败，再读取 `diagnostics.recovery.agent_prompt`，直接把这段提示词交给 AI agent 执行环境修复。
4. 若 `diagnostics.recovery.agent_prompt` 不存在，使用下面的兜底提示词（严格顺序，不可跳步）：

```text
你是环境修复 agent。请根据 diagnostics.checks 修复依赖，必须串行执行：
1) 若 node_cli 失败：先安装 Node.js >=18，未成功前禁止执行 npm install。
2) 若任意 npm_dep_* 失败：再安装 npm 依赖（chrome-remote-interface / ws / sharp）。
每一步完成后重新运行 doctor，全部通过后再重试 start_recommend_pipeline_run。
```

安装顺序约束（必须遵守）：

- 没有 Node.js 时，不能先装 npm 包

## Response Style

- 用结构化中文输出
- 先给用户确认卡片，再正式执行
- 第一轮确认卡片不得包含 `job` 字段
- 只有当工具返回 `job_options` 后，岗位确认卡片才允许出现 `job` 字段，且必须完整列出 `job_options`
- 对 `school_tag/degree/gender/recent_not_view` 必须逐项提问并逐项确认，不可合并成一句“filters已确认”
- 询问 `criteria` 时必须使用开放式文本输入，不要提供“严格执行/宽松执行”等枚举选项
- 当页面就绪检查失败时，提示文案里必须包含 `debug_port` 和 recommend 页面 URL
- 若失败原因是未登录，提示文案必须明确给出登录 URL：`https://www.zhipin.com/web/user/?ka=bticket`
- 不要跳过 `post_action` 的首轮确认
- 不要把 recommend 流程说成 search 流程
