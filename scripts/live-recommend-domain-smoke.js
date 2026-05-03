#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertNoForbiddenCdpCalls,
  assertRuntimeEvaluateBlocked,
  bringPageToFront,
  connectToChromeTarget,
  enableDomains,
  sleep
} from "../src/core/browser/index.js";
import { screenCandidate } from "../src/core/screening/index.js";
import {
  buildRecommendSelfHealConfig,
  HEALTH_STATUS,
  resolveRecommendSelfHealRoots,
  runSelfHealCheck
} from "../src/core/self-heal/index.js";
import {
  closeRecommendDetail,
  createRecommendDetailNetworkRecorder,
  extractRecommendDetailCandidate,
  getRecommendRoots,
  openRecommendCardDetail,
  openFilterPanel,
  readRecommendCardCandidate,
  RECOMMEND_TARGET_URL,
  listFilterOptions,
  selectAndConfirmFirstSafeFilter,
  selectRecommendPageScope,
  waitForRecommendCardNodeIds
} from "../src/domains/recommend/index.js";

const DEFAULT_RULES_PATH = "";

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: RECOMMEND_TARGET_URL,
    rulesPath: DEFAULT_RULES_PATH,
    criteria: "",
    savePayload: ".live-artifacts/recommend-domain-first-card-detail.json",
    closeDetail: true,
    pageScope: "recommend",
    filterGroup: "",
    filterLabels: [],
    filterGroups: [],
    allowNavigate: true,
    selectAllLabels: false,
    skipDetail: false,
    leavePanelOpen: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--target-url-includes") result.targetUrlIncludes = argv[++index];
    if (arg === "--rules") result.rulesPath = argv[++index];
    if (arg === "--criteria") result.criteria = argv[++index];
    if (arg === "--save-payload") result.savePayload = argv[++index];
    if (arg === "--no-save-payload") result.savePayload = "";
    if (arg === "--leave-detail-open") result.closeDetail = false;
    if (arg === "--page-scope") result.pageScope = argv[++index];
    if (arg === "--filter-group") result.filterGroup = argv[++index];
    if (arg === "--filter-label") result.filterLabels.push(argv[++index]);
    if (arg === "--filter-labels") {
      result.filterLabels.push(...String(argv[++index] || "").split(/[,，、|/]/).map((item) => item.trim()).filter(Boolean));
    }
    if (arg === "--filter") {
      const raw = String(argv[++index] || "");
      const [group, labelsRaw = ""] = raw.split(/[:=]/);
      result.filterGroups.push({
        group: group.trim(),
        labels: labelsRaw.split(/[,，、|/]/).map((item) => item.trim()).filter(Boolean),
        selectAllLabels: true
      });
    }
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--select-all-labels") result.selectAllLabels = true;
    if (arg === "--skip-detail") result.skipDetail = true;
    if (arg === "--leave-panel-open") result.leavePanelOpen = true;
  }

  return result;
}

async function connectToRecommendSession(options) {
  try {
    return await connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetUrlIncludes: options.targetUrlIncludes
    });
  } catch (error) {
    if (!options.allowNavigate) throw error;
    return connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetPredicate: (target) => (
        target?.type === "page"
        && String(target?.url || "").includes("zhipin.com/web/chat")
      )
    });
  }
}

function methodSummary(methodLog) {
  const summary = {};
  for (const entry of methodLog) {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
  }
  return summary;
}

