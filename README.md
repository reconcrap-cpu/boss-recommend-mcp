# @reconcrap/boss-recommend-mcp

Boss 推荐 / 搜索 / 聊天筛选 MCP（stdio）服务。

发布入口：

- npm: `@reconcrap/boss-recommend-mcp`（https://www.npmjs.com/package/@reconcrap/boss-recommend-mcp）
- GitHub: `reconcrap-cpu/boss-recommend-mcp`（https://github.com/reconcrap-cpu/boss-recommend-mcp）

2.0.0 是 CDP-only 重写版本：活跃浏览器路径只允许 Chrome DevTools Protocol 的 `DOM` / `Input` / `Page` / `Network` / `Accessibility` 等域，不使用 `Runtime.evaluate` 或页面 JS。包内保留 recommend、search/recruit、chat 三条域服务，并共享浏览器、生命周期、筛选、CV 获取、无限滚动、自愈与 CSV 报告层。

安装 `boss-recommend-mcp` 后可以直接：

- 读取推荐页岗位列表，供 cron / 一次性任务提前填写完整 `job` 参数。
- 运行推荐页筛选、搜索页筛选、聊天页筛选。
- 使用 Network 优先、完整滚动截图兜底的 CV 获取策略。
- 通过共享 run lifecycle 查询、暂停、恢复、取消任务。
- 把运行态保存在用户目录下的 `~/.boss-recommend-mcp/`（chat 默认在 `~/.boss-recommend-mcp/boss-chat/`，可通过 `BOSS_CHAT_HOME` 覆盖）。

MCP 工具：

- `list_recommend_jobs`（只读读取推荐页岗位下拉框，返回可直接用于 cron/一次性任务的 `job_names`）
- `start_recommend_pipeline_run`（异步启动；同样先经过前置门禁，通过后返回 run_id）
- `get_recommend_pipeline_run`（轮询 run_id 状态）
- `cancel_recommend_pipeline_run`（取消运行中任务）
- `pause_recommend_pipeline_run`（请求暂停 run；会在当前候选人处理完成后进入 paused）
- `resume_recommend_pipeline_run`（继续 paused run；沿用同 run_id 与同 CSV）
- `run_recommend_self_heal`（手动运维工具；扫描 Boss recommend 的 selector / network 规则漂移，并在确认后应用高置信度修复）
- `run_recruit_pipeline`
- `start_recruit_pipeline_run`
- `get_recruit_pipeline_run`
- `pause_recruit_pipeline_run`
- `resume_recruit_pipeline_run`
- `cancel_recruit_pipeline_run`
- `boss_chat_health_check`
- `prepare_boss_chat_run`
- `start_boss_chat_run`
- `get_boss_chat_run`
- `pause_boss_chat_run`
- `resume_boss_chat_run`
- `cancel_boss_chat_run`

推荐页 page scope：

- 支持 `recommend` / `featured` / `latest`，对应 Boss UI 的 `推荐` / `精选` / `最新`。
- 切换岗位后再选择 page scope；如果所选岗位没有用户要求的 scope，会自动回退到 `推荐` 并继续运行。

推荐页岗位列表：

```bash
boss-recommend-mcp list-jobs --slow-live --port 9222
```

返回的 `job_names` 可直接作为后续 `start_recommend_pipeline_run` 的 `confirmation.job_value` / `overrides.job`。

状态机：

- `NEED_INPUT`
- `NEED_CONFIRMATION`
- `COMPLETED`
- `FAILED`

异步 run 状态快照（`get_recommend_pipeline_run`）：

- `queued`
- `running`
- `paused`
- `completed`
- `failed`
- `canceled`

旧版 recommend -> chat 自动衔接属于 legacy-only 行为，2.0.0 的 CDP-only MCP 路径会 fail closed。需要聊天页筛选时，请在 recommend 完成后显式调用 `prepare_boss_chat_run` / `start_boss_chat_run`。

## 设计特点

