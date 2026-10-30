// Email: choose who, write it, send it, read what it did.
// The Python side is email_api.py; sending itself is mailer_core.py.

// Subscribers are split by why they have access, in the order the website
// decides it. Ticking Subscribers ticks them all.
const SUBSCRIBER_TYPES = [
  { id: "stripe", label: "Web (Stripe)", desc: "Paying on the website" },
  { id: "store", label: "App store, verified", desc: "Store purchase the store itself has confirmed" },
  { id: "mirror", label: "App store, reported by the phone", desc: "Only the phone says so. Can include someone who has cancelled" },
  { id: "group", label: "Paid group", desc: "Covered by their group's payment" },
  { id: "lifetime", label: "Lifetime", desc: "Bought lifetime access" },
  { id: "complimentary", label: "Complimentary", desc: "Given access free" },
  { id: "admin", label: "Admin", desc: "You. Only listed when admin accounts are included" },
];

const SEGMENTS = [
  { id: "subscribers", label: "Subscribers", desc: "Paying now, or given access" },
  { id: "trial", label: "On a free week", desc: "Inside their seven days now, and not paying" },
  { id: "lapsed-paid", label: "Paid once, lapsed", desc: "Subscribed at some point, no access now" },
  { id: "lapsed-trial", label: "Tried it, never paid", desc: "Free week over, never subscribed" },
];

const $ = (id) => document.getElementById(id);
const statusText = $("status-text");
const api = () => window.pywebview.api;

let audience = null;
let settings = {};
let pollTimer = null;
let logIndex = 0;
let sending = false;

function setStatus(text) {
  statusText.textContent = text;
  statusText.title = text;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function log(line) {
  const box = $("em-log");
  box.textContent += line + "\n";
  box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------- tabs

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "message") renderPreview();
  });
});

$("btn-back").addEventListener("click", () => {
  if (sending && !confirm("A send is still going. Leave this page anyway? It will keep sending.")) return;
  window.location.href = "home.html";
});

// ---------------------------------------------------------------- settings

const saveSettings = debounce(async () => {
  const data = { recipients: $("em-recipients").value };
  document.querySelectorAll("[data-save]").forEach((el) => { data[el.dataset.save] = el.value; });
  const result = await api().email_save_settings(data);
  if (result && result.error) setStatus("Could not save settings: " + result.error);
}, 600);

document.querySelectorAll("[data-save]").forEach((el) => el.addEventListener("input", saveSettings));

function fillSettings(s) {
  settings = s;
  document.querySelectorAll("[data-save]").forEach((el) => {
    const v = s[el.dataset.save];
    el.value = v === undefined || v === null ? "" : v;
  });
  $("em-recipients").value = s.recipients || "";
  if (s.password_from_env) {
    $("em-password").placeholder = "from IONOS_SMTP_PASSWORD";
    $("em-password-hint").textContent = "Never saved. Leave blank to use IONOS_SMTP_PASSWORD, which is set.";
  }
  renderOptouts(s);
  renderCampaign(s);
}

function renderCampaign(s) {
  const name = s.campaign || "(none named: the original sent log)";
  $("em-campaign-state").innerHTML =
    `<p class="em-hint"><strong>${escapeHtml(name)}</strong><br>` +
    `Sent log: ${escapeHtml(s.log_path)}<br>${s.log_count} address(es) already in it.</p>`;
}

$("em-campaign-new").addEventListener("click", async () => {
  const name = $("em-campaign-name").value.trim();
  if (!name) { alert("Give the campaign a name first."); return; }
  if (!confirm(`Start campaign "${name}"?\n\nThe old sent log is kept, and this one starts empty.`)) return;
  const s = await api().email_new_campaign(name);
  if (s.error) { alert(s.error); return; }
  settings = s;
  renderCampaign(s);
  $("em-campaign-name").value = "";
  setStatus(`Campaign ${name} started`);
  recount();
});

