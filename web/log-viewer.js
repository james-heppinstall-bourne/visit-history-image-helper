// State
let users = [];
let filteredUsers = [];
let selectedUserId = null;
let userLogsPage = 1;
let userLogsLoading = false;

// Active user state
let activeUsers = [];
let filteredActiveUsers = [];
let selectedActiveUserId = null;
let activeUserLogsPage = 1;
let activeUserLogsLoading = false;
let activeUsersLoaded = false;

// Visits state
let visitsPage = 1;
let visitsLoading = false;
let visitsLoaded = false;

// Subscriptions state
let subsPage = 1;
let subsLoading = false;
let subsLoaded = false;

// All logs state
let allLogsPage = 1;
let allLogsLoading = false;
let allLogsLoaded = false;
let allLogsLevel = "";

// DOM
const statusText = document.getElementById("status-text");
const userSearch = document.getElementById("user-search");
const userList = document.getElementById("user-list");
const userLogsHeader = document.getElementById("user-logs-header");
const userLogsContainer = document.getElementById("user-logs");
const btnLoadMoreUser = document.getElementById("btn-load-more-user");
const allLogsTable = document.getElementById("all-logs-table");
const allLogsLevelSelect = document.getElementById("all-logs-level");
const btnLoadMoreAll = document.getElementById("btn-load-more-all");
const detailOverlay = document.getElementById("log-detail-overlay");
const detailBody = document.getElementById("log-detail-body");
const btnCloseDetail = document.getElementById("btn-close-detail");

// Tab switching
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "active-user" && !activeUsersLoaded) {
      loadActiveUsers();
    }
    if (btn.dataset.tab === "all-logs" && !allLogsLoaded) {
      loadAllLogs();
    }
    if (btn.dataset.tab === "visits" && !visitsLoaded) {
      loadVisits();
    }
    if (btn.dataset.tab === "subscriptions" && !subsLoaded) {
      loadSubscriptions();
    }
  });
});

// Back
document.getElementById("btn-back").addEventListener("click", () => {
  window.location.href = "home.html";
});

// Init
async function init() {
  statusText.textContent = "Loading users...";
  try {
    const result = await pywebview.api.get_auth_users();
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      return;
    }
    users = result.users || [];
    filteredUsers = users;
    renderUserList();
    statusText.textContent = users.length + " users loaded";
  } catch (e) {
    statusText.textContent = "Error loading users";
  }
}

// User list
function renderUserList() {
  userList.innerHTML = "";
  for (const user of filteredUsers) {
    const item = document.createElement("div");
    item.className = "user-item" + (user.id === selectedUserId ? " selected" : "");
    item.dataset.userId = user.id;

    const name = user.display_name || user.email || user.id;
    const sub = user.display_name ? user.email : "";
    const date = formatDate(user.created_at);

    item.innerHTML =
      '<div class="user-item-name">' + escapeHtml(name) + "</div>" +
      (sub ? '<div class="user-item-email">' + escapeHtml(sub) + "</div>" : "") +
      '<div class="user-item-date">Joined ' + date + "</div>";

    item.addEventListener("click", () => selectUser(user));
    userList.appendChild(item);
  }
}

function selectUser(user) {
  selectedUserId = user.id;
  renderUserList();
  userLogsPage = 1;
  userLogsContainer.innerHTML = '<div class="log-table" id="user-logs-table"></div>';
  btnLoadMoreUser.style.display = "none";

  const name = user.display_name || user.email || user.id;
  userLogsHeader.innerHTML = '<span class="logs-panel-title">Logs for ' + escapeHtml(name) + "</span>";

  loadUserLogs();
}

async function loadUserLogs() {
  if (userLogsLoading || !selectedUserId) return;
  userLogsLoading = true;
  statusText.textContent = "Loading logs...";
  try {
    const result = await pywebview.api.get_logs_for_user(selectedUserId, userLogsPage);
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      userLogsLoading = false;
      return;
    }
    const logs = result.logs || [];
    const table = document.getElementById("user-logs-table") || userLogsContainer;
    appendLogRows(table, logs, false);
    btnLoadMoreUser.style.display = logs.length >= result.page_size ? "inline-block" : "none";
    userLogsPage++;
    statusText.textContent = "Loaded";
  } catch (e) {
    statusText.textContent = "Error loading logs";
  }
  userLogsLoading = false;
}

btnLoadMoreUser.addEventListener("click", loadUserLogs);