- 页面目标固定为 `https://www.zhipin.com/web/chat/recommend`
- 活跃浏览器自动化为 CDP-only；硬静态门禁会阻止活跃路径重新引入 `Runtime.evaluate` / 页面 JS。
- 支持推荐页原生筛选：学校标签 / 学历 / 性别 / 近14天没有
- 支持推荐页岗位列表只读读取：`list_recommend_jobs` / `boss-recommend-mcp list-jobs`
- 支持推荐页 page scope：`推荐` / `精选` / `最新`
- 学校标签支持多选语义：如“985、211”会同时勾选这两项
- 学校标签对“混合输入”按容错处理：如“985、211、qs100”会忽略无效项 `qs100`，保留并应用有效项；仅当全部无效或用户明确“不限”时才回落到“不限”
- 学历支持单选与多选语义：如“本科及以上”会展开为 `本科/硕士/博士`；如“大专、本科”只勾选这两项
- 执行前会逐项确认筛选参数：学校标签 / 学历 / 性别 / 是否过滤近14天已看
- 页面就绪（已登录且在 recommend 页）后，会先提取岗位栏全部岗位并要求用户确认本次岗位；确认后先点击岗位，再执行 search/screen
- 在真正开始 search/screen 前，会进行最后一轮全参数总确认（岗位 + 全部筛选参数 + criteria + target_count + post_action + max_greet_count）
- npm 全局安装后会自动执行 install：生成 skill、导出 MCP 模板，并自动尝试写入已检测到的外部 agent MCP 配置（含 Trae / trae-cn / Cursor / Claude / OpenClaw）
- 2.x installer 会迁移已存在的 legacy Boss MCP 配置：把 `boss-recommend` 指向统一 `@reconcrap/boss-recommend-mcp`，并从同一个 `mcp.json` 中移除旧 `boss-recruit-mcp` / standalone `boss-chat` / 本地 legacy Boss 路径；写入前会生成 `.boss-mcp-migration-*.bak` 备份
- 2.x installer 会刷新外部 agent skills：`boss-recommend-pipeline`、`boss-recruit-pipeline`、`boss-chat` 都来自当前包，旧 recruit/chat skill 会被覆盖为统一 MCP 路由
- npm / npx 安装后会自动初始化 `screening-config.json` 模板（优先写入 workspace 的 `config/`，不可写时回退到用户目录）
- npm 安装流程会预创建运行目录（跨平台）：`~/.boss-recommend-mcp`、`~/.boss-recommend-mcp/runs`、`~/.boss-recommend-mcp/boss-chat` 及其 `logs/runs/profiles/reports/artifacts/state`
- `post_action` 必须在每次完整运行开始时确认一次
- `target_count` 会在每次运行开始时询问一次（可留空，不设上限）
- 当 `post_action=greet` 时，必须在运行开始时确认 `max_greet_count`
- 若检测到 `max_greet_count` 可能由 agent 自动默认（例如与 `target_count` 相同且原始指令未明确），会强制再次向用户确认
- 一旦确认 `post_action`，本次运行内所有通过人选都统一按该动作执行
- 若达到 `max_greet_count` 但流程仍需继续，后续通过人选会自动改为收藏
- 不会对每位候选人重复确认
- 推荐页详情处理完成后，会强制关闭详情页并确认已关闭
- 简历提取优先使用 Network 响应；没有可解析 Network CV 时，回退到完整滚动截图序列再交给多模态模型判断
- recommend / search / chat 正式运行默认全部使用 `screening-config.json` 配置的 LLM 筛选；deterministic/local scorer 只保留给明确测试场景，必须显式传 `debug_test_mode=true` 且 `screening_mode=deterministic` 或 `use_llm=false`。
- `detail_limit=0`、`no_filter`、`filter_enabled=false`、后置动作 dry-run、chat 求简历 dry-run 等调试路径不会在正式 live run 默认启用；需要测试时必须显式传 `debug_test_mode=true`。
- 提供显式运维自愈工具：只在手动调用 `run_recommend_self_heal` 时运行，不会接入正常 run / doctor / preflight 自动链路
- 运行前会自动做依赖体检（Node.js、Python、Pillow、`chrome-remote-interface`、`ws`），缺失时会在 `doctor` 与流水线失败诊断中明确提示
- 若 preflight 失败，返回 `diagnostics.recovery`（含有序修复步骤与 `agent_prompt`），可直接交给 AI agent 自动按顺序安装依赖
- 不依赖 PowerShell；Windows / macOS 均可运行（命令提示会按平台给出）
- package-local legacy/vendor 代码被隔离在 `legacy/research/`，不会进入 npm clean install 包。

## 安装

推荐（npm 全局安装）：

