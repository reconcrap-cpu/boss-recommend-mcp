#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildChatSelfHealConfig,
  resolveChatSelfHealRoots
} from "./core/self-heal/index.js";
import {
  createChatProfileNetworkRecorder,
  getChatTopLevelState,
  isChatShellUrl,
  isForbiddenChatResumeTopLevelUrl,
  isUnsafeChatOnlineResumeLinkError,
  isUnsafeChatOnlineResumeTarget,
  matchesChatProfileNetwork,
  openChatOnlineResume,
  quickChatResumeModalOpenProbe,
  readChatConversationReadyState,
  readChatCardCandidate,
  recoverChatShell,
  requestChatResumeForPassedCandidate,
  selectChatJob,
  waitForChatOnlineResumeButton
} from "./domains/chat/index.js";
import { inspectEmptyChatListVisually } from "../scripts/live-helpers/chat-empty-list-visual.js";

function testNetworkPatterns() {
  assert.equal(
    matchesChatProfileNetwork("https://www.zhipin.com/wapi/zpjob/view/geek/info/v2?uid=1"),
    true
  );
  assert.equal(
    matchesChatProfileNetwork("https://www.zhipin.com/wapi/zpjob/chat/geek/info?uid=1"),
    true
  );
  assert.equal(
    matchesChatProfileNetwork("https://www.zhipin.com/wapi/zpchat/boss/historyMsg?securityId=1"),
    true
  );
  assert.equal(matchesChatProfileNetwork("https://example.com/static/app.js"), false);
}

async function testQuickChatResumeModalOpenProbe() {
  let modalVisible = true;
  const client = {
    DOM: {
      async getDocument() {
        return { root: { nodeId: 1 } };
      },
      async querySelectorAll(params) {
        const selector = String(params.selector || "");
        if (modalVisible && selector.includes("new-chat-resume-dialog-main-ui")) {
          return { nodeIds: [20] };
        }
        return { nodeIds: [] };
      },
      async getBoxModel() {
        return {
          model: {
            border: [300, 0, 900, 0, 900, 700, 300, 700]
          }
        };
      }
    }
  };

  const open = await quickChatResumeModalOpenProbe(client);
  assert.equal(open.open, true);
  assert.equal(open.selector.includes("new-chat-resume-dialog-main-ui"), true);

  modalVisible = false;
  const closed = await quickChatResumeModalOpenProbe(client);
  assert.equal(closed.open, false);
}

function testNetworkRecorder() {
  let onResponseReceived = null;
  let onLoadingFinished = null;
  const client = {
    Network: {
      responseReceived(handler) {
        onResponseReceived = handler;
      },
      loadingFinished(handler) {
        onLoadingFinished = handler;
      },
      loadingFailed() {}
    }
  };

  const recorder = createChatProfileNetworkRecorder(client);
  onResponseReceived({
    requestId: "req-1",
    type: "XHR",
    response: {
      url: "https://www.zhipin.com/wapi/zpjob/view/geek/info/v2?uid=1",
      status: 200,
      mimeType: "application/json"
    }
  });
  onResponseReceived({
    requestId: "req-ignored",
    type: "Script",
    response: {
      url: "https://example.com/static/app.js",
      status: 200,
      mimeType: "text/javascript"
    }
  });
  onLoadingFinished({
    requestId: "req-1",
    encodedDataLength: 1234
  });

  assert.equal(recorder.events.length, 1);
  assert.equal(recorder.events[0].loading_finished, true);
  assert.equal(recorder.events[0].encodedDataLength, 1234);
}

async function testCardCandidateReader() {
  const client = {
    DOM: {
      async getAttributes() {
        return {
          attributes: ["data-id", "customer_123", "class", "geek-item selected"]
        };
      },
      async getOuterHTML() {
        return {
          outerHTML:
            '<div class="geek-item selected" data-id="customer_123">'
            + '<span class="geek-name">王五</span><span class="source-job">算法工程师</span>'
            + '<span>硕士</span><span>机器学习</span></div>'
        };
      }
    }
  };
  const candidate = await readChatCardCandidate(client, 7, {
    targetUrl: "https://www.zhipin.com/web/chat/index"
  });
  assert.equal(candidate.domain, "chat");
  assert.equal(candidate.id, "customer_123");
  assert.equal(candidate.identity.degree, "硕士");
  assert.match(candidate.text.raw, /机器学习/);
}

