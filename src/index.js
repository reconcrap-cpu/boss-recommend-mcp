import path from "node:path";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runRecommendPipeline } from "./pipeline.js";

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json");
const TOOL_NAME = "run_recommend_pipeline";
const SERVER_NAME = "boss-recommend-mcp";

function writeMessage(message) {
  const body = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  process.stdout.write(header + body);
}

function createJsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message }
  };
}

function createToolSchema() {
  return {
    name: TOOL_NAME,
    description: "Boss 推荐页流水线：解析推荐筛选指令、确认 post_action（greet 时确认 max_greet_count）、执行 recommend filter 与 recommend screen 并返回摘要。",
    inputSchema: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "用户自然语言推荐筛选指令"
        },
        confirmation: {
          type: "object",
          properties: {
            filters_confirmed: { type: "boolean" },
            criteria_confirmed: { type: "boolean" },
            target_count_confirmed: { type: "boolean" },
            target_count_value: {
              type: "integer",
              minimum: 1
            },
            post_action_confirmed: { type: "boolean" },
            post_action_value: {
              type: "string",
              enum: ["favorite", "greet"]
            },
            max_greet_count_confirmed: { type: "boolean" },
            max_greet_count_value: {
              type: "integer",
              minimum: 1
            }
          },
          additionalProperties: false
        },
        overrides: {
          type: "object",
          properties: {
            school_tag: {
              type: "string",
              enum: ["不限", "985", "211", "双一流院校", "留学", "国内外名校", "公办本科"]
            },
            gender: {
              type: "string",
              enum: ["不限", "男", "女"]
            },
            recent_not_view: {
              type: "string",
              enum: ["不限", "近14天没有"]
            },
            criteria: { type: "string" },
            target_count: { type: "integer", minimum: 1 },
            max_greet_count: { type: "integer", minimum: 1 },
            post_action: {
              type: "string",
              enum: ["favorite", "greet"]
            }
          },
          additionalProperties: false
        }
      },
      required: ["instruction"],
      additionalProperties: false
    }
  };
}

async function handleRequest(message, workspaceRoot) {
  if (!message || message.jsonrpc !== "2.0") {
    return createJsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }

  const { id, method, params } = message;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION
        }
      }
    };
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [createToolSchema()]
      }
    };
  }

  if (method === "tools/call") {
    if (!params || params.name !== TOOL_NAME) {
      return createJsonRpcError(id, -32602, `Unknown tool: ${params?.name || ""}`);
    }
    const args = params.arguments || {};
    if (!args.instruction || typeof args.instruction !== "string") {
      return createJsonRpcError(id, -32602, "instruction is required and must be a string");
    }

    try {
      const result = await runRecommendPipeline({
        workspaceRoot,
        instruction: args.instruction,
        confirmation: args.confirmation,
        overrides: args.overrides
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ],
          structuredContent: result
        }
      };
    } catch (error) {
      const failed = {
        status: "FAILED",
        error: {
          code: "UNEXPECTED_ERROR",
          message: error.message || "Unexpected error",
          retryable: true
        }
      };
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(failed, null, 2)
            }
          ],
          structuredContent: failed,
          isError: true
        }
      };
    }
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (id === undefined || id === null) {
    return null;
  }
  return createJsonRpcError(id, -32601, `Method not found: ${method}`);
}

export function startServer() {
  const envRoot = process.env.BOSS_WORKSPACE_ROOT;
  const thisFile = fileURLToPath(import.meta.url);
  const mcpRoot = path.resolve(path.dirname(thisFile), "..");
  const workspaceRoot = envRoot ? path.resolve(envRoot) : path.resolve(mcpRoot, "..");
  let buffer = Buffer.alloc(0);

  process.stdin.on("data", async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerText = buffer.slice(0, headerEnd).toString("utf8");
      const contentLengthLine = headerText
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("content-length:"));

      if (!contentLengthLine) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number.parseInt(contentLengthLine.split(":")[1].trim(), 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (buffer.length < bodyEnd) break;

      const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
      buffer = buffer.slice(bodyEnd);

      let message;
      try {
        message = JSON.parse(body);
      } catch {
        writeMessage(createJsonRpcError(null, -32700, "Parse error"));
        continue;
      }

      const response = await handleRequest(message, workspaceRoot);
      if (response) writeMessage(response);
    }
  });
}

const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFilePath) {
  startServer();
}