function renderOptouts(s) {
  const box = $("em-optout-state");
  const warnings = [];
  if (!s.optout_list_exists) {
    warnings.push(`The opt-out list is missing. Restore it from ${s.optout_backup} before sending anything.`);
  } else if (s.optouts_missing_from_live > 0) {
    warnings.push(`${s.optouts_missing_from_live} address(es) in the backup are missing from the live list. Restore it from ${s.optout_backup} before sending.`);
  }
  if (s.optouts_missing_from_backup > 0) {
    warnings.push(`${s.optouts_missing_from_backup} address(es) are not in the backup yet. Copy the file to ${s.optout_backup}.`);
  }
  box.innerHTML = `<p class="em-hint">${s.optouts} address(es) will never be emailed.</p>` +
    warnings.map((w) => `<p class="em-warn">${escapeHtml(w)}</p>`).join("");
}

$("em-optout-add").addEventListener("click", async () => {
  const address = $("em-optout-address").value.trim();
  if (!address) return;
  const result = await api().email_add_optout(address);
  if (result.error) { alert(result.error); return; }
  $("em-optout-address").value = "";
  setStatus(result.added ? `${address} will not be emailed again` : `${address} was already on the list`);
  renderOptouts(await api().email_settings());
  recount();
});

// ---------------------------------------------------------------- recipients

// What is ticked, kept across a refresh. Every subscriber type to start with.
const ticked = new Set(SUBSCRIBER_TYPES.filter((t) => t.id !== "admin").map((t) => "sub:" + t.id));

function segmentRow(key, label, desc, n, extraClass = "") {
  return `<label class="em-segment ${extraClass}">
    <input type="checkbox" data-key="${key}" ${ticked.has(key) ? "checked" : ""}>
    <span class="em-segment-text">
      <span class="em-segment-label">${label} <span class="em-segment-count">${n}</span></span>
      <span class="em-segment-desc">${desc}</span>
    </span>
  </label>`;
}

function renderSegments() {
  const count = (list) => (audience ? list.length : "…");
  const showAdmin = $("em-include-admins").checked;
  const types = SUBSCRIBER_TYPES.filter((t) => t.id !== "admin" || showAdmin);
  if (!showAdmin) ticked.delete("sub:admin");
  $("em-segments").innerHTML = SEGMENTS.map((s) => {
    const n = count(audience ? audience.segments[s.id] : []);
    if (s.id !== "subscribers") return segmentRow(s.id, s.label, s.desc, n);
    return segmentRow("subscribers", s.label, s.desc, n, "em-parent") +
      `<div class="em-children">` +
      types.map((t) => segmentRow("sub:" + t.id, t.label, t.desc,
        count(audience ? audience.subscriber_types[t.id] : []))).join("") +
      `</div>`;
  }).join("");
  syncParent();
}

// The Subscribers box is ticked when every type is, and half-ticked when some are.
function syncParent() {
  const parent = document.querySelector('#em-segments input[data-key="subscribers"]');
  const children = [...document.querySelectorAll('#em-segments input[data-key^="sub:"]')];
  const on = children.filter((c) => c.checked).length;
  parent.checked = on === children.length && on > 0;
  parent.indeterminate = on > 0 && on < children.length;
}

$("em-segments").addEventListener("change", (e) => {
  const key = e.target.dataset.key;
  if (!key) return;
  if (key === "subscribers") {
    document.querySelectorAll('#em-segments input[data-key^="sub:"]').forEach((c) => {
      c.checked = e.target.checked;
      if (c.checked) ticked.add(c.dataset.key); else ticked.delete(c.dataset.key);
    });
  } else if (e.target.checked) {
    ticked.add(key);
  } else {
    ticked.delete(key);
  }
  syncParent();
});

async function loadAudience() {
  setStatus("Reading accounts...");
  audience = null;
  renderSegments();
  const result = await api().email_audience($("em-include-admins").checked);
  if (result.error) {
    setStatus("Could not read accounts: " + result.error);
    return;
  }
  audience = result;
  renderSegments();
  const lo = result.left_out;
  $("em-read-at").textContent = `Counted at ${new Date(result.read_at).toLocaleTimeString()}. ` +
    `Left out: ${lo.admin} admin, ${lo.test} test. Counts change daily, so refresh on the day you send.`;
  setStatus("Ready");
}

