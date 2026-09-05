// State
let users = [];
let filteredUsers = [];
let selectedUserId = null;
let userLogsBefore = null; // created_at cursor: the next page is everything older
let userLogsLoading = false;
let userLogsSource = "all";

// Active user state
let activeUsers = [];
let filteredActiveUsers = [];
let selectedActiveUserId = null;
let activeUserLogsBefore = null;
let activeUserLogsLoading = false;
let activeUserLogsSource = "all";
let activeUsersLoaded = false;
let activeUserFilter = "any"; // any | app | web

// Visits state
let visitsPage = 1;
let visitsLoading = false;
let visitsLoaded = false;
let visitsHasMore = true;
let visitsShown = 0;

// Subscriptions state
let subsPage = 1;
let subsLoading = false;
let subsLoaded = false;
let subsStatus = "active";

// Tag explorer state
let tagsPage = 1;
let tagsLoading = false;
let tagsLoaded = false;
let tagsSearch = "";
let tagsUserId = "";
let tagsApproved = "";
let tagsSearchTimer = null;

// All logs state
let allLogsBefore = null;
let allLogsLoading = false;
let allLogsLoaded = false;
let allLogsLevel = "";
let allLogsSource = "all";

// Dashboard state
let dashRange = "month";
let dashOffset = 0; // 0 = current period, -1 = previous, etc.
let dashIncludeTest = false;
let subscriptionRows = [];
let subscriptionsLoadError = "";

// DOM
const statusText = document.getElementById("status-text");
const userSearch = document.getElementById("user-search");
const userList = document.getElementById("user-list");
const userLogsTitle = document.getElementById("user-logs-title");
const userLogsSourceSelect = document.getElementById("user-logs-source");
const userLogsContainer = document.getElementById("user-logs");
const btnLoadMoreUser = document.getElementById("btn-load-more-user");
const allLogsTable = document.getElementById("all-logs-table");
const allLogsLevelSelect = document.getElementById("all-logs-level");
const allLogsSourceSelect = document.getElementById("all-logs-source");
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
    if (btn.dataset.tab === "dashboard") {
      renderDashboard();
    }
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
    if (btn.dataset.tab === "tags" && !tagsLoaded) {
      loadTagUsers();
      loadPlaceTags();
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
      renderDashboard();
      return;
    }
    users = result.users || [];
    filteredUsers = users;
    renderUserList();
    renderDashboard();
    loadSubscriptionStarts();
    statusText.textContent = users.length + " users loaded";
  } catch (e) {
    statusText.textContent = "Error loading users";
    renderDashboard();
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
  const name = user.display_name || user.email || user.id;
  userLogsTitle.textContent = "Logs for " + name;
  resetUserLogs();
}

function resetUserLogs() {
  userLogsBefore = null;
  userLogsContainer.innerHTML = '<div class="log-table" id="user-logs-table"></div>';
  btnLoadMoreUser.style.display = "none";
  loadUserLogs();
}

async function loadUserLogs() {
  if (userLogsLoading || !selectedUserId) return;
  userLogsLoading = true;
  statusText.textContent = "Loading logs...";
  try {
    const result = await pywebview.api.get_logs_for_user(selectedUserId, 100, userLogsSource, userLogsBefore);
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      userLogsLoading = false;
      return;
    }
    const logs = result.logs || [];
    const table = document.getElementById("user-logs-table") || userLogsContainer;
    appendLogRows(table, logs, false);
    btnLoadMoreUser.style.display = result.has_more ? "inline-block" : "none";
    userLogsBefore = result.next_before;
    statusText.textContent = "Loaded";
  } catch (e) {
    statusText.textContent = "Error loading logs";
  }
  userLogsLoading = false;
}

btnLoadMoreUser.addEventListener("click", loadUserLogs);

userLogsSourceSelect.addEventListener("change", () => {
  userLogsSource = userLogsSourceSelect.value;
  if (selectedUserId) resetUserLogs();
});

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
const activeUserFilterSelect = document.getElementById("active-user-filter");
const activeUserLogsTitle = document.getElementById("active-user-logs-title");
const activeUserLogsSourceSelect = document.getElementById("active-user-logs-source");
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
    applyActiveUserFilter();
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
    // Under an app/web filter the date is that source's; otherwise the latest of either.
    const when = activeUserFilter === "app" ? user.last_active_app
      : activeUserFilter === "web" ? user.last_active_web
      : user.last_active;
    const date = when ? formatDateTime(when) : formatDate(user.created_at);
    const sources =
      (user.last_active_app ? '<span class="user-item-source">app</span>' : "") +
      (user.last_active_web ? '<span class="user-item-source web">web</span>' : "");

    item.innerHTML =
      '<div class="user-item-name">' + escapeHtml(name) + "</div>" +
      (sub ? '<div class="user-item-email">' + escapeHtml(sub) + "</div>" : "") +
      '<div class="user-item-date">' + (when ? "Active " : "Joined ") + date + sources + "</div>";

    item.addEventListener("click", () => selectActiveUser(user));
    activeUserListEl.appendChild(item);
  }
}

function selectActiveUser(user) {
  selectedActiveUserId = user.id;
  renderActiveUserList();
  const name = user.display_name || user.email || user.id;
  activeUserLogsTitle.textContent = "Logs for " + name;
  resetActiveUserLogs();
}

function resetActiveUserLogs() {
  activeUserLogsBefore = null;
  activeUserLogsContainer.innerHTML = '<div class="log-table" id="active-user-logs-table"></div>';
  btnLoadMoreActiveUser.style.display = "none";
  loadActiveUserLogs();
}

async function loadActiveUserLogs() {
  if (activeUserLogsLoading || !selectedActiveUserId) return;
  activeUserLogsLoading = true;
  statusText.textContent = "Loading logs...";
  try {
    const result = await pywebview.api.get_logs_for_user(selectedActiveUserId, 100, activeUserLogsSource, activeUserLogsBefore);
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      activeUserLogsLoading = false;
      return;
    }
    const logs = result.logs || [];
    const table = document.getElementById("active-user-logs-table") || activeUserLogsContainer;
    appendLogRows(table, logs, false);
    btnLoadMoreActiveUser.style.display = result.has_more ? "inline-block" : "none";
    activeUserLogsBefore = result.next_before;
    statusText.textContent = "Loaded";
  } catch (e) {
    statusText.textContent = "Error loading logs";
  }
  activeUserLogsLoading = false;
}

btnLoadMoreActiveUser.addEventListener("click", loadActiveUserLogs);

activeUserLogsSourceSelect.addEventListener("change", () => {
  activeUserLogsSource = activeUserLogsSourceSelect.value;
  if (selectedActiveUserId) resetActiveUserLogs();
});

// "Active anywhere" keeps every user, active ones first, as the tab always has.
// "Active in app" / "Active in web" narrow to users with that activity and
// order them by it.
function applyActiveUserFilter() {
  const q = activeUserSearch.value.trim().toLowerCase();
  let list = activeUsers;
  if (activeUserFilter !== "any") {
    const key = "last_active_" + activeUserFilter;
    list = list.filter((u) => u[key]).sort((a, b) => (a[key] < b[key] ? 1 : -1));
  }
  if (q) {
    list = list.filter((u) =>
      (u.email && u.email.toLowerCase().includes(q)) ||
      (u.display_name && u.display_name.toLowerCase().includes(q))
    );
  }
  filteredActiveUsers = list;
  renderActiveUserList();
}

