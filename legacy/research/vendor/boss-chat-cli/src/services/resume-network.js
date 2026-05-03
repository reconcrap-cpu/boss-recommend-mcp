const RESUME_INFO_URL_PATTERNS = [
  /\/wapi\/zpjob\/view\/geek\/info\b/i,
  /\/wapi\/zpitem\/web\/boss\/[^?#]*\/geek\/info\b/i,
  /\/boss\/[^?#]*\/geek\/info\b/i,
  /\/geek\/info\b/i,
  /[?&](?:geekid|geek_id|encryptgeekid|encryptjid|jid|securityid)=/i,
];
const RESUME_RELATED_KEYWORDS = ['geek', 'resume', 'candidate', 'friend'];
const NETWORK_POLL_MS = 120;

export const NETWORK_RESUME_WAIT_MS = 4200;
export const NETWORK_RESUME_RETRY_WAIT_MS = 2000;
export const NETWORK_RESUME_IMAGE_MODE_GRACE_MS = 1000;
export const NETWORK_RESUME_LATE_RETRY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toLowerSafe(value) {
  return String(value || '').toLowerCase();
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseGeekIdFromUrl(url) {
  const raw = normalizeText(url);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const keys = ['geekId', 'geek_id', 'gid', 'encryptGeekId', 'encryptJid', 'jid', 'securityId'];
    for (const key of keys) {
      const value = normalizeText(parsed.searchParams.get(key) || '');
      if (value) return value;
    }
  } catch {}
  const matched = raw.match(/[?&](?:geekId|geek_id|gid|encryptGeekId|encryptJid|jid|securityId)=([^&]+)/i);
  if (matched?.[1]) return decodeURIComponent(matched[1]);
  return null;
}

function parseGeekIdFromPostData(postData) {
  const raw = normalizeText(postData);
  if (!raw) return null;
  const keys = ['geekId', 'geek_id', 'gid', 'encryptGeekId', 'encryptJid', 'jid', 'securityId'];
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const queue = [parsed];
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || typeof current !== 'object') continue;
        for (const key of keys) {
          const value = normalizeText(current[key] || '');
          if (value) return value;
        }
        for (const value of Object.values(current)) {
          if (value && typeof value === 'object') {
            queue.push(value);
          }
        }
      }
    }
  } catch {}
  const matched = raw.match(
    /(?:^|[?&,\s"'])?(?:geekId|geek_id|gid|encryptGeekId|encryptJid|jid|securityId)(?:["']?\s*[:=]\s*["']?)([^&,"'\s}]+)/i,
  );
  if (matched?.[1]) return decodeURIComponent(matched[1]);
  return null;
}

function collectGeekIdsFromPayload(payload, fallbackGeekId = null) {
  if (!payload || typeof payload !== 'object') return [];
  const geekDetail = payload?.geekDetail || payload;
  const baseInfo = geekDetail?.geekBaseInfo || {};
  const ids = [
    fallbackGeekId,
    baseInfo.geekId,
    baseInfo.encryptGeekId,
    baseInfo.securityId,
    geekDetail?.geekId,
    geekDetail?.encryptGeekId,
    geekDetail?.securityId,
    payload?.geekId,
    payload?.encryptGeekId,
    payload?.securityId,
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);
  return Array.from(new Set(ids));
}

function hasResumePayloadShape(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const geekDetail =
    payload?.geekDetail && typeof payload.geekDetail === 'object' ? payload.geekDetail : payload;
  const baseInfo = geekDetail?.geekBaseInfo || {};
  const hasIdentity = Boolean(
    normalizeText(
      baseInfo?.name ||
        geekDetail?.geekName ||
        payload?.geekName ||
        baseInfo?.geekId ||
        baseInfo?.encryptGeekId ||
        baseInfo?.securityId ||
        geekDetail?.geekId ||
        geekDetail?.encryptGeekId ||
        geekDetail?.securityId ||
        payload?.geekId ||
        payload?.encryptGeekId ||
        payload?.securityId ||
        '',
    ),
  );
  const hasResumeSections = [
    geekDetail?.geekExpectList,
    geekDetail?.geekWorkExpList,
    geekDetail?.geekProjExpList,
    geekDetail?.geekEduExpList,
    geekDetail?.geekEducationList,
    geekDetail?.geekSkillList,
  ].some((section) => Array.isArray(section) && section.length > 0);
  const hasResumeTextFields = Boolean(
    normalizeText(geekDetail?.geekAdvantage || baseInfo?.userDesc || baseInfo?.userDescription || ''),
  );
  return hasIdentity && (hasResumeSections || hasResumeTextFields);
}

function findResumePayloadInObject(root, maxDepth = 4, visited = new Set()) {
  if (root === null || root === undefined || maxDepth < 0) return null;
  if (typeof root !== 'object') return null;
  if (visited.has(root)) return null;
  visited.add(root);

  if (hasResumePayloadShape(root)) {
    return root;
  }
  if (maxDepth === 0) return null;

  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findResumePayloadInObject(item, maxDepth - 1, visited);
      if (found) return found;
    }
    return null;
  }

  for (const key of ['zpData', 'data', 'result', 'geekDetail', 'detail', 'info']) {
    if (!(key in root)) continue;
    const found = findResumePayloadInObject(root[key], maxDepth - 1, visited);
    if (found) return found;
  }
  for (const value of Object.values(root)) {
    const found = findResumePayloadInObject(value, maxDepth - 1, visited);
    if (found) return found;
  }
  return null;
}

