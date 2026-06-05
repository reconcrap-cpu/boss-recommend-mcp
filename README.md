# @reconcrap/boss-recommend-mcp

Boss 推荐 / 搜索 / 聊天筛选 MCP（stdio）服务。

发布入口：

- npm: `@reconcrap/boss-recommend-mcp`（https://www.npmjs.com/package/@reconcrap/boss-recommend-mcp）
- GitHub: `reconcrap-cpu/boss-recommend-mcp`（https://github.com/reconcrap-cpu/boss-recommend-mcp）

## AI harness install entrypoint

如果用户只把这个 GitHub 链接交给 Codex、Claude Code、Cursor、OpenClaw、QClaw、Trae 等 AI harness，并要求“安装这个工具”，请优先执行本节，而不是直接在 macOS 上裸跑 `npm install -g`。

AI harness 不能只完成 npm 安装就结束。安装流程还必须帮助用户完成必填 LLM 配置；如果用户没有提前提供，请向用户索取：

- LLM base URL（默认可用 `https://api.openai.com/v1`）
- LLM API key
- LLM model（默认可用 `gpt-4.1-mini`）

然后写入配置：

```bash
boss-recommend-mcp config set --base-url <baseUrl> --api-key <apiKey> --model <model> --thinking-level low
boss-recommend-mcp doctor
```

如果用户用 macOS bootstrap，它会自动尝试交互式询问并写入这些字段。非交互式 AI harness 如果拿不到用户输入，应暂停并询问用户上述三项，不要把安装标记为完成。

macOS 首次安装推荐使用仓库里的 nvm bootstrap。它会把 Node/npm/global packages 放到用户目录，避免首次安装或后续升级时出现：

```text
EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@reconcrap'
```

这是 npm global prefix 权限问题，不是 `boss-recommend-mcp` 包内部创建目录失败。

macOS 一键安装：

```bash
curl -fsSL https://raw.githubusercontent.com/reconcrap-cpu/boss-recommend-mcp/main/scripts/install-macos.sh | bash
```

如果要直接配置某个宿主：

```bash
curl -fsSL https://raw.githubusercontent.com/reconcrap-cpu/boss-recommend-mcp/main/scripts/install-macos.sh | bash -s -- --agent openclaw
curl -fsSL https://raw.githubusercontent.com/reconcrap-cpu/boss-recommend-mcp/main/scripts/install-macos.sh | bash -s -- --agent qclaw
curl -fsSL https://raw.githubusercontent.com/reconcrap-cpu/boss-recommend-mcp/main/scripts/install-macos.sh | bash -s -- --agent trae-cn
```

安装后，未来升级只需要在同一个 nvm shell 里运行：

```bash
npm -g i @reconcrap/boss-recommend-mcp@latest
boss-recommend-mcp where
```

如果升级前 `npm config get prefix` 返回 `/usr/local`，说明当前 shell 没有使用 nvm Node；请先重新加载 nvm，不要使用 `sudo npm install -g`。

macOS bootstrap 会执行 `boss-recommend-mcp install --mcp-launch global-wrapper`。该模式会把 MCP 宿主配置为启动稳定 wrapper：`~/.boss-recommend-mcp/bin/boss-recommend-mcp-mcp-server`。这个 wrapper 每次启动时都会调用当前全局 `boss-recommend-mcp start`，因此后续 `npm -g i @reconcrap/boss-recommend-mcp@latest` 会更新 MCP 宿主实际运行的版本，不需要每次升级后重写 MCP 配置。

如果 AI harness 已经从用户处拿到 LLM 信息，可以非交互式传给 bootstrap：

```bash
curl -fsSL https://raw.githubusercontent.com/reconcrap-cpu/boss-recommend-mcp/main/scripts/install-macos.sh \
  | BOSS_RECOMMEND_BASE_URL="https://api.openai.com/v1" \
    BOSS_RECOMMEND_API_KEY="<apiKey>" \
    BOSS_RECOMMEND_MODEL="gpt-4.1-mini" \
    bash -s -- --agent openclaw
```