activeUserSearch.addEventListener("input", applyActiveUserFilter);

activeUserFilterSelect.addEventListener("change", () => {
  activeUserFilter = activeUserFilterSelect.value;
  applyActiveUserFilter();
});

// All logs
async function loadAllLogs() {
  if (allLogsLoading) return;
  allLogsLoading = true;
  allLogsLoaded = true;
  statusText.textContent = "Loading logs...";
  try {
    const result = await pywebview.api.get_all_logs(100, allLogsSource, allLogsBefore, allLogsLevel);
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      allLogsLoading = false;
      return;
    }
    const logs = result.logs || [];
    appendLogRows(allLogsTable, logs, true);
    btnLoadMoreAll.style.display = result.has_more ? "inline-block" : "none";
    allLogsBefore = result.next_before;
    statusText.textContent = "Loaded";
  } catch (e) {
    statusText.textContent = "Error loading logs";
  }
  allLogsLoading = false;
}

function resetAllLogs() {
  allLogsBefore = null;
  allLogsLoaded = false;
  allLogsTable.innerHTML = "";
  btnLoadMoreAll.style.display = "none";
  loadAllLogs();
}

allLogsLevelSelect.addEventListener("change", () => {
  allLogsLevel = allLogsLevelSelect.value;
  resetAllLogs();
});

allLogsSourceSelect.addEventListener("change", () => {
  allLogsSource = allLogsSourceSelect.value;
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

function isTestEmail(email) {
  return !!email && email.toLowerCase().startsWith("testuser@");
}

function isTestUser(userId) {
  if (!userId) return false;
  const u = users.find((u) => u.id === userId);
  return !!u && isTestEmail(u.email);
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
    const source = log.log_source || "app";
    html +=
      '<span class="log-source-badge"><span class="log-source-' + source + '">' + source + "</span></span>" +
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
  html += detailRow("Source", log.log_source === "web" ? "Web" + (log.source ? " (" + log.source + ")" : "") : "App");
  html += detailRow("Level", log.level);
  html += detailRow("Category", log.category);
  html += detailRow("Message", log.message);
  if (log.device_platform) html += detailRow("Platform", log.device_platform);
  if (log.device_version) html += detailRow("Device Version", log.device_version);
  if (log.app_version) html += detailRow("App Version", log.app_version);
  if (log.user_id) html += detailRow("User", getUserLabel(log.user_id));
  if (log.route) html += detailRow("Route", (log.method ? log.method + " " : "") + log.route);
  if (log.status != null) html += detailRow("Status", String(log.status));
  if (log.environment) html += detailRow("Environment", log.environment);
  if (log.deployment_id) html += detailRow("Deployment", log.deployment_id);
  if (log.request_id) html += detailRow("Request ID", log.request_id);
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
const photoOverlay = document.getElementById("visit-photo-overlay");
const photoImg = document.getElementById("visit-photo-img");
const btnClosePhoto = document.getElementById("btn-close-photo");
const btnDownloadPhoto = document.getElementById("btn-download-photo");
let currentPhotoFilename = "visit-photo.jpg";
let currentPhoto = null;

const photoCommentText = document.getElementById("visit-photo-comment-text");
const btnEditPhotoComment = document.getElementById("btn-edit-photo-comment");

function updatePhotoCommentBar() {
  photoCommentText.textContent = (currentPhoto && currentPhoto.comment) || "";
}

btnEditPhotoComment.addEventListener("click", () => {
  if (!currentPhoto) return;
  openEditModal("Edit Photo Description", currentPhoto.comment, async (newValue) => {
    const result = await pywebview.api.update_photo_comment(currentPhoto.id, newValue);
    if (result.error) throw new Error(result.error);
    currentPhoto.comment = newValue;
    updatePhotoCommentBar();
    const dot = document.querySelector('.photo-comment-dot[data-photo-id="' + currentPhoto.id + '"]');
    if (dot) dot.style.display = newValue ? "" : "none";
  });
});

// Generic text edit modal (shared by comments and photo descriptions)
const commentsOverlay = document.getElementById("visit-comments-overlay");
const commentsModalTitle = document.getElementById("visit-comments-modal-title");
const commentsTextarea = document.getElementById("visit-comments-textarea");
const btnSaveComments = document.getElementById("btn-save-comments");
const btnCancelComments = document.getElementById("btn-cancel-comments");
const btnCloseComments = document.getElementById("btn-close-comments");
let editModalSaveFn = null;

function openEditModal(title, currentValue, saveFn) {
  editModalSaveFn = saveFn;
  commentsModalTitle.textContent = title;
  commentsTextarea.value = currentValue || "";
  commentsOverlay.classList.remove("hidden");
  commentsTextarea.focus();
}

function closeEditModal() {
  commentsOverlay.classList.add("hidden");
  editModalSaveFn = null;
}

btnCloseComments.addEventListener("click", closeEditModal);
btnCancelComments.addEventListener("click", closeEditModal);
commentsOverlay.addEventListener("click", (e) => {
  if (e.target === commentsOverlay) closeEditModal();
});

btnSaveComments.addEventListener("click", async () => {
  if (!editModalSaveFn) return;
  btnSaveComments.disabled = true;
  btnSaveComments.textContent = "Saving...";
  try {
    await editModalSaveFn(commentsTextarea.value.trim());
    closeEditModal();
  } catch (e) {
    alert("Save failed: " + e);
  } finally {
    btnSaveComments.disabled = false;
    btnSaveComments.textContent = "Save";
  }
});

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
    visitsHasMore = visits.length >= result.page_size;
    visitsShown += visits.length;
    visitsPage++;
    statusText.textContent =
      visitsShown + " visits loaded" + (visitsHasMore ? " (scroll for more)" : "");
  } catch (e) {
    statusText.textContent = "Error loading visits";
  }
  visitsLoading = false;
  // A short page can leave the sentinel still on screen; keep filling until
  // the list actually overflows or the data runs out.
  if (visitsHasMore && visitsSentinelVisible()) loadVisits();
}

function visitsSentinelVisible() {
  const scroll = document.getElementById("visits-scroll");
  const sentinel = document.getElementById("visits-sentinel");
  if (!scroll || !sentinel || !scroll.offsetHeight) return false;
  return sentinel.getBoundingClientRect().top <= scroll.getBoundingClientRect().bottom + 300;
}

document.getElementById("visits-scroll").addEventListener("scroll", () => {
  if (visitsHasMore && !visitsLoading && visitsSentinelVisible()) loadVisits();
});

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
    html += '<div class="visit-comment"' + (v.public_comments ? "" : ' style="display:none"') + ">" + escapeHtml(v.public_comments || "") + "</div>";

    // Photos
    const photos = v.photos || [];
    if (photos.length > 0) {
      html += '<div class="visit-photos">';
      const safeDate = v.visited_at ? v.visited_at.slice(0, 10) : "unknown-date";
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        html += '<div class="visit-photo-wrap">' +
          '<img class="visit-photo-thumb" src="' + escapeHtml(photo.url) + '" alt="' + escapeHtml(photo.comment || "Visit photo") + '" data-url="' + escapeHtml(photo.url) + '" data-place="' + escapeHtml(name) + '" data-date="' + escapeHtml(safeDate) + '" data-index="' + (i + 1) + '" data-idx="' + i + '">' +
          '<span class="photo-comment-dot" data-photo-id="' + escapeHtml(photo.id) + '" style="' + (photo.comment ? "" : "display:none") + '"></span>' +
        "</div>";
      }
      html += "</div>";
    }

    const isPublished = !!v.published;
    html += '<div class="visit-card-actions">' +
      '<label class="visit-published-toggle">' +
        '<span>Published</span>' +
        '<span class="toggle-switch">' +
          '<input type="checkbox" class="published-checkbox"' + (isPublished ? " checked" : "") + ">" +
          '<span class="toggle-slider"></span>' +
        "</span>" +
      "</label>" +
      '<button class="btn-edit-comments">Edit Comments</button>' +
    "</div>";

    card.innerHTML = html;

    // Attach published toggle handler
    const publishedCheckbox = card.querySelector(".published-checkbox");
    publishedCheckbox.addEventListener("change", async () => {
      publishedCheckbox.disabled = true;
      try {
        const result = await pywebview.api.update_visit_published(v.id, publishedCheckbox.checked);
        if (result.error) {
          alert("Failed to update: " + result.error);
          publishedCheckbox.checked = !publishedCheckbox.checked;
        }
      } catch (e) {
        alert("Failed to update: " + e);
        publishedCheckbox.checked = !publishedCheckbox.checked;
      } finally {
        publishedCheckbox.disabled = false;
      }
    });

    // Attach edit comments handler
    const commentEl = card.querySelector(".visit-comment");
    card.querySelector(".btn-edit-comments").addEventListener("click", () => {
      openEditModal("Edit Comments", commentEl.textContent, async (newValue) => {
        const result = await pywebview.api.update_visit_comments(v.id, newValue);
        if (result.error) throw new Error(result.error);
        commentEl.textContent = newValue;
        commentEl.style.display = newValue ? "" : "none";
      });
    });

    // Attach click handlers to photo thumbnails and description edit buttons
    card.querySelectorAll(".visit-photo-thumb").forEach((thumb) => {
      thumb.addEventListener("click", () => {
        currentPhoto = photos[parseInt(thumb.dataset.idx)];
        photoImg.src = thumb.dataset.url;
        currentPhotoFilename = buildPhotoFilename(thumb.dataset.place, thumb.dataset.date, thumb.dataset.index, thumb.dataset.url);
        updatePhotoCommentBar();
        photoOverlay.classList.remove("hidden");
      });
    });

    visitsList.appendChild(card);
  }
}

