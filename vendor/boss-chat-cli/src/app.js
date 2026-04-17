import { mkdir } from 'node:fs/promises';
import path from 'node:path';

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

function sanitizeReasonWithResumeProfile(reason, resumeProfile) {
  const rawReason = normalizeText(reason);
  if (!rawReason) return rawReason;
  const schools = Array.isArray(resumeProfile?.schools)
    ? resumeProfile.schools.map((item) => normalizeText(item)).filter(Boolean)
    : [];
  const primarySchool = normalizeText(resumeProfile?.primarySchool || schools[0] || '');
  const schoolPool = primarySchool ? [primarySchool, ...schools] : schools;
  if (schoolPool.length <= 0) return rawReason;

  if (schoolPool.some((school) => rawReason.includes(school))) {
    return rawReason;
  }
  if (!/(大学|学院|院校|中科院|学校)/.test(rawReason)) {
    return rawReason;
  }

  const sentences = rawReason
    .split(/[。；;]+/)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  const filtered = sentences.filter((sentence) => {
    if (!/(大学|学院|院校|中科院|学校)/.test(sentence)) return true;
    return schoolPool.some((school) => sentence.includes(school));
  });

  const prefix = `教育经历学校以简历主内容为准：${schoolPool[0]}`;
  if (filtered.length <= 0) {
    return `${prefix}。`;
  }
  return `${prefix}。${filtered.join('；')}。`;
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
      const finalClose =
        typeof this.page.closeResumeModalDomOnce === 'function'
          ? await this.page.closeResumeModalDomOnce()
          : await this.page.closeResumeModal({ maxAttempts: 6, ensureDismiss: true });
      this.logger.log(
        `运行收尾关闭简历弹层：closed=${finalClose.closed} | method=${finalClose.method}`,
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
      const preClose =
        typeof this.page.closeResumeModalDomOnce === 'function'
          ? await this.page.closeResumeModalDomOnce()
          : await this.page.closeResumeModal({ maxAttempts: 4, ensureDismiss: true });
      if (preClose.method !== 'already-closed') {
        this.logger.log(
          `候选人开始前清理残留弹层：closed=${preClose.closed} | method=${preClose.method}`,
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

      let capture = null;
      let lastResumeError = null;
      let resumeProfile = null;
      await this.waitResumeOpenCooldown(this.resumeOpenCooldownMs + Math.floor(Math.random() * 200));
      await this.checkpoint();
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
        this.logger.log(
          `检测到简历查看频控提示：${rateLimit.text}，进入冷却 ${Math.round(backoffMs / 1000)}s，当前候选跳过。`,
        );
        lastResumeError = new Error(`RESUME_RATE_LIMIT_WARNING:${rateLimit.text}`);
      } else if (openResult && !openDetected) {
        let delayedDetected = false;
        if (typeof this.page.getResumeModalState === 'function') {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const delayedState = await this.page.getResumeModalState();
          delayedDetected =
            Boolean(delayedState?.open) ||
            Number(delayedState?.iframeCount || 0) > 0 ||
            (Number(delayedState?.scopeCount || 0) > 0 &&
              Number(delayedState?.closeCount || 0) > 0);
        }
        if (delayedDetected) {
          openDetected = true;
          modalOpened = true;
          this.logger.log('在线简历首次检测未命中，1秒后复检已打开，继续处理。');
        } else {
          lastResumeError = new Error('RESUME_MODAL_NOT_DETECTED_AFTER_SINGLE_DOM_CLICK');
        }
      }

      if (!lastResumeError && openDetected) {
        if (typeof this.page.getResumeProfileFromDom === 'function') {
          resumeProfile = await this.page.getResumeProfileFromDom();
          if (resumeProfile?.ok) {
            this.logger.log(
              `简历结构化信息：school=${resumeProfile.primarySchool || 'n/a'} | major=${resumeProfile.major || 'n/a'} | company=${resumeProfile.company || 'n/a'} | position=${resumeProfile.position || 'n/a'}`,
            );
            baseResult.artifacts.resumeProfile = {
              primarySchool: resumeProfile.primarySchool || '',
              schools: Array.isArray(resumeProfile.schools) ? resumeProfile.schools : [],
              major: resumeProfile.major || '',
              majors: Array.isArray(resumeProfile.majors) ? resumeProfile.majors : [],
              company: resumeProfile.company || '',
              position: resumeProfile.position || '',
              resumeTextLength: String(resumeProfile.resumeText || '').length,
              evidenceCorpusLength: String(resumeProfile.evidenceCorpus || '').length,
            };
          } else {
            this.logger.log(`简历结构化提取未命中：${resumeProfile?.error || 'unknown'}`);
          }
        }
        this.logger.log(
          `在线简历点击完成：clicked=${Boolean(openResult?.clicked)} | detectedOpen=${openDetected} | by=${openResult?.by || 'unknown'}，开始截图探测与拼接。`,
        );
        this.logger.log(
          `在线简历截图前状态：modalOpened=${modalOpened} | openDetected=${openDetected}`,
        );
        try {
          await this.checkpoint();
          capture = await this.resumeCaptureService.captureResume({
            artifactDir,
            waitResumeMs: 30000,
            scrollSettleMs: 500,
          });
          if (capture?.quality?.likelyBlank) {
            const blankBackoffMs = 45000 + Math.floor(Math.random() * 20000);
            this.setResumeOpenBlocked(blankBackoffMs);
            this.logger.log(
              `检测到疑似空白简历截图（luma=${capture?.quality?.luma},std=${capture?.quality?.avgStd}），冷却 ${Math.round(blankBackoffMs / 1000)}s，当前候选跳过。`,
            );
            lastResumeError = new Error('RESUME_CAPTURE_LIKELY_BLANK');
            capture = null;
          }
        } catch (error) {
          lastResumeError = error;
        }
      } else if (!lastResumeError && !openDetected) {
        lastResumeError = new Error('RESUME_MODAL_NOT_DETECTED');
      }
      if (!capture) {
        throw lastResumeError || new Error('RESUME_CAPTURE_FAILED');
      }
      this.logger.log(
        `截图完成：chunks=${capture.chunkCount} | image=${capture.stitchedImage}`,
      );
      baseResult.artifacts = {
        chunkDir: capture.chunkDir,
        metadataFile: capture.metadataFile,
        stitchedImage: capture.stitchedImage,
        chunkCount: capture.chunkCount,
      };

      await this.checkpoint();
      const evaluation = await this.llmClient.evaluateResume({
        screeningCriteria: profile.screeningCriteria,
        candidate: {
          name: customer.name || '',
          sourceJob: customer.sourceJob || '',
          resumeProfile: resumeProfile?.ok ? {
            primarySchool: resumeProfile.primarySchool || '',
            schools: Array.isArray(resumeProfile.schools) ? resumeProfile.schools : [],
            major: resumeProfile.major || '',
            majors: Array.isArray(resumeProfile.majors) ? resumeProfile.majors : [],
            company: resumeProfile.company || '',
            position: resumeProfile.position || '',
          } : null,
          resumeText: resumeProfile?.ok ? String(resumeProfile.resumeText || '') : '',
          evidenceCorpus: resumeProfile?.ok ? String(resumeProfile.evidenceCorpus || '') : '',
        },
        imagePath: capture.stitchedImage,
      });
      const finalReason = sanitizeReasonWithResumeProfile(evaluation.reason, resumeProfile);
      if (finalReason !== evaluation.reason) {
        this.logger.log(
          `评估理由学校字段已按主简历纠偏：rawReason=${evaluation.reason} | finalReason=${finalReason}`,
        );
      }
      if (evaluation.evidenceGateDemoted === true) {
        this.logger.log(
          `证据闸门降级：rawPassed=${Boolean(evaluation.rawPassed)} | evidenceRawCount=${Number(evaluation.evidenceRawCount || 0)} | evidenceMatchedCount=${Number(evaluation.evidenceMatchedCount || 0)} | mode=${evaluation.evaluationMode || 'unknown'}`,
        );
      }
      this.logger.log(
        `LLM评估完成：passed=${evaluation.passed} | rawPassed=${Boolean(evaluation.rawPassed)} | mode=${evaluation.evaluationMode || 'unknown'} | reason=${finalReason}`,
      );

      baseResult.reason = finalReason;
      baseResult.passed = evaluation.passed;
      baseResult.decision = evaluation.passed ? 'passed' : 'skipped';
      baseResult.artifacts.rawPassed = Boolean(evaluation.rawPassed);
      baseResult.artifacts.finalPassed = Boolean(evaluation.passed);
      baseResult.artifacts.evidenceRawCount = Number.isFinite(Number(evaluation.evidenceRawCount))
        ? Number(evaluation.evidenceRawCount)
        : 0;
      baseResult.artifacts.evidenceMatchedCount = Number.isFinite(Number(evaluation.evidenceMatchedCount))
        ? Number(evaluation.evidenceMatchedCount)
        : 0;
      baseResult.artifacts.evidenceGateDemoted = evaluation.evidenceGateDemoted === true;
      baseResult.artifacts.evaluationMode = String(evaluation.evaluationMode || '');
      baseResult.artifacts.evaluationChunkIndex = Number.isFinite(Number(evaluation.chunkIndex))
        ? Number(evaluation.chunkIndex)
        : null;
      baseResult.artifacts.evaluationChunkTotal = Number.isFinite(Number(evaluation.chunkTotal))
        ? Number(evaluation.chunkTotal)
        : null;
      baseResult.artifacts.evaluationEvidence = Array.isArray(evaluation.evidence)
        ? evaluation.evidence.slice(0, 5).map((item) => String(item || '').trim()).filter(Boolean)
        : [];

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
        const greetingText = 'Hi同学，能麻烦发下简历吗？';
        this.logger.log(`候选人通过，先发送消息：${greetingText}`);
        await this.checkpoint();
        const editorState = await this.page.setEditorMessage(greetingText);
        if (!String(editorState?.value || '').includes('Hi同学')) {
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

      await this.stateStore.record(baseResult.customerKey, baseResult, baseAliases);
      return baseResult;
    } catch (error) {
      if (error?.name === 'StopRequestedError') {
        throw error;
      }

      if (modalOpened) {
        try {
          const closeResult =
            typeof this.page.closeResumeModalDomOnce === 'function'
              ? await this.page.closeResumeModalDomOnce()
              : await this.page.closeResumeModal({ maxAttempts: 6, ensureDismiss: true });
          baseResult.artifacts.resumeCloseMethod = closeResult.method;
          baseResult.artifacts.resumeClosed = closeResult.closed;
          this.logger.log(
            `异常后关闭简历结果：closed=${closeResult.closed} | method=${closeResult.method} | scope=${closeResult?.finalState?.scopeCount ?? 'n/a'} | iframe=${closeResult?.finalState?.iframeCount ?? 'n/a'} | close=${closeResult?.finalState?.closeCount ?? 'n/a'} | class=${closeResult?.finalState?.topScopeClass || 'n/a'}`,
          );
        } catch {}
      }

      const message = error.message || String(error);
      if (
        /ONLINE_RESUME_UNAVAILABLE|ONLINE_RESUME_BUTTON_NOT_FOUND|OPEN_ONLINE_RESUME_FAILED|NO_RESUME_IFRAME|NO_SCROLL_CONTAINER|RESUME_MODAL_OPEN_TIMEOUT|Resume context probe timeout: reason=NO_RESUME_IFRAME|RESUME_RATE_LIMIT_WARNING|RESUME_CAPTURE_LIKELY_BLANK/i.test(
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