```bash
npm install -g @reconcrap/boss-recommend-mcp@latest
boss-recommend-mcp start
```

无需安装（npx 直接运行）：

```bash
npx -y @reconcrap/boss-recommend-mcp@latest start
```

从 GitHub 源码运行（开发/调试）：

```bash
git clone https://github.com/reconcrap-cpu/boss-recommend-mcp.git
cd boss-recommend-mcp
npm install
node src/cli.js start
```

### 迁移 legacy MCP / skills

全局 npm 安装会自动运行 `boss-recommend-mcp install`。该安装器会在 Windows 和 macOS 上自动检测 Trae / Trae CN / OpenClaw / QClaw 的常见配置目录：

- Windows: `%APPDATA%\Trae*\User\mcp.json`、`%USERPROFILE%\.trae*\mcp.json`、`%USERPROFILE%\.openclaw\mcp.json`、`%APPDATA%\OpenClaw\User\mcp.json`、`%USERPROFILE%\.qclaw\openclaw.json`
- macOS: `~/Library/Application Support/Trae*/User/mcp.json`、`~/.trae*/mcp.json`、`~/.openclaw/mcp.json`、`~/Library/Application Support/OpenClaw/User/mcp.json`

如果检测到 legacy Boss server entries，installer 会：

- 保留非 Boss MCP server。
- 写入统一 server：`boss-recommend -> npx -y @reconcrap/boss-recommend-mcp@<installed-version> start`
- 从同一个 `mcp.json` 删除旧 `boss-recruit-mcp`、standalone `boss-chat`、旧本地 Boss repo 路径，避免 agent 继续调用 legacy 包。
- 在原文件旁生成 `mcp.json.boss-mcp-migration-*.bak`。
- 同步外部 skills 目录里的 `boss-recommend-pipeline`、`boss-recruit-pipeline`、`boss-chat`。

手动指定 agent：

```bash
boss-recommend-mcp install --agent trae-cn
boss-recommend-mcp install --agent openclaw
boss-recommend-mcp install --agent qclaw
boss-recommend-mcp doctor --agent trae-cn
boss-recommend-mcp doctor --agent openclaw
boss-recommend-mcp doctor --agent qclaw
```

自定义路径：

```bash
BOSS_RECOMMEND_MCP_CONFIG_TARGETS="/path/to/mcp.json" boss-recommend-mcp install
BOSS_RECOMMEND_EXTERNAL_SKILL_DIRS="/path/to/skills" boss-recommend-mcp install
```

可选环境变量（用于跨 agent 自动配置）：

```bash
BOSS_RECOMMEND_HOME               # 统一状态目录，默认 ~/.boss-recommend-mcp
BOSS_CHAT_HOME                    # 覆盖 boss-chat 运行态目录；默认 ~/.boss-recommend-mcp/boss-chat
BOSS_RECOMMEND_SCREEN_CONFIG      # 显式指定 screening-config.json 路径（最高优先级）
BOSS_RECOMMEND_MCP_CONFIG_TARGETS   # JSON 数组或系统 path 分隔路径列表，指定额外 mcp.json 目标文件
BOSS_RECOMMEND_EXTERNAL_SKILL_DIRS  # JSON 数组或系统 path 分隔路径列表，指定额外 skills 根目录
```

推荐运行入口是 MCP 工具 `start_recommend_pipeline_run`。如果宿主是 QClaw 这类 shell-only agent，没有把 MCP tools 暴露给模型，可以使用 CDP-only CLI fallback：

```bash
npx -y @reconcrap/boss-recommend-mcp@latest run --detached --instruction-file boss-recommend-instruction.txt --overrides-file boss-recommend-overrides.json --confirmation-file boss-recommend-confirmation.json --slow-live --port 9222
```

`--detached` 会让父进程输出 `ACCEPTED + run_id` 后退出，子进程继续持有 Chrome DevTools 会话并执行长任务。岗位发现可以使用只读 CLI：

```bash
npx -y @reconcrap/boss-recommend-mcp@latest list-jobs --slow-live --port 9222
# 源码模式（GitHub clone 后）
node src/cli.js list-jobs --slow-live --port 9222
```

## 配置

`screening-config.json` 默认写入路径（按优先级）：

