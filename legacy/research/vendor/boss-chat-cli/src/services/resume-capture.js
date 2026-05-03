import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function browserProbeResumeContext(options = {}) {
  const INIT = Boolean(options.init);
  const TARGET_SCROLL =
    typeof options.targetScroll === 'number' && Number.isFinite(options.targetScroll)
      ? options.targetScroll
      : null;

  const absRect = (el) => {
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
  };

  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 30 && rect.height > 30;
  };

  const canScroll = (el) => Boolean(el && (el.scrollHeight || 0) > (el.clientHeight || 0) + 8);

  const chooseScrollableAncestor = (startEl) => {
    const candidates = [];
    let current = startEl;
    let depth = 0;
    while (current && depth < 24) {
      if ((current.clientHeight || 0) > 40 && canScroll(current)) {
        const style = getComputedStyle(current);
        const overflowY = String(style.overflowY || '').toLowerCase();
        const key = `${current.id || ''} ${current.className || ''}`.toLowerCase();
        let score = 0;
        if (/auto|scroll|overlay/.test(overflowY)) score += 1000;
        if (key.includes('resume')) score += 500;
        if (key.includes('detail')) score += 220;
        score += Math.min(250, Math.floor(((current.scrollHeight || 0) - (current.clientHeight || 0)) / 2));
        score -= depth * 10;
        candidates.push({ el: current, score });
      }
      current = current.parentElement;
      depth += 1;
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => right.score - left.score);
    return candidates[0].el;
  };

  const locateInlineResumeContainer = (scopes) => {
    const selectors = [
      '.resume-detail.resume-detail-chat.resume-content-wrap.iframe-resume-detail',
      '.resume-content-wrap.iframe-resume-detail',
      '.resume-content-wrap',
      '.resume-common-wrap',
      '.resume-recommend',
      '.resume-detail',
      '.resume-container .resume-content-wrap',
    ];

    for (const scope of scopes) {
      for (const selector of selectors) {
        const found = scope.querySelector(selector);
        if (found && isVisible(found)) {
          return found;
        }
      }
    }

    return null;
  };

  const locateContext = () => {
    const scopes = Array.from(
      document.querySelectorAll(
        '.dialog-wrap.active, .boss-popup__wrapper, .boss-dialog, .geek-detail-modal, .modal, .boss-popup_wrapper',
      ),
    ).filter(isVisible);
    const allResumeFrames = Array.from(
      document.querySelectorAll('iframe[src*="/web/frame/c-resume/"], iframe[name*="resume"]'),
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
      const inlineResumeContainer = locateInlineResumeContainer(scopes);
      if (!inlineResumeContainer) {
        return {
          ok: false,
          reason: 'NO_RESUME_IFRAME',
          debug: {
            scopeCount: scopes.length,
            totalResumeIframes: allResumeFrames.length,
            visibleResumeIframes: visibleResumeFrames.length,
            inlineResumeFound: false,
          },
        };
      }

      const inlineScroller =
        chooseScrollableAncestor(inlineResumeContainer) ||
        inlineResumeContainer;
      if (!inlineScroller || !isVisible(inlineScroller)) {
        return {
          ok: false,
          reason: 'NO_SCROLL_CONTAINER',
          debug: {
            scopeCount: scopes.length,
            totalResumeIframes: allResumeFrames.length,
            visibleResumeIframes: visibleResumeFrames.length,
            inlineResumeFound: true,
            scrollerFound: Boolean(inlineScroller),
            scrollerVisible: Boolean(inlineScroller && isVisible(inlineScroller)),
            scrollerClass: inlineScroller ? String(inlineScroller.className || '') : '',
          },
        };
      }

      return {
        ok: true,
        mode: 'inline',
        frame: null,
        canvas: null,
        scroller: inlineScroller,
        clipEl: inlineScroller,
        debug: {
          scopeCount: scopes.length,
          totalResumeIframes: allResumeFrames.length,
          visibleResumeIframes: visibleResumeFrames.length,
          inlineResumeFound: true,
          inlineResumeClass: String(inlineResumeContainer.className || ''),
          scrollerClass: String(inlineScroller.className || ''),
        },
      };
    }

    const resumeDoc = resumeFrame.contentDocument;
    const canvas = resumeDoc ? resumeDoc.querySelector('canvas#resume') || resumeDoc.querySelector('canvas') : null;
    const scroller =
      chooseScrollableAncestor(resumeFrame.parentElement || resumeFrame) ||
      document.querySelector('.resume-detail-wrap') ||
      chooseScrollableAncestor(resumeFrame) ||
      resumeFrame.parentElement ||
      resumeFrame;

    if (!scroller || !isVisible(scroller)) {
      return {
        ok: false,
        reason: 'NO_SCROLL_CONTAINER',
        debug: {
          scopeCount: scopes.length,
          totalResumeIframes: allResumeFrames.length,
          visibleResumeIframes: visibleResumeFrames.length,
          resumeFrameSrc: String(resumeFrame.src || ''),
          scrollerFound: Boolean(scroller),
          scrollerVisible: Boolean(scroller && isVisible(scroller)),
          scrollerClass: scroller ? String(scroller.className || '') : '',
        },
      };
    }

    return {
      ok: true,
      mode: 'iframe',
      frame: resumeFrame,
      canvas,
      scroller,
      clipEl: scroller,
      debug: {
        resumeFrameSrc: String(resumeFrame.src || ''),
        scrollerClass: String(scroller.className || ''),
      },
    };
  };

  if (
    INIT ||
    !window.__bossChatResumeCtx ||
    !window.__bossChatResumeCtx.scroller ||
    !window.__bossChatResumeCtx.scroller.isConnected
  ) {
    const located = locateContext();
    if (!located.ok) {
      return located;
    }
    window.__bossChatResumeCtx = located;
  }

  const ctx = window.__bossChatResumeCtx;
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
  const baseClipHeight = Math.max(
    1,
    Math.min(clipRaw.height, Number(ctx.scroller.clientHeight || clipRaw.height)),
  );
  const baseClipTop = Number(clipRaw.y || 0);

  let noiseCutoffHeight = null;
  try {
    const noiseSelectors = [
      '.resume-anonymous-geek-card.v2',
      '.resume-anonymous-geek-card',
      '.resume-anonymous-geek-card .card-container',
      '.resume-warning',
    ];
    const noiseNodes = Array.from(ctx.scroller.querySelectorAll(noiseSelectors.join(','))).filter(
      (node) => node instanceof HTMLElement && isVisible(node),
    );
    for (const node of noiseNodes) {
      const rect = absRect(node);
      if (!(rect.width > 8 && rect.height > 8)) continue;
      const relTop = rect.y - baseClipTop;
      if (relTop <= 80) continue;
      const candidateCutoff = Math.max(1, Math.floor(relTop - 6));
      if (candidateCutoff < baseClipHeight) {
        noiseCutoffHeight = candidateCutoff;
        break;
      }
    }
  } catch {}
  const finalClipHeight =
    typeof noiseCutoffHeight === 'number' && Number.isFinite(noiseCutoffHeight)
      ? Math.max(1, Math.min(baseClipHeight, noiseCutoffHeight))
      : baseClipHeight;

  return {
    ok: true,
    mode: ctx.mode || 'unknown',
    scrollTop,
    scrollHeight,
    clientHeight,
    maxScroll,
    clip: {
      x: clipRaw.x,
      y: clipRaw.y,
      width: Math.max(1, Math.min(clipRaw.width, Number(ctx.scroller.clientWidth || clipRaw.width))),
      height: finalClipHeight,
    },
    canvas: ctx.canvas
      ? {
          width: Number(ctx.canvas.width || 0),
          height: Number(ctx.canvas.height || 0),
        }
      : null,
    debug: ctx.debug || {},
  };
}

