#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKSPACE_RUNTIME_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

let assertNoForbiddenCdpCalls;
let bringPageToFront;
let clickNodeCenter;
let connectToChromeTarget;
let DETERMINISTIC_CLICK_OPTIONS;
let enableDomains;
let pressKey;
let scrollNodeIntoView;
let sleep;
let confirmFilterPanel;
let ensureRecommendCurrentCityOnly;
let findRecommendCurrentCityControl;
let findRecommendLocationTrigger;
let getRecommendRoots;
let listFilterOptions;
let openFilterPanel;
let RECOMMEND_TARGET_URL;
let resolveRecommendFilterGroupNodeIds;
let selectAndConfirmFirstSafeFilter;

const ACTIVITY_LEVELS = new Set([
  "不限",
  "刚刚活跃",
  "今日活跃",
  "3日内活跃",
  "本周活跃",
  "本月活跃"
]);

const DEGREE_LEVELS = new Set([
  "初中及以下",
  "中专",
  "中技",
  "高中",
  "大专",
  "本科",
  "硕士",
  "博士"
]);

function parseLabelList(value) {
  return [...new Set(String(value || "")
    .split(/[，,、|/]/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

export function parseArgs(argv) {
  const result = {
    currentCityOnly: true,
    activityLevel: "今日活跃",
    schoolTags: ["985", "211"],
    degreeLabels: ["本科", "硕士", "博士"],
    cooldownMs: 3000,
    runtimeRoot: WORKSPACE_RUNTIME_ROOT,
    outputPath: path.resolve(".live-artifacts/recommend-filter-apply/result.json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--current-city-only") result.currentCityOnly = true;
    if (arg === "--no-current-city-only") result.currentCityOnly = false;
    if (arg === "--activity-level") result.activityLevel = String(argv[++index] || "").trim();
    if (arg === "--school-tags") {
      result.schoolTags = parseLabelList(argv[++index]);
    }
    if (arg === "--degree-labels" || arg === "--degrees") {
      result.degreeLabels = parseLabelList(argv[++index]);
    }
    if (arg === "--cooldown-ms") {
      const cooldownMs = Number.parseInt(argv[++index], 10);
      if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
        throw new Error("Cooldown must be a non-negative integer");
      }
      result.cooldownMs = cooldownMs;
    }
    if (arg === "--runtime-root") {
      const runtimeRoot = String(argv[++index] || "").trim();
      if (!runtimeRoot) throw new Error("Runtime root is required");
      result.runtimeRoot = path.resolve(runtimeRoot);
    }
    if (arg === "--output") result.outputPath = path.resolve(String(argv[++index] || "").trim());
  }
  if (!ACTIVITY_LEVELS.has(result.activityLevel)) {
    throw new Error(`Unsupported activity level: ${result.activityLevel}`);
  }
  if (!result.schoolTags.length) throw new Error("At least one school tag is required");
  if (!result.degreeLabels.length) throw new Error("At least one degree is required");
  const unsupportedDegrees = result.degreeLabels.filter((label) => !DEGREE_LEVELS.has(label));
  if (unsupportedDegrees.length) {
    throw new Error(`Unsupported degree: ${unsupportedDegrees.join(", ")}`);
  }
  return result;
}

function assertRuntimeExports(module, moduleLabel, exportNames) {
  const missing = exportNames.filter((name) => module[name] === undefined);
  if (missing.length) {
    throw new Error(`${moduleLabel} is missing required exports: ${missing.join(", ")}`);
  }
}

export async function loadRuntime(runtimeRoot) {
  const resolvedRoot = fs.realpathSync(path.resolve(runtimeRoot));
  const packageJsonPath = path.join(resolvedRoot, "package.json");
  const browserModulePath = path.join(resolvedRoot, "src", "core", "browser", "index.js");
  const recommendModulePath = path.join(resolvedRoot, "src", "domains", "recommend", "index.js");
  for (const requiredPath of [packageJsonPath, browserModulePath, recommendModulePath]) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`Installed runtime file not found: ${requiredPath}`);
    }
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const [browserModule, recommendModule] = await Promise.all([
    import(pathToFileURL(browserModulePath).href),
    import(pathToFileURL(recommendModulePath).href)
  ]);
  assertRuntimeExports(browserModule, "Installed browser runtime", [
    "assertNoForbiddenCdpCalls",
    "bringPageToFront",
    "clickNodeCenter",
    "connectToChromeTarget",
    "DETERMINISTIC_CLICK_OPTIONS",
    "enableDomains",
    "pressKey",
    "scrollNodeIntoView",
    "sleep"
  ]);
  assertRuntimeExports(recommendModule, "Installed Recommend runtime", [
    "confirmFilterPanel",
    "ensureRecommendCurrentCityOnly",
    "findRecommendCurrentCityControl",
    "findRecommendLocationTrigger",
    "getRecommendRoots",
    "listFilterOptions",
    "openFilterPanel",
    "RECOMMEND_TARGET_URL",
    "resolveRecommendFilterGroupNodeIds",
    "selectAndConfirmFirstSafeFilter"
  ]);

  ({
    assertNoForbiddenCdpCalls,
    bringPageToFront,
    clickNodeCenter,
    connectToChromeTarget,
    DETERMINISTIC_CLICK_OPTIONS,
    enableDomains,
    pressKey,
    scrollNodeIntoView,
    sleep
  } = browserModule);
  ({
    confirmFilterPanel,
    ensureRecommendCurrentCityOnly,
    findRecommendCurrentCityControl,
    findRecommendLocationTrigger,
    getRecommendRoots,
    listFilterOptions,
    openFilterPanel,
    RECOMMEND_TARGET_URL,
    resolveRecommendFilterGroupNodeIds,
    selectAndConfirmFirstSafeFilter
  } = recommendModule);

  return {
    root: resolvedRoot,
    package_name: String(packageJson.name || ""),
    package_version: String(packageJson.version || "")
  };
}

function normalizeLabel(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function compactFilter(result) {
  return {
    confirmed: result.confirmed,
    selected_option: result.selected_option,
    selected_options: result.selected_options,
    unavailable: result.unavailable,
    unavailable_groups: result.unavailable_groups,
    sticky_verification: result.sticky_verification
  };
}

async function applyActivity(client, frameNodeId, activityLevel) {
  const result = await selectAndConfirmFirstSafeFilter(client, frameNodeId, {
    filterGroups: [{
      group: "activity",
      labels: [activityLevel],
      selectAllLabels: false,
      allowUnlimited: true,
      verifySticky: true
    }],
    afterConfirmSettleMs: 800,
    stickySettleMs: 300
  });
  return compactFilter(result);
}

async function readGroupOptions(client, frameNodeId, group) {
  return (await listFilterOptions(client, frameNodeId, { groupOrder: [group] }))
    .filter((option) => option.group === group);
}

export function exactGroupState(options, desiredLabels) {
  const desired = [...new Set(desiredLabels.map(normalizeLabel))].sort();
  const active = options.filter((option) => option.active).map((option) => normalizeLabel(option.label)).sort();
  return {
    desired,
    active,
    verified: active.length === desired.length && active.every((label, index) => label === desired[index])
  };
}

export function exactCurrentCityState(control, expected = true) {
  const actual = control?.state?.checked;
  const readable = control?.readable === true && typeof actual === "boolean";
  return {
    expected: expected === true,
    actual: readable ? actual : null,
    readable,
    verified: readable && actual === (expected === true),
    state_source: control?.state?.source || "unreadable",
    node_id: control?.node_id || null,
    state_node_id: control?.state?.state_node_id || null
  };
}

async function clickGroupOption(client, option, cooldownMs, clicks, action) {
  const box = await clickNodeCenter(client, option.node_id, {
    ...DETERMINISTIC_CLICK_OPTIONS,
    scrollIntoView: true
  });
  clicks.push({
    action,
    label: option.label,
    node_id: option.node_id,
    click_target: box.click_target
  });
  if (cooldownMs > 0) await sleep(cooldownMs);
}

async function ensureExactMultiSelectGroup(client, frameNodeId, {
  group,
  displayName,
  desiredLabels,
  cooldownMs
}) {
  await openFilterPanel(client, frameNodeId);
  const desired = [...new Set(desiredLabels.map(normalizeLabel))];
  let options = await readGroupOptions(client, frameNodeId, group);
  const available = new Set(options.map((option) => normalizeLabel(option.label)));
  const missing = desired.filter((label) => !available.has(label));
  if (missing.length) throw new Error(`${displayName} filter options not found: ${missing.join(", ")}`);

  const clicks = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    options = await readGroupOptions(client, frameNodeId, group);
    const undesired = options.find((option) => (
      option.active
      && normalizeLabel(option.label) !== "不限"
      && !desired.includes(normalizeLabel(option.label))
    ));
    if (!undesired) break;
    await clickGroupOption(client, undesired, cooldownMs, clicks, "deactivate");
  }

  for (const label of desired) {
    options = await readGroupOptions(client, frameNodeId, group);
    const option = options.find((item) => normalizeLabel(item.label) === label);
    if (!option) throw new Error(`${displayName} filter option disappeared: ${label}`);
    if (!option.active) await clickGroupOption(client, option, cooldownMs, clicks, "activate");
  }

  options = await readGroupOptions(client, frameNodeId, group);
  const beforeConfirmation = exactGroupState(options, desired);
  if (!beforeConfirmation.verified) {
    throw new Error(`${displayName} filters did not reach exact requested state: ${beforeConfirmation.active.join(",")}`);
  }
  const confirmation = await confirmFilterPanel(client, frameNodeId);
  if (!confirmation.confirmed) throw new Error(`${displayName} filter confirmation failed`);
  await sleep(800);

  await openFilterPanel(client, frameNodeId);
  options = await readGroupOptions(client, frameNodeId, group);
  const sticky = exactGroupState(options, desired);
  const closeConfirmation = await confirmFilterPanel(client, frameNodeId);
  if (!closeConfirmation.confirmed) {
    throw new Error(`${displayName} filter sticky-verification panel did not close`);
  }
  if (!sticky.verified) {
    throw new Error(`${displayName} filters failed sticky verification: ${sticky.active.join(",")}`);
  }
  return {
    group,
    requested_labels: desired,
    effective_labels: sticky.active,
    clicked: clicks.length > 0,
    clicks,
    confirmation: {
      confirmed: confirmation.confirmed,
      label: confirmation.confirm_label,
      node_id: confirmation.confirm_node_id
    },
    sticky_verification: {
      verified: sticky.verified,
      active_labels: sticky.active,
      close_confirmation: {
        confirmed: closeConfirmation.confirmed,
        label: closeConfirmation.confirm_label,
        node_id: closeConfirmation.confirm_node_id
      }
    }
  };
}

async function capturePng(client, screenshotPath) {
  const screenshot = await client.Page.captureScreenshot({
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  return screenshotPath;
}

async function waitForCurrentCityControlVisibility(client, frameNodeId, {
  visible,
  timeoutMs = 2400,
  intervalMs = 150
}) {
  const started = Date.now();
  while (true) {
    const control = await findRecommendCurrentCityControl(client, frameNodeId);
    if (visible ? Boolean(control) : !control) return control;
    if (Date.now() - started >= timeoutMs) return control;
    if (intervalMs > 0) await sleep(intervalMs);
  }
}

async function captureCurrentCityEvidence(client, frameNodeId, {
  outputDirectory,
  expected
}) {
  let trigger = await findRecommendLocationTrigger(client, frameNodeId);
  let control = await findRecommendCurrentCityControl(client, frameNodeId);
  let openClick = null;
  if (!control) {
    if (!trigger) throw new Error("Current-city visual evidence could not find the location trigger");
    openClick = await clickNodeCenter(client, trigger.node_id, DETERMINISTIC_CLICK_OPTIONS);
    control = await waitForCurrentCityControlVisibility(client, frameNodeId, { visible: true });
  }
  if (!control) throw new Error("Current-city visual evidence popover did not open");
  const openTriggerNodeId = trigger?.node_id || null;

  const exactState = exactCurrentCityState(control, expected);
  if (!exactState.verified) {
    throw new Error(
      `Current-city visual verification failed: expected=${exactState.expected}, actual=${exactState.actual}`
    );
  }
  await scrollNodeIntoView(client, control.node_id);
  await sleep(300);
  const screenshotPath = await capturePng(
    client,
    path.join(outputDirectory, "applied-current-city.png")
  );

  await pressKey(client, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  let remainingControl = await waitForCurrentCityControlVisibility(client, frameNodeId, {
    visible: false
  });
  let closeMethod = "Escape";
  if (remainingControl) {
    trigger = await findRecommendLocationTrigger(client, frameNodeId);
    if (!trigger) throw new Error("Current-city visual evidence popover could not be closed");
    await clickNodeCenter(client, trigger.node_id, DETERMINISTIC_CLICK_OPTIONS);
    remainingControl = await waitForCurrentCityControlVisibility(client, frameNodeId, {
      visible: false
    });
    closeMethod = "location-trigger-toggle";
  }
  if (remainingControl) throw new Error("Current-city visual evidence popover remained open");

  return {
    exact_state: exactState,
    screenshot: screenshotPath,
    opened_by: openClick ? "location-trigger-click" : "already-open",
    open_trigger_node_id: openTriggerNodeId,
    open_click_target: openClick?.click_target || null,
    closed_without_state_change: true,
    close_method: closeMethod,
    popover_closed: true
  };
}

async function captureFilterPanelEvidence(client, frameNodeId, {
  outputDirectory,
  activityLevel,
  schoolTags,
  degreeLabels
}) {
  await openFilterPanel(client, frameNodeId);
  const specs = [
    { group: "activity", desiredLabels: [activityLevel] },
    { group: "school", desiredLabels: schoolTags },
    { group: "degree", desiredLabels: degreeLabels }
  ];
  const exactStates = {};
  const screenshots = {};

  for (const spec of specs) {
    const state = exactGroupState(
      await readGroupOptions(client, frameNodeId, spec.group),
      spec.desiredLabels
    );
    if (!state.verified) {
      throw new Error(`Final visual verification failed for ${spec.group}: ${state.active.join(",")}`);
    }
    exactStates[spec.group] = state;

    const groupNodeIds = await resolveRecommendFilterGroupNodeIds(client, frameNodeId, spec.group);
    if (!groupNodeIds.length) {
      throw new Error(`Final visual verification could not locate group: ${spec.group}`);
    }
    await scrollNodeIntoView(client, groupNodeIds[0]);
    await sleep(300);
    const screenshotPath = path.join(outputDirectory, `applied-${spec.group}.png`);
    screenshots[spec.group] = await capturePng(client, screenshotPath);
  }

  const closeConfirmation = await confirmFilterPanel(client, frameNodeId);
  if (!closeConfirmation.confirmed) {
    throw new Error("Final visual-evidence filter panel did not close");
  }

  return {
    exact_states: exactStates,
    screenshots,
    panel_closed_after_capture: true,
    close_confirmation: {
      confirmed: closeConfirmation.confirmed,
      label: closeConfirmation.confirm_label,
      node_id: closeConfirmation.confirm_node_id
    }
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const runtime = await loadRuntime(options.runtimeRoot);
  const session = await connectToChromeTarget({
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: RECOMMEND_TARGET_URL
  });

  try {
  const { client, methodLog, target } = session;
  await enableDomains(client, ["Page", "DOM", "Input", "Network", "Accessibility"]);
  await bringPageToFront(client);
  const outputDirectory = path.dirname(options.outputPath);
  fs.mkdirSync(outputDirectory, { recursive: true });

  let roots = await getRecommendRoots(client);
  const city = await ensureRecommendCurrentCityOnly(client, roots.iframe.documentNodeId, {
    enabled: options.currentCityOnly
  });
  if (options.cooldownMs > 0) await sleep(options.cooldownMs);

  roots = await getRecommendRoots(client);
  const currentCityVisualEvidence = await captureCurrentCityEvidence(
    client,
    roots.iframe.documentNodeId,
    {
      outputDirectory,
      expected: options.currentCityOnly
    }
  );
  if (options.cooldownMs > 0) await sleep(options.cooldownMs);

  roots = await getRecommendRoots(client);
  const activity = await applyActivity(client, roots.iframe.documentNodeId, options.activityLevel);
  if (options.cooldownMs > 0) await sleep(options.cooldownMs);

  roots = await getRecommendRoots(client);
  const school = await ensureExactMultiSelectGroup(
    client,
    roots.iframe.documentNodeId,
    {
      group: "school",
      displayName: "School",
      desiredLabels: options.schoolTags,
      cooldownMs: options.cooldownMs
    }
  );
  if (options.cooldownMs > 0) await sleep(options.cooldownMs);

  roots = await getRecommendRoots(client);
  const degree = await ensureExactMultiSelectGroup(
    client,
    roots.iframe.documentNodeId,
    {
      group: "degree",
      displayName: "Degree",
      desiredLabels: options.degreeLabels,
      cooldownMs: options.cooldownMs
    }
  );
  if (options.cooldownMs > 0) await sleep(options.cooldownMs);

  roots = await getRecommendRoots(client);
  const visualEvidence = await captureFilterPanelEvidence(
    client,
    roots.iframe.documentNodeId,
    {
      outputDirectory,
      activityLevel: options.activityLevel,
      schoolTags: options.schoolTags,
      degreeLabels: options.degreeLabels
    }
  );
  visualEvidence.current_city = currentCityVisualEvidence;
  visualEvidence.exact_states.current_city = currentCityVisualEvidence.exact_state;
  visualEvidence.screenshots.current_city = currentCityVisualEvidence.screenshot;

  const screenshotPath = await capturePng(client, path.join(outputDirectory, "applied.png"));
  assertNoForbiddenCdpCalls(methodLog);
  const runtimeMethods = methodLog.filter((entry) => String(entry.method || "").startsWith("Runtime."));
  const scriptInjectionMethods = methodLog.filter((entry) => String(entry.method || "").startsWith("Page.addScript"));
  if (runtimeMethods.length || scriptInjectionMethods.length) {
    throw new Error("Forbidden browser execution method appeared in the live filter-apply log");
  }

  const result = {
    status: "PASS",
    generated_at: new Date().toISOString(),
    runtime_root: runtime.root,
    runtime_package: {
      name: runtime.package_name,
      version: runtime.package_version
    },
    target: { id: target.id, url: target.url, title: target.title },
    requested: {
      current_city_only: options.currentCityOnly,
      activity_level: options.activityLevel,
      school_tag: options.schoolTags,
      degree: options.degreeLabels
    },
    settings_cooldown_ms: options.cooldownMs,
    city,
    current_city_visual_evidence: currentCityVisualEvidence,
    activity,
    school,
    degree,
    visual_evidence: visualEvidence,
    page_left_applied: true,
    post_action: "none",
    screenshot: screenshotPath,
    forbidden_method_counts: {
      runtime: runtimeMethods.length,
      script_injection: scriptInjectionMethods.length
    },
    method_log: methodLog
  };
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: result.status,
    output_path: options.outputPath,
    runtime_root: result.runtime_root,
    runtime_package: result.runtime_package,
    requested: result.requested,
    settings_cooldown_ms: result.settings_cooldown_ms,
    effective: {
      current_city_only: result.city.effective,
      current_city_label: result.city.current_city_label,
      activity_level: result.activity.sticky_verification.groups[0]?.active_labels || [],
      school_tag: result.school.sticky_verification.active_labels,
      degree: result.degree.sticky_verification.active_labels
    },
    page_left_applied: result.page_left_applied,
    forbidden_method_counts: result.forbidden_method_counts,
    screenshot: result.screenshot,
    current_city_screenshot: result.current_city_visual_evidence.screenshot,
    filter_panel_screenshots: result.visual_evidence.screenshots
  }, null, 2));
  } finally {
    await session.close();
  }
}

const directExecutionUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (directExecutionUrl === import.meta.url) {
  await main();
}