function closePhotoOverlay() {
  photoOverlay.classList.add("hidden");
  photoImg.src = "";
  currentPhoto = null;
}

btnClosePhoto.addEventListener("click", closePhotoOverlay);

photoOverlay.addEventListener("click", (e) => {
  if (e.target === photoOverlay) closePhotoOverlay();
});

btnDownloadPhoto.addEventListener("click", async () => {
  if (!photoImg.src) return;
  btnDownloadPhoto.disabled = true;
  btnDownloadPhoto.textContent = "Downloading…";
  try {
    const result = await pywebview.api.download_visit_photo(photoImg.src, currentPhotoFilename);
    if (result.error) {
      alert("Download failed: " + result.error);
    }
  } catch (e) {
    alert("Download failed: " + e);
  } finally {
    btnDownloadPhoto.disabled = false;
    btnDownloadPhoto.innerHTML = "&#x2B07; Download";
  }
});

function buildPhotoFilename(place, date, index, url) {
  const slugPlace = (place || "visit-photo")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safeDate = (date || "").replace(/[^0-9-]/g, "") || "unknown-date";
  const ext = (url || "").split("?")[0].match(/\.([a-z0-9]+)$/i);
  const extension = ext ? "." + ext[1].toLowerCase() : ".jpg";
  return slugPlace + "_" + safeDate + "_" + (index || 1) + extension;
}

// Subscriptions
const subsTableBody = document.getElementById("subs-table-body");
const btnLoadMoreSubs = document.getElementById("btn-load-more-subs");
const subsStatusSelect = document.getElementById("subs-status");
const subsSummary = document.getElementById("subs-summary");
let subsShown = 0;

async function loadSubscriptions() {
  if (subsLoading) return;
  subsLoading = true;
  subsLoaded = true;
  statusText.textContent = "Loading subscriptions...";
  try {
    const result = await pywebview.api.get_subscriptions(subsPage, 50, subsStatus);
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      subsLoading = false;
      return;
    }
    const rows = result.subscriptions || [];
    const visible = rows.filter((s) => !isTestUser(s.user_id));
    appendSubscriptionRows(visible);
    subsShown += visible.length;
    // Page on what the server returned, not on what survived the test-user
    // filter — otherwise a page containing test accounts stops Load More early
    btnLoadMoreSubs.style.display = rows.length >= result.page_size ? "inline-block" : "none";
    subsPage++;
    subsSummary.textContent = subsShown + " shown";
    statusText.textContent = subsShown + " subscriptions loaded";
  } catch (e) {
    statusText.textContent = "Error loading subscriptions";
  }
  subsLoading = false;
}

function appendSubscriptionRows(subs) {
  const now = Date.now();
  for (const s of subs) {
    // A row still flagged subscribed past its expiry means the app hasn't
    // re-checked with the store yet — worth showing rather than hiding
    const expired = s.expires_at && new Date(s.expires_at).getTime() < now;
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + (s.first_subscribed_at ? formatDate(s.first_subscribed_at) : "—") + "</td>" +
      "<td>" + escapeHtml(getUserLabel(s.user_id)) + "</td>" +
      '<td><span class="sub-type-badge sub-type-' + s.subscription_type + '">' +
        escapeHtml(s.subscription_type) + "</span></td>" +
      '<td><span class="sub-status-badge sub-status-' + (s.is_subscribed ? "active" : "lapsed") + '">' +
        (s.is_subscribed ? "Active" : "Lapsed") + "</span></td>" +
      '<td class="' + (expired && s.is_subscribed ? "sub-expired" : "") + '">' +
        (s.expires_at ? formatDate(s.expires_at) : "—") +
        (expired && s.is_subscribed ? " (expired)" : "") + "</td>" +
      "<td>" + escapeHtml(s.platform || "—") + "</td>";
    tr.title =
      "Product: " + (s.product_id || "—") +
      "\nLast checked: " + (s.last_checked_at ? formatDateTime(s.last_checked_at) : "—") +
      "\nUpdated: " + (s.updated_at ? formatDateTime(s.updated_at) : "—");
    subsTableBody.appendChild(tr);
  }
}

function resetSubscriptions() {
  subsPage = 1;
  subsShown = 0;
  subsTableBody.innerHTML = "";
  btnLoadMoreSubs.style.display = "none";
  loadSubscriptions();
}

subsStatusSelect.addEventListener("change", () => {
  subsStatus = subsStatusSelect.value;
  resetSubscriptions();
});

btnLoadMoreSubs.addEventListener("click", loadSubscriptions);

// Tag explorer
const tagsTableBody = document.getElementById("tags-table-body");
const tagsSearchInput = document.getElementById("tags-search");
const tagsUserSelect = document.getElementById("tags-user");
const tagsApprovedSelect = document.getElementById("tags-approved");
const btnLoadMoreTags = document.getElementById("btn-load-more-tags");