// Search filter
userSearch.addEventListener("input", () => {
  const q = userSearch.value.trim().toLowerCase();
  if (!q) {
    filteredUsers = users;
  } else {
    filteredUsers = users.filter((u) => {
      return (
        (u.email && u.email.toLowerCase().includes(q)) ||
        (u.display_name && u.display_name.toLowerCase().includes(q))
      );
    });
  }
  renderUserList();
});

// Active user tab
const activeUserListEl = document.getElementById("active-user-list");
const activeUserSearch = document.getElementById("active-user-search");
const activeUserLogsHeader = document.getElementById("active-user-logs-header");
const activeUserLogsContainer = document.getElementById("active-user-logs");
const btnLoadMoreActiveUser = document.getElementById("btn-load-more-active-user");

async function loadActiveUsers() {
  activeUsersLoaded = true;
  statusText.textContent = "Loading active users...";
  try {
    const result = await pywebview.api.get_active_users();
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      return;
    }
    activeUsers = result.users || [];
    filteredActiveUsers = activeUsers;
    renderActiveUserList();
    statusText.textContent = activeUsers.length + " active users loaded";
  } catch (e) {
    statusText.textContent = "Error loading active users";
  }
}

function renderActiveUserList() {
  activeUserListEl.innerHTML = "";
  for (const user of filteredActiveUsers) {
    const item = document.createElement("div");
    item.className = "user-item" + (user.id === selectedActiveUserId ? " selected" : "");
    item.dataset.userId = user.id;

    const name = user.display_name || user.email || user.id;
    const sub = user.display_name ? user.email : "";
    const date = user.last_active ? formatDateTime(user.last_active) : formatDate(user.created_at);

    item.innerHTML =
      '<div class="user-item-name">' + escapeHtml(name) + "</div>" +
      (sub ? '<div class="user-item-email">' + escapeHtml(sub) + "</div>" : "") +
      '<div class="user-item-date">Active ' + date + "</div>";

    item.addEventListener("click", () => selectActiveUser(user));
    activeUserListEl.appendChild(item);
  }
}

function selectActiveUser(user) {
  selectedActiveUserId = user.id;
  renderActiveUserList();
  activeUserLogsPage = 1;
  activeUserLogsContainer.innerHTML = '<div class="log-table" id="active-user-logs-table"></div>';
  btnLoadMoreActiveUser.style.display = "none";

  const name = user.display_name || user.email || user.id;
  activeUserLogsHeader.innerHTML = '<span class="logs-panel-title">Logs for ' + escapeHtml(name) + "</span>";

  loadActiveUserLogs();
}

async function loadActiveUserLogs() {
  if (activeUserLogsLoading || !selectedActiveUserId) return;
  activeUserLogsLoading = true;
  statusText.textContent = "Loading logs...";
  try {
    const result = await pywebview.api.get_logs_for_user(selectedActiveUserId, activeUserLogsPage);
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      activeUserLogsLoading = false;
      return;
    }
    const logs = result.logs || [];
    const table = document.getElementById("active-user-logs-table") || activeUserLogsContainer;
    appendLogRows(table, logs, false);
    btnLoadMoreActiveUser.style.display = logs.length >= result.page_size ? "inline-block" : "none";
    activeUserLogsPage++;
    statusText.textContent = "Loaded";
  } catch (e) {
    statusText.textContent = "Error loading logs";
  }
  activeUserLogsLoading = false;
}

btnLoadMoreActiveUser.addEventListener("click", loadActiveUserLogs);

activeUserSearch.addEventListener("input", () => {
  const q = activeUserSearch.value.trim().toLowerCase();
  filteredActiveUsers = q
    ? activeUsers.filter((u) =>
        (u.email && u.email.toLowerCase().includes(q)) ||
        (u.display_name && u.display_name.toLowerCase().includes(q))
      )
    : activeUsers;
  renderActiveUserList();
});

// All logs
async function loadAllLogs() {
  if (allLogsLoading) return;
  allLogsLoading = true;
  allLogsLoaded = true;
  statusText.textContent = "Loading logs...";
  try {
    const result = await pywebview.api.get_all_logs(allLogsPage, 100, allLogsLevel);
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      allLogsLoading = false;
      return;
    }
    const logs = result.logs || [];
    appendLogRows(allLogsTable, logs, true);
    btnLoadMoreAll.style.display = logs.length >= result.page_size ? "inline-block" : "none";
    allLogsPage++;
    statusText.textContent = "Loaded";
  } catch (e) {
    statusText.textContent = "Error loading logs";
  }
  allLogsLoading = false;
}