function extractResumePayloadFromResponseBody(parsedBody) {
  return findResumePayloadInObject(parsedBody, 4) || null;
}

function isResumeInfoRequestUrl(url) {
  const normalizedUrl = normalizeText(url).toLowerCase();
  if (!normalizedUrl || !normalizedUrl.includes('/wapi/')) return false;
  return RESUME_INFO_URL_PATTERNS.some((pattern) => pattern.test(normalizedUrl));
}

function isResumeRelatedWapiUrl(url) {
  const normalizedUrl = normalizeText(url).toLowerCase();
  if (!normalizedUrl || !normalizedUrl.includes('/wapi/')) return false;
  return RESUME_RELATED_KEYWORDS.some((keyword) => normalizedUrl.includes(String(keyword).toLowerCase()));
}

function formatResumeTimeRange(exp = {}) {
  const start =
    normalizeText(exp.startYearMonStr || exp.startYearStr || exp.startDateDesc || exp.startDate || '') || '';
  const end =
    normalizeText(exp.endYearMonStr || exp.endYearStr || exp.endDateDesc || exp.endDate || '') || '';
  if (start && end) return `${start} - ${end}`;
  if (start) return `${start} - 至今`;
  if (end) return `至 ${end}`;
  return '';
}

function preferReadableName(...values) {
  const normalized = values.map((item) => normalizeText(item)).filter(Boolean);
  if (normalized.length <= 0) return '';
  const nonMasked = normalized.find((item) => !/[*＊]/.test(item));
  return nonMasked || normalized[0];
}