1. `BOSS_RECOMMEND_SCREEN_CONFIG`（若已设置）
2. `~/.boss-recommend-mcp/screening-config.json`（默认主路径）
3. `<workspace>/config/screening-config.json`（兼容历史路径）
4. `<workspace>/boss-recommend-mcp/config/screening-config.json`（兼容历史路径）
5. 兼容旧路径：`$CODEX_HOME/boss-recommend-mcp/screening-config.json`

配置路径优先级：

1. `BOSS_RECOMMEND_SCREEN_CONFIG`
2. `<workspace>/config/screening-config.json`（优先；在受限权限环境推荐使用）
3. `<workspace>/boss-recommend-mcp/config/screening-config.json`
4. `~/.boss-recommend-mcp/screening-config.json`（当 workspace 不可写或无 workspace 时回退）
5. 兼容旧路径：`$CODEX_HOME/boss-recommend-mcp/screening-config.json`

注意：

- `install` / `postinstall` 会自动创建 `screening-config.json` 模板（若目标路径可写）
- 当当前目录是系统目录（例如 `C:\\Windows\\System32`）、用户主目录根（例如 `C:\\Users\\<name>`）或磁盘根目录时，不会再写入 `<cwd>/config`，而是回退到 `~/.boss-recommend-mcp/screening-config.json`
- `doctor` / `run` 默认优先读取 `~/.boss-recommend-mcp/screening-config.json`；如需强制其它路径，请设置 `BOSS_RECOMMEND_SCREEN_CONFIG`
- 首次运行时，若仍检测到默认占位词（如 `replace-with-openai-api-key`），pipeline 会返回配置目录并要求用户修改后确认“已修改完成”再继续
- 在 `npx` 临时目录（如 `AppData\\Local\\npm-cache\\_npx\\...`）执行时，不会再把该临时目录当作 `screening-config.json` 目标路径
- `boss-chat` 运行态默认固定写入 `~/.boss-recommend-mcp/boss-chat`；即使宿主把 MCP 进程启动在系统根目录，也不会再尝试写入 `/.boss-chat`
- 若当前工作区存在历史 `.boss-chat` 且新用户目录尚未初始化，首次运行会自动把 `logs/runs/profiles/reports/artifacts/state` 迁移到新目录，并保留旧目录作为只读历史来源

配置样例见：

```bash
config/screening-config.example.json
```

必填字段：

- `baseUrl`
- `apiKey`
- `model`

可选字段：

- `openaiOrganization`
- `openaiProject`
- `debugPort`：未显式传 `port` 时，recommend / search / chat CDP-only MCP run 和健康检查默认连接这个 Chrome 调试端口。
- `outputDir`：recommend / search / chat 完成后的最终 CSV 与 report JSON 会写入这里；run state / checkpoint 仍保留在各自状态目录，方便 pause/resume/cancel。
- `llmThinkingLevel`：默认 `low`。可设为 `off/minimal/low/medium/high/auto/current`，用于控制 OpenAI-compatible LLM 的 thinking/reasoning 强度。
- `humanRestEnabled`：默认 `false`。当前 CDP-only recommend / search / chat run 尚未实现随机休息层，因此会读取并保留该字段但不改变节奏；如后续重新加入 human rest，应以此字段为默认值。

## 常用命令

npm 包安装后可直接使用可执行命令 `boss-recommend-mcp`。以下示例展示源码模式（`node src/cli.js`）：

```bash
node src/cli.js install --agent trae-cn
node src/cli.js init-config
node src/cli.js config set --base-url https://api.openai.com/v1 --api-key <your-key> --model gpt-4o-mini --thinking-level off
node src/cli.js set-port --port 9222
node src/cli.js doctor --agent trae-cn
node src/cli.js launch-chrome --port 9222
node src/cli.js list-jobs --slow-live --port 9222
node src/cli.js chat health-check
node src/cli.js chat prepare-run --slow-live --port 9222
```

## Recommend + Chat Follow-up（Legacy-only）

旧版曾支持 recommend screen 完成后自动开始 boss-chat，把 chat 配置放到同一个 recommend run 的顶层 `follow_up.chat`。2.0.0 的 CDP-only MCP 路径已将该链式 orchestration fenced，避免回到 legacy page-JS 路径。推荐做法是：recommend run 完成后，显式启动 chat 工具。

历史 payload 形状如下，仅作迁移参考：