async function loadTagUsers() {
  try {
    const result = await pywebview.api.get_place_tag_users();
    if (result.error) return;
    (result.user_ids || [])
      .map((id) => ({ id: id, label: getUserLabel(id) }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .forEach((u) => {
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = u.label;
        tagsUserSelect.appendChild(opt);
      });
  } catch (e) {
    // Filter stays as "All" if the lookup fails
  }
}

async function loadPlaceTags() {
  if (tagsLoading) return;
  tagsLoading = true;
  tagsLoaded = true;
  statusText.textContent = "Loading tags...";
  try {
    const result = await pywebview.api.get_place_tags(
      tagsPage, 50, tagsSearch, tagsUserId, tagsApproved
    );
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      tagsLoading = false;
      return;
    }
    const rows = result.place_tags || [];
    appendTagRows(rows);
    btnLoadMoreTags.style.display = rows.length >= result.page_size ? "inline-block" : "none";
    tagsPage++;
    statusText.textContent = rows.length + " tag assignments loaded";
  } catch (e) {
    statusText.textContent = "Error loading tags";
  }
  tagsLoading = false;
}

function appendTagRows(rows) {
  for (const r of rows) {
    const location = [r.place_town, r.place_county].filter(Boolean).join(", ");
    const tagClass = "tag-chip" + (r.tag_approved ? "" : " tag-unapproved");
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + formatDateTime(r.created_at) + "</td>" +
      '<td><div class="tag-place-name">' + escapeHtml(r.place_name) + "</div>" +
      (location ? '<div class="tag-place-location">' + escapeHtml(location) + "</div>" : "") +
      "</td>" +
      '<td><span class="' + tagClass + '">' + escapeHtml(r.tag_name) + "</span>" +
      (r.tag_category ? '<span class="tag-category">' + escapeHtml(r.tag_category) + "</span>" : "") +
      (r.tag_approved ? "" : '<span class="tag-pending">pending</span>') +
      "</td>" +
      "<td>" + escapeHtml(r.created_by ? getUserLabel(r.created_by) : "—") + "</td>";
    tagsTableBody.appendChild(tr);
  }
}

function resetPlaceTags() {
  tagsPage = 1;
  tagsTableBody.innerHTML = "";
  btnLoadMoreTags.style.display = "none";
  loadPlaceTags();
}

tagsSearchInput.addEventListener("input", () => {
  clearTimeout(tagsSearchTimer);
  tagsSearchTimer = setTimeout(() => {
    tagsSearch = tagsSearchInput.value.trim();
    resetPlaceTags();
  }, 300);
});

tagsUserSelect.addEventListener("change", () => {
  tagsUserId = tagsUserSelect.value;
  resetPlaceTags();
});

tagsApprovedSelect.addEventListener("change", () => {
  tagsApproved = tagsApprovedSelect.value;
  resetPlaceTags();
});

btnLoadMoreTags.addEventListener("click", loadPlaceTags);

// Tag moderation — mirrors the app's Admin: Tags page (AdminTagsPage).
// Categories and colours come from TagCategoryRegistry.
const TAG_CATEGORIES = [
  { name: "Practical", color: "#3B82F6" },
  { name: "Accessibility", color: "#22C55E" },
  { name: "Period", color: "#D97706" },
  { name: "Type", color: "#6366F1" },
  { name: "Affiliation", color: "#A855F7" },
  { name: "Feature", color: "#EC4899" },
];

let pendingTags = [];
let removalRequests = [];
let approvedTags = [];
let pendingLoaded = false;
let removalsLoaded = false;

const pendingList = document.getElementById("pending-list");
const removalsList = document.getElementById("removals-list");
const pendingCount = document.getElementById("pending-count");
const removalsCount = document.getElementById("removals-count");

// Sub-tab bars are scoped to their own tab, so the tags and visits groups
// don't clear each other's selection.
document.querySelectorAll(".subtabs").forEach((bar) => {
  const group = bar.parentElement;
  bar.querySelectorAll(".subtab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      bar.querySelectorAll(".subtab-btn").forEach((b) => b.classList.remove("active"));
      group.querySelectorAll(".subtab-content").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("subtab-" + btn.dataset.subtab).classList.add("active");
      onSubtabShown(btn.dataset.subtab);
    });
  });
});

function onSubtabShown(name) {
  if (name === "pending" && !pendingLoaded) loadPendingTags();
  if (name === "removals" && !removalsLoaded) loadRemovalRequests();
  if (name === "visit-map") showVisitMap();
}

function categoryColor(name) {
  const found = TAG_CATEGORIES.find((c) => c.name === name);
  return found ? found.color : "#6B7280";
}

function usageTotal(tag) {
  return (
    (tag.place_usage_count || 0) + (tag.nhle_usage_count || 0) + (tag.cadw_usage_count || 0)
  );
}

async function loadPendingTags() {
  pendingLoaded = true;
  pendingList.innerHTML = '<div class="moderation-empty">Loading...</div>';
  try {
    const result = await pywebview.api.get_pending_tags(100, 0);
    if (result.error) {
      pendingList.innerHTML = '<div class="moderation-empty">' + escapeHtml(result.error) + "</div>";
      return;
    }
    pendingTags = result.tags || [];
    renderPendingTags();
  } catch (e) {
    pendingList.innerHTML = '<div class="moderation-empty">Error loading suggestions</div>';
  }
}

function renderPendingTags() {
  pendingCount.textContent = pendingTags.length ? pendingTags.length : "";
  if (!pendingTags.length) {
    pendingList.innerHTML = '<div class="moderation-empty">No pending tag suggestions</div>';
    return;
  }
  pendingList.innerHTML = "";
  pendingTags.forEach((tag) => {
    const usage = usageTotal(tag);
    const card = document.createElement("div");
    card.className = "moderation-card";
    card.innerHTML =
      '<div class="moderation-row">' +
      '<span class="moderation-name">' + escapeHtml(tag.name) + "</span>" +
      '<span class="moderation-date">' + formatDateTime(tag.created_at) + "</span>" +
      "</div>" +
      '<div class="moderation-meta">Category: ' +
      (tag.category
        ? '<span class="moderation-category" style="background:' +
          categoryColor(tag.category) + '">' + escapeHtml(tag.category) + "</span>"
        : "none") +
      "</div>" +
      '<div class="moderation-meta">Suggested by ' +
      escapeHtml(tag.suggester_email || (tag.created_by ? getUserLabel(tag.created_by) : "unknown")) +
      "</div>" +
      '<div class="moderation-meta">In use: ' + usage + "</div>";

    const actions = document.createElement("div");
    actions.className = "moderation-actions";
    actions.appendChild(makeButton("Approve", "btn-approve", () => openApprove(tag)));
    actions.appendChild(makeButton("Merge", "btn-merge", () => openMerge(tag)));
    actions.appendChild(makeButton("Reject", "btn-reject", () => openReject(tag, usage)));
    card.appendChild(actions);
    pendingList.appendChild(card);
  });
}