function formatResumeApiData(data) {
  const parts = [];
  const geekDetail = data?.geekDetail || data?.geekDetailInfo || data || {};
  const baseInfo = geekDetail.geekBaseInfo || {};
  const expectList = Array.isArray(geekDetail.geekExpectList)
    ? geekDetail.geekExpectList
    : Array.isArray(geekDetail.geekExpPosList)
    ? geekDetail.geekExpPosList
    : [];
  const workExpList = Array.isArray(geekDetail.geekWorkExpList) ? geekDetail.geekWorkExpList : [];
  const projExpList = Array.isArray(geekDetail.geekProjExpList) ? geekDetail.geekProjExpList : [];
  const eduExpList = Array.isArray(geekDetail.geekEduExpList)
    ? geekDetail.geekEduExpList
    : Array.isArray(geekDetail.geekEducationList)
    ? geekDetail.geekEducationList
    : [];
  const skillList = Array.isArray(geekDetail.geekSkillList)
    ? geekDetail.geekSkillList
    : Array.isArray(geekDetail.skillList)
    ? geekDetail.skillList
    : [];
  const certificationList = Array.isArray(geekDetail.geekCertificationList)
    ? geekDetail.geekCertificationList
    : [];

  parts.push('=== 基本信息 ===');
  if (baseInfo.name) parts.push(`姓名: ${baseInfo.name}`);
  if (baseInfo.ageDesc) parts.push(`年龄: ${baseInfo.ageDesc}`);
  if (baseInfo.degreeCategory) parts.push(`学历: ${baseInfo.degreeCategory}`);
  if (baseInfo.workYearDesc) parts.push(`工作经验: ${baseInfo.workYearDesc}`);
  if (baseInfo.activeTimeDesc) parts.push(`活跃状态: ${baseInfo.activeTimeDesc}`);
  if (baseInfo.applyStatusContent) parts.push(`求职状态: ${baseInfo.applyStatusContent}`);

  if (expectList.length > 0) {
    parts.push('\n=== 期望工作 ===');
    expectList.forEach((expect, index) => {
      const line = [
        `${index + 1}.`,
        normalizeText(expect.locationName || ''),
        normalizeText(expect.positionName || ''),
        normalizeText(expect.salaryDesc || ''),
        normalizeText(expect.industryDesc || ''),
      ]
        .filter(Boolean)
        .join(' | ');
      if (line) parts.push(line);
    });
  }

  const advantage = stripHtml(geekDetail.geekAdvantage || baseInfo.userDesc || baseInfo.userDescription || '');
  if (advantage) {
    parts.push('\n=== 个人优势 ===');
    parts.push(advantage);
  }

  if (workExpList.length > 0) {
    parts.push('\n=== 工作经历 ===');
    workExpList.forEach((exp, index) => {
      const company = normalizeText(exp.company || '');
      const position = stripHtml(exp.positionName || exp.position || '');
      const range = formatResumeTimeRange(exp);
      const responsibility = stripHtml(exp.responsibility || exp.workContent || '');
      const performance = stripHtml(exp.workPerformance || exp.performance || '');
      parts.push(`${index + 1}. ${[company, position].filter(Boolean).join(' - ')}`.trim());
      if (range) parts.push(`   时间: ${range}`);
      if (responsibility) parts.push(`   职责: ${responsibility}`);
      if (performance) parts.push(`   成果: ${performance}`);
    });
  }

  if (projExpList.length > 0) {
    parts.push('\n=== 项目经历 ===');
    projExpList.forEach((exp, index) => {
      const projectName = normalizeText(exp.name || exp.projectName || '');
      const role = stripHtml(exp.roleName || exp.role || '');
      const range = formatResumeTimeRange(exp);
      const desc = stripHtml(exp.projectDescription || exp.description || '');
      parts.push(`${index + 1}. ${[projectName, role].filter(Boolean).join(' - ')}`.trim());
      if (range) parts.push(`   时间: ${range}`);
      if (desc) parts.push(`   描述: ${desc}`);
    });
  }

  if (eduExpList.length > 0) {
    parts.push('\n=== 教育经历 ===');
    eduExpList.forEach((exp, index) => {
      const school = normalizeText(exp.schoolName || exp.school || '');
      const major = normalizeText(exp.majorName || exp.major || '');
      const degree = normalizeText(exp.degreeName || exp.degree || exp.education || '');
      const range = formatResumeTimeRange(exp);
      parts.push(`${index + 1}. ${[school, major, degree].filter(Boolean).join(' - ')}`.trim());
      if (range) parts.push(`   时间: ${range}`);
    });
  }

  if (skillList.length > 0) {
    parts.push('\n=== 技能 ===');
    parts.push(
      skillList
        .map((item) => normalizeText(item.skillName || item.name || item))
        .filter(Boolean)
        .join('、'),
    );
  }

  if (certificationList.length > 0) {
    parts.push('\n=== 证书 ===');
    parts.push(
      certificationList
        .map((item) => normalizeText(item.certificationName || item.name || item))
        .filter(Boolean)
        .join('、'),
    );
  }

  const firstEducation = eduExpList[0] || {};
  const firstWork = workExpList[0] || {};
  return {
    name: preferReadableName(baseInfo.name || '', geekDetail.geekName || ''),
    school: normalizeText(firstEducation.schoolName || firstEducation.school || ''),
    major: normalizeText(firstEducation.majorName || firstEducation.major || ''),
    company: normalizeText(firstWork.company || ''),
    position: normalizeText(firstWork.positionName || firstWork.position || ''),
    resumeText: parts.join('\n').trim(),
  };
}

