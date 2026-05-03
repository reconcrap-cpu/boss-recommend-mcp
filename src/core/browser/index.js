import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";

export const DEFAULT_CHROME_HOST = "127.0.0.1";
export const DEFAULT_CHROME_PORT = 9222;
export const BOSS_LOGIN_URL = "https://www.zhipin.com/web/user/?ka=bticket";

export const ALLOWED_CDP_DOMAINS = new Set([
  "Accessibility",
  "Browser",
  "DOM",
  "Input",
  "Network",
  "Page",
  "Target"
]);

export const FORBIDDEN_CDP_DOMAINS = new Set(["Runtime"]);

const BOSS_LOGIN_URL_PATTERN = /(?:zhipin\.com\/web\/user(?:\/|\?|$)|passport\.zhipin\.com|login\.zhipin\.com)/i;
const BOSS_LOGIN_TEXT_PATTERN = /扫码登录|验证码登录|密码登录|登录后|请登录|登录BOSS直聘|Boss登录|BOSS登录/i;
const CHROME_DEBUG_UNAVAILABLE_PATTERN = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|connect|socket hang up/i;
const BOSS_LOGIN_DOM_SELECTORS = [
  ".login-box",
  ".login-form",
  ".login-dialog",
  ".sign-form",
  ".qrcode-box",
  ".user-login",
  "input[name='phone']",
  "input[placeholder*='手机号']",
  "input[placeholder*='验证码']"
];

function nowIso() {
  return new Date().toISOString();
}

function normalizeTargetMatcher({ targetUrlIncludes, targetPredicate } = {}) {
  if (typeof targetPredicate === "function") return targetPredicate;
  if (targetUrlIncludes) {
    return (target) => String(target?.url || "").includes(targetUrlIncludes);
  }
  return (target) => target?.type === "page";
}

function isForbiddenMethod(methodName) {
  const [domain] = String(methodName || "").split(".");
  return FORBIDDEN_CDP_DOMAINS.has(domain);
}

function methodName(domain, method) {
  return `${String(domain)}.${String(method)}`;
}

function recordMethod(methodLog, method) {
  if (Array.isArray(methodLog)) {
    methodLog.push({ method, at: nowIso() });
  }
}

export function assertNoForbiddenCdpCalls(methodLog = []) {
  const forbidden = methodLog.filter((entry) => isForbiddenMethod(entry?.method));
  if (forbidden.length > 0) {
    const methods = forbidden.map((entry) => entry.method).join(", ");
    throw new Error(`Forbidden CDP methods were used: ${methods}`);
  }
}

export function isBossLoginUrl(url) {
  return BOSS_LOGIN_URL_PATTERN.test(String(url || ""));
}

export function createBossLoginRequiredError({
  domain = "boss",
  currentUrl = "",
  targetUrl = "",
  loginUrl = BOSS_LOGIN_URL,
  loginDetection = null,
  chrome = null
} = {}) {
  const error = new Error(`Boss login is required before starting the ${domain} run.`);
  error.code = "BOSS_LOGIN_REQUIRED";
  error.requires_login = true;
  error.current_url = currentUrl || null;
  error.target_url = targetUrl || null;
  error.login_url = loginUrl;
  error.login_detection = loginDetection || null;
  error.chrome = chrome || null;
  error.retryable = true;
  return error;
}

export async function detectBossLoginState(client, { currentUrl = "" } = {}) {
  const inspectedUrl = currentUrl || await getMainFrameUrl(client).catch(() => "");
  if (isBossLoginUrl(inspectedUrl)) {
    return {
      requires_login: true,
      reason: "url",
      current_url: inspectedUrl,
      matched_selectors: []
    };
  }

  let root = null;
  try {
    root = await getDocumentRoot(client, { depth: 1, pierce: true });
  } catch (error) {
    return {
      requires_login: false,
      reason: "dom_unavailable",
      current_url: inspectedUrl,
      error: error?.message || String(error || "")
    };
  }

  const matchedSelectors = [];
  for (const selector of BOSS_LOGIN_DOM_SELECTORS) {
    const nodeId = await querySelector(client, root.nodeId, selector).catch(() => 0);
    if (nodeId) matchedSelectors.push(selector);
  }

  if (matchedSelectors.length === 0) {
    return {
      requires_login: false,
      reason: "no_login_dom",
      current_url: inspectedUrl,
      matched_selectors: []
    };
  }

  const html = await getOuterHTML(client, root.nodeId).catch(() => "");
  const looksLikeLogin = BOSS_LOGIN_TEXT_PATTERN.test(html);
  return {
    requires_login: looksLikeLogin,
    reason: looksLikeLogin ? "dom" : "login_selector_without_login_text",
    current_url: inspectedUrl,
    matched_selectors: matchedSelectors
  };
}