async function detectLikelyBlankChunks(chunkFiles = []) {
  const normalizedFiles = Array.isArray(chunkFiles) ? chunkFiles.filter(Boolean) : [];
  if (normalizedFiles.length <= 0) {
    return { likelyBlank: false, luma: 0, avgStd: 0, blankChunks: 0, totalChunks: 0 };
  }

  let lumaTotal = 0;
  let stdTotal = 0;
  let blankChunks = 0;

  for (const file of normalizedFiles) {
    const stats = await sharp(file).stats();
    const channels = stats?.channels || [];
    if (channels.length < 3) {
      continue;
    }
    const meanR = Number(channels[0]?.mean || 0);
    const meanG = Number(channels[1]?.mean || 0);
    const meanB = Number(channels[2]?.mean || 0);
    const stdR = Number(channels[0]?.stdev || 0);
    const stdG = Number(channels[1]?.stdev || 0);
    const stdB = Number(channels[2]?.stdev || 0);
    const luma = 0.299 * meanR + 0.587 * meanG + 0.114 * meanB;
    const avgStd = (stdR + stdG + stdB) / 3;
    lumaTotal += luma;
    stdTotal += avgStd;
    if (luma >= 244 && avgStd <= 9) {
      blankChunks += 1;
    }
  }

  const totalChunks = normalizedFiles.length;
  const avgLuma = totalChunks > 0 ? lumaTotal / totalChunks : 0;
  const avgStd = totalChunks > 0 ? stdTotal / totalChunks : 0;
  const likelyBlank = blankChunks === totalChunks;
  return {
    likelyBlank,
    luma: Number(avgLuma.toFixed(2)),
    avgStd: Number(avgStd.toFixed(2)),
    blankChunks,
    totalChunks,
  };
}