$("em-refresh").addEventListener("click", loadAudience);
$("em-include-admins").addEventListener("change", loadAudience);

$("em-use-segments").addEventListener("click", () => {
  if (!audience) return;
  // Subscribers are taken from the ticked types, never the parent, so a
  // half-ticked Subscribers box sends only to the types that are ticked.
  const keys = [...ticked];
  const lists = keys.map((k) => (k.startsWith("sub:")
    ? audience.subscriber_types[k.slice(4)] || []
    : k === "subscribers" ? [] : audience.segments[k] || []));
  const chosen = keys.map((k) => {
    if (k.startsWith("sub:")) return SUBSCRIBER_TYPES.find((t) => t.id === k.slice(4)).label;
    return SEGMENTS.find((s) => s.id === k).label;
  });
  if (!chosen.length) { alert("Tick at least one group."); return; }
  const addresses = [...new Set(lists.flat())].sort();
  const current = $("em-recipients").value.trim();
  if (current && !confirm(`Replace the current list with ${addresses.length} addresses?`)) return;
  $("em-recipients").value = addresses.join("\n");
  setStatus(`List set to ${chosen.join(" + ")}: ${addresses.length} addresses`);
  saveSettings();
  recount();
});

async function recount() {
  const c = await api().email_recount($("em-recipients").value);
  const bits = [`${c.valid} valid`];
  if (c.duplicates) bits.push(`${c.duplicates} duplicate`);
  if (c.unusable_count) bits.push(`${c.unusable_count} unusable`);
  if (c.opted_out) bits.push(`${c.opted_out} unsubscribed`);
  bits.push(`${c.already_sent} already sent`);
  bits.push(`<strong>${c.to_go} to go</strong>`);
  $("em-counts").innerHTML = bits.join(" · ");
  return c;
}

const recountSoon = debounce(recount, 300);
$("em-recipients").addEventListener("input", () => { recountSoon(); saveSettings(); });

$("em-clean").addEventListener("click", async () => {
  const r = await api().email_clean($("em-recipients").value);
  $("em-recipients").value = r.valid.join("\n");
  if (r.invalid.length) alert("Removed as unusable:\n\n" + r.invalid.slice(0, 20).join("\n"));
  saveSettings();
  recount();
});

$("em-remove-sent").addEventListener("click", async () => {
  const r = await api().email_remaining_list($("em-recipients").value);
  $("em-recipients").value = r.join("\n");
  saveSettings();
  recount();
});

$("em-clear").addEventListener("click", () => {
  if ($("em-recipients").value.trim() && !confirm("Clear the list?")) return;
  $("em-recipients").value = "";
  saveSettings();
  recount();
});

// ---------------------------------------------------------------- message

const renderPreview = () => { $("em-preview").srcdoc = $("em-html").value || "<p style='font-family:sans-serif;color:#888'>No HTML body. Only the plain text will be sent.</p>"; };
$("em-html").addEventListener("input", debounce(renderPreview, 400));

async function loadBody(target) {
  const r = await api().email_open_body();
  if (!r) return;
  $(target).value = r.text;
  setStatus(`Loaded ${r.name}`);
  saveSettings();
  if (target === "em-html") renderPreview();
}
$("em-load-text").addEventListener("click", () => loadBody("em-text"));
$("em-load-html").addEventListener("click", () => loadBody("em-html"));

// ---------------------------------------------------------------- sending

function smtp() {
  return { host: $("em-host").value, port: $("em-port").value, user: $("em-user").value, password: $("em-password").value };
}

function message() {
  return {
    subject: $("em-subject").value, sender: $("em-sender").value || $("em-user").value,
    reply_to: $("em-reply-to").value, unsubscribe: $("em-unsubscribe").value,
    text_body: $("em-text").value, html_body: $("em-html").value,
  };
}

function pacing() {
  return { delay: $("em-delay").value, limit: $("em-limit").value, reconnect_every: $("em-reconnect").value };
}