function makeButton(label, className, onClick) {
  const btn = document.createElement("button");
  btn.className = "moderation-btn " + className;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

async function loadRemovalRequests() {
  removalsLoaded = true;
  removalsList.innerHTML = '<div class="moderation-empty">Loading...</div>';
  try {
    const result = await pywebview.api.get_tag_removal_requests(100, 0);
    if (result.error) {
      removalsList.innerHTML =
        '<div class="moderation-empty">' + escapeHtml(result.error) + "</div>";
      return;
    }
    removalRequests = result.requests || [];
    renderRemovalRequests();
  } catch (e) {
    removalsList.innerHTML = '<div class="moderation-empty">Error loading removal requests</div>';
  }
}

function renderRemovalRequests() {
  removalsCount.textContent = removalRequests.length ? removalRequests.length : "";
  if (!removalRequests.length) {
    removalsList.innerHTML = '<div class="moderation-empty">No removal requests</div>';
    return;
  }
  removalsList.innerHTML = "";
  removalRequests.forEach((req) => {
    const card = document.createElement("div");
    card.className = "moderation-card";
    card.innerHTML =
      '<div class="moderation-row">' +
      '<span class="moderation-name">' + escapeHtml(req.tag_name || "") + "</span>" +
      '<span class="moderation-date">' + formatDateTime(req.created_at) + "</span>" +
      "</div>" +
      '<div class="moderation-meta">Item: ' + escapeHtml(req.item_name || "—") + "</div>" +
      '<div class="moderation-meta">From: ' + escapeHtml(req.requester_email || "—") + "</div>" +
      '<div class="moderation-meta">Reason: ' + escapeHtml(req.reason || "—") + "</div>";

    const actions = document.createElement("div");
    actions.className = "moderation-actions";
    actions.appendChild(makeButton("Remove Tag", "btn-reject", () => openExecuteRemoval(req)));
    actions.appendChild(makeButton("Dismiss", "btn-dismiss", () => openDismissRemoval(req)));
    card.appendChild(actions);
    removalsList.appendChild(card);
  });
}

// Shared confirm/pick dialog for every moderation action
const tagActionOverlay = document.getElementById("tag-action-overlay");
const tagActionTitle = document.getElementById("tag-action-title");
const tagActionMessage = document.getElementById("tag-action-message");
const tagActionSelect = document.getElementById("tag-action-select");
const tagActionStatus = document.getElementById("tag-action-status");
const btnTagActionConfirm = document.getElementById("btn-tag-action-confirm");
let tagActionHandler = null;

function openTagAction(opts) {
  tagActionTitle.textContent = opts.title;
  tagActionMessage.textContent = opts.message;
  tagActionStatus.textContent = "";
  btnTagActionConfirm.textContent = opts.confirmLabel || "Confirm";
  btnTagActionConfirm.className = opts.danger ? "danger" : "";
  if (opts.options) {
    tagActionSelect.innerHTML = "";
    opts.options.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      tagActionSelect.appendChild(opt);
    });
    tagActionSelect.style.display = "block";
  } else {
    tagActionSelect.style.display = "none";
  }
  tagActionHandler = opts.onConfirm;
  tagActionOverlay.classList.remove("hidden");
}

function closeTagAction() {
  tagActionOverlay.classList.add("hidden");
  tagActionHandler = null;
}

btnTagActionConfirm.addEventListener("click", async () => {
  if (!tagActionHandler) return;
  btnTagActionConfirm.disabled = true;
  tagActionStatus.textContent = "Working...";
  try {
    const error = await tagActionHandler(tagActionSelect.value);
    if (error) {
      tagActionStatus.textContent = error;
      return;
    }
    closeTagAction();
  } finally {
    btnTagActionConfirm.disabled = false;
  }
});

document.getElementById("btn-close-tag-action").addEventListener("click", closeTagAction);
document.getElementById("btn-tag-action-cancel").addEventListener("click", closeTagAction);
tagActionOverlay.addEventListener("click", (e) => {
  if (e.target === tagActionOverlay) closeTagAction();
});

function dropPendingTag(tagId) {
  pendingTags = pendingTags.filter((t) => t.id !== tagId);
  renderPendingTags();
}

function dropRemovalRequest(requestId) {
  removalRequests = removalRequests.filter((r) => r.id !== requestId);
  renderRemovalRequests();
}

function openApprove(tag) {
  openTagAction({
    title: "Approve tag",
    message: 'Approve "' + tag.name + '" — pick a category:',
    options: TAG_CATEGORIES.map((c) => ({ value: c.name, label: c.name })),
    confirmLabel: "Approve",
    onConfirm: async (category) => {
      const result = await pywebview.api.approve_tag(tag.id, category);
      if (result.error) return result.error;
      dropPendingTag(tag.id);
      statusText.textContent = 'Approved "' + tag.name + '" as ' + category;
      return null;
    },
  });
}

function openReject(tag, usage) {
  openTagAction({
    title: "Reject tag?",
    message: usage
      ? '"' + tag.name + '" is in use by ' + usage +
        " item(s). Rejecting will remove all usages."
      : 'Delete pending tag "' + tag.name + '"?',
    confirmLabel: "Reject",
    danger: true,
    onConfirm: async () => {
      const result = await pywebview.api.reject_tag(tag.id);
      if (result.error) return result.error;
      dropPendingTag(tag.id);
      statusText.textContent = 'Rejected "' + tag.name + '"';
      return null;
    },
  });
}

async function openMerge(tag) {
  if (!approvedTags.length) {
    const result = await pywebview.api.get_approved_tags();
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      return;
    }
    approvedTags = result.tags || [];
  }
  const targets = approvedTags.filter((t) => t.id !== tag.id);
  if (!targets.length) {
    statusText.textContent = "No approved tags exist to merge into";
    return;
  }
  openTagAction({
    title: "Merge tag",
    message:
      'All "' + tag.name + '" usages will be re-pointed to the tag you pick, and "' +
      tag.name + '" will be deleted.',
    options: targets.map((t) => ({
      value: t.id,
      label: t.category ? t.name + "  (" + t.category + ")" : t.name,
    })),
    confirmLabel: "Merge",
    onConfirm: async (targetId) => {
      const result = await pywebview.api.merge_tag(tag.id, targetId);
      if (result.error) return result.error;
      dropPendingTag(tag.id);
      const target = targets.find((t) => t.id === targetId);
      statusText.textContent =
        'Merged "' + tag.name + '" into "' + (target ? target.name : "tag") + '"';
      return null;
    },
  });
}

function openExecuteRemoval(req) {
  openTagAction({
    title: "Remove tag from item?",
    message:
      'Remove "' + (req.tag_name || "") + '" from "' + (req.item_name || "this item") +
      '". The tag itself is kept.',
    confirmLabel: "Remove Tag",
    danger: true,
    onConfirm: async () => {
      const result = await pywebview.api.execute_removal_request(req.id);
      if (result.error) return result.error;
      dropRemovalRequest(req.id);
      statusText.textContent = 'Removed "' + (req.tag_name || "tag") + '"';
      return null;
    },
  });
}

function openDismissRemoval(req) {
  openTagAction({
    title: "Dismiss request?",
    message:
      'Keep "' + (req.tag_name || "") + '" on "' + (req.item_name || "this item") +
      '" and drop the request.',
    confirmLabel: "Dismiss",
    onConfirm: async () => {
      const result = await pywebview.api.dismiss_removal_request(req.id);
      if (result.error) return result.error;
      dropRemovalRequest(req.id);
      statusText.textContent = "Dismissed removal request";
      return null;
    },
  });
}