```json
{
  "follow_up": {
    "chat": {
      "criteria": "候选人需要继续在聊天页过滤有 AI Agent 经验的人选",
      "start_from": "unread",
      "greeting_text": "您好，方便发下简历吗？",
      "target_count": 20,
      "profile": "default",
      "dry_run": false,
      "no_state": false,
      "safe_pacing": true,
      "batch_rest_enabled": true
    }
  }
}
```

说明：

- `criteria` / `start_from` / `target_count` 为必填
- `greeting_text` 可选（兼容 `greetingText`）
- `profile` 可选，默认 `default`
- `job` 与 `port` 继承 recommend run 已选岗位和调试端口
- `baseUrl` / `apiKey` / `model` 不再单独传入，固定复用 recommend 的 `screening-config.json`
- `greeting_text` 默认优先级：本次显式值 > profile 历史值 > 内置默认招呼语（`Hi同学，能麻烦发下简历吗？`）
- 若缺少 `follow_up.chat` 必填项，pipeline 会返回 `NEED_INPUT`
- 如需聊天页筛选，请调用 `prepare_boss_chat_run` 获取岗位列表，再调用 `start_boss_chat_run`。
- `boss-chat` 状态统一写入 `~/.boss-recommend-mcp/boss-chat`（或 `BOSS_CHAT_HOME` 指定目录），不再依赖工作区 `cwd`

## Chat-only

安装 `boss-recommend-mcp` 后，无需额外安装 `boss-chat`：

- CLI：
  - `boss-recommend-mcp chat health-check`
  - `boss-recommend-mcp chat prepare-run`
  - `boss-recommend-mcp chat start-run` / `run` 在 2.0.0 CLI 中 fenced；活跃异步 chat run 请使用 MCP `start_boss_chat_run` 或 live harness。
  - `boss-recommend-mcp chat get-run|pause-run|resume-run|cancel-run`
- MCP：
  - `boss_chat_health_check`
  - `prepare_boss_chat_run`
  - `start_boss_chat_run`
  - `get_boss_chat_run`
  - `pause_boss_chat_run`
  - `resume_boss_chat_run`
  - `cancel_boss_chat_run`
- vendored `boss-chat` CLI 还支持 `--data-dir <path>` 与 `BOSS_CHAT_HOME`，默认目录为 `~/.boss-recommend-mcp/boss-chat`（若设置 `BOSS_RECOMMEND_HOME`，则默认 `<BOSS_RECOMMEND_HOME>/boss-chat`）
- 对 `/.boss-chat`、系统目录等危险运行目录会主动拒绝启动并返回 `UNSAFE_DATA_DIR`，避免在 harness 丢参时误写根目录
- `boss_chat_health_check` 与 chat run 返回结果会包含 `data_dir` 与 `data_dir_source`，便于定位是参数/环境变量/默认路径生效

chat-only 交互建议：

- 先调用一次 `prepare_boss_chat_run`（可不带参数），服务会先导航到 `https://www.zhipin.com/web/chat/index` 并返回 `NEED_INPUT`，其中包含岗位 `job_options` 与待补字段。
- 然后基于 `job_options` 让用户选择 `job`，并补齐 `start_from`、`target_count`、`criteria` 后调用 `start_boss_chat_run` 启动任务。
- `greeting_text` 可选；未传时会自动沿用 profile 上次输入，若无历史值则使用默认招呼语（`Hi同学，能麻烦发下简历吗？`）。
- `target_count` 支持正整数、`all`、`-1`；若用户给出 `全部候选人` / `所有候选人`，会自动按不限（扫到底）处理。

Trae-CN / 长对话防循环建议：

- 固定流程：`boss_chat_health_check` -> `prepare_boss_chat_run(空参可)` -> 一次性补齐 `job/start_from/target_count/criteria` -> `start_boss_chat_run`。
- `start_boss_chat_run` 的工具 schema 已把 `job/start_from/target_count/criteria` 标记为必填；不要用它获取岗位列表。
- 若 `pending_questions` / UI 选项里出现“扫到底（必须传 `target_count="all"`）”，下一次工具调用请直接照抄 `"target_count": "all"`，不要只保留“扫到底”这层自然语言语义。
- `start_boss_chat_run` 返回 `ACCEPTED` 后直接结束当前回合，不要自动轮询。
- 缺参或校验失败时，一次性列出全部缺失/错误项，避免重复同一句提示触发宿主“陷入循环”保护。
- 仅当用户明确要求“查进度”时再调用 `get_boss_chat_run`。

