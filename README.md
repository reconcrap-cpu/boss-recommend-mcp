# @reconcrap/boss-recommend-mcp

Boss 推荐页自动化流水线 MCP（stdio）服务。

它把 recommend 页面上的两段能力串起来：

- `boss-recommend-search-cli`: 只负责推荐页筛选项
- `boss-recommend-screen-cli`: 只负责滚动列表、打开详情、提取完整简历图、多模态判断，并对通过人选统一执行 `favorite` 或 `greet`

MCP 工具：

- `start_recommend_pipeline_run`（异步启动；同样先经过前置门禁，通过后返回 run_id）
- `get_recommend_pipeline_run`（轮询 run_id 状态）
- `cancel_recommend_pipeline_run`（取消运行中任务）
- `pause_recommend_pipeline_run`（请求暂停 run；会在当前候选人处理完成后进入 paused）
- `resume_recommend_pipeline_run`（继续 paused run；沿用同 run_id 与同 CSV）

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
- 运行前会自动做依赖体检（Node.js、Python、Pillow、`chrome-remote-interface`、`ws`），缺失时会在 `doctor` 与流水线失败诊断中明确提示
- 若 preflight 失败，返回 `diagnostics.recovery`（含有序修复步骤与 `agent_prompt`），可直接交给 AI agent 自动按顺序安装依赖
- 不依赖 PowerShell；Windows / macOS 均可运行（命令提示会按平台给出）

## 安装

```bash
npm install
```

安装后可以直接运行：

```bash
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
node src/cli.js run --instruction "推荐页筛选985男生，近14天没有，有大模型平台经验，符合标准的收藏"
npx -y @reconcrap/boss-recommend-mcp@latest run --instruction "推荐页筛选985男生，近14天没有，有大模型平台经验，符合标准的收藏"
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

## 常用命令

```bash
node src/cli.js install --agent trae-cn
node src/cli.js init-config
node src/cli.js config set --base-url https://api.openai.com/v1 --api-key <your-key> --model gpt-4o-mini
node src/cli.js set-port --port 9222
node src/cli.js doctor --agent trae-cn
node src/cli.js launch-chrome --port 9222
node src/cli.js run --instruction-file request.txt --confirmation-file confirmation.json --overrides-file overrides.json
```

## 长流程 Agent 兼容模式

当宿主 agent 对“长时间无回包”敏感（容易误判失败）时，建议改用异步工具：

1. 调用 `start_recommend_pipeline_run`。
2. 若返回 `NEED_INPUT/NEED_CONFIRMATION/FAILED`，按同步流程先补齐前置条件（登录、页面就绪、岗位确认、最终确认）。
3. 仅当门禁通过时，接口才会返回 `ACCEPTED + run_id`；随后每 5~15 秒调用一次 `get_recommend_pipeline_run` 轮询。
4. 若需临时中断，调用 `pause_recommend_pipeline_run`；接口会先返回 `PAUSE_REQUESTED`，随后在安全边界进入 `paused`。
5. `paused` 后调用 `resume_recommend_pipeline_run` 继续执行；同一 `run_id` 会复用同一 CSV，并从 checkpoint 无缝续跑。
6. 若需终止，调用 `cancel_recommend_pipeline_run`。

说明：

- `start_recommend_pipeline_run` 为异步入口，但不会跳过同步确认流程。
- 定时心跳默认 120 秒一次；`updated_at` 仍会在阶段或进度变化时刷新。
- 每个 run 会持久化到 `~/.boss-recommend-mcp/runs/<run_id>.json`（可通过 `BOSS_RECOMMEND_HOME` 覆盖）。
- screen 阶段会持久化 checkpoint：`~/.boss-recommend-mcp/runs/<run_id>.checkpoint.json`。
- 暂停采用“当前候选人处理完成后暂停”语义，避免停在详情页中间态。
- 轮询期间不要重复 `start`，优先复用已有 `run_id`，避免重复筛选。

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
  }
}
```

## 测试

```bash
npm run test:parser
npm run test:pipeline
```

## 当前实现边界

- 选择器已经按 recommend 页面语义切换
- `post_action` 的运行级单次确认已经落到 parser / pipeline / screen CLI
- 图片化简历筛选已经接入 recommend-screen-cli
- 页面按钮的真实联调验证仍然应该按你的要求，在交互前先征求确认后再做
