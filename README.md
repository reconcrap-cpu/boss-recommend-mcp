# @reconcrap/boss-recommend-mcp

Boss 推荐页自动化流水线 MCP（stdio）服务。

发布入口：

- npm: `@reconcrap/boss-recommend-mcp`（https://www.npmjs.com/package/@reconcrap/boss-recommend-mcp）
- GitHub: `reconcrap-cpu/boss-recommend-mcp`（https://github.com/reconcrap-cpu/boss-recommend-mcp）

它把 recommend 页面上的两段能力串起来：

- `boss-recommend-search-cli`: 只负责推荐页筛选项
- `boss-recommend-screen-cli`: 只负责滚动列表、打开详情、提取完整简历图、多模态判断，并对通过人选统一执行 `favorite` 或 `greet`

现在包内还内置了 `boss-chat` runtime，因此安装 `boss-recommend-mcp` 后可以直接：

- 单独运行 chat-only 任务，不需要再单独安装 `boss-chat`
- 在 recommend screen 完成后，通过同一个父 run 自动进入 `chat_followup`
- 继续把聊天页状态保存在工作区下的 `.boss-chat/`

MCP 工具：

- `start_recommend_pipeline_run`（异步启动；同样先经过前置门禁，通过后返回 run_id）
- `get_recommend_pipeline_run`（轮询 run_id 状态）
- `cancel_recommend_pipeline_run`（取消运行中任务）
- `pause_recommend_pipeline_run`（请求暂停 run；会在当前候选人处理完成后进入 paused）
- `resume_recommend_pipeline_run`（继续 paused run；沿用同 run_id 与同 CSV）
- `run_recommend_self_heal`（手动运维工具；扫描 Boss recommend 的 selector / network 规则漂移，并在确认后应用高置信度修复）
- `boss_chat_health_check`
- `start_boss_chat_run`
- `get_boss_chat_run`
- `pause_boss_chat_run`
- `resume_boss_chat_run`
- `cancel_boss_chat_run`
  - `validation_profile=safe`：只做非破坏性扫描与被动 network 观察
  - `validation_profile=full`：会主动打开候选人详情，并执行收藏往返校验与一次打招呼校验；若完整交互没跑通，会明确返回验证异常而不是静默跳过
  - 扫描会主动覆盖 recommend/latest/featured 三个 tab 的详情链路（详情打开、详情内关键 selector、popup 关闭）
  - 搜索链路 selector 会在状态触发后验证：职位下拉、职位搜索输入、职位 label、筛选面板、筛选分组（school/degree/gender/recentNotView）、筛选滚动容器与筛选项激活态
  - 对关闭弹层相关 selector，会同时验证 close 按钮与 fallback close 候选 selector

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

当 recommend run 传入 `follow_up.chat` 且 screen 成功后，父 run 会进入 `chat_followup` 阶段并保持 `running`，直到内置 boss-chat 子任务结束。此时对父 run 的 `pause/resume/cancel` 会代理到子 chat run。

## 设计特点

- 页面目标固定为 `https://www.zhipin.com/web/chat/recommend`
- 支持推荐页原生筛选：学校标签 / 学历 / 性别 / 近14天没有
- 学校标签支持多选语义：如“985、211”会同时勾选这两项
- 学校标签对“混合输入”按容错处理：如“985、211、qs100”会忽略无效项 `qs100`，保留并应用有效项；仅当全部无效或用户明确“不限”时才回落到“不限”
- 学历支持单选与多选语义：如“本科及以上”会展开为 `本科/硕士/博士`；如“大专、本科”只勾选这两项
- 执行前会逐项确认筛选参数：学校标签 / 学历 / 性别 / 是否过滤近14天已看
- 页面就绪（已登录且在 recommend 页）后，会先提取岗位栏全部岗位并要求用户确认本次岗位；确认后先点击岗位，再执行 search/screen
- 在真正开始 search/screen 前，会进行最后一轮全参数总确认（岗位 + 全部筛选参数 + criteria + target_count + post_action + max_greet_count）
- npm 全局安装后会自动执行 install：生成 skill、导出 MCP 模板，并自动尝试写入已检测到的外部 agent MCP 配置（含 Trae / trae-cn / Cursor / Claude / OpenClaw）
- npm / npx 安装后会自动初始化 `screening-config.json` 模板（优先写入 workspace 的 `config/`，不可写时回退到用户目录）
- `post_action` 必须在每次完整运行开始时确认一次
- `target_count` 会在每次运行开始时询问一次（可留空，不设上限）
- 当 `post_action=greet` 时，必须在运行开始时确认 `max_greet_count`
- 若检测到 `max_greet_count` 可能由 agent 自动默认（例如与 `target_count` 相同且原始指令未明确），会强制再次向用户确认
- 一旦确认 `post_action`，本次运行内所有通过人选都统一按该动作执行
- 若达到 `max_greet_count` 但流程仍需继续，后续通过人选会自动改为收藏
- 不会对每位候选人重复确认
- 推荐页详情处理完成后，会强制关闭详情页并确认已关闭
- 简历提取采用“分段滚动截图 + 拼成长图”的方式，再交给多模态模型判断
- 提供显式运维自愈工具：只在手动调用 `run_recommend_self_heal` 时运行，不会接入正常 run / doctor / preflight 自动链路
- 运行前会自动做依赖体检（Node.js、Python、Pillow、`chrome-remote-interface`、`ws`），缺失时会在 `doctor` 与流水线失败诊断中明确提示
- 若 preflight 失败，返回 `diagnostics.recovery`（含有序修复步骤与 `agent_prompt`），可直接交给 AI agent 自动按顺序安装依赖
- 不依赖 PowerShell；Windows / macOS 均可运行（命令提示会按平台给出）

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