2.0.0 是 CDP-only 重写版本：活跃浏览器路径只允许 Chrome DevTools Protocol 的 `DOM` / `Input` / `Page` / `Network` / `Accessibility` 等域，不使用 `Runtime.evaluate` 或页面 JS。包内保留 recommend、search/recruit、chat 三条域服务，并共享浏览器、生命周期、筛选、CV 获取、无限滚动、自愈与 CSV 报告层。

安装 `boss-recommend-mcp` 后可以直接：

- 读取推荐页岗位列表，供 cron / 一次性任务提前填写完整 `job` 参数。
- 运行推荐页筛选、搜索页筛选、聊天页筛选。
- 使用 Network 优先、完整滚动截图兜底的 CV 获取策略。
- 通过共享 run lifecycle 查询、暂停、恢复、取消任务。
- 把运行态保存在用户目录下的 `~/.boss-recommend-mcp/`（chat 默认在 `~/.boss-recommend-mcp/boss-chat/`，可通过 `BOSS_CHAT_HOME` 覆盖）。

MCP 工具：

- `list_recommend_jobs`（只读读取推荐页岗位下拉框，返回可直接用于 cron/一次性任务的 `job_names`）
- `run_recommend`（`start_recommend_pipeline_run` 的短别名；用户已经确认且要现在启动时优先调用）
- `start_recommend_pipeline_run`（异步启动；先经过前置门禁，通过后返回 `ACCEPTED + run_id`）
- `prepare_recommend_pipeline_run`（只校验完整 payload；不启动筛选。主要用于显式预检或定时任务前校验；若现在运行，READY 后继续调用 `run_recommend` / `start_recommend_pipeline_run`）
- `schedule_recommend_pipeline_run`（只用于用户明确要求稍后/cron/定时；保存已 READY 的完整 payload，启动 detached scheduler，到点后直接调用 `start_recommend_pipeline_run`）
- `get_recommend_scheduled_run`（查询 package-owned 定时任务；到点后会显示内层 `run_id` 和 run 快照）
- `get_recommend_pipeline_run`（用已知 `run_id` 轮询状态）
- `list_recommend_pipeline_runs`（只读列出最近 run 摘要并返回 `latest_run`；忘记 `run_id` 时用它恢复，不要读磁盘 JSON）
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
- `list_boss_chat_jobs`（只读读取聊天页岗位列表；chat-only 获取 `job_options` 的首选别名，不会启动任务）
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

返回的 `job_names` 可直接作为后续 `start_recommend_pipeline_run` 的 `overrides.job`；旧版 `confirmation.job_value` 仍兼容。

Cron / 一次性定时任务设置建议先在设置阶段完成 Chrome/登录/岗位发现与一次总确认；确认文件推荐只包含 `{ "final_confirmed": true }`：

```bash
boss-recommend-mcp prepare-run --instruction-file boss-recommend-instruction.txt --overrides-file boss-recommend-overrides.json --confirmation-file boss-recommend-confirmation.json --slow-live --port 9222
boss-recommend-mcp schedule-run --schedule-delay-minutes 10 --instruction-file boss-recommend-instruction.txt --overrides-file boss-recommend-overrides.json --confirmation-file boss-recommend-confirmation.json --slow-live --port 9222
boss-recommend-mcp schedule-status --schedule-id <schedule_id>
```

只有 `prepare-run` 输出 `status: "READY"` 且 `cron_ready: true` 后，才继续调用 `schedule-run`。只有 `schedule-run` 输出 `status: "SCHEDULED"` 且带有 `schedule_id` 后，才算定时任务真的创建成功。不要让外部 AI harness 自己拼 `/tmp/*.log` shell cron 或未来对话提醒；那类 cron 容易丢失 JSON/file 参数并在到点后重新卡确认门禁。

状态机：