async function testChatSelfHealConfig() {
  const config = buildChatSelfHealConfig();
  assert.equal(config.domain, "chat");
  assert.equal(config.targetHints.includes("/web/chat/index"), true);
  assert.equal(config.selectorProbes.find((probe) => probe.id === "candidate_cards")?.required, true);
  assert.equal(config.selectorProbes.find((probe) => probe.id === "online_resume_button")?.required, false);

  const roots = await resolveChatSelfHealRoots({
    DOM: {
      async getDocument() {
        return { root: { nodeId: 9 } };
      }
    }
  }, config);
  assert.equal(roots.roots.top, 9);
  assert.equal(roots.iframe, null);
}

async function testEmptyChatListVisualInspection() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-chat-empty-"));
  const client = {
    DOM: {
      async querySelectorAll() {
        return { nodeIds: [] };
      },
      async getOuterHTML() {
        return {
          outerHTML: '<main><section class="empty">暂无未读消息</section></main>'
        };
      }
    },
    Page: {
      async captureScreenshot() {
        return { data: Buffer.from("empty-chat-image").toString("base64") };
      }
    },
    Accessibility: {
      async getFullAXTree() {
        return {
          nodes: [
            { name: { value: "暂无未读消息" } }
          ]
        };
      }
    }
  };
  const inspection = await inspectEmptyChatListVisually(client, 9, {
    startFrom: "unread",
    runId: "test_chat",
    evidenceDir: dir
  });
  assert.equal(inspection.verified_empty, true);
  assert.equal(inspection.selector_counts_after.total, 0);
  assert.equal(inspection.empty_hint_found, true);
  assert.equal(fs.existsSync(inspection.screenshot.file_path), true);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testChatTopLevelPageGuard() {
  assert.equal(isChatShellUrl("https://www.zhipin.com/web/chat/index"), true);
  assert.equal(isChatShellUrl("https://www.zhipin.com/web/frame/c-resume/?source=chat-resume-online"), false);
  assert.equal(isForbiddenChatResumeTopLevelUrl("https://www.zhipin.com/web/frame/c-resume/?source=chat-resume-online"), true);
  assert.equal(isForbiddenChatResumeTopLevelUrl("https://www.zhipin.com/web/chat/index"), false);

  let url = "https://www.zhipin.com/web/frame/c-resume/?source=chat-resume-online";
  const navigations = [];
  const client = {
    Page: {
      async getFrameTree() {
        return {
          frameTree: {
            frame: { url }
          }
        };
      },
      async navigate(params) {
        navigations.push(params.url);
        url = params.url;
        return {};
      }
    }
  };

  const before = await getChatTopLevelState(client);
  assert.equal(before.is_forbidden_resume_top_level, true);
  const recovery = await recoverChatShell(client, {
    targetUrl: "https://www.zhipin.com/web/chat/index",
    timeoutMs: 200,
    intervalMs: 10
  });
  assert.equal(recovery.recovered, true);
  assert.deepEqual(navigations, ["https://www.zhipin.com/web/chat/index"]);
  assert.equal(recovery.after.is_chat_shell, true);
}