function resetAllLogs() {
  allLogsPage = 1;
  allLogsLoaded = false;
  allLogsTable.innerHTML = "";
  btnLoadMoreAll.style.display = "none";
  loadAllLogs();
}

allLogsLevelSelect.addEventListener("change", () => {
  allLogsLevel = allLogsLevelSelect.value;
  resetAllLogs();
});

btnLoadMoreAll.addEventListener("click", loadAllLogs);

// User lookup
function getUserLabel(userId) {
  if (!userId) return "";
  const u = users.find((u) => u.id === userId);
  if (u) return u.display_name || u.email || userId.slice(0, 8);
  return userId.slice(0, 8);
}

function isTestUser(userId) {
  if (!userId) return false;
  const u = users.find((u) => u.id === userId);
  return u && u.email && u.email.toLowerCase().startsWith("testuser@");
}

// Render log rows
function appendLogRows(container, logs, showUser) {
  for (const log of logs) {
    const row = document.createElement("div");
    row.className = "log-row log-level-" + log.level;
    let html =
      '<span class="log-time">' + formatDateTime(log.created_at) + "</span>";
    if (showUser) {
      html += '<span class="log-user">' + escapeHtml(getUserLabel(log.user_id)) + "</span>";
    }
    html +=
      '<span class="log-level-badge"><span>' + escapeHtml(log.level) + "</span></span>" +
      '<span class="log-category">' + escapeHtml(log.category) + "</span>" +
      '<span class="log-message">' + escapeHtml(log.message) + "</span>";
    row.innerHTML = html;
    row.addEventListener("dblclick", () => showDetail(log));
    container.appendChild(row);
  }
}

// Detail overlay
function showDetail(log) {
  detailOverlay.classList.remove("hidden");
  let html = '<table class="detail-table">';
  html += detailRow("Time", formatDateTime(log.created_at));
  html += detailRow("Level", log.level);
  html += detailRow("Category", log.category);
  html += detailRow("Message", log.message);
  if (log.device_platform) html += detailRow("Platform", log.device_platform);
  if (log.device_version) html += detailRow("Device Version", log.device_version);
  if (log.app_version) html += detailRow("App Version", log.app_version);
  if (log.exception_type) html += detailRow("Exception", log.exception_type);
  if (log.exception_message) html += detailRow("Exception Msg", log.exception_message);
  if (log.stack_trace) {
    html += '<tr><td class="detail-label">Stack Trace</td><td class="detail-value"><pre class="stack-trace">' + escapeHtml(log.stack_trace) + "</pre></td></tr>";
  }
  if (log.context) {
    const ctx = typeof log.context === "string" ? log.context : JSON.stringify(log.context, null, 2);
    html += '<tr><td class="detail-label">Context</td><td class="detail-value"><pre class="context-json">' + escapeHtml(ctx) + "</pre></td></tr>";
  }
  html += "</table>";
  detailBody.innerHTML = html;
}

function detailRow(label, value) {
  return '<tr><td class="detail-label">' + escapeHtml(label) + '</td><td class="detail-value">' + escapeHtml(value || "") + "</td></tr>";
}

btnCloseDetail.addEventListener("click", () => {
  detailOverlay.classList.add("hidden");
});

detailOverlay.addEventListener("click", (e) => {
  if (e.target === detailOverlay) detailOverlay.classList.add("hidden");
});

// Visits
const visitsList = document.getElementById("visits-list");
const btnLoadMoreVisits = document.getElementById("btn-load-more-visits");
const photoOverlay = document.getElementById("visit-photo-overlay");
const photoImg = document.getElementById("visit-photo-img");
const btnClosePhoto = document.getElementById("btn-close-photo");

async function loadVisits() {
  if (visitsLoading) return;
  visitsLoading = true;
  visitsLoaded = true;
  statusText.textContent = "Loading visits...";
  try {
    const result = await pywebview.api.get_visits(visitsPage);
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      visitsLoading = false;
      return;
    }
    const visits = result.visits || [];
    appendVisitCards(visits);
    btnLoadMoreVisits.style.display = visits.length >= result.page_size ? "inline-block" : "none";
    visitsPage++;
    statusText.textContent = visits.length + " visits loaded";
  } catch (e) {
    statusText.textContent = "Error loading visits";
  }
  visitsLoading = false;
}