function readJsonFile(filePath) {
  if (!filePath) return {};
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return {};
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function writeJsonFile(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolved;
}

function redactIdentity(identity = {}) {
  return {
    ...identity,
    name: identity?.name ? "[redacted]" : null
  };
}

function compactHealth(check) {
  return {
    status: check.status,
    summary: check.summary,
    drift_report: check.drift_report,
    probes: check.probes.map((probe) => ({
      id: probe.id,
      type: probe.type,
      status: probe.status,
      count: probe.count,
      required: probe.required
    }))
  };
}

function summarizeActiveOptions(options = [], group = "") {
  return options
    .filter((option) => option.active && (!group || option.group === group))
    .map((option) => ({
      group: option.group,
      label: option.label,
      node_id: option.node_id
    }));
}

async function waitForHealthyRecommend(client, selfHealConfig, {
  timeoutMs = 20000,
  intervalMs = 800
} = {}) {
  const started = Date.now();
  let lastCheck = null;
  while (Date.now() - started <= timeoutMs) {
    const selfHealRoots = await resolveRecommendSelfHealRoots(client, selfHealConfig);
    lastCheck = await runSelfHealCheck({
      client,
      domain: "recommend",
      roots: selfHealRoots.roots,
      selectorProbes: selfHealConfig.selectorProbes,
      accessibilityProbes: selfHealConfig.accessibilityProbes
    });
    if (lastCheck.status === HEALTH_STATUS.HEALTHY) return lastCheck;
    await sleep(intervalMs);
  }
  return lastCheck;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  let session;
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    chrome: {
      host: options.host,
      port: options.port,
      target_url_includes: options.targetUrlIncludes
    }
  };

  try {
    session = await connectToRecommendSession(options);
    const { client, methodLog, target } = session;
    result.chrome.target = {
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title
    };
    result.runtime_guard_probe = await assertRuntimeEvaluateBlocked(client);

    await enableDomains(client, ["Page", "DOM", "Input", "Network", "Accessibility"]);
    const networkRecorder = createRecommendDetailNetworkRecorder(client);
    await bringPageToFront(client);
    if (options.allowNavigate && !String(target.url || "").includes(options.targetUrlIncludes)) {
      await client.Page.navigate({ url: RECOMMEND_TARGET_URL });
      await sleep(3000);
      result.chrome.navigated_to = RECOMMEND_TARGET_URL;
    }

    const rules = readJsonFile(options.rulesPath);
    const selfHealConfig = buildRecommendSelfHealConfig(rules);
    const initialHealth = await waitForHealthyRecommend(client, selfHealConfig);
    result.self_heal = {
      initial: initialHealth ? compactHealth(initialHealth) : null
    };
    if (!initialHealth || initialHealth.status !== HEALTH_STATUS.HEALTHY) {
      throw new Error(`Recommend initial health is not healthy: ${initialHealth?.status || "missing"}`);
    }

    const preFilterCloseResult = await closeRecommendDetail(client, { attemptsLimit: 2 });
    await sleep(500);
    let rootState = await getRecommendRoots(client);
    const pageScopeResult = await selectRecommendPageScope(client, rootState.iframe.documentNodeId, {
      pageScope: options.pageScope,
      fallbackScope: "recommend",
      settleMs: 1500,
      timeoutMs: 20000
    });
    if (!pageScopeResult.selected) {
      throw new Error(`Recommend page scope was not selected: ${pageScopeResult.reason || options.pageScope}`);
    }
    rootState = await getRecommendRoots(client);
    const filterResult = await selectAndConfirmFirstSafeFilter(client, rootState.iframe.documentNodeId, {
      group: options.filterGroup,
      labels: options.filterLabels,
      selectAllLabels: options.selectAllLabels,
      filterGroups: options.filterGroups
    });
    if (!filterResult.confirmed) {
      throw new Error("Recommend filter selection was not confirmed");
    }

    let activeOptionsAfterConfirm = [];
    if (options.leavePanelOpen) {
      await openFilterPanel(client, rootState.iframe.documentNodeId);
      activeOptionsAfterConfirm = summarizeActiveOptions(
        await listFilterOptions(client, rootState.iframe.documentNodeId),
        options.filterGroup
      );
    }

    const cardNodeIds = await waitForRecommendCardNodeIds(client, rootState.iframe.documentNodeId, {
      timeoutMs: 10000,
      intervalMs: 300
    });
    if (!cardNodeIds.length) {
      throw new Error("No recommend candidate cards found after filter confirmation");
    }

    const firstCardNodeId = cardNodeIds[0];
    const cardCandidate = await readRecommendCardCandidate(client, firstCardNodeId, {
      targetUrl: target.url,
      source: "recommend-domain-card"
    });
    let openedDetail = null;
    let detailResult = null;
    let screeningCandidate = cardCandidate;
    if (!options.skipDetail) {
      networkRecorder.clear();
      openedDetail = await openRecommendCardDetail(client, firstCardNodeId);
      detailResult = await extractRecommendDetailCandidate(client, {
        cardCandidate,
        cardNodeId: firstCardNodeId,
        detailState: openedDetail.detail_state,
        networkEvents: networkRecorder.events,
        targetUrl: target.url,
        closeDetail: options.closeDetail
      });

      if (!detailResult.detail.popup_text && !detailResult.network_bodies.length) {
        throw new Error("Recommend detail opened, but no detail text or network body was extracted");
      }
      screeningCandidate = detailResult.candidate;
    }

    const screening = screenCandidate(screeningCandidate, {
      criteria: options.criteria
    });

    assertNoForbiddenCdpCalls(methodLog);

    let savedPayloadPath = null;
    result.status = "PASS";
    result.runtime_evaluate_used = false;
    result.recommend = {
      iframe: {
        selector: rootState.iframe.selector,
        document_node_id: rootState.iframe.documentNodeId
      },
      page_scope: pageScopeResult,
      filter: {
        opened_panel: filterResult.opened_panel,
        selected_option: filterResult.selected_option,
        selected_options: filterResult.selected_options || null,
        confirmed: filterResult.confirmed,
        before_counts: filterResult.before_counts,
        after_open_counts: filterResult.after_open_counts,
        after_confirm_counts: filterResult.after_confirm_counts,
        active_options_after_confirm: activeOptionsAfterConfirm,
        pre_filter_close_result: preFilterCloseResult
      },
      cards: {
        count_after_filter: cardNodeIds.length,
        first_card_node_id: firstCardNodeId,
        first_card_candidate: {
          schema_version: cardCandidate.schema_version,
          has_id: Boolean(cardCandidate.id),
          identity: redactIdentity(cardCandidate.identity),
          text_length: cardCandidate.text.raw.length
        }
      },
      detail: {
        opened: Boolean(openedDetail),
        popup_found: Boolean(openedDetail?.detail_state?.popup),
        resume_iframe_found: Boolean(openedDetail?.detail_state?.resumeIframe),
        popup_text_length: detailResult?.detail?.popup_text?.length || 0,
        resume_text_length: detailResult?.detail?.resume_text?.length || 0,
        network_detail_event_count: networkRecorder.events.length,
        network_body_count: detailResult?.network_bodies?.filter((item) => item.body).length || 0,
        parsed_network_profile_count: detailResult?.parsed_network_profiles?.filter((item) => item.ok).length || 0,
        close_result: detailResult?.close_result || null
      },
      screening: {
        schema_version: screening.schema_version,
        status: screening.status,
        passed: screening.passed,
        score: screening.score,
        reasons: screening.reasons,
        candidate: {
          ...screening.candidate,
          identity: redactIdentity(screening.candidate.identity)
        }
      }
    };
    result.method_summary = methodSummary(methodLog);
    result.method_log = methodLog;

    if (options.savePayload) {
      savedPayloadPath = writeJsonFile(options.savePayload, {
        generated_at: new Date().toISOString(),
        note: "Unredacted local artifact from Phase 5 recommend-domain modules. This is the first-card detail candidate payload intended for screening/LLM input review.",
        chrome: {
          target_url: target.url,
          target_title: target.title
        },
        extraction: {
          domain: "recommend",
          source: "recommend-domain-live-smoke",
          selected_filter: filterResult.selected_option,
          page_scope: pageScopeResult,
          selected_filters: filterResult.selected_options || null,
          active_options_after_confirm: activeOptionsAfterConfirm,
          pre_filter_close_result: preFilterCloseResult,
          first_card_node_id: firstCardNodeId,
          card_count_after_filter: cardNodeIds.length,
          cdp_methods: methodLog.map((entry) => entry.method)
        },
        card_candidate: cardCandidate,
        detail: detailResult?.detail || null,
        parsed_network_profiles: detailResult?.parsed_network_profiles || [],
        network_bodies: detailResult?.network_bodies || [],
        llm_screening_payload: {
          schema_version: 1,
          criteria: options.criteria,
          candidate: screeningCandidate
        },
        deterministic_screening_result: screening
      });
      result.recommend.saved_payload_path = savedPayloadPath;
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    result.status = "FAIL";
    result.error = {
      name: error?.name || "Error",
      message: error?.message || String(error)
    };
    if (session?.methodLog) {
      result.method_summary = methodSummary(session.methodLog);
      result.method_log = session.methodLog;
    }
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
  }
}

run();
