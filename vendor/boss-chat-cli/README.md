# boss-chat

基于 Chrome DevTools Protocol 和 OpenAI 兼容 LLM 的 Boss 直聘聊天页教育筛选与自动沟通 CLI。

## 功能

- 连接已登录、已打开聊天页的 Chrome
- 遍历聊天列表客户卡片，读取教育信息
- 用自定义 `baseUrl + apiKey + model` 调用大模型判断是否符合教育要求
- 命中时自动生成简短话术并写入聊天框，随后发送
- 默认记录已处理客户，避免重复触达
- 支持选择从`未读`或`全部`列表开始处理
- 支持 `--dry-run` 先验证页面稳定性和命中效果

## 依赖

- Node.js（建议 18+）
- Google Chrome（需开启远程调试端口）
- npm 包依赖：
  - `chrome-remote-interface@^0.33.3`

## 使用前准备

1. 用远程调试模式启动 Chrome：

```powershell
chrome.exe --remote-debugging-port=9222
```

2. 登录 Boss 直聘并打开聊天页：

```text
https://www.zhipin.com/web/chat/index
```

3. 全局安装：

```powershell
npm install -g @reconcrap/boss-chat-cli
```

也可以直接用 `npx`（适合 agent 平台托管 MCP 时）：

```powershell
npx -y -p @reconcrap/boss-chat-cli@latest boss-chat-mcp
```

## 运行

首次运行会交互式询问教育要求、话术样例、LLM 参数等配置；每次运行也可选择从`未读`或`全部`开始：

```powershell
boss-chat run
```

建议先用 dry-run：

```powershell
boss-chat run --dry-run --targetCount 3
```

## MCP Agent 集成（openclaw / codex / trae-cn）

包内已内置 MCP stdio server，可直接被三类平台调用：

- `openclaw-boss-chat-mcp`
- `codex-boss-chat-mcp`
- `trae-cn-boss-chat-mcp`
- 通用入口：`boss-chat-mcp`

### 工具列表

- `health_check`: 检查服务是否可用
- `start_run`: 启动异步任务，返回 `run_id`
- `get_run`: 查询任务状态
- `pause_run`: 暂停任务
- `resume_run`: 继续任务
- `cancel_run`: 取消任务

### 平台配置示例

项目里提供了三份可直接复制的模板：

- `configs/mcp/openclaw.json`
- `configs/mcp/codex.json`
- `configs/mcp/trae-cn.json`

三份配置都通过 `npx` 拉取最新包并启动对应 MCP 入口，例如：

```json
{
  "mcpServers": {
    "boss-chat": {
      "command": "npx",
      "args": ["-y", "-p", "@reconcrap/boss-chat-cli@latest", "boss-chat-mcp"]
    }
  }
}
```

> 不同平台的 MCP 配置文件路径可能不同，但 `command + args` 可直接复用。

## 运行中控制

程序运行时可以直接用键盘控制：

- `p`: 暂停；再次按 `p` 或按 `r` 继续
- `r`: 继续运行
- `q`: 请求停止，当前步骤结束后安全退出
- `Ctrl+C`: 请求停止，当前步骤结束后安全退出

停止后仍会写入本次运行报告，已记录的客户状态也会保留。

## 常用参数

- `--profile <name>`: 使用指定 profile
- `--dry-run`: 只检查和生成文案，不实际发送
- `--no-state`: 不记录已处理客户
- `--targetCount <n>`: 覆盖本次检查人数
- `--educationRequirement <text>`: 覆盖教育要求
- `--messageSample <text>`: 覆盖话术样例
- `--start-from <unread|all>`: 本次从未读或全部列表开始
- `--baseurl <url>`: 覆盖 LLM base URL
- `--apikey <key>`: 覆盖 LLM API key
- `--model <name>`: 覆盖 LLM 模型
- `--port <n>`: 覆盖 Chrome 远程调试端口

## 数据目录

运行产生的数据默认保存在项目下的 `.boss-chat/`：

- `profiles/`: 保存 profile 配置
- `state/`: 保存已处理客户状态
- `reports/`: 保存每次运行的 JSON 报告