export class ResumeCaptureService {
  constructor({ chromeClient, logger = console } = {}) {
    this.chromeClient = chromeClient;
    this.logger = logger;
  }

  async waitForProbe({ waitResumeMs = 30000, pollMs = 700 } = {}) {
    const start = Date.now();
    let lastProbe = null;
    while (Date.now() - start < waitResumeMs) {
      const probe = await this.chromeClient.callFunction(browserProbeResumeContext, {
        init: true,
        targetScroll: 0,
      });
      if (probe && typeof probe === 'object') {
        lastProbe = probe;
      }
      if (probe?.ok && probe?.clip?.height > 80 && probe?.clip?.width > 120) {
        return probe;
      }
      await sleep(pollMs);
    }

    const reason = lastProbe?.reason || 'UNKNOWN';
    throw new Error(`Resume context probe timeout: reason=${reason}`);
  }

  async captureResume({ artifactDir, waitResumeMs = 30000, scrollSettleMs = 500 } = {}) {
    if (!artifactDir) {
      throw new Error('artifactDir is required for resume capture');
    }

    await mkdir(artifactDir, { recursive: true });
    const chunkDir = path.join(artifactDir, 'chunks');
    await mkdir(chunkDir, { recursive: true });
    const metadataFile = path.join(artifactDir, 'chunks.json');

    const probe = await this.waitForProbe({ waitResumeMs });
    const maxScroll = Math.max(0, Number(probe.maxScroll || 0));
    const step = Math.max(120, Math.floor(Number(probe.clientHeight || probe.clip?.height || 800)));
    const positions = [];
    for (let pos = 0; pos <= maxScroll; pos += step) {
      positions.push(Math.min(pos, maxScroll));
    }
    if (positions.length === 0 || positions[positions.length - 1] !== maxScroll) {
      positions.push(maxScroll);
    }

    const uniquePositions = [...new Set(positions.map((value) => Math.round(value)))].sort((a, b) => a - b);
    const chunks = [];
    const seenScroll = [];

    for (let index = 0; index < uniquePositions.length; index += 1) {
      const targetScroll = uniquePositions[index];
      await this.chromeClient.callFunction(browserProbeResumeContext, {
        init: false,
        targetScroll,
      });
      await sleep(scrollSettleMs);

      const current = await this.chromeClient.callFunction(browserProbeResumeContext, {
        init: false,
        targetScroll: null,
      });
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

      const shot = await this.chromeClient.Page.captureScreenshot({
        format: 'png',
        captureBeyondViewport: true,
        clip: {
          x: Number(clip.x.toFixed(2)),
          y: Number(clip.y.toFixed(2)),
          width: Number(width.toFixed(2)),
          height: Number(height.toFixed(2)),
          scale: 1,
        },
      });
      const file = path.resolve(chunkDir, `chunk_${String(chunks.length).padStart(3, '0')}.png`);
      await writeFile(file, Buffer.from(shot.data, 'base64'));
      seenScroll.push(actualScroll);
      chunks.push({
        index: chunks.length,
        file,
        scrollTop: actualScroll,
        clipHeightCss: height,
        clipWidthCss: width,
      });
    }

    if (chunks.length === 0) {
      throw new Error('No screenshot chunks captured from resume modal');
    }

    const metadata = {
      createdAt: new Date().toISOString(),
      probe,
      chunks,
    };
    await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    const chunkFiles = chunks.map((chunk) => path.resolve(chunk.file));
    const blank = await detectLikelyBlankChunks(chunkFiles);
    this.logger.log(
      `简历截图完成: chunks=${chunks.length}, modelImages=${chunkFiles.length}, likelyBlank=${blank.likelyBlank}, blankChunks=${blank.blankChunks}/${blank.totalChunks}, luma=${blank.luma}, std=${blank.avgStd}`,
    );

    return {
      metadataFile,
      chunkDir,
      chunkCount: chunks.length,
      chunkFiles,
      modelImagePaths: chunkFiles,
      stitchedImage: '',
      stitchEngine: 'skipped',
      stitched: null,
      quality: blank,
    };
  }
}
