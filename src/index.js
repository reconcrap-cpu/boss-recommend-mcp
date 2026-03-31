import path from "node:path";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runRecommendPipeline } from "./pipeline.js";

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json");
const TOOL_NAME = "run_recommend_pipeline";
const SERVER_NAME = "boss-recommend-mcp";
const FRAMING_UNKNOWN = "unknown";
const FRAMING_HEADER = "header";
const FRAMING_LINE = "line";

function writeMessage(message, framing = FRAMING_LINE) {
  const body = JSON.stringify(message);
  if (framing === FRAMING_HEADER) {
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    process.stdout.write(header + body);
    return;
  }
  process.stdout.write(`${body}\n`);
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
            school_tag_confirmed: { type: "boolean" },
            degree_confirmed: { type: "boolean" },
            gender_confirmed: { type: "boolean" },
            recent_not_view_confirmed: { type: "boolean" },
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
            degree: {
              oneOf: [
                {
                  type: "string",
                  enum: ["不限", "初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"]
                },
                {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["不限", "初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"]
                  },
                  minItems: 1,
                  uniqueItems: true
                }
              ]
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
  let framing = FRAMING_UNKNOWN;

  process.stdin.on("data", async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      buffer = buffer.slice(3);
    }

    while (true) {
      const crlfHeaderEnd = buffer.indexOf("\r\n\r\n");
      const lfHeaderEnd = buffer.indexOf("\n\n");
      const crHeaderEnd = buffer.indexOf("\r\r");
      let headerEnd = -1;
      let headerSeparatorLength = 0;
      if (
        crlfHeaderEnd !== -1
        && (lfHeaderEnd === -1 || crlfHeaderEnd < lfHeaderEnd)
        && (crHeaderEnd === -1 || crlfHeaderEnd < crHeaderEnd)
      ) {
        headerEnd = crlfHeaderEnd;
        headerSeparatorLength = 4;
      } else if (lfHeaderEnd !== -1 && (crHeaderEnd === -1 || lfHeaderEnd < crHeaderEnd)) {
        headerEnd = lfHeaderEnd;
        headerSeparatorLength = 2;
      } else if (crHeaderEnd !== -1) {
        headerEnd = crHeaderEnd;
        headerSeparatorLength = 2;
      }
      if (headerEnd !== -1) {
        const headerText = buffer.slice(0, headerEnd).toString("utf8");
        const contentLengthLine = headerText
          .split(/\r\n|\n|\r/)
          .find((line) => line.toLowerCase().startsWith("content-length:"));

        if (!contentLengthLine) {
          buffer = buffer.slice(headerEnd + headerSeparatorLength);
          continue;
        }

        const contentLength = Number.parseInt(contentLengthLine.split(":")[1].trim(), 10);
        if (!Number.isFinite(contentLength) || contentLength < 0) {
          buffer = buffer.slice(headerEnd + headerSeparatorLength);
          continue;
        }

        const bodyStart = headerEnd + headerSeparatorLength;
        const bodyEnd = bodyStart + contentLength;
        if (buffer.length < bodyEnd) break;

        const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
        buffer = buffer.slice(bodyEnd);
        framing = FRAMING_HEADER;

        let message;
        try {
          message = JSON.parse(body);
        } catch {
          writeMessage(createJsonRpcError(null, -32700, "Parse error"), FRAMING_HEADER);
          continue;
        }

        const response = await handleRequest(message, workspaceRoot);
        if (response) writeMessage(response, framing);
        continue;
      }

      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const rawLine = buffer.slice(0, newlineIndex).toString("utf8").replace(/\r$/, "");
      if (/^\s*content-length:/i.test(rawLine)) break;
      buffer = buffer.slice(newlineIndex + 1);
      const line = rawLine.trim();
      if (!line) continue;
      framing = FRAMING_LINE;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        writeMessage(createJsonRpcError(null, -32700, "Parse error"), FRAMING_LINE);
        continue;
      }

      const response = await handleRequest(message, workspaceRoot);
      if (response) writeMessage(response, framing);
    }
  });
}

const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFilePath) {
  startServer();
}