## 长流程 Agent 兼容模式

当宿主 agent 对“长时间无回包”敏感（容易误判失败）时，建议改用异步工具：

1. 调用 `start_recommend_pipeline_run`。
2. 若返回 `NEED_INPUT/NEED_CONFIRMATION/FAILED`，按同步流程先补齐前置条件（登录、页面就绪、岗位确认、最终确认）。
3. 仅当门禁通过时，接口才会返回 `ACCEPTED + run_id`；默认不自动轮询，建议按需调用 `get_recommend_pipeline_run`（长任务至少每 30 分钟一次，除非用户明确要求更频繁）。
4. 若需临时中断，调用 `pause_recommend_pipeline_run`；接口会先返回 `PAUSE_REQUESTED`，随后在安全边界进入 `paused`。
5. `paused` 后调用 `resume_recommend_pipeline_run` 继续执行；同一 `run_id` 会复用同一 CSV，并从 checkpoint 无缝续跑。
6. 若需终止，调用 `cancel_recommend_pipeline_run`。
7. 若该 run 配置了 `follow_up.chat`，screen 完成后父 run 会进入 `chat_followup`；继续轮询同一个 `run_id` 即可，不需要再新建 chat run。

说明：

- `start_recommend_pipeline_run` 为异步入口，但不会跳过同步确认流程。
- 定时心跳默认 120 秒一次；`updated_at` 仍会在阶段或进度变化时刷新。
- 每个 run 会持久化到 `~/.boss-recommend-mcp/runs/<run_id>.json`（可通过 `BOSS_RECOMMEND_HOME` 覆盖）。
- screen 阶段会持久化 checkpoint：`~/.boss-recommend-mcp/runs/<run_id>.checkpoint.json`。
- 暂停采用“当前候选人处理完成后暂停”语义，避免停在详情页中间态。
- 轮询期间不要重复 `start`，优先复用已有 `run_id`，避免重复筛选。
- 处于 `chat_followup` 时，对父 run 的 `pause/resume/cancel` 会自动代理到内置 boss-chat 子 run。

## MCP Tool Input

```json
{
  "instruction": "推荐页筛选211女生，近14天没有，有 AI Agent 经验，符合标准的直接沟通",
  "confirmation": {
    "filters_confirmed": true,
    "school_tag_confirmed": true,
    "school_tag_value": ["985", "211"],
    "degree_confirmed": true,
    "degree_value": ["本科", "硕士", "博士"],
    "gender_confirmed": true,
    "gender_value": "女",
    "recent_not_view_confirmed": true,
    "recent_not_view_value": "近14天没有",
    "criteria_confirmed": true,
    "target_count_confirmed": true,
    "target_count_value": 20,
    "post_action_confirmed": true,
    "post_action_value": "greet",
    "final_confirmed": true,
    "job_confirmed": true,
    "job_value": "算法工程师（视频/图像模型方向） _ 杭州",
    "max_greet_count_confirmed": true,
    "max_greet_count_value": 10
  },
  "overrides": {
    "school_tag": ["985", "211"],
    "degree": ["本科", "硕士", "博士"],
    "gender": "女",
    "recent_not_view": "近14天没有",
    "criteria": "候选人需要有 AI Agent 或 MCP 工具开发经验",
    "job": "算法工程师（视频/图像模型方向） _ 杭州",
    "target_count": 20,
    "post_action": "greet",
    "max_greet_count": 10
  },
  "follow_up": {
    "chat": {
      "criteria": "继续在聊天页处理有 AI Agent 或 MCP 项目经验的人选",
      "start_from": "unread",
      "target_count": 20,
      "profile": "default",
      "safe_pacing": true
    }
  }
}
```

## 测试

```bash
npm run test:parser
npm run test:pipeline
npm run test:async
npm run test:boss-chat
```

## 当前实现边界

- 选择器已经按 recommend 页面语义切换
- `post_action` 的运行级单次确认已经落到 parser / pipeline / screen CLI
- 图片化简历筛选已经接入 recommend-screen-cli
- 页面按钮的真实联调验证仍然应该按你的要求，在交互前先征求确认后再做
