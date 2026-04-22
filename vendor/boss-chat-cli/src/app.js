import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { isDomProfileConsistentWithCard, NETWORK_RESUME_RETRY_WAIT_MS } from './services/resume-network.js';
import { DEFAULT_GREETING_TEXT } from './services/profile-store.js';
import { createCustomerAliases, createCustomerKey } from './utils/customer-key.js';

function runToken(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function safePathToken(value) {
  return String(value || 'unknown')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 80);
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toStringArray(value, maxItems = 8) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const item of value) {
    const text = normalizeText(item);
    if (!text) continue;
    normalized.push(text);
    if (normalized.length >= maxItems) break;
  }
  return normalized;
}

function shouldContinue(summary, targetCount) {
  if (!targetCount || !Number.isFinite(targetCount) || targetCount <= 0) {
    return true;
  }
  return summary.inspected < targetCount;
}

function hasResumeRequestSentMessage(state = {}) {
  const lastText = normalizeText(state?.lastText || '');
  const recent = Array.isArray(state?.recent) ? state.recent : [];
  if (lastText.includes('简历请求已发送')) return true;
  return recent.some((item) => normalizeText(item).includes('简历请求已发送'));
}

function resolveGreetingText(profile = {}) {
  return normalizeText(profile?.greetingText || '') || DEFAULT_GREETING_TEXT;
}

const CANDIDATE_LIST_WAIT_AFTER_CONTEXT_MS = 5000;
const CANDIDATE_LIST_WAIT_POLL_MS = 500;

export class BossChatApp {
  constructor({
    page,
    llmClient,
    interaction,
    resumeCaptureService,
    stateStore,
    reportStore,
    resumeNetworkTracker = null,
    runControl = null,
    logger = console,
    dryRun = false,
    artifactRootDir = '',
    resumeOpenCooldownMs = 3000,
    onProgress = null,
  }) {
    this.page = page;
    this.llmClient = llmClient;
    this.interaction = interaction;
    this.resumeCaptureService = resumeCaptureService;
    this.stateStore = stateStore;
    this.reportStore = reportStore;
    this.resumeNetworkTracker = resumeNetworkTracker;
    this.runControl = runControl;
    this.logger = logger;
    this.dryRun = dryRun;
    this.artifactRootDir = artifactRootDir;
    this.lastResumeOpenAt = 0;
    this.resumeOpenBlockedUntil = 0;
    this.resumeOpenCooldownMs = Number.isFinite(Number(resumeOpenCooldownMs))
      ? Math.max(0, Number(resumeOpenCooldownMs))
      : 3000;
    this.onProgress = typeof onProgress === 'function' ? onProgress : null;
  }

  formatProgress(summary) {
    const targetText = summary.profile.targetCount || '∞';
    return `进度: 已处理 ${summary.inspected}/${targetText}，通过 ${summary.passed}，已求简历 ${summary.requested}，跳过 ${summary.skipped}，错误 ${summary.errors}`;
  }

  async checkpoint() {
    if (this.runControl) {
      await this.runControl.checkpoint();
    }
  }