async function testUnsafeOnlineResumeLinkIsBlockedBeforeClick() {
  assert.equal(
    isUnsafeChatOnlineResumeTarget(
      {},
      '<a class="btn resume-btn-online" href="/web/frame/c-resume/?source=chat-resume-online">在线简历</a>'
    ),
    true
  );
  assert.equal(
    isUnsafeChatOnlineResumeTarget(
      {},
      '<a class="btn resume-btn-online" href="javascript:;">在线简历</a>'
    ),
    false
  );

  let clickCount = 0;
  const client = {
    Page: {
      async getFrameTree() {
        return {
          frameTree: {
            frame: { url: "https://www.zhipin.com/web/chat/index" }
          }
        };
      }
    },
    DOM: {
      async getDocument() {
        return { root: { nodeId: 1 } };
      },
      async querySelectorAll(params) {
        const selector = String(params.selector || "");
        if (selector === "a.btn.resume-btn-online" || selector === "a.resume-btn-online") {
          return { nodeIds: [20] };
        }
        return { nodeIds: [] };
      },
      async querySelector() {
        return { nodeId: 0 };
      },
      async getAttributes(params) {
        if (params.nodeId === 20) {
          return {
            attributes: [
              "class", "btn resume-btn-online",
              "href", "/web/frame/c-resume/?source=chat-resume-online"
            ]
          };
        }
        return { attributes: [] };
      },
      async getOuterHTML(params) {
        if (params.nodeId === 20) {
          return {
            outerHTML:
              '<a class="btn resume-btn-online" href="/web/frame/c-resume/?source=chat-resume-online">在线简历</a>'
          };
        }
        return { outerHTML: "" };
      },
      async getBoxModel(params) {
        if (params.nodeId !== 20) throw new Error("no box");
        return {
          model: {
            border: [0, 0, 100, 0, 100, 30, 0, 30]
          }
        };
      },
      async scrollIntoViewIfNeeded() {}
    },
    Input: {
      async dispatchMouseEvent() {
        clickCount += 1;
      }
    }
  };

  await assert.rejects(
    () => openChatOnlineResume(client, {
      timeoutMs: 50,
      attemptsLimit: 1,
      settleMs: 0
    }),
    (error) => isUnsafeChatOnlineResumeLinkError(error)
  );
  assert.equal(clickCount, 0);
}

function createFakeChatJobClient({ selectionChanges = true, initialSelectedLabel = "" , initialMenuOpen = false } = {}) {
  const requestedLabel = "算法工程师 23-27届实习/校招/早期职业 _ 杭州 25-50K";
  const wrongLabel = "大模型高招岗位 _ 杭州 50-80K";
  const state = {
    selectedLabel: initialSelectedLabel || wrongLabel,
    menuOpen: Boolean(initialMenuOpen),
    clicks: [],
    keyEvents: []
  };
  const optionLabels = {
    101: "全部职位",
    102: wrongLabel,
    103: requestedLabel
  };
  const optionValues = {
    101: "-1",
    102: "535092691",
    103: "534000582"
  };
  const centers = {
    20: { x: 50, y: 20 },
    101: { x: 50, y: 60 },
    102: { x: 50, y: 90 },
    103: { x: 50, y: 120 }
  };
  const boxFor = (nodeId) => {
    const center = centers[nodeId];
    if (!center) throw new Error(`no box for ${nodeId}`);
    if ([101, 102, 103].includes(nodeId) && !state.menuOpen) {
      throw new Error("option hidden");
    }
    return {
      model: {
        border: [
          center.x - 20, center.y - 10,
          center.x + 20, center.y - 10,
          center.x + 20, center.y + 10,
          center.x - 20, center.y + 10
        ]
      }
    };
  };
  return {
    state,
    client: {
      DOM: {
        async getDocument() {
          return { root: { nodeId: 1 } };
        },
        async querySelector(params) {
          const selector = String(params.selector || "");
          if (selector === ".chat-job .chat-select-job" || selector === ".chat-job .dropmenu-label") {
            return { nodeId: selector === ".chat-job .chat-select-job" ? 20 : 10 };
          }
          if (selector === ".chat-job") return { nodeId: 20 };
          return { nodeId: 0 };
        },
        async querySelectorAll(params) {
          const selector = String(params.selector || "");
          if (selector === ".chat-job .ui-dropmenu-list li") return { nodeIds: [101, 102, 103] };
          if (selector === ".chat-job .chat-select-job" || selector === ".chat-job" || selector === ".chat-job .dropmenu-label") {
            return { nodeIds: [20] };
          }
          return { nodeIds: [] };
        },
        async getAttributes(params) {
          if (params.nodeId === 20) return { attributes: ["class", "chat-select-job"] };
          if (params.nodeId === 10) return { attributes: ["class", "dropmenu-label"] };
          const label = optionLabels[params.nodeId];
          if (label) {
            const active = label === state.selectedLabel ? "active" : "";
            return {
              attributes: ["title", label, "value", optionValues[params.nodeId], "class", active]
            };
          }
          return { attributes: [] };
        },
        async getOuterHTML(params) {
          if (params.nodeId === 20 || params.nodeId === 10) {
            return { outerHTML: `<div class="chat-select-job">${state.selectedLabel}</div>` };
          }
          const label = optionLabels[params.nodeId];
          if (label) {
            const active = label === state.selectedLabel ? "active" : "";
            return { outerHTML: `<li class="${active}" value="${optionValues[params.nodeId]}">${label}</li>` };
          }
          return { outerHTML: "" };
        },
        async getBoxModel(params) {
          return boxFor(params.nodeId);
        },
        async scrollIntoViewIfNeeded() {}
      },
      Input: {
        async dispatchMouseEvent(event) {
          if (event.type !== "mouseReleased") return;
          state.clicks.push({ x: event.x, y: event.y });
          if (Math.abs(event.x - centers[20].x) < 1 && Math.abs(event.y - centers[20].y) < 1) {
            state.menuOpen = true;
            return;
          }
          if (Math.abs(event.x - centers[103].x) < 1 && Math.abs(event.y - centers[103].y) < 1) {
            if (selectionChanges) state.selectedLabel = requestedLabel;
            state.menuOpen = false;
          }
        },
        async dispatchKeyEvent(event) {
          state.keyEvents.push(event);
          if (event.type === "keyUp" && event.key === "Escape") {
            state.menuOpen = false;
          }
        }
      }
    }
  };
}

