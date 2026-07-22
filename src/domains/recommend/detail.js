import {
  clickNodeCenter,
  clickPoint,
  DETERMINISTIC_CLICK_OPTIONS,
  describeNode,
  getAttributesMap,
  getFrameDocumentNodeId,
  getNodeBox,
  getOuterHTML,
  isClosedCdpTransportError,
  pressKey,
  querySelectorAll,
  scrollNodeIntoView,
  sleep
} from "../../core/browser/index.js";
import { candidateKeyFromProfile } from "../../core/infinite-list/index.js";
import {
  CV_CAPTURE_TARGET_SELECTORS,
  resolveCvCaptureTarget
} from "../../core/cv-capture-target/index.js";
import {
  buildScreeningCandidateFromDetail,
  htmlToText
} from "../../core/screening/index.js";
import {
  closeBossAccountRightsBlockingPanel,
  findBossAccountRightsBlockingPanel
} from "../common/account-rights-panel.js";
import {
  DETAIL_CLOSE_SELECTORS,
  DETAIL_NETWORK_PATTERNS,
  DETAIL_POPUP_SELECTORS,
  DETAIL_RESUME_IFRAME_SELECTORS,
  RECOMMEND_AVATAR_PREVIEW_CLOSE_SELECTORS,
  RECOMMEND_AVATAR_PREVIEW_SELECTORS
} from "./constants.js";
import {
  getRecommendRoots
} from "./roots.js";
import {
  findRecommendCardNodeIds,
  readRecommendCardCandidate
} from "./cards.js";

const DETAIL_OUTSIDE_CLOSE_BOUNDARY_SELECTORS = Object.freeze([
  ".resume-center-side .resume-detail-wrap",
  ".resume-detail-wrap",
  ".boss-popup__wrapper .boss-popup__body",
  ".boss-popup__wrapper .dialog-body",
  ".dialog-wrap.active .resume-detail-wrap",
  ".geek-detail-modal .resume-detail-wrap"
]);

const DETAIL_CANDIDATE_ID_ATTRIBUTES = Object.freeze([
  "data-geek",
  "data-geekid",
  "data-uid",
  "data-securityid",
  "geekid",
  "encryptgeekid"
]);
const DETAIL_CANDIDATE_ID_SELECTOR = DETAIL_CANDIDATE_ID_ATTRIBUTES
  .map((attribute) => `[${attribute}]`)
  .join(", ");
const DETAIL_IDENTITY_TEXT_SELECTOR = "span, h1, h2, h3, p, strong, b, em, li, dt, dd";
const DETAIL_IDENTITY_PRIORITY_SELECTOR = [
  ".name",
  ".geek-name",
  ".resume-name",
  ".candidate-name",
  '[class*="school"]',
  '[class*="major"]',
  '[class*="company"]',
  '[class*="position"]'
].join(", ");
const DETAIL_SECONDARY_IDENTITY_FIELDS = Object.freeze([
  "school",
  "major",
  "current_company",
  "current_position",
  "title"
]);

function normalizeBindingText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function positiveNodeId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function shouldRethrowRecommendProtocolError(error) {
  return Boolean(
    isClosedCdpTransportError(error)
    || error?.cdp_outcome_unknown === true
    || error?.cdp_replay_suppressed === true
    || (error?.cdp_method && !isStaleRecommendNodeError(error))
  );
}

function compactBindingNode(node = null) {
  if (!node) return null;
  return {
    source: node.source || null,
    field: node.field || null,
    value: node.value || null,
    node_id: positiveNodeId(node.node_id),
    backend_node_id: positiveNodeId(node.backend_node_id),
    visible: node.visible === true,
    verified: node.verified === true,
    reason: node.reason || null,
    definitively_disappeared: node.definitively_disappeared === true,
    disappearance_kind: node.disappearance_kind || null,
    accessibility_verified: node.accessibility_verified === true
  };
}

async function readVisibleBackendNode(client, nodeId) {
  try {
    const box = await getNodeBox(client, nodeId);
    if (Number(box?.rect?.width || 0) <= 2 || Number(box?.rect?.height || 0) <= 2) return null;
    const node = await describeNode(client, nodeId, { depth: 0, pierce: true });
    const backendNodeId = positiveNodeId(node?.backendNodeId);
    if (!backendNodeId) return null;
    return {
      node_id: nodeId,
      backend_node_id: backendNodeId,
      visible: true
    };
  } catch (error) {
    // A virtual-list remount is a normal stale-node race.  Transport/session
    // failures are not candidate evidence and must retain their original
    // error identity so the run cannot misclassify them as a local mismatch.
    if (isStaleRecommendNodeError(error)) return null;
    throw error;
  }
}

async function readExactAccessibilityText(client, nodeId, expectedText) {
  const expected = normalizeBindingText(expectedText);
  if (!expected || typeof client?.Accessibility?.getPartialAXTree !== "function") return false;
  const axTreeContainsExactText = (tree, expectedBackendNodeId) => {
    const backendNodeId = positiveNodeId(expectedBackendNodeId);
    if (!backendNodeId) return false;
    const nodes = tree?.nodes || [];
    const byAxId = new Map(nodes
      .filter((node) => node?.nodeId != null)
      .map((node) => [String(node.nodeId), node]));
    const queue = nodes.filter((node) => (
      positiveNodeId(node?.backendDOMNodeId) === backendNodeId
    ));
    const visited = new Set();
    let inspected = 0;
    while (queue.length && inspected < 48) {
      const node = queue.shift();
      const axId = node?.nodeId == null ? null : String(node.nodeId);
      if (axId && visited.has(axId)) continue;
      if (axId) visited.add(axId);
      inspected += 1;
      const exact = [node?.name?.value, node?.value?.value, node?.description?.value]
        .map(normalizeBindingText)
        .some((value) => value === expected);
      if (exact) return true;
      for (const childId of node?.childIds || []) {
        const child = byAxId.get(String(childId));
        if (child) queue.push(child);
      }
    }
    return false;
  };
  try {
    const described = await describeNode(client, nodeId, { depth: 4, pierce: true });
    const tree = await client.Accessibility.getPartialAXTree({
      nodeId,
      fetchRelatives: false
    });
    if (axTreeContainsExactText(tree, described?.backendNodeId)) return true;

    // BOSS commonly renders an exact identity value inside an AX-ignored
    // wrapper (for example, <span class="name">...</span>).  Keep the proof
    // scoped to the already DOM-exact node: only inspect its bounded returned
    // descendants and accept an exact #text node whose own AX entry exposes
    // the same value.  This avoids an unscoped full-tree/name search.
    const queue = [...(described?.children || [])];
    let inspected = 0;
    while (queue.length && inspected < 48) {
      const descendant = queue.shift();
      inspected += 1;
      if (
        String(descendant?.nodeName || "").toLowerCase() === "#text"
        && normalizeBindingText(descendant?.nodeValue) === expected
      ) {
        const descendantNodeId = positiveNodeId(descendant?.nodeId);
        const descendantBackendNodeId = positiveNodeId(descendant?.backendNodeId);
        const exactDescendantTarget = descendantNodeId
          ? { nodeId: descendantNodeId }
          : descendantBackendNodeId
          ? { backendNodeId: descendantBackendNodeId }
          : null;
        if (exactDescendantTarget) {
          const descendantTree = await client.Accessibility.getPartialAXTree({
            ...exactDescendantTarget,
            fetchRelatives: false
          });
          if (axTreeContainsExactText(descendantTree, descendantBackendNodeId)) return true;
        }
      }
      for (const child of descendant?.children || []) queue.push(child);
    }
    return false;
  } catch (error) {
    if (shouldRethrowRecommendProtocolError(error)) throw error;
    return false;
  }
}

function candidateIdFromAttributes(attributes = {}) {
  for (const attribute of DETAIL_CANDIDATE_ID_ATTRIBUTES) {
    const value = normalizeBindingText(attributes?.[attribute]);
    if (value) return { attribute, value };
  }
  return { attribute: null, value: "" };
}

function expectedSecondaryIdentity(candidate = null) {
  const identity = candidate?.identity || {};
  const seen = new Set();
  const values = [];
  const rawAge = normalizeBindingText(identity.age);
  const ageMatch = rawAge.match(/^(\d{1,3})(?:\s*岁)?$/);
  if (ageMatch) {
    const age = Number(ageMatch[1]);
    if (Number.isInteger(age) && age > 0 && age < 150) {
      const value = `${age}岁`;
      seen.add(value);
      values.push({ field: "age", value });
    }
  }
  for (const field of DETAIL_SECONDARY_IDENTITY_FIELDS) {
    const value = normalizeBindingText(identity[field]);
    if (!value || value.length < 2 || seen.has(value)) continue;
    seen.add(value);
    values.push({ field, value });
  }
  return values;
}

async function readRecommendCardBindingEvidence(client, cardNodeId, cardCandidate = null) {
  const expectedCandidateId = normalizeBindingText(cardCandidate?.id);
  const expectedName = normalizeBindingText(cardCandidate?.identity?.name);
  const evidence = await readVisibleBackendNode(client, cardNodeId);
  if (!evidence) {
    return {
      verified: false,
      reason: "card_node_not_visible_or_stale",
      node_id: positiveNodeId(cardNodeId),
      backend_node_id: null,
      candidate_id: null,
      name: null
    };
  }
  try {
    const [attributes, currentCandidate] = await Promise.all([
      getAttributesMap(client, cardNodeId),
      readRecommendCardCandidate(client, cardNodeId, {
        source: "recommend-detail-binding-card"
      })
    ]);
    const idEvidence = candidateIdFromAttributes(attributes);
    const candidateId = normalizeBindingText(idEvidence.value || currentCandidate?.id);
    const name = normalizeBindingText(currentCandidate?.identity?.name);
    const verified = Boolean(
      expectedCandidateId
      && expectedName
      && candidateId === expectedCandidateId
      && name === expectedName
    );
    return {
      ...evidence,
      verified,
      reason: verified
        ? null
        : !expectedCandidateId || !expectedName
        ? "expected_card_identity_incomplete"
        : candidateId !== expectedCandidateId
        ? "card_candidate_id_mismatch"
        : "card_candidate_name_mismatch",
      candidate_id: candidateId || null,
      candidate_id_attribute: idEvidence.attribute,
      name: name || null
    };
  } catch (error) {
    if (shouldRethrowRecommendProtocolError(error)) throw error;
    return {
      ...evidence,
      verified: false,
      reason: "card_identity_read_failed",
      candidate_id: null,
      name: null,
      error: error?.message || String(error)
    };
  }
}

function isDefinitiveDetachedRecommendNodeError(error) {
  const message = String(error?.message || error || "");
  return /Could not find node|No node with given id|Node with given id.*does not belong|detached node|not attached to the page/i.test(message);
}

function isDefinitiveHiddenRecommendNodeError(error) {
  const message = String(error?.message || error || "");
  return /Could not compute box model|does not have a layout object|node has no layout/i.test(message);
}

async function readRecommendCardAfterClickEvidence(client, cardNodeId, cardCandidate = null) {
  let described;
  try {
    described = await describeNode(client, cardNodeId, { depth: 0, pierce: true });
  } catch (error) {
    if (shouldRethrowRecommendProtocolError(error)) throw error;
    return {
      verified: false,
      reason: isDefinitiveDetachedRecommendNodeError(error)
        ? "card_node_detached_after_click"
        : "card_identity_probe_failed",
      definitively_disappeared: isDefinitiveDetachedRecommendNodeError(error),
      disappearance_kind: isDefinitiveDetachedRecommendNodeError(error) ? "detached" : null,
      node_id: positiveNodeId(cardNodeId),
      backend_node_id: null,
      candidate_id: null,
      name: null,
      error: error?.message || String(error)
    };
  }
  const backendNodeId = positiveNodeId(described?.backendNodeId);
  if (!backendNodeId) {
    return {
      verified: false,
      reason: "card_identity_probe_failed",
      definitively_disappeared: false,
      disappearance_kind: null,
      node_id: positiveNodeId(cardNodeId),
      backend_node_id: null,
      candidate_id: null,
      name: null
    };
  }
  try {
    const box = await getNodeBox(client, cardNodeId);
    if (Number(box?.rect?.width || 0) <= 2 || Number(box?.rect?.height || 0) <= 2) {
      return {
        verified: false,
        reason: "card_node_hidden_after_click",
        definitively_disappeared: true,
        disappearance_kind: "hidden_zero_box",
        node_id: positiveNodeId(cardNodeId),
        backend_node_id: backendNodeId,
        candidate_id: null,
        name: null
      };
    }
  } catch (error) {
    const hidden = isDefinitiveHiddenRecommendNodeError(error);
    const detached = isDefinitiveDetachedRecommendNodeError(error);
    return {
      verified: false,
      reason: detached
        ? "card_node_detached_after_click"
        : hidden
        ? "card_node_hidden_after_click"
        : "card_identity_probe_failed",
      definitively_disappeared: detached || hidden,
      disappearance_kind: detached ? "detached" : hidden ? "hidden_no_layout" : null,
      node_id: positiveNodeId(cardNodeId),
      backend_node_id: backendNodeId,
      candidate_id: null,
      name: null,
      error: error?.message || String(error)
    };
  }
  return readRecommendCardBindingEvidence(client, cardNodeId, cardCandidate);
}

function compactBindingAncestry(ancestry = null) {
  if (!ancestry) return null;
  return {
    verified: ancestry.verified === true,
    reason: ancestry.reason || null,
    method: ancestry.method || null,
    descendant_node_id: positiveNodeId(ancestry.descendant_node_id),
    ancestor_node_id: positiveNodeId(ancestry.ancestor_node_id),
    ancestor_backend_node_id: positiveNodeId(ancestry.ancestor_backend_node_id),
    parent_id_missing: ancestry.parent_id_missing === true,
    parent_id_missing_at_node_id: positiveNodeId(ancestry.parent_id_missing_at_node_id),
    depth: Number.isInteger(ancestry.depth) ? ancestry.depth : null,
    error: ancestry.error || null,
    path: (ancestry.path || []).slice(0, 160).map((item) => ({
      node_id: positiveNodeId(item.node_id),
      backend_node_id: positiveNodeId(item.backend_node_id)
    }))
  };
}

function compactRecommendCardRootMembership(membership = null) {
  if (!membership) return null;
  return {
    verified: membership.verified === true,
    reason: membership.reason || null,
    method: membership.method || null,
    root_scoped: membership.root_scoped === true,
    root_node_id: positiveNodeId(membership.root_node_id),
    expected_root_backend_node_id: positiveNodeId(
      membership.expected_root_backend_node_id
    ),
    expected_iframe_node_id: positiveNodeId(membership.expected_iframe_node_id),
    expected_iframe_backend_node_id: positiveNodeId(
      membership.expected_iframe_backend_node_id
    ),
    expected_linked_document_node_id: positiveNodeId(
      membership.expected_linked_document_node_id
    ),
    expected_card_node_id: positiveNodeId(membership.expected_card_node_id),
    expected_card_backend_node_id: positiveNodeId(
      membership.expected_card_backend_node_id
    ),
    observed_card_backend_node_id: positiveNodeId(
      membership.observed_card_backend_node_id
    ),
    query_count: Number.isInteger(membership.query_count) ? membership.query_count : null,
    valid_query_count: Number.isInteger(membership.valid_query_count)
      ? membership.valid_query_count
      : null,
    exact_frontend_match_count: Number.isInteger(membership.exact_frontend_match_count)
      ? membership.exact_frontend_match_count
      : null,
    exact_backend_match_count: Number.isInteger(membership.exact_backend_match_count)
      ? membership.exact_backend_match_count
      : null,
    queried_nodes: (membership.queried_nodes || []).slice(0, 160).map((item) => ({
      node_id: positiveNodeId(item.node_id),
      backend_node_id: positiveNodeId(item.backend_node_id)
    })),
    recheck: membership.recheck
      ? {
          verified: membership.recheck.verified === true,
          root_node_id: positiveNodeId(membership.recheck.root_node_id),
          expected_root_backend_node_id: positiveNodeId(
            membership.recheck.expected_root_backend_node_id
          ),
          observed_root_backend_node_id: positiveNodeId(
            membership.recheck.observed_root_backend_node_id
          ),
          iframe_node_id: positiveNodeId(membership.recheck.iframe_node_id),
          expected_iframe_backend_node_id: positiveNodeId(
            membership.recheck.expected_iframe_backend_node_id
          ),
          observed_iframe_backend_node_id: positiveNodeId(
            membership.recheck.observed_iframe_backend_node_id
          ),
          expected_linked_document_node_id: positiveNodeId(
            membership.recheck.expected_linked_document_node_id
          ),
          observed_linked_document_node_id: positiveNodeId(
            membership.recheck.observed_linked_document_node_id
          )
        }
      : null,
    card_identity_recheck: membership.card_identity_recheck
      ? {
          verified: membership.card_identity_recheck.verified === true,
          reason: membership.card_identity_recheck.reason || null,
          node_id: positiveNodeId(membership.card_identity_recheck.node_id),
          backend_node_id: positiveNodeId(membership.card_identity_recheck.backend_node_id),
          candidate_id: membership.card_identity_recheck.candidate_id || null,
          name: membership.card_identity_recheck.name || null,
          visible: membership.card_identity_recheck.visible === true
        }
      : null,
    error: membership.error || null
  };
}

function compactRecommendIframePopupMembership(membership = null) {
  if (!membership) return null;
  return {
    verified: membership.verified === true,
    reason: membership.reason || null,
    method: membership.method || null,
    popup_scoped: membership.popup_scoped === true,
    selector: membership.selector || null,
    popup_node_id: positiveNodeId(membership.popup_node_id),
    expected_popup_backend_node_id: positiveNodeId(
      membership.expected_popup_backend_node_id
    ),
    expected_iframe_node_id: positiveNodeId(membership.expected_iframe_node_id),
    expected_iframe_backend_node_id: positiveNodeId(
      membership.expected_iframe_backend_node_id
    ),
    expected_document_node_id: positiveNodeId(membership.expected_document_node_id),
    expected_document_backend_node_id: positiveNodeId(
      membership.expected_document_backend_node_id
    ),
    observed_iframe_backend_node_id: positiveNodeId(
      membership.observed_iframe_backend_node_id
    ),
    query_count: Number.isInteger(membership.query_count) ? membership.query_count : null,
    valid_query_count: Number.isInteger(membership.valid_query_count)
      ? membership.valid_query_count
      : null,
    exact_frontend_match_count: Number.isInteger(membership.exact_frontend_match_count)
      ? membership.exact_frontend_match_count
      : null,
    exact_backend_match_count: Number.isInteger(membership.exact_backend_match_count)
      ? membership.exact_backend_match_count
      : null,
    queried_nodes: (membership.queried_nodes || []).slice(0, 160).map((item) => ({
      node_id: positiveNodeId(item.node_id),
      backend_node_id: positiveNodeId(item.backend_node_id)
    })),
    recheck: membership.recheck
      ? {
          verified: membership.recheck.verified === true,
          popup_node_id: positiveNodeId(membership.recheck.popup_node_id),
          expected_popup_backend_node_id: positiveNodeId(
            membership.recheck.expected_popup_backend_node_id
          ),
          observed_popup_backend_node_id: positiveNodeId(
            membership.recheck.observed_popup_backend_node_id
          ),
          iframe_node_id: positiveNodeId(membership.recheck.iframe_node_id),
          expected_iframe_backend_node_id: positiveNodeId(
            membership.recheck.expected_iframe_backend_node_id
          ),
          observed_iframe_backend_node_id: positiveNodeId(
            membership.recheck.observed_iframe_backend_node_id
          ),
          expected_document_node_id: positiveNodeId(
            membership.recheck.expected_document_node_id
          ),
          observed_document_node_id: positiveNodeId(
            membership.recheck.observed_document_node_id
          ),
          expected_document_backend_node_id: positiveNodeId(
            membership.recheck.expected_document_backend_node_id
          ),
          observed_document_backend_node_id: positiveNodeId(
            membership.recheck.observed_document_backend_node_id
          )
        }
      : null,
    error: membership.error || null
  };
}

function compactRecommendCardPreClickProvenance(provenance = null) {
  if (!provenance) return null;
  return {
    verified: provenance.verified === true,
    reason: provenance.reason || null,
    containment_method: provenance.containment_method || null,
    card: provenance.card
      ? {
          verified: provenance.card.verified === true,
          reason: provenance.card.reason || null,
          node_id: positiveNodeId(provenance.card.node_id),
          backend_node_id: positiveNodeId(provenance.card.backend_node_id),
          candidate_id: provenance.card.candidate_id || null,
          name: provenance.card.name || null,
          visible: provenance.card.visible === true
        }
      : null,
    card_identity_recheck: provenance.card_identity_recheck
      ? {
          verified: provenance.card_identity_recheck.verified === true,
          reason: provenance.card_identity_recheck.reason || null,
          node_id: positiveNodeId(provenance.card_identity_recheck.node_id),
          backend_node_id: positiveNodeId(provenance.card_identity_recheck.backend_node_id),
          candidate_id: provenance.card_identity_recheck.candidate_id || null,
          name: provenance.card_identity_recheck.name || null,
          visible: provenance.card_identity_recheck.visible === true
        }
      : null,
    list_root: provenance.list_root
      ? {
          node_id: positiveNodeId(provenance.list_root.node_id),
          backend_node_id: positiveNodeId(provenance.list_root.backend_node_id),
          iframe_node_id: positiveNodeId(provenance.list_root.iframe_node_id),
          iframe_backend_node_id: positiveNodeId(provenance.list_root.iframe_backend_node_id),
          linked_document_node_id: positiveNodeId(provenance.list_root.linked_document_node_id)
        }
      : null,
    ancestry: compactBindingAncestry(provenance.ancestry),
    root_membership: compactRecommendCardRootMembership(provenance.root_membership)
  };
}

function compactRecommendClickPoint(point = null) {
  if (!point) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  return {
    x: Number.isFinite(x) ? x : null,
    y: Number.isFinite(y) ? y : null,
    mode: point.mode || null,
    attempt_index: Number.isInteger(point.attempt_index) ? point.attempt_index : null,
    hit_test_candidate_index: Number.isInteger(point.hit_test_candidate_index)
      ? point.hit_test_candidate_index
      : null
  };
}

function sameRecommendClickPoint(left = null, right = null) {
  return Boolean(
    left
    && right
    && Number.isFinite(Number(left.x))
    && Number.isFinite(Number(left.y))
    && Number(left.x) === Number(right.x)
    && Number(left.y) === Number(right.y)
  );
}

