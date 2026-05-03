#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  RUN_STATUS_CANCELED,
  RUN_STATUS_PAUSED
} from "./core/run/index.js";
import { createChatRunService } from "./domains/chat/index.js";

async function waitUntil(predicate, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for chat run service test condition");
}

async function testLifecycleDelegation() {
  const service = createChatRunService({
    idPrefix: "test_chat",
    workflow: async (options, runControl) => {
      assert.equal(options.targetUrl, "https://www.zhipin.com/web/chat/index");
      assert.equal(options.detailSource, "cascade");
      assert.equal(options.detailLimit, 1);
      assert.equal(options.listFallbackPoint, null);
      for (let processed = 1; processed <= 20; processed += 1) {
        await runControl.waitIfPaused();
        runControl.throwIfCanceled();
        runControl.setPhase("test:chat-screening");
        runControl.updateProgress({
          card_count: 40,
          target_count: 20,
          processed,
          screened: processed,
          detail_opened: processed >= 1 ? 1 : 0
        });
        await runControl.sleep(25);
      }
      return { domain: "chat", processed: 20 };
    }
  });

  const started = service.startChatRun({
    client: { guarded: true },
    targetUrl: "https://www.zhipin.com/web/chat/index",
    criteria: "算法",
    maxCandidates: 20,
    detailLimit: 1,
    detailSource: "cascade"
  });
  assert.equal(started.context.domain, "chat");
  assert.equal(started.context.detail_source, "cascade");
  assert.equal(started.context.list_fallback_point, null);

  await waitUntil(() => service.getChatRun(started.runId).progress.processed >= 2);
  service.pauseChatRun(started.runId);
  const paused = await waitUntil(() => {
    const snapshot = service.getChatRun(started.runId);
    return snapshot.status === RUN_STATUS_PAUSED && snapshot;
  });
  const pausedProgress = paused.progress.processed;
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal(service.getChatRun(started.runId).progress.processed, pausedProgress);

  service.resumeChatRun(started.runId);
  await waitUntil(() => service.getChatRun(started.runId).progress.processed > pausedProgress);
  service.cancelChatRun(started.runId);
  const final = await service.waitForChatRun(started.runId);
  assert.equal(final.status, RUN_STATUS_CANCELED);
}

await testLifecycleDelegation();

console.log("chat run service tests passed");