function appendVisitCards(visits) {
  for (const v of visits) {
    const card = document.createElement("div");
    card.className = "visit-card";

    // Determine place/site name
    let name = v.place_name || v.nhle_name || v.cadw_name || "Unknown place";
    let badge = "";
    if (v.nhle_list_entry) {
      badge = '<span class="visit-source-badge nhle">NHLE ' + escapeHtml(String(v.nhle_list_entry)) + (v.nhle_grade ? " — Grade " + escapeHtml(v.nhle_grade) : "") + "</span>";
    } else if (v.cadw_fid) {
      badge = '<span class="visit-source-badge cadw">CADW ' + escapeHtml(v.cadw_fid) + (v.cadw_grade ? " — Grade " + escapeHtml(v.cadw_grade) : "") + "</span>";
    }

    // User
    const userName = getUserLabel(v.user_id);

    // Rating stars
    let stars = "";
    if (v.rating) {
      for (let i = 0; i < v.rating; i++) stars += "&#9733;";
      for (let i = v.rating; i < 5; i++) stars += "&#9734;";
    }

    let html = '<div class="visit-card-header">' +
      '<span class="visit-place-name">' + escapeHtml(name) + "</span>" +
      (badge ? " " + badge : "") +
      (v.is_favorite ? ' <span class="visit-fav">&#9829;</span>' : "") +
      "</div>" +
      '<div class="visit-card-meta">' +
      '<span class="visit-user">' + escapeHtml(userName) + "</span>" +
      '<span class="visit-date">' + formatDateTime(v.visited_at) + "</span>" +
      (stars ? '<span class="visit-rating">' + stars + "</span>" : "") +
      "</div>";

    if (v.notes) {
      html += '<div class="visit-notes">' + escapeHtml(v.notes) + "</div>";
    }
    if (v.public_comments) {
      html += '<div class="visit-comment">' + escapeHtml(v.public_comments) + "</div>";
    }

    // Photos
    const photos = v.photos || [];
    if (photos.length > 0) {
      html += '<div class="visit-photos">';
      for (const photo of photos) {
        html += '<img class="visit-photo-thumb" src="' + escapeHtml(photo.url) + '" alt="' + escapeHtml(photo.comment || "Visit photo") + '" data-url="' + escapeHtml(photo.url) + '">';
      }
      html += "</div>";
    }

    card.innerHTML = html;

    // Attach click handlers to photo thumbnails
    card.querySelectorAll(".visit-photo-thumb").forEach((thumb) => {
      thumb.addEventListener("click", () => {
        photoImg.src = thumb.dataset.url;
        photoOverlay.classList.remove("hidden");
      });
    });

    visitsList.appendChild(card);
  }
}

btnLoadMoreVisits.addEventListener("click", loadVisits);

btnClosePhoto.addEventListener("click", () => {
  photoOverlay.classList.add("hidden");
  photoImg.src = "";
});

photoOverlay.addEventListener("click", (e) => {
  if (e.target === photoOverlay) {
    photoOverlay.classList.add("hidden");
    photoImg.src = "";
  }
});

// Subscriptions
const subsTableBody = document.getElementById("subs-table-body");
const btnLoadMoreSubs = document.getElementById("btn-load-more-subs");

async function loadSubscriptions() {
  if (subsLoading) return;
  subsLoading = true;
  subsLoaded = true;
  statusText.textContent = "Loading subscriptions...";
  try {
    const result = await pywebview.api.get_subscriptions(subsPage);
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      subsLoading = false;
      return;
    }
    const subs = (result.subscriptions || []).filter((s) => !isTestUser(s.user_id));
    for (const s of subs) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td>' + formatDateTime(s.created_at) + '</td>' +
        '<td>' + escapeHtml(getUserLabel(s.user_id)) + '</td>' +
        '<td><span class="sub-type-badge sub-type-' + s.subscription_type + '">' + escapeHtml(s.subscription_type) + '</span></td>';
      subsTableBody.appendChild(tr);
    }
    btnLoadMoreSubs.style.display = subs.length >= result.page_size ? "inline-block" : "none";
    subsPage++;
    statusText.textContent = subs.length + " subscriptions loaded";
  } catch (e) {
    statusText.textContent = "Error loading subscriptions";
  }
  subsLoading = false;
}

btnLoadMoreSubs.addEventListener("click", loadSubscriptions);

// Helpers
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString();
}

function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString();
}

// Wait for pywebview API
window.addEventListener("pywebviewready", init);
