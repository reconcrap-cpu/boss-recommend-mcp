#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const WebSocket = require("ws");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EARLY_FAIL_NO_RESUME_IFRAME_MIN_WAIT_MS = 5000;
const EARLY_FAIL_NO_RESUME_IFRAME_STABLE_POLLS = 4;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error(`Parse JSON failed for ${url}: ${error.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

function pickTarget(targets, targetPattern) {
  const pages = targets.filter((item) => item.type === "page");
  if (!pages.length) return null;
  return (
    pages.find((item) => typeof item.url === "string" && item.url.includes(targetPattern))
    || pages.find((item) => /zhipin\.com/i.test(item.url || ""))
    || pages[0]
  );
}

function oneLineJson(value, maxLength = 1200) {
  try {
    const text = JSON.stringify(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
  } catch {
    return "\"<unserializable>\"";
  }
}

function summarizeProbeReason(probe) {
  if (!probe || typeof probe !== "object") return "NO_PROBE";
  if (probe.ok === true) return "INVALID_CLIP";
  return String(probe.reason || "UNKNOWN");
}

function buildResumeProbeTimeoutMessage(waitResumeMs, probe) {
  const reason = summarizeProbeReason(probe);
  const payload = {
    reason,
    clip: probe?.clip || null,
    scroll_top: Number.isFinite(Number(probe?.scrollTop)) ? Number(probe.scrollTop) : null,
    client_height: Number.isFinite(Number(probe?.clientHeight)) ? Number(probe.clientHeight) : null,
    scroll_height: Number.isFinite(Number(probe?.scrollHeight)) ? Number(probe.scrollHeight) : null,
    max_scroll: Number.isFinite(Number(probe?.maxScroll)) ? Number(probe.maxScroll) : null,
    debug: probe?.debug || null
  };
  return `Resume canvas not found: wait_resume_ms=${waitResumeMs}; last_reason=${reason}; probe=${oneLineJson(payload)}`;
}

function isStableNoResumeIframeProbe(probe) {
  if (!probe || probe.ok === true || probe.reason !== "NO_CRESUME_IFRAME") {
    return false;
  }
  const activeScopeCount = Number(probe?.debug?.activeScopeCount ?? -1);
  const totalResumeIframes = Number(probe?.debug?.totalResumeIframes ?? -1);
  const visibleResumeIframes = Number(probe?.debug?.visibleResumeIframes ?? -1);
  return activeScopeCount === 0 && totalResumeIframes === 0 && visibleResumeIframes === 0;
}

function shouldAbortResumeProbeEarly({ probe, stableNoResumeIframePolls, elapsedMs, waitResumeMs }) {
  if (!isStableNoResumeIframeProbe(probe)) {
    return false;
  }
  const minWaitMs = Math.min(waitResumeMs, EARLY_FAIL_NO_RESUME_IFRAME_MIN_WAIT_MS);
  return stableNoResumeIframePolls >= EARLY_FAIL_NO_RESUME_IFRAME_STABLE_POLLS
    && elapsedMs >= minWaitMs;
}

function buildResumeProbeExpr({ init, targetScroll }) {
  const initLiteral = init ? "true" : "false";
  const scrollLiteral = typeof targetScroll === "number" && Number.isFinite(targetScroll)
    ? String(targetScroll)
    : "null";

  return `(() => {
    const INIT = ${initLiteral};
    const TARGET_SCROLL = ${scrollLiteral};

    function absRect(el) {
      const rect = el.getBoundingClientRect();
      let x = rect.left;
      let y = rect.top;
      let win = el.ownerDocument.defaultView;
      while (win && win !== win.parent) {
        const frameEl = win.frameElement;
        if (!frameEl) break;
        const frameRect = frameEl.getBoundingClientRect();
        x += frameRect.left;
        y += frameRect.top;
        win = win.parent;
      }
      return { x, y, width: rect.width, height: rect.height };
    }

    function canScroll(el) {
      return Boolean(el && (el.scrollHeight || 0) > (el.clientHeight || 0) + 8);
    }

    function chooseScrollableAncestor(startEl) {
      const candidates = [];
      let cur = startEl;
      let depth = 0;
      while (cur && depth < 24) {
        if ((cur.clientHeight || 0) > 40 && canScroll(cur)) {
          const style = getComputedStyle(cur);
          const overflowY = String(style.overflowY || '').toLowerCase();
          const key = (((cur.id || '') + ' ' + (cur.className || '')).toLowerCase());
          let score = 0;
          if (/auto|scroll|overlay/.test(overflowY)) score += 1000;
          if (key.includes('resume')) score += 600;
          if (key.includes('detail')) score += 300;
          score += Math.min(250, Math.floor((cur.scrollHeight - cur.clientHeight) / 2));
          score -= depth * 10;
          candidates.push({ el: cur, score });
        }
        cur = cur.parentElement;
        depth += 1;
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0].el;
    }

    function isVisible(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 80 && rect.height > 80;
    }

    function locateContext() {
      const recommendFrame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      const recommendDoc = recommendFrame && recommendFrame.contentDocument;
      if (!recommendFrame || !recommendDoc) {
        return {
          ok: false,
          reason: 'NO_RECOMMEND_IFRAME',
          debug: {
            topIframeCount: document.querySelectorAll('iframe').length
          }
        };
      }

      const scopes = Array.from(
        recommendDoc.querySelectorAll('.dialog-wrap.active, .boss-popup__wrapper.boss-dialog, .boss-dialog__wrapper')
      ).filter(isVisible);
      const allResumeFrames = Array.from(
        recommendDoc.querySelectorAll('iframe[src*="/web/frame/c-resume/"], iframe[name*="resume"]')
      );
      const visibleResumeFrames = allResumeFrames.filter(isVisible);

      let resumeFrame = null;
      for (const scope of scopes) {
        const found = scope.querySelector('iframe[src*="/web/frame/c-resume/"], iframe[name*="resume"]');
        if (found && isVisible(found)) {
          resumeFrame = found;
          break;
        }
      }

      if (!resumeFrame) {
        resumeFrame = visibleResumeFrames[0] || null;
      }

      if (!resumeFrame) {
        return {
          ok: false,
          reason: 'NO_CRESUME_IFRAME',
          debug: {
            activeScopeCount: scopes.length,
            totalResumeIframes: allResumeFrames.length,
            visibleResumeIframes: visibleResumeFrames.length,
            recommendFrameUrl: (() => {
              try { return String(recommendFrame.contentWindow.location.href || ''); } catch { return ''; }
            })()
          }
        };
      }

      const resumeDoc = resumeFrame.contentDocument;
      const canvas = resumeDoc ? (resumeDoc.querySelector('canvas#resume') || resumeDoc.querySelector('canvas')) : null;
      const scroller = chooseScrollableAncestor(resumeFrame.parentElement || resumeFrame)
        || recommendDoc.querySelector('.resume-detail-wrap')
        || chooseScrollableAncestor(resumeFrame)
        || null;
      if (!scroller || !isVisible(scroller)) {
        return {
          ok: false,
          reason: 'NO_SCROLL_CONTAINER',
          debug: {
            activeScopeCount: scopes.length,
            totalResumeIframes: allResumeFrames.length,
            visibleResumeIframes: visibleResumeFrames.length,
            resumeFrameSrc: String(resumeFrame.src || ''),
            scrollerFound: Boolean(scroller),
            scrollerVisible: Boolean(scroller && isVisible(scroller)),
            scrollerClass: scroller ? String(scroller.className || '') : ''
          }
        };
      }

      return {
        ok: true,
        frame: resumeFrame,
        canvas,
        scroller,
        clipEl: scroller,
        debug: {
          recommendFrameUrl: (() => {
            try { return String(recommendFrame.contentWindow.location.href || ''); } catch { return ''; }
          })(),
          resumeFrameSrc: String(resumeFrame.src || ''),
          scrollerClass: String(scroller.className || '')
        }
      };
    }

    if (INIT || !window.__bossRecommendResumeCtx || !window.__bossRecommendResumeCtx.scroller || !window.__bossRecommendResumeCtx.scroller.isConnected) {
      const located = locateContext();
      if (!located.ok) {
        return located;
      }
      window.__bossRecommendResumeCtx = located;
    }

    const ctx = window.__bossRecommendResumeCtx;
    if (typeof TARGET_SCROLL === 'number' && Number.isFinite(TARGET_SCROLL)) {
      try {
        ctx.scroller.scrollTop = TARGET_SCROLL;
        if (typeof ctx.scroller.scrollTo === 'function') {
          ctx.scroller.scrollTo({ top: TARGET_SCROLL, left: 0, behavior: 'instant' });
        }
        ctx.scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      } catch {}
    }

    const scrollTop = Number(ctx.scroller.scrollTop || 0);
    const scrollHeight = Number(ctx.scroller.scrollHeight || 0);
    const clientHeight = Number(ctx.scroller.clientHeight || 0);
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const clipRaw = absRect(ctx.clipEl);

    return {
      ok: true,
      scrollTop,
      scrollHeight,
      clientHeight,
      maxScroll,
      clip: {
        x: clipRaw.x,
        y: clipRaw.y,
        width: Math.max(1, Math.min(clipRaw.width, Number(ctx.scroller.clientWidth || clipRaw.width))),
        height: Math.max(1, Math.min(clipRaw.height, Number(ctx.scroller.clientHeight || clipRaw.height)))
      },
      canvas: ctx.canvas ? {
        width: Number(ctx.canvas.width || 0),
        height: Number(ctx.canvas.height || 0)
      } : null,
      debug: ctx.debug || {}
    };
  })()`;
}

async function captureFullResumeCanvas(options = {}) {
  const host = options.host || process.env.CDP_HOST || "127.0.0.1";
  const port = Number(options.port || process.env.CDP_PORT || 9222);
  const waitResumeMs = Number(options.waitResumeMs || process.env.WAIT_RESUME_MS || 30000);
  const scrollSettleMs = Number(options.scrollSettleMs || process.env.SCROLL_SETTLE_MS || 500);
  const outPrefix = options.outPrefix || process.env.OUT_PREFIX || path.resolve(process.cwd(), "recommend_resume_full");
  const targetPattern = options.targetPattern || process.env.TARGET_PATTERN || "/web/chat/recommend";
  const stitchScript = path.resolve(__dirname, "stitch_resume_chunks.py");
  const chunkDir = `${outPrefix}_chunks`;
  const metadataFile = `${outPrefix}_chunks.json`;
  const stitchedImage = `${outPrefix}.png`;

  if (!fs.existsSync(stitchScript)) {
    throw new Error(`Missing stitch script: ${stitchScript}`);
  }
  fs.mkdirSync(chunkDir, { recursive: true });

  const targets = await getJson(`http://${host}:${port}/json/list`);
  const target = pickTarget(targets, targetPattern);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("No debuggable zhipin page target found.");
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();

  function send(method, params = {}) {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, 30000);
    });
  }

  function evaluate(expression) {
    return send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    }).then((response) => response.result?.value);
  }

  ws.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!message.id) return;
    const promise = pending.get(message.id);
    if (!promise) return;
    pending.delete(message.id);
    if (message.error) {
      promise.reject(new Error(JSON.stringify(message.error)));
    } else {
      promise.resolve(message.result);
    }
  });

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.bringToFront");

    let probe = null;
    let lastProbe = null;
    let stableNoResumeIframePolls = 0;
    const startTime = Date.now();
    while (Date.now() - startTime < waitResumeMs) {
      try {
        probe = await evaluate(buildResumeProbeExpr({ init: true, targetScroll: 0 }));
      } catch (error) {
        probe = {
          ok: false,
          reason: "PROBE_EVALUATE_FAILED",
          debug: {
            message: String(error?.message || error || "unknown")
          }
        };
      }
      if (probe && typeof probe === "object") {
        lastProbe = probe;
      }
      if (probe?.ok && probe.clip?.height > 80 && probe.clip?.width > 120) {
        break;
      }
      if (isStableNoResumeIframeProbe(probe)) {
        stableNoResumeIframePolls += 1;
      } else {
        stableNoResumeIframePolls = 0;
      }
      const elapsedMs = Date.now() - startTime;
      if (shouldAbortResumeProbeEarly({
        probe,
        stableNoResumeIframePolls,
        elapsedMs,
        waitResumeMs
      })) {
        if (probe && typeof probe === "object") {
          probe = {
            ...probe,
            debug: {
              ...(probe.debug && typeof probe.debug === "object" ? probe.debug : {}),
              earlyAbort: true,
              stableNoResumeIframePolls,
              elapsedMs
            }
          };
          lastProbe = probe;
        }
        break;
      }
      await sleep(700);
    }

    if (!probe?.ok) {
      const elapsedMs = Math.max(0, Date.now() - startTime);
      throw new Error(buildResumeProbeTimeoutMessage(Math.min(waitResumeMs, elapsedMs), lastProbe || probe));
    }

    const maxScroll = Math.max(0, Number(probe.maxScroll || 0));
    const step = Math.max(120, Math.floor(Number(probe.clientHeight || probe.clip.height || 800)));
    const positions = [];
    for (let pos = 0; pos <= maxScroll; pos += step) {
      positions.push(Math.min(pos, maxScroll));
    }
    if (!positions.length || positions[positions.length - 1] !== maxScroll) {
      positions.push(maxScroll);
    }

    const uniquePositions = [...new Set(positions.map((value) => Math.round(value)))].sort((a, b) => a - b);
    const chunks = [];
    const seenScroll = [];

    for (let index = 0; index < uniquePositions.length; index += 1) {
      const targetScroll = uniquePositions[index];
      await evaluate(buildResumeProbeExpr({ init: false, targetScroll }));
      await sleep(scrollSettleMs);
      const current = await evaluate(buildResumeProbeExpr({ init: false, targetScroll: null }));
      if (!current?.ok) continue;

      const actualScroll = Number(current.scrollTop || 0);
      if (seenScroll.some((value) => Math.abs(value - actualScroll) < 1)) {
        continue;
      }

      const clip = current.clip || {};
      const width = Number(clip.width || 0);
      const height = Number(clip.height || 0);
      if (width < 50 || height < 50) {
        continue;
      }

      const shot = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: {
          x: Number(clip.x.toFixed(2)),
          y: Number(clip.y.toFixed(2)),
          width: Number(width.toFixed(2)),
          height: Number(height.toFixed(2)),
          scale: 1
        }
      });

      const file = path.resolve(chunkDir, `chunk_${String(chunks.length).padStart(3, "0")}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      seenScroll.push(actualScroll);
      chunks.push({
        index: chunks.length,
        file,
        scrollTop: actualScroll,
        clipHeightCss: height,
        clipWidthCss: width
      });
    }

    if (!chunks.length) {
      throw new Error("No screenshot chunks captured.");
    }

    const metadata = {
      createdAt: new Date().toISOString(),
      target: { title: target.title, url: target.url },
      probe,
      chunks
    };
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), "utf8");

    const stitch = spawnSync("python", [stitchScript, metadataFile, stitchedImage], {
      encoding: "utf8"
    });
    if (stitch.status !== 0) {
      throw new Error(`Stitch failed: ${stitch.stderr || stitch.stdout}`);
    }

    return {
      stitchedImage,
      metadataFile,
      chunkDir,
      chunkCount: chunks.length,
      target: {
        title: target.title,
        url: target.url
      }
    };
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

module.exports = {
  captureFullResumeCanvas,
  __testables: {
    EARLY_FAIL_NO_RESUME_IFRAME_MIN_WAIT_MS,
    EARLY_FAIL_NO_RESUME_IFRAME_STABLE_POLLS,
    isStableNoResumeIframeProbe,
    shouldAbortResumeProbeEarly
  }
};

if (require.main === module) {
  captureFullResumeCanvas()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(String(error?.message || error));
      process.exit(1);
    });
}
