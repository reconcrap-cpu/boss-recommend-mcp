#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  RUN_STATUS_CANCELED,
  RUN_STATUS_PAUSED
} from "./core/run/index.js";
import {
  captureNodeIdFromResumeState,
  chatDetailSkipReasonFromReadyState,
  createChatRunService,
  resolveChatDomFallbackWait,
  summarizeChatFullCvEvidence
} from "./domains/chat/index.js";

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

function testChatResumeCaptureTarget() {
  assert.equal(captureNodeIdFromResumeState({
    content: { node_id: 101 },
    popup: { node_id: 202 },
    resumeIframe: { node_id: 303 }
  }), 202);
  assert.equal(captureNodeIdFromResumeState({
    content: { node_id: 101 },
    resumeIframe: { node_id: 303 }
  }), 101);
  assert.equal(captureNodeIdFromResumeState({
    resumeIframe: { node_id: 303 }
  }), 303);
  assert.equal(captureNodeIdFromResumeState(null), null);
}

function testChatPreDetailAttachmentResumeSkipReason() {
  assert.equal(chatDetailSkipReasonFromReadyState({
    attachment_resume_enabled: true,
    has_attachment_resume: true
  }), "attachment_resume_already_available");
  assert.equal(chatDetailSkipReasonFromReadyState({
    attachment_resume_enabled: false,
    has_attachment_resume: true
  }), "");
  assert.equal(chatDetailSkipReasonFromReadyState({
    has_online_resume: true
  }), "");
}

function testChatDomFallbackWaitPlan() {
  assert.deepEqual(resolveChatDomFallbackWait({
    normalizedDetailSource: "image",
    resumeDomTimeoutMs: 120000
  }), {
    skipped: false,
    timeout_ms: 3500,
    configured_timeout_ms: 120000,
    short_probe: true,
    reason: "forced_image_modal_probe"
  });

  const domPlan = resolveChatDomFallbackWait({
    normalizedDetailSource: "dom",
    resumeDomTimeoutMs: 120000
  });
  assert.equal(domPlan.timeout_ms, 120000);
  assert.equal(domPlan.short_probe, false);

  const firstProfileOnlyPlan = resolveChatDomFallbackWait({
    normalizedDetailSource: "cascade",
    parsedNetworkProfileCount: 2,
    waitPlan: { mode_before: "network" },
    resumeDomTimeoutMs: 120000
  });
  assert.equal(firstProfileOnlyPlan.timeout_ms, 3500);
  assert.equal(firstProfileOnlyPlan.short_probe, true);
  assert.equal(firstProfileOnlyPlan.reason, "profile_only_network_short_dom_probe");

  const imageModeProfileOnlyPlan = resolveChatDomFallbackWait({
    normalizedDetailSource: "cascade",
    parsedNetworkProfileCount: 2,
    waitPlan: { mode_before: "image" },
    resumeDomTimeoutMs: 120000
  });
  assert.equal(imageModeProfileOnlyPlan.timeout_ms, 1500);
  assert.equal(imageModeProfileOnlyPlan.short_probe, true);

  const imageModeNetworkMissPlan = resolveChatDomFallbackWait({
    normalizedDetailSource: "cascade",
    parsedNetworkProfileCount: 0,
    waitPlan: { mode_before: "image" },
    resumeDomTimeoutMs: 120000
  });
  assert.equal(imageModeNetworkMissPlan.timeout_ms, 2500);
  assert.equal(imageModeNetworkMissPlan.short_probe, true);
}