export function isChromeDebugUnavailableError(error) {
  return CHROME_DEBUG_UNAVAILABLE_PATTERN.test(String(error?.message || error || ""));
}

function pathExists(targetPath) {
  try {
    return Boolean(targetPath) && fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function isLocalChromeHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return !normalized || normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function getCodexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

function getDefaultChromeExecutableCandidates() {
  const candidates = [
    process.env.BOSS_MCP_CHROME_PATH,
    process.env.BOSS_RECOMMEND_CHROME_PATH
  ].filter(Boolean);
  if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe")
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/snap/bin/chromium"
    );
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

export function getChromeExecutable() {
  return getDefaultChromeExecutableCandidates().find((candidate) => pathExists(candidate)) || null;
}

export function getBossChromeUserDataDir(port = DEFAULT_CHROME_PORT) {
  const sharedPath = path.join(getCodexHome(), "boss-mcp", `chrome-profile-${port}`);
  ensureDir(sharedPath);
  return sharedPath;
}

export async function waitForChromeDebugPort({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  timeoutMs = 8000,
  intervalMs = 300
} = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      const targets = await listChromeTargets({ host, port });
      return {
        ok: true,
        elapsed_ms: Date.now() - started,
        targets
      };
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    error: lastError?.message || String(lastError || "Chrome debug port did not become ready")
  };
}

export async function launchChromeDebugInstance({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  url = "about:blank",
  slowLive = false
} = {}) {
  if (!isLocalChromeHost(host)) {
    throw new Error(`Cannot auto-launch Chrome for non-local debug host: ${host}`);
  }
  const chromePath = getChromeExecutable();
  if (!chromePath) {
    throw new Error("Chrome executable not found. Set BOSS_MCP_CHROME_PATH or BOSS_RECOMMEND_CHROME_PATH.");
  }
  const userDataDir = getBossChromeUserDataDir(port);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    url
  ];
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  const readiness = await waitForChromeDebugPort({
    host,
    port,
    timeoutMs: slowLive ? 30000 : 12000,
    intervalMs: slowLive ? 700 : 300
  });
  if (!readiness.ok) {
    throw new Error(`Chrome launched but DevTools port ${port} did not become reachable: ${readiness.error}`);
  }
  return {
    launched: true,
    chrome_path: chromePath,
    user_data_dir: userDataDir,
    port,
    url,
    readiness: {
      elapsed_ms: readiness.elapsed_ms,
      target_count: readiness.targets.length
    }
  };
}

export async function ensureChromeDebugPort({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  url = "about:blank",
  slowLive = false,
  launchIfMissing = true
} = {}) {
  try {
    const targets = await listChromeTargets({ host, port });
    return {
      launched: false,
      reused: true,
      port,
      target_count: targets.length
    };
  } catch (error) {
    if (!launchIfMissing || !isChromeDebugUnavailableError(error)) {
      throw error;
    }
    return launchChromeDebugInstance({ host, port, url, slowLive });
  }
}

