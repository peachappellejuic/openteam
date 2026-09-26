const TOKEN_STORAGE_KEY = "agentswarm.token";
const FILTER_STORAGE_KEY = "agentswarm.assigneeFilter";
const IDENTITY_STORAGE_KEY = "agentswarm.identity";

const readStored = (key, fallback = "") => {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

const writeStored = (key, value) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
};

const state = {
  projects: [],
  projectId: null,
  snapshot: null,
  providers: [],
  eventSource: null,
  refreshTimer: null,
  token: readStored(TOKEN_STORAGE_KEY),
  assigneeFilter: readStored(FILTER_STORAGE_KEY),
  identity: readStored(IDENTITY_STORAGE_KEY),
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const shortId = (value) => value ? value.slice(-8) : "—";
const formatTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
const formatDate = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { month: "short", day: "numeric" });
};
const splitValues = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);
const statusLabel = (status) => ({ queued: "Queued", blocked: "Blocked", running: "Running", review: "Review", completed: "Completed", failed: "Failed", cancelled: "Cancelled", pending: "Pending", approved: "Approved", merged: "Merged", conflict: "Conflict", failed_change: "Failed" }[status] || status);

const tokenHeaders = () => (state.token ? { authorization: `Bearer ${state.token}` } : {});

const api = async (path, options = {}) => {
  const response = await fetch(path, { headers: { "content-type": "application/json", ...tokenHeaders(), ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    handleUnauthorized();
    throw new Error("Shared access token required");
  }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
};

const handleUnauthorized = () => {
  state.eventSource?.close();
  setConnection("Locked", "status-muted");
  showToast("Enter the shared access token to continue", true);
  $("#shared-token")?.focus();
};

const showToast = (message, isError = false) => {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("visible"), 3600);
};

const openDialog = (id) => {
  const dialog = document.getElementById(id);
  if (dialog && !dialog.open) dialog.showModal();
};

const closeDialog = (id) => {
  const dialog = document.getElementById(id);
  if (dialog?.open) dialog.close();
};

const setConnection = (label, stateName) => {
  const element = $("#connection-state");
  element.textContent = label;
  element.className = `status-pill ${stateName}`;
};

const renderSidebar = () => {
  const list = $("#project-list");
  if (!state.projects.length) {
    list.innerHTML = '<div class="empty-state">No repositories connected</div>';
    return;
  }
  list.innerHTML = state.projects.map((project) => `
    <button class="project-item ${project.id === state.projectId ? "active" : ""}" data-action="select-project" data-id="${escapeHtml(project.id)}">
      <span class="project-item-mark">${escapeHtml(project.name.slice(0, 1).toUpperCase())}</span>
      <span class="project-item-copy"><span class="project-item-name">${escapeHtml(project.name)}</span><span class="project-item-meta">${escapeHtml(project.defaultBranch)}</span></span>
    </button>
  `).join("");
};

const renderProviders = () => {
  const select = $("#task-provider");
  if (!select || !state.providers.length) return;
  const current = select.value || "mock";
  select.innerHTML = state.providers.map((provider) => `<option value="${escapeHtml(provider.id)}" ${provider.available ? "" : "disabled"}>${escapeHtml(provider.id)}${provider.available ? "" : " · unavailable"}</option>`).join("");
  if ([...select.options].some((option) => option.value === current && !option.disabled)) select.value = current;
  if (!select.value) select.value = "mock";
};

const renderStats = () => {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const running = snapshot.tasks.filter((task) => task.status === "running").length;
  const review = snapshot.tasks.filter((task) => task.status === "review").length;
  const completed = snapshot.tasks.filter((task) => task.status === "completed").length;
  const pending = snapshot.changes.filter((change) => ["pending", "approved"].includes(change.status)).length;
  $("#stats-row").innerHTML = [
    ["Active runs", running, `${snapshot.runs.filter((run) => run.status === "running").length} provider processes`],
    ["Awaiting review", review, `${snapshot.changes.filter((change) => change.status === "pending").length} changes pending`],
    ["Completed", completed, `${snapshot.tasks.length} total tasks`],
    ["Merge queue", pending, `${snapshot.changes.filter((change) => change.status === "merged").length} merged`],
  ].map(([label, value, detail]) => `<div class="stat-card"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div><div class="stat-detail">${escapeHtml(detail)}</div></div>`).join("");
};

const taskAction = (task) => {
  if (task.status === "queued" || task.status === "blocked") return `<button class="mini-button mini-button-primary" data-action="dispatch-task" data-id="${escapeHtml(task.id)}">Run</button>`;
  if (task.status === "running") return `<button class="mini-button" data-action="cancel-task" data-id="${escapeHtml(task.id)}">Stop</button>`;
  if (task.status === "review") {
    const change = state.snapshot.changes.find((candidate) => candidate.taskId === task.id);
    return change ? `<button class="mini-button mini-button-primary" data-action="view-diff" data-id="${escapeHtml(change.id)}">Review</button>` : "";
  }
  return "";
};

const matchesAssignee = (task) => {
  const filter = state.assigneeFilter.trim().toLowerCase();
  if (!filter) return true;
  return (task.assignee ?? "").toLowerCase().includes(filter);
};

const assigneeBadge = (task) => {
  if (!task.assignee) return `<button class="assignee-badge assignee-unset" data-action="claim-task" data-id="${escapeHtml(task.id)}" title="Claim this task">+ claim</button>`;
  return `<button class="assignee-badge" data-action="filter-assignee" data-name="${escapeHtml(task.assignee)}" title="Filter by ${escapeHtml(task.assignee)}">${escapeHtml(task.assignee)}</button>`;
};

const knownAssignees = () => {
  const names = new Set();
  for (const task of state.snapshot?.tasks ?? []) {
    if (task.assignee) names.add(task.assignee);
  }
  return [...names].sort();
};

const renderAssigneeOptions = () => {
  const list = $("#assignee-options");
  if (!list) return;
  list.innerHTML = knownAssignees().map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
};

const renderTaskBoard = () => {
  const board = $("#task-board");
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const groups = [
    ["Queue", ["queued", "blocked"]],
    ["Running", ["running"]],
    ["Review", ["review"]],
    ["Finished", ["completed", "failed", "cancelled"]],
  ];
  board.innerHTML = groups.map(([label, statuses]) => {
    const tasks = snapshot.tasks.filter((task) => statuses.includes(task.status) && matchesAssignee(task));
    return `<div class="task-column"><div class="task-column-heading"><span>${label}</span><span>${tasks.length}</span></div>${tasks.length ? tasks.map((task) => `
      <article class="task-card">
        <div class="task-card-top"><span class="task-provider">${escapeHtml(task.provider)}</span><span class="muted-text">${escapeHtml(statusLabel(task.status))}</span></div>
        <div class="task-card-title">${escapeHtml(task.title)}</div>
        <div class="task-card-description">${escapeHtml(task.description)}</div>
        ${task.error ? `<div class="change-meta"><span class="change-conflict">${escapeHtml(task.error)}</span></div>` : ""}
        <div class="task-card-footer"><span>${escapeHtml(shortId(task.id))} · ${escapeHtml(task.dependencies.length ? `${task.dependencies.length} deps` : "independent")}</span><span class="task-card-actions">${assigneeBadge(task)}${taskAction(task)}</span></div>
      </article>`).join("") : '<div class="empty-state">Nothing here</div>'}</div>`;
  }).join("");
  const hidden = snapshot.tasks.length - snapshot.tasks.filter(matchesAssignee).length;
  const filterNote = $("#task-filter-note");
  if (filterNote) filterNote.textContent = state.assigneeFilter.trim() ? `${hidden} task${hidden === 1 ? "" : "s"} hidden by filter` : "";
  renderAssigneeOptions();
};

const changeStatusClass = (status) => `change-${status === "failed" ? "failed" : status}`;

const renderChanges = () => {
  const list = $("#change-list");
  const changes = [...state.snapshot.changes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("#change-count").textContent = changes.filter((change) => ["pending", "approved"].includes(change.status)).length;
  if (!changes.length) {
    list.innerHTML = '<div class="empty-state">Submitted changes will appear here for review.</div>';
    return;
  }
  list.innerHTML = changes.map((change) => {
    const actions = change.status === "pending" ? `<button class="mini-button" data-action="view-diff" data-id="${escapeHtml(change.id)}">Diff</button><button class="mini-button mini-button-primary" data-action="approve-change" data-id="${escapeHtml(change.id)}">Approve</button>` : change.status === "approved" ? `<button class="mini-button mini-button-primary" data-action="merge-change" data-id="${escapeHtml(change.id)}">Merge</button>` : "";
    const task = state.snapshot.tasks.find((candidate) => candidate.id === change.taskId);
    const owner = task?.assignee ? `<span>by ${escapeHtml(task.assignee)}</span>` : "";
    return `<div class="change-item"><div class="change-main"><div class="change-summary">${escapeHtml(change.summary)}</div><div class="change-meta"><span class="change-status ${changeStatusClass(change.status)}">${escapeHtml(statusLabel(change.status))}</span><span>task <code>${escapeHtml(shortId(change.taskId))}</code></span>${owner}<span>base <code>${escapeHtml(shortId(change.baseSha))}</code></span><span>${escapeHtml(formatDate(change.createdAt))}</span></div></div><div class="change-actions">${actions}</div></div>`;
  }).join("");
};

const eventClass = (type) => type.includes("failed") || type.includes("conflict") || type.includes("cancelled") ? "error" : type.includes("completed") || type.includes("merged") || type.includes("passed") ? "success" : type.includes("review") || type.includes("verification") ? "warn" : "";

const renderActivity = () => {
  const list = $("#activity-list");
  const events = [...state.snapshot.events].reverse();
  $("#activity-count").textContent = events.length;
  if (!events.length) {
    list.innerHTML = '<div class="activity-empty">Connect a repository and delegate a task to see the swarm come alive.</div>';
    return;
  }
  list.innerHTML = events.slice(0, 80).map((event) => `<div class="activity-item ${eventClass(event.type)}"><span class="activity-dot"></span><div class="activity-message">${escapeHtml(event.message)}</div><time class="activity-time">${escapeHtml(formatTime(event.timestamp))}</time></div>`).join("");
};

const renderDashboard = () => {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const { project } = snapshot;
  $("#page-title").textContent = project.name;
  $("#active-project-name").textContent = project.name;
  $("#active-project-meta").textContent = `${project.defaultBranch} · ${project.repositoryPath}`;
  renderStats();
  renderTaskBoard();
  renderChanges();
  renderActivity();
};

const loadSnapshot = async () => {
  if (!state.projectId) return;
  try {
    state.snapshot = await api(`/api/projects/${encodeURIComponent(state.projectId)}/snapshot`);
    renderSidebar();
    renderDashboard();
    setConnection("Live", "status-live");
  } catch (error) {
    setConnection("Offline", "status-muted");
    showToast(error.message, true);
  }
};

const scheduleRefresh = () => {
  window.clearTimeout(state.refreshTimer);
  state.refreshTimer = window.setTimeout(() => void loadSnapshot(), 220);
};

const connectEvents = () => {
  state.eventSource?.close();
  if (!state.projectId) return;
  const source = new EventSource(`/api/projects/${encodeURIComponent(state.projectId)}/events${state.token ? `?token=${encodeURIComponent(state.token)}` : ""}`);
  state.eventSource = source;
  source.addEventListener("ready", () => setConnection("Live", "status-live"));
  source.addEventListener("update", (event) => {
    try {
      const update = JSON.parse(event.data);
      if (["task.started", "task.review", "task.completed", "task.failed", "change.merged", "change.conflict"].includes(update.type)) showToast(update.message);
      scheduleRefresh();
    } catch {
      scheduleRefresh();
    }
  });
  source.onerror = () => setConnection("Reconnecting", "status-muted");
};

const selectProject = async (projectId) => {
  state.projectId = projectId;
  state.snapshot = null;
  state.eventSource?.close();
  $("#welcome-view").classList.add("hidden");
  $("#dashboard-view").classList.remove("hidden");
  $("#refresh-button").disabled = false;
  renderSidebar();
  await loadSnapshot();
  connectEvents();
};

const loadProjects = async () => {
  const payload = await api("/api/projects");
  state.projects = payload.projects;
  renderSidebar();
  if (state.projects.length) {
    const selected = state.projects.some((project) => project.id === state.projectId) ? state.projectId : state.projects[0].id;
    await selectProject(selected);
  } else {
    state.projectId = null;
    state.snapshot = null;
    state.eventSource?.close();
    $("#welcome-view").classList.remove("hidden");
    $("#dashboard-view").classList.add("hidden");
    $("#refresh-button").disabled = true;
    $("#page-title").textContent = "Connect a repository";
    setConnection("Offline", "status-muted");
  }
};

const loadProviders = async () => {
  try {
    const payload = await api("/api/providers");
    state.providers = payload.providers;
    renderProviders();
  } catch (error) {
    showToast(error.message, true);
  }
};

const submitProject = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button[type=submit]");
  const errorBox = $("#project-error");
  errorBox.textContent = "";
  submit.disabled = true;
  try {
    const payload = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: $("#project-name").value, repositoryPath: $("#project-path").value, defaultBranch: $("#project-branch").value }) });
    form.reset();
    closeDialog("project-dialog");
    state.projectId = payload.project.id;
    await loadProjects();
    showToast(`Connected ${payload.project.name}`);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};