function compactRecommendCardClickEvidence(evidence = null) {
  if (!evidence) return null;
  const selected = compactRecommendClickPoint(
    evidence?.hit_test?.selected || evidence?.click_target
  );
  const selectedAttempt = (evidence?.hit_test?.attempts || []).find((attempt) => (
    sameRecommendClickPoint(attempt?.point, selected)
  )) || evidence?.hit_test?.selected_attempt || null;
  return {
    verified: evidence.verified === true,
    in_viewport: evidence.in_viewport === true,
    reason: evidence.reason || null,
    node_id: positiveNodeId(evidence.node_id),
    click_target: compactRecommendClickPoint(evidence.click_target),
    viewport: evidence.viewport
      ? {
          width: Number(evidence.viewport.width) || 0,
          height: Number(evidence.viewport.height) || 0,
          margin_px: Number(evidence.viewport.margin_px) || 0,
          source: evidence.viewport.source || null
        }
      : null,
    hit_test: evidence.hit_test
      ? {
          completed: evidence.hit_test.completed === true,
          exact_card_hit_verified: evidence.hit_test.exact_card_hit_verified === true,
          reason: evidence.hit_test.reason || null,
          selected,
          descendant_count: Number(evidence.hit_test.descendant_count) || 0,
          unsafe_descendant_count: Number(evidence.hit_test.unsafe_descendant_count) || 0,
          selected_attempt: selectedAttempt
            ? {
                point: compactRecommendClickPoint(selectedAttempt.point),
                inside_viewport: selectedAttempt.inside_viewport === true,
                exact_card_hit: selectedAttempt.exact_card_hit === true,
                safe_card_hit: selectedAttempt.safe_card_hit === true,
                safe_card_body_hit: selectedAttempt.safe_card_body_hit === true,
                hit_node_id: positiveNodeId(selectedAttempt.hit_node_id),
                hit_node_name: selectedAttempt.hit_node_name || null,
                hit_backend_node_id: positiveNodeId(selectedAttempt.hit_backend_node_id),
                reason: selectedAttempt.reason || null
              }
            : null
        }
      : null
  };
}

function compactRecommendCardClickAttempts(attempts = []) {
  return (Array.isArray(attempts) ? attempts : []).slice(0, 4).map((attempt) => ({
    attempt: Number(attempt?.attempt) || null,
    click_target: compactRecommendClickPoint(attempt?.click_target),
    input_dispatched: attempt?.input_dispatched === true,
    outcome: attempt?.outcome || null,
    elapsed_ms: Number.isFinite(Number(attempt?.elapsed_ms))
      ? Math.max(0, Number(attempt.elapsed_ms))
      : null
  }));
}

function appendCumulativeRecommendCardClickAttempts(target = [], attempts = []) {
  for (const attempt of compactRecommendCardClickAttempts(attempts)) {
    target.push({
      ...attempt,
      attempt: target.length + 1
    });
  }
  return target;
}

async function readExactDescendantAncestry(client, descendantNodeId, ancestorNodeId, {
  maxDepth = 160
} = {}) {
  const descendant = positiveNodeId(descendantNodeId);
  const ancestor = positiveNodeId(ancestorNodeId);
  if (!descendant || !ancestor || descendant === ancestor) {
    return {
      verified: false,
      reason: "detail_iframe_ancestry_identity_missing",
      method: "parent_ancestry",
      descendant_node_id: descendant,
      ancestor_node_id: ancestor,
      path: []
    };
  }
  const path = [];
  const seen = new Set();
  let currentNodeId = descendant;
  try {
    for (let depth = 0; depth < maxDepth; depth += 1) {
      if (seen.has(currentNodeId)) break;
      seen.add(currentNodeId);
      const described = await describeNode(client, currentNodeId, { depth: 0, pierce: true });
      const backendNodeId = positiveNodeId(described?.backendNodeId);
      const parentNodeId = positiveNodeId(described?.parentId);
      if (!backendNodeId) {
        return {
          verified: false,
          reason: "detail_iframe_ancestry_backend_missing",
          method: "parent_ancestry",
          descendant_node_id: descendant,
          ancestor_node_id: ancestor,
          path
        };
      }
      path.push({
        node_id: currentNodeId,
        backend_node_id: backendNodeId
      });
      if (parentNodeId === ancestor) {
        const ancestorNode = await describeNode(client, ancestor, { depth: 0, pierce: true });
        const ancestorBackendNodeId = positiveNodeId(ancestorNode?.backendNodeId);
        if (!ancestorBackendNodeId) {
          return {
            verified: false,
            reason: "detail_iframe_container_backend_missing",
            method: "parent_ancestry",
            descendant_node_id: descendant,
            ancestor_node_id: ancestor,
            path
          };
        }
        path.push({
          node_id: ancestor,
          backend_node_id: ancestorBackendNodeId
        });
        return {
          verified: true,
          reason: null,
          method: "parent_ancestry",
          descendant_node_id: descendant,
          ancestor_node_id: ancestor,
          ancestor_backend_node_id: ancestorBackendNodeId,
          depth: path.length - 1,
          path
        };
      }
      if (!parentNodeId) {
        return {
          verified: false,
          reason: "detail_iframe_ancestry_parent_missing",
          method: "parent_ancestry",
          descendant_node_id: descendant,
          ancestor_node_id: ancestor,
          parent_id_missing: true,
          parent_id_missing_at_node_id: currentNodeId,
          path
        };
      }
      currentNodeId = parentNodeId;
    }
  } catch (error) {
    if (shouldRethrowRecommendProtocolError(error)) throw error;
    return {
      verified: false,
      reason: "detail_iframe_ancestry_read_failed",
      method: "parent_ancestry",
      descendant_node_id: descendant,
      ancestor_node_id: ancestor,
      path,
      error: error?.message || String(error)
    };
  }
  return {
    verified: false,
    reason: "detail_iframe_not_contained_by_popup",
    method: "parent_ancestry",
    descendant_node_id: descendant,
    ancestor_node_id: ancestor,
    path
  };
}

async function readExactRecommendCardRootMembership(client, {
  cardNodeId,
  cardBackendNodeId,
  cardCandidate,
  listRootNodeId,
  listRootBackendNodeId,
  iframeNodeId,
  iframeBackendNodeId,
  linkedDocumentNodeId
} = {}) {
  const expectedCardNodeId = positiveNodeId(cardNodeId);
  const expectedCardBackendNodeId = positiveNodeId(cardBackendNodeId);
  const expectedRootNodeId = positiveNodeId(listRootNodeId);
  const expectedRootBackendNodeId = positiveNodeId(listRootBackendNodeId);
  const expectedIframeNodeId = positiveNodeId(iframeNodeId);
  const expectedIframeBackendNodeId = positiveNodeId(iframeBackendNodeId);
  const expectedLinkedDocumentNodeId = positiveNodeId(linkedDocumentNodeId);
  const base = {
    verified: false,
    reason: null,
    method: "root_scoped_exact_card_identity",
    root_scoped: true,
    root_node_id: expectedRootNodeId,
    expected_root_backend_node_id: expectedRootBackendNodeId,
    expected_iframe_node_id: expectedIframeNodeId,
    expected_iframe_backend_node_id: expectedIframeBackendNodeId,
    expected_linked_document_node_id: expectedLinkedDocumentNodeId,
    expected_card_node_id: expectedCardNodeId,
    expected_card_backend_node_id: expectedCardBackendNodeId,
    observed_card_backend_node_id: null,
    query_count: null,
    valid_query_count: null,
    exact_frontend_match_count: null,
    exact_backend_match_count: null,
    queried_nodes: [],
    recheck: null,
    card_identity_recheck: null
  };
  if (
    !expectedCardNodeId
    || !expectedCardBackendNodeId
    || !expectedRootNodeId
    || !expectedRootBackendNodeId
    || !expectedIframeNodeId
    || !expectedIframeBackendNodeId
    || expectedLinkedDocumentNodeId !== expectedRootNodeId
  ) {
    return {
      ...base,
      reason: "card_list_root_membership_identity_missing"
    };
  }

  let rawNodeIds;
  try {
    rawNodeIds = await findRecommendCardNodeIds(client, expectedLinkedDocumentNodeId);
  } catch (error) {
    if (shouldRethrowRecommendProtocolError(error)) throw error;
    return {
      ...base,
      reason: "card_list_root_query_failed",
      error: error?.message || String(error)
    };
  }
  const normalizedNodeIds = (rawNodeIds || []).map(positiveNodeId);
  const queryEvidence = {
    query_count: normalizedNodeIds.length,
    valid_query_count: normalizedNodeIds.filter(Boolean).length,
    exact_frontend_match_count: normalizedNodeIds.filter(
      (nodeId) => nodeId === expectedCardNodeId
    ).length
  };
  if (queryEvidence.valid_query_count !== queryEvidence.query_count) {
    return {
      ...base,
      ...queryEvidence,
      reason: "card_list_root_query_invalid_node_id"
    };
  }
  if (queryEvidence.exact_frontend_match_count === 0) {
    return {
      ...base,
      ...queryEvidence,
      reason: "card_list_root_frontend_match_missing"
    };
  }
  if (queryEvidence.exact_frontend_match_count !== 1) {
    return {
      ...base,
      ...queryEvidence,
      reason: "card_list_root_frontend_match_ambiguous"
    };
  }

  const queriedNodes = [];
  try {
    for (const nodeId of normalizedNodeIds) {
      const described = await describeNode(client, nodeId, { depth: 0, pierce: true });
      const backendNodeId = positiveNodeId(described?.backendNodeId);
      if (!backendNodeId) throw new Error(`Missing backendNodeId for recommend card node ${nodeId}`);
      queriedNodes.push({
        node_id: nodeId,
        backend_node_id: backendNodeId
      });
    }
  } catch (error) {
    if (shouldRethrowRecommendProtocolError(error)) throw error;
    return {
      ...base,
      ...queryEvidence,
      queried_nodes: queriedNodes,
      reason: "card_list_root_node_describe_failed",
      error: error?.message || String(error)
    };
  }
  const observedCardBackendNodeId = positiveNodeId(
    queriedNodes.find((item) => item.node_id === expectedCardNodeId)?.backend_node_id
  );
  const exactBackendMatchCount = queriedNodes.filter(
    (item) => item.backend_node_id === expectedCardBackendNodeId
  ).length;
  const identityEvidence = {
    ...queryEvidence,
    queried_nodes: queriedNodes,
    observed_card_backend_node_id: observedCardBackendNodeId,
    exact_backend_match_count: exactBackendMatchCount
  };
  if (observedCardBackendNodeId !== expectedCardBackendNodeId) {
    return {
      ...base,
      ...identityEvidence,
      reason: "card_list_root_card_backend_mismatch"
    };
  }
  if (exactBackendMatchCount !== 1) {
    return {
      ...base,
      ...identityEvidence,
      reason: "card_list_root_backend_match_ambiguous"
    };
  }

  let observedRootBackendNodeId = null;
  let observedIframeBackendNodeId = null;
  let observedLinkedDocumentNodeId = null;
  try {
    const rootNode = await describeNode(client, expectedRootNodeId, { depth: 0, pierce: true });
    observedRootBackendNodeId = positiveNodeId(rootNode?.backendNodeId);
    const iframeNode = await describeNode(client, expectedIframeNodeId, { depth: 0, pierce: true });
    observedIframeBackendNodeId = positiveNodeId(iframeNode?.backendNodeId);
    observedLinkedDocumentNodeId = positiveNodeId(
      await getFrameDocumentNodeId(client, expectedIframeNodeId)
    );
  } catch (error) {
    if (shouldRethrowRecommendProtocolError(error)) throw error;
    return {
      ...base,
      ...identityEvidence,
      reason: "card_list_root_recheck_failed",
      recheck: {
        verified: false,
        root_node_id: expectedRootNodeId,
        expected_root_backend_node_id: expectedRootBackendNodeId,
        observed_root_backend_node_id: observedRootBackendNodeId,
        iframe_node_id: expectedIframeNodeId,
        expected_iframe_backend_node_id: expectedIframeBackendNodeId,
        observed_iframe_backend_node_id: observedIframeBackendNodeId,
        expected_linked_document_node_id: expectedLinkedDocumentNodeId,
        observed_linked_document_node_id: observedLinkedDocumentNodeId
      },
      error: error?.message || String(error)
    };
  }
  const recheck = {
    verified: Boolean(
      observedRootBackendNodeId === expectedRootBackendNodeId
      && observedIframeBackendNodeId === expectedIframeBackendNodeId
      && observedLinkedDocumentNodeId === expectedLinkedDocumentNodeId
    ),
    root_node_id: expectedRootNodeId,
    expected_root_backend_node_id: expectedRootBackendNodeId,
    observed_root_backend_node_id: observedRootBackendNodeId,
    iframe_node_id: expectedIframeNodeId,
    expected_iframe_backend_node_id: expectedIframeBackendNodeId,
    observed_iframe_backend_node_id: observedIframeBackendNodeId,
    expected_linked_document_node_id: expectedLinkedDocumentNodeId,
    observed_linked_document_node_id: observedLinkedDocumentNodeId
  };
  const recheckReason = observedRootBackendNodeId !== expectedRootBackendNodeId
    ? "card_list_root_backend_drift"
    : observedIframeBackendNodeId !== expectedIframeBackendNodeId
    ? "card_iframe_backend_drift"
    : observedLinkedDocumentNodeId !== expectedLinkedDocumentNodeId
    ? "card_iframe_document_link_drift"
    : null;
  if (!recheck.verified) {
    return {
      ...base,
      ...identityEvidence,
      verified: false,
      reason: recheckReason,
      recheck
    };
  }
  const cardIdentityRecheck = await readRecommendCardBindingEvidence(
    client,
    expectedCardNodeId,
    cardCandidate
  );
  const cardIdentityRecheckVerified = Boolean(
    cardIdentityRecheck?.verified === true
    && positiveNodeId(cardIdentityRecheck?.backend_node_id) === expectedCardBackendNodeId
  );
  return {
    ...base,
    ...identityEvidence,
    verified: cardIdentityRecheckVerified,
    reason: cardIdentityRecheckVerified
      ? null
      : positiveNodeId(cardIdentityRecheck?.backend_node_id) !== expectedCardBackendNodeId
      ? "card_list_root_card_backend_recheck_mismatch"
      : "card_list_root_card_identity_recheck_failed",
    recheck,
    card_identity_recheck: cardIdentityRecheck
  };
}

async function readExactRecommendIframePopupMembership(client, {
  selector,
  popupNodeId,
  popupBackendNodeId,
  iframeNodeId,
  iframeBackendNodeId,
  documentNodeId,
  documentBackendNodeId
} = {}) {
  const exactSelector = String(selector || "").trim();
  const expectedPopupNodeId = positiveNodeId(popupNodeId);
  const expectedPopupBackendNodeId = positiveNodeId(popupBackendNodeId);
  const expectedIframeNodeId = positiveNodeId(iframeNodeId);
  const expectedIframeBackendNodeId = positiveNodeId(iframeBackendNodeId);
  const expectedDocumentNodeId = positiveNodeId(documentNodeId);
  const expectedDocumentBackendNodeId = positiveNodeId(documentBackendNodeId);
  const base = {
    verified: false,
    reason: null,
    method: "popup_scoped_exact_resume_iframe_identity",
    popup_scoped: true,
    selector: exactSelector || null,
    popup_node_id: expectedPopupNodeId,
    expected_popup_backend_node_id: expectedPopupBackendNodeId,
    expected_iframe_node_id: expectedIframeNodeId,
    expected_iframe_backend_node_id: expectedIframeBackendNodeId,
    expected_document_node_id: expectedDocumentNodeId,
    expected_document_backend_node_id: expectedDocumentBackendNodeId,
    observed_iframe_backend_node_id: null,
    query_count: null,
    valid_query_count: null,
    exact_frontend_match_count: null,
    exact_backend_match_count: null,
    queried_nodes: [],
    recheck: null
  };
  if (
    !exactSelector
    || !expectedPopupNodeId
    || !expectedPopupBackendNodeId
    || !expectedIframeNodeId
    || !expectedIframeBackendNodeId
    || !expectedDocumentNodeId
    || !expectedDocumentBackendNodeId
  ) {
    return {
      ...base,
      reason: "detail_iframe_popup_membership_identity_missing"
    };
  }

  let rawNodeIds;
  try {
    rawNodeIds = await querySelectorAll(client, expectedPopupNodeId, exactSelector);
  } catch (error) {
    return {
      ...base,
      reason: "detail_iframe_popup_query_failed",
      error: error?.message || String(error)
    };
  }
  const normalizedNodeIds = (rawNodeIds || []).map(positiveNodeId);
  const queryEvidence = {
    query_count: normalizedNodeIds.length,
    valid_query_count: normalizedNodeIds.filter(Boolean).length,
    exact_frontend_match_count: normalizedNodeIds.filter(
      (nodeId) => nodeId === expectedIframeNodeId
    ).length
  };
  if (queryEvidence.valid_query_count !== queryEvidence.query_count) {
    return {
      ...base,
      ...queryEvidence,
      reason: "detail_iframe_popup_query_invalid_node_id"
    };
  }
  if (queryEvidence.exact_frontend_match_count === 0) {
    return {
      ...base,
      ...queryEvidence,
      reason: "detail_iframe_popup_frontend_match_missing"
    };
  }
  if (queryEvidence.exact_frontend_match_count !== 1) {
    return {
      ...base,
      ...queryEvidence,
      reason: "detail_iframe_popup_frontend_match_ambiguous"
    };
  }

  const queriedNodes = [];
  try {
    for (const nodeId of normalizedNodeIds) {
      const described = await describeNode(client, nodeId, { depth: 0, pierce: true });
      const backendNodeId = positiveNodeId(described?.backendNodeId);
      if (!backendNodeId) throw new Error(`Missing backendNodeId for resume iframe node ${nodeId}`);
      queriedNodes.push({
        node_id: nodeId,
        backend_node_id: backendNodeId
      });
    }
  } catch (error) {
    return {
      ...base,
      ...queryEvidence,
      queried_nodes: queriedNodes,
      reason: "detail_iframe_popup_node_describe_failed",
      error: error?.message || String(error)
    };
  }
  const observedIframeBackendNodeId = positiveNodeId(
    queriedNodes.find((item) => item.node_id === expectedIframeNodeId)?.backend_node_id
  );
  const exactBackendMatchCount = queriedNodes.filter(
    (item) => item.backend_node_id === expectedIframeBackendNodeId
  ).length;
  const identityEvidence = {
    ...queryEvidence,
    queried_nodes: queriedNodes,
    observed_iframe_backend_node_id: observedIframeBackendNodeId,
    exact_backend_match_count: exactBackendMatchCount
  };
  if (observedIframeBackendNodeId !== expectedIframeBackendNodeId) {
    return {
      ...base,
      ...identityEvidence,
      reason: "detail_iframe_popup_backend_mismatch"
    };
  }
  if (exactBackendMatchCount !== 1) {
    return {
      ...base,
      ...identityEvidence,
      reason: "detail_iframe_popup_backend_match_ambiguous"
    };
  }

  let observedPopupBackendNodeId = null;
  let observedRecheckIframeBackendNodeId = null;
  let observedDocumentNodeId = null;
  let observedDocumentBackendNodeId = null;
  try {
    const popupNode = await describeNode(client, expectedPopupNodeId, {
      depth: 0,
      pierce: true
    });
    observedPopupBackendNodeId = positiveNodeId(popupNode?.backendNodeId);
    const iframeNode = await describeNode(client, expectedIframeNodeId, {
      depth: 0,
      pierce: true
    });
    observedRecheckIframeBackendNodeId = positiveNodeId(iframeNode?.backendNodeId);
    observedDocumentNodeId = positiveNodeId(
      await getFrameDocumentNodeId(client, expectedIframeNodeId)
    );
    const documentNode = observedDocumentNodeId
      ? await describeNode(client, observedDocumentNodeId, { depth: 0, pierce: true })
      : null;
    observedDocumentBackendNodeId = positiveNodeId(documentNode?.backendNodeId);
  } catch (error) {
    return {
      ...base,
      ...identityEvidence,
      reason: "detail_iframe_popup_recheck_failed",
      recheck: {
        verified: false,
        popup_node_id: expectedPopupNodeId,
        expected_popup_backend_node_id: expectedPopupBackendNodeId,
        observed_popup_backend_node_id: observedPopupBackendNodeId,
        iframe_node_id: expectedIframeNodeId,
        expected_iframe_backend_node_id: expectedIframeBackendNodeId,
        observed_iframe_backend_node_id: observedRecheckIframeBackendNodeId,
        expected_document_node_id: expectedDocumentNodeId,
        observed_document_node_id: observedDocumentNodeId,
        expected_document_backend_node_id: expectedDocumentBackendNodeId,
        observed_document_backend_node_id: observedDocumentBackendNodeId
      },
      error: error?.message || String(error)
    };
  }
  const recheck = {
    verified: Boolean(
      observedPopupBackendNodeId === expectedPopupBackendNodeId
      && observedRecheckIframeBackendNodeId === expectedIframeBackendNodeId
      && observedDocumentNodeId === expectedDocumentNodeId
      && observedDocumentBackendNodeId === expectedDocumentBackendNodeId
    ),
    popup_node_id: expectedPopupNodeId,
    expected_popup_backend_node_id: expectedPopupBackendNodeId,
    observed_popup_backend_node_id: observedPopupBackendNodeId,
    iframe_node_id: expectedIframeNodeId,
    expected_iframe_backend_node_id: expectedIframeBackendNodeId,
    observed_iframe_backend_node_id: observedRecheckIframeBackendNodeId,
    expected_document_node_id: expectedDocumentNodeId,
    observed_document_node_id: observedDocumentNodeId,
    expected_document_backend_node_id: expectedDocumentBackendNodeId,
    observed_document_backend_node_id: observedDocumentBackendNodeId
  };
  const reason = observedPopupBackendNodeId !== expectedPopupBackendNodeId
    ? "detail_iframe_popup_backend_drift"
    : observedRecheckIframeBackendNodeId !== expectedIframeBackendNodeId
    ? "detail_iframe_backend_drift"
    : observedDocumentNodeId !== expectedDocumentNodeId
    ? "detail_iframe_document_link_drift"
    : observedDocumentBackendNodeId !== expectedDocumentBackendNodeId
    ? "detail_iframe_document_backend_drift"
    : null;
  return {
    ...base,
    ...identityEvidence,
    verified: recheck.verified,
    reason,
    recheck
  };
}