function normalizeNameForCompare(value) {
  return normalizeText(value).replace(/[*＊]/g, '');
}

function isLikelyNameMatch(expected, actual) {
  const left = normalizeNameForCompare(expected);
  const right = normalizeNameForCompare(actual);
  if (!left || !right) return true;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  return left[0] === right[0];
}

function isLikelyTextMatch(expected, actual) {
  const left = toLowerSafe(normalizeText(expected));
  const right = toLowerSafe(normalizeText(actual));
  if (!left || !right) return true;
  return left === right || left.includes(right) || right.includes(left);
}

export function isDomProfileConsistentWithCard(cardProfile, domProfile) {
  if (!cardProfile || !domProfile) return true;
  let compared = 0;
  let mismatched = 0;
  const compareField = (field, matcher) => {
    const expected = normalizeText(cardProfile?.[field] || '');
    const actual = normalizeText(domProfile?.[field] || '');
    if (!expected || !actual) return;
    compared += 1;
    if (!matcher(expected, actual)) {
      mismatched += 1;
    }
  };
  compareField('name', isLikelyNameMatch);
  compareField('school', isLikelyTextMatch);
  compareField('major', isLikelyTextMatch);
  if (compared <= 0) return true;
  return mismatched <= 1;
}

function buildCandidateInfoFromPayload(payload, fallbackGeekId = '') {
  const formatted = formatResumeApiData(payload);
  return {
    geekId: normalizeText(fallbackGeekId || ''),
    name: formatted.name,
    school: formatted.school,
    major: formatted.major,
    company: formatted.company,
    position: formatted.position,
    resumeText: normalizeText(formatted.resumeText),
    evidenceCorpus: normalizeText(formatted.resumeText),
    alreadyInterested: false,
  };
}

export class ResumeNetworkTracker {
  constructor({ chromeClient, logger = console } = {}) {
    this.chromeClient = chromeClient;
    this.logger = logger;
    this.Network = chromeClient?.Network || null;
    this.resumeNetworkRequests = new Map();
    this.resumeNetworkRelatedRequests = new Map();
    this.resumeNetworkByGeekId = new Map();
    this.latestResumeNetworkPayload = null;
    this.resumeNetworkDiagnostics = [];
    this.resumeAcquisitionMode = 'unknown';
    this.resumeAcquisitionModeReason = '';
    this.bound = false;
    this.attach();
  }

  attach() {
    if (this.bound || !this.Network) return;
    if (typeof this.Network.requestWillBeSent === 'function') {
      this.Network.requestWillBeSent((params) => {
        try {
          this.handleNetworkRequestWillBeSent(params);
        } catch {}
      });
    }
    if (typeof this.Network.loadingFinished === 'function') {
      this.Network.loadingFinished((params) => {
        this.handleNetworkLoadingFinished(params).catch(() => {});
      });
    }
    this.bound = true;
  }