const submitTask = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    await api(`/api/projects/${encodeURIComponent(state.projectId)}/tasks`, { method: "POST", body: JSON.stringify({ title: $("#task-title").value, description: $("#task-description").value, assignee: $("#task-assignee").value.trim(), provider: $("#task-provider").value, model: $("#task-model").value, dependencies: splitValues($("#task-dependencies").value), allowedPaths: splitValues($("#task-paths").value), acceptanceTests: splitValues($("#task-tests").value), verifyCommand: $("#task-verify").value }) });
    form.reset();
    $("#task-provider").value = "mock";
    await loadSnapshot();
    showToast("Task queued");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
  }
};

const submitPlan = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button[type=submit]");
  const errorBox = $("#plan-error");
  errorBox.textContent = "";
  submit.disabled = true;
  try {
    const payload = await api(`/api/projects/${encodeURIComponent(state.projectId)}/plan`, { method: "POST", body: JSON.stringify({ goal: $("#plan-goal").value }) });
    form.reset();
    closeDialog("plan-dialog");
    await loadSnapshot();
    showToast(`${payload.tasks.length} delegated tasks created`);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};

const setAssigneeFilter = (value) => {
  state.assigneeFilter = value;
  writeStored(FILTER_STORAGE_KEY, value);
  const input = $("#task-filter");
  if (input && input.value !== value) input.value = value;
  renderTaskBoard();
};

