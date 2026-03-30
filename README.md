# @reconcrap/boss-recommend-mcp

Boss 推荐页自动化流水线 MCP（stdio）服务。

它把 recommend 页面上的两段能力串起来：

- `boss-recommend-search-cli`: 只负责推荐页筛选项
- `boss-recommend-screen-cli`: 只负责滚动列表、打开详情、提取完整简历图、多模态判断，并对通过人选统一执行 `favorite` 或 `greet`

MCP 工具名：`run_recommend_pipeline`

状态机：

- `NEED_INPUT`
- `NEED_CONFIRMATION`
- `COMPLETED`
- `FAILED`

## 设计特点

- 页面目标固定为 `https://www.zhipin.com/web/chat/recommend`
- 支持推荐页原生筛选：学校标签 / 性别 / 近14天没有
- `post_action` 必须在每次完整运行开始时确认一次
- `target_count` 会在每次运行开始时询问一次（可留空，不设上限）
- 当 `post_action=greet` 时，必须在运行开始时确认 `max_greet_count`
- 一旦确认 `post_action`，本次运行内所有通过人选都统一按该动作执行
- 若达到 `max_greet_count` 但流程仍需继续，后续通过人选会自动改为收藏
- 不会对每位候选人重复确认
- 推荐页详情处理完成后，会强制关闭详情页并确认已关闭
- 简历提取采用“分段滚动截图 + 拼成长图”的方式，再交给多模态模型判断

## 安装

```bash
npm install
```

安装后可以直接运行：

```bash
node src/cli.js start
```

或使用 CLI fallback：

```bash
node src/cli.js run --instruction "推荐页筛选985男生，近14天没有，有大模型平台经验，符合标准的收藏"
```

## 配置

用户配置文件默认路径：

```bash
$CODEX_HOME/boss-recommend-mcp/screening-config.json
```

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
node src/cli.js install
node src/cli.js init-config
node src/cli.js set-port --port 9222
node src/cli.js doctor
node src/cli.js launch-chrome --port 9222
node src/cli.js run --instruction-file request.txt --confirmation-file confirmation.json --overrides-file overrides.json
```

## MCP Tool Input

```json
{
  "instruction": "推荐页筛选211女生，近14天没有，有 AI Agent 经验，符合标准的直接沟通",
  "confirmation": {
    "filters_confirmed": true,
    "criteria_confirmed": true,
    "target_count_confirmed": true,
    "target_count_value": 20,
    "post_action_confirmed": true,
    "post_action_value": "greet",
    "max_greet_count_confirmed": true,
    "max_greet_count_value": 10
  },
  "overrides": {
    "school_tag": "211",
    "gender": "女",
    "recent_not_view": "近14天没有",
    "criteria": "候选人需要有 AI Agent 或 MCP 工具开发经验",
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
