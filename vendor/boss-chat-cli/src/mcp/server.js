#!/usr/bin/env node
import process from 'node:process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import { runCliJsonCommand } from './tool-runtime.js';

const SERVER_VERSION = process.env.BOSS_CHAT_MCP_VERSION || '1.1.0';

function toToolResult(payload, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
    isError,
  };
}

async function executeCliCommand(command, input) {
  const result = await runCliJsonCommand(command, input);
  const payload = {
    ...result.payload,
    _meta: {
      command: result.command,
      args: result.args,
      exitCode: result.exitCode,
      stderr: String(result.stderr || '').trim() || undefined,
    },
  };

  if (!payload._meta.stderr) {
    delete payload._meta.stderr;
  }
  return toToolResult(payload, !result.ok);
}

function registerTools(server) {
  server.registerTool(
    'health_check',
    {
      description: '检查 MCP 服务与 CLI 适配层是否可用。',
      inputSchema: {},
    },
    async () =>
      toToolResult({
        status: 'OK',
        server: 'boss-chat-mcp',
        version: SERVER_VERSION,
        supportedAgents: ['openclaw', 'codex', 'trae-cn'],
      }),
  );

  server.registerTool(
    'start_run',
    {
      description: '异步启动一次 Boss chat 任务并返回 run_id。',
      inputSchema: {
        profile: z.string().optional().describe('Profile 名称，默认 default'),
        dryRun: z.boolean().optional().describe('true 时不发出索要简历动作'),
        noState: z.boolean().optional().describe('true 时不记录已处理状态'),
        job: z.string().describe('岗位，支持岗位名/编号/value'),
        startFrom: z
          .enum(['unread', 'all'])
          .optional()
          .describe('从未读或全部聊天列表开始'),
        criteria: z.string().describe('筛选标准'),
        targetCount: z.number().int().positive().optional().describe('本次处理上限'),
        baseUrl: z.string().optional().describe('覆盖 LLM baseUrl'),
        apiKey: z.string().optional().describe('覆盖 LLM apiKey'),
        model: z.string().optional().describe('覆盖 LLM 模型'),
        port: z.number().int().positive().optional().describe('Chrome 调试端口'),
        safePacing: z.boolean().optional().describe('是否启用安全节奏控制'),
        batchRestEnabled: z.boolean().optional().describe('是否启用批次休息'),
      },
    },
    async (input) => executeCliCommand('start-run', input),
  );

  server.registerTool(
    'get_run',
    {
      description: '查询 run_id 对应任务的当前状态。',
      inputSchema: {
        runId: z.string().min(1).describe('start_run 返回的 run_id'),
        profile: z.string().optional().describe('可选，默认 default'),
      },
    },
    async (input) => executeCliCommand('get-run', input),
  );

  server.registerTool(
    'pause_run',
    {
      description: '暂停运行中的任务。',
      inputSchema: {
        runId: z.string().min(1).describe('start_run 返回的 run_id'),
        profile: z.string().optional().describe('可选，默认 default'),
      },
    },
    async (input) => executeCliCommand('pause-run', input),
  );

  server.registerTool(
    'resume_run',
    {
      description: '继续已暂停任务。',
      inputSchema: {
        runId: z.string().min(1).describe('start_run 返回的 run_id'),
        profile: z.string().optional().describe('可选，默认 default'),
      },
    },
    async (input) => executeCliCommand('resume-run', input),
  );

  server.registerTool(
    'cancel_run',
    {
      description: '取消运行中的任务（在安全点停止）。',
      inputSchema: {
        runId: z.string().min(1).describe('start_run 返回的 run_id'),
        profile: z.string().optional().describe('可选，默认 default'),
      },
    },
    async (input) => executeCliCommand('cancel-run', input),
  );
}

async function main() {
  const server = new McpServer({
    name: 'boss-chat-mcp',
    version: SERVER_VERSION,
  });
  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[boss-chat-mcp] server failed:', error?.stack || error?.message || String(error));
  process.exit(1);
});