export async function readRecommendCardPreClickProvenance(client, {
  cardNodeId,
  cardCandidate,
  rootState = null,
  cardEvidence = null
} = {}) {
  const currentRootState = rootState?.iframe?.documentNodeId
    ? rootState
    : await getRecommendRoots(client);
  const card = cardEvidence || await readRecommendCardBindingEvidence(
    client,
    cardNodeId,
    cardCandidate
  );
  const listRootNodeId = positiveNodeId(currentRootState?.iframe?.documentNodeId);
  const iframeNodeId = positiveNodeId(currentRootState?.iframe?.nodeId);
  let listRootBackendNodeId = null;
  let iframeBackendNodeId = null;
  let linkedDocumentNodeId = null;
  try {
    const listRootNode = listRootNodeId
      ? await describeNode(client, listRootNodeId, { depth: 0, pierce: true })
      : null;
    listRootBackendNodeId = positiveNodeId(listRootNode?.backendNodeId);
    const iframeNode = iframeNodeId
      ? await describeNode(client, iframeNodeId, { depth: 0, pierce: true })
      : null;
    iframeBackendNodeId = positiveNodeId(iframeNode?.backendNodeId);
    linkedDocumentNodeId = iframeNodeId
      ? positiveNodeId(await getFrameDocumentNodeId(client, iframeNodeId))
      : null;
  } catch (error) {
    if (shouldRethrowRecommendProtocolError(error)) throw error;
    // The exact root requirements below fail closed with compact evidence.
  }
  const ancestry = listRootNodeId
    ? await readExactDescendantAncestry(client, cardNodeId, listRootNodeId)
    : null;
  const rootMembership = Boolean(
    card?.verified === true
    && listRootNodeId
    && listRootBackendNodeId
    && iframeNodeId
    && iframeBackendNodeId
    && linkedDocumentNodeId === listRootNodeId
    && ancestry?.verified !== true
    && ancestry?.parent_id_missing === true
  )
    ? await readExactRecommendCardRootMembership(client, {
      cardNodeId,
      cardBackendNodeId: card?.backend_node_id,
      cardCandidate,
        listRootNodeId,
        listRootBackendNodeId,
        iframeNodeId,
        iframeBackendNodeId,
        linkedDocumentNodeId
      })
    : null;
  const containmentVerified = Boolean(
    ancestry?.verified === true
    && positiveNodeId(ancestry.ancestor_backend_node_id) === listRootBackendNodeId
  ) || rootMembership?.verified === true;
  const verified = Boolean(
    card?.verified === true
    && listRootNodeId
    && listRootBackendNodeId
    && iframeNodeId
    && iframeBackendNodeId
    && linkedDocumentNodeId === listRootNodeId
    && containmentVerified
  );
  return {
    verified,
    reason: verified
      ? null
      : card?.verified !== true
      ? card?.reason || "card_identity_not_verified_before_click"
      : !listRootNodeId || !listRootBackendNodeId || !iframeNodeId || !iframeBackendNodeId
      ? "card_list_root_provenance_missing"
      : linkedDocumentNodeId !== listRootNodeId
      ? "card_iframe_document_link_mismatch"
      : rootMembership?.reason || ancestry?.reason || "card_not_bound_to_recommend_list_root",
    containment_method: ancestry?.verified === true
      ? "parent_ancestry"
      : rootMembership?.verified === true
      ? rootMembership.method
      : null,
    card,
    list_root: {
      node_id: listRootNodeId,
      backend_node_id: listRootBackendNodeId,
      iframe_node_id: iframeNodeId,
      iframe_backend_node_id: iframeBackendNodeId,
      linked_document_node_id: linkedDocumentNodeId
    },
    ancestry,
    root_membership: rootMembership
  };
}

async function resolveRecommendDetailBindingScopes(client, detailState = null) {
  const scopes = [];
  const ignoredScopes = [];
  const popupNodeIds = new Set();
  if (positiveNodeId(detailState?.popup?.node_id)) popupNodeIds.add(detailState.popup.node_id);
  if (detailState?.popup?.selector && Array.isArray(detailState?.roots)) {
    for (const root of detailState.roots) {
      if (!positiveNodeId(root?.nodeId)) continue;
      try {
        for (const nodeId of await querySelectorAll(client, root.nodeId, detailState.popup.selector)) {
          if (positiveNodeId(nodeId)) popupNodeIds.add(nodeId);
        }
      } catch (error) {
        if (shouldRethrowRecommendProtocolError(error)) throw error;
        ignoredScopes.push({
          source: "popup",
          selector: detailState.popup.selector,
          root_node_id: positiveNodeId(root.nodeId),
          visible: false,
          stale: isStaleRecommendNodeError(error),
          reason: "detail_popup_selector_query_failed",
          error: error?.message || String(error)
        });
      }
    }
  }
  for (const nodeId of popupNodeIds) {
    const rootEvidence = await readVisibleBackendNode(client, nodeId);
    if (rootEvidence) {
      scopes.push({
        source: "popup",
        node_id: rootEvidence.node_id,
        backend_node_id: rootEvidence.backend_node_id,
        visible: true
      });
    } else {
      ignoredScopes.push({
        source: "popup",
        node_id: positiveNodeId(nodeId),
        backend_node_id: null,
        visible: false,
        stale: true
      });
    }
  }

  const resumeIframeNodeIds = new Set();
  if (positiveNodeId(detailState?.resumeIframe?.node_id)) {
    resumeIframeNodeIds.add(detailState.resumeIframe.node_id);
  }
  if (detailState?.resumeIframe?.selector && Array.isArray(detailState?.roots)) {
    for (const root of detailState.roots) {
      if (!positiveNodeId(root?.nodeId)) continue;
      try {
        for (const nodeId of await querySelectorAll(
          client,
          root.nodeId,
          detailState.resumeIframe.selector
        )) {
          if (positiveNodeId(nodeId)) resumeIframeNodeIds.add(nodeId);
        }
      } catch (error) {
        if (shouldRethrowRecommendProtocolError(error)) throw error;
        ignoredScopes.push({
          source: "resume_iframe",
          selector: detailState.resumeIframe.selector,
          root_node_id: positiveNodeId(root.nodeId),
          visible: false,
          stale: isStaleRecommendNodeError(error),
          reason: "detail_resume_iframe_selector_query_failed",
          error: error?.message || String(error)
        });
      }
    }
  }
  for (const iframeNodeId of resumeIframeNodeIds) {
    try {
      const iframeEvidence = await readVisibleBackendNode(client, iframeNodeId);
      const documentNodeId = await getFrameDocumentNodeId(client, iframeNodeId);
      const documentNode = await describeNode(client, documentNodeId, { depth: 0, pierce: true });
      const documentBackendNodeId = positiveNodeId(documentNode?.backendNodeId);
      if (iframeEvidence && documentBackendNodeId) {
        const visiblePopups = scopes.filter((scope) => scope.source === "popup");
        const containerChecks = [];
        for (const popup of visiblePopups) {
          const ancestry = await readExactDescendantAncestry(
            client,
            iframeEvidence.node_id,
            popup.node_id
          );
          const membership = Boolean(
            ancestry?.verified !== true
            && ancestry?.parent_id_missing === true
            && detailState?.resumeIframe?.selector
          )
            ? await readExactRecommendIframePopupMembership(client, {
                selector: detailState.resumeIframe.selector,
                popupNodeId: popup.node_id,
                popupBackendNodeId: popup.backend_node_id,
                iframeNodeId: iframeEvidence.node_id,
                iframeBackendNodeId: iframeEvidence.backend_node_id,
                documentNodeId,
                documentBackendNodeId
              })
            : null;
          const verified = Boolean(
            ancestry?.verified === true
            && positiveNodeId(ancestry.ancestor_backend_node_id)
              === positiveNodeId(popup.backend_node_id)
          ) || membership?.verified === true;
          containerChecks.push({
            verified,
            method: ancestry?.verified === true
              ? "parent_ancestry"
              : membership?.verified === true
              ? membership.method
              : null,
            ancestry,
            membership
          });
        }
        const verifiedContainerIndexes = containerChecks
          .map((item, index) => (item.verified === true ? index : -1))
          .filter((index) => index >= 0);
        const container = verifiedContainerIndexes.length === 1
          ? visiblePopups[verifiedContainerIndexes[0]]
          : null;
        const selectedCheck = verifiedContainerIndexes.length === 1
          ? containerChecks[verifiedContainerIndexes[0]]
          : containerChecks[0] || null;
        scopes.push({
          source: "resume_iframe",
          selector: detailState?.resumeIframe?.selector || null,
          node_id: documentNodeId,
          backend_node_id: documentBackendNodeId,
          iframe_node_id: iframeEvidence.node_id,
          iframe_backend_node_id: iframeEvidence.backend_node_id,
          container_node_id: positiveNodeId(container?.node_id),
          container_backend_node_id: positiveNodeId(container?.backend_node_id),
          container_verified: visiblePopups.length === 0
            ? null
            : verifiedContainerIndexes.length === 1,
          container_match_count: verifiedContainerIndexes.length,
          containment_method: verifiedContainerIndexes.length === 1
            ? selectedCheck?.method || null
            : null,
          container_membership: selectedCheck?.membership || null,
          ancestry: selectedCheck?.ancestry?.verified === true
            ? {
                verified: true,
                method: "parent_ancestry",
                depth: selectedCheck.ancestry.depth,
                path: selectedCheck.ancestry.path
              }
            : {
                verified: false,
                reason: verifiedContainerIndexes.length > 1
                  ? "detail_iframe_container_ambiguous"
                  : selectedCheck?.membership?.reason
                    || selectedCheck?.ancestry?.reason
                    || "detail_iframe_not_contained_by_popup",
                method: selectedCheck?.ancestry?.method || "parent_ancestry",
                parent_id_missing: selectedCheck?.ancestry?.parent_id_missing === true,
                parent_id_missing_at_node_id: positiveNodeId(
                  selectedCheck?.ancestry?.parent_id_missing_at_node_id
                ),
                path: selectedCheck?.ancestry?.path || []
              },
          visible: true
        });
      } else {
        ignoredScopes.push({
          source: "resume_iframe",
          node_id: positiveNodeId(documentNodeId),
          backend_node_id: documentBackendNodeId,
          iframe_node_id: positiveNodeId(iframeNodeId),
          iframe_backend_node_id: positiveNodeId(iframeEvidence?.backend_node_id),
          visible: false,
          stale: true
        });
      }
    } catch (error) {
      if (shouldRethrowRecommendProtocolError(error)) throw error;
      ignoredScopes.push({
        source: "resume_iframe",
        selector: detailState?.resumeIframe?.selector || null,
        node_id: null,
        backend_node_id: null,
        iframe_node_id: positiveNodeId(iframeNodeId),
        iframe_backend_node_id: null,
        visible: false,
        stale: isStaleRecommendNodeError(error),
        reason: "detail_resume_iframe_scope_read_failed",
        error: error?.message || String(error)
      });
    }
  }
  return { scopes, ignored_scopes: ignoredScopes };
}

function compactRecommendDetailRootSnapshotScope(scope = null) {
  if (!scope) return null;
  return {
    source: scope.source || null,
    selector: scope.selector || null,
    root_node_id: positiveNodeId(scope.root_node_id),
    node_id: positiveNodeId(scope.node_id),
    backend_node_id: positiveNodeId(scope.backend_node_id),
    iframe_node_id: positiveNodeId(scope.iframe_node_id),
    iframe_backend_node_id: positiveNodeId(scope.iframe_backend_node_id),
    visible: scope.visible === true,
    stale: scope.stale === true,
    reason: scope.reason || null,
    error: scope.error || null
  };
}

function compactRecommendDetailRootsBeforeSnapshot(snapshot = null) {
  if (Array.isArray(snapshot)) {
    return {
      schema_version: 1,
      captured: true,
      // Legacy arrays omitted ignored/unread-root evidence.  They may support
      // the older DOM identity methods, but never authorize causal binding.
      complete: false,
      roots: snapshot.map(compactRecommendDetailRootSnapshotScope).filter(Boolean),
      ignored_scopes: [],
      legacy_array: true
    };
  }
  return {
    schema_version: 1,
    captured: snapshot?.captured === true,
    complete: snapshot?.complete === true,
    roots: (snapshot?.roots || [])
      .map(compactRecommendDetailRootSnapshotScope)
      .filter(Boolean),
    ignored_scopes: (snapshot?.ignored_scopes || [])
      .map(compactRecommendDetailRootSnapshotScope)
      .filter(Boolean),
    legacy_array: snapshot?.legacy_array === true
  };
}

async function readRecommendDetailRootsBeforeClick(client, {
  rootState = null
} = {}) {
  const state = await readRecommendDetailState(client, { rootState });
  const resolved = await resolveRecommendDetailBindingScopes(client, state);
  const roots = (resolved.scopes || [])
    .filter((scope) => scope.visible === true)
    .map(compactRecommendDetailRootSnapshotScope)
    .filter(Boolean);
  const ignoredScopes = (resolved.ignored_scopes || [])
    .map(compactRecommendDetailRootSnapshotScope)
    .filter(Boolean);
  return {
    schema_version: 1,
    captured: true,
    complete: ignoredScopes.length === 0,
    roots,
    ignored_scopes: ignoredScopes
  };
}

async function readDetailCandidateIds(client, scope) {
  const probe = {
    source: scope?.source || null,
    scope_node_id: positiveNodeId(scope?.node_id),
    scope_backend_node_id: positiveNodeId(scope?.backend_node_id),
    complete: true,
    queried_node_count: 0,
    attribute_read_count: 0,
    unread_nodes: []
  };
  if (scope?.visible !== true || !positiveNodeId(scope?.node_id)) {
    return { evidence: [], probe: { ...probe, complete: false } };
  }
  // A resume-iframe scope is its document node, which cannot carry element
  // attributes.  Candidate-id descendants are still queried below.
  const nodeIds = new Set(scope.source === "popup" ? [scope.node_id] : []);
  for (const nodeId of await querySelectorAll(client, scope.node_id, DETAIL_CANDIDATE_ID_SELECTOR)) {
    nodeIds.add(nodeId);
  }
  probe.queried_node_count = nodeIds.size;
  const evidence = [];
  for (const nodeId of nodeIds) {
    let attributes;
    try {
      attributes = await getAttributesMap(client, nodeId);
      probe.attribute_read_count += 1;
    } catch (error) {
      if (shouldRethrowRecommendProtocolError(error)) throw error;
      probe.complete = false;
      probe.unread_nodes.push({
        node_id: positiveNodeId(nodeId),
        reason: "candidate_id_attributes_unreadable",
        error: error?.message || String(error)
      });
      continue;
    }
    const visible = nodeId === scope.node_id
      ? {
          node_id: scope.node_id,
          backend_node_id: scope.backend_node_id,
          visible: true
        }
      : await readVisibleBackendNode(client, nodeId);
    if (!visible) {
      probe.complete = false;
      probe.unread_nodes.push({
        node_id: positiveNodeId(nodeId),
        reason: "candidate_id_node_not_visible_or_stale",
        error: null
      });
      continue;
    }
    for (const attribute of DETAIL_CANDIDATE_ID_ATTRIBUTES) {
      const value = normalizeBindingText(attributes[attribute]);
      if (!value) continue;
      evidence.push({
        source: scope.source,
        field: attribute,
        value,
        node_id: visible.node_id,
        backend_node_id: visible.backend_node_id,
        visible: true,
        accessibility_verified: false
      });
    }
  }
  return { evidence, probe };
}

async function readDetailExactIdentityMatches(client, scope, expectedValues = [], {
  allowScroll = true
} = {}) {
  const probe = {
    source: scope?.source || null,
    scope_node_id: positiveNodeId(scope?.node_id),
    scope_backend_node_id: positiveNodeId(scope?.backend_node_id),
    scoped_node_count: 0,
    html_read_count: 0,
    exact_dom_text_count: 0,
    visible_exact_dom_text_count: 0,
    ax_exact_count: 0,
    ax_rejected_count: 0,
    selector_queries: [],
    fields: {}
  };
  for (const item of expectedValues) {
    probe.fields[item.field] = {
      value: item.value,
      exact_dom_text_count: 0,
      visible_exact_dom_text_count: 0,
      ax_exact_count: 0,
      ax_rejected_count: 0
    };
  }
  if (scope?.visible !== true || !positiveNodeId(scope?.node_id)) {
    return { matches: [], probe };
  }
  const expectedByValue = new Map(expectedValues.map((item) => [item.value, item]));
  const matches = [];
  const seenNodeIds = new Set();
  for (const selector of [DETAIL_IDENTITY_PRIORITY_SELECTOR, DETAIL_IDENTITY_TEXT_SELECTOR]) {
    const nodeIds = await querySelectorAll(client, scope.node_id, selector);
    const queryProbe = {
      selector,
      raw_node_count: nodeIds.length,
      unique_node_count: 0
    };
    probe.selector_queries.push(queryProbe);
    for (const nodeId of nodeIds.slice(0, selector === DETAIL_IDENTITY_PRIORITY_SELECTOR ? 160 : 1200)) {
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);
      queryProbe.unique_node_count += 1;
      probe.scoped_node_count += 1;
      let text = "";
      try {
        text = normalizeBindingText(htmlToText(await getOuterHTML(client, nodeId)));
        probe.html_read_count += 1;
      } catch (error) {
        if (shouldRethrowRecommendProtocolError(error)) throw error;
        continue;
      }
      const expected = expectedByValue.get(text);
      if (!expected) continue;
      const fieldProbe = probe.fields[expected.field];
      probe.exact_dom_text_count += 1;
      if (fieldProbe) fieldProbe.exact_dom_text_count += 1;
      if (allowScroll) {
        try {
          await scrollNodeIntoView(client, nodeId);
          await sleep(40);
        } catch (error) {
          if (shouldRethrowRecommendProtocolError(error)) throw error;
          continue;
        }
      }
      const visible = await readVisibleBackendNode(client, nodeId);
      if (!visible) continue;
      probe.visible_exact_dom_text_count += 1;
      if (fieldProbe) fieldProbe.visible_exact_dom_text_count += 1;
      const accessibilityVerified = await readExactAccessibilityText(client, nodeId, text);
      if (!accessibilityVerified) {
        probe.ax_rejected_count += 1;
        if (fieldProbe) fieldProbe.ax_rejected_count += 1;
        continue;
      }
      probe.ax_exact_count += 1;
      if (fieldProbe) fieldProbe.ax_exact_count += 1;
      matches.push({
        source: scope.source,
        field: expected.field,
        value: text,
        node_id: visible.node_id,
        backend_node_id: visible.backend_node_id,
        visible: true,
        accessibility_verified: true
      });
    }
    const matchedFields = new Set(matches.map((item) => item.field));
    if (expectedValues.every((item) => matchedFields.has(item.field))) break;
  }
  return { matches, probe };
}

function bindingNodeSignature(nodes = []) {
  return Array.from(new Set(nodes.map((node) => (
    `${node.source || ""}:${node.field || ""}:${node.value || ""}:${positiveNodeId(node.backend_node_id) || 0}`
  )))).sort();
}