// Dashboard
const dashRangeSelect = document.getElementById("dash-range");
const dashPeriodLabel = document.getElementById("dash-period-label");
const dashStats = document.getElementById("dash-stats");
const dashChartSub = document.getElementById("dash-chart-sub");
const signupsChart = document.getElementById("signups-chart");
const dashSubStats = document.getElementById("dash-sub-stats");
const dashSubChartSub = document.getElementById("dash-sub-chart-sub");
const subsSignupsChart = document.getElementById("subs-signups-chart");
const btnDashPrev = document.getElementById("btn-dash-prev");
const btnDashNext = document.getElementById("btn-dash-next");
const btnDashToday = document.getElementById("btn-dash-today");
const dashIncludeTestCheck = document.getElementById("dash-include-test");

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfWeek(d) {
  const s = startOfDay(d);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); // Monday-start
  return s;
}

// Signup dates of the users the chart should count, as local Date objects
function signupDates() {
  const dates = [];
  for (const u of users) {
    if (!dashIncludeTest && isTestEmail(u.email)) continue;
    if (!u.created_at) continue;
    const d = new Date(u.created_at);
    if (!isNaN(d.getTime())) dates.push(d);
  }
  return dates;
}

// When each subscriber first subscribed, same filtering rules as sign-ups
function subscriptionDates() {
  const dates = [];
  for (const s of subscriptionRows) {
    if (!dashIncludeTest && isTestUser(s.user_id)) continue;
    if (!s.first_subscribed_at) continue;
    const d = new Date(s.first_subscribed_at);
    if (!isNaN(d.getTime())) dates.push(d);
  }
  return dates;
}

async function loadSubscriptionStarts() {
  try {
    const result = await pywebview.api.get_subscription_starts();
    subscriptionsLoadError = result.error || "";
    subscriptionRows = result.subscriptions || [];
  } catch (e) {
    subscriptionsLoadError = String(e);
    subscriptionRows = [];
  }
  renderDashboard();
}

