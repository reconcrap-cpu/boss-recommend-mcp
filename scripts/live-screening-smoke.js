#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertNoForbiddenCdpCalls,
  bringPageToFront,
  connectToChromeTarget,
  enableDomains,
  findIframeDocument,
  getAttributesMap,
  getDocumentRoot,
  getOuterHTML,
  querySelectorAll
} from "../src/core/browser/index.js";
import {
  normalizeCandidateFromHtml,
  screenCandidate
} from "../src/core/screening/index.js";

const RECOMMEND_TARGET_URL = "https://www.zhipin.com/web/chat/recommend";
const RECOMMEND_IFRAME_SELECTORS = [
  'iframe[name="recommendFrame"]',
  'iframe[src*="/web/frame/recommend/"]',
  "iframe"
];
const RECOMMEND_CARD_SELECTOR = [
  ".candidate-card-wrap .card-inner[data-geek]",
  ".candidate-card-wrap [data-geek]",
  "li.geek-info-card a[data-geekid]",
  "a[data-geekid]"
].join(", ");

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: RECOMMEND_TARGET_URL,
    criteria: "",
    savePayload: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--target-url-includes") result.targetUrlIncludes = argv[++index];
    if (arg === "--criteria") result.criteria = argv[++index];
    if (arg === "--save-payload") result.savePayload = argv[++index];
  }
  return result;
}

function methodSummary(methodLog) {
  const summary = {};
  for (const entry of methodLog) {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
  }
  return summary;
}

function redactIdentity(identity = {}) {
  return {
    ...identity,
    name: identity?.name ? "[redacted]" : null
  };
}

function writeJsonFile(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolved;
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
    },
    runtime_guard_probe: null,
    recommend: {}
  };

  try {
    session = await connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetUrlIncludes: options.targetUrlIncludes
    });
    const { client, methodLog, target } = session;
    result.chrome.target = {
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title
    };

    await enableDomains(client, ["Page", "DOM"]);
    await bringPageToFront(client);

    const root = await getDocumentRoot(client);
    const iframe = await findIframeDocument(client, root.nodeId, RECOMMEND_IFRAME_SELECTORS);
    if (!iframe) throw new Error("recommendFrame iframe was not found");

    const cardNodeIds = await querySelectorAll(client, iframe.documentNodeId, RECOMMEND_CARD_SELECTOR);
    if (!cardNodeIds.length) {
      throw new Error("No recommend candidate cards found");
    }

    const firstCardNodeId = cardNodeIds[0];
    const [attributes, outerHTML] = await Promise.all([
      getAttributesMap(client, firstCardNodeId),
      getOuterHTML(client, firstCardNodeId)
    ]);
    const candidate = normalizeCandidateFromHtml({
      domain: "recommend",
      source: "live-cdp-dom",
      html: outerHTML,
      attributes,
      metadata: {
        target_url: target.url,
        card_node_id: firstCardNodeId
      }
    });
    const screening = screenCandidate(candidate, {
      criteria: options.criteria
    });

    let savedPayloadPath = null;
    if (options.savePayload) {
      savedPayloadPath = writeJsonFile(options.savePayload, {
        generated_at: new Date().toISOString(),
        note: "Unredacted local artifact. This is the normalized first-card candidate payload intended for screening/LLM input review.",
        chrome: {
          target_url: target.url,
          target_title: target.title
        },
        extraction: {
          domain: "recommend",
          source: "live-cdp-dom",
          iframe_selector: iframe.selector,
          card_selector: RECOMMEND_CARD_SELECTOR,
          first_card_node_id: firstCardNodeId,
          card_count: cardNodeIds.length,
          cdp_methods: methodLog.map((entry) => entry.method)
        },
        llm_screening_payload: {
          schema_version: 1,
          criteria: options.criteria,
          candidate
        },
        deterministic_screening_result: screening
      });
    }

    if (!candidate.text.raw || candidate.text.raw.length < 2) {
      throw new Error("Live candidate normalization produced empty text");
    }
    if (!candidate.identity.name && !candidate.id) {
      throw new Error("Live candidate normalization produced neither name nor id");
    }

    result.runtime_guard_probe = assertNoForbiddenCdpCalls(methodLog);
    result.runtime_evaluate_used = false;
    result.recommend = {
      iframe: {
        selector: iframe.selector,
        document_node_id: iframe.documentNodeId
      },
      card_count: cardNodeIds.length,
      first_card_node_id: firstCardNodeId,
      candidate: {
        schema_version: candidate.schema_version,
        domain: candidate.domain,
        source: candidate.source,
        has_id: Boolean(candidate.id),
        text_length: candidate.text.raw.length,
        identity: redactIdentity(candidate.identity),
        tags_count: candidate.tags.length
      },
      screening: {
        schema_version: screening.schema_version,
        status: screening.status,
        passed: screening.passed,
        score: screening.score,
        reasons: screening.reasons,
        matched: screening.matched,
        candidate: {
          ...screening.candidate,
          identity: redactIdentity(screening.candidate.identity)
        }
      },
      saved_payload_path: savedPayloadPath
    };
    result.method_summary = methodSummary(methodLog);
    result.method_log = methodLog;
    result.status = "PASS";
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