  recordDiagnostic(entry = {}) {
    const normalized = {
      ts: Number.isFinite(Number(entry.ts)) ? Number(entry.ts) : Date.now(),
      kind: normalizeText(entry.kind || 'unknown') || 'unknown',
      request_id: normalizeText(entry.request_id || '') || null,
      url: normalizeText(entry.url || '') || null,
      geek_id: normalizeText(entry.geek_id || '') || null,
      reason: normalizeText(entry.reason || '') || null,
      source: normalizeText(entry.source || '') || null,
      error: normalizeText(entry.error || '') || null,
      waited_ms: Number.isFinite(Number(entry.waited_ms)) ? Number(entry.waited_ms) : null,
    };
    this.resumeNetworkDiagnostics.push(normalized);
    if (this.resumeNetworkDiagnostics.length > 240) {
      this.resumeNetworkDiagnostics.splice(0, this.resumeNetworkDiagnostics.length - 200);
    }
  }

  setResumeAcquisitionMode(mode, reason = '') {
    if (!['unknown', 'network', 'image'].includes(mode)) return;
    this.resumeAcquisitionMode = mode;
    this.resumeAcquisitionModeReason = normalizeText(reason || '');
  }

  getResumeAcquisitionState() {
    return {
      mode: this.resumeAcquisitionMode,
      reason: this.resumeAcquisitionModeReason,
    };
  }

  cacheResumeNetworkPayload(payload, fallbackGeekId = '') {
    const geekIds = collectGeekIdsFromPayload(payload, fallbackGeekId);
    const candidateInfo = buildCandidateInfoFromPayload(payload, fallbackGeekId);
    const wrapped = {
      ts: Date.now(),
      geekIds,
      data: payload,
      candidateInfo,
    };
    this.latestResumeNetworkPayload = wrapped;
    for (const id of geekIds) {
      const normalizedId = normalizeText(id);
      if (!normalizedId) continue;
      this.resumeNetworkByGeekId.set(normalizedId, wrapped);
    }
  }

  getCandidateKeys(candidate = {}) {
    return Array.from(
      new Set(
        [
          candidate?.key,
          candidate?.geek_id,
          candidate?.customerId,
          candidate?.customerKey,
        ]
          .map((value) => normalizeText(value))
          .filter(Boolean),
      ),
    );
  }

  tryExtractNetworkResumeForCandidate(candidate, options = {}) {
    const candidateKeys = this.getCandidateKeys(candidate);
    const minTs = Number.isFinite(Number(options?.minTs)) ? Number(options.minTs) : 0;
    for (const candidateKey of candidateKeys) {
      if (!this.resumeNetworkByGeekId.has(candidateKey)) continue;
      const wrapped = this.resumeNetworkByGeekId.get(candidateKey);
      const payloadTs = Number(wrapped?.ts || 0);
      if (payloadTs >= minTs) {
        return {
          candidateInfo: wrapped?.candidateInfo || null,
          source: 'geek_id_map',
          ts: payloadTs,
        };
      }
    }
    if (this.latestResumeNetworkPayload) {
      const wrapped = this.latestResumeNetworkPayload;
      const payloadTs = Number(wrapped?.ts || 0);
      const ageMs = Date.now() - payloadTs;
      const latestGeekIds = Array.isArray(wrapped?.geekIds)
        ? wrapped.geekIds.map((id) => normalizeText(id)).filter(Boolean)
        : [];
      const withinAge = ageMs <= 12000;
      const withinTs = payloadTs >= minTs;
      if (candidateKeys.length <= 0 && withinAge && withinTs) {
        return {
          candidateInfo: wrapped?.candidateInfo || null,
          source: 'latest_payload',
          ts: payloadTs,
        };
      }
      if (candidateKeys.some((candidateKey) => withinAge && withinTs && latestGeekIds.includes(candidateKey))) {
        return {
          candidateInfo: wrapped?.candidateInfo || null,
          source: 'latest_payload_key_match',
          ts: payloadTs,
        };
      }
    }
    return null;
  }