const handleAction = async (action, id, dataset = {}) => {
  if (action === "filter-assignee") {
    setAssigneeFilter(dataset.name === state.assigneeFilter ? "" : dataset.name || "");
    return;
  }
  if (!id) return;
  try {
    if (action === "select-project") await selectProject(id);
    if (action === "claim-task") {
      const owner = state.identity.trim() || $("#task-assignee").value.trim();
      if (!owner) {
        showToast("Set your name in the sidebar to claim tasks", true);
        $("#identity-input")?.focus();
        return;
      }
      await api(`/api/tasks/${encodeURIComponent(id)}/assign`, { method: "POST", body: JSON.stringify({ assignee: owner }) });
      await loadSnapshot();
      showToast(`Claimed by ${owner}`);
    }
    if (action === "dispatch-task") {
      await api(`/api/tasks/${encodeURIComponent(id)}/dispatch`, { method: "POST" });
      await loadSnapshot();
      showToast("Task dispatched");
    }
    if (action === "cancel-task") {
      await api(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      await loadSnapshot();
      showToast("Task cancelled");
    }
    if (action === "approve-change") {
      await api(`/api/changes/${encodeURIComponent(id)}/approve`, { method: "POST" });
      await loadSnapshot();
      showToast("Change approved");
    }
    if (action === "merge-change") {
      await api(`/api/changes/${encodeURIComponent(id)}/merge`, { method: "POST" });
      await loadSnapshot();
      showToast("Merge request processed");
    }
    if (action === "view-diff") {
      const change = state.snapshot.changes.find((candidate) => candidate.id === id);
      if (change) {
        $("#diff-title").textContent = change.summary;
        $("#diff-content").textContent = change.diff || "No textual diff available.";
        openDialog("diff-dialog");
      }
    }
  } catch (error) {
    showToast(error.message, true);
  }
};

const bind = () => {
  $("#new-project-button").addEventListener("click", () => openDialog("project-dialog"));
  $("#welcome-connect-button").addEventListener("click", () => openDialog("project-dialog"));
  $("#project-plan-button").addEventListener("click", () => openDialog("plan-dialog"));
  $("#project-form").addEventListener("submit", submitProject);
  $("#task-form").addEventListener("submit", submitTask);
  $("#plan-form").addEventListener("submit", submitPlan);
  $("#refresh-button").addEventListener("click", () => void loadSnapshot());
  $("#shared-token").value = state.token;
  $("#shared-token").addEventListener("change", (event) => {
    state.token = event.target.value.trim();
    writeStored(TOKEN_STORAGE_KEY, state.token);
    state.eventSource?.close();
    void reloadAll();
  });
  $("#identity-input").value = state.identity;
  if (state.identity) $("#task-assignee").placeholder = state.identity;
  $("#identity-input").addEventListener("change", (event) => {
    state.identity = event.target.value.trim();
    writeStored(IDENTITY_STORAGE_KEY, state.identity);
    if (state.identity) $("#task-assignee").placeholder = state.identity;
  });
  $("#task-filter").value = state.assigneeFilter;
  $("#task-filter").addEventListener("input", (event) => setAssigneeFilter(event.target.value));
  $("#my-tasks-button").addEventListener("click", () => {
    if (!state.identity.trim()) {
      showToast("Set your name in the sidebar first", true);
      $("#identity-input")?.focus();
      return;
    }
    setAssigneeFilter(state.assigneeFilter === state.identity ? "" : state.identity);
  });
  $("#sync-button").addEventListener("click", async () => {
    try {
      const payload = await api(`/api/projects/${encodeURIComponent(state.projectId)}/sync`, { method: "POST" });
      const labels = { updated: "Source branch synced", up_to_date: "Source is already current", ahead: "Managed branch is ahead of source", diverged: "Source and managed branches diverged" };
      showToast(labels[payload.sync.status] || "Source sync complete");
      await loadSnapshot();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#dispatch-all-button").addEventListener("click", async () => {
    try {
      await api(`/api/projects/${encodeURIComponent(state.projectId)}/dispatch`, { method: "POST" });
      await loadSnapshot();
      showToast("Ready tasks dispatched");
    } catch (error) {
      showToast(error.message, true);
    }
  });
  document.addEventListener("click", (event) => {
    const actionElement = event.target.closest("[data-action]");
    if (actionElement) void handleAction(actionElement.dataset.action, actionElement.dataset.id, actionElement.dataset);
    const closeElement = event.target.closest("[data-close]");
    if (closeElement) closeDialog(closeElement.dataset.close);
  });
};

const reloadAll = async () => {
  await Promise.all([loadProviders(), loadProjects()]);
};

const boot = async () => {
  bind();
  await reloadAll();
};

void boot();