- `NEED_INPUT`
- `NEED_CONFIRMATION`
- `READY`（仅准备工具）
- `SCHEDULED`（仅定时工具）
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
- 执行前会先补齐筛选值、岗位、后置动作和休息强度，然后只做一次总确认
- 页面就绪（已登录且在 recommend 页）后，会先提取岗位栏全部岗位，使用精确岗位名填入 run payload，再进入总确认
- 在真正开始 search/screen 或创建 cron 前，总确认需包含岗位、全部筛选参数、criteria、target_count、post_action、可选 max_greet_count、restLevel 和定时信息（如适用）
- npm 全局安装后会自动执行 install：生成 skill、导出 MCP 模板，并自动尝试写入已检测到的外部 agent MCP 配置（含 Trae / trae-cn / Cursor / Claude / OpenClaw）
- 2.x installer 会迁移已存在的 legacy Boss MCP 配置：把 `boss-recommend` 指向统一 `@reconcrap/boss-recommend-mcp`，并从同一个 `mcp.json` 中移除旧 `boss-recruit-mcp` / standalone `boss-chat` / 本地 legacy Boss 路径；写入前会生成 `.boss-mcp-migration-*.bak` 备份
- 2.x installer 会刷新外部 agent skills：`boss-recommend-pipeline`、`boss-recruit-pipeline`、`boss-chat` 都来自当前包，旧 recruit/chat skill 会被覆盖为统一 MCP 路由
- npm / npx 安装后会自动初始化 `screening-config.json` 模板（优先写入 workspace 的 `config/`，不可写时回退到用户目录）
- npm 安装流程会预创建运行目录（跨平台）：`~/.boss-recommend-mcp`、`~/.boss-recommend-mcp/runs`、`~/.boss-recommend-mcp/boss-chat` 及其 `logs/runs/profiles/reports/artifacts/state`
- `post_action`、`target_count` 和可选 `max_greet_count` 通过同一次总确认锁定
- 新流程中 `confirmation.final_confirmed=true` 是总确认；旧版逐字段 `*_confirmed` JSON 仍兼容但不是推荐写法
- 一旦确认 `post_action`，本次运行内所有通过人选都统一按该动作执行
- 若达到可选 `max_greet_count` 但流程仍需继续，后续通过人选会继续筛选但不再执行打招呼动作
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

macOS 首次安装如果没有确认 npm prefix 在用户目录，优先使用本文开头的 `scripts/install-macos.sh`。完成 bootstrap 后，后续升级仍然使用同一个 npm 命令：

