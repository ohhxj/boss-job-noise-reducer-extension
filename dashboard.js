(() => {
  "use strict";

  const STORAGE_KEY = "boss_job_noise_reducer_v0";
  const EXCLUDED_STATUSES = ["unsuitable", "zombie", "later"];
  const PROCESS_STATUSES = ["waiting", "read_no_reply", "communicated", "resume_sent", "interview", "rejected"];
  const STATUS = {
    unmarked: { label: "未标记", tone: "neutral", timeFields: ["lastMarkedAt", "lastSeenAt"] },
    waiting: { label: "未读未回", tone: "warm", timeFields: ["firstDeliveredNoReplyAt", "lastDeliveredNoReplyAt", "firstCommunicatedAt", "lastMarkedAt"] },
    read_no_reply: { label: "已读未回", tone: "warm", timeFields: ["firstReadNoReplyAt", "lastReadNoReplyAt", "firstCommunicatedAt", "lastMarkedAt"] },
    communicated: { label: "已沟通", tone: "warm", timeFields: ["firstCommunicatedAt", "lastCommunicatedAt", "lastMarkedAt"] },
    resume_sent: { label: "已发简历", tone: "keep", timeFields: ["resumeSentAt", "lastResumeSentAt", "lastMarkedAt"] },
    rejected: { label: "被拒绝", tone: "exclude", timeFields: ["rejectedAt", "lastMarkedAt"] },
    unsuitable: { label: "不合适", tone: "exclude", timeFields: ["unsuitableAt", "lastMarkedAt"] },
    zombie: { label: "僵尸职位", tone: "exclude", timeFields: ["zombieDetectedAt", "lastMarkedAt"] },
    later: { label: "稍后看", tone: "keep", timeFields: ["laterAt", "lastMarkedAt"] },
    interview: { label: "面试", tone: "keep", timeFields: ["interviewAt", "lastInterviewAt", "lastMarkedAt"] }
  };
  const METRICS = {
    processed: { id: "processed", label: "总处理数", statuses: "processed", timeFields: ["firstProcessedAt", "lastProcessedAt", "lastMarkedAt"] },
    allJobs: { id: "allJobs", label: "全部职位", statuses: "all", timeFields: ["firstSeenAt", "lastSeenAt"] },
    waiting: { id: "waiting", label: "未读未回", statuses: ["waiting"] },
    read_no_reply: { id: "read_no_reply", label: "已读未回", statuses: ["read_no_reply"] },
    communicated: { id: "communicated", label: "已沟通", statuses: ["communicated"] },
    resume_sent: { id: "resume_sent", label: "已发简历", statuses: ["resume_sent"] },
    interview: { id: "interview", label: "面试", statuses: ["interview"] },
    rejected: { id: "rejected", label: "被拒绝", statuses: ["rejected"] },
    unsuitable: { id: "unsuitable", label: "不合适", statuses: ["unsuitable"] },
    later: { id: "later", label: "稍后看", statuses: ["later"] },
    zombie: { id: "zombie", label: "僵尸职位", statuses: ["zombie"] },
    blocked: { id: "blocked", label: "屏蔽公司", statuses: "blocked", timeFields: ["lastMarkedAt"] },
    unmarked: { id: "unmarked", label: "未处理", statuses: ["unmarked"], timeFields: ["firstSeenAt", "lastSeenAt"] }
  };
  const VIEW_METRICS = {
    process: ["processed", "waiting", "read_no_reply", "communicated", "resume_sent", "interview", "rejected"],
    excluded: ["unsuitable", "zombie", "later", "blocked"],
    all: ["allJobs", "processed", "unmarked", "waiting", "read_no_reply", "communicated", "resume_sent", "interview", "rejected", "unsuitable", "zombie", "later"]
  };

  let store = { jobs: {}, companies: {}, chatThreads: {}, events: [] };
  let rows = [];
  let activeMetric = "";

  const statsNode = document.getElementById("stats");
  const recordsBody = document.getElementById("recordsBody");
  const emptyState = document.getElementById("emptyState");
  const searchInput = document.getElementById("searchInput");
  const viewFilter = document.getElementById("viewFilter");
  const statusFilter = document.getElementById("statusFilter");
  const timeRange = document.getElementById("timeRange");
  const timeField = document.getElementById("timeField");
  const sortSelect = document.getElementById("sortSelect");
  const refreshButton = document.getElementById("refreshButton");
  const exportButton = document.getElementById("exportButton");

  init();

  async function init() {
    fillStatusOptions();
    bindEvents();
    bindStorageSync();
    await loadAndRender();
  }

  function bindEvents() {
    [searchInput, viewFilter, statusFilter, timeRange, timeField, sortSelect].forEach((node) => {
      node.addEventListener("input", () => {
        if (node === statusFilter) activeMetric = "";
        if (node === viewFilter) activeMetric = "";
        renderAll();
      });
      node.addEventListener("change", () => {
        if (node === statusFilter) activeMetric = "";
        if (node === viewFilter) activeMetric = "";
        renderAll();
      });
    });
    refreshButton.addEventListener("click", loadAndRender);
    exportButton.addEventListener("click", exportStore);
    statsNode.addEventListener("click", (event) => {
      const card = event.target.closest("[data-metric]");
      if (!card) return;
      const metric = card.dataset.metric;
      activeMetric = activeMetric === metric ? "" : metric;
      statusFilter.value = "all";
      renderAll();
    });
  }

  async function loadAndRender() {
    store = normalizeStore(await storageGet(STORAGE_KEY));
    rows = buildRows(store);
    renderAll();
  }

  function bindStorageSync() {
    if (!chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[STORAGE_KEY]) return;
      store = normalizeStore(changes[STORAGE_KEY].newValue);
      rows = buildRows(store);
      renderAll();
    });
  }

  function normalizeStore(raw) {
    return {
      jobs: raw && raw.jobs && typeof raw.jobs === "object" ? raw.jobs : {},
      companies: raw && raw.companies && typeof raw.companies === "object" ? raw.companies : {},
      chatThreads: raw && raw.chatThreads && typeof raw.chatThreads === "object" ? raw.chatThreads : {},
      events: raw && Array.isArray(raw.events) ? raw.events : [],
      settings: raw && raw.settings && typeof raw.settings === "object" ? raw.settings : {}
    };
  }

  function renderAll() {
    renderStats();
    renderRows();
  }

  function fillStatusOptions() {
    Object.entries(STATUS).forEach(([value, config]) => {
      if (value === "unmarked") return;
      const option = document.createElement("option");
      option.value = value;
      option.textContent = config.label;
      statusFilter.appendChild(option);
    });
  }

  function buildRows(rawStore) {
    const jobs = Object.values(rawStore.jobs || {});
    const mappedRows = jobs
      .filter((job) => job && (job.companyName || job.jobTitle || job.hrName))
      .map((job) => {
        const company = rawStore.companies && job.companyKey ? rawStore.companies[job.companyKey] : null;
        const chat = findChatForJob(rawStore, job);
        const status = chooseDisplayStatus(job, chat);
        const timeFields = mergeTimeFields(job, chat);
        const row = {
          ...job,
          ...timeFields,
          status,
          companyStatus: company && company.status || "normal",
          companyNote: company && company.note || "",
          hrName: job.hrName || chat && chat.hrName || "",
          hrTitle: job.hrTitle || chat && chat.hrTitle || "",
          lastMessage: chat && chat.lastMessage || "",
          hasChat: Boolean(chat),
          updatedAt: newestDate(job.lastMarkedAt, job.lastSeenAt, chat && (chat.updatedAt || chat.lastMarkedAt)),
          searchable: [
            job.companyName,
            job.jobTitle,
            job.hrName,
            job.hrTitle,
            job.salary,
            job.locationText,
            job.note,
            chat && chat.lastMessage
          ].filter(Boolean).join(" ").toLowerCase()
        };
        row.isProcessed = isProcessedRow(row);
        row.isExcluded = EXCLUDED_STATUSES.includes(row.status) || row.companyStatus === "blocked";
        return row;
      });
    return dedupeRows(mappedRows);
  }

  function isProcessedRow(row) {
    return PROCESS_STATUSES.includes(row.status);
  }

  function findChatForJob(rawStore, job) {
    return Object.values(rawStore.chatThreads || {})
      .map((chat) => ({ chat, score: scoreChatJobMatch(chat, job) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return String(b.chat.updatedAt || b.chat.lastMarkedAt || "").localeCompare(String(a.chat.updatedAt || a.chat.lastMarkedAt || ""));
      })[0]?.chat || null;
  }

  function scoreChatJobMatch(chat, job) {
    if (!chat || !job) return 0;
    if (chat.jobKey && job.jobKey && chat.jobKey === job.jobKey) return 120;
    const companyScore = scoreCompanyMatch(chat.companyName, job.companyName);
    if (!companyScore) return 0;
    const titleScore = scoreJobTitleMatch(chat.jobTitle, job.jobTitle);
    if (!titleScore) return 0;
    let score = companyScore + titleScore;
    if (chatHrMatches(chat, job.hrName)) score += 12;
    if (chat.status && chat.status !== "unmarked") score += 8;
    return score;
  }

  function scoreCompanyMatch(left, right) {
    if (!clean(left) || !clean(right)) return 0;
    if (clean(left) === clean(right)) return 44;
    const a = normalizeCompanyName(left);
    const b = normalizeCompanyName(right);
    if (!a || !b) return 0;
    if (a === b) return 36;
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    return short.length >= 3 && long.includes(short) ? 26 : 0;
  }

  function scoreJobTitleMatch(left, right) {
    const a = normalizeJobTitle(left);
    const b = normalizeJobTitle(right);
    if (!a || !b) return 0;
    if (a === b) return 44;
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    if (short.length >= 3 && long.includes(short) && short.length / long.length >= 0.6) return 24;
    const common = longestCommonChineseRun(a, b);
    return common >= 4 && common / long.length >= 0.6 ? 20 : 0;
  }

  function chatHrMatches(chat, hrName) {
    if (!hrName || !chat || !chat.hrName) return false;
    return clean(chat.hrName) === clean(hrName);
  }

  function chooseDisplayStatus(job, chat) {
    const jobStatus = job && job.status || "unmarked";
    const chatStatus = chat && chat.status || "";
    if (!chatStatus || chatStatus === "unmarked") return jobStatus;
    if (!jobStatus || jobStatus === "unmarked") return chatStatus;
    const jobTime = Date.parse(job.lastMarkedAt || job.updatedAt || job.lastSeenAt || "") || 0;
    const chatTime = Date.parse(chat.lastMarkedAt || chat.updatedAt || "") || 0;
    return chatTime >= jobTime ? chatStatus : jobStatus;
  }

  function dedupeRows(sourceRows) {
    const result = [];
    sourceRows.forEach((row) => {
      const index = result.findIndex((existing) => canMergeDashboardRows(existing, row));
      if (index >= 0) result[index] = mergeDashboardRows(result[index], row);
      else result.push(row);
    });
    return result;
  }

  function canMergeDashboardRows(left, right) {
    if (left.jobKey && right.jobKey && left.jobKey === right.jobKey) return true;
    if (!isSameOrRelatedCompany(left.companyName, right.companyName)) return false;
    if (!scoreJobTitleMatch(left.jobTitle, right.jobTitle)) return false;
    const leftHr = clean(left.hrName);
    const rightHr = clean(right.hrName);
    return !leftHr || !rightHr || leftHr === rightHr;
  }

  function mergeDashboardRows(left, right) {
    const primary = preferDashboardRow(left, right) ? left : right;
    const secondary = primary === left ? right : left;
    const merged = {
      ...secondary,
      ...primary,
      jobTitle: primary.jobTitle || secondary.jobTitle || "",
      companyName: primary.companyName || secondary.companyName || "",
      hrName: primary.hrName || secondary.hrName || "",
      hrTitle: primary.hrTitle || secondary.hrTitle || "",
      salary: primary.salary || secondary.salary || "",
      locationText: primary.locationText || secondary.locationText || "",
      tags: primary.tags && primary.tags.length ? primary.tags : secondary.tags || [],
      url: primary.url || secondary.url || "",
      note: primary.note || secondary.note || "",
      lastMessage: primary.lastMessage || secondary.lastMessage || "",
      updatedAt: newestDate(primary.updatedAt, secondary.updatedAt),
      lastMarkedAt: newestDate(primary.lastMarkedAt, secondary.lastMarkedAt),
      lastSeenAt: newestDate(primary.lastSeenAt, secondary.lastSeenAt),
      firstSeenAt: primary.firstSeenAt || secondary.firstSeenAt || "",
      hasChat: Boolean(primary.hasChat || secondary.hasChat),
      status: chooseDisplayStatus(primary, secondary)
    };
    merged.isProcessed = isProcessedRow(merged);
    merged.isExcluded = EXCLUDED_STATUSES.includes(merged.status) || merged.companyStatus === "blocked";
    merged.searchable = [
      merged.companyName,
      merged.jobTitle,
      merged.hrName,
      merged.hrTitle,
      merged.salary,
      merged.locationText,
      merged.note,
      merged.lastMessage
    ].filter(Boolean).join(" ").toLowerCase();
    return merged;
  }

  function preferDashboardRow(left, right) {
    const leftProcessed = isProcessedRow(left);
    const rightProcessed = isProcessedRow(right);
    if (leftProcessed !== rightProcessed) return leftProcessed;
    const leftFormal = left.jobKey && String(left.jobKey).startsWith("job:");
    const rightFormal = right.jobKey && String(right.jobKey).startsWith("job:");
    if (leftFormal !== rightFormal) return leftFormal;
    return String(left.updatedAt || left.lastMarkedAt || left.lastSeenAt || "") >= String(right.updatedAt || right.lastMarkedAt || right.lastSeenAt || "");
  }

  function mergeTimeFields(job, chat) {
    const result = { ...(job || {}) };
    if (!chat) return result;
    [
      "firstCommunicatedAt",
      "firstDeliveredNoReplyAt",
      "firstReadNoReplyAt",
      "resumeSentAt",
      "interviewAt",
      "rejectedAt",
      "unsuitableAt",
      "laterAt"
    ].forEach((field) => {
      result[field] = result[field] || chat[field] || "";
    });
    [
      "lastCommunicatedAt",
      "lastDeliveredNoReplyAt",
      "lastReadNoReplyAt",
      "lastResumeSentAt",
      "lastInterviewAt"
    ].forEach((field) => {
      result[field] = newestDate(result[field], chat[field]);
    });
    return result;
  }

  function renderStats() {
    const baseRows = rows.filter(matchesView);
    statsNode.innerHTML = getVisibleMetrics().map((metric) => {
      const value = baseRows.filter((row) => matchesMetric(row, metric) && matchesTime(row, metric)).length;
      return `
        <button type="button" class="stat ${activeMetric === metric.id ? "is-active" : ""}" data-metric="${escapeHtml(metric.id)}">
          <b>${escapeHtml(value)}</b>
          <span>${escapeHtml(metric.label)}</span>
        </button>
      `;
    }).join("");
  }

  function getVisibleMetrics() {
    return (VIEW_METRICS[viewFilter.value] || VIEW_METRICS.process).map((id) => METRICS[id]).filter(Boolean);
  }

  function renderRows() {
    const query = clean(searchInput.value).toLowerCase();
    const status = statusFilter.value;
    const sortBy = sortSelect.value;
    const metric = METRICS[activeMetric] || null;
    const filtered = rows
      .filter(matchesView)
      .filter((row) => status === "all" || row.status === status)
      .filter((row) => !metric || matchesMetric(row, metric))
      .filter((row) => matchesTime(row, metric))
      .filter((row) => !query || row.searchable.includes(query))
      .sort((a, b) => compareRows(a, b, sortBy));

    recordsBody.innerHTML = filtered.map(renderRow).join("");
    emptyState.classList.toggle("is-visible", filtered.length === 0);
  }

  function matchesView(row) {
    if (viewFilter.value === "all") return true;
    if (viewFilter.value === "excluded") return row.isExcluded;
    return row.isProcessed;
  }

  function matchesMetric(row, metric) {
    if (!metric) return true;
    if (metric.statuses === "processed") return row.isProcessed;
    if (metric.statuses === "all") return true;
    if (metric.statuses === "blocked") return row.companyStatus === "blocked";
    return metric.statuses.includes(row.status);
  }

  function matchesTime(row, metric) {
    if (timeRange.value === "all") return true;
    const fields = resolveTimeFields(row, metric);
    return fields.some((field) => isInRange(row[field], timeRange.value));
  }

  function resolveTimeFields(row, metric) {
    if (timeField.value !== "auto") return [timeField.value];
    if (metric && metric.timeFields) return metric.timeFields;
    if (metric && Array.isArray(metric.statuses) && metric.statuses.length === 1) return STATUS[metric.statuses[0]].timeFields;
    if (statusFilter.value !== "all" && STATUS[statusFilter.value]) return STATUS[statusFilter.value].timeFields;
    if (STATUS[row.status]) return STATUS[row.status].timeFields;
    return ["lastMarkedAt", "updatedAt", "lastSeenAt"];
  }

  function renderRow(row) {
    const status = STATUS[row.status] || STATUS.unmarked;
    const salaryLocation = [normalizeSalaryText(row.salary), row.locationText].filter(Boolean).join(" / ") || "-";
    const hrLine = [row.hrName, row.hrTitle].filter(Boolean).join(" · ") || "-";
    return `
      <tr>
        <td><span class="badge badge-${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span></td>
        <td>
          <strong title="${escapeHtml(row.jobTitle || "")}">${escapeHtml(row.jobTitle || "-")}</strong>
          <small>${escapeHtml((row.tags || []).slice(0, 4).join(" / "))}</small>
        </td>
        <td>
          <strong title="${escapeHtml(row.companyName || "")}">${escapeHtml(row.companyName || "-")}</strong>
          <small>${escapeHtml(row.companyStatus === "blocked" ? `已屏蔽${row.companyNote ? `：${row.companyNote}` : ""}` : "")}</small>
        </td>
        <td>
          <strong>${escapeHtml(hrLine)}</strong>
          <small>${escapeHtml(row.lastMessage || "")}</small>
        </td>
        <td>${escapeHtml(salaryLocation)}</td>
        <td>${escapeHtml(row.note || "-")}</td>
        <td>${escapeHtml(formatShortTime(row.updatedAt) || "-")}</td>
        <td>${row.url ? `<a class="link" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td>
      </tr>
    `;
  }

  function compareRows(a, b, sortBy) {
    if (sortBy === "company") return String(a.companyName || "").localeCompare(String(b.companyName || ""), "zh-Hans-CN");
    if (sortBy === "status") return String(statusLabel(a.status)).localeCompare(String(statusLabel(b.status)), "zh-Hans-CN");
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  }

  function exportStore() {
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

  function storageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => resolve(result[key]));
    });
  }

  function statusLabel(status) {
    return STATUS[status] ? STATUS[status].label : status || "未标记";
  }

  function normalizeJobTitle(value) {
    return clean(value)
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/[【\[][^】\]]*[】\]]/g, "")
      .replace(/\.{2,}|…+/g, "")
      .replace(/[｜|·_\-+/\\\s]/g, "")
      .replace(/招聘|急聘|直招|双休|单双休/g, "");
  }

  function normalizeCompanyName(value) {
    return clean(value)
      .replace(/[（）()\[\]【】\s]/g, "")
      .replace(/有限责任公司|股份有限公司|有限合伙|集团股份|集团|控股|公司/g, "");
  }

  function isSameOrRelatedCompany(left, right) {
    if (!clean(left) || !clean(right)) return false;
    if (clean(left) === clean(right)) return true;
    const a = normalizeCompanyName(left);
    const b = normalizeCompanyName(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    return short.length >= 3 && long.includes(short);
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

  function newestDate(...values) {
    return values.filter(Boolean).sort().pop() || "";
  }

  function isInRange(value, range) {
    if (!value) return false;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return false;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    if (range === "today") return date >= todayStart && date < tomorrowStart;
    if (range === "yesterday") {
      const yesterdayStart = new Date(todayStart);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      return date >= yesterdayStart && date < todayStart;
    }
    if (range === "7d" || range === "30d") {
      const days = range === "7d" ? 7 : 30;
      const start = new Date(todayStart);
      start.setDate(start.getDate() - days + 1);
      return date >= start && date < tomorrowStart;
    }
    return true;
  }

  function formatShortTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeSalaryText(value) {
    const text = clean(value);
    if (!text) return "";
    if (/[�□?]{2,}/.test(text)) return "";
    const match = text.match(/\d+\s*-\s*\d+\s*K(?:[·.]\d+薪)?|面议|\d+\s*K以上/i);
    return match ? clean(match[0]) : "";
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