async function testChatJobSelectionVerifiesRequestedJob() {
  const { client, state } = createFakeChatJobClient();
  const result = await selectChatJob(client, 1, {
    jobLabel: "算法工程师 23-27届实习/校招/早期职业 _ 杭州",
    timeoutMs: 100,
    intervalMs: 1,
    settleMs: 0
  });
  assert.equal(result.selected, true);
  assert.equal(result.verified, true);
  assert.match(result.selected_label, /算法工程师 23-27届/);
  assert.match(state.selectedLabel, /算法工程师 23-27届/);
}

async function testChatJobSelectionClosesOpenDropdownWhenAlreadyCurrent() {
  const requestedLabel = "算法工程师 23-27届实习/校招/早期职业 _ 杭州 25-50K";
  const { client, state } = createFakeChatJobClient({
    initialSelectedLabel: requestedLabel,
    initialMenuOpen: true
  });
  const result = await selectChatJob(client, 1, {
    jobLabel: "534000582",
    timeoutMs: 100,
    intervalMs: 1,
    settleMs: 0
  });
  assert.equal(result.selected, true);
  assert.equal(result.verified, true);
  assert.equal(result.already_current, true);
  assert.equal(result.menu_close.closed, true);
  assert.equal(state.menuOpen, false);
  assert.equal(state.keyEvents.some((event) => event.key === "Escape"), true);
}

async function testChatJobSelectionFailsWhenUiStaysOnWrongJob() {
  const { client, state } = createFakeChatJobClient({ selectionChanges: false });
  const result = await selectChatJob(client, 1, {
    jobLabel: "算法工程师 23-27届实习/校招/早期职业 _ 杭州",
    timeoutMs: 100,
    intervalMs: 1,
    settleMs: 0
  });
  assert.equal(result.selected, false);
  assert.equal(result.verified, false);
  assert.equal(result.reason, "job_selection_not_verified");
  assert.match(state.selectedLabel, /大模型高招岗位/);
}