可选环境变量（用于跨 agent 自动配置）：

```bash
BOSS_RECOMMEND_HOME               # 统一状态目录，默认 ~/.boss-recommend-mcp
BOSS_RECOMMEND_SCREEN_CONFIG      # 显式指定 screening-config.json 路径（最高优先级）
BOSS_RECOMMEND_MCP_CONFIG_TARGETS   # JSON 数组或系统 path 分隔路径列表，指定额外 mcp.json 目标文件
BOSS_RECOMMEND_EXTERNAL_SKILL_DIRS  # JSON 数组或系统 path 分隔路径列表，指定额外 skills 根目录
```

或使用 CLI fallback：

```bash
npx -y @reconcrap/boss-recommend-mcp@latest run --instruction "推荐页筛选985男生，近14天没有，有大模型平台经验，符合标准的收藏"
# 源码模式（GitHub clone 后）
node src/cli.js run --instruction "推荐页筛选985男生，近14天没有，有大模型平台经验，符合标准的收藏"
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
- `debugPort`
- `outputDir`
- `llmThinkingLevel`：默认 `low`。可设为 `off/minimal/low/medium/high/auto/current`，用于控制 OpenAI-compatible LLM 的 thinking/reasoning 强度。
- `humanRestEnabled`：默认 `false`。`false` 时 recommend-screen 随机休息/批次休息与 boss-chat 批次休息均为 `0ms`；`true` 时恢复随机休息节奏。

## 常用命令

npm 包安装后可直接使用可执行命令 `boss-recommend-mcp`。以下示例展示源码模式（`node src/cli.js`）：

```bash
node src/cli.js install --agent trae-cn
node src/cli.js init-config
node src/cli.js config set --base-url https://api.openai.com/v1 --api-key <your-key> --model gpt-4o-mini --thinking-level off
node src/cli.js set-port --port 9222
node src/cli.js doctor --agent trae-cn
node src/cli.js launch-chrome --port 9222
node src/cli.js run --instruction-file request.txt --confirmation-file confirmation.json --overrides-file overrides.json
node src/cli.js run --instruction-file request.txt --confirmation-file confirmation.json --overrides-file overrides.json --follow-up-file follow-up.json
node src/cli.js chat health-check
node src/cli.js chat run --job "算法工程师" --start-from unread --criteria "有 AI Agent 经验" --targetCount 20
```

## Recommend + Chat Follow-up

若要让 recommend screen 完成后自动开始 boss-chat，把 chat 配置放到同一个 recommend run 的顶层 `follow_up.chat`：

```json
{
  "follow_up": {
    "chat": {
      "criteria": "候选人需要继续在聊天页过滤有 AI Agent 经验的人选",
      "start_from": "unread",
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
- `profile` 可选，默认 `default`
- `job` 与 `port` 继承 recommend run 已选岗位和调试端口
- `baseUrl` / `apiKey` / `model` 不再单独传入，固定复用 recommend 的 `screening-config.json`
- 若缺少 `follow_up.chat` 必填项，pipeline 会返回 `NEED_INPUT`
- recommend 成功后，父 run 继续存活并进入 `chat_followup`；chat 结束后父 run 才会进入最终终态

## Chat-only

安装 `boss-recommend-mcp` 后，无需额外安装 `boss-chat`：

- CLI：
  - `boss-recommend-mcp chat health-check`
  - `boss-recommend-mcp chat prepare-run`
  - `boss-recommend-mcp chat run --job "算法工程师" --start-from unread --targetCount 20 --criteria "有 AI Agent 经验"`（后台启动，不自动轮询）
  - `boss-recommend-mcp chat start-run|get-run|pause-run|resume-run|cancel-run`
- MCP：
  - `boss_chat_health_check`
  - `prepare_boss_chat_run`
  - `start_boss_chat_run`
  - `get_boss_chat_run`
  - `pause_boss_chat_run`
  - `resume_boss_chat_run`
  - `cancel_boss_chat_run`

chat-only 交互建议：

- 先调用一次 `prepare_boss_chat_run`（可不带参数），服务会先导航到 `https://www.zhipin.com/web/chat/index` 并返回 `NEED_INPUT`，其中包含岗位 `job_options` 与待补字段。
- 然后基于 `job_options` 让用户选择 `job`，并补齐 `start_from`、`target_count`、`criteria` 后调用 `start_boss_chat_run` 启动任务。
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