function signaturesEqual(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function readRecommendDetailBindingSample(client, detailState, expected, {
  allowScroll = true
} = {}) {
  const resolvedScopes = await resolveRecommendDetailBindingScopes(client, detailState);
  const scopes = resolvedScopes.scopes;
  const candidateIds = [];
  const candidateIdProbes = [];
  const identityMatches = [];
  const identityProbes = [];
  for (const scope of scopes) {
    const candidateIdResult = await readDetailCandidateIds(client, scope);
    candidateIds.push(...candidateIdResult.evidence);
    candidateIdProbes.push(candidateIdResult.probe);
  }
  const expectedValues = [
    { field: "name", value: expected.name },
    ...(candidateIds.length ? [] : expected.secondary)
  ].filter((item) => item.value);
  for (const scope of scopes) {
    const identityResult = await readDetailExactIdentityMatches(
      client,
      scope,
      expectedValues,
      { allowScroll }
    );
    identityMatches.push(...identityResult.matches);
    identityProbes.push(identityResult.probe);
  }
  const nameMatches = identityMatches.filter((item) => item.field === "name");
  const secondaryMatches = identityMatches.filter((item) => item.field !== "name");
  return {
    scopes,
    ignored_scopes: resolvedScopes.ignored_scopes,
    candidate_ids: candidateIds,
    candidate_id_probe_complete: Boolean(
      scopes.length > 0
      && (resolvedScopes.ignored_scopes || []).length === 0
      && candidateIdProbes.length === scopes.length
      && candidateIdProbes.every((probe) => probe?.complete === true)
    ),
    candidate_id_probes: candidateIdProbes,
    name_matches: nameMatches,
    secondary_matches: secondaryMatches,
    identity_probes: identityProbes,
    signatures: {
      scopes: bindingNodeSignature(scopes.map((scope) => ({
        source: scope.source,
        field: "scope",
        value: "detail",
        backend_node_id: scope.backend_node_id
      }))),
      candidate_ids: bindingNodeSignature(candidateIds),
      names: bindingNodeSignature(nameMatches),
      secondary: bindingNodeSignature(secondaryMatches)
    }
  };
}

function compactDetailBindingSample(sample = null) {
  if (!sample) return null;
  return {
    scopes: (sample.scopes || []).map((scope) => ({
      source: scope.source,
      selector: scope.selector || null,
      node_id: positiveNodeId(scope.node_id),
      backend_node_id: positiveNodeId(scope.backend_node_id),
      iframe_node_id: positiveNodeId(scope.iframe_node_id),
      iframe_backend_node_id: positiveNodeId(scope.iframe_backend_node_id),
      container_node_id: positiveNodeId(scope.container_node_id),
      container_backend_node_id: positiveNodeId(scope.container_backend_node_id),
      container_verified: scope.container_verified === true,
      container_match_count: Number.isInteger(scope.container_match_count)
        ? scope.container_match_count
        : null,
      containment_method: scope.containment_method || null,
      container_membership: compactRecommendIframePopupMembership(
        scope.container_membership
      ),
      ancestry: scope.ancestry
        ? {
            verified: scope.ancestry.verified === true,
            reason: scope.ancestry.reason || null,
            method: scope.ancestry.method || null,
            parent_id_missing: scope.ancestry.parent_id_missing === true,
            parent_id_missing_at_node_id: positiveNodeId(
              scope.ancestry.parent_id_missing_at_node_id
            ),
            depth: Number.isInteger(scope.ancestry.depth) ? scope.ancestry.depth : null,
            path: (scope.ancestry.path || []).slice(0, 160).map((item) => ({
              node_id: positiveNodeId(item.node_id),
              backend_node_id: positiveNodeId(item.backend_node_id)
            }))
          }
        : null,
      visible: scope.visible === true
    })),
    ignored_scopes: (sample.ignored_scopes || []).slice(0, 20).map((scope) => ({
      source: scope.source || null,
      selector: scope.selector || null,
      root_node_id: positiveNodeId(scope.root_node_id),
      node_id: positiveNodeId(scope.node_id),
      backend_node_id: positiveNodeId(scope.backend_node_id),
      iframe_node_id: positiveNodeId(scope.iframe_node_id),
      iframe_backend_node_id: positiveNodeId(scope.iframe_backend_node_id),
      visible: false,
      stale: scope.stale === true,
      reason: scope.reason || null,
      error: scope.error || null
    })),
    candidate_ids: (sample.candidate_ids || []).slice(0, 20).map(compactBindingNode),
    candidate_id_probe_complete: sample.candidate_id_probe_complete === true,
    candidate_id_probes: (sample.candidate_id_probes || []).slice(0, 4).map((probe) => ({
      source: probe.source || null,
      scope_node_id: positiveNodeId(probe.scope_node_id),
      scope_backend_node_id: positiveNodeId(probe.scope_backend_node_id),
      complete: probe.complete === true,
      queried_node_count: Number(probe.queried_node_count) || 0,
      attribute_read_count: Number(probe.attribute_read_count) || 0,
      unread_nodes: (probe.unread_nodes || []).slice(0, 20).map((item) => ({
        node_id: positiveNodeId(item.node_id),
        reason: item.reason || null,
        error: item.error || null
      }))
    })),
    name_matches: (sample.name_matches || []).slice(0, 20).map(compactBindingNode),
    secondary_matches: (sample.secondary_matches || []).slice(0, 40).map(compactBindingNode),
    identity_probes: (sample.identity_probes || []).slice(0, 4).map((probe) => ({
      source: probe.source || null,
      scope_node_id: positiveNodeId(probe.scope_node_id),
      scope_backend_node_id: positiveNodeId(probe.scope_backend_node_id),
      scoped_node_count: Number(probe.scoped_node_count) || 0,
      html_read_count: Number(probe.html_read_count) || 0,
      exact_dom_text_count: Number(probe.exact_dom_text_count) || 0,
      visible_exact_dom_text_count: Number(probe.visible_exact_dom_text_count) || 0,
      ax_exact_count: Number(probe.ax_exact_count) || 0,
      ax_rejected_count: Number(probe.ax_rejected_count) || 0,
      selector_queries: (probe.selector_queries || []).slice(0, 4).map((query) => ({
        selector: query.selector || null,
        raw_node_count: Number(query.raw_node_count) || 0,
        unique_node_count: Number(query.unique_node_count) || 0
      })),
      fields: Object.fromEntries(Object.entries(probe.fields || {}).slice(0, 8).map(
        ([field, item]) => [field, {
          value: item.value || null,
          exact_dom_text_count: Number(item.exact_dom_text_count) || 0,
          visible_exact_dom_text_count: Number(item.visible_exact_dom_text_count) || 0,
          ax_exact_count: Number(item.ax_exact_count) || 0,
          ax_rejected_count: Number(item.ax_rejected_count) || 0
        }]
      ))
    }))
  };
}

function exactScopeIdentity(left = null, right = null) {
  return Boolean(
    left?.visible === true
    && right?.visible === true
    && left?.source
    && left.source === right.source
    && (left.selector || null) === (right.selector || null)
    && positiveNodeId(left.node_id)
    && left.node_id === right.node_id
    && positiveNodeId(left.backend_node_id)
    && left.backend_node_id === right.backend_node_id
    && positiveNodeId(left.iframe_node_id) === positiveNodeId(right.iframe_node_id)
    && positiveNodeId(left.iframe_backend_node_id)
      === positiveNodeId(right.iframe_backend_node_id)
  );
}

function compactContainedIframe(scope = null) {
  if (!scope) return null;
  return {
    selector: scope.selector || null,
    node_id: positiveNodeId(scope.node_id),
    backend_node_id: positiveNodeId(scope.backend_node_id),
    iframe_node_id: positiveNodeId(scope.iframe_node_id),
    iframe_backend_node_id: positiveNodeId(scope.iframe_backend_node_id),
    container_node_id: positiveNodeId(scope.container_node_id),
    container_backend_node_id: positiveNodeId(scope.container_backend_node_id),
    containment_method: scope.containment_method || null,
    container_membership: compactRecommendIframePopupMembership(
      scope.container_membership
    ),
    ancestry_depth: Number.isInteger(scope?.ancestry?.depth) ? scope.ancestry.depth : null,
    ancestry_path: (scope?.ancestry?.path || []).slice(0, 160).map((item) => ({
      node_id: positiveNodeId(item.node_id),
      backend_node_id: positiveNodeId(item.backend_node_id)
    })),
    visible: scope.visible === true,
    stable: true,
    contained: scope.container_verified === true
  };
}

function exactStableRecommendDetailRoot(first = null, second = null) {
  const firstScopes = Array.isArray(first?.scopes) ? first.scopes : [];
  const secondScopes = Array.isArray(second?.scopes) ? second.scopes : [];
  const firstPopups = firstScopes.filter((scope) => scope.source === "popup" && scope.visible === true);
  const secondPopups = secondScopes.filter((scope) => scope.source === "popup" && scope.visible === true);
  const firstIframes = firstScopes.filter((scope) => scope.source === "resume_iframe" && scope.visible === true);
  const secondIframes = secondScopes.filter((scope) => scope.source === "resume_iframe" && scope.visible === true);
  if (
    firstPopups.length > 1
    || secondPopups.length > 1
    || firstIframes.length > 1
    || secondIframes.length > 1
  ) {
    return { root: null, reason: "detail_root_not_unique" };
  }
  const left = firstPopups[0] || firstIframes[0] || null;
  const right = secondPopups[0] || secondIframes[0] || null;
  if (!left || !right) return { root: null, reason: "detail_root_not_visible" };
  if (!exactScopeIdentity(left, right)) {
    return { root: null, reason: "detail_root_identity_not_stable" };
  }

  let containedIframe = null;
  if (left.source === "popup") {
    if (firstIframes.length !== secondIframes.length) {
      return { root: null, reason: "detail_root_identity_not_stable" };
    }
    if (firstIframes.length === 1) {
      const firstIframe = firstIframes[0];
      const secondIframe = secondIframes[0];
      if (firstIframe.container_verified !== secondIframe.container_verified) {
        return { root: null, reason: "detail_iframe_ancestry_not_stable" };
      }
      if (
        firstIframe.container_verified !== true
        || secondIframe.container_verified !== true
        || positiveNodeId(firstIframe.container_node_id) !== positiveNodeId(left.node_id)
        || positiveNodeId(secondIframe.container_node_id) !== positiveNodeId(right.node_id)
        || positiveNodeId(firstIframe.container_backend_node_id)
          !== positiveNodeId(left.backend_node_id)
        || positiveNodeId(secondIframe.container_backend_node_id)
          !== positiveNodeId(right.backend_node_id)
      ) {
        return { root: null, reason: "detail_iframe_not_contained_by_popup" };
      }
      const firstAncestry = JSON.stringify(firstIframe?.ancestry?.path || []);
      const secondAncestry = JSON.stringify(secondIframe?.ancestry?.path || []);
      if (
        !exactScopeIdentity(firstIframe, secondIframe)
        || firstAncestry !== secondAncestry
        || (firstIframe?.containment_method || null)
          !== (secondIframe?.containment_method || null)
      ) {
        return { root: null, reason: "detail_iframe_ancestry_not_stable" };
      }
      containedIframe = compactContainedIframe(firstIframe);
    }
  } else if (firstPopups.length || secondPopups.length) {
    return { root: null, reason: "detail_root_identity_not_stable" };
  }

  const root = {
    source: left.source,
    node_id: positiveNodeId(left.node_id),
    backend_node_id: positiveNodeId(left.backend_node_id),
    iframe_node_id: positiveNodeId(left.iframe_node_id),
    iframe_backend_node_id: positiveNodeId(left.iframe_backend_node_id),
    contained_iframe: containedIframe,
    canonical: true,
    action_root: true,
    visible: true,
    stable: true
  };
  return {
    root,
    reason: null
  };
}

function sameCanonicalRecommendDetailContainerRoot(left = null, right = null) {
  return Boolean(
    left?.source
    && left.source === right?.source
    && positiveNodeId(left.backend_node_id)
    && positiveNodeId(left.backend_node_id) === positiveNodeId(right?.backend_node_id)
    && positiveNodeId(left.iframe_backend_node_id)
      === positiveNodeId(right?.iframe_backend_node_id)
  );
}

function sameCanonicalRecommendDetailRoot(left = null, right = null) {
  // This comparison crosses DOM snapshots (pre-click roots and later
  // revalidation).  Frontend node ids may be replaced by DOM.getDocument even
  // when the exact underlying detail is unchanged, so candidate authorization
  // here is based on the stable backend identity.  Within a single binding
  // attempt exactStableRecommendDetailRoot still requires both frontend and
  // backend identities to remain unchanged across its two samples.
  const leftContainedIframe = left?.contained_iframe || null;
  const rightContainedIframe = right?.contained_iframe || null;
  const containedIframeMatches = Boolean(leftContainedIframe) === Boolean(rightContainedIframe)
    && (!leftContainedIframe || Boolean(
      positiveNodeId(leftContainedIframe.iframe_backend_node_id)
      && positiveNodeId(leftContainedIframe.iframe_backend_node_id)
        === positiveNodeId(rightContainedIframe?.iframe_backend_node_id)
      && positiveNodeId(leftContainedIframe.backend_node_id)
        === positiveNodeId(rightContainedIframe?.backend_node_id)
      && (leftContainedIframe.selector || null) === (rightContainedIframe?.selector || null)
  ));
  return Boolean(
    sameCanonicalRecommendDetailContainerRoot(left, right)
    && containedIframeMatches
  );
}

function detailRootWasVisibleBeforeClick(detailRoot = null, detailRootsBefore = []) {
  if (!detailRoot || !Array.isArray(detailRootsBefore)) return false;
  return detailRootsBefore.some((scope) => (
    sameCanonicalRecommendDetailContainerRoot(detailRoot, scope)
  ));
}

export function compactRecommendDetailCandidateBinding(binding = null) {
  if (!binding) return null;
  const sample = binding?.detail?.second || binding?.detail?.first || null;
  return {
    schema_version: binding.schema_version || 1,
    verified: binding.verified === true,
    reason: binding.reason || null,
    method: binding.method || null,
    screening_verified: binding.screening_verified === true,
    screening_reason: binding.screening_reason || null,
    screening_method: binding.screening_method || null,
    expected_candidate_id: binding.expected_candidate_id || null,
    expected_name: binding.expected_name || null,
    expected_secondary: (binding.expected_secondary || []).slice(0, 8).map((item) => ({
      field: item.field || null,
      value: item.value || null
    })),
    allow_scroll: binding.allow_scroll !== false,
    settle_ms: Number.isFinite(Number(binding.settle_ms))
      ? Math.max(0, Number(binding.settle_ms))
      : null,
    stable: binding.stable === true,
    readiness: binding.readiness
      ? {
          verified: binding.readiness.verified === true,
          strict_verified: binding.readiness.strict_verified === true,
          screening_verified: binding.readiness.screening_verified === true,
          accepted_screening_binding: binding.readiness.accepted_screening_binding === true,
          exhausted: binding.readiness.exhausted === true,
          terminal: binding.readiness.terminal === true,
          attempt_count: Number(binding.readiness.attempt_count) || 0,
          timeout_ms: Number(binding.readiness.timeout_ms) || 0,
          elapsed_ms: Number(binding.readiness.elapsed_ms) || 0,
          last_reason: binding.readiness.last_reason || null
        }
      : null,
    card: {
      stable: binding?.card?.stable === true,
      disappeared_after_click: binding?.card?.disappeared_after_click === true,
      before: compactBindingNode(binding?.card?.before),
      after: compactBindingNode(binding?.card?.after),
      candidate_id: binding?.card?.candidate_id || null,
      name: binding?.card?.name || null,
      reason: binding?.card?.reason || null,
      pre_click_provenance: compactRecommendCardPreClickProvenance(
        binding?.card?.pre_click_provenance
      ),
      click_evidence: compactRecommendCardClickEvidence(
        binding?.card?.click_evidence
      ),
      click_attempts: compactRecommendCardClickAttempts(
        binding?.card?.click_attempts
      ),
      causal_proof: binding?.card?.causal_proof
          ? {
            verified: binding.card.causal_proof.verified === true,
            reason: binding.card.causal_proof.reason || null,
            resume_iframe_selector: binding.card.causal_proof.resume_iframe_selector || null
          }
        : null
    },
    detail: {
      root: binding?.detail?.root
        ? {
            source: binding.detail.root.source || null,
            node_id: positiveNodeId(binding.detail.root.node_id),
            backend_node_id: positiveNodeId(binding.detail.root.backend_node_id),
            iframe_node_id: positiveNodeId(binding.detail.root.iframe_node_id),
            iframe_backend_node_id: positiveNodeId(binding.detail.root.iframe_backend_node_id),
            contained_iframe: binding.detail.root.contained_iframe
              ? {
                  ...binding.detail.root.contained_iframe,
                  ancestry_path: (binding.detail.root.contained_iframe.ancestry_path || [])
                    .slice(0, 160)
                }
              : null,
            canonical: binding.detail.root.canonical === true,
            action_root: binding.detail.root.action_root === true,
            visible: binding.detail.root.visible === true,
            stable: binding.detail.root.stable === true
          }
        : null,
      newly_mounted: binding?.detail?.newly_mounted === true,
      root_matches_expected: binding?.detail?.root_matches_expected !== false,
      roots_before_click: (binding?.detail?.roots_before_click || [])
        .slice(0, 8)
        .map(compactRecommendDetailRootSnapshotScope),
      roots_before_capture: compactRecommendDetailRootsBeforeSnapshot(
        binding?.detail?.roots_before_capture || null
      ),
      candidate_id_evidence_present: binding?.detail?.candidate_id_evidence_present === true,
      candidate_id_probe_complete: binding?.detail?.candidate_id_probe_complete === true,
      exact_candidate_id: binding?.detail?.exact_candidate_id === true,
      exact_name: binding?.detail?.exact_name === true,
      exact_secondary: binding?.detail?.exact_secondary === true,
      stable_secondary_fields: (binding?.detail?.stable_secondary_fields || []).slice(0, 8),
      screening_capture_target: binding?.detail?.screening_capture_target
        ? {
            node_id: positiveNodeId(binding.detail.screening_capture_target.node_id),
            source: binding.detail.screening_capture_target.source || null,
            selector: binding.detail.screening_capture_target.selector || null,
            root_node_id: positiveNodeId(binding.detail.screening_capture_target.root_node_id),
            containment_verified:
              binding.detail.screening_capture_target.containment_verified === true,
            rect: binding.detail.screening_capture_target.rect || null,
            stability: binding.detail.screening_capture_target.stability || null
          }
        : null,
      stable_sample: sample
        ? {
            scopes: (sample.scopes || []).slice(0, 4),
            candidate_ids: (sample.candidate_ids || []).slice(0, 12),
            name_matches: (sample.name_matches || []).slice(0, 12),
            secondary_matches: (sample.secondary_matches || []).slice(0, 20),
            identity_probes: (sample.identity_probes || []).slice(0, 4)
          }
        : null
    }
  };
}

export function verifyExactCardClickToNewResumeRootCausality({
  cardNodeId,
  expectedCandidateId,
  expectedName,
  beforeCard,
  afterCard,
  cardPreClickProvenance,
  cardClickEvidence,
  clickAttempts,
  detailRoot,
  rootsBeforeWereCaptured,
  rootsBeforeCaptureComplete,
  newlyMounted,
  rootMatchesExpected,
  hasCandidateIdEvidence,
  candidateIdProbeComplete
} = {}) {
  const clickEvidence = compactRecommendCardClickEvidence(cardClickEvidence);
  const compactClickAttempts = compactRecommendCardClickAttempts(clickAttempts);
  const selectedPoint = clickEvidence?.hit_test?.selected || null;
  const selectedAttempt = clickEvidence?.hit_test?.selected_attempt || null;
  const clickAttempt = compactClickAttempts.length === 1 ? compactClickAttempts[0] : null;
  const preClickCard = cardPreClickProvenance?.card || null;
  const listRoot = cardPreClickProvenance?.list_root || null;
  const ancestry = cardPreClickProvenance?.ancestry || null;
  const rootMembership = cardPreClickProvenance?.root_membership || null;
  const containedIframe = detailRoot?.contained_iframe || null;
  const resumeIframeSelector = containedIframe?.selector
    || containedIframe?.container_membership?.selector
    || null;
  const exactExpectedCard = Boolean(
    beforeCard?.verified === true
    && beforeCard.candidate_id === expectedCandidateId
    && beforeCard.name === expectedName
    && positiveNodeId(beforeCard.node_id) === positiveNodeId(cardNodeId)
    && positiveNodeId(beforeCard.backend_node_id)
  );
  const exactListRoot = Boolean(
    positiveNodeId(listRoot?.node_id)
    && positiveNodeId(listRoot?.backend_node_id)
    && positiveNodeId(listRoot?.iframe_node_id)
    && positiveNodeId(listRoot?.iframe_backend_node_id)
    && positiveNodeId(listRoot?.linked_document_node_id)
      === positiveNodeId(listRoot?.node_id)
  );
  const exactParentAncestry = Boolean(
    cardPreClickProvenance?.containment_method === "parent_ancestry"
    && ancestry?.verified === true
    && positiveNodeId(ancestry?.descendant_node_id) === positiveNodeId(cardNodeId)
    && positiveNodeId(ancestry?.ancestor_node_id) === positiveNodeId(listRoot?.node_id)
    && positiveNodeId(ancestry?.ancestor_backend_node_id)
      === positiveNodeId(listRoot?.backend_node_id)
  );
  const membershipRecheck = rootMembership?.recheck || null;
  const membershipCardRecheck = rootMembership?.card_identity_recheck || null;
  const exactRootMembership = Boolean(
    cardPreClickProvenance?.containment_method === "root_scoped_exact_card_identity"
    && rootMembership?.verified === true
    && rootMembership?.root_scoped === true
    && rootMembership?.method === "root_scoped_exact_card_identity"
    && positiveNodeId(rootMembership?.root_node_id) === positiveNodeId(listRoot?.node_id)
    && positiveNodeId(rootMembership?.expected_root_backend_node_id)
      === positiveNodeId(listRoot?.backend_node_id)
    && positiveNodeId(rootMembership?.expected_iframe_node_id)
      === positiveNodeId(listRoot?.iframe_node_id)
    && positiveNodeId(rootMembership?.expected_iframe_backend_node_id)
      === positiveNodeId(listRoot?.iframe_backend_node_id)
    && positiveNodeId(rootMembership?.expected_linked_document_node_id)
      === positiveNodeId(listRoot?.linked_document_node_id)
    && positiveNodeId(rootMembership?.expected_card_node_id) === positiveNodeId(cardNodeId)
    && positiveNodeId(rootMembership?.expected_card_backend_node_id)
      === positiveNodeId(beforeCard?.backend_node_id)
    && positiveNodeId(rootMembership?.observed_card_backend_node_id)
      === positiveNodeId(beforeCard?.backend_node_id)
    && rootMembership?.exact_frontend_match_count === 1
    && rootMembership?.exact_backend_match_count === 1
    && membershipRecheck?.verified === true
    && positiveNodeId(membershipRecheck?.root_node_id) === positiveNodeId(listRoot?.node_id)
    && positiveNodeId(membershipRecheck?.expected_root_backend_node_id)
      === positiveNodeId(listRoot?.backend_node_id)
    && positiveNodeId(membershipRecheck?.observed_root_backend_node_id)
      === positiveNodeId(listRoot?.backend_node_id)
    && positiveNodeId(membershipRecheck?.iframe_node_id)
      === positiveNodeId(listRoot?.iframe_node_id)
    && positiveNodeId(membershipRecheck?.expected_iframe_backend_node_id)
      === positiveNodeId(listRoot?.iframe_backend_node_id)
    && positiveNodeId(membershipRecheck?.observed_iframe_backend_node_id)
      === positiveNodeId(listRoot?.iframe_backend_node_id)
    && positiveNodeId(membershipRecheck?.expected_linked_document_node_id)
      === positiveNodeId(listRoot?.linked_document_node_id)
    && positiveNodeId(membershipRecheck?.observed_linked_document_node_id)
      === positiveNodeId(listRoot?.linked_document_node_id)
    && membershipCardRecheck?.verified === true
    && membershipCardRecheck?.candidate_id === expectedCandidateId
    && membershipCardRecheck?.name === expectedName
    && positiveNodeId(membershipCardRecheck?.node_id) === positiveNodeId(cardNodeId)
    && positiveNodeId(membershipCardRecheck?.backend_node_id)
      === positiveNodeId(beforeCard?.backend_node_id)
  );
  const exactPreClickCard = Boolean(
    cardPreClickProvenance?.verified === true
    && preClickCard?.verified === true
    && preClickCard.candidate_id === expectedCandidateId
    && preClickCard.name === expectedName
    && positiveNodeId(preClickCard.node_id) === positiveNodeId(cardNodeId)
    && positiveNodeId(preClickCard.backend_node_id)
      === positiveNodeId(beforeCard?.backend_node_id)
    && exactListRoot
    && (exactParentAncestry || exactRootMembership)
  );
  const exactSafeHit = Boolean(
    clickEvidence?.verified === true
    && clickEvidence?.in_viewport === true
    && positiveNodeId(clickEvidence?.node_id) === positiveNodeId(cardNodeId)
    && clickEvidence?.hit_test?.completed === true
    && clickEvidence?.hit_test?.exact_card_hit_verified === true
    && selectedPoint
    && sameRecommendClickPoint(clickEvidence?.click_target, selectedPoint)
    && sameRecommendClickPoint(selectedAttempt?.point, selectedPoint)
    && selectedAttempt?.inside_viewport === true
    && selectedAttempt?.exact_card_hit === true
    && selectedAttempt?.safe_card_hit === true
    && selectedAttempt?.safe_card_body_hit === true
    && positiveNodeId(selectedAttempt?.hit_node_id)
    && positiveNodeId(selectedAttempt?.hit_backend_node_id)
  );
  const exactSingleClick = Boolean(
    compactClickAttempts.length === 1
    && clickAttempt?.attempt === 1
    && clickAttempt?.input_dispatched === true
    && clickAttempt?.outcome === "detail"
    && sameRecommendClickPoint(clickAttempt?.click_target, selectedPoint)
  );
  const cardDefinitivelyDetached = Boolean(
    afterCard?.verified !== true
    && afterCard?.definitively_disappeared === true
    && afterCard?.disappearance_kind === "detached"
  );
  const exactNewResumeRoot = Boolean(
    rootsBeforeWereCaptured === true
    && rootsBeforeCaptureComplete === true
    && detailRoot?.source === "popup"
    && detailRoot?.canonical === true
    && detailRoot?.action_root === true
    && detailRoot?.visible === true
    && detailRoot?.stable === true
    && positiveNodeId(detailRoot?.backend_node_id)
    && newlyMounted === true
    && rootMatchesExpected === true
    && containedIframe?.contained === true
    && containedIframe?.visible === true
    && containedIframe?.stable === true
    && positiveNodeId(containedIframe?.iframe_node_id)
    && positiveNodeId(containedIframe?.iframe_backend_node_id)
    && positiveNodeId(containedIframe?.node_id)
    && positiveNodeId(containedIframe?.backend_node_id)
    && DETAIL_RESUME_IFRAME_SELECTORS.includes(resumeIframeSelector)
  );

  let reason = null;
  if (candidateIdProbeComplete !== true) reason = "detail_causal_candidate_id_probe_incomplete";
  else if (hasCandidateIdEvidence) reason = "detail_causal_candidate_id_evidence_present";
  else if (!exactExpectedCard) reason = "detail_causal_exact_card_identity_missing";
  else if (!exactPreClickCard) reason = "detail_causal_pre_click_provenance_unverified";
  else if (!exactSafeHit) reason = "detail_causal_safe_hit_unverified";
  else if (!exactSingleClick) reason = "detail_causal_single_click_unverified";
  else if (!cardDefinitivelyDetached) reason = "detail_causal_card_not_detached_after_click";
  else if (!exactNewResumeRoot) reason = "detail_causal_resume_iframe_not_ready";

  return {
    verified: reason === null,
    reason,
    exact_expected_card: exactExpectedCard,
    exact_pre_click_card: exactPreClickCard,
    exact_safe_hit: exactSafeHit,
    exact_single_click: exactSingleClick,
    card_definitively_detached: cardDefinitivelyDetached,
    exact_new_resume_root: exactNewResumeRoot,
    click_evidence: clickEvidence,
    click_attempts: compactClickAttempts,
    resume_iframe_selector: resumeIframeSelector
  };
}

export async function verifyRecommendDetailCandidateBinding(client, {
  cardNodeId,
  cardCandidate,
  detailState,
  cardEvidenceBefore = null,
  cardPreClickProvenance = null,
  detailRootsBefore = null,
  expectedDetailRoot = null,
  allowCardDisappearance = false,
  cardClickEvidence = null,
  clickAttempts = null,
  settleMs = 120,
  allowScroll = true
} = {}) {
  const expected = {
    candidate_id: normalizeBindingText(cardCandidate?.id),
    name: normalizeBindingText(cardCandidate?.identity?.name),
    secondary: expectedSecondaryIdentity(cardCandidate)
  };
  const beforeCard = cardEvidenceBefore
    || cardPreClickProvenance?.card
    || await readRecommendCardBindingEvidence(
    client,
    cardNodeId,
    cardCandidate
  );
  const first = await readRecommendDetailBindingSample(client, detailState, expected, {
    allowScroll
  });
  if (settleMs > 0) await sleep(settleMs);
  const second = await readRecommendDetailBindingSample(client, detailState, expected, {
    allowScroll
  });
  const afterCard = await readRecommendCardAfterClickEvidence(client, cardNodeId, cardCandidate);

  const detailRootSelection = exactStableRecommendDetailRoot(first, second);
  const detailRoot = detailRootSelection.root;

  const cardPersistedStable = Boolean(
    beforeCard?.verified === true
    && afterCard?.verified === true
    && positiveNodeId(beforeCard.backend_node_id)
    && beforeCard.backend_node_id === afterCard.backend_node_id
    && beforeCard.candidate_id === afterCard.candidate_id
    && beforeCard.name === afterCard.name
  );
  const cardDisappearedAfterClick = Boolean(
    allowCardDisappearance === true
    && cardPreClickProvenance?.verified === true
    && beforeCard?.verified === true
    && afterCard?.verified !== true
    && afterCard?.definitively_disappeared === true
  );
  const cardStable = cardPersistedStable || cardDisappearedAfterClick;
  const stable = Boolean(
    signaturesEqual(first.signatures.scopes, second.signatures.scopes)
    && signaturesEqual(first.signatures.candidate_ids, second.signatures.candidate_ids)
    && signaturesEqual(first.signatures.names, second.signatures.names)
    && signaturesEqual(first.signatures.secondary, second.signatures.secondary)
  );
  const firstIds = Array.from(new Set(first.candidate_ids.map((item) => item.value)));
  const secondIds = Array.from(new Set(second.candidate_ids.map((item) => item.value)));
  const hasCandidateIdEvidence = firstIds.length > 0 || secondIds.length > 0;
  const candidateIdProbeComplete = Boolean(
    first.candidate_id_probe_complete === true
    && second.candidate_id_probe_complete === true
  );
  const exactCandidateId = Boolean(
    expected.candidate_id
    && candidateIdProbeComplete
    && firstIds.length > 0
    && firstIds.every((value) => value === expected.candidate_id)
    && secondIds.length > 0
    && secondIds.every((value) => value === expected.candidate_id)
  );
  const exactName = Boolean(
    expected.name
    && first.name_matches.length > 0
    && second.name_matches.length > 0
  );
  const stableSecondaryFields = Array.from(new Set(first.secondary_matches
    .filter((item) => second.secondary_matches.some((other) => (
      other.field === item.field
      && other.value === item.value
      && other.backend_node_id === item.backend_node_id
    )))
    .map((item) => item.field)));
  const exactSecondary = stableSecondaryFields.length > 0;
  let method = exactCandidateId && exactName
    ? "exact_candidate_id_and_name"
    : candidateIdProbeComplete && !hasCandidateIdEvidence && exactName && exactSecondary
    ? "exact_name_and_secondary_identity"
    : null;
  const rootsBeforeSnapshot = compactRecommendDetailRootsBeforeSnapshot(detailRootsBefore);
  const rootsBeforeWereCaptured = rootsBeforeSnapshot.captured === true;
  const rootsBeforeCaptureComplete = rootsBeforeSnapshot.complete === true;
  const newlyMounted = Boolean(
    detailRoot
    && (!rootsBeforeWereCaptured || !detailRootWasVisibleBeforeClick(
      detailRoot,
      rootsBeforeSnapshot.roots
    ))
  );
  const rootMatchesExpected = Boolean(
    detailRoot
    && (!expectedDetailRoot || sameCanonicalRecommendDetailRoot(detailRoot, expectedDetailRoot))
  );
  const causalProof = verifyExactCardClickToNewResumeRootCausality({
    cardNodeId,
    expectedCandidateId: expected.candidate_id,
    expectedName: expected.name,
    beforeCard,
    afterCard,
    cardPreClickProvenance,
    cardClickEvidence,
    clickAttempts,
    detailRoot,
    rootsBeforeWereCaptured,
    rootsBeforeCaptureComplete,
    newlyMounted,
    rootMatchesExpected,
    hasCandidateIdEvidence,
    candidateIdProbeComplete
  });
  const causalEvidenceProvided = Boolean(
    cardClickEvidence
    || (Array.isArray(clickAttempts) && clickAttempts.length > 0)
  );
  if (
    !method
    && candidateIdProbeComplete
    && !hasCandidateIdEvidence
    && !exactName
    && causalProof.verified
  ) {
    method = "exact_card_click_and_new_resume_root";
  }
  const verified = Boolean(
    cardStable
    && stable
    && detailRoot
    && newlyMounted
    && rootMatchesExpected
    && method
  );
  let reason = null;
  if (!expected.candidate_id || !expected.name) reason = "expected_candidate_identity_incomplete";
  else if (allowCardDisappearance === true && cardPreClickProvenance?.verified !== true) {
    reason = cardPreClickProvenance?.reason || "card_pre_click_provenance_unverified";
  }
  else if (
    afterCard?.visible === true
    && ["card_candidate_id_mismatch", "card_candidate_name_mismatch"].includes(afterCard?.reason)
  ) reason = afterCard.reason;
  else if (!cardStable) reason = "card_identity_not_stable";
  else if (!detailRoot) reason = detailRootSelection.reason || "detail_root_identity_not_stable";
  else if (!newlyMounted) reason = "detail_root_not_newly_mounted";
  else if (!rootMatchesExpected) reason = "detail_root_changed";
  else if (!stable) reason = "detail_binding_evidence_changed";
  else if (hasCandidateIdEvidence && !exactCandidateId) reason = "detail_candidate_id_mismatch";
  else if (!candidateIdProbeComplete) reason = causalEvidenceProvided
    ? causalProof.reason || "detail_candidate_id_probe_incomplete"
    : "detail_candidate_id_probe_incomplete";
  else if (!exactName && method !== "exact_card_click_and_new_resume_root") {
    reason = !hasCandidateIdEvidence && causalEvidenceProvided && causalProof.reason
      ? causalProof.reason
      : "detail_candidate_name_not_proven";
  }
  else if (
    method !== "exact_card_click_and_new_resume_root"
    && !hasCandidateIdEvidence
    && !exactSecondary
  ) reason = "detail_secondary_identity_not_proven";

  // Screening can operate from the stable, newly-mounted popup itself.  Boss
  // currently renders many resumes directly inside that popup without a
  // nested resume iframe or readable identity text.  Keep this evidence
  // separate from the strict candidate binding: it may authorize only
  // screenshot/LLM reads in an explicitly zero-outbound run and must never be
  // treated as sufficient for a post action.
  let screeningCaptureTarget = null;
  if (
    !verified
    && detailRoot?.source === "popup"
    && detailRoot?.visible === true
    && detailRoot?.stable === true
    && positiveNodeId(detailRoot?.node_id)
  ) {
    screeningCaptureTarget = await resolveCvCaptureTarget(client, {
      popup: {
        ...(detailState?.popup || {}),
        node_id: positiveNodeId(detailRoot.node_id)
      },
      resumeIframe: null,
      content: null,
      roots: []
    }, {
      domain: "recommend",
      stabilitySamples: 2,
      stabilityIntervalMs: 0
    });
  }
  const exactScreeningCaptureTarget = Boolean(
    screeningCaptureTarget?.source === "popup_cv_selector"
    && CV_CAPTURE_TARGET_SELECTORS.includes(screeningCaptureTarget?.selector)
    && screeningCaptureTarget?.containment_verified === true
    && screeningCaptureTarget?.stability?.stable === true
    && Number(screeningCaptureTarget?.stability?.sample_count) >= 2
    && positiveNodeId(screeningCaptureTarget?.root_node_id)
      === positiveNodeId(detailRoot?.node_id)
    && Number(screeningCaptureTarget?.rect?.width || 0) > 2
    && Number(screeningCaptureTarget?.rect?.height || 0) > 2
  );
  const exactScreeningPopupRoot = Boolean(
    rootsBeforeWereCaptured === true
    && rootsBeforeCaptureComplete === true
    && detailRoot?.source === "popup"
    && detailRoot?.canonical === true
    && detailRoot?.action_root === true
    && detailRoot?.visible === true
    && detailRoot?.stable === true
    && positiveNodeId(detailRoot?.backend_node_id)
    && newlyMounted === true
    && rootMatchesExpected === true
    && exactScreeningCaptureTarget
  );
  const screeningFallbackVerified = Boolean(
    expected.candidate_id
    && expected.name
    && cardStable
    && stable
    && candidateIdProbeComplete
    && (!hasCandidateIdEvidence || exactCandidateId)
    && causalProof.exact_expected_card === true
    && causalProof.exact_pre_click_card === true
    && causalProof.exact_safe_hit === true
    && causalProof.exact_single_click === true
    && exactScreeningPopupRoot
  );
  const screeningVerified = verified || screeningFallbackVerified;
  const screeningMethod = verified
    ? method
    : screeningFallbackVerified
    ? "exact_card_click_and_stable_popup_cv_root"
    : null;
  let screeningReason = null;
  if (!screeningVerified) {
    if (!expected.candidate_id || !expected.name) screeningReason = "expected_candidate_identity_incomplete";
    else if (!cardStable) screeningReason = "screening_card_identity_not_stable";
    else if (!stable) screeningReason = "screening_detail_root_not_stable";
    else if (!candidateIdProbeComplete) screeningReason = "screening_candidate_id_probe_incomplete";
    else if (hasCandidateIdEvidence && !exactCandidateId) screeningReason = "detail_candidate_id_mismatch";
    else if (causalProof.exact_expected_card !== true) screeningReason = "screening_exact_card_identity_missing";
    else if (causalProof.exact_pre_click_card !== true) screeningReason = "screening_pre_click_provenance_unverified";
    else if (causalProof.exact_safe_hit !== true) screeningReason = "screening_safe_hit_unverified";
    else if (causalProof.exact_single_click !== true) screeningReason = "screening_single_click_unverified";
    else if (!exactScreeningCaptureTarget) screeningReason = "screening_popup_cv_target_unverified";
    else if (!exactScreeningPopupRoot) screeningReason = "screening_popup_cv_root_unverified";
    else screeningReason = reason || "screening_candidate_binding_unverified";
  }

  return {
    schema_version: 1,
    verified,
    reason: verified ? null : reason || "detail_candidate_binding_unverified",
    method,
    screening_verified: screeningVerified,
    screening_reason: screeningReason,
    screening_method: screeningMethod,
    expected_candidate_id: expected.candidate_id || null,
    expected_name: expected.name || null,
    expected_secondary: expected.secondary,
    allow_scroll: allowScroll === true,
    settle_ms: Math.max(0, Number(settleMs) || 0),
    stable,
    card: {
      stable: cardStable,
      disappeared_after_click: cardDisappearedAfterClick,
      before: compactBindingNode(beforeCard),
      after: compactBindingNode(afterCard),
      candidate_id: afterCard?.candidate_id || beforeCard?.candidate_id || null,
      name: afterCard?.name || beforeCard?.name || null,
      reason: cardStable ? null : afterCard?.reason || beforeCard?.reason || null,
      pre_click_provenance: compactRecommendCardPreClickProvenance(cardPreClickProvenance),
      click_evidence: causalProof.click_evidence,
      click_attempts: causalProof.click_attempts,
      causal_proof: {
        verified: causalProof.verified,
        reason: causalProof.reason,
        resume_iframe_selector: causalProof.resume_iframe_selector
      }
    },
    detail: {
      root: detailRoot,
      newly_mounted: newlyMounted,
      root_matches_expected: rootMatchesExpected,
      roots_before_click: rootsBeforeSnapshot.roots,
      roots_before_capture: rootsBeforeSnapshot,
      candidate_id_evidence_present: hasCandidateIdEvidence,
      candidate_id_probe_complete: candidateIdProbeComplete,
      exact_candidate_id: exactCandidateId,
      exact_name: exactName,
      exact_secondary: exactSecondary,
      stable_secondary_fields: stableSecondaryFields,
      screening_capture_target: screeningCaptureTarget,
      first: compactDetailBindingSample(first),
      second: compactDetailBindingSample(second)
    }
  };
}

const TERMINAL_RECOMMEND_DETAIL_BINDING_REASONS = new Set([
  "expected_candidate_identity_incomplete",
  "card_pre_click_provenance_unverified",
  "card_identity_not_verified_before_click",
  "card_list_root_provenance_missing",
  "card_iframe_document_link_mismatch",
  "card_not_bound_to_recommend_list_root",
  "card_candidate_id_mismatch",
  "card_candidate_name_mismatch",
  "detail_root_not_unique",
  "detail_root_not_newly_mounted",
  "detail_root_changed",
  "detail_candidate_id_mismatch",
  "detail_causal_exact_card_identity_missing",
  "detail_causal_pre_click_provenance_unverified",
  "detail_causal_safe_hit_unverified",
  "detail_causal_single_click_unverified",
  "detail_causal_card_not_detached_after_click"
]);

function isTerminalRecommendDetailBindingReason(reason = "") {
  return TERMINAL_RECOMMEND_DETAIL_BINDING_REASONS.has(String(reason || ""));
}

export async function waitForRecommendDetailCandidateBinding(client, {
  timeoutMs = 5000,
  intervalMs = 200,
  maxAttempts = 20,
  acceptScreeningBinding = false,
  ...verificationOptions
} = {}) {
  const started = Date.now();
  const boundedTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
  const boundedIntervalMs = Math.max(0, Number(intervalMs) || 0);
  const boundedMaxAttempts = Math.max(1, Math.floor(Number(maxAttempts) || 1));
  const attempts = [];
  let lastBinding = null;
  let lastDetailState = null;
  let lastError = null;

  for (let attemptIndex = 0; attemptIndex < boundedMaxAttempts; attemptIndex += 1) {
    try {
      // A click first mounts a generic loading dialog; the resume iframe is
      // attached later.  Re-read the current detail roots on every readiness
      // attempt instead of freezing the loading-only state returned by the
      // first post-click poll.
      const currentDetailState = await readRecommendDetailState(client);
      lastDetailState = currentDetailState;
      lastBinding = await verifyRecommendDetailCandidateBinding(client, {
        ...verificationOptions,
        detailState: currentDetailState
      });
      attempts.push({
        attempt: attemptIndex + 1,
        verified: lastBinding.verified === true,
        screening_verified: lastBinding.screening_verified === true,
        reason: lastBinding.reason || null,
        method: lastBinding.method || null,
        detail_root_backend_node_id: positiveNodeId(lastBinding?.detail?.root?.backend_node_id),
        card_disappeared_after_click: lastBinding?.card?.disappeared_after_click === true
      });
      const acceptedScreeningBinding = Boolean(
        acceptScreeningBinding === true
        && lastBinding.screening_verified === true
      );
      if (lastBinding.verified === true || acceptedScreeningBinding) {
        return {
          ...lastBinding,
          observed_detail_state: currentDetailState,
          readiness: {
            verified: true,
            strict_verified: lastBinding.verified === true,
            screening_verified: lastBinding.screening_verified === true,
            accepted_screening_binding: acceptedScreeningBinding,
            exhausted: false,
            terminal: false,
            attempt_count: attempts.length,
            timeout_ms: boundedTimeoutMs,
            elapsed_ms: Date.now() - started,
            last_reason: null,
            attempts
          }
        };
      }
      const screeningMayStillBecomeReady = Boolean(
        acceptScreeningBinding === true
        && lastBinding.reason === "detail_causal_card_not_detached_after_click"
      );
      if (
        isTerminalRecommendDetailBindingReason(lastBinding.reason)
        && !screeningMayStillBecomeReady
      ) {
        return {
          ...lastBinding,
          observed_detail_state: currentDetailState,
          readiness: {
            verified: false,
            strict_verified: false,
            screening_verified: lastBinding.screening_verified === true,
            accepted_screening_binding: false,
            exhausted: false,
            terminal: true,
            attempt_count: attempts.length,
            timeout_ms: boundedTimeoutMs,
            elapsed_ms: Date.now() - started,
            last_reason: lastBinding.reason || null,
            attempts
          }
        };
      }
    } catch (error) {
      if (shouldRethrowRecommendProtocolError(error)) throw error;
      lastError = error;
      attempts.push({
        attempt: attemptIndex + 1,
        verified: false,
        reason: "detail_binding_readiness_read_failed",
        error: error?.message || String(error)
      });
    }

    const elapsedMs = Date.now() - started;
    if (elapsedMs >= boundedTimeoutMs || attemptIndex >= boundedMaxAttempts - 1) break;
    if (boundedIntervalMs > 0) {
      await sleep(Math.min(boundedIntervalMs, Math.max(0, boundedTimeoutMs - elapsedMs)));
    }
  }

  const lastReason = lastBinding?.reason
    || (lastError ? "detail_binding_readiness_read_failed" : "detail_candidate_binding_unverified");
  return {
    ...(lastBinding || {
      schema_version: 1,
      verified: false,
      screening_verified: false,
      screening_reason: lastReason,
      screening_method: null,
      method: null,
      expected_candidate_id: normalizeBindingText(verificationOptions?.cardCandidate?.id) || null,
      expected_name: normalizeBindingText(verificationOptions?.cardCandidate?.identity?.name) || null,
      expected_secondary: expectedSecondaryIdentity(verificationOptions?.cardCandidate),
      stable: false,
      card: {
        stable: false,
        disappeared_after_click: false,
        before: null,
        after: null,
        candidate_id: null,
        name: null,
        reason: lastReason,
        pre_click_provenance: compactRecommendCardPreClickProvenance(
          verificationOptions.cardPreClickProvenance
        )
      },
      detail: null
    }),
    verified: false,
    reason: "detail_binding_readiness_timeout",
    observed_detail_state: lastDetailState,
    readiness: {
      verified: false,
      strict_verified: false,
      screening_verified: false,
      accepted_screening_binding: false,
      exhausted: true,
      terminal: false,
      attempt_count: attempts.length,
      timeout_ms: boundedTimeoutMs,
      elapsed_ms: Date.now() - started,
      last_reason: lastReason,
      last_error: lastError?.message || null,
      attempts
    }
  };
}

export function createRecommendDetailCandidateBindingError(binding = null) {
  const reason = binding?.reason || "detail_candidate_binding_unverified";
  const error = new Error(`RECOMMEND_DETAIL_CANDIDATE_MISMATCH: ${reason}`);
  error.code = "RECOMMEND_DETAIL_CANDIDATE_MISMATCH";
  error.phase = "recommend:detail-binding";
  error.detail_candidate_binding = binding;
  return error;
}

export function isCleanRecommendPostClickBindingReadinessTimeout(
  binding = null,
  clickAttempts = []
) {
  const readiness = binding?.readiness || null;
  const attempts = Array.isArray(clickAttempts) ? clickAttempts : [];
  const dispatchedAttempts = attempts.filter((attempt) => attempt?.input_dispatched === true);
  return Boolean(
    binding?.verified !== true
    && binding?.reason === "detail_binding_readiness_timeout"
    && readiness?.exhausted === true
    && readiness?.terminal === false
    && readiness?.last_error == null
    && Number(readiness?.attempt_count || 0) > 0
    && dispatchedAttempts.length === 1
    && dispatchedAttempts[0]?.outcome === "detail"
  );
}

export function isRecommendDetailCandidateBindingError(error) {
  return error?.code === "RECOMMEND_DETAIL_CANDIDATE_MISMATCH"
    || /RECOMMEND_DETAIL_CANDIDATE_MISMATCH/.test(String(error?.message || error || ""));
}

export function matchesRecommendDetailNetwork(url) {
  return DETAIL_NETWORK_PATTERNS.some((pattern) => pattern.test(String(url || "")));
}

export function createRecommendDetailNetworkRecorder(client) {
  const events = [];
  client.Network.responseReceived((event) => {
    const url = event?.response?.url || "";
    if (!matchesRecommendDetailNetwork(url)) return;
    events.push({
      requestId: event.requestId,
      url,
      status: event.response?.status,
      mimeType: event.response?.mimeType,
      type: event.type
    });
  });
  if (typeof client.Network.loadingFinished === "function") {
    client.Network.loadingFinished((event) => {
      const found = events.find((item) => item.requestId === event.requestId);
      if (!found) return;
      found.loading_finished = true;
      found.encodedDataLength = event.encodedDataLength;
    });
  }
  if (typeof client.Network.loadingFailed === "function") {
    client.Network.loadingFailed((event) => {
      const found = events.find((item) => item.requestId === event.requestId);
      if (!found) return;
      found.loading_failed = true;
      found.loading_error = event.errorText || event.blockedReason || "Network loading failed";
    });
  }
  return {
    events,
    clear() {
      events.length = 0;
    }
  };
}

export async function findRecommendBlockingPanel(client, options = {}) {
  return findBossAccountRightsBlockingPanel(client, options);
}

export async function closeRecommendBlockingPanels(client, options = {}) {
  return closeBossAccountRightsBlockingPanel(client, {
    resolveRoots: getRecommendRoots,
    ...options
  });
}

function looksLikeRecommendAvatarPreviewHtml(html = "") {
  return /\bavatar-preview\b|\bfigure-preview\b/i.test(String(html || ""));
}

function isRecommendAvatarPreviewOpenError(error) {
  return error?.code === "RECOMMEND_AVATAR_PREVIEW_OPENED"
    || /RECOMMEND_AVATAR_PREVIEW_OPENED/i.test(String(error?.message || error || ""));
}

export async function waitForRecommendDetailNetworkEvents(recorder, {
  minCount = 1,
  requireLoaded = true,
  timeoutMs = 3500,
  intervalMs = 100
} = {}) {
  const started = Date.now();
  const events = Array.isArray(recorder) ? recorder : recorder?.events || [];
  let matching = [];
  while (Date.now() - started <= timeoutMs) {
    matching = events.filter((event) => (
      !requireLoaded
      || event.loading_finished === true
      || event.loading_failed === true
    ));
    if (matching.length >= minCount) {
      return {
        ok: true,
        elapsed_ms: Date.now() - started,
        count: matching.length,
        events: matching
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    count: matching.length,
    events: matching,
    total_event_count: events.length
  };
}

export async function readRecommendDetailNetworkBodies(client, events = [], {
  limit = 10
} = {}) {
  const bodies = [];
  for (const event of events.slice(0, limit)) {
    try {
      const body = await client.Network.getResponseBody({ requestId: event.requestId });
      bodies.push({
        ...event,
        body,
        body_length: String(body?.body || "").length
      });
    } catch (error) {
      bodies.push({
        ...event,
        body_error: error?.message || String(error)
      });
    }
  }
  return bodies;
}

export async function waitForRecommendDetail(client, {
  timeoutMs = 10000,
  intervalMs = 250
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    lastState = await readRecommendDetailState(client);
    if (lastState?.popup || lastState?.resumeIframe) return lastState;
    await sleep(intervalMs);
  }
  return lastState;
}

async function readRecommendDetailState(client, {
  rootState = null
} = {}) {
  const currentRootState = rootState?.iframe?.documentNodeId
    ? rootState
    : await getRecommendRoots(client);
  const popup = await findVisibleDetailTarget(
    client,
    currentRootState.roots,
    DETAIL_POPUP_SELECTORS
  );
  const resumeIframe = await findVisibleDetailTarget(
    client,
    currentRootState.roots,
    DETAIL_RESUME_IFRAME_SELECTORS
  );
  return {
    iframe: currentRootState.iframe,
    roots: currentRootState.roots,
    popup,
    resumeIframe
  };
}

export async function waitForRecommendDetailClosed(client, {
  timeoutMs = 4000,
  intervalMs = 250
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    lastState = await readRecommendDetailState(client);
    if (!lastState?.popup && !lastState?.resumeIframe) {
      return {
        closed: true,
        elapsed_ms: Date.now() - started,
        state: lastState
      };
    }
    await sleep(intervalMs);
  }
  return {
    closed: false,
    elapsed_ms: Date.now() - started,
    state: lastState
  };
}

export async function readRecommendAvatarPreviewState(client) {
  const rootState = await getRecommendRoots(client);
  const topRoot = rootState.rootNodes?.top
    ? [{ name: "top", nodeId: rootState.rootNodes.top }]
    : rootState.roots.filter((root) => root?.name === "top");
  const preview = await findVisibleDetailTarget(client, topRoot, RECOMMEND_AVATAR_PREVIEW_SELECTORS, {
    includeAvatarPreview: true
  });
  return {
    open: Boolean(preview),
    root: rootState.topRoot,
    roots: topRoot,
    preview
  };
}

export async function waitForRecommendAvatarPreviewClosed(client, {
  timeoutMs = 1200,
  intervalMs = 120
} = {}) {
  const started = Date.now();
  let state = null;
  while (Date.now() - started <= timeoutMs) {
    state = await readRecommendAvatarPreviewState(client);
    if (!state.open) {
      return {
        closed: true,
        elapsed_ms: Date.now() - started,
        state
      };
    }
    await sleep(intervalMs);
  }
  return {
    closed: false,
    elapsed_ms: Date.now() - started,
    state
  };
}

function compactRect(rect) {
  if (!rect) return null;
  return {
    x: Math.round(Number(rect.x) || 0),
    y: Math.round(Number(rect.y) || 0),
    width: Math.round(Number(rect.width) || 0),
    height: Math.round(Number(rect.height) || 0)
  };
}

function compactDetailTarget(target) {
  if (!target) return null;
  return {
    root: target.root || "",
    root_node_id: target.root_node_id || null,
    selector: target.selector || "",
    node_id: target.node_id || null,
    rect: compactRect(target.rect)
  };
}

function compactDetailOpenState(state) {
  if (!state) {
    return {
      open: false,
      popup: null,
      resume_iframe: null,
      iframe_document_node_id: null
    };
  }
  return {
    open: Boolean(state.popup || state.resumeIframe),
    popup: compactDetailTarget(state.popup),
    resume_iframe: compactDetailTarget(state.resumeIframe),
    iframe_document_node_id: state.iframe?.documentNodeId || null
  };
}

async function verifyRecommendDetailStillOpen(client, {
  settleMs = 350
} = {}) {
  const firstState = await readRecommendDetailState(client);
  if (settleMs > 0) await sleep(settleMs);
  const secondState = await readRecommendDetailState(client);
  const first = compactDetailOpenState(firstState);
  const second = compactDetailOpenState(secondState);
  const stableOpen = Boolean(first.open && second.open);
  return {
    open: Boolean(second.open),
    stable_open: stableOpen,
    first,
    second
  };
}

async function findVisibleDetailTarget(client, roots, selectors, {
  includeAvatarPreview = false
} = {}) {
  for (const root of roots) {
    if (!root?.nodeId) continue;
    for (const selector of selectors) {
      const nodeIds = await querySelectorAll(client, root.nodeId, selector);
      for (const nodeId of nodeIds) {
        try {
          const box = await getNodeBox(client, nodeId);
          if (box.rect.width > 2 && box.rect.height > 2) {
            if (!includeAvatarPreview) {
              try {
                const html = await getOuterHTML(client, nodeId);
                if (looksLikeRecommendAvatarPreviewHtml(html)) continue;
              } catch {
                // If the node went stale, let the next candidate decide.
              }
            }
            return {
              root: root.name,
              root_node_id: root.nodeId,
              selector,
              node_id: nodeId,
              center: box.center,
              rect: box.rect
            };
          }
        } catch {}
      }
    }
  }
  return null;
}

export async function readRecommendDetailHtml(client, detailState) {
  let popupHTML = "";
  let resumeHTML = "";
  let resumeIframeDocumentNodeId = null;
  const errors = [];

  if (detailState?.popup?.node_id) {
    try {
      popupHTML = await getOuterHTML(client, detailState.popup.node_id);
    } catch (error) {
      errors.push({
        source: "popup",
        node_id: detailState.popup.node_id,
        stale_node: isStaleRecommendNodeError(error),
        error: error?.message || String(error)
      });
    }
  }

  if (detailState?.resumeIframe?.node_id) {
    try {
      resumeIframeDocumentNodeId = await getFrameDocumentNodeId(client, detailState.resumeIframe.node_id);
      resumeHTML = await getOuterHTML(client, resumeIframeDocumentNodeId);
    } catch (error) {
      errors.push({
        source: "resume_iframe",
        node_id: detailState.resumeIframe.node_id,
        document_node_id: resumeIframeDocumentNodeId,
        stale_node: isStaleRecommendNodeError(error),
        error: error?.message || String(error)
      });
      resumeIframeDocumentNodeId = null;
      resumeHTML = "";
    }
  }

  return {
    popupHTML,
    resumeHTML,
    resumeIframeDocumentNodeId,
    popupText: htmlToText(popupHTML),
    resumeText: htmlToText(resumeHTML),
    errors
  };
}

export function isStaleRecommendNodeError(error) {
  const pattern = /Could not find node with given id|No node with given id|Node with given id does not exist|No node found for given backend id|Invalid (?:backend )?Node\s*Id|Node is detached|Cannot find node|Could not compute box model/i;
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if ((typeof current === "object" || typeof current === "function") && seen.has(current)) break;
    if (typeof current === "object" || typeof current === "function") seen.add(current);
    const message = String(current?.message || current || "");
    if (pattern.test(message)) return true;
    current = current?.cause || null;
  }
  return false;
}

export function isRecommendPreClickStaleNoActionError(error) {
  return Boolean(
    error?.recommend_pre_click_stale_no_action === true
    && error?.recommend_no_click_dispatched === true
    && error?.recommend_input_dispatched === false
    && error?.recommend_pre_click_stage === "pre_click_card_box"
  );
}

export function summarizeRecommendPreClickRetryAttempts(attempts = []) {
  const items = Array.isArray(attempts) ? attempts : [];
  const allPreClickStaleNoAction = Boolean(
    items.length > 0
    && items.every((attempt) => (
      attempt?.stale_node === true
      && attempt?.pre_click_stale_no_action === true
      && attempt?.no_click_dispatched === true
      && attempt?.click_dispatched === false
      && attempt?.input_dispatched === false
      && attempt?.pre_click_stage === "pre_click_card_box"
      && attempt?.exact_candidate_provenance_verified === true
      && attempt?.detail_open_miss !== true
      && attempt?.candidate_binding_mismatch !== true
    ))
  );
  return {
    attempt_count: items.length,
    all_pre_click_stale_no_action: allPreClickStaleNoAction,
    no_click_dispatched: allPreClickStaleNoAction
  };
}

function markRecommendPreClickStaleNoAction(error, {
  nodeId = null,
  stage = "pre_click_card_box"
} = {}) {
  if (!error || !isStaleRecommendNodeError(error)) return error;
  error.recommend_pre_click_stale_no_action = true;
  error.recommend_no_click_dispatched = true;
  error.recommend_click_dispatched = false;
  error.recommend_input_dispatched = false;
  error.recommend_pre_click_stage = stage;
  error.recommend_pre_click_node_id = positiveNodeId(nodeId);
  if (!error.phase) error.phase = stage;
  return error;
}

function createRecommendPreClickCardUnavailableError(binding = null, {
  nodeId = null,
  bindingStage = "card_binding_before_click"
} = {}) {
  const reason = binding?.reason || "card_node_not_visible_or_stale";
  const error = new Error(
    `Could not find node with given id during ${bindingStage}: ${reason}`
  );
  error.code = "RECOMMEND_PRE_CLICK_CARD_UNAVAILABLE";
  error.detail_candidate_binding = binding;
  error.recommend_pre_click_binding_stage = bindingStage;
  return markRecommendPreClickStaleNoAction(error, {
    nodeId,
    stage: "pre_click_card_box"
  });
}

function markRecommendPostInputOutcomeUnknown(error, {
  stage = "post_card_click",
  clickAttempts = null
} = {}) {
  if (!error) return error;
  error.recommend_click_dispatched = true;
  error.recommend_input_dispatched = true;
  error.recommend_post_input_outcome_unknown = true;
  error.recommend_no_click_dispatched = false;
  error.recommend_post_input_stage = stage;
  if (!error.phase) error.phase = stage;
  if (Array.isArray(clickAttempts) && !Array.isArray(error.click_attempts)) {
    error.click_attempts = clickAttempts;
  }
  return error;
}

export function isRecommendDetailOpenMissError(error) {
  const message = String(error?.message || error || "");
  return isRecommendAvatarPreviewOpenError(error)
    || /Candidate detail did not open|no known detail selectors mounted/i.test(message);
}

export function resolveRecommendCardDetailClickPoint(cardBox, {
  attemptIndex = 0
} = {}) {
  const rect = cardBox?.rect || {};
  const width = Number(rect.width) || 0;
  const height = Number(rect.height) || 0;
  if (width <= 2 || height <= 2) {
    return {
      ...(cardBox?.center || { x: 0, y: 0 }),
      mode: "card-center-fallback",
      reason: "invalid_card_rect"
    };
  }

  const xFractions = [0.22, 0.50, 0.72];
  const xFraction = xFractions[Math.min(Math.max(0, attemptIndex), xFractions.length - 1)];
  const minOffsetX = Math.min(width - 12, Math.max(110, Math.min(180, width * 0.18)));
  const maxOffsetX = Math.max(minOffsetX, width - Math.min(220, Math.max(90, width * 0.22)));
  const rawOffsetX = width * xFraction;
  const offsetX = clampPointCoordinate(rawOffsetX, minOffsetX, maxOffsetX);
  const offsetY = clampPointCoordinate(height * 0.28, Math.min(34, height / 2), Math.max(36, height - 28));
  return {
    x: rect.x + offsetX,
    y: rect.y + offsetY,
    mode: "card-body-safe-point",
    attempt_index: attemptIndex,
    offset_x: Math.round(offsetX),
    offset_y: Math.round(offsetY)
  };
}

function resolveRecommendCardDetailClickPointCandidates(cardBox, {
  attemptIndex = 0
} = {}) {
  const primary = resolveRecommendCardDetailClickPoint(cardBox, { attemptIndex });
  const rect = cardBox?.rect || {};
  const height = Number(rect.height) || 0;
  if (height <= 2) {
    return [{
      ...primary,
      x: Math.round(Number(primary.x) || 0),
      y: Math.round(Number(primary.y) || 0),
      hit_test_candidate_index: 0
    }];
  }
  const minOffsetY = Math.min(4, height / 2);
  const maxOffsetY = Math.max(minOffsetY, height - 4);
  const offsets = [
    Number(primary.offset_y),
    height * 0.55,
    height * 0.82
  ];
  const candidates = [];
  const seen = new Set();
  for (const rawOffset of offsets) {
    const offsetY = clampPointCoordinate(rawOffset, minOffsetY, maxOffsetY);
    const point = {
      ...primary,
      x: Math.round(Number(primary.x) || 0),
      y: Math.round((Number(rect.y) || 0) + offsetY),
      offset_y: Math.round(offsetY),
      mode: candidates.length === 0
        ? primary.mode
        : "card-body-safe-point-hit-test-alternate",
      hit_test_candidate_index: candidates.length
    };
    const signature = `${point.x}:${point.y}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    candidates.push(point);
  }
  return candidates;
}

const RECOMMEND_UNSAFE_CARD_CLICK_TAGS = new Set([
  "A",
  "BUTTON",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "LABEL",
  "IMG",
  "SVG"
]);
const RECOMMEND_UNSAFE_CARD_CLICK_ATTRIBUTE_PATTERN = /(?:^|[\s_-])(?:avatar|portrait|head[-_]?img|action|operate|operation|btn|button|check(?:box)?|more|menu|favorite|collect|like|close|icon)(?:$|[\s_-])/i;
const RECOMMEND_UNSAFE_CARD_CLICK_SELECTOR = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "option",
  "label",
  "img",
  "svg",
  '[role="button"]',
  '[class*="avatar"]',
  '[class*="portrait"]',
  '[class*="head-img"]',
  '[class*="head_img"]',
  '[class*="action"]',
  '[class*="operate"]',
  '[class*="operation"]',
  '[class*="btn"]',
  '[class*="button"]',
  '[class*="checkbox"]',
  '[class*="check-box"]',
  '[class*="more"]',
  '[class*="menu"]',
  '[class*="favorite"]',
  '[class*="collect"]',
  '[class*="like"]',
  '[class*="close"]'
].join(", ");

function compactDomNodeAttributes(attributes = []) {
  const values = [];
  for (let index = 0; index < attributes.length; index += 2) {
    const name = String(attributes[index] || "").trim();
    const value = String(attributes[index + 1] || "").trim();
    if (/^(?:class|id|role|aria-label|data-testid)$/i.test(name) && value) {
      values.push(`${name}=${value}`);
    }
  }
  return values.join(" ");
}

async function readRecommendCardClickTargetSafety(client, hitNodeId, cardNodeId, {
  unsafeNodeIds = new Set()
} = {}) {
  const hit = positiveNodeId(hitNodeId);
  const card = positiveNodeId(cardNodeId);
  if (!hit || !card) {
    return {
      verified: false,
      safe: false,
      reason: "card_click_hit_identity_missing",
      path: []
    };
  }
  if (hit === card) {
    return {
      verified: true,
      safe: true,
      reason: null,
      path: []
    };
  }
  const node = await describeNode(client, hit, { depth: 0, pierce: true });
  const nodeName = String(node?.nodeName || "").toUpperCase();
  const attributeText = compactDomNodeAttributes(node?.attributes || []);
  const unsafe = unsafeNodeIds.has(hit)
    || RECOMMEND_UNSAFE_CARD_CLICK_TAGS.has(nodeName)
    || RECOMMEND_UNSAFE_CARD_CLICK_ATTRIBUTE_PATTERN.test(attributeText);
  const path = [{
    node_id: hit,
    backend_node_id: positiveNodeId(node?.backendNodeId),
    node_name: nodeName || null,
    attributes: attributeText || null,
    unsafe
  }];
  if (unsafe) {
    return {
      verified: true,
      safe: false,
      reason: "card_click_point_unsafe_interactive_target",
      path
    };
  }
  return {
    verified: true,
    safe: true,
    reason: null,
    path
  };
}

async function readRecommendCardClickHitTestEvidence(client, nodeId, cardBox, {
  attemptIndex = 0,
  viewport = null
} = {}) {
  if (typeof client?.DOM?.getNodeForLocation !== "function") {
    return {
      completed: false,
      exact_card_hit_verified: false,
      reason: "card_click_hit_test_unavailable",
      selected: null,
      attempts: []
    };
  }
  let descendantNodeIds;
  let unsafeNodeIds;
  try {
    descendantNodeIds = new Set([
      positiveNodeId(nodeId),
      ...(await querySelectorAll(client, nodeId, "*")).map(positiveNodeId)
    ].filter(Boolean));
    unsafeNodeIds = new Set();
    const unsafeRoots = (await querySelectorAll(
      client,
      nodeId,
      RECOMMEND_UNSAFE_CARD_CLICK_SELECTOR
    )).map(positiveNodeId).filter(Boolean);
    for (const unsafeRootNodeId of unsafeRoots.slice(0, 48)) {
      unsafeNodeIds.add(unsafeRootNodeId);
      for (const unsafeDescendantNodeId of (
        await querySelectorAll(client, unsafeRootNodeId, "*")
      ).map(positiveNodeId).filter(Boolean).slice(0, 96)) {
        unsafeNodeIds.add(unsafeDescendantNodeId);
      }
    }
  } catch (error) {
    if (isStaleRecommendNodeError(error)) {
      throw markRecommendPreClickStaleNoAction(error, {
        nodeId,
        stage: "pre_click_card_hit_test"
      });
    }
    throw error;
  }
  const width = Number(viewport?.width || 0);
  const height = Number(viewport?.height || 0);
  const margin = Math.max(0, Number(viewport?.margin_px) || 0);
  const attempts = [];
  for (const point of resolveRecommendCardDetailClickPointCandidates(cardBox, { attemptIndex })) {
    const insideViewport = Boolean(
      Number.isFinite(point.x)
      && Number.isFinite(point.y)
      && point.x >= margin
      && point.x <= width - margin
      && point.y >= margin
      && point.y <= height - margin
    );
    if (!insideViewport) {
      attempts.push({
        point,
        inside_viewport: false,
        exact_card_hit: false,
        hit_node_id: null,
        hit_backend_node_id: null,
        reason: "card_click_point_outside_viewport"
      });
      continue;
    }
    const hit = await client.DOM.getNodeForLocation({
      x: Math.round(point.x),
      y: Math.round(point.y),
      includeUserAgentShadowDOM: true
    });
    const hitNodeId = positiveNodeId(hit?.nodeId);
    const exactCardHit = Boolean(hitNodeId && descendantNodeIds.has(hitNodeId));
    const targetSafety = exactCardHit
      ? await readRecommendCardClickTargetSafety(client, hitNodeId, nodeId, {
          unsafeNodeIds
        })
      : null;
    const safeCardBodyHit = Boolean(
      exactCardHit
      && targetSafety?.verified === true
      && targetSafety?.safe === true
    );
    const evidence = {
      point,
      inside_viewport: true,
      exact_card_hit: exactCardHit,
      safe_card_hit: safeCardBodyHit,
      safe_card_body_hit: safeCardBodyHit,
      hit_node_id: hitNodeId,
      hit_node_name: targetSafety?.path?.[0]?.node_name || null,
      hit_backend_node_id: positiveNodeId(hit?.backendNodeId),
      hit_frame_id: hit?.frameId || null,
      target_safety: targetSafety,
      reason: safeCardBodyHit
        ? null
        : exactCardHit
        ? targetSafety?.reason || "card_click_point_not_safe_card_body"
        : "card_click_point_not_owned_by_exact_card"
    };
    attempts.push(evidence);
    if (safeCardBodyHit) {
      return {
        completed: true,
        exact_card_hit_verified: true,
        reason: null,
        selected: point,
        descendant_count: descendantNodeIds.size,
        unsafe_descendant_count: unsafeNodeIds.size,
        attempts
      };
    }
  }
  return {
    completed: true,
    exact_card_hit_verified: false,
    reason: attempts.find((attempt) => attempt.inside_viewport)?.reason
      || (attempts.some((attempt) => attempt.inside_viewport)
        ? "card_click_point_not_owned_by_exact_card"
        : "card_click_point_outside_viewport"),
    selected: null,
    descendant_count: descendantNodeIds.size,
    unsafe_descendant_count: unsafeNodeIds.size,
    attempts
  };
}

export async function readRecommendCardClickViewportEvidence(client, nodeId, {
  attemptIndex = 0,
  marginPx = 4
} = {}) {
  let box;
  try {
    box = await getNodeBox(client, nodeId);
  } catch (error) {
    throw markRecommendPreClickStaleNoAction(error, {
      nodeId,
      stage: "pre_click_card_box"
    });
  }
  const fallbackClickTarget = resolveRecommendCardDetailClickPoint(box, { attemptIndex });
  let metrics;
  try {
    metrics = typeof client?.Page?.getLayoutMetrics === "function"
      ? await client.Page.getLayoutMetrics()
      : null;
  } catch (error) {
    // Keep raw Page/session failures generic.  They must never be promoted to
    // the narrow candidate-local all-pre-click-stale disposition.
    throw error;
  }
  const viewport = metrics?.cssVisualViewport
    || metrics?.visualViewport
    || metrics?.cssLayoutViewport
    || metrics?.layoutViewport
    || null;
  const width = Number(viewport?.clientWidth || viewport?.width || 0);
  const height = Number(viewport?.clientHeight || viewport?.height || 0);
  const margin = Math.max(0, Number(marginPx) || 0);
  const metricsVerified = Boolean(
    Number.isFinite(width)
    && width > margin * 2
    && Number.isFinite(height)
    && height > margin * 2
  );
  const viewportEvidence = {
    width,
    height,
    margin_px: margin,
    source: metrics?.cssVisualViewport
      ? "cssVisualViewport"
      : metrics?.visualViewport
      ? "visualViewport"
      : metrics?.cssLayoutViewport
      ? "cssLayoutViewport"
      : metrics?.layoutViewport
      ? "layoutViewport"
      : null
  };
  const hitTest = metricsVerified
    ? await readRecommendCardClickHitTestEvidence(client, nodeId, box, {
        attemptIndex,
        viewport: viewportEvidence
      })
    : {
        completed: false,
        exact_card_hit_verified: false,
        reason: "card_click_viewport_metrics_missing",
        selected: null,
        attempts: []
      };
  const pointVerified = Boolean(
    metricsVerified
    && hitTest.completed === true
    && hitTest.exact_card_hit_verified === true
    && hitTest.selected
  );
  const clickTarget = hitTest.selected || fallbackClickTarget;
  return {
    verified: metricsVerified && hitTest.completed === true,
    in_viewport: pointVerified,
    reason: !metricsVerified
      ? "card_click_viewport_metrics_missing"
      : pointVerified
      ? null
      : hitTest.reason || "card_click_point_not_owned_by_exact_card",
    node_id: positiveNodeId(nodeId),
    box,
    click_target: clickTarget,
    hit_test: hitTest,
    viewport: viewportEvidence
  };
}

function createRecommendCardClickViewportProofError(evidence, reason = "card_click_viewport_unverified") {
  const error = new Error(`Recommend card click viewport proof failed: ${reason}`);
  error.code = "RECOMMEND_CARD_CLICK_VIEWPORT_UNVERIFIED";
  error.phase = "pre_click_card_viewport";
  error.recommend_card_click_viewport = evidence || null;
  error.recommend_no_click_dispatched = true;
  error.recommend_click_dispatched = false;
  error.recommend_input_dispatched = false;
  return error;
}

async function clickRecommendCardDetailPoint(client, nodeId, {
  scrollIntoView = true,
  attemptIndex = 0,
  preverifiedCardBox = null
} = {}) {
  if (scrollIntoView) {
    try {
      await scrollNodeIntoView(client, nodeId);
      await sleep(150);
    } catch {
      // Recommend list cards are selected from visible nodes; if this CDP
      // helper races the virtual list, let the box lookup/retry decide.
    }
  }
  // Re-run geometry plus native hit-testing immediately before Input.  A box
  // can be inside the numeric viewport while its nominal point is covered by
  // BOSS's fixed filter header.  Only a point whose topmost hit node belongs
  // to this exact card (or one of its descendants) is authorized.
  const clickViewport = await readRecommendCardClickViewportEvidence(client, nodeId, {
    attemptIndex
  });
  if (!clickViewport.verified || !clickViewport.in_viewport) {
    throw createRecommendCardClickViewportProofError(
      clickViewport,
      clickViewport.reason || "card_click_hit_test_unverified"
    );
  }
  const box = clickViewport.box || preverifiedCardBox;
  const clickTarget = clickViewport.click_target;
  let clickResult;
  try {
    clickResult = await clickPoint(
      client,
      clickTarget.x,
      clickTarget.y,
      DETERMINISTIC_CLICK_OPTIONS
    );
  } catch (error) {
    // Once clickPoint is entered, at least one Input command may have reached
    // Chrome.  Treat every failure as outcome-unknown and never replay it.
    throw markRecommendPostInputOutcomeUnknown(error, {
      stage: "card_click_input"
    });
  }
  return {
    ...box,
    click_target: clickTarget,
    click_result: clickResult,
    click_viewport: clickViewport
  };
}

async function waitForRecommendDetailOpenOutcome(client, {
  timeoutMs = 10000,
  intervalMs = 250
} = {}) {
  const started = Date.now();
  let detailState = null;
  let avatarPreview = null;
  while (Date.now() - started <= timeoutMs) {
    detailState = await readRecommendDetailState(client);
    if (detailState?.popup || detailState?.resumeIframe) {
      return {
        kind: "detail",
        elapsed_ms: Date.now() - started,
        detail_state: detailState
      };
    }
    avatarPreview = await readRecommendAvatarPreviewState(client);
    if (avatarPreview.open) {
      return {
        kind: "avatar_preview",
        elapsed_ms: Date.now() - started,
        avatar_preview: avatarPreview
      };
    }
    await sleep(intervalMs);
  }
  return {
    kind: "none",
    elapsed_ms: Date.now() - started,
    detail_state: detailState,
    avatar_preview: avatarPreview
  };
}

function makeRecommendAvatarPreviewOpenedError(outcome, clickAttempts = []) {
  const error = new Error("RECOMMEND_AVATAR_PREVIEW_OPENED: candidate avatar preview opened instead of resume detail");
  error.code = "RECOMMEND_AVATAR_PREVIEW_OPENED";
  error.avatar_preview = outcome?.avatar_preview || null;
  error.click_attempts = clickAttempts;
  error.recommend_click_dispatched = clickAttempts.length > 0;
  error.recommend_input_dispatched = clickAttempts.length > 0;
  return error;
}

export async function findRecommendCardNodeForCandidateKey(client, {
  candidateKey = "",
  rootState = null,
  targetUrl = "",
  source = "recommend-run-card-retry",
  timeoutMs = 5000,
  intervalMs = 250
} = {}) {
  if (!candidateKey) {
    return {
      ok: false,
      reason: "candidate_key_required"
    };
  }

  const started = Date.now();
  let lastError = null;
  let lastCardCount = 0;
  while (Date.now() - started <= timeoutMs) {
    const currentRootState = rootState?.iframe?.documentNodeId
      ? rootState
      : await getRecommendRoots(client);
    const frameNodeId = currentRootState?.iframe?.documentNodeId;
    if (!frameNodeId) {
      return {
        ok: false,
        reason: "recommend_frame_not_found"
      };
    }

    let nodeIds = [];
    try {
      nodeIds = await findRecommendCardNodeIds(client, frameNodeId);
    } catch (error) {
      lastError = error;
      if (!isStaleRecommendNodeError(error)) throw error;
      rootState = null;
      if (intervalMs > 0) await sleep(intervalMs);
      continue;
    }
    lastCardCount = nodeIds.length;
    for (let visibleIndex = 0; visibleIndex < nodeIds.length; visibleIndex += 1) {
      const nodeId = nodeIds[visibleIndex];
      try {
        const candidate = await readRecommendCardCandidate(client, nodeId, {
          targetUrl,
          source,
          metadata: {
            visible_index: visibleIndex,
            retry_reason: "stale_detail_node"
          }
        });
        const key = candidateKeyFromProfile(candidate, {
          nodeId,
          visibleIndex,
          attributes: candidate?.attributes || candidate?.metadata?.attributes || {}
        });
        if (key === candidateKey) {
          return {
            ok: true,
            node_id: nodeId,
            visible_index: visibleIndex,
            candidate,
            key,
            root_state: currentRootState,
            card_count: nodeIds.length
          };
        }
      } catch (error) {
        lastError = error;
        if (shouldRethrowRecommendProtocolError(error)) throw error;
      }
    }

    if (intervalMs > 0) await sleep(intervalMs);
    rootState = null;
  }

  return {
    ok: false,
    reason: "candidate_key_not_mounted",
    candidate_key: candidateKey,
    last_card_count: lastCardCount,
    error: lastError?.message || null
  };
}

export async function openRecommendCardDetail(client, cardNodeId, {
  timeoutMs = 12000,
  scrollIntoView = true,
  preverifiedCardBox = null
} = {}) {
  const started = Date.now();
  const clickAttempts = [];
  // One fully proven card node authorizes exactly one irreversible Input
  // sequence.  Any retry belongs to the outer exact-key reacquire loop, which
  // reruns candidate/root/backend provenance before another click.
  const maxClickAttempts = 1;
  let lastOutcome = null;
  let lastCardBox = null;
  let candidateClickMs = 0;
  let detailOpenMs = 0;

  for (let attemptIndex = 0; attemptIndex < maxClickAttempts; attemptIndex += 1) {
    const clickStarted = Date.now();
    lastCardBox = await clickRecommendCardDetailPoint(client, cardNodeId, {
      scrollIntoView: attemptIndex === 0 ? scrollIntoView : false,
      attemptIndex,
      preverifiedCardBox: attemptIndex === 0 ? preverifiedCardBox : null
    });
    candidateClickMs += Date.now() - clickStarted;
    const clickAttempt = {
      attempt: attemptIndex + 1,
      click_target: lastCardBox.click_target,
      click_result: lastCardBox.click_result,
      input_dispatched: true,
      outcome: "pending",
      elapsed_ms: null
    };
    // Persist the irreversible fact before any detail-state polling.  A stale
    // read after this point must never authorize another click.
    clickAttempts.push(clickAttempt);
    const detailStarted = Date.now();
    try {
      lastOutcome = await waitForRecommendDetailOpenOutcome(client, {
        timeoutMs: attemptIndex === 0 ? timeoutMs : Math.max(2500, Math.floor(timeoutMs / 3)),
        intervalMs: 250
      });
    } catch (error) {
      clickAttempt.outcome = "detail_state_poll_failed";
      clickAttempt.elapsed_ms = Date.now() - detailStarted;
      throw markRecommendPostInputOutcomeUnknown(error, {
        stage: "post_card_click_detail_poll",
        clickAttempts
      });
    }
    detailOpenMs += Date.now() - detailStarted;
    clickAttempt.outcome = lastOutcome.kind;
    clickAttempt.elapsed_ms = lastOutcome.elapsed_ms;

    if (lastOutcome.kind === "detail") {
      return {
        card_box: lastCardBox,
        click_attempts: clickAttempts,
        detail_state: lastOutcome.detail_state,
        timings: {
          candidate_click_ms: candidateClickMs,
          detail_open_ms: detailOpenMs,
          open_total_ms: Date.now() - started
        }
      };
    }

    if (lastOutcome.kind === "avatar_preview") {
      await closeRecommendAvatarPreview(client, { attemptsLimit: 2, waitMs: 350 });
      throw makeRecommendAvatarPreviewOpenedError(lastOutcome, clickAttempts);
    }
    break;
  }

  if (lastOutcome?.kind === "avatar_preview") {
    throw makeRecommendAvatarPreviewOpenedError(lastOutcome, clickAttempts);
  }
  const error = new Error("Candidate detail did not open or no known detail selectors mounted");
  error.click_attempts = clickAttempts;
  error.last_open_outcome = lastOutcome;
  error.recommend_click_dispatched = clickAttempts.length > 0;
  error.recommend_input_dispatched = clickAttempts.length > 0;
  // A completed polling window with kind=none is an exact negative outcome,
  // not an unknown transport result.  The outer loop may reacquire/reprove the
  // candidate before one further click.
  error.recommend_click_negative_outcome_observed = Boolean(
    clickAttempts.length > 0 && lastOutcome?.kind === "none"
  );
  error.recommend_post_input_outcome_unknown = false;
  throw error;
}

function attachRecommendDetailOpenRetryEvidence(error, attempts, {
  retryExhausted = false,
  reacquireFailed = false,
  expectedAttemptCount = null
} = {}) {
  const retrySummary = summarizeRecommendPreClickRetryAttempts(attempts);
  const expectedCount = Math.max(1, Number(expectedAttemptCount) || 1);
  const candidateLocalExhaustion = Boolean(
    retryExhausted === true
    && reacquireFailed !== true
    && retrySummary.attempt_count === expectedCount
    && retrySummary.all_pre_click_stale_no_action
  );
  error.recommend_detail_open_attempts = attempts;
  error.recommend_pre_click_retry = {
    ...retrySummary,
    retry_exhausted: retryExhausted === true,
    reacquire_failed: reacquireFailed === true,
    expected_attempt_count: expectedCount,
    candidate_local_exhaustion: candidateLocalExhaustion
  };
  if (candidateLocalExhaustion) {
    error.recommend_pre_click_stale_no_action = true;
    error.recommend_no_click_dispatched = true;
    error.recommend_click_dispatched = false;
    error.recommend_input_dispatched = false;
    error.recommend_pre_click_stage = "pre_click_card_box";
    error.recommend_pre_click_retry_exhausted = true;
    error.recommend_pre_click_reacquire_failed = false;
  }
  return error;
}

export async function openRecommendCardDetailWithFreshRetry(client, {
  cardNodeId,
  candidateKey = "",
  cardCandidate = null,
  rootState = null,
  targetUrl = "",
  timeoutMs = 12000,
  scrollIntoView = true,
  retryTimeoutMs = 5000,
  retryIntervalMs = 250,
  bindingTimeoutMs = 5000,
  bindingIntervalMs = 200,
  bindingMaxAttempts = 20,
  acceptScreeningBinding = false,
  maxAttempts = 2
} = {}) {
  let currentNodeId = cardNodeId;
  let currentCandidate = cardCandidate;
  let currentRootState = rootState;
  const attempts = [];
  const cumulativeClickAttempts = [];
  const limit = Math.max(1, Number(maxAttempts) || 1);

  for (let attemptIndex = 0; attemptIndex < limit; attemptIndex += 1) {
    let exactCandidateProvenanceVerified = false;
    let inputDispatchedWithinAttempt = false;
    let clickAttemptsRecordedWithinAttempt = false;
    let viewportPreparation = null;
    try {
      const initialViewport = await readRecommendCardClickViewportEvidence(
        client,
        currentNodeId,
        { attemptIndex: 0 }
      );
      viewportPreparation = {
        initial: initialViewport,
        scrolled: false,
        reacquire: null,
        final: null
      };
      if (!initialViewport.verified) {
        throw createRecommendCardClickViewportProofError(
          initialViewport,
          initialViewport.reason || "initial_card_click_viewport_unverified"
        );
      }
      if (!initialViewport.in_viewport) {
        if (!scrollIntoView || !candidateKey) {
          throw createRecommendCardClickViewportProofError(
            initialViewport,
            !scrollIntoView
              ? "card_click_point_outside_viewport_and_scroll_disabled"
              : "candidate_key_required_for_post_scroll_reacquire"
          );
        }

        // Scrolling is preparation only.  The old node is never clicked:
        // Boss may remount its virtual list while the scroll settles.
        await scrollNodeIntoView(client, currentNodeId);
        await sleep(150);
        viewportPreparation.scrolled = true;
        const postScrollResolved = await findRecommendCardNodeForCandidateKey(client, {
          candidateKey,
          rootState: currentRootState,
          targetUrl,
          source: "recommend-run-card-post-scroll-reacquire",
          timeoutMs: retryTimeoutMs,
          intervalMs: retryIntervalMs
        });
        viewportPreparation.reacquire = {
          ok: Boolean(postScrollResolved.ok),
          node_id: positiveNodeId(postScrollResolved.node_id),
          visible_index: postScrollResolved.visible_index ?? null,
          card_count: postScrollResolved.card_count || postScrollResolved.last_card_count || 0,
          candidate_key: postScrollResolved.key || null,
          reason: postScrollResolved.reason || null,
          error: postScrollResolved.error || null
        };
        if (
          !postScrollResolved.ok
          || !postScrollResolved.node_id
          || postScrollResolved.key !== candidateKey
        ) {
          throw createRecommendDetailCandidateBindingError({
            schema_version: 1,
            verified: false,
            reason: "card_not_exactly_reacquired_after_pre_scroll",
            method: null,
            expected_candidate_id: normalizeBindingText(currentCandidate?.id) || null,
            expected_name: normalizeBindingText(currentCandidate?.identity?.name) || null,
            card: {
              stable: false,
              before: null,
              after: null,
              candidate_id: normalizeBindingText(postScrollResolved.candidate?.id) || null,
              name: normalizeBindingText(postScrollResolved.candidate?.identity?.name) || null,
              reason: "card_not_exactly_reacquired_after_pre_scroll"
            },
            detail: null
          });
        }
        currentNodeId = postScrollResolved.node_id;
        currentCandidate = postScrollResolved.candidate || currentCandidate;
        currentRootState = postScrollResolved.root_state || null;
      }

      // Snapshot detail roots only after any scroll/remount and exact-key
      // reacquire, then rerun full candidate/root/backend provenance.
      // Keep the pre-click detail snapshot in the same frontend-node tree as
      // the exact card/root proof below.  Fetching another document root here
      // can replace frontend node ids even while backend identity is stable.
      const detailRootsBefore = await readRecommendDetailRootsBeforeClick(client, {
        rootState: currentRootState
      });
      let cardEvidenceBefore = await readRecommendCardBindingEvidence(
        client,
        currentNodeId,
        currentCandidate
      );
      if (!cardEvidenceBefore.verified) {
        if (cardEvidenceBefore.reason === "card_node_not_visible_or_stale") {
          throw createRecommendPreClickCardUnavailableError(cardEvidenceBefore, {
            nodeId: currentNodeId,
            bindingStage: "card_binding_before_click"
          });
        }
        throw createRecommendDetailCandidateBindingError({
          schema_version: 1,
          verified: false,
          reason: cardEvidenceBefore.reason || "card_identity_not_verified_before_click",
          method: null,
          expected_candidate_id: normalizeBindingText(currentCandidate?.id) || null,
          expected_name: normalizeBindingText(currentCandidate?.identity?.name) || null,
          card: {
            stable: false,
            before: compactBindingNode(cardEvidenceBefore),
            after: null,
            candidate_id: cardEvidenceBefore.candidate_id || null,
            name: cardEvidenceBefore.name || null,
            reason: cardEvidenceBefore.reason || null
          },
          detail: null
        });
      }
      let cardPreClickProvenance = await readRecommendCardPreClickProvenance(client, {
        cardNodeId: currentNodeId,
        cardCandidate: currentCandidate,
        rootState: currentRootState,
        cardEvidence: cardEvidenceBefore
      });
      if (!cardPreClickProvenance.verified) {
        throw createRecommendDetailCandidateBindingError({
          schema_version: 1,
          verified: false,
          reason: cardPreClickProvenance.reason || "card_pre_click_provenance_unverified",
          method: null,
          expected_candidate_id: normalizeBindingText(currentCandidate?.id) || null,
          expected_name: normalizeBindingText(currentCandidate?.identity?.name) || null,
          card: {
            stable: false,
            disappeared_after_click: false,
            before: compactBindingNode(cardEvidenceBefore),
            after: null,
            candidate_id: cardEvidenceBefore.candidate_id || null,
            name: cardEvidenceBefore.name || null,
            reason: cardPreClickProvenance.reason || null,
            pre_click_provenance: compactRecommendCardPreClickProvenance(
              cardPreClickProvenance
            )
          },
          detail: null
        });
      }
      const cardIdentityImmediatelyBeforeClick = await readRecommendCardBindingEvidence(
        client,
        currentNodeId,
        currentCandidate
      );
      if (!cardIdentityImmediatelyBeforeClick.verified) {
        if (cardIdentityImmediatelyBeforeClick.reason === "card_node_not_visible_or_stale") {
          throw createRecommendPreClickCardUnavailableError(
            cardIdentityImmediatelyBeforeClick,
            {
              nodeId: currentNodeId,
              bindingStage: "card_identity_immediately_before_click"
            }
          );
        }
        throw createRecommendDetailCandidateBindingError({
          schema_version: 1,
          verified: false,
          reason: cardIdentityImmediatelyBeforeClick.reason
            || "card_identity_not_verified_immediately_before_click",
          method: null,
          expected_candidate_id: normalizeBindingText(currentCandidate?.id) || null,
          expected_name: normalizeBindingText(currentCandidate?.identity?.name) || null,
          card: {
            stable: false,
            before: compactBindingNode(cardEvidenceBefore),
            after: compactBindingNode(cardIdentityImmediatelyBeforeClick),
            candidate_id: cardIdentityImmediatelyBeforeClick.candidate_id || null,
            name: cardIdentityImmediatelyBeforeClick.name || null,
            reason: cardIdentityImmediatelyBeforeClick.reason || null,
            pre_click_provenance: compactRecommendCardPreClickProvenance(
              cardPreClickProvenance
            )
          },
          detail: null
        });
      }
      if (
        positiveNodeId(cardIdentityImmediatelyBeforeClick.backend_node_id)
          !== positiveNodeId(cardEvidenceBefore.backend_node_id)
      ) {
        throw createRecommendDetailCandidateBindingError({
          schema_version: 1,
          verified: false,
          reason: "card_backend_changed_immediately_before_click",
          method: null,
          expected_candidate_id: normalizeBindingText(currentCandidate?.id) || null,
          expected_name: normalizeBindingText(currentCandidate?.identity?.name) || null,
          card: {
            stable: false,
            before: compactBindingNode(cardEvidenceBefore),
            after: compactBindingNode(cardIdentityImmediatelyBeforeClick),
            candidate_id: cardIdentityImmediatelyBeforeClick.candidate_id || null,
            name: cardIdentityImmediatelyBeforeClick.name || null,
            reason: "card_backend_changed_immediately_before_click",
            pre_click_provenance: compactRecommendCardPreClickProvenance(
              cardPreClickProvenance
            )
          },
          detail: null
        });
      }
      cardEvidenceBefore = cardIdentityImmediatelyBeforeClick;
      cardPreClickProvenance.card = cardIdentityImmediatelyBeforeClick;
      cardPreClickProvenance.card_identity_recheck = cardIdentityImmediatelyBeforeClick;
      exactCandidateProvenanceVerified = true;
      const finalViewport = await readRecommendCardClickViewportEvidence(
        client,
        currentNodeId,
        { attemptIndex: 0 }
      );
      viewportPreparation.final = finalViewport;
      if (!finalViewport.verified) {
        throw createRecommendCardClickViewportProofError(
          finalViewport,
          finalViewport.reason || "final_card_click_viewport_unverified"
        );
      }
      if (!finalViewport.in_viewport) {
        const viewportBindingError = createRecommendDetailCandidateBindingError({
          schema_version: 1,
          verified: false,
          reason: finalViewport.reason
            ? `exact_card_click_target_unverified_after_preparation:${finalViewport.reason}`
            : "exact_card_click_point_outside_viewport_after_preparation",
          method: null,
          expected_candidate_id: normalizeBindingText(currentCandidate?.id) || null,
          expected_name: normalizeBindingText(currentCandidate?.identity?.name) || null,
          card: {
            stable: false,
            before: compactBindingNode(cardEvidenceBefore),
            after: compactBindingNode(cardIdentityImmediatelyBeforeClick),
            candidate_id: cardIdentityImmediatelyBeforeClick.candidate_id || null,
            name: cardIdentityImmediatelyBeforeClick.name || null,
            reason: finalViewport.reason
              ? `exact_card_click_target_unverified_after_preparation:${finalViewport.reason}`
              : "exact_card_click_point_outside_viewport_after_preparation",
            pre_click_provenance: compactRecommendCardPreClickProvenance(
              cardPreClickProvenance
            ),
            click_viewport: finalViewport
          },
          detail: null
        });
        viewportBindingError.recommend_no_click_dispatched = true;
        viewportBindingError.recommend_click_dispatched = false;
        viewportBindingError.recommend_input_dispatched = false;
        viewportBindingError.recommend_pre_click_stage = "final_card_click_target_proof";
        viewportBindingError.recommend_card_click_viewport = finalViewport;
        throw viewportBindingError;
      }
      // The viewport read itself is asynchronous and may trigger a virtual
      // list update.  Reprove exact ID/name/backend once more after geometry,
      // then use the already-proven box with no intervening DOM operation.
      const cardIdentityAfterFinalViewport = await readRecommendCardBindingEvidence(
        client,
        currentNodeId,
        currentCandidate
      );
      if (
        !cardIdentityAfterFinalViewport.verified
        && cardIdentityAfterFinalViewport.reason === "card_node_not_visible_or_stale"
      ) {
        throw createRecommendPreClickCardUnavailableError(cardIdentityAfterFinalViewport, {
          nodeId: currentNodeId,
          bindingStage: "card_identity_after_final_viewport"
        });
      }
      if (
        !cardIdentityAfterFinalViewport.verified
        || positiveNodeId(cardIdentityAfterFinalViewport.backend_node_id)
          !== positiveNodeId(cardEvidenceBefore.backend_node_id)
      ) {
        throw createRecommendDetailCandidateBindingError({
          schema_version: 1,
          verified: false,
          reason: !cardIdentityAfterFinalViewport.verified
            ? cardIdentityAfterFinalViewport.reason
              || "card_identity_changed_after_final_viewport_proof"
            : "card_backend_changed_after_final_viewport_proof",
          method: null,
          expected_candidate_id: normalizeBindingText(currentCandidate?.id) || null,
          expected_name: normalizeBindingText(currentCandidate?.identity?.name) || null,
          card: {
            stable: false,
            before: compactBindingNode(cardEvidenceBefore),
            after: compactBindingNode(cardIdentityAfterFinalViewport),
            candidate_id: cardIdentityAfterFinalViewport.candidate_id || null,
            name: cardIdentityAfterFinalViewport.name || null,
            reason: !cardIdentityAfterFinalViewport.verified
              ? cardIdentityAfterFinalViewport.reason || null
              : "card_backend_changed_after_final_viewport_proof",
            pre_click_provenance: compactRecommendCardPreClickProvenance(
              cardPreClickProvenance
            ),
            click_viewport: finalViewport
          },
          detail: null
        });
      }
      cardEvidenceBefore = cardIdentityAfterFinalViewport;
      const cardProvenanceAfterFinalViewport = await readRecommendCardPreClickProvenance(
        client,
        {
          cardNodeId: currentNodeId,
          cardCandidate: currentCandidate,
          rootState: currentRootState,
          cardEvidence: cardIdentityAfterFinalViewport
        }
      );
      if (!cardProvenanceAfterFinalViewport.verified) {
        throw createRecommendDetailCandidateBindingError({
          schema_version: 1,
          verified: false,
          reason: cardProvenanceAfterFinalViewport.reason
            || "card_root_provenance_changed_after_final_viewport_proof",
          method: null,
          expected_candidate_id: normalizeBindingText(currentCandidate?.id) || null,
          expected_name: normalizeBindingText(currentCandidate?.identity?.name) || null,
          card: {
            stable: false,
            before: compactBindingNode(cardEvidenceBefore),
            after: compactBindingNode(cardIdentityAfterFinalViewport),
            candidate_id: cardIdentityAfterFinalViewport.candidate_id || null,
            name: cardIdentityAfterFinalViewport.name || null,
            reason: cardProvenanceAfterFinalViewport.reason || null,
            pre_click_provenance: compactRecommendCardPreClickProvenance(
              cardProvenanceAfterFinalViewport
            ),
            click_viewport: finalViewport
          },
          detail: null
        });
      }
      cardPreClickProvenance = cardProvenanceAfterFinalViewport;
      cardPreClickProvenance.card = cardIdentityAfterFinalViewport;
      cardPreClickProvenance.card_identity_recheck = cardIdentityAfterFinalViewport;
      const opened = await openRecommendCardDetail(client, currentNodeId, {
        timeoutMs,
        // No scroll or second box lookup is allowed after the final exact
        // provenance + viewport proof.  This box authorizes one click only.
        scrollIntoView: false,
        preverifiedCardBox: finalViewport.box
      });
      appendCumulativeRecommendCardClickAttempts(
        cumulativeClickAttempts,
        opened?.click_attempts || []
      );
      clickAttemptsRecordedWithinAttempt = true;
      inputDispatchedWithinAttempt = cumulativeClickAttempts.some(
        (attempt) => attempt?.input_dispatched === true
      );
      const candidateBinding = await waitForRecommendDetailCandidateBinding(client, {
        cardNodeId: currentNodeId,
        cardCandidate: currentCandidate,
        detailState: opened.detail_state,
        cardEvidenceBefore,
        cardPreClickProvenance,
        detailRootsBefore,
        allowCardDisappearance: true,
        cardClickEvidence: opened?.card_box?.click_viewport || null,
        clickAttempts: cumulativeClickAttempts,
        timeoutMs: bindingTimeoutMs,
        intervalMs: bindingIntervalMs,
        maxAttempts: bindingMaxAttempts,
        acceptScreeningBinding
      });
      const acceptedCandidateBinding = Boolean(
        candidateBinding.verified === true
        || (
          acceptScreeningBinding === true
          && candidateBinding.screening_verified === true
        )
      );
      if (!acceptedCandidateBinding) {
        const bindingError = createRecommendDetailCandidateBindingError(candidateBinding);
        bindingError.click_attempts = cumulativeClickAttempts;
        bindingError.recommend_click_dispatched = true;
        bindingError.recommend_input_dispatched = true;
        bindingError.recommend_no_click_dispatched = false;
        bindingError.recommend_post_input_outcome_unknown = false;
        bindingError.recommend_post_input_stage = "post_card_click_binding";
        bindingError.recommend_clean_pre_action_detail_binding_timeout =
          isCleanRecommendPostClickBindingReadinessTimeout(
            candidateBinding,
            cumulativeClickAttempts
          );
        bindingError.recommend_card_click_viewport = opened?.card_box?.click_viewport || null;
        throw bindingError;
      }
      return {
        ...opened,
        detail_state: {
          ...(candidateBinding.observed_detail_state || opened.detail_state),
          candidate_binding: candidateBinding,
          candidate_binding_context: {
            card_pre_click_provenance: candidateBinding?.card?.pre_click_provenance || null,
            detail_roots_before: candidateBinding?.detail?.roots_before_capture || null,
            expected_detail_root: candidateBinding?.detail?.root || null,
            allow_card_disappearance: true,
            card_click_evidence: candidateBinding?.card?.click_evidence || null,
            click_attempts: candidateBinding?.card?.click_attempts || []
          }
        },
        card_node_id: currentNodeId,
        card_candidate: currentCandidate,
        candidate_binding: candidateBinding,
        retry_attempts: attempts,
        viewport_preparation: viewportPreparation
      };
    } catch (error) {
      if (!clickAttemptsRecordedWithinAttempt) {
        appendCumulativeRecommendCardClickAttempts(
          cumulativeClickAttempts,
          error?.click_attempts || []
        );
      }
      const candidateBindingMismatch = isRecommendDetailCandidateBindingError(error);
      if (
        inputDispatchedWithinAttempt
        && !candidateBindingMismatch
        && error?.recommend_input_dispatched !== true
      ) {
        markRecommendPostInputOutcomeUnknown(error, {
          stage: "post_card_click_binding"
        });
      }
      const stale = isStaleRecommendNodeError(error);
      const detailOpenMiss = isRecommendDetailOpenMissError(error);
      const preClickStaleNoAction = isRecommendPreClickStaleNoActionError(error);
      const clickDispatched = error?.recommend_click_dispatched === true
        ? true
        : error?.recommend_click_dispatched === false
          || error?.recommend_no_click_dispatched === true
        ? false
        : null;
      const inputDispatched = error?.recommend_input_dispatched === true
        ? true
        : error?.recommend_input_dispatched === false
        ? false
        : null;
      attempts.push({
        attempt: attemptIndex + 1,
        node_id: currentNodeId,
        stale_node: stale,
        detail_open_miss: detailOpenMiss,
        candidate_binding_mismatch: candidateBindingMismatch,
        pre_click_stale_no_action: preClickStaleNoAction,
        no_click_dispatched: error?.recommend_no_click_dispatched === true,
        click_dispatched: clickDispatched,
        input_dispatched: inputDispatched,
        pre_click_stage: error?.recommend_pre_click_stage || null,
        pre_click_node_id: positiveNodeId(error?.recommend_pre_click_node_id),
        exact_candidate_provenance_verified: exactCandidateProvenanceVerified,
        viewport_preparation: viewportPreparation,
        candidate_binding: error?.detail_candidate_binding || null,
        click_attempts: compactRecommendCardClickAttempts(error?.click_attempts || []),
        cumulative_click_attempt_count: cumulativeClickAttempts.length,
        error: error?.message || String(error)
      });
      if (
        (inputDispatched === true && error?.recommend_click_negative_outcome_observed !== true)
        || candidateBindingMismatch
        || (!stale && !detailOpenMiss)
        || attemptIndex >= limit - 1
        || !candidateKey
      ) {
        throw attachRecommendDetailOpenRetryEvidence(error, attempts, {
          retryExhausted: attemptIndex >= limit - 1,
          expectedAttemptCount: limit
        });
      }

      const resolved = await findRecommendCardNodeForCandidateKey(client, {
        candidateKey,
        rootState: currentRootState,
        targetUrl,
        timeoutMs: retryTimeoutMs,
        intervalMs: retryIntervalMs
      });
      attempts[attempts.length - 1].refresh_lookup = {
        ok: Boolean(resolved.ok),
        node_id: resolved.node_id || null,
        visible_index: resolved.visible_index ?? null,
        card_count: resolved.card_count || resolved.last_card_count || 0,
        reason: resolved.reason || null,
        error: resolved.error || null
      };
      if (!resolved.ok || !resolved.node_id || resolved.key !== candidateKey) {
        attempts[attempts.length - 1].refresh_lookup.exact_candidate_key_match = false;
        throw attachRecommendDetailOpenRetryEvidence(error, attempts, {
          reacquireFailed: true,
          expectedAttemptCount: limit
        });
      }
      attempts[attempts.length - 1].refresh_lookup.exact_candidate_key_match = true;
      currentNodeId = resolved.node_id;
      currentCandidate = resolved.candidate || currentCandidate;
      currentRootState = resolved.root_state || null;
    }
  }

  throw new Error("Recommend detail retry exhausted");
}

export async function closeRecommendAvatarPreview(client, {
  attemptsLimit = 2,
  waitMs = 500
} = {}) {
  const attempts = [];
  for (let index = 0; index < attemptsLimit; index += 1) {
    const state = await readRecommendAvatarPreviewState(client);
    if (!state.open) {
      return {
        closed: true,
        already_closed: true,
        attempts
      };
    }

    const closeTarget = await findVisibleCloseTarget(client, state.roots, RECOMMEND_AVATAR_PREVIEW_CLOSE_SELECTORS);
    if (closeTarget) {
      try {
        if (closeTarget.center) {
          await clickPoint(client, closeTarget.center.x, closeTarget.center.y, DETERMINISTIC_CLICK_OPTIONS);
        } else {
          await clickNodeCenter(client, closeTarget.node_id, DETERMINISTIC_CLICK_OPTIONS);
        }
        attempts.push({
          mode: "avatar-preview-close-selector",
          selector: closeTarget.selector,
          root: closeTarget.root
        });
      } catch (error) {
        attempts.push({
          mode: "avatar-preview-close-selector-error",
          selector: closeTarget.selector,
          root: closeTarget.root,
          error: error?.message || String(error)
        });
      }
    } else {
      await pressEscape(client);
      attempts.push({ mode: "avatar-preview-Escape" });
    }

    const closed = await waitForRecommendAvatarPreviewClosed(client, {
      timeoutMs: waitMs,
      intervalMs: 100
    });
    attempts.push({
      mode: "wait-avatar-preview-closed",
      closed: closed.closed,
      elapsed_ms: closed.elapsed_ms
    });
    if (closed.closed) {
      return {
        closed: true,
        already_closed: false,
        attempts
      };
    }

    await pressEscape(client);
    attempts.push({ mode: "avatar-preview-Escape-fallback" });
    const closedAfterEscape = await waitForRecommendAvatarPreviewClosed(client, {
      timeoutMs: waitMs,
      intervalMs: 100
    });
    attempts.push({
      mode: "wait-avatar-preview-closed-after-escape",
      closed: closedAfterEscape.closed,
      elapsed_ms: closedAfterEscape.elapsed_ms
    });
    if (closedAfterEscape.closed) {
      return {
        closed: true,
        already_closed: false,
        attempts
      };
    }
  }

  const state = await readRecommendAvatarPreviewState(client);
  return {
    closed: !state.open,
    already_closed: false,
    reason: state.open ? "avatar_preview_still_visible_after_close_attempts" : null,
    attempts,
    state
  };
}

export async function closeRecommendDetail(client, {
  attemptsLimit = 4,
  closeWaitMs = 5000,
  escapeWaitMs = 3500
} = {}) {
  const attempts = [];
  for (let index = 0; index < attemptsLimit; index += 1) {
    const existingState = await waitForRecommendDetail(client, { timeoutMs: 500 });
    if (!existingState?.popup && !existingState?.resumeIframe) {
      return {
        closed: true,
        attempts
      };
    }

    const rootState = await getRecommendRoots(client);
    const closeTarget = await findVisibleCloseTarget(client, rootState.roots, DETAIL_CLOSE_SELECTORS);
    if (closeTarget) {
      try {
        if (closeTarget.center) {
          await clickPoint(client, closeTarget.center.x, closeTarget.center.y, DETERMINISTIC_CLICK_OPTIONS);
        } else {
          await clickNodeCenter(client, closeTarget.node_id, DETERMINISTIC_CLICK_OPTIONS);
        }
        attempts.push({
          mode: "close-selector",
          selector: closeTarget.selector,
          root: closeTarget.root
        });
      } catch (error) {
        attempts.push({
          mode: "close-selector-error",
          selector: closeTarget.selector,
          root: closeTarget.root,
          error: error?.message || String(error)
        });
        await pressEscape(client);
        attempts.push({ mode: "Escape-after-close-selector-error" });
      }
    } else {
      await pressEscape(client);
      attempts.push({ mode: "Escape" });
    }

    const closedAfterClick = await waitForRecommendDetailClosed(client, {
      timeoutMs: closeWaitMs,
      intervalMs: 250
    });
    attempts.push({
      mode: "wait-closed-after-primary",
      closed: closedAfterClick.closed,
      elapsed_ms: closedAfterClick.elapsed_ms
    });
    if (closedAfterClick.closed) {
      return {
        closed: true,
        attempts
      };
    }

    const outsideClick = await clickOutsideRecommendDetail(client, closedAfterClick.state || existingState);
    attempts.push(outsideClick);
    if (outsideClick.clicked) {
      const closedAfterOutsideClick = await waitForRecommendDetailClosed(client, {
        timeoutMs: closeWaitMs,
        intervalMs: 250
      });
      attempts.push({
        mode: "wait-closed-after-outside-click",
        closed: closedAfterOutsideClick.closed,
        elapsed_ms: closedAfterOutsideClick.elapsed_ms
      });
      if (closedAfterOutsideClick.closed) {
        return {
          closed: true,
          attempts
        };
      }
    }

    await pressEscape(client);
    attempts.push({ mode: "Escape-fallback" });

    const closedAfterEscape = await waitForRecommendDetailClosed(client, {
      timeoutMs: escapeWaitMs,
      intervalMs: 250
    });
    attempts.push({
      mode: "wait-closed-after-escape",
      closed: closedAfterEscape.closed,
      elapsed_ms: closedAfterEscape.elapsed_ms
    });
    if (closedAfterEscape.closed) {
      return {
        closed: true,
        attempts
      };
    }
  }

  const verification = await verifyRecommendDetailStillOpen(client);
  attempts.push({
    mode: "final-close-verification",
    open: verification.open,
    stable_open: verification.stable_open,
    popup: verification.second.popup,
    resume_iframe: verification.second.resume_iframe
  });
  if (!verification.open) {
    return {
      closed: true,
      attempts,
      verification
    };
  }

  return {
    closed: false,
    reason: verification.stable_open
      ? "detail_still_visible_after_close_attempts"
      : "detail_visibility_ambiguous_after_close_attempts",
    attempts,
    verification
  };
}

async function findVisibleCloseTarget(client, roots, selectors) {
  let fallback = null;
  for (const root of roots) {
    if (!root?.nodeId) continue;
    for (const selector of selectors) {
      const nodeIds = await querySelectorAll(client, root.nodeId, selector);
      for (const nodeId of nodeIds) {
        const target = {
          root: root.name,
          root_node_id: root.nodeId,
          selector,
          node_id: nodeId
        };
        if (!fallback) fallback = target;
        try {
          const box = await getNodeBox(client, nodeId);
          if (box.rect.width > 2 && box.rect.height > 2) {
            return {
              ...target,
              center: box.center,
              rect: box.rect
            };
          }
        } catch {}
      }
    }
  }
  return fallback;
}

async function pressEscape(client) {
  await pressKey(client, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
}

function clampPointCoordinate(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function getClickViewport(client) {
  try {
    const metrics = typeof client?.Page?.getLayoutMetrics === "function"
      ? await client.Page.getLayoutMetrics()
      : null;
    const viewport = metrics?.cssLayoutViewport || metrics?.layoutViewport || metrics?.visualViewport || {};
    return {
      width: Number(viewport.clientWidth || viewport.width || 1440),
      height: Number(viewport.clientHeight || viewport.height || 900)
    };
  } catch {
    return {
      width: 1440,
      height: 900
    };
  }
}

function getOutsideClickPoint(rect, viewport) {
  if (!rect || rect.width <= 2 || rect.height <= 2) return null;
  const margin = 24;
  const minX = 8;
  const minY = 8;
  const maxX = Math.max(minX, (Number(viewport?.width) || 1440) - 8);
  const maxY = Math.max(minY, (Number(viewport?.height) || 900) - 8);
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + Math.min(Math.max(rect.height * 0.2, 48), Math.max(48, rect.height - 24));
  const candidates = [
    { side: "left", x: rect.x - margin, y: midY },
    { side: "right", x: rect.x + rect.width + margin, y: midY },
    { side: "above", x: midX, y: rect.y - margin },
    { side: "below", x: midX, y: rect.y + rect.height + margin },
    { side: "viewport-corner", x: 16, y: 16 }
  ];

  for (const candidate of candidates) {
    const x = clampPointCoordinate(candidate.x, minX, maxX);
    const y = clampPointCoordinate(candidate.y, minY, maxY);
    const insideRect = (
      x >= rect.x
      && x <= rect.x + rect.width
      && y >= rect.y
      && y <= rect.y + rect.height
    );
    if (!insideRect) {
      return {
        ...candidate,
        x,
        y
      };
    }
  }
  return null;
}

async function clickOutsideRecommendDetail(client, detailState) {
  const rootState = detailState?.roots?.length
    ? detailState
    : await readRecommendDetailState(client);
  const boundaryTarget = await findVisibleDetailTarget(
    client,
    rootState.roots || [],
    DETAIL_OUTSIDE_CLOSE_BOUNDARY_SELECTORS
  );
  const target = boundaryTarget || rootState.resumeIframe || rootState.popup || null;
  const viewport = await getClickViewport(client);
  const point = getOutsideClickPoint(target?.rect, viewport);
  if (!point) {
    return {
      clicked: false,
      mode: "outside-modal-click",
      reason: "no_outside_click_point",
      selector: target?.selector || null,
      root: target?.root || null
    };
  }
  await clickPoint(client, point.x, point.y, DETERMINISTIC_CLICK_OPTIONS);
  return {
    clicked: true,
    mode: "outside-modal-click",
    selector: target?.selector || null,
    root: target?.root || null,
    side: point.side,
    x: Math.round(point.x),
    y: Math.round(point.y)
  };
}

export async function extractRecommendDetailCandidate(client, {
  cardCandidate,
  cardNodeId,
  detailState,
  networkEvents = [],
  targetUrl = "",
  closeDetail = true,
  networkParseRetryMs = 1800,
  networkParseIntervalMs = 250
} = {}) {
  const detailHtml = await readRecommendDetailHtml(client, detailState);
  const detailText = [
    detailHtml.popupText,
    detailHtml.resumeText
  ].filter(Boolean).join("\n\n");

  const parseStarted = Date.now();
  let networkBodies = [];
  let detailCandidateResult = null;
  do {
    networkBodies = await readRecommendDetailNetworkBodies(client, networkEvents);
    detailCandidateResult = buildScreeningCandidateFromDetail({
      cardCandidate,
      detailText,
      networkBodies,
      metadata: {
        target_url: targetUrl,
        card_node_id: cardNodeId,
        detail_popup_selector: detailState?.popup?.selector || null,
        detail_popup_root: detailState?.popup?.root || null,
        resume_iframe_selector: detailState?.resumeIframe?.selector || null,
        resume_iframe_root: detailState?.resumeIframe?.root || null,
        resume_iframe_document_node_id: detailHtml.resumeIframeDocumentNodeId,
        detail_html_errors: detailHtml.errors || []
      }
    });
    if (detailCandidateResult.parsed_network_profiles.some((item) => item.ok)) break;
    if (Date.now() - parseStarted >= Math.max(0, Number(networkParseRetryMs) || 0)) break;
    await sleep(Math.max(50, Number(networkParseIntervalMs) || 250));
  } while (true);

  let closeResult = null;
  if (closeDetail) {
    closeResult = await closeRecommendDetail(client);
  }

  return {
    candidate: detailCandidateResult.candidate,
    parsed_network_profiles: detailCandidateResult.parsed_network_profiles,
    network_profile_binding: detailCandidateResult.network_profile_binding || null,
    network_bodies: networkBodies,
    network_parse_retry_elapsed_ms: Date.now() - parseStarted,
    network_event_count: networkEvents.length,
    detail: {
      popup_text: detailHtml.popupText,
      resume_text: detailHtml.resumeText,
      popup_html_length: detailHtml.popupHTML.length,
      resume_html_length: detailHtml.resumeHTML.length,
      html_errors: detailHtml.errors || []
    },
    close_result: closeResult
  };
}