// Calendar-aligned window for the current range/offset.
// offset 0 = the period containing today, -1 = the one before it.
function getPeriodWindow(range, offset) {
  const now = new Date();
  if (range === "week") {
    const start = startOfWeek(now);
    start.setDate(start.getDate() + offset * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const last = new Date(end);
    last.setDate(last.getDate() - 1);
    const label =
      start.getDate() + " " + MONTHS_SHORT[start.getMonth()] +
      " – " + last.getDate() + " " + MONTHS_SHORT[last.getMonth()] + " " + last.getFullYear();
    return { start: start, end: end, bucket: "day", label: label };
  }
  if (range === "month") {
    const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
    return {
      start: start,
      end: end,
      bucket: "day",
      label: start.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    };
  }
  if (range === "year") {
    const start = new Date(now.getFullYear() + offset, 0, 1);
    const end = new Date(now.getFullYear() + offset + 1, 0, 1);
    return { start: start, end: end, bucket: "month", label: String(start.getFullYear()) };
  }
  // All time — from the month of the earliest record in either series through
  // the current month, so both charts cover the same span
  const dates = signupDates().concat(subscriptionDates());
  const first = dates.reduce((min, d) => (d < min ? d : min), dates[0] || now);
  const start = new Date(first.getFullYear(), first.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { start: start, end: end, bucket: "month", label: "All time" };
}

function bucketKey(d, bucket) {
  return bucket === "day"
    ? d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate()
    : d.getFullYear() + "-" + d.getMonth();
}

// Every bucket in the window, pre-seeded at zero so quiet days still show a gap
function bucketSignups(win, dates) {
  const buckets = [];
  const index = new Map();
  const cur = new Date(win.start);
  while (cur < win.end) {
    index.set(bucketKey(cur, win.bucket), buckets.length);
    buckets.push({ date: new Date(cur), count: 0 });
    if (win.bucket === "day") cur.setDate(cur.getDate() + 1);
    else cur.setMonth(cur.getMonth() + 1);
  }
  for (const d of dates) {
    const i = index.get(bucketKey(d, win.bucket));
    if (i !== undefined) buckets[i].count++;
  }
  return buckets;
}

// Round the axis up to a whole-number 1/2/5 step, ~5 gridlines
function niceScale(max) {
  if (max <= 0) return { max: 1, step: 1 };
  const raw = max / 5;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  const step = Math.max(1, Math.round((f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp));
  return { max: Math.ceil(max / step) * step, step: step };
}

function bucketLabel(b, bucket) {
  return bucket === "day"
    ? DAYS_SHORT[b.date.getDay()] + " " + b.date.getDate() + " " + MONTHS_SHORT[b.date.getMonth()]
    : b.date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// Sparse x labels — enough to orient, never enough to collide
function xLabelFor(b, i, buckets, bucket) {
  const n = buckets.length;
  const last = n - 1;
  if (bucket === "day") {
    if (n <= 7) return DAYS_SHORT[b.date.getDay()] + " " + b.date.getDate();
    if (n <= 10) return String(b.date.getDate());
    const day = b.date.getDate();
    if (i === 0 || i === last || day % 5 === 0) return String(day);
    return "";
  }
  if (n <= 12) return MONTHS_SHORT[b.date.getMonth()];
  if (i === 0 || i === last || b.date.getMonth() % 3 === 0) {
    return b.date.getMonth() === 0 || i === 0
      ? MONTHS_SHORT[b.date.getMonth()] + " " + String(b.date.getFullYear()).slice(2)
      : MONTHS_SHORT[b.date.getMonth()];
  }
  return "";
}

function renderDashboard() {
  const win = getPeriodWindow(dashRange, dashOffset);

  dashPeriodLabel.textContent = win.label;
  btnDashPrev.disabled = dashRange === "all";
  btnDashNext.disabled = dashRange === "all" || dashOffset >= 0;
  btnDashToday.disabled = dashRange === "all" || dashOffset === 0;

  // Both sections share one period window, so the two charts always line up
  renderMetricSection(
    {
      statsEl: dashStats,
      subEl: dashChartSub,
      chartEl: signupsChart,
      plural: "sign-ups",
      singular: "sign-up",
      hasData: users.length > 0,
      emptyMessage: "No sign-up data available.",
    },
    win,
    signupDates()
  );

  renderMetricSection(
    {
      statsEl: dashSubStats,
      subEl: dashSubChartSub,
      chartEl: subsSignupsChart,
      plural: "subscriptions",
      singular: "subscription",
      hasData: subscriptionRows.length > 0,
      emptyMessage: subscriptionsLoadError
        ? "Could not load subscriptions: " + subscriptionsLoadError
        : "No subscription data available.",
      extraTile: activeSubscriberTile,
    },
    win,
    subscriptionDates()
  );
}

// Renders one "stat row + bar chart" pair for a single metric over the window
function renderMetricSection(cfg, win, dates) {
  const buckets = bucketSignups(win, dates);
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const unit = win.bucket === "day" ? "day" : "month";
  const inProgress = dashRange !== "all" && new Date() < win.end;

  // Previous period, for the trend line on the total tile
  let delta = null;
  if (dashRange !== "all") {
    const prevWin = getPeriodWindow(dashRange, dashOffset - 1);
    // A period still running is only comparable to the same elapsed slice of
    // the one before it — otherwise a 1-day-old week always "falls" 100%
    // against a complete one.
    const prevEnd = inProgress
      ? new Date(prevWin.start.getTime() + (Date.now() - win.start.getTime()))
      : prevWin.end;
    const prevTotal = dates.filter((d) => d >= prevWin.start && d < prevEnd).length;
    delta = { prev: prevTotal, diff: total - prevTotal, inProgress: inProgress };
  }

  renderStats(cfg, buckets, total, unit, delta, dashRange);

  cfg.subEl.textContent =
    "Per " + unit + " · " + win.label +
    (inProgress ? " (in progress)" : "") +
    (dashIncludeTest ? "" : " · excluding test accounts");

  if (!cfg.hasData) {
    cfg.chartEl.innerHTML = '<div class="dash-empty">' + escapeHtml(cfg.emptyMessage) + "</div>";
    return;
  }
  renderBarChart(cfg.chartEl, buckets, win, cfg.singular);
}

function renderStats(cfg, buckets, total, unit, delta, range) {
  let peak = null;
  for (const b of buckets) {
    if (!peak || b.count > peak.count) peak = b;
  }
  const avg = buckets.length ? total / buckets.length : 0;

  let deltaSub = "";
  if (delta) {
    const against = delta.inProgress
      ? "same point last " + range
      : "previous " + range;
    if (delta.diff === 0) {
      deltaSub = "Same as " + against;
    } else {
      const pct = delta.prev ? Math.round((delta.diff / delta.prev) * 100) : null;
      deltaSub =
        (delta.diff > 0 ? "▲ " : "▼ ") + Math.abs(delta.diff) +
        (pct === null ? "" : " (" + Math.abs(pct) + "%)") + " vs " + against;
    }
  }

  cfg.statsEl.innerHTML =
    statTile("Total " + cfg.plural, String(total), deltaSub) +
    statTile("Average per " + unit, avg.toFixed(avg >= 10 ? 0 : 1), buckets.length + " " + unit + "s in range") +
    statTile(
      "Best " + unit,
      peak && peak.count ? String(peak.count) : "0",
      peak && peak.count ? bucketLabel(peak, unit) : "No " + cfg.plural + " in range"
    ) +
    (cfg.extraTile ? cfg.extraTile() : "");
}

// Current state, deliberately not scoped to the selected period
function activeSubscriberTile() {
  let active = 0;
  for (const s of subscriptionRows) {
    if (!dashIncludeTest && isTestUser(s.user_id)) continue;
    if (s.is_subscribed) active++;
  }
  return statTile("Active subscribers", String(active), "Right now, all time");
}

function statTile(label, value, sub) {
  return (
    '<div class="stat-tile">' +
    '<div class="stat-label">' + escapeHtml(label) + "</div>" +
    '<div class="stat-value">' + escapeHtml(value) + "</div>" +
    (sub ? '<div class="stat-sub">' + escapeHtml(sub) + "</div>" : "") +
    "</div>"
  );
}

function renderBarChart(chartEl, buckets, win, noun) {
  const maxCount = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  const scale = niceScale(maxCount);
  // Keep a step of headroom so the peak bar never touches the ceiling and its
  // direct label stays inside the plot
  if (scale.max === maxCount) scale.max += scale.step;
  const peakIndex = maxCount > 0 ? buckets.findIndex((b) => b.count === maxCount) : -1;

  chartEl.innerHTML = "";

  const plot = document.createElement("div");
  plot.className = "chart-plot";

  // Gridlines, top down
  for (let v = scale.max; v >= 0; v -= scale.step) {
    const line = document.createElement("div");
    line.className = "chart-gridline" + (v === 0 ? " is-base" : "");
    line.style.bottom = (v / scale.max) * 100 + "%";
    line.innerHTML = "<span>" + v + "</span>";
    plot.appendChild(line);
  }

  const bars = document.createElement("div");
  bars.className = "chart-bars";

  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip hidden";

  buckets.forEach((b, i) => {
    const col = document.createElement("div");
    col.className = "chart-col" + (b.count === 0 ? " is-empty" : "");
    const dateLabel = bucketLabel(b, win.bucket);
    col.title = dateLabel + ": " + b.count + " " + noun + (b.count === 1 ? "" : "s");

    if (b.count > 0) {
      const bar = document.createElement("div");
      bar.className = "chart-bar";
      bar.style.height = (b.count / scale.max) * 100 + "%";
      // Direct-label the peak only; everything else is on hover
      if (i === peakIndex) {
        const tag = document.createElement("span");
        tag.className = "chart-peak-label";
        tag.textContent = b.count;
        bar.appendChild(tag);
      }
      col.appendChild(bar);
    }

    // The whole column is the hit target, so short bars stay easy to hover
    col.addEventListener("mouseenter", () => {
      tooltip.innerHTML =
        '<div class="chart-tooltip-date">' + escapeHtml(dateLabel) + "</div>" +
        "<div>" + b.count + " " + noun + (b.count === 1 ? "" : "s") + "</div>";
      tooltip.classList.remove("hidden");
      tooltip.style.left = col.offsetLeft + col.offsetWidth / 2 + 36 + "px";
      // Anchor to the top of the bar, not the top of the plot
      tooltip.style.top = col.offsetHeight * (1 - b.count / scale.max) + "px";
    });
    col.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));

    bars.appendChild(col);
  });

  plot.appendChild(bars);
  chartEl.appendChild(plot);
  chartEl.appendChild(tooltip);

  const xLabels = document.createElement("div");
  xLabels.className = "chart-x-labels";
  buckets.forEach((b, i) => {
    const el = document.createElement("div");
    el.className = "chart-x-label";
    el.textContent = xLabelFor(b, i, buckets, win.bucket);
    xLabels.appendChild(el);
  });
  chartEl.appendChild(xLabels);
}

dashRangeSelect.addEventListener("change", () => {
  dashRange = dashRangeSelect.value;
  dashOffset = 0;
  renderDashboard();
});

btnDashPrev.addEventListener("click", () => {
  dashOffset--;
  renderDashboard();
});

btnDashNext.addEventListener("click", () => {
  if (dashOffset < 0) dashOffset++;
  renderDashboard();
});

btnDashToday.addEventListener("click", () => {
  dashOffset = 0;
  renderDashboard();
});

dashIncludeTestCheck.addEventListener("change", () => {
  dashIncludeTest = dashIncludeTestCheck.checked;
  renderDashboard();
});

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

// Visit map — layer colours mirror NationalDatasetRegistry (NHLE) and the
// Cadw entry in PlaceDatasetRegistry.
const VISIT_LAYERS = [
  { key: "place", label: "Places", color: "#22C55E", kind: "place" },
  { key: "nhle-0", label: "Listed Buildings", color: "#FF8C00", kind: "nhle", layerId: 0 },
  { key: "nhle-6", label: "Scheduled Monuments", color: "#577399", kind: "nhle", layerId: 6 },
  { key: "nhle-7", label: "Parks & Gardens", color: "#2E8B57", kind: "nhle", layerId: 7 },
  { key: "nhle-8", label: "Battlefields", color: "#DC143C", kind: "nhle", layerId: 8 },
  { key: "nhle-9", label: "Protected Wrecks", color: "#4169E1", kind: "nhle", layerId: 9 },
  { key: "nhle-10", label: "World Heritage Sites", color: "#9932CC", kind: "nhle", layerId: 10 },
  { key: "nhle-other", label: "NHLE (other)", color: "#94A3B8", kind: "nhle", layerId: null },
  { key: "cadw", label: "Cadw", color: "#14382E", kind: "cadw" },
];

const VISIT_PIN_SVG =
  '<svg width="28" height="28" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M16 1c5.3 0 9.6 4.3 9.6 9.6 0 1.7-0.4 3.3-1.3 4.8L16 29.8 7.7 15.4c-0.8-1.5-1.3-3.1-1.3-4.8C6.4 5.3 10.7 1 16 1z" fill="{COLOR}"/>' +
  '<circle cx="16" cy="10.7" r="3.7" fill="#FFFFFF"/>' +
  "</svg>";

let visitMap = null;
let visitMapLoaded = false;
let visitRecords = []; // { visit, marker, key }
const visitLayerGroups = {};
const visitLayerEnabled = {};
const visitLayerIcons = {};
let visitMapPeriod = "all";
let visitMapUserId = "";

const visitMapSummary = document.getElementById("visit-map-summary");
const visitMapPeriodSelect = document.getElementById("visit-map-period");
const visitMapUserSelect = document.getElementById("visit-map-user");
const visitLayerList = document.getElementById("visit-layer-list");

function visitLayerKey(visit) {
  if (visit.kind === "place") return "place";
  if (visit.kind === "cadw") return "cadw";
  const match = VISIT_LAYERS.find(
    (l) => l.kind === "nhle" && l.layerId !== null && l.layerId === visit.layer_id
  );
  return match ? match.key : "nhle-other";
}

async function showVisitMap() {
  if (visitMapLoaded) {
    // Leaflet needs a nudge after being shown in a previously hidden container
    visitMap.invalidateSize();
    return;
  }
  visitMapLoaded = true;
  initVisitMap();
  statusText.textContent = "Loading visits for map...";
  try {
    const result = await pywebview.api.get_visits_for_map();
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      return;
    }
    addVisitMarkers(result.visits || []);
    populateVisitUserFilter();
    applyVisitFilters();
    visitMap.invalidateSize();
    statusText.textContent = visitRecords.length + " visits mapped";
  } catch (e) {
    statusText.textContent = "Error loading visits for map";
  }
}

function initVisitMap() {
  visitMap = L.map("visit-map").setView([54.5, -3.0], 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(visitMap);

  VISIT_LAYERS.forEach((layer) => {
    visitLayerGroups[layer.key] = L.layerGroup().addTo(visitMap);
    visitLayerEnabled[layer.key] = true;
    visitLayerIcons[layer.key] = L.divIcon({
      html: VISIT_PIN_SVG.replace("{COLOR}", layer.color),
      className: "place-pin",
      iconSize: [28, 28],
      iconAnchor: [14, 26],
    });
  });
  renderVisitLayerList();
}

function addVisitMarkers(visits) {
  visits.forEach((visit) => {
    const key = visitLayerKey(visit);
    const marker = L.marker([visit.latitude, visit.longitude], {
      icon: visitLayerIcons[key],
      title: visit.name,
    });
    marker.bindPopup(visitPopupHtml(visit));
    visitRecords.push({ visit: visit, marker: marker, key: key });
  });
}

function visitPopupHtml(visit) {
  const who = visit.user_id ? getUserLabel(visit.user_id) : "unknown";
  const stars = visit.rating ? " · " + "★".repeat(visit.rating) : "";
  return (
    '<div class="visit-popup-name">' + escapeHtml(visit.name || "(unnamed)") + "</div>" +
    '<div class="visit-popup-meta">' + formatDate(visit.visited_at) + stars + "</div>" +
    '<div class="visit-popup-meta">' + escapeHtml(who) + "</div>"
  );
}

// Period filter. Boundaries are local-time so they line up with the dates
// shown in the visit list.
function visitPeriodStart(period) {
  const now = new Date();
  if (period === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "week") {
    const day = (now.getDay() + 6) % 7; // Monday as the first day of the week
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  }
  if (period === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  if (period === "year") return new Date(now.getFullYear(), 0, 1);
  return null;
}

function visitMatchesFilters(visit) {
  if (visitMapUserId && visit.user_id !== visitMapUserId) return false;
  const start = visitPeriodStart(visitMapPeriod);
  if (start && (!visit.visited_at || new Date(visit.visited_at) < start)) return false;
  return true;
}

function applyVisitFilters() {
  const counts = {};
  VISIT_LAYERS.forEach((l) => {
    counts[l.key] = 0;
  });
  visitRecords.forEach((rec) => {
    const group = visitLayerGroups[rec.key];
    if (visitMatchesFilters(rec.visit)) {
      counts[rec.key] += 1;
      if (!group.hasLayer(rec.marker)) group.addLayer(rec.marker);
    } else if (group.hasLayer(rec.marker)) {
      group.removeLayer(rec.marker);
    }
  });
  renderVisitLayerList(counts);
  const shown = VISIT_LAYERS.reduce(
    (sum, l) => sum + (visitLayerEnabled[l.key] ? counts[l.key] : 0),
    0
  );
  visitMapSummary.textContent = shown + " of " + visitRecords.length + " visits shown";
}

function renderVisitLayerList(counts) {
  visitLayerList.innerHTML = "";
  VISIT_LAYERS.forEach((layer) => {
    const row = document.createElement("label");
    row.className = "dataset-row";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = visitLayerEnabled[layer.key];
    check.addEventListener("change", () => setVisitLayerEnabled(layer.key, check.checked));

    const swatch = document.createElement("span");
    swatch.className = "dataset-swatch";
    swatch.style.background = layer.color;

    const label = document.createElement("span");
    label.className = "dataset-label";
    label.textContent = layer.label;

    const count = document.createElement("span");
    count.className = "dataset-count";
    count.textContent = counts ? counts[layer.key] : "";

    row.appendChild(check);
    row.appendChild(swatch);
    row.appendChild(label);
    row.appendChild(count);
    visitLayerList.appendChild(row);
  });
}

function setVisitLayerEnabled(key, on) {
  visitLayerEnabled[key] = on;
  if (on) {
    visitLayerGroups[key].addTo(visitMap);
  } else {
    visitMap.removeLayer(visitLayerGroups[key]);
  }
  applyVisitFilters();
}

function populateVisitUserFilter() {
  const ids = [];
  visitRecords.forEach((rec) => {
    if (rec.visit.user_id && ids.indexOf(rec.visit.user_id) === -1) ids.push(rec.visit.user_id);
  });
  ids
    .map((id) => ({ id: id, label: getUserLabel(id) }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = u.label;
      visitMapUserSelect.appendChild(opt);
    });
}

visitMapPeriodSelect.addEventListener("change", () => {
  visitMapPeriod = visitMapPeriodSelect.value;
  applyVisitFilters();
});

visitMapUserSelect.addEventListener("change", () => {
  visitMapUserId = visitMapUserSelect.value;
  applyVisitFilters();
});

document.getElementById("btn-visit-layers-all").addEventListener("click", () => {
  VISIT_LAYERS.forEach((l) => setVisitLayerEnabled(l.key, true));
});

document.getElementById("btn-visit-layers-none").addEventListener("click", () => {
  VISIT_LAYERS.forEach((l) => setVisitLayerEnabled(l.key, false));
});

// Wait for pywebview API
window.addEventListener("pywebviewready", init);