$("em-mail-tester").addEventListener("click", (e) => { e.preventDefault(); api().open_url("https://www.mail-tester.com"); });

$("em-test-connection").addEventListener("click", async () => {
  setStatus("Testing the connection...");
  const r = await api().email_test_connection(smtp());
  if (r.error) { setStatus("Connection failed"); log("ERROR " + r.error); alert(r.error); return; }
  setStatus("Connection fine");
  log(r.ok);
});

$("em-dry-run").addEventListener("click", async () => {
  const p = await api().email_plan($("em-recipients").value, $("em-limit").value);
  const m = message();
  log("--- dry run, nothing sent ---");
  log(`from      ${m.sender}`);
  log(`subject   ${m.subject}`);
  log(`body      ${m.text_body.length} chars text, ${m.html_body.trim() ? m.html_body.length + " chars html" : "no html part"}`);
  log(`this run  ${p.batch} of ${p.to_go} remaining, ${$("em-delay").value}s apart`);
  p.first.forEach((a) => log(`  would send to ${a}`));
  if (p.batch > p.first.length) log(`  ... and ${p.batch - p.first.length} more`);
});

$("em-send-test").addEventListener("click", async () => {
  const address = $("em-test-address").value.trim();
  if (!address) { alert("Put a test address in first."); return; }
  if (!confirm(`Send one test copy to ${address}?\n\nSubject: ${$("em-subject").value}`)) return;
  start(await api().email_send("test", smtp(), message(), "", address, pacing(), null), `test to ${address}`);
});

// Batch: the dialog is the only route, and its Send button stays disabled
// until the number of people is typed exactly.
let confirmCount = null;

$("em-send-batch").addEventListener("click", async () => {
  const p = await api().email_plan($("em-recipients").value, $("em-limit").value);
  if (!p.batch || !p.to_go) { alert("Nothing left to send. The list is all in the log or unsubscribed."); return; }
  const m = message();
  if (!m.subject.trim() || !m.text_body.trim()) { alert("Still missing a subject or a plain-text body."); return; }
  const minutes = Math.round((p.batch * (parseFloat($("em-delay").value) || 0)) / 60);
  confirmCount = p.batch;
  $("em-confirm-body").innerHTML = `
    <table class="em-confirm-table">
      <tr><th>To</th><td><strong>${p.batch} people</strong>${p.left_after ? `, ${p.left_after} left for the next run` : ""}</td></tr>
      <tr><th>Subject</th><td>${escapeHtml(m.subject)}</td></tr>
      <tr><th>From</th><td>${escapeHtml(m.sender)}</td></tr>
      <tr><th>Campaign</th><td>${escapeHtml(p.campaign || "(none named)")}</td></tr>
      <tr><th>Skipped</th><td>${p.already_sent} already sent in this campaign, ${p.opted_out} unsubscribed</td></tr>
      <tr><th>Takes</th><td>${minutes < 1 ? "under a minute" : `about ${minutes} minute(s)`}</td></tr>
      <tr><th>Starting with</th><td>${p.first.map(escapeHtml).join("<br>")}${p.batch > p.first.length ? "<br>…" : ""}</td></tr>
    </table>
    <p class="em-warn">This sends real email and cannot be undone.</p>`;
  $("em-confirm-label").textContent = `Type ${p.batch} to confirm`;
  $("em-confirm-input").value = "";
  $("em-confirm-send").disabled = true;
  $("em-confirm").hidden = false;
  $("em-confirm-input").focus();
});

$("em-confirm-input").addEventListener("input", () => {
  $("em-confirm-send").disabled = $("em-confirm-input").value.trim() !== String(confirmCount);
});

function closeConfirm() {
  $("em-confirm").hidden = true;
  confirmCount = null;
}
$("em-confirm-cancel").addEventListener("click", closeConfirm);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("em-confirm").hidden) closeConfirm(); });