async function testOnlineResumeButtonRequiresExpectedActiveCandidate() {
  let activeCandidateId = "candidate-1";
  const client = {
    Page: {
      async getFrameTree() {
        return {
          frameTree: {
            frame: { url: "https://www.zhipin.com/web/chat/index" }
          }
        };
      }
    },
    DOM: {
      async getDocument() {
        return { root: { nodeId: 1 } };
      },
      async querySelectorAll(_params) {
        if (String(_params.selector || "").includes("resume-btn-online")) {
          return { nodeIds: [20] };
        }
        return { nodeIds: [] };
      },
      async querySelector(_params) {
        if (String(_params.selector || "").includes(".geek-item.selected")) {
          return { nodeId: 10 };
        }
        return { nodeId: 0 };
      },
      async getAttributes(params) {
        if (params.nodeId === 10) {
          return { attributes: ["data-id", activeCandidateId, "class", "geek-item selected"] };
        }
        return { attributes: ["class", "btn resume-btn-online"] };
      },
      async getOuterHTML(params) {
        if (params.nodeId === 10) {
          return { outerHTML: `<div class="geek-item selected" data-id="${activeCandidateId}">李鹏涛</div>` };
        }
        return { outerHTML: '<a class="btn resume-btn-online">在线简历</a>' };
      },
      async getBoxModel() {
        return {
          model: {
            border: [0, 0, 100, 0, 100, 30, 0, 30]
          }
        };
      }
    }
  };

  const mismatch = await waitForChatOnlineResumeButton(client, {
    timeoutMs: 5,
    intervalMs: 1,
    expectedCandidateId: "candidate-2"
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "active_candidate_mismatch");
  assert.equal(mismatch.active_candidate_id, "candidate-1");

  activeCandidateId = "candidate-2";
  const matched = await waitForChatOnlineResumeButton(client, {
    timeoutMs: 50,
    intervalMs: 1,
    expectedCandidateId: "candidate-2"
  });
  assert.equal(matched.ok, true);
  assert.equal(matched.candidate_selection_verified, true);
  assert.equal(matched.active_candidate_id, "candidate-2");
}

async function testDisabledAskResumeIsNotAlreadyRequested() {
  let askLabel = "求简历";
  let askClass = "operate-btn disabled";
  const client = {
    DOM: {
      async getDocument() {
        return { root: { nodeId: 1 } };
      },
      async querySelectorAll(params) {
        const selector = String(params.selector || "");
        if (selector.includes("resume-btn-online")) return { nodeIds: [20] };
        if (selector.includes("resume-btn-file")) return { nodeIds: [21] };
        if (selector === "span.operate-btn" || selector === ".operate-btn") return { nodeIds: [30] };
        if (selector.includes("boss-chat-editor-input")) return { nodeIds: [40] };
        if (selector.includes("submit")) return { nodeIds: [41] };
        return { nodeIds: [] };
      },
      async getAttributes(params) {
        if (params.nodeId === 20) return { attributes: ["class", "btn resume-btn-online"] };
        if (params.nodeId === 21) return { attributes: ["class", "btn resume-btn-file disabled"] };
        if (params.nodeId === 30) return { attributes: ["class", askClass] };
        if (params.nodeId === 40) return { attributes: ["id", "boss-chat-editor-input", "contenteditable", "true"] };
        if (params.nodeId === 41) return { attributes: ["class", "submit"] };
        return { attributes: [] };
      },
      async getOuterHTML(params) {
        if (params.nodeId === 20) return { outerHTML: '<a class="btn resume-btn-online">在线简历</a>' };
        if (params.nodeId === 21) return { outerHTML: '<a class="btn resume-btn-file disabled">附件简历</a>' };
        if (params.nodeId === 30) return { outerHTML: `<span class="${askClass}">${askLabel}</span>` };
        if (params.nodeId === 40) return { outerHTML: '<div id="boss-chat-editor-input" contenteditable="true"></div>' };
        if (params.nodeId === 41) return { outerHTML: '<button class="submit">发送</button>' };
        return { outerHTML: "" };
      },
      async getBoxModel() {
        return {
          model: {
            border: [0, 0, 100, 0, 100, 30, 0, 30]
          }
        };
      }
    }
  };

  const disabledAsk = await readChatConversationReadyState(client);
  assert.equal(disabledAsk.has_ask_resume, true);
  assert.equal(disabledAsk.ask_resume.disabled, true);
  assert.equal(disabledAsk.already_requested_resume, false);

  askLabel = "已求简历";
  askClass = "operate-btn disabled";
  const requestedAsk = await readChatConversationReadyState(client);
  assert.equal(requestedAsk.already_requested_resume, true);
}

async function testPlainAttachmentResumeIsNotAskResumeControl() {
  const client = {
    DOM: {
      async getDocument() {
        return { root: { nodeId: 1 } };
      },
      async querySelectorAll(params) {
        const selector = String(params.selector || "");
        if (selector.includes("resume-btn-file")) return { nodeIds: [21] };
        if (selector.includes("boss-chat-editor-input")) return { nodeIds: [40] };
        return { nodeIds: [] };
      },
      async getAttributes(params) {
        if (params.nodeId === 21) return { attributes: ["class", "btn resume-btn-file"] };
        if (params.nodeId === 40) return { attributes: ["id", "boss-chat-editor-input", "contenteditable", "true"] };
        return { attributes: [] };
      },
      async getOuterHTML(params) {
        if (params.nodeId === 21) return { outerHTML: '<a class="btn resume-btn-file">附件简历</a>' };
        if (params.nodeId === 40) return { outerHTML: '<div id="boss-chat-editor-input" contenteditable="true"></div>' };
        return { outerHTML: "" };
      },
      async getBoxModel() {
        return {
          model: {
            border: [0, 0, 100, 0, 100, 30, 0, 30]
          }
        };
      }
    }
  };

  const state = await readChatConversationReadyState(client);
  assert.equal(state.has_attachment_resume, true);
  assert.equal(state.attachment_resume_enabled, true);
  assert.equal(state.has_ask_resume, false);
  assert.equal(state.already_requested_resume, false);
}

async function testActiveAttachmentResumeSkipsRequest() {
  let clicked = false;
  const client = {
    DOM: {
      async getDocument() {
        return { root: { nodeId: 1 } };
      },
      async querySelectorAll(params) {
        const selector = String(params.selector || "");
        if (selector.includes("resume-btn-online")) return { nodeIds: [20] };
        if (selector.includes("resume-btn-file")) return { nodeIds: [21] };
        if (selector === "span.operate-btn" || selector === ".operate-btn") return { nodeIds: [30] };
        return { nodeIds: [] };
      },
      async getAttributes(params) {
        if (params.nodeId === 20) return { attributes: ["class", "btn resume-btn-online"] };
        if (params.nodeId === 21) return { attributes: ["class", "btn resume-btn-file"] };
        if (params.nodeId === 30) return { attributes: ["class", "operate-btn disabled"] };
        return { attributes: [] };
      },
      async getOuterHTML(params) {
        if (params.nodeId === 20) return { outerHTML: '<a class="btn resume-btn-online">在线简历</a>' };
        if (params.nodeId === 21) return { outerHTML: '<a class="btn resume-btn-file">附件简历</a>' };
        if (params.nodeId === 30) return { outerHTML: '<span class="operate-btn disabled">求简历</span>' };
        return { outerHTML: "" };
      },
      async getBoxModel() {
        return {
          model: {
            border: [0, 0, 100, 0, 100, 30, 0, 30]
          }
        };
      }
    },
    Input: {
      async dispatchMouseEvent() {
        clicked = true;
      }
    }
  };
  const result = await requestChatResumeForPassedCandidate(client);
  assert.equal(result.requested, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "attachment_resume_already_available");
  assert.equal(clicked, false);
}

async function testChatResumeRequestSendsMessageBeforeAskResume() {
  const state = {
    editorText: "",
    messageSent: false,
    askClicked: false,
    confirmVisible: false,
    requestSent: false,
    lastBoxNodeId: 0,
    clicks: [],
    boxCenters: {}
  };
  const nodeHtml = (nodeId) => {
    if (nodeId === 20) return '<a class="btn resume-btn-online">在线简历</a>';
    if (nodeId === 21) return '<a class="btn resume-btn-file disabled">附件简历</a>';
    if (nodeId === 30) {
      const className = state.messageSent ? "operate-btn" : "operate-btn disabled";
      const label = state.requestSent ? "已求简历" : "求简历";
      return `<span class="${state.requestSent ? "operate-btn disabled" : className}">${label}</span>`;
    }
    if (nodeId === 40) return `<div id="boss-chat-editor-input" contenteditable="true">${state.editorText}</div>`;
    if (nodeId === 41) return '<button class="submit active">发送</button>';
    if (nodeId === 50) {
      return state.requestSent
        ? '<div class="chat-message-list"><div>简历请求已发送</div></div>'
        : '<div class="chat-message-list"></div>';
    }
    if (nodeId === 60) return '<span class="boss-btn-primary boss-btn">确定</span>';
    return "";
  };
  const client = {
    DOM: {
      async getDocument() {
        return { root: { nodeId: 1 } };
      },
      async querySelectorAll(params) {
        const selector = String(params.selector || "");
        if (selector.includes("resume-btn-online")) return { nodeIds: [20] };
        if (selector.includes("resume-btn-file")) return { nodeIds: [21] };
        if (selector === "span.operate-btn" || selector === ".operate-btn") return { nodeIds: [30] };
        if (selector.includes("boss-chat-editor-input")) return { nodeIds: [40] };
        if (selector.includes("submit")) return { nodeIds: [41] };
        if (selector.includes("chat-message-list")) return { nodeIds: [50] };
        if (state.confirmVisible && selector.includes("boss-btn-primary")) return { nodeIds: [60] };
        return { nodeIds: [] };
      },
      async getAttributes(params) {
        if (params.nodeId === 20) return { attributes: ["class", "btn resume-btn-online"] };
        if (params.nodeId === 21) return { attributes: ["class", "btn resume-btn-file disabled"] };
        if (params.nodeId === 30) {
          const className = state.requestSent
            ? "operate-btn disabled"
            : state.messageSent
              ? "operate-btn"
              : "operate-btn disabled";
          return { attributes: ["class", className] };
        }
        if (params.nodeId === 40) return { attributes: ["id", "boss-chat-editor-input", "contenteditable", "true"] };
        if (params.nodeId === 41) return { attributes: ["class", "submit active"] };
        if (params.nodeId === 50) return { attributes: ["class", "chat-message-list"] };
        if (params.nodeId === 60) return { attributes: ["class", "boss-btn-primary boss-btn"] };
        return { attributes: [] };
      },
      async getOuterHTML(params) {
        return { outerHTML: nodeHtml(params.nodeId) };
      },
      async getBoxModel(params) {
        state.lastBoxNodeId = params.nodeId;
        const left = params.nodeId * 10;
        const right = left + 100;
        const center = left + 50;
        state.boxCenters[center] = params.nodeId;
        return {
          model: {
            border: [left, 0, right, 0, right, 30, left, 30]
          }
        };
      },
      async scrollIntoViewIfNeeded() {}
    },
    Input: {
      async dispatchMouseEvent(params) {
        if (params.type !== "mouseReleased") return {};
        const clickedNodeId = state.boxCenters[Math.round(params.x)] || state.lastBoxNodeId;
        state.clicks.push(clickedNodeId);
        if (clickedNodeId === 41) state.messageSent = true;
        if (clickedNodeId === 30 && state.messageSent) {
          state.askClicked = true;
          state.confirmVisible = true;
        }
        if (clickedNodeId === 60 && state.confirmVisible) {
          state.confirmVisible = false;
          state.requestSent = true;
        }
        return {};
      },
      async dispatchKeyEvent() {
        return {};
      },
      async insertText(params) {
        state.editorText = params.text;
        return {};
      }
    }
  };

  const result = await requestChatResumeForPassedCandidate(client, {
    greetingText: "",
    maxAttempts: 1
  });
  assert.equal(result.requested, true);
  assert.equal(result.skipped, false);
  assert.equal(result.greeting_sent, true);
  assert.equal(result.greeting_send_result.expected_text, "Hi同学，能麻烦发下简历吗？");
  assert.deepEqual(state.clicks.filter((nodeId) => [41, 30, 60].includes(nodeId)), [41, 30, 60]);
}

testNetworkPatterns();
await testQuickChatResumeModalOpenProbe();
testNetworkRecorder();
await testCardCandidateReader();
await testChatSelfHealConfig();
await testEmptyChatListVisualInspection();
await testChatTopLevelPageGuard();
await testUnsafeOnlineResumeLinkIsBlockedBeforeClick();
await testChatJobSelectionVerifiesRequestedJob();
await testChatJobSelectionClosesOpenDropdownWhenAlreadyCurrent();
await testChatJobSelectionFailsWhenUiStaysOnWrongJob();
await testOnlineResumeButtonRequiresExpectedActiveCandidate();
await testDisabledAskResumeIsNotAlreadyRequested();
await testPlainAttachmentResumeIsNotAskResumeControl();
await testActiveAttachmentResumeSkipsRequest();
await testChatResumeRequestSendsMessageBeforeAskResume();

console.log("chat domain tests passed");
