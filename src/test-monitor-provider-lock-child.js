import fs from "node:fs";
import path from "node:path";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

const encoded = process.argv[2] || "";
const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
for (const [key, value] of Object.entries(config.environment || {})) {
  process.env[key] = String(value);
}

const { createBossRecruitingRunProvider } = await import("./monitor-provider.js");
const provider = createBossRecruitingRunProvider({
  legacyModuleLoader: async (kind) => {
    if (kind !== "recommend") throw new Error(`Unexpected workflow kind: ${kind}`);
    const pauseRecommendPipelineRunTool = async () => {
      fs.mkdirSync(config.effect_dir, { recursive: true });
      const effectPath = path.join(config.effect_dir, `${process.pid}.json`);
      writeJson(effectPath, {
        pid: process.pid,
        command: "pause",
        entered_at: new Date().toISOString()
      });
      fs.appendFileSync(
        config.trace_path,
        `${JSON.stringify({ type: "enter", pid: process.pid, at: Date.now() })}\n`,
        "utf8"
      );
      await delay(250);
      fs.appendFileSync(
        config.trace_path,
        `${JSON.stringify({ type: "exit", pid: process.pid, at: Date.now() })}\n`,
        "utf8"
      );
      return { status: "PAUSE_REQUESTED" };
    };
    return { pauseRecommendPipelineRunTool };
  }
});

writeJson(config.ready_path, { pid: process.pid, ready_at: new Date().toISOString() });
const barrierDeadline = Date.now() + 15_000;
while (!fs.existsSync(config.go_path)) {
  if (Date.now() >= barrierDeadline) {
    throw new Error("Timed out waiting for monitor-provider lock test barrier");
  }
  await delay(10);
}

try {
  const result = await provider.executeCommand(config.ref, config.command);
  writeJson(config.result_path, { ok: true, result });
} catch (error) {
  writeJson(config.result_path, {
    ok: false,
    error: {
      name: error?.name || "Error",
      code: error?.code || null,
      message: error?.message || String(error)
    }
  });
  process.exitCode = 1;
}
