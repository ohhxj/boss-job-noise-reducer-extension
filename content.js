(() => {
  "use strict";

  const HOST_RE = /(^|\.)((zhipin|bosszhipin|kanzhun)\.com)$/i;
  const STORAGE_KEY = "boss_job_noise_reducer_v0";
  const ROOT_ID = "boss-job-noise-reducer-root";
  const PAGE_STYLE_ID = "boss-job-noise-reducer-style";
  const JOB_SELECTOR = "li.job-card-box";
  const WRAP_SELECTOR = ".job-card-wrap, .job-card-box";
  const EXTENSION_VERSION = "0.5.15";
  const EXCLUDED_JOB_STATUSES = new Set(["rejected", "unsuitable", "zombie"]);
  const KEEP_JOB_STATUSES = new Set(["later", "interview", "resume_sent"]);
  const ACTIVE_JOB_STATUSES = new Set(["communicated", "waiting", "read_no_reply", "resume_sent", "interview"]);
  const STATUS = {
    unmarked: { label: "未标记", tone: "neutral" },
    waiting: { label: "未读未回", tone: "warm" },
    read_no_reply: { label: "已读未回", tone: "warm" },
    communicated: { label: "已沟通", tone: "warm" },
    resume_sent: { label: "已发简历", tone: "keep" },
    rejected: { label: "被拒绝", tone: "exclude" },
    unsuitable: { label: "不合适", tone: "exclude" },
    zombie: { label: "僵尸职位", tone: "exclude" },
    later: { label: "稍后看", tone: "keep" },
    interview: { label: "面试", tone: "keep" }
  };

  if (!HOST_RE.test(location.hostname)) return;
  if (window.top !== window.self) return;

  let store = null;
  let scanTimer = null;
  let lastUrl = location.href;
  let lastChatListFields = null;
  let lastPanelSignature = "";
  let extensionContextValid = true;

  init().catch((error) => {
    if (!isExtensionContextError(error)) console.warn("[BOSS 求职降噪助手] init failed", error);
    extensionContextValid = false;
  });

  async function init() {
    store = await loadStore();
    if (!extensionContextValid) return;
    injectPageStyles();
    mountPanel();
    scheduleScan(100);
    bindStorageSync();

    const observer = new MutationObserver((records) => {
      if (records.some(isRelevantPageMutation)) scheduleScan(250);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        scheduleScan(120);
      }
    }, 1000);
  }

  function isRelevantPageMutation(record) {
    const target = record.target;
    if (isPluginNode(target)) return false;
    const changedNodes = [
      ...Array.from(record.addedNodes || []),
      ...Array.from(record.removedNodes || [])
    ];
    if (changedNodes.length && changedNodes.every(isPluginNode)) return false;
    return true;
  }

  function isPluginNode(node) {
    if (!node) return false;
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const element = node;
    return Boolean(
      element.id === ROOT_ID
      || element.classList && (
        element.classList.contains("bjnr-mount")
        || element.classList.contains("bjnr-hidden-strip")
        || element.classList.contains("bjnr-chat-toolbar")
        || element.classList.contains("bjnr-open-chat-new-tab")
      )
      || element.closest && element.closest(`#${ROOT_ID}, .bjnr-mount, .bjnr-hidden-strip, .bjnr-chat-toolbar, .bjnr-open-chat-new-tab`)
    );
  }

  function defaultStore() {
    return {
      version: 1,
      jobs: {},
      companies: {},
      chatThreads: {},
      events: [],
      settings: {
        hideExcluded: true,
        hideZombie: true,
        dimCommunicated: true,
        showPanel: true
      },
      updatedAt: ""
    };
  }

  async function loadStore() {
    const raw = await storageGet(STORAGE_KEY);
    return normalizeStore(raw);
  }

  function normalizeStore(raw) {
    if (!raw || typeof raw !== "object") return defaultStore();
    const base = defaultStore();
    return {
      ...base,
      ...raw,
      jobs: raw.jobs && typeof raw.jobs === "object" ? raw.jobs : {},
      companies: raw.companies && typeof raw.companies === "object" ? raw.companies : {},
      chatThreads: raw.chatThreads && typeof raw.chatThreads === "object" ? raw.chatThreads : {},
      events: Array.isArray(raw.events) ? raw.events.slice(-400) : [],
      settings: { ...base.settings, ...(raw.settings || {}) }
    };
  }

  function bindStorageSync() {
    if (!hasExtensionContext() || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[STORAGE_KEY]) return;
      const incoming = changes[STORAGE_KEY].newValue;
      if (!incoming || incoming.updatedAt === store.updatedAt) return;
      store = normalizeStore(incoming);
      lastPanelSignature = "";
      scheduleScan(50);
    });
  }

  async function saveStore() {
    if (!extensionContextValid || !hasExtensionContext()) return;
    const latest = normalizeStore(await storageGet(STORAGE_KEY));
    if (latest.updatedAt && latest.updatedAt !== store.updatedAt) {
      store = mergeStores(latest, store);
    }
    store.updatedAt = new Date().toISOString();
    const ok = await storageSet(STORAGE_KEY, store);
    if (!ok) return;
    mountPanel();
  }

  function mergeStores(remote, local) {
    const base = defaultStore();
    const merged = {
      ...base,
      ...remote,
      ...local,
      jobs: mergeRecordMap(remote.jobs, local.jobs, mergeJobRecord),
      companies: mergeRecordMap(remote.companies, local.companies, mergeCompanyRecord),
      chatThreads: mergeRecordMap(remote.chatThreads, local.chatThreads, mergeChatRecord),
      events: mergeEvents(remote.events, local.events),
      settings: { ...base.settings, ...(remote.settings || {}), ...(local.settings || {}) },
      updatedAt: newestDate(remote.updatedAt, local.updatedAt)
    };
    return normalizeStore(merged);
  }

  function mergeRecordMap(remoteMap, localMap, mergeRecord) {
    const result = {};
    const keys = new Set([
      ...Object.keys(remoteMap || {}),
      ...Object.keys(localMap || {})
    ]);
    keys.forEach((key) => {
      const remote = remoteMap && remoteMap[key];
      const local = localMap && localMap[key];
      if (remote && local) result[key] = mergeRecord(remote, local);
      else result[key] = local || remote;
    });
    return result;
  }

  function mergeJobRecord(remote, local) {
    const merged = mergeGenericRecord(remote, local);
    mergeStatusValue(merged, remote, local);
    mergeStatusTimestampFields(merged, remote, local);
    return merged;
  }

  function mergeChatRecord(remote, local) {
    const merged = mergeGenericRecord(remote, local);
    mergeStatusValue(merged, remote, local);
    mergeStatusTimestampFields(merged, remote, local);
    return merged;
  }

  function mergeCompanyRecord(remote, local) {
    const merged = mergeGenericRecord(remote, local);
    const remoteTime = Date.parse(remote.lastMarkedAt || remote.updatedAt || remote.lastSeenAt || "") || 0;
    const localTime = Date.parse(local.lastMarkedAt || local.updatedAt || local.lastSeenAt || "") || 0;
    merged.status = localTime >= remoteTime ? local.status || remote.status || "normal" : remote.status || local.status || "normal";
    merged.lastMarkedAt = newestDate(remote.lastMarkedAt, local.lastMarkedAt);
    merged.lastSeenAt = newestDate(remote.lastSeenAt, local.lastSeenAt);
    merged.firstSeenAt = oldestDate(remote.firstSeenAt, local.firstSeenAt);
    return merged;
  }

  function mergeGenericRecord(remote, local) {
    const newer = isLocalNewer(remote, local) ? local : remote;
    const older = newer === local ? remote : local;
    return {
      ...older,
      ...newer,
      firstSeenAt: oldestDate(remote.firstSeenAt, local.firstSeenAt),
      lastSeenAt: newestDate(remote.lastSeenAt, local.lastSeenAt),
      lastMarkedAt: newestDate(remote.lastMarkedAt, local.lastMarkedAt),
      updatedAt: newestDate(remote.updatedAt, local.updatedAt),
      note: pickText(newer.note, older.note),
      hrName: pickText(newer.hrName, older.hrName),
      hrTitle: pickText(newer.hrTitle, older.hrTitle),
      lastMessage: pickText(newer.lastMessage, older.lastMessage),
      salary: pickText(newer.salary, older.salary),
      locationText: pickText(newer.locationText, older.locationText),
      url: pickText(newer.url, older.url),
      tags: local.tags && local.tags.length ? local.tags : remote.tags || []
    };
  }

  function mergeStatusValue(target, remote, local) {
    const remoteTime = Date.parse(remote.lastMarkedAt || remote.updatedAt || remote.lastSeenAt || "") || 0;
    const localTime = Date.parse(local.lastMarkedAt || local.updatedAt || local.lastSeenAt || "") || 0;
    target.status = localTime >= remoteTime ? local.status || remote.status || "unmarked" : remote.status || local.status || "unmarked";
  }

  function mergeStatusTimestampFields(target, remote, local) {
    [
      "firstProcessedAt",
      "firstCommunicatedAt",
      "firstDeliveredNoReplyAt",
      "firstReadNoReplyAt",
      "resumeSentAt",
      "interviewAt",
      "rejectedAt",
      "unsuitableAt",
      "laterAt",
      "zombieDetectedAt"
    ].forEach((field) => {
      target[field] = oldestDate(remote[field], local[field]) || remote[field] || local[field] || "";
    });
    [
      "lastProcessedAt",
      "lastCommunicatedAt",
      "lastDeliveredNoReplyAt",
      "lastReadNoReplyAt",
      "lastResumeSentAt",
      "lastInterviewAt"
    ].forEach((field) => {
      target[field] = newestDate(remote[field], local[field]);
    });
  }

  function mergeEvents(remoteEvents, localEvents) {
    const seen = new Set();
    return [...(remoteEvents || []), ...(localEvents || [])]
      .filter((event) => {
        const key = JSON.stringify(event || {});
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(-400);
  }

  function isLocalNewer(remote, local) {
    const remoteTime = Date.parse(remote.updatedAt || remote.lastMarkedAt || remote.lastSeenAt || "") || 0;
    const localTime = Date.parse(local.updatedAt || local.lastMarkedAt || local.lastSeenAt || "") || 0;
    return localTime >= remoteTime;
  }

  function pickText(primaryValue, fallbackValue) {
    return clean(primaryValue) || clean(fallbackValue) || "";
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      if (!hasExtensionContext()) {
        extensionContextValid = false;
        resolve(undefined);
        return;
      }
      try {
        chrome.storage.local.get([key], (result) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            extensionContextValid = false;
            resolve(undefined);
            return;
          }
          resolve(result && result[key]);
        });
      } catch (error) {
        extensionContextValid = false;
        if (!isExtensionContextError(error)) console.warn("[BOSS 求职降噪助手] storage get failed", error);
        resolve(undefined);
      }
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve) => {
      if (!hasExtensionContext()) {
        extensionContextValid = false;
        resolve(false);
        return;
      }
      try {
        chrome.storage.local.set({ [key]: value }, () => {
          if (chrome.runtime && chrome.runtime.lastError) {
            extensionContextValid = false;
            resolve(false);
            return;
          }
          resolve(true);
        });
      } catch (error) {
        extensionContextValid = false;
        if (!isExtensionContextError(error)) console.warn("[BOSS 求职降噪助手] storage set failed", error);
        resolve(false);
      }
    });
  }

  function hasExtensionContext() {
    try {
      return Boolean(window.chrome && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local);
    } catch {
      return false;
    }
  }

  function isExtensionContextError(error) {
    return /Extension context invalidated/i.test(String(error && (error.message || error)));
  }

  function scheduleScan(delay) {
    if (!extensionContextValid) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPage, delay);
  }

  function scanPage() {
    if (!extensionContextValid || !store) return;
    const cards = Array.from(document.querySelectorAll(JOB_SELECTOR))
      .filter((card) => !card.closest(`#${ROOT_ID}`));

    let changed = false;
    cards.forEach((card) => {
      const job = parseJobCard(card);
      if (!job || !job.jobTitle || !job.companyName) return;
      changed = upsertSeen(job, card) || changed;
      changed = applyZombieSignal(job.jobKey, detectActivitySignal(card)) || changed;
      renderJob(card, job);
    });
    changed = upsertDetailPageJob() || changed;
    changed = syncActiveDetailActivity() || changed;

    refreshCompanyCounts();
    decorateCommunicateButtons();
    mountChatDetailToolbar();
    if (changed) saveStore();
    mountPanel();
  }

  function parseJobCard(card) {
    const jobTitleNode = card.querySelector(".job-name");
    const jobTitle = clean(jobTitleNode && jobTitleNode.textContent);
    const salary = normalizeSalaryText(card.querySelector(".job-salary") && card.querySelector(".job-salary").textContent);
    const companyName = clean(card.querySelector(".job-card-footer .boss-name, .boss-name") && card.querySelector(".job-card-footer .boss-name, .boss-name").textContent);
    const locationText = clean(card.querySelector(".company-location") && card.querySelector(".company-location").textContent);
    const tags = Array.from(card.querySelectorAll(".tag-list li")).map((node) => clean(node.textContent)).filter(Boolean);
    const href = jobTitleNode && jobTitleNode.getAttribute("href") ? jobTitleNode.getAttribute("href") : "";
    const url = resolveUrl(href);

    if (!jobTitle || !companyName) return null;

    const companyKey = `company:${hash(companyName)}`;
    const jobId = extractJobId(url);
    const jobKey = jobId ? `job:${jobId}` : `job-fp:${hash([companyName, jobTitle, locationText, tags.slice(0, 2).join(","), salary].join("|"))}`;

    return {
      jobKey,
      companyKey,
      jobTitle,
      companyName,
      locationText,
      salary,
      tags,
      url
    };
  }

  function parseJobDetailPage() {
    const jobId = extractJobId(location.href) || extractJobIdFromAttributes(document);
    if (!jobId) return null;
    const root = document.querySelector(".job-primary.detail-box") || document.querySelector(".job-banner") || document.body;
    const jobTitle = clean(textFromSelectors([
      ".job-primary .job-title",
      ".smallbanner .job-title",
      ".info-primary .name",
      "h1"
    ], root) || parseTitleFromDocument());
    const companyName = clean(textFromSelectors([
      "[ka='job-detail-company_custompage']",
      ".sider-company .company-info a:nth-of-type(2)",
      ".company-info a:nth-of-type(2)"
    ], document));
    const salary = normalizeSalaryText(textFromSelectors([
      ".job-primary .salary",
      ".job-primary .job-salary",
      ".info-primary .salary",
      ".smallbanner .salary"
    ], document) || findSalaryText(root));
    const locationText = clean(textFromSelectors([
      ".job-primary .text-city",
      ".job-primary .job-area",
      ".job-primary .location",
      ".job-location"
    ], document) || findCityNearTitle(root));
    const tags = Array.from(document.querySelectorAll(".job-primary .job-tags span, .job-primary .job-tags, .tag-container-new .job-tags span"))
      .map((node) => clean(node.textContent))
      .filter(Boolean)
      .slice(0, 12);
    const bossText = clean(document.querySelector(".job-boss-info") && document.querySelector(".job-boss-info").textContent);
    const bossInfo = parseBossInfo(bossText, companyName);

    if (!jobTitle || !companyName) return null;
    const companyKey = `company:${hash(companyName)}`;
    return {
      jobKey: `job:${jobId}`,
      companyKey,
      companyName,
      jobTitle,
      locationText,
      salary,
      tags,
      url: `https://www.zhipin.com/job_detail/${jobId}.html`,
      hrName: bossInfo.hrName,
      hrTitle: bossInfo.hrTitle,
      source: "detail"
    };
  }

  function upsertDetailPageJob() {
    const job = parseJobDetailPage();
    if (!job) return false;
    const now = new Date().toISOString();
    const nowTime = Date.now();
    const existing = store.jobs[job.jobKey] || {};
    const matched = findMergeCandidateForDetailJob(job);
    const base = mergeBaseRecords(existing, matched);
    const beforeJob = stableRecordSnapshot(store.jobs[job.jobKey]);
    const beforeMatched = matched && matched.jobKey !== job.jobKey ? stableRecordSnapshot(matched) : "";
    const linkedChat = findBestChatThreadForJobData({
      companyName: job.companyName,
      jobTitle: job.jobTitle,
      hrName: job.hrName || base.hrName || ""
    });
    const syncedStatus = chooseSyncedStatus(base, linkedChat);
    const shouldRefreshSeen = !base.lastSeenAt || nowTime - (Date.parse(base.lastSeenAt) || 0) > 5 * 60 * 1000;

    store.jobs[job.jobKey] = {
      ...base,
      jobKey: job.jobKey,
      companyKey: job.companyKey,
      companyName: job.companyName || base.companyName || "",
      jobTitle: job.jobTitle || base.jobTitle || "",
      locationText: job.locationText || base.locationText || "",
      salary: job.salary || normalizeSalaryText(base.salary) || "",
      tags: job.tags && job.tags.length ? job.tags : base.tags || [],
      url: job.url || base.url || "",
      status: syncedStatus || base.status || "unmarked",
      note: base.note || "",
      hrName: base.hrName || job.hrName || linkedChat && linkedChat.hrName || "",
      hrTitle: base.hrTitle || job.hrTitle || linkedChat && linkedChat.hrTitle || "",
      firstSeenAt: base.firstSeenAt || now,
      lastSeenAt: shouldRefreshSeen ? now : base.lastSeenAt,
      lastMarkedAt: newestDate(base.lastMarkedAt, linkedChat && linkedChat.lastMarkedAt),
      seenCount: base.seenCount || 0,
      source: base.source || "detail"
    };
    mergeStatusFieldsFromLinkedChat(store.jobs[job.jobKey], linkedChat);
    const chatChanged = mergeChatThreadsToJob(job, matched && matched.jobKey);
    const mergedDifferentRecord = Boolean(matched && matched.jobKey && matched.jobKey !== job.jobKey);
    if (mergedDifferentRecord) delete store.jobs[matched.jobKey];

    const company = store.companies[job.companyKey] || {};
    const shouldRefreshCompanySeen = !company.lastSeenAt || nowTime - (Date.parse(company.lastSeenAt) || 0) > 5 * 60 * 1000;
    store.companies[job.companyKey] = {
      companyKey: job.companyKey,
      companyName: job.companyName,
      status: company.status || "normal",
      note: company.note || "",
      firstSeenAt: company.firstSeenAt || now,
      lastSeenAt: shouldRefreshCompanySeen ? now : company.lastSeenAt,
      lastMarkedAt: company.lastMarkedAt || "",
      jobCount: company.jobCount || 0,
      communicatedCount: company.communicatedCount || 0,
      rejectedCount: company.rejectedCount || 0
    };
    return beforeJob !== stableRecordSnapshot(store.jobs[job.jobKey])
      || beforeMatched
      || chatChanged
      || shouldRefreshCompanySeen;
  }

  function findMergeCandidateForDetailJob(detailJob) {
    const candidates = Object.values(store.jobs || {})
      .filter((job) => job.jobKey !== detailJob.jobKey)
      .filter((job) => isSameOrRelatedCompany(job.companyName, detailJob.companyName))
      .filter((job) => isTemporaryJobKey(job.jobKey))
      .filter((job) => isStrictSameJobTitle(job.jobTitle, detailJob.jobTitle));
    if (candidates.length !== 1) return null;
    return candidates[0];
  }

  function isTemporaryJobKey(jobKey) {
    return /^(chat-job:|job-fp:)/.test(String(jobKey || ""));
  }

  function isStrictSameJobTitle(left, right) {
    const a = normalizeJobTitleForMatch(left);
    const b = normalizeJobTitleForMatch(right);
    return Boolean(a && b && a === b);
  }

  function mergeBaseRecords(primary, secondary) {
    if (!secondary) return primary || {};
    if (!primary || !Object.keys(primary).length) return secondary;
    const primaryTime = Date.parse(primary.lastMarkedAt || primary.lastSeenAt || "") || 0;
    const secondaryTime = Date.parse(secondary.lastMarkedAt || secondary.lastSeenAt || "") || 0;
    const newer = primaryTime >= secondaryTime ? primary : secondary;
    return {
      ...secondary,
      ...primary,
      status: newer.status || primary.status || secondary.status || "unmarked",
      lastMarkedAt: newestDate(primary.lastMarkedAt, secondary.lastMarkedAt),
      firstSeenAt: primary.firstSeenAt || secondary.firstSeenAt || "",
      note: primary.note || secondary.note || "",
      hrName: primary.hrName || secondary.hrName || "",
      hrTitle: primary.hrTitle || secondary.hrTitle || ""
    };
  }

  function mergeChatThreadsToJob(detailJob, oldJobKey) {
    let changed = false;
    Object.values(store.chatThreads || {}).forEach((thread) => {
      const matchOldKey = oldJobKey && thread.jobKey === oldJobKey;
      const matchFields = isSameOrRelatedCompany(thread.companyName, detailJob.companyName)
        && isStrictSameJobTitle(thread.jobTitle, detailJob.jobTitle);
      if (!matchOldKey && !matchFields) return;
      const before = stableRecordSnapshot(thread);
      thread.jobKey = detailJob.jobKey;
      thread.companyKey = detailJob.companyKey;
      thread.companyName = thread.companyName || detailJob.companyName;
      thread.jobTitle = thread.jobTitle || detailJob.jobTitle;
      const after = stableRecordSnapshot(thread);
      if (before !== after) {
        thread.updatedAt = new Date().toISOString();
        changed = true;
      }
    });
    return changed;
  }

  function stableRecordSnapshot(record) {
    if (!record || typeof record !== "object") return "";
    return JSON.stringify(Object.keys(record).sort().reduce((acc, key) => {
      acc[key] = record[key];
      return acc;
    }, {}));
  }

  function textFromSelectors(selectors, scope) {
    for (const selector of selectors) {
      const node = (scope || document).querySelector(selector);
      const text = clean(node && node.textContent);
      if (text) return text;
    }
    return "";
  }

  function parseTitleFromDocument() {
    const match = String(document.title || "").match(/「(.+?)招聘」/);
    return match ? clean(match[1]) : "";
  }

  function findSalaryText(root) {
    const match = clean(root && root.textContent).match(/\d+\s*-\s*\d+\s*K(?:[·.]\d+薪)?/i);
    return match ? clean(match[0]) : "";
  }

  function normalizeSalaryText(value) {
    const text = clean(value);
    if (!text) return "";
    if (/[�□?]{2,}/.test(text)) return "";
    const match = text.match(/\d+\s*-\s*\d+\s*K(?:[·.]\d+薪)?|面议|\d+\s*K以上/i);
    return match ? clean(match[0]) : "";
  }

  function findCityNearTitle(root) {
    const text = clean(root && root.textContent);
    const salary = findSalaryText(root);
    if (!salary) return "";
    const tail = text.slice(text.indexOf(salary) + salary.length);
    const match = tail.match(/([\u4e00-\u9fa5]{2,8})(?:\s+\d|$)/);
    return match ? clean(match[1]) : "";
  }

  function parseBossInfo(text, companyName) {
    const source = clean(text);
    if (!source) return { hrName: "", hrTitle: "" };
    const hrName = clean((source.match(/^([\u4e00-\u9fa5]{1,4}(?:先生|女士|老师)?)/) || [])[1]);
    const afterCompany = companyName && source.includes(`${companyName}·`) ? source.split(`${companyName}·`).pop() : "";
    return {
      hrName,
      hrTitle: clean(afterCompany || "")
    };
  }

  function extractJobIdFromAttributes(scope) {
    const nodes = Array.from((scope || document).querySelectorAll("[redirect-url], [data-url], [href]"));
    for (const node of nodes) {
      const value = node.getAttribute("redirect-url") || node.getAttribute("data-url") || node.getAttribute("href") || "";
      const jobId = extractJobId(value);
      if (jobId) return jobId;
    }
    return "";
  }

  function resolveUrl(href) {
    if (!href || href === "javascript:;") return "";
    try {
      return new URL(href, location.origin).href;
    } catch {
      return "";
    }
  }

  function extractJobId(url) {
    const text = String(url || "");
    const detailMatch = text.match(/job_detail\/([^/?#]+)\.html/i);
    if (detailMatch) return detailMatch[1];
    const queryMatch = text.match(/[?&]jobId=([^&#]+)/i);
    return queryMatch ? decodeURIComponent(queryMatch[1]) : "";
  }

  function upsertSeen(job, card) {
    const now = new Date().toISOString();
    const existing = store.jobs[job.jobKey];
    const linkedChat = findBestChatThreadForJobData(job);
    const base = existing || {};
    const firstTimeThisSession = card.dataset.bjnrSeen !== "1";
    const syncedStatus = chooseSyncedStatus(base, linkedChat);

    store.jobs[job.jobKey] = {
      ...base,
      jobKey: job.jobKey,
      companyKey: job.companyKey,
      companyName: job.companyName,
      jobTitle: job.jobTitle,
      locationText: job.locationText,
      salary: job.salary,
      tags: job.tags,
      url: job.url,
      status: syncedStatus,
      note: base.note || "",
      hrName: base.hrName || linkedChat && linkedChat.hrName || "",
      firstSeenAt: base.firstSeenAt || now,
      lastSeenAt: now,
      lastMarkedAt: newestDate(base.lastMarkedAt, linkedChat && linkedChat.lastMarkedAt),
      seenCount: (base.seenCount || 0) + (firstTimeThisSession ? 1 : 0)
    };
    mergeStatusFieldsFromLinkedChat(store.jobs[job.jobKey], linkedChat);

    const company = store.companies[job.companyKey] || {};
    store.companies[job.companyKey] = {
      companyKey: job.companyKey,
      companyName: job.companyName,
      status: company.status || "normal",
      note: company.note || "",
      firstSeenAt: company.firstSeenAt || now,
      lastSeenAt: now,
      lastMarkedAt: company.lastMarkedAt || "",
      jobCount: company.jobCount || 0,
      communicatedCount: company.communicatedCount || 0,
      rejectedCount: company.rejectedCount || 0
    };

    card.dataset.bjnrJobKey = job.jobKey;
    card.dataset.bjnrCompanyKey = job.companyKey;
    if (firstTimeThisSession) {
      card.dataset.bjnrSeen = "1";
      return true;
    }
    return false;
  }

  function chooseSyncedStatus(record, linkedChat) {
    const recordStatus = record && record.status || "unmarked";
    const chatStatus = linkedChat && linkedChat.status || "";
    if (!linkedChat || !chatStatus || chatStatus === "unmarked") return recordStatus;
    if (!recordStatus || recordStatus === "unmarked") return chatStatus;
    const recordTime = Date.parse(record.lastMarkedAt || record.updatedAt || record.lastSeenAt || "") || 0;
    const chatTime = Date.parse(linkedChat.lastMarkedAt || linkedChat.updatedAt || "") || 0;
    return chatTime >= recordTime ? chatStatus : recordStatus;
  }

  function mergeStatusFieldsFromLinkedChat(record, linkedChat) {
    if (!record || !linkedChat) return;
    [
      "firstCommunicatedAt",
      "firstDeliveredNoReplyAt",
      "firstReadNoReplyAt",
      "resumeSentAt",
      "interviewAt",
      "rejectedAt",
      "unsuitableAt"
    ].forEach((field) => {
      record[field] = record[field] || linkedChat[field] || "";
    });
    [
      "lastCommunicatedAt",
      "lastDeliveredNoReplyAt",
      "lastReadNoReplyAt",
      "lastResumeSentAt",
      "lastInterviewAt"
    ].forEach((field) => {
      record[field] = newestDate(record[field], linkedChat[field]);
    });
  }

  function newestDate(left, right) {
    if (!left) return right || "";
    if (!right) return left || "";
    const leftTime = Date.parse(left) || 0;
    const rightTime = Date.parse(right) || 0;
    return rightTime > leftTime ? right : left;
  }

  function oldestDate(left, right) {
    if (!left) return right || "";
    if (!right) return left || "";
    const leftTime = Date.parse(left) || 0;
    const rightTime = Date.parse(right) || 0;
    if (!leftTime) return right;
    if (!rightTime) return left;
    return rightTime < leftTime ? right : left;
  }

  function refreshCompanyCounts() {
    Object.values(store.companies).forEach((company) => {
      const jobs = Object.values(store.jobs).filter((job) => job.companyKey === company.companyKey);
      company.jobCount = jobs.length;
      company.communicatedCount = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length;
      company.rejectedCount = jobs.filter((job) => job.status === "rejected").length;
    });
  }

  function findBestChatThreadForJobData(job) {
    return findChatThreadsForJobData(job)[0] || null;
  }

  function findChatThreadsForJobRecord(record) {
    return findChatThreadsForJobData({
      companyName: record.companyName,
      jobTitle: record.jobTitle,
      hrName: record.hrName
    });
  }

  function findChatThreadsForJobData(job) {
    return Object.values(store.chatThreads || {})
      .filter((chat) => chat.jobKey && job.jobKey ? chat.jobKey === job.jobKey || isSameOrRelatedCompany(chat.companyName, job.companyName) : isSameOrRelatedCompany(chat.companyName, job.companyName))
      .filter((chat) => isSameOrRelatedJobTitle(chat.jobTitle, job.jobTitle))
      .sort((a, b) => {
        const hrScore = Number(chatHrMatches(b, job.hrName)) - Number(chatHrMatches(a, job.hrName));
        if (hrScore) return hrScore;
        return String(b.updatedAt || b.lastMarkedAt || "").localeCompare(String(a.updatedAt || a.lastMarkedAt || ""));
      });
  }

  function chatHrMatches(chat, hrName) {
    if (!hrName || !chat || !chat.hrName) return false;
    return clean(chat.hrName) === clean(hrName);
  }

  function isSameOrRelatedCompany(left, right) {
    if (!clean(left) || !clean(right)) return false;
    if (clean(left) === clean(right)) return true;
    const a = normalizeCompanyNameForMatch(left);
    const b = normalizeCompanyNameForMatch(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    return short.length >= 3 && long.includes(short);
  }

  function isSameOrRelatedJobTitle(left, right) {
    const a = normalizeJobTitleForMatch(left).replace(/^(高级|资深|初级|中级|见习|实习|储备)+/, "").replace(/(高级|资深|初级|中级|见习|实习)$/, "");
    const b = normalizeJobTitleForMatch(right).replace(/^(高级|资深|初级|中级|见习|实习|储备)+/, "").replace(/(高级|资深|初级|中级|见习|实习)$/, "");
    if (!a || !b) return false;
    if (a === b) return true;
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    if (short.length < 3) return false;
    if (long.includes(short) && short.length / long.length >= 0.6) return true;
    return longestCommonChineseRun(a, b) >= 4 && longestCommonChineseRun(a, b) / long.length >= 0.6;
  }

  function normalizeJobTitleForMatch(value) {
    return clean(value)
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/[【\[][^】\]]*[】\]]/g, "")
      .replace(/\.{2,}|…+/g, "")
      .replace(/[｜|·_\-+/\\\s]/g, "")
      .replace(/招聘|急聘|直招|双休|单双休/g, "");
  }

  function normalizeCompanyNameForMatch(value) {
    return clean(value)
      .replace(/[（）()\[\]【】\s]/g, "")
      .replace(/有限责任公司|股份有限公司|有限合伙|集团股份|集团|控股|公司/g, "");
  }

  function longestCommonChineseRun(left, right) {
    let best = 0;
    for (let start = 0; start < left.length; start += 1) {
      for (let end = start + 1; end <= left.length; end += 1) {
        const part = left.slice(start, end);
        if (/^[\u4e00-\u9fa5]+$/.test(part) && right.includes(part)) best = Math.max(best, part.length);
      }
    }
    return best;
  }

  function detectActivitySignal(root) {
    if (!(root instanceof Element)) return null;
    const labels = findActivityLabels(root);
    if (!labels.length) return null;
    const label = labels.find((item) => !isFreshActivityLabel(item)) || labels[0];
    return {
      label,
      isZombie: !isFreshActivityLabel(label)
    };
  }

  function findActivityLabels(root) {
    const candidates = [root, ...Array.from(root.querySelectorAll("*"))]
      .filter((node) => !node.closest(`#${ROOT_ID}`))
      .map((node) => clean(node.textContent).replace(/\s+/g, ""))
      .filter((text) => text && text.length <= 12);
    return uniqueStrings(candidates.map(parseActivityLabel).filter(Boolean));
  }

  function parseActivityLabel(text) {
    const source = clean(text).replace(/\s+/g, "");
    const match = source.match(/^(在线|刚刚活跃|今日活跃|3日内活跃|三日内活跃|本周活跃|本月活跃|7日内活跃|七日内活跃|15日内活跃|30日内活跃|一个月内活跃)$/);
    return match ? match[1] : "";
  }

  function isFreshActivityLabel(label) {
    return /^(在线|刚刚活跃|今日活跃|3日内活跃|三日内活跃)$/.test(label);
  }

  function applyZombieSignal(jobKey, signal) {
    if (!store.settings.hideZombie || !signal || !signal.isZombie) return false;
    const record = store.jobs[jobKey];
    if (!record || record.status !== "unmarked") {
      if (record && record.activityText !== signal.label) {
        record.activityText = signal.label;
        return true;
      }
      return false;
    }
    const now = new Date().toISOString();
    record.status = "zombie";
    record.activityText = signal.label;
    record.zombieDetectedAt = record.zombieDetectedAt || now;
    record.lastMarkedAt = now;
    pushEvent("job", jobKey, "zombie_detected", "unmarked", signal.label);
    return true;
  }

  function syncActiveDetailActivity() {
    if (!store.settings.hideZombie) return false;
    const signal = detectActivitySignal(findActiveDetailRoot());
    if (!signal) return false;
    const jobKey = findActiveJobKeyFromPage();
    if (!jobKey) return false;
    return applyZombieSignal(jobKey, signal);
  }

  function findActiveDetailRoot() {
    const selectors = [
      ".job-detail",
      ".job-detail-box",
      ".job-detail-container",
      ".detail-content",
      ".job-sec",
      ".job-detail-card",
      "[class*='job-detail']",
      "[class*='detail']"
    ].join(",");
    const candidates = Array.from(document.querySelectorAll(selectors))
      .filter((node) => node instanceof HTMLElement)
      .filter((node) => !node.closest(`#${ROOT_ID}`))
      .map((node) => ({ node, rect: node.getBoundingClientRect(), text: clean(node.textContent) }))
      .filter((item) => item.rect.width > 260 && item.rect.height > 120)
      .filter((item) => item.rect.left > window.innerWidth * 0.28)
      .filter((item) => /活跃|在线/.test(item.text))
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
    return candidates[0] ? candidates[0].node : null;
  }

  function findActiveJobKeyFromPage() {
    const selectors = [
      ".job-card-wrap.active li.job-card-box",
      ".card-area.is-seen li.job-card-box",
      "li.job-card-box.bjnr-card"
    ];
    for (const selector of selectors) {
      const card = document.querySelector(selector);
      if (card && card.dataset.bjnrJobKey) return card.dataset.bjnrJobKey;
    }
    const activeUrl = getActiveJobDetailUrl();
    const jobId = extractJobId(activeUrl);
    return jobId ? `job:${jobId}` : "";
  }

  function renderJob(card, parsedJob) {
    const record = store.jobs[parsedJob.jobKey];
    const company = store.companies[parsedJob.companyKey];
    if (!record) return;

    const shell = getCardShell(card);
    const renderSignature = getJobRenderSignature(record, company, shell);

    card.classList.add("bjnr-card");
    shell.classList.add("bjnr-card-shell");
    card.classList.toggle("bjnr-dim", shouldDim(record));
    card.classList.toggle("bjnr-keep", KEEP_JOB_STATUSES.has(record.status));
    card.classList.toggle("bjnr-excluded", isExcluded(record, company));

    if (shouldHide(record, company, shell)) {
      if (
        shell.dataset.bjnrHiddenSignature === renderSignature
        && document.querySelector(`.bjnr-hidden-strip[data-bjnr-job-key="${cssEscape(record.jobKey)}"]`)
      ) {
        return;
      }
      removeHiddenStrip(record.jobKey);
      hideCard(shell, record, company);
      shell.dataset.bjnrHiddenSignature = renderSignature;
      return;
    }

    removeHiddenStrip(record.jobKey);
    shell.dataset.bjnrHiddenSignature = "";
    shell.style.display = "";
    if (card.dataset.bjnrRenderSignature === renderSignature && card.querySelector(".bjnr-mount")) return;
    card.dataset.bjnrRenderSignature = renderSignature;
    card.querySelectorAll(".bjnr-mount").forEach((node) => node.remove());
    const mount = document.createElement("div");
    mount.className = "bjnr-mount";
    mount.addEventListener("click", (event) => {
      if (event.target.closest("[data-bjnr-action]")) return;
      stopNativeClick(event);
    }, true);
    mount.innerHTML = `
      <div class="bjnr-memory">${renderChips(record, company)}</div>
      <div class="bjnr-actions">
      ${actionButton("未读未回", "waiting", record.status === "waiting", "warm")}
      ${actionButton("已读未回", "read_no_reply", record.status === "read_no_reply", "warm")}
      ${actionButton("已沟通", "communicated", record.status === "communicated", "warm")}
      ${actionButton("已发简历", "resume_sent", record.status === "resume_sent", "keep")}
      ${actionButton("面试", "interview", record.status === "interview", "keep")}
      ${actionButton("被拒绝", "rejected", record.status === "rejected", "exclude")}
      ${actionButton("不合适", "unsuitable", record.status === "unsuitable", "exclude")}
      ${actionButton("僵尸职位", "zombie", record.status === "zombie", "exclude")}
      ${actionButton("稍后看", "later", record.status === "later", "keep")}
        ${actionButton("屏蔽公司", "block-company", company && company.status === "blocked", "exclude")}
        ${actionButton("备注/HR", "edit", Boolean(record.note || record.hrName), "neutral")}
        ${actionButton("清除", "clear", false, "plain")}
      </div>
    `;

    mount.querySelectorAll("[data-bjnr-action]").forEach((button) => {
      button.addEventListener("pointerdown", (event) => {
        stopNativeClick(event);
        triggerButtonAction(button, record, shell);
      });
      ["mousedown", "mouseup"].forEach((eventName) => {
        button.addEventListener(eventName, stopPagePointer, true);
      });
      button.addEventListener("click", (event) => {
        stopNativeClick(event);
        triggerButtonAction(button, record, shell);
      });
    });

    card.appendChild(mount);
  }

  function getCardShell(card) {
    return card.closest(WRAP_SELECTOR) || card;
  }

  function getJobRenderSignature(record, company, shell) {
    return JSON.stringify({
      jobKey: record.jobKey,
      status: record.status,
      note: record.note || "",
      hrName: record.hrName || "",
      activityText: record.activityText || "",
      companyStatus: company && company.status || "",
      companyNote: company && company.note || "",
      expanded: shell && shell.dataset.bjnrExpanded || "",
      hideExcluded: store.settings.hideExcluded,
      hideZombie: store.settings.hideZombie,
      dimCommunicated: store.settings.dimCommunicated
    });
  }

  function renderChips(record, company) {
    const chips = [];
    const status = STATUS[record.status] || STATUS.unmarked;
    const chatRecords = findChatThreadsForJobRecord(record);
    if (record.status !== "unmarked") chips.push(chip(status.label, status.tone));
    if (chatRecords.length) {
      const chat = chatRecords[0];
      const chatStatus = STATUS[chat.status] || STATUS.unmarked;
      chips.push(chip(`消息：${chat.hrName} · ${chatStatus.label}`, chatStatus.tone));
    }
    if (record.hrName) chips.push(chip(`HR：${record.hrName}`, "neutral"));
    if (company && company.jobCount > 1) chips.push(chip(`同公司 ${company.jobCount} 条`, "keep"));
    if (company && company.status === "blocked") chips.push(chip(`公司屏蔽${company.note ? `：${truncate(company.note, 10)}` : ""}`, "exclude"));
    if (record.note) chips.push(chip(`备注：${truncate(record.note, 18)}`, "neutral"));
    if (record.status === "zombie" && record.activityText) chips.push(chip(record.activityText, "exclude"));
    if (!chips.length) chips.push(chip("新职位", "fresh"));
    return chips.join("");
  }

  function chip(text, tone) {
    return `<span class="bjnr-chip bjnr-chip-${tone || "neutral"}">${escapeHtml(text)}</span>`;
  }

  function actionButton(label, action, active, tone) {
    return `<button type="button" class="bjnr-action bjnr-action-${tone || "neutral"}${active ? " is-active" : ""}" data-bjnr-action="${escapeHtml(action)}">${escapeHtml(label)}</button>`;
  }

  function triggerButtonAction(button, record, shell) {
    const now = Date.now();
    const lastTriggeredAt = Number(button.dataset.bjnrTriggeredAt || 0);
    if (now - lastTriggeredAt < 650) return;
    button.dataset.bjnrTriggeredAt = String(now);
    handleAction(button.dataset.bjnrAction, record.jobKey, record.companyKey, shell);
  }

  async function handleAction(action, jobKey, companyKey, shell) {
    if (["waiting", "read_no_reply", "communicated", "resume_sent", "interview", "rejected", "unsuitable", "zombie", "later"].includes(action)) {
      await setJobStatus(jobKey, action);
      return;
    }
    if (action === "block-company") {
      const company = store.companies[companyKey];
      const note = window.prompt("屏蔽这家公司的原因，可留空：", company ? company.note || "" : "");
      if (note === null) return;
      await setCompanyStatus(companyKey, "blocked", note.trim());
      return;
    }
    if (action === "edit") {
      await editJob(jobKey);
      return;
    }
    if (action === "clear") {
      shell.dataset.bjnrExpanded = "0";
      await setJobStatus(jobKey, "unmarked");
    }
  }

  async function setJobStatus(jobKey, status) {
    const record = store.jobs[jobKey];
    if (!record) return;
    const from = record.status || "unmarked";
    record.status = status;
    record.lastMarkedAt = status === "unmarked" ? "" : new Date().toISOString();
    applyStatusTimestamps(record, status, record.lastMarkedAt);
    pushEvent("job", jobKey, "status_changed", from, status);
    await saveStore();
    scheduleScan(20);
  }

  async function setCompanyStatus(companyKey, status, note) {
    const company = store.companies[companyKey];
    if (!company) return;
    const from = company.status || "normal";
    company.status = status;
    company.note = note || "";
    company.lastMarkedAt = status === "normal" ? "" : new Date().toISOString();
    pushEvent("company", companyKey, "status_changed", from, status);
    await saveStore();
    scheduleScan(20);
  }

  async function editJob(jobKey) {
    const record = store.jobs[jobKey];
    if (!record) return;
    const hrName = window.prompt("HR 名称（列表页没有显示时可手动补）：", record.hrName || "");
    if (hrName === null) return;
    const note = window.prompt("职位备注：", record.note || "");
    if (note === null) return;
    record.hrName = hrName.trim();
    record.note = note.trim();
    record.lastMarkedAt = new Date().toISOString();
    pushEvent("job", jobKey, "details_updated", "", "");
    await saveStore();
    scheduleScan(20);
  }

  function shouldDim(record) {
    return store.settings.dimCommunicated && ACTIVE_JOB_STATUSES.has(record.status);
  }

  function isExcluded(record, company) {
    if (KEEP_JOB_STATUSES.has(record.status)) return false;
    return EXCLUDED_JOB_STATUSES.has(record.status) || (company && company.status === "blocked");
  }

  function shouldHide(record, company, shell) {
    if (shell.dataset.bjnrExpanded === "1") return false;
    if (record.status === "zombie") return Boolean(store.settings.hideZombie);
    if (!store.settings.hideExcluded) return false;
    return isExcluded(record, company);
  }

  function hideCard(shell, record, company) {
    shell.style.display = "none";
    if (document.querySelector(`.bjnr-hidden-strip[data-bjnr-job-key="${cssEscape(record.jobKey)}"]`)) return;
    const strip = document.createElement("div");
    strip.className = "bjnr-hidden-strip";
    strip.dataset.bjnrJobKey = record.jobKey;
    strip.innerHTML = `
      <div class="bjnr-hidden-copy">
        <strong>已隐藏</strong>
        <span>${escapeHtml(record.jobTitle)} · ${escapeHtml(record.companyName)}</span>
        <small>${escapeHtml(hiddenReason(record, company))}</small>
      </div>
      <div class="bjnr-hidden-actions">
        <button type="button" data-bjnr-hidden-action="expand">展开本次</button>
        <button type="button" data-bjnr-hidden-action="clear">清除标记</button>
      </div>
    `;
    strip.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-bjnr-hidden-action]");
      if (!button) return;
      stopNativeClick(event);
      if (button.dataset.bjnrHiddenAction === "expand") {
        shell.dataset.bjnrExpanded = "1";
        strip.remove();
        shell.style.display = "";
        scheduleScan(20);
      }
      if (button.dataset.bjnrHiddenAction === "clear") {
        shell.dataset.bjnrExpanded = "0";
        if (company && company.status === "blocked") {
          await setCompanyStatus(company.companyKey, "normal", "");
        }
        await setJobStatus(record.jobKey, "unmarked");
      }
    });
    shell.insertAdjacentElement("beforebegin", strip);
  }

  function removeHiddenStrip(jobKey) {
    document.querySelectorAll(`.bjnr-hidden-strip[data-bjnr-job-key="${cssEscape(jobKey)}"]`).forEach((node) => node.remove());
  }

  function hiddenReason(record, company) {
    if (record.status === "zombie") return record.activityText ? `僵尸职位：${record.activityText}` : "僵尸职位";
    if (EXCLUDED_JOB_STATUSES.has(record.status)) return STATUS[record.status].label;
    if (company && company.status === "blocked") return company.note ? `公司屏蔽：${company.note}` : "公司已屏蔽";
    return "已排除";
  }

  function pushEvent(targetType, targetKey, action, from, to) {
    store.events.push({
      eventId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      targetType,
      targetKey,
      action,
      from,
      to,
      createdAt: new Date().toISOString()
    });
    store.events = store.events.slice(-400);
  }

  function applyStatusTimestamps(target, status, now) {
    if (!target) return;
    if (status === "unmarked") {
      clearStatusTimestamps(target);
      return;
    }
    if (!now) return;
    if (status && status !== "unmarked") {
      target.firstProcessedAt = target.firstProcessedAt || now;
      target.lastProcessedAt = now;
    }
    if (ACTIVE_JOB_STATUSES.has(status)) {
      target.firstCommunicatedAt = target.firstCommunicatedAt || now;
      target.lastCommunicatedAt = now;
    }
    if (status === "waiting") {
      target.firstDeliveredNoReplyAt = target.firstDeliveredNoReplyAt || now;
      target.lastDeliveredNoReplyAt = now;
    }
    if (status === "read_no_reply") {
      target.firstReadNoReplyAt = target.firstReadNoReplyAt || now;
      target.lastReadNoReplyAt = now;
    }
    if (status === "resume_sent") {
      target.resumeSentAt = target.resumeSentAt || now;
      target.lastResumeSentAt = now;
    }
    if (status === "interview") {
      target.interviewAt = target.interviewAt || now;
      target.lastInterviewAt = now;
    }
    if (status === "rejected") {
      target.rejectedAt = target.rejectedAt || now;
    }
    if (status === "unsuitable") {
      target.unsuitableAt = target.unsuitableAt || now;
    }
    if (status === "later") {
      target.laterAt = target.laterAt || now;
    }
  }

  function clearStatusTimestamps(target) {
    [
      "firstProcessedAt",
      "lastProcessedAt",
      "firstCommunicatedAt",
      "lastCommunicatedAt",
      "firstDeliveredNoReplyAt",
      "lastDeliveredNoReplyAt",
      "firstReadNoReplyAt",
      "lastReadNoReplyAt",
      "resumeSentAt",
      "lastResumeSentAt",
      "interviewAt",
      "lastInterviewAt",
      "rejectedAt",
      "unsuitableAt",
      "laterAt",
      "zombieDetectedAt",
      "activityText"
    ].forEach((field) => {
      delete target[field];
    });
  }

  function formatShortTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    if (sameDay) return `今天 ${time}`;
    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time}`;
  }

  function decorateCommunicateButtons() {
    document.querySelectorAll(".bjnr-open-chat-new-tab").forEach((node) => node.remove());
    if (isJobDetailPage()) return;

    const trigger = findCommunicateTriggers()[0];
    if (!trigger) return;
    if (!getActiveJobDetailUrl()) return;

    const reference = trigger.closest("a, button, [role='button'], .btn, [class*='btn']") || trigger;
    const parent = reference.parentElement;
    if (!parent) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "bjnr-open-chat-new-tab";
    button.textContent = "打开详情页沟通";
    button.title = "在新标签页打开当前职位详情页，并使用 BOSS 原生立即沟通";
    ["pointerdown", "mousedown", "mouseup"].forEach((eventName) => {
      button.addEventListener(eventName, stopNativeClick, true);
    });
    button.addEventListener("click", (event) => {
      stopNativeClick(event);
      const targetUrl = getActiveJobDetailUrl();
      if (targetUrl) window.open(targetUrl, "_blank", "noopener");
    });
    reference.insertAdjacentElement("afterend", button);
  }

  function isJobDetailPage() {
    return /\/job_detail\/[^/?#]+\.html/i.test(location.pathname);
  }

  function findCommunicateTriggers() {
    return Array.from(document.querySelectorAll("a, button, [role='button'], .btn, [class*='btn']"))
      .filter((node) => !node.closest(`#${ROOT_ID}`))
      .filter((node) => !node.classList.contains("bjnr-open-chat-new-tab"))
      .filter((node) => {
        const text = clean(node.textContent);
        return text.includes("立即沟通") && text.length <= 30;
      });
  }

  function getActiveJobDetailUrl() {
    const selectors = [
      ".job-card-wrap.active .job-name[href]",
      ".card-area.is-seen .job-name[href]"
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const url = resolveUrl(node && node.getAttribute("href"));
      if (url) return url;
    }
    return "";
  }

  function mountChatDetailToolbar() {
    if (!isChatPage()) return;
    decorateChatListItems();

    const root = findChatDetailRoot();
    if (!root) return;

    let toolbar = root.querySelector(".bjnr-chat-toolbar");
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.className = "bjnr-chat-toolbar";
      root.insertBefore(toolbar, root.firstChild);
    }

    const context = extractCurrentChatContext(root);
    toolbar.innerHTML = renderChatToolbar(context);
    toolbar.querySelectorAll("[data-bjnr-chat-status]").forEach((button) => {
      button.addEventListener("pointerdown", async (event) => {
        stopNativeClick(event);
        await triggerChatStatusAction(button, root);
      }, true);
      ["mousedown", "mouseup"].forEach((eventName) => {
        button.addEventListener(eventName, stopPagePointer, true);
      });
      button.addEventListener("click", async (event) => {
        stopNativeClick(event);
        await triggerChatStatusAction(button, root);
      });
    });
  }

  async function triggerChatStatusAction(button, fallbackRoot) {
    const now = Date.now();
    const lastTriggeredAt = Number(button.dataset.bjnrTriggeredAt || 0);
    if (now - lastTriggeredAt < 650) return;
    button.dataset.bjnrTriggeredAt = String(now);
    const latestRoot = findChatDetailRoot() || fallbackRoot;
    const latestContext = extractCurrentChatContext(latestRoot);
    await applyChatStatus(latestContext, button.dataset.bjnrChatStatus);
  }

  function decorateChatListItems() {
    document.querySelectorAll(".user-list-content li, [class*='user-list'] li, [class*='friend'] li").forEach((item) => {
      if (!(item instanceof HTMLElement)) return;
      const fields = parseChatListItem(item);
      const thread = findBestChatThreadForListFields(fields);
      item.classList.toggle("bjnr-chat-list-item", Boolean(thread));
      item.dataset.bjnrChatTone = thread ? (STATUS[thread.status] || STATUS.unmarked).tone : "";
      item.dataset.bjnrChatStatus = thread ? thread.status || "" : "";
      if (item.dataset.bjnrChatBound !== "1") {
        item.dataset.bjnrChatBound = "1";
        item.addEventListener("click", () => {
          lastChatListFields = parseChatListItem(item);
          setTimeout(() => scheduleScan(80), 80);
        }, true);
      }
    });
  }

  function findBestChatThreadForListFields(fields) {
    if (!fields || !fields.companyName || !fields.hrName) return null;
    return Object.values(store.chatThreads || {})
      .filter((thread) => thread.companyName === fields.companyName)
      .filter((thread) => thread.hrName === fields.hrName)
      .sort((a, b) => String(b.updatedAt || b.lastMarkedAt || "").localeCompare(String(a.updatedAt || a.lastMarkedAt || "")))[0] || null;
  }

  function findChatDetailRoot() {
    const selectors = [
      ".chat-conversation",
      ".chat-dialog",
      ".chat-detail",
      ".conversation-wrap",
      "[class*='conversation']",
      "[class*='dialog']"
    ].join(",");

    const candidates = Array.from(document.querySelectorAll(selectors))
      .filter((node) => node instanceof HTMLElement)
      .filter((node) => !node.closest(`#${ROOT_ID}`))
      .map((node) => ({ node, rect: node.getBoundingClientRect(), text: clean(node.textContent) }))
      .filter((item) => item.rect.width > 260 && item.rect.height > 160)
      .filter((item) => item.rect.left > window.innerWidth * 0.28)
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));

    return candidates[0] ? candidates[0].node : null;
  }

  function extractCurrentChatContext(root) {
    const listFields = getCurrentChatListFields();
    const detailText = clean(root && root.textContent).slice(0, 2000);
    const companyName = clean(listFields.companyName || findBestKnownCompany(detailText));
    const hrName = clean(listFields.hrName || guessHrName(detailText));
    const stableRecord = findBestChatThreadForListFields({ companyName, hrName });
    const jobTitle = clean(findJobTitleForChat(root, detailText, companyName, listFields.lastMessage) || stableRecord && stableRecord.jobTitle);
    const fields = {
      companyName,
      jobTitle,
      hrName,
      hrTitle: listFields.hrTitle || "",
      messageStatus: listFields.messageStatus || guessMessageStatus(detailText),
      lastMessage: listFields.lastMessage || "",
      timeText: listFields.timeText || "",
      stableChatKey: getStableChatKey({ companyName, hrName })
    };
    const chatKey = getChatKey(fields);
    return {
      ...fields,
      chatKey,
      complete: Boolean(chatKey),
      matchedJobs: chatKey ? findStrongMatchedJobs(fields) : []
    };
  }

  function getCurrentChatListFields() {
    const active = findActiveChatListItem();
    if (active) {
      lastChatListFields = parseChatListItem(active);
      return lastChatListFields;
    }
    return lastChatListFields || parseChatListItem(document.querySelector(".user-list-content li, [class*='user-list'] li, [class*='friend'] li")) || {};
  }

  function findActiveChatListItem() {
    const selectors = [
      ".user-list-content li.active",
      ".user-list-content li.selected",
      ".user-list-content li[class*='active']",
      ".user-list-content li[class*='selected']",
      "[class*='user-list'] li.active",
      "[class*='user-list'] li.selected",
      "[class*='friend'] li.active",
      "[class*='friend'] li.selected"
    ];
    return selectors.map((selector) => document.querySelector(selector)).find(Boolean);
  }

  function parseChatListItem(item) {
    if (!(item instanceof HTMLElement)) return {};
    return guessChatFields(clean(item.textContent), visibleTextNodes(item).slice(0, 40));
  }

  function findJobTitleForChat(root, detailText, companyName, lastMessage) {
    const known = findBestKnownJob([detailText, lastMessage].join(" "), companyName);
    if (known) return known;

    const salaryNeighbor = findJobTitleNearSalary(root);
    if (salaryNeighbor) return salaryNeighbor;

    const candidateNodes = root ? Array.from(root.querySelectorAll(".job-name, .job-title, [class*='job-name'], [class*='job-title'], [class*='position']")) : [];
    const domCandidate = candidateNodes
      .map((node) => clean(node.textContent))
      .filter((text) => isPlausibleJobTitle(text))
      .sort((a, b) => a.length - b.length)[0];
    if (domCandidate) return domCandidate;

    return inferJobTitleFromMessage(lastMessage || detailText);
  }

  function findJobTitleNearSalary(root) {
    if (!root) return "";
    const nodes = visibleTextNodes(root).slice(0, 120).map((item) => clean(item.text)).filter(Boolean);
    for (let index = 0; index < nodes.length; index += 1) {
      if (!/\d+\s*-\s*\d+\s*K|薪资|薪水/i.test(nodes[index])) continue;
      for (let offset = 1; offset <= 3; offset += 1) {
        const before = nodes[index - offset];
        if (isPlausibleJobTitle(before)) return before;
      }
    }
    const joined = clean(nodes.join(" "));
    const match = joined.match(/([\u4e00-\u9fa5A-Za-z0-9+·（）()\-]{2,32})\s+\d+\s*-\s*\d+\s*K/);
    if (match && isPlausibleJobTitle(match[1])) return clean(match[1]);
    const looseMatch = joined.match(/([\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9+·（）()\-]{1,31})\s+\d+\s*-\s*\d+\s*K/);
    return looseMatch ? clean(looseMatch[1]) : "";
  }

  function isPlausibleJobTitle(text) {
    if (!text || text.length < 2 || text.length > 60) return false;
    if (/职位|岗位|公司|薪资|简历|沟通|招聘者|招聘经理|HRBP|人事$/.test(text) && text.length <= 6) return false;
    if (/^[\d\s\-~薪资待遇面议Kk]+$/.test(text)) return false;
    return /运营|产品|销售|市场|经理|主管|专家|专员|店长|商务|BD|策划|分析|开发|客服|客户成功|IP|中台|项目|助理|总助|秘书|总监|负责人|合伙人|顾问|咨询|行政|财务|会计|出纳|投放|编辑|内容|文案|设计|增长|用户|岗/.test(text);
  }

  function inferJobTitleFromMessage(text) {
    const source = clean(text);
    const patterns = [
      /(?:诚聘|招聘|正在招聘|在招)([^，。,.~！!？?]{2,40}?)(?:岗位|职位|一职|，|。|,|~|吗|$)/,
      /([^，。,.~！!？?]{2,40}?)(?:岗位|职位|一职)(?:，|。|,|~|吗|$)/,
      /我在找([^，。,.~！!？?]{2,30}?岗)(?:。|，|,|~|吗|$)/
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match && isPlausibleJobTitle(match[1])) return clean(match[1]);
    }
    return "";
  }

  function renderChatToolbar(context) {
    const missing = [];
    if (!context.companyName) missing.push("公司");
    if (!context.jobTitle) missing.push("职位");
    if (!context.hrName) missing.push("HR");
    const record = context.chatKey && store.chatThreads[context.chatKey]
      ? store.chatThreads[context.chatKey]
      : findBestChatThreadForListFields(context);
    const authoritativeStatus = getAuthoritativeChatStatus(context, record);
    const status = context.complete ? STATUS[authoritativeStatus] || STATUS.unmarked : null;
    const summary = context.complete
      ? `${record || authoritativeStatus !== "unmarked" ? status.label : "未记录"}`
      : `缺 ${missing.join("、")}`;

    return `
      <div class="bjnr-chat-toolbar-main">
        <span class="bjnr-chat-summary" data-tone="${escapeHtml(status ? status.tone : context.complete ? "fresh" : "exclude")}">${escapeHtml(summary)}</span>
      </div>
      <div class="bjnr-chat-toolbar-actions">
        ${chatStatusButton("已读未回", "read_no_reply", authoritativeStatus === "read_no_reply")}
        ${chatStatusButton("未读未回", "waiting", authoritativeStatus === "waiting")}
        ${chatStatusButton("已沟通", "communicated", authoritativeStatus === "communicated")}
        ${chatStatusButton("已发简历", "resume_sent", authoritativeStatus === "resume_sent")}
        ${chatStatusButton("面试", "interview", authoritativeStatus === "interview")}
        ${chatStatusButton("被拒绝", "rejected", authoritativeStatus === "rejected")}
        ${chatStatusButton("不合适", "unsuitable", authoritativeStatus === "unsuitable")}
        ${chatStatusButton("稍后看", "later", authoritativeStatus === "later")}
      </div>
    `;
  }

  function getAuthoritativeChatStatus(context, record) {
    const matched = context && context.matchedJobs && context.matchedJobs[0];
    const job = matched && matched.jobKey ? store.jobs[matched.jobKey] : null;
    const jobStatus = job && job.status || matched && matched.status || "";
    if (jobStatus && jobStatus !== "unmarked") return jobStatus;
    return record && record.status || "unmarked";
  }

  function chatStatusButton(label, status, active) {
    return `<button type="button" class="${active ? "is-active" : ""}" data-bjnr-chat-status="${escapeHtml(status)}">${escapeHtml(label)}</button>`;
  }

  async function applyChatStatus(context, status, silent) {
    const completed = { ...context };
    const stableRecord = findBestChatThreadForListFields(completed);
    if (!completed.jobTitle && stableRecord && stableRecord.jobTitle) completed.jobTitle = stableRecord.jobTitle;
    completed.chatKey = getChatKey(completed);
    completed.complete = Boolean(completed.chatKey);
    completed.matchedJobs = completed.complete ? findStrongMatchedJobs(completed) : [];
    if (!completed.complete) {
      const missing = [];
      if (!completed.companyName) missing.push("公司");
      if (!completed.jobTitle) missing.push("职位");
      if (!completed.hrName) missing.push("HR");
      window.alert(`未识别到${missing.join("、")}，无法保存。请先确认右侧聊天框已加载完整。`);
      return;
    }

    const now = new Date().toISOString();
    const job = upsertChatLinkedJob(completed, status, now);
    const existing = store.chatThreads[completed.chatKey] || {};
    const oldStableKey = stableRecord && stableRecord.chatKey && stableRecord.chatKey !== completed.chatKey ? stableRecord.chatKey : "";
    const thread = {
      ...existing,
      chatKey: completed.chatKey,
      stableChatKey: getStableChatKey(completed),
      jobKey: job.jobKey,
      companyKey: job.companyKey,
      companyName: completed.companyName,
      jobTitle: completed.jobTitle,
      hrName: completed.hrName,
      hrTitle: completed.hrTitle || "",
      messageStatus: completed.messageStatus || "",
      lastMessage: completed.lastMessage || "",
      status,
      firstSeenAt: existing.firstSeenAt || now,
      lastMarkedAt: now,
      updatedAt: now
    };
    applyStatusTimestamps(thread, status, now);
    store.chatThreads[completed.chatKey] = {
      ...thread
    };
    if (oldStableKey) delete store.chatThreads[oldStableKey];
    pushEvent("chat", completed.chatKey, "status_changed", existing.status || "unmarked", status);
    refreshCompanyCounts();
    await saveStore();
    decorateChatListItems();
    mountChatDetailToolbar();
    scheduleScan(20);
  }

  function upsertChatLinkedJob(context, status, now) {
    const companyKey = `company:${hash(context.companyName)}`;
    const matched = findStrongMatchedJobs(context)[0];
    const jobKey = matched ? matched.jobKey : `chat-job:${hash([context.companyName, context.jobTitle, context.hrName].join("|"))}`;
    const existing = store.jobs[jobKey] || {};

    const nextJob = {
      ...existing,
      jobKey,
      companyKey,
      companyName: context.companyName,
      jobTitle: context.jobTitle,
      locationText: existing.locationText || "",
      salary: existing.salary || "",
      tags: existing.tags || [],
      url: existing.url || "",
      status,
      note: existing.note || "",
      hrName: context.hrName,
      firstSeenAt: existing.firstSeenAt || now,
      lastSeenAt: now,
      lastMarkedAt: now,
      seenCount: existing.seenCount || 0,
      source: existing.source || (matched ? "job-list" : "chat")
    };
    applyStatusTimestamps(nextJob, status, now);
    store.jobs[jobKey] = nextJob;

    const company = store.companies[companyKey] || {};
    store.companies[companyKey] = {
      companyKey,
      companyName: context.companyName,
      status: company.status || "normal",
      note: company.note || "",
      firstSeenAt: company.firstSeenAt || now,
      lastSeenAt: now,
      lastMarkedAt: company.lastMarkedAt || "",
      jobCount: company.jobCount || 0,
      communicatedCount: company.communicatedCount || 0,
      rejectedCount: company.rejectedCount || 0
    };

    return store.jobs[jobKey];
  }

  function getChatKey(fields) {
    if (!fields || !clean(fields.companyName) || !clean(fields.jobTitle) || !clean(fields.hrName)) return "";
    return `chat:${hash([clean(fields.companyName), normalizeJobTitleForMatch(fields.jobTitle), clean(fields.hrName)].join("|"))}`;
  }

  function getStableChatKey(fields) {
    if (!fields || !clean(fields.companyName) || !clean(fields.hrName)) return "";
    return `chat-stable:${hash([clean(fields.companyName), clean(fields.hrName)].join("|"))}`;
  }

  function findStrongMatchedJobs(fields) {
    if (!fields || !fields.companyName || !fields.jobTitle || !fields.hrName) return [];
    return Object.values(store.jobs || {})
      .filter((job) => isSameOrRelatedCompany(job.companyName, fields.companyName))
      .filter((job) => isSameOrRelatedJobTitle(job.jobTitle, fields.jobTitle))
      .map((job) => ({
        score: scoreJobMatch(job, fields),
        jobKey: job.jobKey,
        companyKey: job.companyKey,
        companyName: job.companyName,
        jobTitle: job.jobTitle,
        hrName: job.hrName,
        status: job.status,
        note: job.note
      }))
      .sort((a, b) => b.score - a.score);
  }

  function scoreJobMatch(job, fields) {
    let score = job.jobTitle === fields.jobTitle ? 40 : 24;
    if (normalizeJobTitleForMatch(job.jobTitle) === normalizeJobTitleForMatch(fields.jobTitle)) score += 8;
    if (job.companyName === fields.companyName) score += 8;
    if (job.hrName === fields.hrName) score += 10;
    if (!job.hrName) score += 2;
    return score;
  }

  function isChatPage() {
    return location.pathname.includes("/web/geek/chat");
  }

  function buildChatReport() {
    const candidates = findChatCandidateBlocks().slice(0, 40).map((node, index) => inspectChatBlock(node, index));
    const detailRoot = findChatDetailRoot();
    const currentDetail = detailRoot ? {
      selector: selectorFor(detailRoot, document.body || document.documentElement),
      textPreview: clean(detailRoot.textContent).slice(0, 1200),
      guessed: extractCurrentChatContext(detailRoot),
      textNodes: visibleTextNodes(detailRoot).slice(0, 80).map((item) => ({
        text: item.text,
        selector: selectorFor(item.element, detailRoot),
        className: String(item.element.className || "").slice(0, 160)
      }))
    } : null;
    const pageText = clean(document.body && document.body.textContent).slice(0, 2000);
    const currentChat = guessCurrentChat(candidates, pageText);
    const matches = matchChatTextToJobs([
      pageText,
      currentChat.textPreview,
      ...candidates.slice(0, 8).map((candidate) => candidate.textPreview)
    ].join(" "), currentChat.guessed);

    return {
      type: "boss-chat-page-report",
      url: location.href,
      title: document.title,
      createdAt: new Date().toISOString(),
      counts: {
        candidates: candidates.length,
        storedJobs: Object.keys(store.jobs || {}).length,
        storedCompanies: Object.keys(store.companies || {}).length,
        storedChatThreads: Object.keys(store.chatThreads || {}).length
      },
      currentChat,
      currentDetail,
      candidates,
      matches,
      chatRecords: candidates.map((candidate) => ({
        index: candidate.index,
        selector: candidate.selector,
        companyName: candidate.guessed.companyName,
        hrName: candidate.guessed.hrName,
        hrTitle: candidate.guessed.hrTitle,
        messageStatus: candidate.guessed.messageStatus,
        lastMessage: candidate.guessed.lastMessage,
        matchedJobs: candidate.matchedJobs
      })),
      storedRecordSamples: Object.values(store.jobs || {}).slice(0, 20).map((job) => ({
        jobKey: job.jobKey,
        companyName: job.companyName,
        jobTitle: job.jobTitle,
        hrName: job.hrName,
        status: job.status,
        note: job.note
      }))
    };
  }

  function findChatCandidateBlocks() {
    const selectors = [
      "li",
      "[class*='chat']",
      "[class*='conversation']",
      "[class*='dialog']",
      "[class*='friend']",
      "[class*='message']",
      "[class*='item']"
    ].join(",");

    const nodes = Array.from(document.querySelectorAll(selectors))
      .filter((node) => node instanceof HTMLElement)
      .filter((node) => !node.closest(`#${ROOT_ID}`))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 24) return false;
        const text = clean(node.textContent);
        if (text.length < 6 || text.length > 1200) return false;
        return scoreChatBlockText(text, node.className) > 0;
      })
      .sort((a, b) => scoreChatBlockText(clean(b.textContent), b.className) - scoreChatBlockText(clean(a.textContent), a.className));

    return uniqueOuterElements(nodes).slice(0, 60);
  }

  function uniqueOuterElements(nodes) {
    const result = [];
    nodes.forEach((node) => {
      if (result.some((kept) => kept.contains(node))) return;
      for (let index = result.length - 1; index >= 0; index -= 1) {
        if (node.contains(result[index])) result.splice(index, 1);
      }
      result.push(node);
    });
    return result;
  }

  function scoreChatBlockText(text, className) {
    let score = 0;
    const classes = String(className || "").toLowerCase();
    if (/chat|conversation|dialog|friend|message|item|geek|boss/.test(classes)) score += 2;
    if (/已读|未读|送达|在线|沟通|职位|招聘|HR|BOSS|回复|对方|发来|简历/.test(text)) score += 3;
    if (/K|薪|年|本科|大专|公司|科技|信息|有限|集团|经理|运营|产品|销售|开发/.test(text)) score += 2;
    if (text.length > 20 && text.length < 500) score += 1;
    return score;
  }

  function inspectChatBlock(node, index) {
    const textNodes = visibleTextNodes(node).slice(0, 80);
    const textPreview = clean(node.textContent).slice(0, 700);
    const guessed = guessChatFields(textPreview, textNodes);
    return {
      index,
      tag: node.tagName ? node.tagName.toLowerCase() : "",
      className: String(node.className || "").slice(0, 240),
      selector: selectorFor(node, document.body || document.documentElement),
      textPreview,
      guessed,
      matchedJobs: matchChatTextToJobs(textPreview, guessed).slice(0, 5),
      textNodes: textNodes.map((item) => ({
        text: item.text,
        selector: selectorFor(item.element, node),
        className: String(item.element.className || "").slice(0, 160)
      }))
    };
  }

  function visibleTextNodes(root) {
    const result = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (!(node instanceof HTMLElement)) return NodeFilter.FILTER_SKIP;
        if (node.closest(`#${ROOT_ID}`)) return NodeFilter.FILTER_REJECT;
        if (node.closest(".bjnr-mount, .bjnr-hidden-strip, .bjnr-chat-toolbar")) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return NodeFilter.FILTER_REJECT;
        if (node.children.length > 0) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node = walker.nextNode();
    while (node) {
      const text = clean(node.textContent);
      if (text) result.push({ element: node, text: text.slice(0, 140) });
      node = walker.nextNode();
    }
    return result;
  }

  function guessCurrentChat(candidates, pageText) {
    const likely = candidates.find((candidate) => /职位|岗位|招聘|已读|未读|在线|简历|沟通/.test(candidate.textPreview)) || candidates[0] || {};
    return {
      textPreview: likely.textPreview || pageText.slice(0, 900),
      guessed: likely.guessed || guessChatFields(pageText, []),
      matchedJobs: likely.matchedJobs || matchChatTextToJobs(pageText, likely.guessed).slice(0, 5)
    };
  }

  function guessChatFields(text, textNodes) {
    const nodeTexts = textNodes.map((item) => item.text);
    const combined = clean([text, ...nodeTexts].join(" "));
    const structured = parseChatFieldsFromTextNodes(textNodes);
    const companyName = structured.companyName || findBestKnownCompany(combined);
    return {
      ...structured,
      companyName,
      jobTitle: findBestKnownJob(combined, companyName),
      hrName: structured.hrName || guessHrName(combined),
      messageStatus: structured.messageStatus || guessMessageStatus(combined)
    };
  }

  function parseChatFieldsFromTextNodes(textNodes) {
    const nodes = textNodes.map((item) => ({
      text: clean(item.text),
      className: String(item.element && item.element.className || "")
    })).filter((item) => item.text);
    const nameIndex = nodes.findIndex((item) => item.className.split(/\s+/).includes("name-text"));
    const statusNode = nodes.find((item) => item.className.includes("message-status") || /^\[(已读|送达|未读)\]$/.test(item.text));
    const lastMessageNode = nodes.find((item) => item.className.includes("last-msg-text"));

    const result = {
      timeText: (nodes.find((item) => item.className.split(/\s+/).includes("time")) || {}).text || "",
      hrName: nameIndex >= 0 ? nodes[nameIndex].text : "",
      companyName: "",
      hrTitle: "",
      lastMessage: lastMessageNode ? lastMessageNode.text : "",
      messageStatus: statusNode ? normalizeMessageStatus(statusNode.text, statusNode.className) : ""
    };

    if (nameIndex >= 0) {
      const company = nodes[nameIndex + 1];
      const title = nodes[nameIndex + 2];
      if (company && !isChatMetaText(company.text, company.className)) result.companyName = company.text;
      if (title && !isChatMetaText(title.text, title.className)) result.hrTitle = title.text;
    }

    return result;
  }

  function isChatMetaText(text, className) {
    return className.includes("message-status") || className.includes("last-msg-text") || /^\[(已读|送达|未读|.+)\]$/.test(text);
  }

  function normalizeMessageStatus(text, className) {
    if (className.includes("status-read") || text.includes("已读")) return "read_no_reply";
    if (className.includes("status-delivery") || text.includes("送达")) return "waiting";
    if (text.includes("未读")) return "unread_candidate";
    return "";
  }

  function findBestKnownCompany(text) {
    const companies = Object.values(store.companies || {})
      .map((company) => company.companyName)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    return companies.find((companyName) => text.includes(companyName)) || "";
  }

  function findBestKnownJob(text, companyName) {
    const jobs = Object.values(store.jobs || {})
      .filter((job) => !companyName || job.companyName === companyName)
      .map((job) => job.jobTitle)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    return jobs.find((jobTitle) => text.includes(jobTitle)) || "";
  }

  function guessHrName(text) {
    const match = text.match(/([\u4e00-\u9fa5]{1,3}(先生|女士|经理|主管|HR|招聘))/);
    return match ? match[1] : "";
  }

  function guessMessageStatus(text) {
    if (/已读/.test(text) && !/回复|收到回复|对方回复/.test(text)) return "read_no_reply";
    if (/未读/.test(text)) return "unread_candidate";
    if (/送达/.test(text)) return "waiting";
    return "";
  }

  function matchChatTextToJobs(text, fields) {
    const source = clean(text);
    const context = fields || {};
    const completed = {
      companyName: context.companyName || findBestKnownCompany(source),
      jobTitle: context.jobTitle || findBestKnownJob(source, context.companyName),
      hrName: context.hrName || ""
    };
    if (!completed.companyName || !completed.jobTitle || !completed.hrName) return [];
    return findStrongMatchedJobs(completed).slice(0, 12);
  }

  async function copyChatReport() {
    const ok = await copyText(JSON.stringify(buildChatReport(), null, 2));
    window.alert(ok ? "消息页 JSON 已复制。" : "复制失败，请改用下载消息 JSON。");
  }

  function downloadChatReport() {
    const report = buildChatReport();
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `boss-chat-dom-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function outlineChatCandidates() {
    document.querySelectorAll(".bjnr-chat-outline").forEach((node) => node.classList.remove("bjnr-chat-outline"));
    findChatCandidateBlocks().slice(0, 20).forEach((node) => node.classList.add("bjnr-chat-outline"));
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall back below.
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand("copy");
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function selectorFor(element, scope) {
    if (!element || element === scope) return "";
    const parts = [];
    let node = element;
    while (node && node !== scope && parts.length < 5) {
      const tag = node.tagName ? node.tagName.toLowerCase() : "";
      if (!tag) break;
      const className = Array.from(node.classList || [])
        .filter((name) => !name.startsWith("bjnr"))
        .slice(0, 3)
        .join(".");
      const nth = node.parentElement ? nthOfType(node) : "";
      parts.unshift(`${tag}${className ? `.${className}` : ""}${nth}`);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function nthOfType(node) {
    if (!node.parentElement) return "";
    const siblings = Array.from(node.parentElement.children).filter((item) => item.tagName === node.tagName);
    if (siblings.length <= 1) return "";
    return `:nth-of-type(${siblings.indexOf(node) + 1})`;
  }

  function mountPanel() {
    if (!store) return;
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.attachShadow({ mode: "open" });
      document.documentElement.appendChild(root);
    }

    const shadow = root.shadowRoot;
    const stats = getStats();
    const panelSignature = stableRecordSnapshot({
      stats,
      settings: store.settings,
      version: EXTENSION_VERSION
    });
    if (panelSignature === lastPanelSignature && shadow.querySelector(".panel")) return;
    lastPanelSignature = panelSignature;
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          font-family: "Avenir Next", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
          color-scheme: light;
        }
        .panel {
          width: ${store.settings.showPanel ? "280px" : "auto"};
          border: 1px solid #b9aa9a;
          border-radius: 8px;
          background: #fffaf2;
          color: #171a18;
          box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
          overflow: hidden;
        }
        .collapsed {
          padding: 0;
          border-color: #0f766e;
          background: #0f766e;
        }
        .tab {
          height: 34px;
          padding: 0 10px;
          border: 0;
          background: #0f766e;
          color: #ecfeff;
          font: 850 12px/34px "Avenir Next", "PingFang SC", sans-serif;
          cursor: pointer;
        }
        .head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          padding: 10px 11px;
          background: #0f766e;
          color: #ecfeff;
          font-size: 13px;
          font-weight: 850;
        }
        button {
          height: 27px;
          padding: 0 8px;
          border: 1px solid #b9aa9a;
          border-radius: 6px;
          background: #fffaf2;
          color: #171a18;
          font: 800 12px/25px "Avenir Next", "PingFang SC", sans-serif;
          cursor: pointer;
        }
        .body {
          display: grid;
          gap: 10px;
          padding: 10px 11px 11px;
          font-size: 12px;
        }
        .stats {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 6px;
        }
        .stats.stats-flow {
          grid-template-columns: repeat(3, 1fr);
        }
        .stat {
          padding: 7px 5px;
          border: 1px solid #ddd0c2;
          border-radius: 7px;
          background: #f8efe5;
          text-align: center;
        }
        .stat b {
          display: block;
          font-size: 17px;
          line-height: 1;
        }
        .stat span {
          display: block;
          margin-top: 5px;
          color: #6b625a;
          font-size: 11px;
          white-space: nowrap;
        }
        label {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          color: #4d443d;
        }
        .tools {
          display: flex;
          gap: 7px;
          flex-wrap: wrap;
        }
        .chat-tools {
          display: grid;
          gap: 6px;
          padding: 8px;
          border: 1px solid #d7eee8;
          border-radius: 7px;
          background: #f0fdfa;
          color: #134e4a;
        }
        .chat-tools strong {
          font-size: 12px;
        }
        .chat-tools span {
          color: #47635f;
          line-height: 1.45;
        }
        .note {
          color: #6b625a;
          line-height: 1.45;
        }
      </style>
      <section class="panel ${store.settings.showPanel ? "" : "collapsed"}">
        ${store.settings.showPanel ? `
          <div class="head">
            <span>求职降噪助手 V${EXTENSION_VERSION}</span>
            <button type="button" data-panel-action="collapse">收起</button>
          </div>
          <div class="body">
            <div class="stats">
              <div class="stat"><b>${stats.total}</b><span>记录</span></div>
              <div class="stat"><b>${stats.communicated}</b><span>沟通</span></div>
              <div class="stat"><b>${stats.excluded}</b><span>排除</span></div>
              <div class="stat"><b>${stats.blocked}</b><span>屏蔽</span></div>
            </div>
            <div class="stats stats-flow">
              <div class="stat"><b>${stats.today.communicated}</b><span>今日沟通</span></div>
              <div class="stat"><b>${stats.today.resumeSent}</b><span>今日简历</span></div>
              <div class="stat"><b>${stats.today.interview}</b><span>今日面试</span></div>
            </div>
            <div class="stats stats-flow">
              <div class="stat"><b>${stats.week.communicated}</b><span>本周沟通</span></div>
              <div class="stat"><b>${stats.week.resumeSent}</b><span>本周简历</span></div>
              <div class="stat"><b>${stats.week.interview}</b><span>本周面试</span></div>
            </div>
            <label><span>隐藏排除态职位</span><input type="checkbox" data-setting="hideExcluded" ${store.settings.hideExcluded ? "checked" : ""}></label>
            <label><span>自动隐藏僵尸职位</span><input type="checkbox" data-setting="hideZombie" ${store.settings.hideZombie ? "checked" : ""}></label>
            <label><span>弱化已沟通职位</span><input type="checkbox" data-setting="dimCommunicated" ${store.settings.dimCommunicated ? "checked" : ""}></label>
            <div class="tools">
              <button type="button" data-panel-action="dashboard">打开数据面板</button>
              <button type="button" data-panel-action="export">导出记录</button>
              <button type="button" data-panel-action="import">导入记录</button>
              <button type="button" data-panel-action="page-report">导出页面信息</button>
              <button type="button" data-panel-action="rescan">重新扫描</button>
            </div>
            <div class="note">只做本地标记；不请求接口、不自动翻页。</div>
          </div>
        ` : `<button class="tab" type="button" data-panel-action="expand">求职降噪 · ${stats.excluded} 已排除</button>`}
      </section>
    `;

    shadow.querySelectorAll("[data-setting]").forEach((input) => {
      input.addEventListener("change", async () => {
        store.settings[input.dataset.setting] = input.checked;
        await saveStore();
        scheduleScan(20);
      });
    });

    shadow.querySelectorAll("[data-panel-action]").forEach((button) => {
      button.addEventListener("pointerdown", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const action = button.dataset.panelAction;
        if (action === "collapse") {
          store.settings.showPanel = false;
          await saveStore();
        }
        if (action === "expand") {
          store.settings.showPanel = true;
          await saveStore();
        }
        if (action === "dashboard") openDashboard();
        if (action === "rescan") scheduleScan(20);
        if (action === "export") exportRecords();
        if (action === "import") importRecords();
        if (action === "page-report") downloadPageProbeReport();
      });
    });
  }

  function openDashboard() {
    const url = hasExtensionContext() && chrome.runtime.getURL
      ? chrome.runtime.getURL("dashboard.html")
      : "";
    if (!url) return;
    window.open(url, "_blank", "noopener");
  }

  function getStats() {
    const jobs = Object.values(store.jobs);
    const companies = Object.values(store.companies);
    return {
      total: jobs.length,
      communicated: jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length,
      excluded: jobs.filter((job) => EXCLUDED_JOB_STATUSES.has(job.status)).length,
      blocked: companies.filter((company) => company.status === "blocked").length,
      today: getPeriodStats(jobs, "today"),
      week: getPeriodStats(jobs, "week")
    };
  }

  function getPeriodStats(jobs, period) {
    return {
      communicated: jobs.filter((job) => isInPeriod(job.firstCommunicatedAt, period)).length,
      resumeSent: jobs.filter((job) => isInPeriod(job.resumeSentAt, period)).length,
      interview: jobs.filter((job) => isInPeriod(job.interviewAt, period)).length
    };
  }

  function isInPeriod(value, period) {
    if (!value) return false;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return false;
    const now = new Date();
    if (period === "today") {
      return date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
    }
    if (period === "week") {
      const start = startOfLocalWeek(now);
      return date >= start && date <= now;
    }
    return false;
  }

  function startOfLocalWeek(date) {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = start.getDay() || 7;
    start.setDate(start.getDate() - day + 1);
    start.setHours(0, 0, 0, 0);
    return start;
  }

  function exportRecords() {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `boss-job-records-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function downloadPageProbeReport() {
    const report = buildPageProbeReport();
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `boss-page-probe-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function buildPageProbeReport() {
    const chatRoot = isChatPage() ? findChatDetailRoot() : null;
    const chatContext = chatRoot ? extractCurrentChatContext(chatRoot) : null;
    const activeCard = document.querySelector("li.job-card-box.bjnr-card") || document.querySelector("li.job-card-box");
    const parsedActiveJob = activeCard ? parseJobCard(activeCard) : null;
    const parsedDetailJob = parseJobDetailPage();
    const links = collectProbeLinks(document).slice(0, 160);
    const chatLinks = chatRoot ? collectProbeLinks(chatRoot).slice(0, 80) : [];
    const attributes = collectProbeAttributes(document).slice(0, 240);
    const chatAttributes = chatRoot ? collectProbeAttributes(chatRoot).slice(0, 160) : [];
    const jobIds = uniqueStrings([
      ...links.map((item) => item.jobId),
      ...chatLinks.map((item) => item.jobId),
      ...attributes.map((item) => item.jobId),
      ...chatAttributes.map((item) => item.jobId),
      extractJobId(location.href),
      parsedActiveJob && extractJobId(parsedActiveJob.url)
    ].filter(Boolean));

    return {
      type: "boss-page-probe",
      url: location.href,
      title: document.title,
      createdAt: new Date().toISOString(),
      isChatPage: isChatPage(),
      activeJobDetailUrl: getActiveJobDetailUrl(),
      activeJobId: extractJobId(getActiveJobDetailUrl()) || extractJobId(location.href),
      jobIds,
      chatContext,
      parsedActiveJob,
      parsedDetailJob,
      chatDetail: chatRoot ? {
        selector: selectorFor(chatRoot, document.body || document.documentElement),
        textPreview: clean(chatRoot.textContent).slice(0, 1600),
        links: chatLinks,
        attributes: chatAttributes
      } : null,
      pageLinks: links,
      pageAttributes: attributes,
      storedMatches: chatContext && chatContext.companyName ? {
        byCompany: Object.values(store.jobs || {})
          .filter((job) => job.companyName === chatContext.companyName)
          .slice(0, 20)
          .map((job) => ({
            jobKey: job.jobKey,
            jobTitle: job.jobTitle,
            companyName: job.companyName,
            hrName: job.hrName,
            url: job.url,
            status: job.status
          }))
      } : null
    };
  }

  function collectProbeLinks(scope) {
    return Array.from(scope.querySelectorAll("a[href]"))
      .filter((node) => !node.closest(`#${ROOT_ID}`))
      .map((node) => {
        const href = node.getAttribute("href") || "";
        const url = resolveUrl(href);
        return {
          text: clean(node.textContent).slice(0, 120),
          href,
          url,
          jobId: extractJobId(url || href),
          selector: selectorFor(node, scope === document ? document.body || document.documentElement : scope)
        };
      })
      .filter((item) => item.jobId || /职位|岗位|查看|job|detail/i.test([item.text, item.href, item.url].join(" ")));
  }

  function collectProbeAttributes(scope) {
    const result = [];
    const nodes = Array.from(scope.querySelectorAll("*"))
      .filter((node) => !node.closest(`#${ROOT_ID}`))
      .slice(0, 4000);
    nodes.forEach((node) => {
      Array.from(node.attributes || []).forEach((attr) => {
        const pair = `${attr.name}=${attr.value}`;
        if (!/(job|position|security|encrypt|href|url|link|lid|id)/i.test(pair)) return;
        const value = String(attr.value || "");
        result.push({
          tag: node.tagName ? node.tagName.toLowerCase() : "",
          attr: attr.name,
          value: value.slice(0, 240),
          jobId: extractJobId(value),
          text: clean(node.textContent).slice(0, 100),
          selector: selectorFor(node, scope === document ? document.body || document.documentElement : scope)
        });
      });
    });
    return result;
  }

  function uniqueStrings(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function importRecords() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const imported = normalizeImportedStore(JSON.parse(String(reader.result || "{}")));
          store.jobs = { ...store.jobs, ...imported.jobs };
          store.companies = { ...store.companies, ...imported.companies };
          store.chatThreads = { ...store.chatThreads, ...imported.chatThreads };
          store.events = [...store.events, ...imported.events].slice(-400);
          store.settings = { ...store.settings, ...(imported.settings || {}) };
          refreshCompanyCounts();
          await saveStore();
          scheduleScan(20);
          window.alert("导入完成。");
        } catch (error) {
          window.alert("导入失败：文件格式不正确。");
          console.warn("[BOSS 求职降噪助手] import failed", error);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  function normalizeImportedStore(value) {
    const raw = value && typeof value === "object" ? value : {};
    return {
      jobs: raw.jobs && typeof raw.jobs === "object" ? raw.jobs : {},
      companies: raw.companies && typeof raw.companies === "object" ? raw.companies : {},
      chatThreads: raw.chatThreads && typeof raw.chatThreads === "object" ? raw.chatThreads : {},
      events: Array.isArray(raw.events) ? raw.events : [],
      settings: raw.settings && typeof raw.settings === "object" ? raw.settings : {}
    };
  }

  function injectPageStyles() {
    if (document.getElementById(PAGE_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PAGE_STYLE_ID;
    style.textContent = `
      .bjnr-card {
        border-left: 4px solid transparent !important;
      }
      .bjnr-card.bjnr-dim {
        opacity: 0.72 !important;
        border-left-color: #a76513 !important;
      }
      .bjnr-card.bjnr-keep {
        border-left-color: #315f86 !important;
      }
      .bjnr-card.bjnr-excluded {
        border-left-color: #8a5a44 !important;
        background: #fff7f1 !important;
      }
      .bjnr-mount {
        display: grid !important;
        gap: 7px !important;
        margin-top: 9px !important;
        padding-top: 9px !important;
        border-top: 1px solid rgba(96, 77, 57, 0.16) !important;
        font-family: "Avenir Next", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif !important;
      }
      .bjnr-memory,
      .bjnr-actions {
        display: flex !important;
        flex-wrap: wrap !important;
        gap: 6px !important;
        align-items: center !important;
      }
      .bjnr-chip {
        display: inline-flex !important;
        align-items: center !important;
        min-height: 23px !important;
        padding: 3px 7px !important;
        border: 1px solid #d6cabd !important;
        border-radius: 999px !important;
        background: #fffaf2 !important;
        color: #3a332b !important;
        font-size: 12px !important;
        font-weight: 800 !important;
        line-height: 1.2 !important;
        white-space: nowrap !important;
      }
      .bjnr-chip-warm {
        border-color: #dfc38d !important;
        background: #f5e5c5 !important;
        color: #71460f !important;
      }
      .bjnr-chip-keep,
      .bjnr-chip-fresh {
        border-color: #abc7d8 !important;
        background: #e5f0f5 !important;
        color: #274e69 !important;
      }
      .bjnr-chip-exclude {
        border-color: #d9b7a4 !important;
        background: #f4dfd2 !important;
        color: #70432f !important;
      }
      .bjnr-action {
        height: 27px !important;
        padding: 0 8px !important;
        border: 1px solid #cfc2b4 !important;
        border-radius: 6px !important;
        background: #fffaf2 !important;
        color: #25211c !important;
        font-size: 12px !important;
        font-weight: 800 !important;
        line-height: 25px !important;
        cursor: pointer !important;
        box-shadow: none !important;
      }
      .bjnr-action:hover {
        border-color: #3a332b !important;
        background: #f0e5d8 !important;
      }
      .bjnr-action.is-active {
        border-color: #0f766e !important;
        background: #0f766e !important;
        color: #ecfeff !important;
      }
      .bjnr-action-exclude {
        border-color: #d0aa94 !important;
        background: #fff4ed !important;
        color: #70432f !important;
      }
      .bjnr-action-keep {
        border-color: #abc7d8 !important;
        background: #f0f8fb !important;
        color: #274e69 !important;
      }
      .bjnr-action-plain {
        opacity: 0.72 !important;
      }
      .bjnr-open-chat-new-tab {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        min-width: 132px !important;
        height: 38px !important;
        margin-left: 10px !important;
        padding: 0 16px !important;
        border: 1px solid #0f766e !important;
        border-radius: 8px !important;
        background: #ffffff !important;
        color: #0f766e !important;
        font-family: "Avenir Next", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif !important;
        font-size: 14px !important;
        font-weight: 850 !important;
        line-height: 36px !important;
        white-space: nowrap !important;
        cursor: pointer !important;
        box-shadow: none !important;
        vertical-align: middle !important;
      }
      .bjnr-open-chat-new-tab:hover {
        background: #ecfeff !important;
        border-color: #0d9488 !important;
        color: #0f766e !important;
      }
      .bjnr-chat-toolbar {
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) auto !important;
        gap: 10px !important;
        align-items: center !important;
        margin: 0 0 10px !important;
        padding: 9px 10px !important;
        border: 1px solid #cce7e1 !important;
        border-radius: 8px !important;
        background: #f0fdfa !important;
        color: #134e4a !important;
        box-shadow: 0 8px 22px rgba(15, 23, 42, 0.08) !important;
        font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif !important;
        box-sizing: border-box !important;
      }
      .bjnr-chat-toolbar-main,
      .bjnr-chat-summary {
        display: grid !important;
        min-width: 0 !important;
      }
      .bjnr-chat-summary {
        width: fit-content !important;
        max-width: 180px !important;
        min-height: 28px !important;
        align-items: center !important;
        padding: 4px 9px !important;
        border: 1px solid #abc7d8 !important;
        border-radius: 999px !important;
        background: #e5f0f5 !important;
        color: #274e69 !important;
        font-size: 12px !important;
        font-weight: 850 !important;
        line-height: 18px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      .bjnr-chat-summary[data-tone="warm"] {
        border-color: #dfc38d !important;
        background: #f5e5c5 !important;
        color: #71460f !important;
      }
      .bjnr-chat-summary[data-tone="exclude"] {
        border-color: #d9b7a4 !important;
        background: #f4dfd2 !important;
        color: #70432f !important;
      }
      .bjnr-chat-toolbar-actions {
        display: flex !important;
        flex-wrap: wrap !important;
        gap: 6px !important;
        align-items: center !important;
      }
      .bjnr-chat-toolbar-actions {
        justify-content: flex-end !important;
      }
      .bjnr-chat-toolbar-actions button {
        height: 28px !important;
        padding: 0 8px !important;
        border: 1px solid #0f766e !important;
        border-radius: 6px !important;
        background: #ffffff !important;
        color: #0f766e !important;
        font-size: 12px !important;
        font-weight: 850 !important;
        cursor: pointer !important;
        white-space: nowrap !important;
      }
      .bjnr-chat-toolbar-actions button:hover {
        background: #ccfbf1 !important;
      }
      .bjnr-chat-toolbar-actions button.is-active {
        background: #0f766e !important;
        color: #ecfeff !important;
        border-color: #0f766e !important;
      }
      .bjnr-chat-list-item {
        position: relative !important;
        overflow: hidden !important;
      }
      .bjnr-chat-list-item::before {
        content: "" !important;
        position: absolute !important;
        left: 0 !important;
        top: 10px !important;
        bottom: 10px !important;
        width: 4px !important;
        border-radius: 0 999px 999px 0 !important;
        background: #abc7d8 !important;
        z-index: 2 !important;
      }
      .bjnr-chat-list-item[data-bjnr-chat-tone="warm"] {
        background: linear-gradient(90deg, rgba(245, 229, 197, 0.7), rgba(245, 229, 197, 0.18) 44%, transparent) !important;
      }
      .bjnr-chat-list-item[data-bjnr-chat-tone="warm"]::before {
        background: #b7791f !important;
      }
      .bjnr-chat-list-item[data-bjnr-chat-tone="keep"],
      .bjnr-chat-list-item[data-bjnr-chat-status="interview"] {
        background: linear-gradient(90deg, rgba(229, 240, 245, 0.86), rgba(229, 240, 245, 0.2) 44%, transparent) !important;
      }
      .bjnr-chat-list-item[data-bjnr-chat-tone="keep"]::before,
      .bjnr-chat-list-item[data-bjnr-chat-status="interview"]::before {
        background: #2f6f95 !important;
      }
      .bjnr-chat-list-item[data-bjnr-chat-tone="exclude"] {
        background: linear-gradient(90deg, rgba(244, 223, 210, 0.82), rgba(244, 223, 210, 0.18) 44%, transparent) !important;
      }
      .bjnr-chat-list-item[data-bjnr-chat-tone="exclude"]::before {
        background: #9a5a3f !important;
      }
      .bjnr-hidden-strip {
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) auto !important;
        gap: 10px !important;
        align-items: center !important;
        margin: 8px 0 !important;
        padding: 10px 12px !important;
        border: 1px dashed #c9ad9b !important;
        border-left: 4px solid #8a5a44 !important;
        border-radius: 8px !important;
        background: #fff6ef !important;
        color: #6b5a4c !important;
        font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif !important;
        font-size: 13px !important;
        box-sizing: border-box !important;
      }
      .bjnr-hidden-copy {
        display: flex !important;
        flex-wrap: wrap !important;
        gap: 8px !important;
        min-width: 0 !important;
      }
      .bjnr-hidden-copy strong {
        color: #25211c !important;
      }
      .bjnr-hidden-copy small {
        color: #70432f !important;
      }
      .bjnr-hidden-actions {
        display: flex !important;
        gap: 6px !important;
      }
      .bjnr-hidden-actions button {
        height: 27px !important;
        padding: 0 8px !important;
        border: 1px solid #c9ad9b !important;
        border-radius: 6px !important;
        background: #fffaf2 !important;
        color: #25211c !important;
        font-size: 12px !important;
        font-weight: 800 !important;
        cursor: pointer !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function stopNativeClick(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function stopPagePointer(event) {
    event.stopPropagation();
  }

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function truncate(value, limit) {
    const text = clean(value);
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  }

  function hash(input) {
    const text = String(input || "");
    let value = 5381;
    for (let index = 0; index < text.length; index += 1) {
      value = ((value << 5) + value) ^ text.charCodeAt(index);
    }
    return (value >>> 0).toString(36);
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/"/g, '\\"');
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