function testChatFullCvEvidenceGate() {
  const profileOnly = summarizeChatFullCvEvidence({
    detailResult: {
      parsed_network_profiles: [
        {
          ok: true,
          profile: {
            text: "姓名：王同学\n教育经历：浙江大学 本科\n亮点标签：Embedding",
            source_keys: {
              chat_geek_info: true,
              education_count: 1,
              work_count: 0
            }
          }
        }
      ],
      detail: {
        popup_text: "",
        content_text: "",
        resume_iframe_text: ""
      }
    },
    contentWait: {
      ok: true,
      skipped: true,
      reason: "network_profile_parsed_before_dom_wait",
      text_length: 0
    }
  });
  assert.equal(profileOnly.full_cv_acquired, false);
  assert.equal(profileOnly.network_profile_only_count, 1);
  assert.equal(profileOnly.network_full_cv_count, 0);

  const fullNetwork = summarizeChatFullCvEvidence({
    detailResult: {
      parsed_network_profiles: [
        {
          ok: true,
          profile: {
            text: "基础信息\n姓名：赵同学\n最高学历：硕士\n\n"
              + "个人总结\n长期参与大模型、检索排序、视觉理解和多模态算法实验，负责数据构建、模型训练、评估和误差分析。"
              + "熟悉深度学习、机器学习、Transformer、RAG、向量检索、图像识别和模型部署评测，能够独立完成算法项目闭环。\n\n"
              + "求职期望\n算法工程师 / 杭州 / 校招\n\n"
              + "工作经历\n1. 字节跳动 算法实习生 2025.06-2025.09，负责大模型检索增强、召回排序实验、特征分析和AB指标复盘。"
              + "2. 某实验室 科研助理 2024.09-2025.05，负责视觉语言模型数据清洗、训练脚本开发、实验记录和论文复现。\n\n"
              + "项目经历\n1. 多模态大模型问答系统，负责Embedding召回、重排模型训练、负样本构造、指标评估和上线前压测。"
              + "2. 计算机视觉缺陷检测项目，负责图像增强、检测模型训练、mAP评估、误检分析和模型蒸馏。"
              + "3. 三维重建科研项目，负责相机标定、点云配准、NeRF实验、可视化评估、失败样例归因和实验报告撰写。"
              + "4. 论文复现项目，复现视觉Transformer模型并完成消融实验，记录数据集划分、训练参数、指标变化和结论。\n\n"
              + "教育经历\n浙江大学 计算机科学与技术 硕士 2024-2027\n山东大学 软件工程 本科 2020-2024\n\n"
              + "校园经历\n参加智能车竞赛和机器学习课程项目，负责感知算法、路径规划实验、传感器数据清洗和答辩材料整理。\n\n"
              + "技能/亮点\nPyTorch、LLM、RAG、CV、3D视觉、检索排序、论文复现、模型评估、特征工程、AB实验、误差分析",
            source_keys: {
              geek_detail_info: true,
              project_count: 2,
              education_count: 2,
              work_count: 2,
              expectation_count: 1
            }
          }
        }
      ],
      detail: {}
    }
  });
  assert.equal(fullNetwork.full_cv_acquired, true);
  assert.equal(fullNetwork.source, "network");

  const shortGeekDetail = summarizeChatFullCvEvidence({
    detailResult: {
      parsed_network_profiles: [
        {
          ok: true,
          profile: {
            text: "基础信息\n姓名：陈同学\n教育经历\n浙江大学 硕士\n亮点标签\n大模型、视觉算法",
            source_keys: {
              geek_detail_info: true,
              education_count: 1,
              work_count: 0,
              project_count: 0
            }
          }
        }
      ],
      detail: {}
    },
    contentWait: {
      ok: true,
      skipped: true,
      reason: "network_profile_parsed_before_dom_wait",
      text_length: 0
    }
  });
  assert.equal(shortGeekDetail.full_cv_acquired, false);
  assert.equal(shortGeekDetail.network_profile_only_count, 1);
  assert.equal(shortGeekDetail.network_full_cv_count, 0);

  const domResume = summarizeChatFullCvEvidence({
    detailResult: {
      parsed_network_profiles: [],
      detail: {
        popup_text: "",
        content_text:
          "教育经历\n浙江大学 计算机科学 本科\n2021-2025\n\n"
          + "项目经历\n图像算法项目，负责模型训练与评估，包含数据处理、特征提取、模型迭代、误差分析、上线验证和论文复现。"
          + "项目中使用深度学习模型完成图像识别任务，持续调参并撰写实验报告。\n\n"
          + "工作经历\n算法实习，负责检索排序实验、指标监控、召回策略优化、AB实验复盘和模型效果评估。"
          + "在实习中参与候选集生成、特征工程和排序模型训练，沉淀了完整算法项目经验。",
        resume_iframe_text: ""
      }
    },
    contentWait: {
      ok: true,
      text_length: 200
    }
  });
  assert.equal(domResume.full_cv_acquired, true);
  assert.equal(domResume.source, "dom");

  const imageResume = summarizeChatFullCvEvidence({
    detailResult: {
      parsed_network_profiles: [
        {
          ok: true,
          profile: {
            text: "姓名：李同学",
            source_keys: { chat_geek_info: true }
          }
        }
      ],
      detail: {}
    },
    imageEvidence: {
      ok: true,
      llm_file_paths: ["C:/tmp/cv.jpg"],
      llm_screenshot_count: 1
    }
  });
  assert.equal(imageResume.full_cv_acquired, true);
  assert.equal(imageResume.source, "image");
  assert.equal(imageResume.network_profile_only_count, 1);
}

testChatFullCvEvidenceGate();
testChatResumeCaptureTarget();
testChatPreDetailAttachmentResumeSkipReason();
testChatDomFallbackWaitPlan();
await testLifecycleDelegation();

console.log("chat run service tests passed");