```bash
npm -g i @reconcrap/boss-recommend-mcp@latest
boss-recommend-mcp where
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

- Windows: `%APPDATA%\Trae*\User\mcp.json`、`%USERPROFILE%\.trae*\mcp.json`、`%USERPROFILE%\.openclaw\mcp.json`、`%USERPROFILE%\.openclaw\openclaw.json`、`%APPDATA%\OpenClaw\User\mcp.json`、`%USERPROFILE%\.qclaw\openclaw.json`
- macOS: `~/Library/Application Support/Trae*/User/mcp.json`、`~/.trae*/mcp.json`、`~/.openclaw/mcp.json`、`~/.openclaw/openclaw.json`、`~/Library/Application Support/OpenClaw/User/mcp.json`

如果检测到 legacy Boss server entries，installer 会：

- 保留非 Boss MCP server。
- Trae/Trae-CN 默认写入三个小 toolset server：`boss-recommend`（`BOSS_RECOMMEND_MCP_TOOLSET=recommend`）、`boss-chat`（`chat`）、`boss-recruit`（`recruit`）。这样 recommend/chat/search 的 tool list 不会互相挤占 agent 可见工具预算。
- 其它宿主默认仍写入兼容统一 server：`boss-recommend -> npx -y @reconcrap/boss-recommend-mcp@<installed-version> start`。
- 如果传入 `--mcp-launch global-wrapper`，Trae/Trae-CN 同样会写入三个 toolset server，但 command 指向升级稳定 wrapper。该 wrapper 会加载 `~/.nvm/nvm.sh` 并执行当前全局 `boss-recommend-mcp start`，适合 macOS 上通过 `npm -g i @reconcrap/boss-recommend-mcp@latest` 持续升级。
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

macOS 上如果希望 MCP 宿主总是使用全局 npm 最新安装版本：

```bash
boss-recommend-mcp install --mcp-launch global-wrapper --agent openclaw
boss-recommend-mcp install --mcp-launch global-wrapper --agent qclaw
boss-recommend-mcp install --mcp-launch global-wrapper --agent trae-cn
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
BOSS_RECOMMEND_MCP_TOOLSET        # 可选收窄 MCP 工具：all|recommend|chat|recruit；Trae/Trae-CN installer 会自动设置
BOSS_RECOMMEND_MCP_CONFIG_TARGETS   # JSON 数组或系统 path 分隔路径列表，指定额外 mcp.json 目标文件
BOSS_RECOMMEND_EXTERNAL_SKILL_DIRS  # JSON 数组或系统 path 分隔路径列表，指定额外 skills 根目录
```

推荐运行入口是 MCP 工具 `run_recommend` / `start_recommend_pipeline_run`。在 Trae/Trae-CN 这类普通 MCP 宿主中，用户完成总确认并要求现在运行时，应直接调用 `run_recommend` 或 `start_recommend_pipeline_run`。`prepare_recommend_pipeline_run` 只做显式预检或定时任务前校验；如果已经调用过 prepare 且返回 `READY + cron_ready=true`，下一步仍然必须调用 `run_recommend` / `start_recommend_pipeline_run`，不要改用 terminal/shell/run_command/PowerShell/CLI/manual JSON-RPC，也不要用短延迟 `schedule_recommend_pipeline_run` 冒充立即启动。`prepare` 能返回结果就证明该宿主已经可以调用本 MCP server。

只有宿主是 QClaw 这类真正 shell-only agent、没有把 MCP tools 暴露给模型、且当前会话从未成功调用过 `boss-recommend/prepare_recommend_pipeline_run` 时，才使用 CDP-only CLI fallback。CLI fallback 也必须显式传本次用户确认的 rest level：

```bash
npx -y @reconcrap/boss-recommend-mcp@latest run --detached --instruction-file boss-recommend-instruction.txt --overrides-file boss-recommend-overrides.json --confirmation-file boss-recommend-confirmation.json --rest-level <low|medium|high> --slow-live --port 9222
```

`--detached` 会让父进程输出 `ACCEPTED + run_id` 后退出，子进程继续持有 Chrome DevTools 会话并执行长任务。岗位发现可以使用只读 CLI：

如果用户明确要求稍后启动/cron/定时任务，不要手写系统 cron；用 package-owned scheduler：

```bash
npx -y @reconcrap/boss-recommend-mcp@latest prepare-run --instruction-file boss-recommend-instruction.txt --overrides-file boss-recommend-overrides.json --confirmation-file boss-recommend-confirmation.json --rest-level <low|medium|high> --slow-live --port 9222
npx -y @reconcrap/boss-recommend-mcp@latest schedule-run --schedule-delay-minutes 10 --instruction-file boss-recommend-instruction.txt --overrides-file boss-recommend-overrides.json --confirmation-file boss-recommend-confirmation.json --rest-level <low|medium|high> --slow-live --port 9222
npx -y @reconcrap/boss-recommend-mcp@latest schedule-status --schedule-id <schedule_id>
```

`schedule-run` 会保存同一份已验证 payload 并启动 detached scheduler worker；到点后 worker 会直接调用包内 `start_recommend_pipeline_run`，不会重新让 AI harness 拼参数。

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

也可以用 `llmModels` 配置多个 OpenAI-compatible 模型。运行时会先调用第一个模型；当该模型请求失败、超时、返回非 JSON、或没有返回 `{"passed": true/false}` 决策时，会自动切到下一个模型。未配置 `llmModels` 或数组为空时，继续使用上面的单模型字段，旧配置无需迁移。

```json
{
  "llmModels": [
    {
      "name": "primary",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-primary",
      "model": "gpt-4.1-mini"
    },
    {
      "name": "backup",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-backup",
      "model": "gpt-4.1-nano"
    }
  ],
  "greetingMessage": "Hi同学，能麻烦发下简历吗？",
  "llmThinkingLevel": "low",
  "llmMaxRetries": 1
}
```

可选字段：

- `openaiOrganization`
- `openaiProject`
- `greetingMessage`：chat 求简历流程发送的招呼语。兼容 `greetingText` / `greeting_text`；本次 run 显式传入的 `greeting_text` 优先级最高。
- `debugPort`：未显式传 `port` 时，recommend / search / chat CDP-only MCP run 和健康检查默认连接这个 Chrome 调试端口。
- `outputDir`：recommend / search / chat 完成后的最终 CSV 与 report JSON 会写入这里；run state / checkpoint 仍保留在各自状态目录，方便 pause/resume/cancel。
- `llmThinkingLevel`：默认 `low`。可设为 `off/minimal/low/medium/high/auto/current`，用于控制 OpenAI-compatible LLM 的 thinking/reasoning 强度。
- `humanBehavior`：默认 `{ "enabled": true, "profile": "paced_with_rests", "restLevel": "low" }`。用于 recommend / search / chat 的可靠性实验，支持：
  - `profile: "baseline"`：关闭人类节奏，保持确定性行为。
  - `profile: "paced"`：启用 CDP-only Bezier 鼠标移动、较大按钮的安全 inset 点击点、分块 `Input.insertText`、列表 wheel/settle jitter，以及小的动作前后读秒。
  - `profile: "paced_with_rests"`：在 `paced` 基础上启用候选人短休和批次休息。
  - `restLevel: "low"`：保持旧版休息策略不变，候选人短休 8% 概率暂停 3-7 秒，批次休息约每 25-32 人暂停 15-30 秒。
  - `restLevel: "medium"`：随机分散短/长休息，平均目标约每 5 小时或 700 位候选人累计休息 30 分钟。
  - `restLevel: "high"`：随机分散短/长休息，平均目标约每 5 小时或 700 位候选人累计休息 1 小时。
- `humanRestEnabled`：兼容旧配置。设为 `true` 时等价于 `humanBehavior.profile="paced_with_rests"`；设为 `false` 时不会关闭当前默认节奏。如需关闭，请显式设置 `humanBehavior.enabled=false` 或 `humanBehavior.profile="baseline"`。
  - recommend / search / chat 图片简历 fallback 与主列表滚动都会在启用 `listScrollJitter` 时使用 coverage-safe scroll jitter：每次 wheel delta 在安全范围内变化，并保留截图重叠、重复检测、bottom-marker / stop-boundary 逻辑，实际 delta 和 settle 时间会写入 artifact metadata。
  - chat/recommend/search run 也兼容显式参数 `safe_pacing`、`batch_rest_enabled` 与 `human_behavior.restLevel`：run 参数优先于配置文件。AI harness/skill 启动每次 run 前必须让用户明确选择 `low/medium/high`，再把选择写入 `human_behavior.restLevel`。

## 常用命令

npm 包安装后可直接使用可执行命令 `boss-recommend-mcp`。以下示例展示源码模式（`node src/cli.js`）：

```bash
node src/cli.js install --agent trae-cn
node src/cli.js init-config
node src/cli.js config set --base-url https://api.openai.com/v1 --api-key <your-key> --model gpt-4o-mini --thinking-level off --greeting-message "您好，方便发下简历吗？"
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
- `greeting_text` 默认优先级：本次显式值 > `screening-config.json.greetingMessage` > 内置默认招呼语（`Hi同学，能麻烦发下简历吗？`）
- 若缺少 `follow_up.chat` 必填项，pipeline 会返回 `NEED_INPUT`
- 如需聊天页筛选，请调用 `list_boss_chat_jobs` 或 `prepare_boss_chat_run` 获取岗位列表，再调用 `start_boss_chat_run`。chat-only、未读、全部聊天、求简历任务不要调用 `list_recommend_jobs` / `run_recommend` / `start_recommend_pipeline_run`；这些 recommend 工具会对明确的 chat/search 误路由 fail closed。
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
  - `list_boss_chat_jobs`
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