  async waitResumeOpenCooldown(minGapMs = this.resumeOpenCooldownMs) {
    const now = Date.now();
    const waitFromLast = Math.max(0, minGapMs - (now - this.lastResumeOpenAt));
    const waitFromBlock = Math.max(0, this.resumeOpenBlockedUntil - now);
    const waitMs = Math.max(waitFromLast, waitFromBlock);
    if (waitMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  setResumeOpenBlocked(ms = 90000) {
    const until = Date.now() + ms;
    this.resumeOpenBlockedUntil = Math.max(this.resumeOpenBlockedUntil, until);
  }

  emitProgress(summary, meta = {}) {
    if (!this.onProgress) return;
    try {
      this.onProgress(
        {
          inspected: Number(summary?.inspected || 0),
          passed: Number(summary?.passed || 0),
          requested: Number(summary?.requested || 0),
          skipped: Number(summary?.skipped || 0),
          errors: Number(summary?.errors || 0),
          exhausted: Boolean(summary?.exhausted),
          stopped: Boolean(summary?.stopped),
          stopReason: String(summary?.stopReason || ''),
          reportPath: String(summary?.reportPath || ''),
        },
        meta,
      );
    } catch {}
  }

  buildCardProfile(customer = {}) {
    return {
      name: normalizeText(customer.name || ''),
      school: normalizeText(customer.school || ''),
      major: normalizeText(customer.major || ''),
      company: normalizeText(customer.company || customer.lastCompany || customer.last_company || ''),
      position: normalizeText(customer.position || customer.lastPosition || customer.last_position || ''),
    };
  }

  buildResumeCandidateContext(customer = {}, candidateInfo = null) {
    const info = candidateInfo && typeof candidateInfo === 'object' ? candidateInfo : {};
    const schools = Array.isArray(info.schools) ? info.schools.map((item) => normalizeText(item)).filter(Boolean) : [];
    const majors = Array.isArray(info.majors) ? info.majors.map((item) => normalizeText(item)).filter(Boolean) : [];
    const primarySchool = normalizeText(info.school || info.primarySchool || schools[0] || '');
    const primaryMajor = normalizeText(info.major || majors[0] || '');
    const company = normalizeText(info.company || '');
    const position = normalizeText(info.position || '');
    const hasProfileContext = Boolean(primarySchool || primaryMajor || company || position || schools.length || majors.length);
    return {
      name: customer.name || info.name || '',
      sourceJob: customer.sourceJob || '',
      resumeProfile: hasProfileContext
        ? {
            primarySchool,
            schools: schools.length > 0 ? schools : primarySchool ? [primarySchool] : [],
            major: primaryMajor,
            majors: majors.length > 0 ? majors : primaryMajor ? [primaryMajor] : [],
            company,
            position,
          }
        : null,
      resumeText: String(info.resumeText || ''),
      evidenceCorpus: String(info.evidenceCorpus || info.resumeText || ''),
    };
  }

  async extractDomResumeCandidateInfo(customer = {}) {
    if (typeof this.page.getResumeProfileFromDom !== 'function') {
      return null;
    }
    const result = await this.page.getResumeProfileFromDom();
    if (!result?.ok) {
      return null;
    }
    const resumeText = normalizeText(result.resumeText || '');
    if (!resumeText) {
      return null;
    }
    return {
      name: normalizeText(result.name || customer.name || ''),
      school: normalizeText(result.primarySchool || ''),
      schools: Array.isArray(result.schools) ? result.schools.map((item) => normalizeText(item)).filter(Boolean) : [],
      major: normalizeText(result.major || ''),
      majors: Array.isArray(result.majors) ? result.majors.map((item) => normalizeText(item)).filter(Boolean) : [],
      company: normalizeText(result.company || ''),
      position: normalizeText(result.position || ''),
      resumeText: String(result.resumeText || ''),
      evidenceCorpus: String(result.evidenceCorpus || result.resumeText || ''),
    };
  }

  async retryCandidateResumeContext(customer = {}) {
    if (typeof this.page.closeResumeModalDomOnce === 'function') {
      try {
        await this.page.closeResumeModalDomOnce();
      } catch {}
    }
    await this.checkpoint();
    if (typeof this.page.activateCandidate === 'function') {
      await this.page.activateCandidate(customer, 0);
    } else {
      const rect = await this.page.centerCustomerCard(customer.domIndex, 0);
      await this.interaction.clickRect(rect);
    }
    await this.interaction.sleepRange(520, 140);
    await this.page.waitForCandidateActivated(customer, {
      maxAttempts: 8,
      delayMs: 180,
    });
    await this.page.waitForConversationReady({
      maxAttempts: 8,
      delayMs: 220,
    });
    const retryStartedAt = Date.now();
    const openResult = await this.page.openOnlineResume();
    await this.interaction.sleepRange(520, 140);
    return {
      retryStartedAt,
      openResult,
    };
  }

  async resolveDomResumeFallback(customer = {}, cardProfile = null) {
    let domCandidateInfo = await this.extractDomResumeCandidateInfo(customer);
    let networkCandidateInfo = null;
    let acquisitionReason = domCandidateInfo?.resumeText ? 'dom_initial_hit' : '';

    if (domCandidateInfo && !isDomProfileConsistentWithCard(cardProfile, domCandidateInfo)) {
      this.logger.log(
        `DOM简历疑似错位：expected=${cardProfile?.name || 'unknown'} | actual=${domCandidateInfo?.name || 'unknown'}，尝试重试点击并短暂回查 network。`,
      );
      acquisitionReason = 'dom_profile_mismatch_retry';
      try {
        const retryContext = await this.retryCandidateResumeContext(customer);
        if (this.resumeNetworkTracker) {
          const retryNetwork = await this.resumeNetworkTracker.waitForNetworkResumeCandidateInfo(
            customer,
            NETWORK_RESUME_RETRY_WAIT_MS,
            { minTs: retryContext.retryStartedAt },
          );
          if (retryNetwork?.candidateInfo?.resumeText) {
            networkCandidateInfo = retryNetwork.candidateInfo;
            acquisitionReason = 'dom_retry_network_recheck_hit';
            domCandidateInfo = null;
          }
        }
        if (!networkCandidateInfo) {
          const retryDomCandidateInfo = await this.extractDomResumeCandidateInfo(customer);
          if (retryDomCandidateInfo && isDomProfileConsistentWithCard(cardProfile, retryDomCandidateInfo)) {
            domCandidateInfo = retryDomCandidateInfo;
            acquisitionReason = 'dom_retry_hit';
          } else {
            domCandidateInfo = null;
            acquisitionReason = 'dom_profile_mismatch_unresolved';
          }
        }
      } catch (error) {
        domCandidateInfo = null;
        acquisitionReason = `dom_profile_retry_failed:${normalizeText(error?.message || error)}`;
      }
    }

    return {
      domCandidateInfo,
      networkCandidateInfo,
      acquisitionReason,
    };
  }

  async acquireResumeAndEvaluate(customer, profile, artifactDir, baseResult) {
    let modalOpened = false;
    let capture = null;
    let lastResumeError = null;
    const timings = {
      initialNetworkWaitMs: 0,
      networkRetryMs: 0,
      imageCaptureMs: 0,
      imageModelMs: 0,
      lateNetworkRetryMs: 0,
      domFallbackMs: 0,
      textModelMs: 0,
    };
    const cardProfile = this.buildCardProfile(customer);

    await this.waitResumeOpenCooldown(this.resumeOpenCooldownMs + Math.floor(Math.random() * 200));
    await this.checkpoint();
    const acquisitionStartedAt = Date.now();
    const openResult = await this.page.openOnlineResume();
    let openDetected = openResult ? Boolean(openResult?.detectedOpen) : true;
    this.lastResumeOpenAt = Date.now();
    modalOpened = openDetected;
    await this.interaction.sleepRange(600, 220);

    const rateLimit =
      typeof this.page.getResumeRateLimitWarning === 'function'
        ? await this.page.getResumeRateLimitWarning()
        : { hit: false, text: '' };
    if (rateLimit?.hit) {
      const backoffMs = 90000 + Math.floor(Math.random() * 30000);
      this.setResumeOpenBlocked(backoffMs);
      throw new Error(`RESUME_RATE_LIMIT_WARNING:${rateLimit.text}`);
    }
    if (openResult && !openDetected) {
      let delayedDetected = false;
      if (typeof this.page.getResumeModalState === 'function') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const delayedState = await this.page.getResumeModalState();
        delayedDetected =
          Boolean(delayedState?.open) ||
          Number(delayedState?.iframeCount || 0) > 0 ||
          (Number(delayedState?.scopeCount || 0) > 0 && Number(delayedState?.closeCount || 0) > 0);
      }
      if (delayedDetected) {
        openDetected = true;
        modalOpened = true;
        this.logger.log('在线简历首次检测未命中，1秒后复检已打开，继续处理。');
      } else {
        throw new Error('RESUME_MODAL_NOT_DETECTED_AFTER_SINGLE_DOM_CLICK');
      }
    }
    if (!openDetected) {
      throw new Error('RESUME_MODAL_NOT_DETECTED');
    }

    let networkResult = null;
    if (this.resumeNetworkTracker) {
      networkResult = await this.resumeNetworkTracker.waitForResumeNetworkByMode(customer, {
        minTs: acquisitionStartedAt,
      });
      timings.initialNetworkWaitMs = Number(networkResult?.initialWaitMs || 0);
      timings.networkRetryMs = Number(networkResult?.retryWaitMs || 0);
    }

    if (networkResult?.candidateInfo?.resumeText) {
      await this.checkpoint();
      const evaluationStartedAt = Date.now();
      const evaluation = await this.llmClient.evaluateResume({
        screeningCriteria: profile.screeningCriteria,
        candidate: this.buildResumeCandidateContext(customer, networkResult.candidateInfo),
      });
      timings.textModelMs = Date.now() - evaluationStartedAt;
      return {
        modalOpened,
        capture,
        evaluation,
        timings,
        acquisitionMode: 'network',
        acquisitionReason: networkResult.acquisitionReason || 'initial_network_hit',
        sourceCandidateInfo: networkResult.candidateInfo,
      };
    }

    try {
      await this.checkpoint();
      const captureStartedAt = Date.now();
      capture = await this.resumeCaptureService.captureResume({
        artifactDir,
        waitResumeMs: 30000,
        scrollSettleMs: 500,
      });
      timings.imageCaptureMs = Date.now() - captureStartedAt;
      if (capture?.quality?.likelyBlank) {
        const blankBackoffMs = 45000 + Math.floor(Math.random() * 20000);
        this.setResumeOpenBlocked(blankBackoffMs);
        throw new Error('RESUME_CAPTURE_LIKELY_BLANK');
      }
      const modelImagePaths = Array.isArray(capture.modelImagePaths)
        ? capture.modelImagePaths.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      this.logger.log(`截图完成：chunks=${capture.chunkCount} | modelImages=${modelImagePaths.length}`);
      baseResult.artifacts.chunkDir = capture.chunkDir;
      baseResult.artifacts.metadataFile = capture.metadataFile;
      baseResult.artifacts.stitchedImage = capture.stitchedImage;
      baseResult.artifacts.chunkCount = capture.chunkCount;
      baseResult.artifacts.modelImagePaths = modelImagePaths;

      if (this.resumeNetworkTracker) {
        this.resumeNetworkTracker.setResumeAcquisitionMode('image', 'image_capture_success');
      }

      await this.checkpoint();
      const imageEvalStartedAt = Date.now();
      const evaluation = await this.llmClient.evaluateResume({
        screeningCriteria: profile.screeningCriteria,
        candidate: this.buildResumeCandidateContext(customer, null),
        imagePaths: modelImagePaths,
      });
      timings.imageModelMs = Date.now() - imageEvalStartedAt;
      return {
        modalOpened,
        capture,
        evaluation,
        timings,
        acquisitionMode: 'image_fallback',
        acquisitionReason: 'image_capture_success',
        sourceCandidateInfo: null,
      };
    } catch (imageError) {
      lastResumeError = imageError;
    }

    let lateNetworkResult = null;
    if (this.resumeNetworkTracker) {
      lateNetworkResult = await this.resumeNetworkTracker.waitForLateNetworkResumeCandidateInfo(customer, {
        minTs: acquisitionStartedAt,
      });
      timings.lateNetworkRetryMs = Number(lateNetworkResult?.lateRetryMs || 0);
    }
    if (lateNetworkResult?.candidateInfo?.resumeText) {
      await this.checkpoint();
      const evaluationStartedAt = Date.now();
      const evaluation = await this.llmClient.evaluateResume({
        screeningCriteria: profile.screeningCriteria,
        candidate: this.buildResumeCandidateContext(customer, lateNetworkResult.candidateInfo),
      });
      timings.textModelMs = Date.now() - evaluationStartedAt;
      return {
        modalOpened,
        capture,
        evaluation,
        timings,
        acquisitionMode: 'network',
        acquisitionReason: lateNetworkResult.acquisitionReason || 'late_network_hit',
        sourceCandidateInfo: lateNetworkResult.candidateInfo,
      };
    }

    const domStartedAt = Date.now();
    const domFallback = await this.resolveDomResumeFallback(customer, cardProfile);
    timings.domFallbackMs = Date.now() - domStartedAt;
    if (domFallback?.networkCandidateInfo?.resumeText) {
      await this.checkpoint();
      const evaluationStartedAt = Date.now();
      const evaluation = await this.llmClient.evaluateResume({
        screeningCriteria: profile.screeningCriteria,
        candidate: this.buildResumeCandidateContext(customer, domFallback.networkCandidateInfo),
      });
      timings.textModelMs = Date.now() - evaluationStartedAt;
      return {
        modalOpened,
        capture,
        evaluation,
        timings,
        acquisitionMode: 'network',
        acquisitionReason: domFallback.acquisitionReason || 'dom_retry_network_recheck_hit',
        sourceCandidateInfo: domFallback.networkCandidateInfo,
      };
    }
    if (domFallback?.domCandidateInfo?.resumeText) {
      await this.checkpoint();
      const evaluationStartedAt = Date.now();
      const evaluation = await this.llmClient.evaluateResume({
        screeningCriteria: profile.screeningCriteria,
        candidate: this.buildResumeCandidateContext(customer, domFallback.domCandidateInfo),
      });
      timings.textModelMs = Date.now() - evaluationStartedAt;
      return {
        modalOpened,
        capture,
        evaluation,
        timings,
        acquisitionMode: 'dom_fallback',
        acquisitionReason: domFallback.acquisitionReason || 'dom_initial_hit',
        sourceCandidateInfo: domFallback.domCandidateInfo,
      };
    }

    throw lastResumeError || new Error('DOM_RESUME_FALLBACK_FAILED');
  }

  async restoreListContext(profile) {
    if (typeof this.page.activatePrimaryChatLabel === 'function') {
      await this.page.activatePrimaryChatLabel('全部');
    }
    await this.page.selectJob(profile.jobSelection);
    return profile.startFrom === 'all'
      ? this.page.activateAllFilter()
      : this.page.activateUnreadFilter();
  }

  async waitForCandidateList({
    reason = 'unknown',
    maxWaitMs = CANDIDATE_LIST_WAIT_AFTER_CONTEXT_MS,
    pollMs = CANDIDATE_LIST_WAIT_POLL_MS,
  } = {}) {
    const startedAt = Date.now();
    let attempts = 0;
    let lastState = null;
    let lastError = '';

    while (Date.now() - startedAt <= maxWaitMs) {
      attempts += 1;
      try {
        if (typeof this.page.getPageState === 'function') {
          lastState = await this.page.getPageState();
          if (Number(lastState?.listItemCount || 0) > 0) {
            return {
              ready: true,
              waitedMs: Date.now() - startedAt,
              attempts,
              listItemCount: Number(lastState?.listItemCount || 0),
              lastState,
              lastError,
            };
          }
        } else if (typeof this.page.getLoadedCustomers === 'function') {
          const customers = await this.page.getLoadedCustomers();
          if (Array.isArray(customers) && customers.length > 0) {
            return {
              ready: true,
              waitedMs: Date.now() - startedAt,
              attempts,
              listItemCount: customers.length,
              lastState,
              lastError,
            };
          }
        }
      } catch (error) {
        lastError = String(error?.message || error || '');
      }

      if (Date.now() - startedAt >= maxWaitMs) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return {
      ready: false,
      waitedMs: Date.now() - startedAt,
      attempts,
      listItemCount: Number(lastState?.listItemCount || 0),
      lastState,
      lastError,
      reason,
    };
  }

  async cleanupPanels({
    resumeMaxAttempts = 6,
    detailMaxAttempts = 4,
    ensureDismiss = true,
  } = {}) {
    const resume =
      typeof this.page.closeResumeModalDomOnce === 'function'
        ? await this.page.closeResumeModalDomOnce()
        : await this.page.closeResumeModal({
          maxAttempts: resumeMaxAttempts,
          ensureDismiss,
        });

    let detail = {
      closed: true,
      method: 'unsupported',
      finalState: {
        panelCount: 0,
        closeCount: 0,
        topPanelClass: '',
      },
    };
    if (typeof this.page.closeCandidateDetailDomOnce === 'function') {
      detail = await this.page.closeCandidateDetailDomOnce();
      if (!detail.closed && typeof this.page.closeCandidateDetail === 'function') {
        detail = await this.page.closeCandidateDetail({
          maxAttempts: detailMaxAttempts,
          ensureDismiss,
        });
      }
    } else if (typeof this.page.closeCandidateDetail === 'function') {
      detail = await this.page.closeCandidateDetail({
        maxAttempts: detailMaxAttempts,
        ensureDismiss,
      });
    }

    return { resume, detail };
  }

  isResumeModalVisible(state = {}) {
    return (
      Boolean(state?.open) ||
      Number(state?.iframeCount || 0) > 0 ||
      Number(state?.scopeCount || 0) > 0
    );
  }

  isCandidateDetailVisible(state = {}) {
    return (
      Boolean(state?.open) ||
      Number(state?.panelCount || 0) > 0 ||
      Number(state?.closeCount || 0) > 0
    );
  }

  async ensurePanelsClosedBeforeOutreach({ initialResumeCloseResult = null } = {}) {
    const runResumeLightClose = async () => {
      if (initialResumeCloseResult) {
        return initialResumeCloseResult;
      }
      if (typeof this.page.closeResumeModalDomOnce === 'function') {
        return this.page.closeResumeModalDomOnce();
      }
      if (typeof this.page.closeResumeModal === 'function') {
        return this.page.closeResumeModal({ maxAttempts: 6, ensureDismiss: true });
      }
      return {
        closed: true,
        method: 'unsupported',
        finalState: { open: false, scopeCount: 0, iframeCount: 0, closeCount: 0, topScopeClass: '' },
      };
    };
    const runDetailLightClose = async () => {
      if (typeof this.page.closeCandidateDetailDomOnce === 'function') {
        return this.page.closeCandidateDetailDomOnce();
      }
      if (typeof this.page.closeCandidateDetail === 'function') {
        return this.page.closeCandidateDetail({ maxAttempts: 1, ensureDismiss: false });
      }
      return {
        closed: true,
        method: 'unsupported',
        finalState: {
          open: false,
          panelCount: 0,
          closeCount: 0,
          topPanelClass: '',
          overlayClass: '',
          contentClass: '',
        },
      };
    };
    const methodParts = [];
    let retried = false;
    let readyState = null;

    let resumeResult = await runResumeLightClose();
    let detailResult = await runDetailLightClose();
    methodParts.push(`resume:${resumeResult?.method || 'unknown'}`);
    methodParts.push(`detail:${detailResult?.method || 'unknown'}`);
    this.logger.log(
      `发送前首次关闭结果：resumeClosed=${Boolean(resumeResult?.closed)} | resumeMethod=${resumeResult?.method || 'unknown'} | detailClosed=${Boolean(detailResult?.closed)} | detailMethod=${detailResult?.method || 'unknown'}`,
    );

    let resumeClosed = Boolean(resumeResult?.closed);
    let detailClosed = Boolean(detailResult?.closed);

    if (!resumeClosed && typeof this.page.closeResumeModal === 'function') {
      retried = true;
      resumeResult = await this.page.closeResumeModal({ maxAttempts: 6, ensureDismiss: true });
      methodParts.push(`resume-retry:${resumeResult?.method || 'unknown'}`);
      resumeClosed = Boolean(resumeResult?.closed);
    }

    if (!detailClosed && typeof this.page.closeCandidateDetail === 'function') {
      retried = true;
      detailResult = await this.page.closeCandidateDetail({ maxAttempts: 4, ensureDismiss: true });
      methodParts.push(`detail-retry:${detailResult?.method || 'unknown'}`);
      detailClosed = Boolean(detailResult?.closed);
    }

    let resumeState = resumeResult?.finalState || null;
    let detailState = detailResult?.finalState || null;

    if (typeof this.page.getResumeModalState === 'function') {
      resumeState = await this.page.getResumeModalState();
      resumeClosed = !this.isResumeModalVisible(resumeState);
    }
    if (typeof this.page.getCandidateDetailState === 'function') {
      detailState = await this.page.getCandidateDetailState();
      detailClosed = !this.isCandidateDetailVisible(detailState);
    }

    if (retried) {
      this.logger.log(
        `发送前重试关闭结果：resumeClosed=${resumeClosed} | resumeMethod=${resumeResult?.method || 'unknown'} | detailClosed=${detailClosed} | detailMethod=${detailResult?.method || 'unknown'}`,
      );
    }

    let failureReason = '';
    if (resumeClosed && detailClosed) {
      try {
        readyState = await this.page.waitForConversationReady({
          maxAttempts: 12,
          delayMs: 220,
          requirePanelsClosed: true,
        });
        methodParts.push('ready:strict');
      } catch (error) {
        failureReason = `strict-ready-check-failed:${error?.message || error}`;
        methodParts.push(failureReason);
      }
    } else {
      failureReason = [
        !resumeClosed ? 'resume-modal-still-open' : '',
        !detailClosed ? 'candidate-detail-still-open' : '',
      ].filter(Boolean).join('+');
    }

    const diagnostics = {
      preActionResumeClosed: resumeClosed,
      preActionDetailClosed: detailClosed,
      preActionCleanupMethod: methodParts.join('|'),
      preActionCleanupRetried: retried,
      preActionCleanupFailureReason: failureReason,
    };

    return {
      ok: resumeClosed && detailClosed && Boolean(readyState?.panelsClosed),
      readyState,
      diagnostics,
      resumeResult,
      detailResult,
      resumeState,
      detailState,
    };
  }

  async run(profile) {
    const startedAt = new Date().toISOString();
    const runId = runToken(new Date());
    const startFrom = profile.startFrom === 'all' ? 'all' : 'unread';
    const filterLabel = startFrom === 'all' ? '全部' : '未读';
    const targetCount =
      Number.isFinite(Number(profile.targetCount)) && Number(profile.targetCount) > 0
        ? Number(profile.targetCount)
        : null;

    await this.stateStore.load();
    try {
      await this.page.ensureReady();
    } catch (error) {
      this.logger.log(`页面就绪检查告警：${error?.message || error}，将继续执行预热恢复流程。`);
    }
    let filterResult = await this.restoreListContext(profile);
    await this.interaction.sleepRange(420, 160);
    let initialListWait = await this.waitForCandidateList({
      reason: 'initial-context-restore',
    });
    if (initialListWait.ready) {
      this.logger.log(
        `候选人列表已就绪：reason=initial-context-restore | waited=${initialListWait.waitedMs}ms | attempts=${initialListWait.attempts} | count=${initialListWait.listItemCount}`,
      );
    } else {
      this.logger.log(
        `候选人列表等待超时：reason=initial-context-restore | waited=${initialListWait.waitedMs}ms | attempts=${initialListWait.attempts} | count=${initialListWait.listItemCount} | lastError=${initialListWait.lastError || 'n/a'}，继续尝试预热。`,
      );
      filterResult = await this.restoreListContext(profile);
      await this.interaction.sleepRange(420, 160);
      initialListWait = await this.waitForCandidateList({
        reason: 'initial-context-restore-reapply',
      });
      if (initialListWait.ready) {
        this.logger.log(
          `候选人列表二次恢复成功：reason=initial-context-restore-reapply | waited=${initialListWait.waitedMs}ms | attempts=${initialListWait.attempts} | count=${initialListWait.listItemCount}`,
        );
      } else {
        this.logger.log(
          `候选人列表二次等待仍超时：reason=initial-context-restore-reapply | waited=${initialListWait.waitedMs}ms | attempts=${initialListWait.attempts} | count=${initialListWait.listItemCount} | lastError=${initialListWait.lastError || 'n/a'}，继续尝试预热。`,
        );
      }
    }
    this.logger.log('预热步骤：准备点击首位人选初始化聊天容器...');
    let primedCustomer = null;

    if (typeof this.page.primeConversationByFirstCandidate === 'function') {
      try {
        const prime = await this.page.primeConversationByFirstCandidate();
        const candidate = prime?.candidate || {};
        const candidateBase = {
          customerId: candidate.customerId || '',
          name: candidate.name || '',
          sourceJob: candidate.sourceJob || '',
          domIndex: Number.isFinite(candidate.domIndex) ? candidate.domIndex : 0,
          textSnippet: '',
        };
        primedCustomer = {
          ...candidateBase,
          customerKey: createCustomerKey(candidateBase),
        };
        this.logger.log(
          `预热完成：name=${prime?.candidate?.name || '未知'} | job=${prime?.candidate?.sourceJob || '未知'} | id=${prime?.candidate?.customerId || '无'} | domIndex=${prime?.candidate?.domIndex ?? -1} | 候选人数=${prime?.totalVisibleCandidates ?? '未知'} | ready=${prime?.readyState?.hasOnlineResume ? 'online_resume' : prime?.readyState?.hasAskResume ? 'ask_resume' : 'unknown'}`,
        );
      } catch (error) {
        this.logger.log(`预热失败：${error?.message || error}（将继续尝试主循环）`);
      }
    }

    const results = [];
    const summary = {
      startedAt,
      finishedAt: null,
      dryRun: this.dryRun,
      profile: {
        screeningCriteria: profile.screeningCriteria,
        targetCount,
        chromePort: profile.chrome.port,
        model: profile.llm.model,
        startFrom,
        jobSelection: profile.jobSelection,
      },
      inspected: 0,
      passed: 0,
      requested: 0,
      skipped: 0,
      errors: 0,
      exhausted: false,
      stopped: false,
      stopReason: '',
      results,
      reportPath: null,
    };

    this.logger.log(
      `岗位: ${profile.jobSelection?.label || profile.jobSelection?.value || '未知'}；列表范围: ${filterLabel}${
        filterResult.changed
          ? filterResult.verified === false
            ? '（已尝试切换，未验证 active）'
            : '（已切换）'
          : '（已在目标筛选）'
      }${filterResult?.activeLabel ? ` | active=${filterResult.activeLabel}` : ''}`,
    );
    this.logger.log(this.formatProgress(summary));
    this.emitProgress(summary, {
      stage: 'running',
      message: '任务已启动。',
    });

    let consecutiveErrors = 0;
    let exhaustedScrolls = 0;
    let noMoreMarkerHits = 0;
    let fallbackBottomHits = 0;
    const noMoreMarkerConfirmations = 2;
    const exhaustedScrollLimit = targetCount ? 10 : 60;
    const fallbackBottomLimit = targetCount ? 4 : 12;

    try {
      while (shouldContinue(summary, targetCount)) {
        await this.checkpoint();
        if (this.resumeOpenBlockedUntil > Date.now()) {
          const remainMs = this.resumeOpenBlockedUntil - Date.now();
          this.logger.log(
            `简历查看冷却中：remaining=${Math.ceil(remainMs / 1000)}s，暂停打开新简历以避免频控。`,
          );
          await new Promise((resolve) => setTimeout(resolve, Math.min(remainMs, 30000)));
          continue;
        }
        await this.interaction.maybeRest(summary.inspected, this.logger);
        await this.checkpoint();

        let loadedCustomers = [];
        try {
          loadedCustomers = await this.page.getLoadedCustomers();
        } catch (error) {
          const message = String(error?.message || error || '');
          this.logger.log(`候选人扫描异常：${message}`);
          if (
            /CHAT_CARD_LIST_NOT_FOUND|CHAT_LIST_CONTAINER_NOT_FOUND|ACTIVE_TAB_IS_NOT_BOSS_CHAT_PAGE/.test(
              message,
            )
          ) {
            const delayedListWait = await this.waitForCandidateList({
              reason: `main-loop:${message}`,
            });
            if (delayedListWait.ready) {
              this.logger.log(
                `候选人列表延迟恢复成功：reason=main-loop:${message} | waited=${delayedListWait.waitedMs}ms | attempts=${delayedListWait.attempts} | count=${delayedListWait.listItemCount}，继续重试扫描。`,
              );
              continue;
            }
            try {
              const recover = await this.page.recoverToChatIndex();
              this.logger.log(
                `页面恢复：changed=${recover.changed} | href=${recover.href || 'unknown'}，准备重新预热并继续。`,
              );
              await this.interaction.sleepRange(900, 220);
              let recoveredFilterResult = await this.restoreListContext(profile);
              this.logger.log(
                `恢复后列表上下文：岗位=${profile.jobSelection?.label || profile.jobSelection?.value || '未知'}；列表范围: ${filterLabel}${
                  recoveredFilterResult.changed
                    ? recoveredFilterResult.verified === false
                      ? '（已尝试切换，未验证 active）'
                      : '（已切换）'
                    : '（已在目标筛选）'
                }${recoveredFilterResult?.activeLabel ? ` | active=${recoveredFilterResult.activeLabel}` : ''}`,
              );
              let recoveredListWait = await this.waitForCandidateList({
                reason: 'post-recovery-context-restore',
              });
              if (recoveredListWait.ready) {
                this.logger.log(
                  `恢复后候选人列表已就绪：reason=post-recovery-context-restore | waited=${recoveredListWait.waitedMs}ms | attempts=${recoveredListWait.attempts} | count=${recoveredListWait.listItemCount}`,
                );
              } else {
                this.logger.log(
                  `恢复后候选人列表等待超时：reason=post-recovery-context-restore | waited=${recoveredListWait.waitedMs}ms | attempts=${recoveredListWait.attempts} | count=${recoveredListWait.listItemCount} | lastError=${recoveredListWait.lastError || 'n/a'}，继续尝试预热。`,
                );
                recoveredFilterResult = await this.restoreListContext(profile);
                this.logger.log(
                  `恢复后二次应用列表上下文：岗位=${profile.jobSelection?.label || profile.jobSelection?.value || '未知'}；列表范围: ${filterLabel}${
                    recoveredFilterResult.changed
                      ? recoveredFilterResult.verified === false
                        ? '（已尝试切换，未验证 active）'
                        : '（已切换）'
                      : '（已在目标筛选）'
                  }${recoveredFilterResult?.activeLabel ? ` | active=${recoveredFilterResult.activeLabel}` : ''}`,
                );
                await this.interaction.sleepRange(420, 160);
                recoveredListWait = await this.waitForCandidateList({
                  reason: 'post-recovery-context-restore-reapply',
                });
                if (recoveredListWait.ready) {
                  this.logger.log(
                    `恢复后二次候选人列表恢复成功：reason=post-recovery-context-restore-reapply | waited=${recoveredListWait.waitedMs}ms | attempts=${recoveredListWait.attempts} | count=${recoveredListWait.listItemCount}`,
                  );
                } else {
                  this.logger.log(
                    `恢复后二次候选人列表等待仍超时：reason=post-recovery-context-restore-reapply | waited=${recoveredListWait.waitedMs}ms | attempts=${recoveredListWait.attempts} | count=${recoveredListWait.listItemCount} | lastError=${recoveredListWait.lastError || 'n/a'}，继续尝试预热。`,
                  );
                }
              }
              const prime = await this.page.primeConversationByFirstCandidate();
              const candidate = prime?.candidate || {};
              const candidateBase = {
                customerId: candidate.customerId || '',
                name: candidate.name || '',
                sourceJob: candidate.sourceJob || '',
                domIndex: Number.isFinite(candidate.domIndex) ? candidate.domIndex : 0,
                textSnippet: '',
              };
              primedCustomer = {
                ...candidateBase,
                customerKey: createCustomerKey(candidateBase),
              };
              this.logger.log(
                `恢复后预热完成：name=${prime?.candidate?.name || '未知'} | id=${prime?.candidate?.customerId || '无'}`,
              );
              continue;
            } catch (recoverError) {
              throw new Error(
                `CHAT_LIST_RECOVERY_FAILED: ${recoverError?.message || recoverError}`,
              );
            }
          }
          throw error;
        }

        const shouldUsePrimedFirst =
          Boolean(primedCustomer) &&
          (startFrom === 'unread' || !this.stateStore.hasAny(createCustomerAliases(primedCustomer)));
        if (shouldUsePrimedFirst && primedCustomer) {
          this.logger.log(
            `优先处理预热候选人：name=${primedCustomer.name || '未知'} | key=${primedCustomer.customerKey}`,
          );
          const result = await this.processCustomer(primedCustomer, profile, runId, {
            skipCardClick: true,
          });
          primedCustomer = null;
          results.push(result);
          summary.inspected += 1;

          if (result.error) {
            summary.errors += 1;
            consecutiveErrors += 1;
          } else {
            consecutiveErrors = 0;
          }
          if (result.passed) summary.passed += 1;
          if (result.requested) summary.requested += 1;
          if (!result.passed && !result.error) summary.skipped += 1;

          this.logger.log(
            `候选人结果: ${result.name || '未知'} | ${result.passed ? 'passed' : result.error ? 'error' : 'skipped'}${result.reason ? ` | ${result.reason}` : ''}${result.error ? ` | ${result.error}` : ''}`,
          );
          this.logger.log(this.formatProgress(summary));
          this.emitProgress(summary, {
            stage: 'running',
            message: `已处理候选人：${result.name || '未知'}`,
          });
          exhaustedScrolls = 0;
          noMoreMarkerHits = 0;
          fallbackBottomHits = 0;
          if (consecutiveErrors >= 3) {
            this.logger.log('连续 3 位候选人处理失败，提前停止本轮运行。');
            break;
          }
          continue;
        }
        primedCustomer = null;

        this.logger.log(`候选人扫描：当前可见 ${loadedCustomers.length} 位`);
        const nextCustomer = loadedCustomers.find(
          (customer) => !this.stateStore.hasAny(createCustomerAliases(customer)),
        );

        if (!nextCustomer) {
          const ratio = 0.52 + Math.random() * 0.34;
          const scrollResult = await this.page.scrollCustomerList(ratio);
          const noMoreDetected =
            Boolean(scrollResult.noMoreDetectedAfter) || Boolean(scrollResult.noMoreDetectedBefore);
          this.logger.log(
            `列表滚动：ratio=${ratio.toFixed(2)} | didScroll=${Boolean(scrollResult.didScroll)} | top=${scrollResult.after?.top ?? 'n/a'} | atBottom=${Boolean(scrollResult.atBottom)} | noMore=${noMoreDetected}${scrollResult.noMoreTextAfter ? `(${scrollResult.noMoreTextAfter})` : ''} | scrollRetry=${exhaustedScrolls + 1}`,
          );
          if (noMoreDetected) {
            noMoreMarkerHits += 1;
            if (noMoreMarkerHits >= noMoreMarkerConfirmations) {
              summary.exhausted = true;
              this.logger.log('列表滚动终止：检测到“没有更多了”标识，判定为 exhausted。');
              break;
            }
            await this.interaction.sleepRange(920, 260);
            continue;
          }

          noMoreMarkerHits = 0;
          exhaustedScrolls = scrollResult.didScroll ? exhaustedScrolls + 1 : exhaustedScrolls + 2;
          fallbackBottomHits = scrollResult.atBottom ? fallbackBottomHits + 1 : 0;
          if (fallbackBottomHits >= fallbackBottomLimit && exhaustedScrolls >= Math.ceil(exhaustedScrollLimit / 2)) {
            summary.exhausted = true;
            this.logger.log('列表滚动终止：未发现“没有更多了”标识，但已多次触底且无可处理候选人，判定为 exhausted。');
            break;
          }
          if (exhaustedScrolls >= exhaustedScrollLimit) {
            summary.exhausted = true;
            this.logger.log('列表滚动终止：连续无可处理候选人达到保护上限，判定为 exhausted。');
            break;
          }
          await this.interaction.sleepRange(920, 260);
          continue;
        }

        exhaustedScrolls = 0;
        noMoreMarkerHits = 0;
        fallbackBottomHits = 0;
        this.logger.log(
          `准备处理候选人：name=${nextCustomer.name || '未知'} | key=${nextCustomer.customerKey} | job=${nextCustomer.sourceJob || '未知'} | domIndex=${nextCustomer.domIndex}`,
        );
        const result = await this.processCustomer(nextCustomer, profile, runId, {
          skipCardClick: false,
        });
        results.push(result);
        summary.inspected += 1;

        if (result.error) {
          summary.errors += 1;
          consecutiveErrors += 1;
        } else {
          consecutiveErrors = 0;
        }
        if (result.passed) summary.passed += 1;
        if (result.requested) summary.requested += 1;
        if (!result.passed && !result.error) summary.skipped += 1;

        this.logger.log(
          `候选人结果: ${result.name || '未知'} | ${result.passed ? 'passed' : result.error ? 'error' : 'skipped'}${result.reason ? ` | ${result.reason}` : ''}${result.error ? ` | ${result.error}` : ''}`,
        );
        this.logger.log(this.formatProgress(summary));
        this.emitProgress(summary, {
          stage: 'running',
          message: `已处理候选人：${result.name || '未知'}`,
        });

        if (consecutiveErrors >= 3) {
          this.logger.log('连续 3 位候选人处理失败，提前停止本轮运行。');
          break;
        }
      }
    } catch (error) {
      if (error?.name !== 'StopRequestedError') {
        throw error;
      }
      summary.stopped = true;
      summary.stopReason = error.message;
      this.emitProgress(summary, {
        stage: 'running',
        message: `运行停止：${summary.stopReason}`,
      });
    }

    try {
      const finalClose = await this.cleanupPanels({
        resumeMaxAttempts: 6,
        detailMaxAttempts: 4,
        ensureDismiss: true,
      });
      this.logger.log(
        `运行收尾关闭弹层：resumeClosed=${finalClose.resume.closed} | resumeMethod=${finalClose.resume.method} | detailClosed=${finalClose.detail.closed} | detailMethod=${finalClose.detail.method}`,
      );
    } catch (cleanupError) {
      this.logger.log(`运行收尾清理告警：${cleanupError?.message || cleanupError}`);
    }

    summary.finishedAt = new Date().toISOString();
    summary.reportPath = await this.reportStore.write(summary);
    this.emitProgress(summary, {
      stage: 'finalize',
      message: summary.stopped ? '任务已停止并完成收尾。' : '任务执行完成。',
    });
    return summary;
  }

  async processCustomer(customer, profile, runId, options = {}) {
    const skipCardClick = Boolean(options?.skipCardClick);
    const baseAliases = createCustomerAliases(customer);
    const baseResult = {
      customerKey: customer.customerKey,
      name: customer.name || '',
      sourceJob: customer.sourceJob || '',
      decision: 'skipped',
      passed: false,
      requested: false,
      reason: '',
      error: '',
      artifacts: {},
    };

    let modalOpened = false;
    try {
      this.logger.log(`候选人开始：${customer.name || '未知'} (${customer.customerKey})`);
      const preClose = await this.cleanupPanels({
        resumeMaxAttempts: 4,
        detailMaxAttempts: 3,
        ensureDismiss: true,
      });
      if (
        preClose.resume.method !== 'already-closed' ||
        preClose.detail.method !== 'already-closed'
      ) {
        this.logger.log(
          `候选人开始前清理残留面板：resumeClosed=${preClose.resume.closed} | resumeMethod=${preClose.resume.method} | detailClosed=${preClose.detail.closed} | detailMethod=${preClose.detail.method}`,
        );
      }
      if (!skipCardClick) {
        await this.checkpoint();
        const drift = Math.round((Math.random() - 0.5) * 46);
        this.logger.log(`卡片定位：domIndex=${customer.domIndex} | drift=${drift}`);
        if (typeof this.page.activateCandidate === 'function') {
          await this.page.activateCandidate(customer, drift);
        } else {
          const rect = await this.page.centerCustomerCard(customer.domIndex, drift);
          await this.interaction.sleepRange(320, 120);
          await this.checkpoint();
          await this.interaction.clickRect(rect);
        }
        await this.interaction.sleepRange(860, 280);
        let activated = await this.page.waitForCandidateActivated(customer, {
          maxAttempts: 12,
          delayMs: 220,
        });
        if (!activated?.matched) {
          this.logger.log(
            `候选人激活首次校验未命中，开始重试：expectedId=${customer.customerId || 'n/a'} | expectedName=${customer.name || 'n/a'} | activeId=${activated?.customerId || 'n/a'} | activeName=${activated?.name || 'n/a'}`,
          );
          for (let retry = 0; retry < 2; retry += 1) {
            const retryDrift = Math.round((Math.random() - 0.5) * 36);
            if (typeof this.page.activateCandidate === 'function') {
              await this.page.activateCandidate(customer, retryDrift);
            } else {
              const retryRect = await this.page.centerCustomerCard(customer.domIndex, retryDrift);
              await this.interaction.clickRect(retryRect);
            }
            await this.interaction.sleepRange(700, 200);
            activated = await this.page.waitForCandidateActivated(customer, {
              maxAttempts: 8,
              delayMs: 180,
            });
            if (activated?.matched) break;
          }
          if (!activated?.matched) {
            baseResult.decision = 'skipped';
            baseResult.reason = `候选人上下文切换失败，已跳过避免误判（expected=${customer.name || customer.customerId || 'unknown'}, active=${activated?.name || activated?.customerId || 'unknown'}）`;
            this.logger.log(
              `候选人跳过：name=${customer.name || '未知'} | key=${customer.customerKey} | reason=${baseResult.reason}`,
            );
            await this.stateStore.record(baseResult.customerKey, baseResult, baseAliases);
            return baseResult;
          }
        }
      } else {
        this.logger.log('复用预热候选人上下文，跳过再次点击卡片。');
      }
      await this.checkpoint();
      const readyState = await this.page.waitForConversationReady();
      this.logger.log(
        `会话面板就绪。onlineResume=${Boolean(readyState?.hasOnlineResume)} | askResume=${Boolean(readyState?.hasAskResume)} | attachmentResume=${Boolean(readyState?.hasAttachmentResume)} | attachmentResumeEnabled=${Boolean(readyState?.attachmentResumeEnabled)}`,
      );
      if (readyState?.attachmentResumeEnabled) {
        baseResult.decision = 'skipped';
        baseResult.reason = '检测到附件简历按钮可用，按策略跳过，不进入在线简历截图与LLM评估。';
        baseResult.artifacts.attachmentResume = {
          present: Boolean(readyState?.hasAttachmentResume),
          enabled: Boolean(readyState?.attachmentResumeEnabled),
          className: String(readyState?.attachmentResumeClass || ''),
        };
        this.logger.log(
          `候选人跳过：name=${customer.name || '未知'} | key=${customer.customerKey} | reason=${baseResult.reason}`,
        );
        await this.stateStore.record(baseResult.customerKey, baseResult, baseAliases);
        return baseResult;
      }
      if (!readyState?.hasOnlineResume) {
        throw new Error('ONLINE_RESUME_UNAVAILABLE');
      }

      const candidateToken = safePathToken(customer.customerKey || customer.name || 'candidate');
      const artifactDir = path.join(this.artifactRootDir, runId, candidateToken);
      await mkdir(artifactDir, { recursive: true });

      const acquisition = await this.acquireResumeAndEvaluate(
        customer,
        profile,
        artifactDir,
        baseResult,
      );
      const evaluation = acquisition.evaluation;
      const capture = acquisition.capture;
      modalOpened = Boolean(acquisition.modalOpened);
      const finalReason =
        normalizeText(evaluation.reason || evaluation.summary || evaluation.cot) ||
        (evaluation.passed ? 'LLM判定通过' : 'LLM判定不通过');
      this.logger.log(
        `LLM评估完成：passed=${evaluation.passed} | source=${acquisition.acquisitionMode} | reason=${acquisition.acquisitionReason || 'n/a'} | mode=${evaluation.evaluationMode || 'unknown'} | imageCount=${Number(evaluation.imageCount || baseResult.artifacts.modelImagePaths?.length || 0)} | result=${normalizeText(evaluation.rawOutputText || '') || 'n/a'}`,
      );

      baseResult.reason = finalReason;
      baseResult.passed = evaluation.passed;
      baseResult.decision = evaluation.passed ? 'passed' : 'skipped';
      baseResult.artifacts.finalPassed = Boolean(evaluation.passed);
      baseResult.artifacts.evaluationMode = String(evaluation.evaluationMode || '');
      baseResult.artifacts.evaluationImageCount = Number.isFinite(Number(evaluation.imageCount))
        ? Number(evaluation.imageCount)
        : Array.isArray(baseResult.artifacts.modelImagePaths)
        ? baseResult.artifacts.modelImagePaths.length
        : 0;
      baseResult.artifacts.evaluationChunkIndex = Number.isFinite(Number(evaluation.chunkIndex))
        ? Number(evaluation.chunkIndex)
        : null;
      baseResult.artifacts.evaluationChunkTotal = Number.isFinite(Number(evaluation.chunkTotal))
        ? Number(evaluation.chunkTotal)
        : null;
      baseResult.artifacts.evaluationAggregateRetryUsed = evaluation.aggregateRetryUsed === true;
      baseResult.artifacts.llmReason = normalizeText(evaluation.reason || '');
      baseResult.artifacts.llmSummary = normalizeText(evaluation.summary || '');
      baseResult.artifacts.llmCot = normalizeText(evaluation.cot || '');
      baseResult.artifacts.llmEvidence = toStringArray(evaluation.evidence);
      baseResult.artifacts.llmRawReasoning = String(evaluation.rawReasoningText || '');
      baseResult.artifacts.llmRawOutput = String(evaluation.rawOutputText || '');
      baseResult.artifacts.resumeAcquisitionMode = String(acquisition.acquisitionMode || '');
      baseResult.artifacts.resumeAcquisitionReason = String(acquisition.acquisitionReason || '');
      baseResult.artifacts.initialNetworkWaitMs = Number(acquisition.timings?.initialNetworkWaitMs || 0);
      baseResult.artifacts.networkRetryMs = Number(acquisition.timings?.networkRetryMs || 0);
      baseResult.artifacts.imageCaptureMs = Number(acquisition.timings?.imageCaptureMs || 0);
      baseResult.artifacts.imageModelMs = Number(acquisition.timings?.imageModelMs || 0);
      baseResult.artifacts.lateNetworkRetryMs = Number(acquisition.timings?.lateNetworkRetryMs || 0);
      baseResult.artifacts.domFallbackMs = Number(acquisition.timings?.domFallbackMs || 0);
      baseResult.artifacts.textModelMs = Number(acquisition.timings?.textModelMs || 0);
      if (acquisition.sourceCandidateInfo) {
        baseResult.artifacts.resumeProfile = {
          primarySchool: normalizeText(acquisition.sourceCandidateInfo.school || ''),
          schools: Array.isArray(acquisition.sourceCandidateInfo.schools)
            ? acquisition.sourceCandidateInfo.schools
            : [],
          major: normalizeText(acquisition.sourceCandidateInfo.major || ''),
          majors: Array.isArray(acquisition.sourceCandidateInfo.majors)
            ? acquisition.sourceCandidateInfo.majors
            : [],
          company: normalizeText(acquisition.sourceCandidateInfo.company || ''),
          position: normalizeText(acquisition.sourceCandidateInfo.position || ''),
          resumeTextLength: String(acquisition.sourceCandidateInfo.resumeText || '').length,
          evidenceCorpusLength: String(
            acquisition.sourceCandidateInfo.evidenceCorpus || acquisition.sourceCandidateInfo.resumeText || '',
          ).length,
        };
      }
      if (this.resumeNetworkTracker) {
        baseResult.artifacts.resumeNetworkMode = this.resumeNetworkTracker.getResumeAcquisitionState().mode;
        baseResult.artifacts.resumeNetworkModeReason =
          this.resumeNetworkTracker.getResumeAcquisitionState().reason;
        baseResult.artifacts.resumeNetworkDiagnostics =
          this.resumeNetworkTracker.resumeNetworkDiagnostics.slice(-12);
      }

      await this.checkpoint();
      const closeResult =
        typeof this.page.closeResumeModalDomOnce === 'function'
          ? await this.page.closeResumeModalDomOnce()
          : await this.page.closeResumeModal({ maxAttempts: 6, ensureDismiss: true });
      modalOpened = false;
      baseResult.artifacts.resumeCloseMethod = closeResult.method;
      baseResult.artifacts.resumeClosed = closeResult.closed;
      this.logger.log(
        `简历关闭结果：closed=${closeResult.closed} | method=${closeResult.method} | scope=${closeResult?.finalState?.scopeCount ?? 'n/a'} | iframe=${closeResult?.finalState?.iframeCount ?? 'n/a'} | close=${closeResult?.finalState?.closeCount ?? 'n/a'} | class=${closeResult?.finalState?.topScopeClass || 'n/a'}`,
      );
      if (!closeResult.closed) {
        baseResult.artifacts.resumeCloseWarning = 'resume modal not fully closed by single DOM close';
      }

      if (evaluation.passed && !this.dryRun) {
        await this.checkpoint();
        const preAction = await this.ensurePanelsClosedBeforeOutreach({
          initialResumeCloseResult: closeResult,
        });
        Object.assign(baseResult.artifacts, preAction.diagnostics);
        if (!preAction.ok) {
          baseResult.decision = 'skipped';
          baseResult.passed = false;
          baseResult.requested = false;
          baseResult.reason =
            '发送前未能安全关闭简历/详情面板，已跳过避免触发风控';
          this.logger.log(
            `候选人跳过：name=${customer.name || '未知'} | key=${customer.customerKey} | reason=${baseResult.reason} | cleanupFailure=${preAction.diagnostics.preActionCleanupFailureReason || 'unknown'}`,
          );
          const finalPanels = await this.cleanupPanels({
            resumeMaxAttempts: 4,
            detailMaxAttempts: 4,
            ensureDismiss: true,
          });
          baseResult.artifacts.finalResumeCloseMethod = finalPanels.resume.method;
          baseResult.artifacts.finalResumeClosed = finalPanels.resume.closed;
          baseResult.artifacts.finalDetailCloseMethod = finalPanels.detail.method;
          baseResult.artifacts.finalDetailClosed = finalPanels.detail.closed;
          await this.stateStore.record(baseResult.customerKey, baseResult, baseAliases);
          return baseResult;
        }

        const greetingText = resolveGreetingText(profile);
        this.logger.log(`候选人通过，先发送消息：${greetingText}`);
        await this.checkpoint();
        const editorState = await this.page.setEditorMessage(greetingText);
        if (!normalizeText(editorState?.value || '').includes(normalizeText(greetingText))) {
          throw new Error('CHAT_EDITOR_MESSAGE_MISMATCH');
        }
        this.logger.log(
          `招呼语写入输入框：activeSubmit=${Boolean(editorState?.activeSubmit)} | valueLen=${String(editorState?.value || '').length}`,
        );
        await this.interaction.sleepRange(320, 120);
        await this.checkpoint();
        const sendResult = await this.page.sendMessage(greetingText);
        if (!sendResult?.sent) {
          throw new Error(
            `CHAT_GREETING_SEND_FAILED(method=${sendResult?.method || 'unknown'},editorAfter=${sendResult?.editorAfter || ''})`,
          );
        }
        baseResult.artifacts.greetingMessage = greetingText;
        baseResult.artifacts.greetingSent = Boolean(sendResult?.sent);
        baseResult.artifacts.greetingSendMethod = sendResult?.method || 'unknown';
        this.logger.log(
          `招呼语发送结果：sent=${Boolean(sendResult?.sent)} | method=${sendResult?.method || 'unknown'} | cleared=${Boolean(sendResult?.cleared)} | editorAfter=${sendResult?.editorAfter || ''}`,
        );
        await this.interaction.sleepRange(360, 120);

        this.logger.log('候选人通过，执行求简历动作。');
        const maxRequestAttempts = 3;
        let requestSucceeded = false;
        let lastAttempt = null;

        for (let requestAttempt = 0; requestAttempt < maxRequestAttempts; requestAttempt += 1) {
          await this.checkpoint();
          const messageBefore =
            typeof this.page.getResumeRequestMessageState === 'function'
              ? await this.page.getResumeRequestMessageState()
              : { ok: false, count: 0, lastText: '', recent: [] };
          const askResult = await this.page.clickAskResume();
          await this.interaction.sleepRange(460, 150);

          let confirmResult = {
            confirmed: false,
            requestedVerified: false,
            assumedRequested: false,
            uiState: null,
          };
          if (!askResult?.alreadyRequested) {
            await this.checkpoint();
            confirmResult = await this.page.clickConfirmRequestResume();
          }

          let messageObserved = false;
          let messageAfter = null;
          if (typeof this.page.waitForResumeRequestMessage === 'function') {
            const messageCheck = await this.page.waitForResumeRequestMessage({
              baselineCount: Number(messageBefore?.count || 0),
              timeoutMs: 7000,
              pollMs: 260,
            });
            messageAfter = messageCheck?.state || null;
            messageObserved = Boolean(messageCheck?.observed) || hasResumeRequestSentMessage(messageAfter || {});
          }

          const requestedVerified = Boolean(messageObserved);
          lastAttempt = {
            attempt: requestAttempt + 1,
            askResult,
            confirmResult,
            messageBefore,
            messageAfter,
            messageObserved,
            requestedVerified,
          };

          if (messageAfter) {
            baseResult.artifacts.resumeRequestMessageBefore = Number(messageBefore?.count || 0);
            baseResult.artifacts.resumeRequestMessageAfter = Number(messageAfter?.count || 0);
            baseResult.artifacts.resumeRequestMessageObserved = messageObserved;
            baseResult.artifacts.resumeRequestMessageLastText = String(messageAfter?.lastText || '');
          }

          this.logger.log(
            `求简历动作检查：attempt=${requestAttempt + 1}/${maxRequestAttempts} | alreadyRequested=${Boolean(askResult?.alreadyRequested)} | confirmed=${Boolean(confirmResult?.confirmed)} | disabledOperateAsk=${Boolean(confirmResult?.uiState?.hasDisabledOperateAsk)} | messageObserved=${messageObserved} | verified=${requestedVerified} | assumed=${Boolean(confirmResult?.assumedRequested)}`,
          );

          if (requestedVerified) {
            requestSucceeded = true;
            break;
          }

          if (requestAttempt < maxRequestAttempts - 1) {
            this.logger.log('未检测到“简历请求已发送”提示，重新发起求简历。');
            await this.interaction.sleepRange(640, 180);
          }
        }

        baseResult.requested = requestSucceeded;
        if (!requestSucceeded) {
          const confirmStateText = JSON.stringify(lastAttempt?.confirmResult?.uiState || {});
          throw new Error(
            `REQUEST_RESUME_MESSAGE_NOT_OBSERVED(state=${confirmStateText},messageBefore=${Number(lastAttempt?.messageBefore?.count || 0)},messageAfter=${Number(lastAttempt?.messageAfter?.count || 0)},attempts=${maxRequestAttempts})`,
          );
        }
      }

      const finalPanels = await this.cleanupPanels({
        resumeMaxAttempts: 4,
        detailMaxAttempts: 4,
        ensureDismiss: true,
      });
      baseResult.artifacts.finalResumeCloseMethod = finalPanels.resume.method;
      baseResult.artifacts.finalResumeClosed = finalPanels.resume.closed;
      baseResult.artifacts.finalDetailCloseMethod = finalPanels.detail.method;
      baseResult.artifacts.finalDetailClosed = finalPanels.detail.closed;
      if (
        finalPanels.resume.method !== 'already-closed' ||
        finalPanels.detail.method !== 'already-closed'
      ) {
        this.logger.log(
          `候选人收尾清理：resumeClosed=${finalPanels.resume.closed} | resumeMethod=${finalPanels.resume.method} | detailClosed=${finalPanels.detail.closed} | detailMethod=${finalPanels.detail.method}`,
        );
      }

      await this.stateStore.record(baseResult.customerKey, baseResult, baseAliases);
      return baseResult;
    } catch (error) {
      if (error?.name === 'StopRequestedError') {
        throw error;
      }

      if (modalOpened || typeof this.page.closeCandidateDetailDomOnce === 'function' || typeof this.page.closeCandidateDetail === 'function') {
        try {
          const closeResult = await this.cleanupPanels({
            resumeMaxAttempts: 6,
            detailMaxAttempts: 4,
            ensureDismiss: true,
          });
          baseResult.artifacts.resumeCloseMethod = closeResult.resume.method;
          baseResult.artifacts.resumeClosed = closeResult.resume.closed;
          baseResult.artifacts.finalDetailCloseMethod = closeResult.detail.method;
          baseResult.artifacts.finalDetailClosed = closeResult.detail.closed;
          this.logger.log(
            `异常后关闭面板结果：resumeClosed=${closeResult.resume.closed} | resumeMethod=${closeResult.resume.method} | resumeScope=${closeResult?.resume?.finalState?.scopeCount ?? 'n/a'} | resumeIframe=${closeResult?.resume?.finalState?.iframeCount ?? 'n/a'} | resumeClose=${closeResult?.resume?.finalState?.closeCount ?? 'n/a'} | resumeClass=${closeResult?.resume?.finalState?.topScopeClass || 'n/a'} | detailClosed=${closeResult.detail.closed} | detailMethod=${closeResult.detail.method} | detailPanels=${closeResult?.detail?.finalState?.panelCount ?? 'n/a'} | detailClose=${closeResult?.detail?.finalState?.closeCount ?? 'n/a'} | detailClass=${closeResult?.detail?.finalState?.topPanelClass || 'n/a'}`,
          );
        } catch {}
      }

      const message = error.message || String(error);
      if (
        /ONLINE_RESUME_UNAVAILABLE|ONLINE_RESUME_BUTTON_NOT_FOUND|OPEN_ONLINE_RESUME_FAILED|NO_RESUME_IFRAME|NO_SCROLL_CONTAINER|RESUME_MODAL_OPEN_TIMEOUT|Resume context probe timeout: reason=NO_RESUME_IFRAME|RESUME_RATE_LIMIT_WARNING|RESUME_CAPTURE_LIKELY_BLANK|DOM_RESUME_FALLBACK_FAILED|RESUME_MODAL_NOT_DETECTED/i.test(
          message,
        )
      ) {
        baseResult.decision = 'skipped';
        baseResult.reason = `在线简历不可用或未加载，已跳过该候选人（${message}）`;
        baseResult.artifacts.resumeUnavailable = true;
        this.logger.log(
          `候选人跳过：name=${customer.name || '未知'} | key=${customer.customerKey} | reason=${baseResult.reason}`,
        );
      } else {
        baseResult.error = message;
        baseResult.decision = 'error';
        this.logger.log(
          `候选人处理异常：name=${customer.name || '未知'} | key=${customer.customerKey} | error=${baseResult.error}`,
        );
      }
      await this.stateStore.record(baseResult.customerKey, baseResult, baseAliases);
      return baseResult;
    }
  }
}