  async waitForNetworkResumeCandidateInfo(candidate, timeoutMs = 2200, options = {}) {
    const waitStartedAt = Date.now();
    const minTs = Number.isFinite(Number(options?.minTs)) ? Number(options.minTs) : 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = this.tryExtractNetworkResumeForCandidate(candidate, { minTs });
      const info = match?.candidateInfo || null;
      if (info && normalizeText(info.resumeText)) {
        this.recordDiagnostic({
          kind: 'wait_hit',
          geek_id: this.getCandidateKeys(candidate)[0] || '',
          source: match?.source || 'unknown',
          waited_ms: Date.now() - waitStartedAt,
        });
        return {
          candidateInfo: info,
          source: match?.source || 'unknown',
          waitedMs: Date.now() - waitStartedAt,
        };
      }
      await sleep(NETWORK_POLL_MS);
    }
    this.recordDiagnostic({
      kind: 'wait_timeout',
      geek_id: this.getCandidateKeys(candidate)[0] || '',
      waited_ms: Date.now() - waitStartedAt,
      reason: 'resume_text_not_ready',
    });
    return null;
  }

  async waitForResumeNetworkByMode(candidate, options = {}) {
    const minTs = Number.isFinite(Number(options?.minTs)) ? Number(options.minTs) : 0;
    const mode = this.resumeAcquisitionMode || 'unknown';
    const firstWaitMs = mode === 'image' ? NETWORK_RESUME_IMAGE_MODE_GRACE_MS : NETWORK_RESUME_WAIT_MS;
    const firstStageStartedAt = Date.now();
    let networkResult = await this.waitForNetworkResumeCandidateInfo(candidate, firstWaitMs, { minTs });
    const firstStageElapsedMs = Date.now() - firstStageStartedAt;
    if (networkResult?.candidateInfo?.resumeText) {
      const reason = mode === 'image' ? 'image_mode_grace_hit' : 'initial_network_hit';
      this.setResumeAcquisitionMode('network', reason);
      return {
        ...networkResult,
        acquisitionReason: reason,
        initialWaitMs: firstStageElapsedMs,
        retryWaitMs: 0,
      };
    }
    if (mode === 'image') {
      return {
        candidateInfo: null,
        source: null,
        waitedMs: firstStageElapsedMs,
        acquisitionReason: '',
        initialWaitMs: firstStageElapsedMs,
        retryWaitMs: 0,
      };
    }
    const retryStageStartedAt = Date.now();
    await sleep(NETWORK_RESUME_RETRY_WAIT_MS);
    networkResult = await this.waitForNetworkResumeCandidateInfo(candidate, NETWORK_RESUME_RETRY_WAIT_MS, {
      minTs,
    });
    const retryStageElapsedMs = Date.now() - retryStageStartedAt;
    if (networkResult?.candidateInfo?.resumeText) {
      const reason = 'network_retry_hit';
      this.setResumeAcquisitionMode('network', reason);
      return {
        ...networkResult,
        acquisitionReason: reason,
        initialWaitMs: firstStageElapsedMs,
        retryWaitMs: retryStageElapsedMs,
      };
    }
    return {
      candidateInfo: null,
      source: null,
      waitedMs: firstStageElapsedMs + retryStageElapsedMs,
      acquisitionReason: '',
      initialWaitMs: firstStageElapsedMs,
      retryWaitMs: retryStageElapsedMs,
    };
  }

  async waitForLateNetworkResumeCandidateInfo(candidate, options = {}) {
    const minTs = Number.isFinite(Number(options?.minTs)) ? Number(options.minTs) : 0;
    const networkResult = await this.waitForNetworkResumeCandidateInfo(candidate, NETWORK_RESUME_LATE_RETRY_MS, {
      minTs,
    });
    if (networkResult?.candidateInfo?.resumeText) {
      const reason = 'late_network_hit';
      this.setResumeAcquisitionMode('network', reason);
      return {
        ...networkResult,
        acquisitionReason: reason,
        lateRetryMs: Number(networkResult?.waitedMs || 0),
      };
    }
    return {
      candidateInfo: null,
      source: null,
      waitedMs: 0,
      acquisitionReason: '',
      lateRetryMs: 0,
    };
  }

  handleNetworkRequestWillBeSent(params = {}) {
    const url = normalizeText(params?.request?.url || '');
    const postData = params?.request?.postData || '';
    if (!url) return;
    const requestTs = Date.now();
    const method = normalizeText(params?.request?.method || '').toUpperCase() || 'GET';
    const isResumeInfo = isResumeInfoRequestUrl(url);
    const isResumeRelated = isResumeInfo || isResumeRelatedWapiUrl(url);
    if (!isResumeRelated) return;
    const geekId = parseGeekIdFromUrl(url) || parseGeekIdFromPostData(postData);
    const meta = {
      ts: requestTs,
      url,
      geekId,
      method,
      isResumeInfo,
    };
    this.resumeNetworkRelatedRequests.set(params.requestId, meta);
    this.recordDiagnostic({
      kind: 'request',
      request_id: params.requestId,
      url: url.slice(0, 280),
      geek_id: geekId,
      source: isResumeInfo ? 'resume_info_url' : 'wapi_related_non_resume_info',
    });
    if (isResumeInfo) {
      this.resumeNetworkRequests.set(params.requestId, meta);
    }
  }

  async handleNetworkLoadingFinished(params = {}) {
    const requestId = params?.requestId;
    const requestMeta = this.resumeNetworkRequests.get(requestId);
    const relatedMeta = this.resumeNetworkRelatedRequests.get(requestId);
    if (!requestMeta && !relatedMeta) return;
    this.resumeNetworkRequests.delete(requestId);
    this.resumeNetworkRelatedRequests.delete(requestId);
    const effectiveMeta = requestMeta || relatedMeta || {};
    const effectiveUrl = normalizeText(effectiveMeta.url || '');
    const effectiveGeekId = normalizeText(effectiveMeta.geekId || '');
    try {
      const responseBody = await this.Network.getResponseBody({ requestId });
      if (!responseBody?.body) {
        this.recordDiagnostic({
          kind: 'response_miss',
          request_id: requestId,
          url: effectiveUrl.slice(0, 280),
          geek_id: effectiveGeekId,
          reason: 'empty_body',
        });
        return;
      }
      const rawBody = responseBody.base64Encoded
        ? Buffer.from(responseBody.body, 'base64').toString('utf8')
        : responseBody.body;
      const parsed = JSON.parse(rawBody);
      const resumePayload = extractResumePayloadFromResponseBody(parsed);
      if (!resumePayload) {
        this.recordDiagnostic({
          kind: 'response_miss',
          request_id: requestId,
          url: effectiveUrl.slice(0, 280),
          geek_id: effectiveGeekId,
          reason: 'payload_not_found',
        });
        return;
      }
      this.cacheResumeNetworkPayload(resumePayload, effectiveGeekId);
      this.recordDiagnostic({
        kind: 'response_hit',
        request_id: requestId,
        url: effectiveUrl.slice(0, 280),
        geek_id: effectiveGeekId,
      });
    } catch (error) {
      this.recordDiagnostic({
        kind: 'response_error',
        request_id: requestId,
        url: effectiveUrl.slice(0, 280),
        geek_id: effectiveGeekId,
        error: normalizeText(error?.message || String(error)).slice(0, 240),
      });
    }
  }
}

export const __testables = {
  buildCandidateInfoFromPayload,
  collectGeekIdsFromPayload,
  extractResumePayloadFromResponseBody,
  formatResumeApiData,
  isDomProfileConsistentWithCard,
  isResumeInfoRequestUrl,
  isResumeRelatedWapiUrl,
  parseGeekIdFromPostData,
  parseGeekIdFromUrl,
  preferReadableName,
};