- 先调用一次 `list_boss_chat_jobs` 或 `prepare_boss_chat_run`（可不带参数），服务会先导航到 `https://www.zhipin.com/web/chat/index` 并返回 `NEED_INPUT`，其中包含岗位 `job_options` 与待补字段。
- 然后基于 `job_options` 让用户选择 `job`，并补齐 `start_from`、`target_count`、`criteria` 后调用 `start_boss_chat_run` 启动任务。
- `greeting_text` 可选；未传时使用 `screening-config.json.greetingMessage`，若未配置则使用默认招呼语（`Hi同学，能麻烦发下简历吗？`）。
- `target_count` 支持正整数、`all`、`-1`；若用户给出 `全部候选人` / `所有候选人`，会自动按不限（扫到底）处理。

Trae-CN / 长对话防循环建议：

- 固定流程：`boss_chat_health_check` -> `list_boss_chat_jobs(空参可)` / `prepare_boss_chat_run(空参可)` -> 一次性补齐 `job/start_from/target_count/criteria` -> `start_boss_chat_run`。
- chat-only 场景严禁调用 `list_recommend_jobs`、`run_recommend` 或 `start_recommend_pipeline_run`。
- `start_boss_chat_run` 的工具 schema 已把 `job/start_from/target_count/criteria` 标记为必填；不要用它获取岗位列表。
- 若 `pending_questions` / UI 选项里出现“扫到底（必须传 `target_count="all"`）”，下一次工具调用请直接照抄 `"target_count": "all"`，不要只保留“扫到底”这层自然语言语义。
- `start_boss_chat_run` 返回 `ACCEPTED` 后直接结束当前回合，不要自动轮询。
- 缺参或校验失败时，一次性列出全部缺失/错误项，避免重复同一句提示触发宿主“陷入循环”保护。
- 仅当用户明确要求“查进度”时再调用 `get_boss_chat_run`。