export async function openChromeTarget({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  url
} = {}) {
  const encodedUrl = encodeURIComponent(url || "about:blank");
  const endpoint = `http://${host}:${port}/json/new?${encodedUrl}`;
  const methods = ["PUT", "GET"];
  let lastError = null;
  for (const method of methods) {
    try {
      const response = await fetch(endpoint, { method });
      if (response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch {}
        return {
          ok: true,
          method,
          target_id: payload?.id || null,
          url: payload?.url || url || null
        };
      }
      lastError = new Error(`DevTools /json/new returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  return {
    ok: false,
    error: lastError?.message || "Failed to open Chrome target"
  };
}

export async function connectToChromeTargetOrOpen({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  targetUrlIncludes,
  targetPredicate,
  fallbackTargetPredicate,
  targetUrl,
  allowNavigate = true,
  slowLive = false,
  launchIfMissing = true
} = {}) {
  let chrome = null;
  if (allowNavigate && targetUrl) {
    chrome = await ensureChromeDebugPort({
      host,
      port,
      url: targetUrl,
      slowLive,
      launchIfMissing
    });
  }

  try {
    const session = await connectToChromeTarget({
      host,
      port,
      targetUrlIncludes,
      targetPredicate
    });
    return {
      ...session,
      chrome: {
        ...(chrome || { launched: false, reused: true, port }),
        target_created: false
      }
    };
  } catch (primaryError) {
    if (!allowNavigate) throw primaryError;

    if (typeof fallbackTargetPredicate === "function") {
      try {
        const session = await connectToChromeTarget({
          host,
          port,
          targetPredicate: fallbackTargetPredicate
        });
        return {
          ...session,
          chrome: {
            ...(chrome || { launched: false, reused: true, port }),
            target_created: false,
            fallback_target: true
          }
        };
      } catch {}
    }

    let openAttempt = null;
    if (targetUrl) {
      openAttempt = await openChromeTarget({ host, port, url: targetUrl });
      if (openAttempt.ok) {
        const session = await connectToChromeTarget({
          host,
          port,
          targetPredicate: (target) => (
            (openAttempt.target_id && target?.id === openAttempt.target_id)
            || String(target?.url || "").includes(targetUrlIncludes || targetUrl)
            || (targetUrl.includes("zhipin.com") && String(target?.url || "").includes("zhipin.com"))
          )
        });
        return {
          ...session,
          chrome: {
            ...(chrome || { launched: false, reused: true, port }),
            target_created: true,
            open_attempt: openAttempt
          }
        };
      }
    }

    const session = await connectToChromeTarget({
      host,
      port,
      targetPredicate: (target) => target?.type === "page"
    });
    return {
      ...session,
      chrome: {
        ...(chrome || { launched: false, reused: true, port }),
        target_created: false,
        open_attempt: openAttempt,
        fallback_any_page: true
      }
    };
  }
}

export function createGuardedCdpClient(client, { methodLog = [] } = {}) {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "send") {
        return async (method, params = {}) => {
          if (isForbiddenMethod(method)) {
            throw new Error(`Forbidden CDP method blocked: ${method}`);
          }
          recordMethod(methodLog, method);
          return target.send(method, params);
        };
      }

      const value = Reflect.get(target, property, receiver);
      if (!value || typeof value !== "object") return value;

      return new Proxy(value, {
        get(domainTarget, method, domainReceiver) {
          const domainValue = Reflect.get(domainTarget, method, domainReceiver);
          if (typeof domainValue !== "function") return domainValue;

          return async (params = {}) => {
            const fullMethod = methodName(property, method);
            if (isForbiddenMethod(fullMethod)) {
              throw new Error(`Forbidden CDP method blocked: ${fullMethod}`);
            }
            recordMethod(methodLog, fullMethod);
            return domainValue.call(domainTarget, params);
          };
        }
      });
    }
  });
}

export async function listChromeTargets({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT
} = {}) {
  return CDP.List({ host, port });
}

export async function connectToChromeTarget({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  targetUrlIncludes,
  targetPredicate
} = {}) {
  const targets = await listChromeTargets({ host, port });
  const matcher = normalizeTargetMatcher({ targetUrlIncludes, targetPredicate });
  const target = targets.find(matcher);
  if (!target) {
    const urls = targets.map((item) => item.url).filter(Boolean).join("\n");
    throw new Error(`No matching Chrome target found on ${host}:${port}.\nAvailable targets:\n${urls}`);
  }

  const rawClient = await CDP({ host, port, target });
  const methodLog = [];
  const client = createGuardedCdpClient(rawClient, { methodLog });

  return {
    client,
    rawClient,
    target,
    methodLog,
    async close() {
      await rawClient.close();
    }
  };
}

export async function assertRuntimeEvaluateBlocked(client) {
  try {
    await client.Runtime.evaluate({ expression: "1" });
  } catch (error) {
    if (/Forbidden CDP method blocked: Runtime\.evaluate/.test(String(error?.message || ""))) {
      return { blocked: true, message: error.message };
    }
    throw error;
  }
  throw new Error("Runtime.evaluate was not blocked by the CDP guard");
}

export async function enableDomains(client, domains = ["Page", "DOM", "Input"]) {
  for (const domain of domains) {
    if (!ALLOWED_CDP_DOMAINS.has(domain)) {
      throw new Error(`CDP domain is not allowed by the CDP-only contract: ${domain}`);
    }
    if (typeof client?.[domain]?.enable === "function") {
      await client[domain].enable();
    }
  }
}

export async function bringPageToFront(client) {
  if (typeof client?.Page?.bringToFront === "function") {
    await client.Page.bringToFront();
  }
}

export async function getPageFrameTree(client) {
  const result = await client.Page.getFrameTree();
  return result.frameTree || null;
}

export async function getMainFrame(client) {
  const frameTree = await getPageFrameTree(client);
  return frameTree?.frame || null;
}

export async function getMainFrameUrl(client) {
  const frame = await getMainFrame(client);
  return frame?.url || "";
}

export async function waitForMainFrameUrl(client, predicate, {
  timeoutMs = 10000,
  intervalMs = 250
} = {}) {
  const started = Date.now();
  let lastUrl = "";
  while (Date.now() - started <= timeoutMs) {
    lastUrl = await getMainFrameUrl(client);
    if (predicate(lastUrl)) {
      return {
        ok: true,
        elapsed_ms: Date.now() - started,
        url: lastUrl
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    url: lastUrl
  };
}

export async function getDocumentRoot(client, { depth = 1, pierce = true } = {}) {
  const result = await client.DOM.getDocument({ depth, pierce });
  return result.root;
}

export async function querySelector(client, nodeId, selector) {
  const result = await client.DOM.querySelector({ nodeId, selector });
  return result.nodeId || 0;
}

export async function querySelectorAll(client, nodeId, selector) {
  const result = await client.DOM.querySelectorAll({ nodeId, selector });
  return result.nodeIds || [];
}

export async function findFirstNode(client, rootNodeId, selectors = []) {
  for (const selector of selectors) {
    const nodeId = await querySelector(client, rootNodeId, selector);
    if (nodeId) return { selector, nodeId };
  }
  return null;
}

export async function describeNode(client, nodeId, { depth = 1, pierce = true } = {}) {
  const result = await client.DOM.describeNode({ nodeId, depth, pierce });
  return result.node;
}

export async function getFrameDocumentNodeId(client, iframeNodeId) {
  const node = await describeNode(client, iframeNodeId, { depth: 1, pierce: true });
  const documentNodeId = node?.contentDocument?.nodeId;
  if (!documentNodeId) {
    throw new Error(`Node ${iframeNodeId} does not expose a contentDocument node`);
  }
  return documentNodeId;
}

export async function findIframeDocument(client, rootNodeId, selectors = []) {
  const iframe = await findFirstNode(client, rootNodeId, selectors);
  if (!iframe) return null;
  const documentNodeId = await getFrameDocumentNodeId(client, iframe.nodeId);
  return { ...iframe, documentNodeId };
}

export async function getAttributesMap(client, nodeId) {
  const result = await client.DOM.getAttributes({ nodeId });
  const attributes = {};
  const raw = result.attributes || [];
  for (let index = 0; index < raw.length; index += 2) {
    attributes[raw[index]] = raw[index + 1] || "";
  }
  return attributes;
}

export async function getOuterHTML(client, nodeId) {
  const result = await client.DOM.getOuterHTML({ nodeId });
  return result.outerHTML || "";
}

export async function getNodeBox(client, nodeId) {
  const result = await client.DOM.getBoxModel({ nodeId });
  const model = result.model;
  const quad = model.border?.length ? model.border : model.content;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    model,
    center: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2
    },
    rect: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    }
  };
}

export async function clickPoint(client, x, y, {
  button = "left",
  clickCount = 1,
  delayMs = 80
} = {}) {
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" });
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button, clickCount });
  if (delayMs > 0) await sleep(delayMs);
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button, clickCount });
}

export async function scrollNodeIntoView(client, nodeId) {
  await client.DOM.scrollIntoViewIfNeeded({ nodeId });
}

export async function clickNodeCenter(client, nodeId, {
  scrollIntoView = false,
  ...clickOptions
} = {}) {
  if (scrollIntoView) {
    await scrollNodeIntoView(client, nodeId);
    await sleep(150);
  }
  const box = await getNodeBox(client, nodeId);
  await clickPoint(client, box.center.x, box.center.y, clickOptions);
  return box;
}

export async function pressKey(client, key, {
  code = key,
  windowsVirtualKeyCode,
  nativeVirtualKeyCode = windowsVirtualKeyCode,
  text = "",
  modifiers = 0
} = {}) {
  await client.Input.dispatchKeyEvent({
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode,
    text,
    modifiers
  });
  await client.Input.dispatchKeyEvent({
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode,
    modifiers
  });
}

export async function insertText(client, text) {
  await client.Input.insertText({ text: String(text || "") });
}

export async function selectAllFocusedText(client) {
  await pressKey(client, "a", {
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2
  });
}

export async function clearFocusedInput(client) {
  await selectAllFocusedText(client);
  await pressKey(client, "Backspace", {
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8
  });
}

export async function waitForSelector(client, nodeId, selector, {
  timeoutMs = 5000,
  intervalMs = 150
} = {}) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const foundNodeId = await querySelector(client, nodeId, selector);
    if (foundNodeId) return foundNodeId;
    await sleep(intervalMs);
  }
  return 0;
}

export async function countSelectors(client, nodeId, selectors = {}) {
  const counts = {};
  for (const [name, selector] of Object.entries(selectors)) {
    counts[name] = (await querySelectorAll(client, nodeId, selector)).length;
  }
  return counts;
}

export async function getAccessibilityTree(client, options = {}) {
  return client.Accessibility.getFullAXTree(options);
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