$("em-confirm-send").addEventListener("click", async () => {
  const typed = $("em-confirm-input").value.trim();
  if (typed !== String(confirmCount)) return;
  closeConfirm();
  start(await api().email_send("batch", smtp(), message(), $("em-recipients").value, "", pacing(), typed), `batch of ${typed}`);
});

function start(result, what) {
  if (result.error) { log("NOT SENT: " + result.error); setStatus("Not sent"); alert(result.error); return; }
  sending = true;
  logIndex = 0;
  setRunning(true);
  log(`--- ${what} at ${new Date().toLocaleTimeString()} ---`);
  $("em-progress-bar").style.width = "0%";
  pollTimer = setInterval(poll, 500);
}

function setRunning(running) {
  ["em-send-batch", "em-send-test", "em-dry-run", "em-test-connection"].forEach((id) => { $(id).disabled = running; });
  $("em-stop").disabled = !running;
}

async function poll() {
  const s = await api().email_status(logIndex);
  logIndex = s.next;
  for (const e of s.events) {
    if (e.kind === "sent") log(`[${e.index}/${e.total}] sent ${e.address}`);
    else if (e.kind === "refused") log(`[${e.index}/${e.total}] REFUSED ${e.address}: ${e.detail}`);
    else if (e.kind === "stopped") log(`[${e.index}/${e.total}] stopped at ${e.address}: ${e.detail}`);
    else log(e.detail);
    if (e.total && e.index) {
      $("em-progress-bar").style.width = `${(e.index / e.total) * 100}%`;
      setStatus(`${e.index} of ${e.total}`);
    }
  }
  if (!s.running) {
    clearInterval(pollTimer);
    sending = false;
    setRunning(false);
    if (s.error) { log("ERROR " + s.error); setStatus("Failed"); alert(s.error); }
    else { log(s.summary); setStatus(s.summary); }
    renderCampaign(await api().email_settings());
    recount();
  }
}

$("em-stop").addEventListener("click", async () => {
  await api().email_stop();
  setStatus("Stopping after this message...");
});

// ---------------------------------------------------------------- results

function isoDay(d) { return d.toISOString().slice(0, 10); }

$("em-preset-baseline").addEventListener("click", () => {
  const today = new Date();
  $("em-since").value = isoDay(new Date(today.getTime() - 14 * 864e5));
  $("em-until").value = isoDay(today);
  document.querySelector('input[name="em-source"][value="list"]').checked = true;
});

$("em-read").addEventListener("click", async () => {
  const since = $("em-since").value;
  if (!since) { alert("Choose a From date."); return; }
  const source = document.querySelector('input[name="em-source"]:checked').value;
  const until = $("em-until").value || null;
  setStatus("Reading...");
  $("em-results").innerHTML = `<p class="em-hint">Reading...</p>`;
  const r = await api().email_read(source, $("em-recipients").value, since, until);
  if (r.error) { setStatus("Read failed"); $("em-results").innerHTML = `<p class="em-warn">${escapeHtml(r.error)}</p>`; return; }
  setStatus("Ready");
  const span = `${since} to ${until || "now"}`;
  const rows = [
    ["Opened the map on the website", r.map_opened + (r.map_opened_is_floor ? " (at least: older rows are pruned)" : "")],
    ["Recorded a visit", r.recorded_visit],
    ["Made a layer in My sites", r.made_layer],
    ["Added a site in My sites", r.made_site],
    ["Started a subscription", r.started_subscription],
  ];
  $("em-results").innerHTML = `
    <div class="em-section-title">${source === "log" ? "Sent log" : "The list"}, ${escapeHtml(span)}</div>
    <p class="em-hint">${r.addresses} addresses, ${r.matched} matched to an account. Counts are people, not events.</p>
    <table class="subs-table"><tbody>
      ${rows.map(([k, v]) => `<tr><td>${k}</td><td>${escapeHtml(v)}</td></tr>`).join("")}
    </tbody></table>`;
});

// ---------------------------------------------------------------- start

async function init() {
  fillSettings(await api().email_settings());
  renderSegments();
  recount();
  loadAudience();
}

window.addEventListener("pywebviewready", init);