## 长流程 Agent 兼容模式

当宿主 agent 对“长时间无回包”敏感（容易误判失败）时，建议改用异步工具：

1. 调用 `run_recommend`（短别名）或 `start_recommend_pipeline_run`。
2. 若返回 `NEED_INPUT/NEED_CONFIRMATION/FAILED`，按同步流程先补齐前置条件（登录、页面就绪、岗位确认、最终确认）。
3. 仅当门禁通过时，接口才会返回 `ACCEPTED + run_id`；默认不自动轮询，建议按需调用 `get_recommend_pipeline_run`（长任务至少每 30 分钟一次，除非用户明确要求更频繁）。
4. 若需临时中断，调用 `pause_recommend_pipeline_run`；接口会先返回 `PAUSE_REQUESTED`，随后在安全边界进入 `paused`。
5. `paused` 后调用 `resume_recommend_pipeline_run` 继续执行；同一 `run_id` 会复用同一 CSV，并从 checkpoint 无缝续跑。
6. 若需终止，调用 `cancel_recommend_pipeline_run`。
7. 若该 run 配置了 `follow_up.chat`，screen 完成后父 run 会进入 `chat_followup`；继续轮询同一个 `run_id` 即可，不需要再新建 chat run。

说明：

- `run_recommend` 与 `start_recommend_pipeline_run` 是同一个异步 MCP 启动入口，但不会跳过同步确认流程；普通 MCP 宿主现在运行时优先直接调用它们。
- `prepare_recommend_pipeline_run` / `boss-recommend-mcp prepare-run` 只做参数门禁；它不启动筛选。普通 MCP 宿主只有在显式预检或定时任务准备时才需要先调用 prepare；prepare READY 后继续调用 `run_recommend` / `start_recommend_pipeline_run`，不要改用 CLI fallback。
- `prepare_recommend_pipeline_run` 的 READY 响应会带 `prepared_only=true`、`run_started=false`、`recommended_next_tool=start_recommend_pipeline_run`、`alternate_next_tool=run_recommend` 和 `next_action.do_not_call_prepare_again=true`；agent 应直接照这个字段继续下一步。
- `schedule_recommend_pipeline_run` / `boss-recommend-mcp schedule-run` 是推荐页定时启动的唯一推荐路径；它创建真实 package-owned detached scheduler，并返回 `schedule_id`。
- 如果忘记了 `run_id`，调用 `list_recommend_pipeline_runs` 获取 `latest_run.run_id`；不要用 PowerShell、`Get-Content`、terminal、CLI 或手动读取 `~/.boss-recommend-mcp/runs/*.json` 来恢复状态。
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
    "final_confirmed": true
  },
  "overrides": {
    "page_scope": "recommend",
    "school_tag": ["985", "211"],
    "degree": ["本科", "硕士", "博士"],
    "gender": "女",
    "recent_not_view": "近14天没有",
    "criteria": "候选人需要有 AI Agent 或 MCP 工具开发经验",
    "job": "算法工程师（视频/图像模型方向） _ 杭州",
    "target_count": 20,
    "post_action": "greet"
  },
  "human_behavior": {
    "restLevel": "medium"
  }
}
```

`confirmation.final_confirmed=true` 表示用户已经看过并确认总览。旧版 `page_confirmed`、`school_tag_confirmed`、`job_confirmed` 等逐字段布尔值仍兼容，但新流程不需要主动生成它们。

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
