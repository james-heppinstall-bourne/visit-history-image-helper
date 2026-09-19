// Place image manager: the whole place list on the left, and the card and hero
// for one place open side by side on the right. Each panel is an independent
// crop of its own source — the two outputs are different aspect ratios, so
// nothing is derived from the other (see TARGETS in backend.py).

// creditScale/creditPlate mirror finder.credit_style(): a letterbox banner gets a
// smaller credit with no plate, because a proportional plated one reads as a stripe.
const TARGETS = {
  card: {
    label: "Card",
    widthKey: "crop_width",
    heightKey: "crop_height",
    column: "image_path",
    other: "hero",
    creditScale: 1.0,
    creditPlate: true,
  },
  hero: {
    label: "Hero",
    widthKey: "hero_width",
    heightKey: "hero_height",
    column: "hero_image_path",
    other: "card",
    creditScale: 0.78,
    creditPlate: true,
  },
};

// Everything that only makes sense once a source is loaded. While a panel is
// showing the image the place already has, these stay disabled until Re-crop or
// Clear says what to do with it.
const EDITOR_ACTIONS = [
  "zoom-in",
  "zoom-out",
  "rot-ccw",
  "rot-cw",
  "centre",
  "enhance",
  "apply-credit",
];

const FILTERS = {
  all: () => true,
  "no-card": (p) => !p.image_path,
  "no-hero": (p) => !p.hero_image_path,
  "no-both": (p) => !p.image_path && !p.hero_image_path,
};

const FIND_POLL_MS = 1500;

// State
let config = null;
let finderStatus = { ready: false, reason: "Checking…" };
// "both", or the slot name of the panel showing on its own.
let layoutMode = "both";
let places = [];
let imageBaseUrl = "";
let selectedPlace = null;
let visiblePlaces = [];
const panels = {};

// DOM
const statusText = document.getElementById("status-text");
const listEl = document.getElementById("pi-list");
const countEl = document.getElementById("pi-count");
const searchInput = document.getElementById("pi-search");
const filterSelect = document.getElementById("pi-filter");
const placeNameEl = document.getElementById("pi-place-name");
const placeMetaEl = document.getElementById("pi-place-meta");
const placeLinkButtons = Array.from(document.querySelectorAll("#pi-place-links .pi-link"));
const filenameInput = document.getElementById("pi-filename");
const btnFindAll = document.getElementById("pi-find-all");
const picker = document.getElementById("pi-picker");
const pickerQuery = document.getElementById("pi-picker-query");
const pickerMode = document.getElementById("pi-picker-mode");
const pickerLarge = document.getElementById("pi-picker-large");
const pickerGrid = document.getElementById("pi-picker-grid");
const pickerCount = document.getElementById("pi-picker-count");
const pickerTitle = document.getElementById("pi-picker-title");
const pickerSort = document.getElementById("pi-picker-sort");
const pickerTargetBtns = Array.from(
  document.querySelectorAll("#pi-picker-target .target-btn")
);

function setStatus(text) {
  statusText.textContent = text;
  statusText.title = text;
}

function slugify(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function imageUrl(filename, bust) {
  if (!filename || !imageBaseUrl) return "";
  return imageBaseUrl + encodeURIComponent(filename) + (bust ? "?v=" + bust : "");
}

// --- Panel -----------------------------------------------------------------

class Panel {
  constructor(slot) {
    this.slot = slot;
    this.spec = TARGETS[slot];
    this.root = document.getElementById("panel-" + slot);
    this.stage = this.q("stage");
    this.canvas = this.q("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.overlay = this.q("overlay");
    this.hint = this.q("hint");
    this.dimsEl = this.q("dims");
    this.stateEl = this.q("state");
    this.creditInput = this.q("credit");
    this.licenceSelect = this.q("licence");
    this.preview = this.q("preview");
    this.previewImg = this.q("preview-img");
    this.previewName = this.q("preview-name");
    this.hintText = this.q("hint-text");
    this.finding = this.q("finding");
    this.findTitle = this.q("find-title");
    this.findLog = this.q("find-log");
    this.attrib = this.q("attrib");
    this.attribText = this.q("attrib-text");

    this.img = null;
    this.transform = { x: 0, y: 0, scale: 1, rotation: 0 };
    this.crop = { x: 0, y: 0, width: 0, height: 0 };
    this.originalDataUrl = null;
    this.enhancedDataUrl = null;
    this.enhanced = false;
    this.credit = "";
    this.sourceName = "";
    this.saved = false;
    // True while the place's existing image is on the stage and untouched.
    this.locked = false;
    // Image finder: searching is true from the click until the thread reports
    // back; record holds where a found image came from.
    this.searching = false;
    this.record = null;
    this.findSeen = 0;
    this.findTimer = null;

    this.bindTools();
    this.bindCanvas();
    this.observeStage();
  }

  /** Builds the credit line from the fields and puts it on the canvas. */
  applyCredit() {
    const name = this.creditInput.value.trim();
    this.credit = name
      ? `Photo: ${name} / ${this.licenceSelect.value} (modified)`
      : "";
    this.draw();
    return this.credit;
  }

  async openFromDialog() {
    setStatus("Opening file…");
    const result = await pywebview.api.open_slot_image(this.slot);
    if (!result) return setStatus("Cancelled");
    await this.setSource(result);
  }

  q(role) {
    return this.root.querySelector(`[data-role="${role}"]`);
  }

  button(action) {
    return this.root.querySelector(`[data-action="${action}"]`);
  }

  dims() {
    return { width: config[this.spec.widthKey], height: config[this.spec.heightKey] };
  }

  // --- rendering ---

  resize() {
    const rect = this.stage.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.canvas.width = w;
    this.canvas.height = h;
    // Pin the element to its backing store rather than letting width:100% stretch
    // it. The crop overlay is positioned in these same pixels, so any stretch
    // shows up as the image not filling the red box.
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.updateCropOverlay();
  }

  /** Track the stage's size, keeping the framing that is already set. */
  observeStage() {
    if (typeof ResizeObserver === "undefined") return;
    this.stageObserver = new ResizeObserver(() => {
      const rect = this.stage.getBoundingClientRect();
      // A collapsed panel reports no size; leave the canvas and the crop box
      // alone so the framing survives until it is expanded again.
      if (rect.width < 2 || rect.height < 2) return;
      if (
        Math.round(rect.width) === this.canvas.width &&
        Math.round(rect.height) === this.canvas.height
      ) {
        return;
      }
      const before = { ...this.crop };
      this.resize();
      if (this.img) this.rescaleToCrop(before);
      this.draw();
    });
    this.stageObserver.observe(this.stage);
  }

  /**
   * Map the current composition onto a resized crop box.
   *
   * The box keeps its aspect ratio, so one factor covers both axes: scale the
   * image by it and move it the same way relative to the box centre. Maximising
   * a panel then shows the same framing larger, instead of resetting it.
   */
  rescaleToCrop(before) {
    if (!before || before.width < 1) return this.fitImageToCrop();
    const k = this.crop.width / before.width;
    const oldCx = before.x + before.width / 2;
    const oldCy = before.y + before.height / 2;
    const newCx = this.crop.x + this.crop.width / 2;
    const newCy = this.crop.y + this.crop.height / 2;
    this.transform.scale *= k;
    this.transform.x = newCx + (this.transform.x - oldCx) * k;
    this.transform.y = newCy + (this.transform.y - oldCy) * k;
  }

  updateCropOverlay() {
    if (!config) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const d = this.dims();
    const ratio = d.width / d.height;
    const maxW = w * 0.9;
    const maxH = h * 0.9;

    let boxW, boxH;
    if (maxW / ratio <= maxH) {
      boxW = maxW;
      boxH = maxW / ratio;
    } else {
      boxH = maxH;
      boxW = maxH * ratio;
    }

    this.crop = { x: (w - boxW) / 2, y: (h - boxH) / 2, width: boxW, height: boxH };
    this.overlay.style.left = this.crop.x + "px";
    this.overlay.style.top = this.crop.y + "px";
    this.overlay.style.width = boxW + "px";
    this.overlay.style.height = boxH + "px";
    this.overlay.style.display = this.img ? "block" : "none";
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this.img) {
      ctx.save();
      const cx = this.transform.x + (this.img.width * this.transform.scale) / 2;
      const cy = this.transform.y + (this.img.height * this.transform.scale) / 2;
      ctx.translate(cx, cy);
      ctx.rotate((this.transform.rotation * Math.PI) / 180);
      ctx.scale(this.transform.scale, this.transform.scale);
      ctx.drawImage(this.img, -this.img.width / 2, -this.img.height / 2);
      ctx.restore();
    }
    if (this.credit) this.drawCredit();
  }

  /**
   * Preview of the watermark the backend burns in at save time, in the same
   * proportions as finder.watermark(): everything is a fraction of the output
   * height, so what is on the canvas is what lands in the file. Wide targets
   * take CREDIT_SCALE, which is why the hero's credit is a discreet mark and
   * the card's is a readable strip.
   */
  drawCredit() {
    const { ctx } = this;
    // Same proportions as finder.watermark(), so the preview shows what lands
    // in the file. Wide targets take a smaller credit with no plate behind it;
    // the outline carries the contrast there instead.
    const h = this.crop.height;
    const style = this.spec;
    const px = (fraction, floor) => Math.max(floor, fraction * h);
    const fontSize = px(0.025 * style.creditScale, 4);
    ctx.font = fontSize + "px sans-serif";
    ctx.textBaseline = "top";
    const textW = ctx.measureText(this.credit).width;

    if (style.creditPlate) {
      const padX = px(0.015 * style.creditScale, 2);
      const padY = px(0.01 * style.creditScale, 1);
      const radius = px(0.008 * style.creditScale, 1);
      const boxW = textW + padX * 2;
      const boxH = fontSize + padY * 2;
      // Flush into the corner, with the outer rounded corners pushed past the
      // crop box so they clip square — same as finder.watermark().
      const x = this.crop.x + this.crop.width - boxW;
      const y = this.crop.y + this.crop.height - boxH;
      ctx.save();
      ctx.beginPath();
      ctx.rect(this.crop.x, this.crop.y, this.crop.width, this.crop.height);
      ctx.clip();
      ctx.fillStyle = "rgba(0, 0, 0, 0.47)";
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, boxW + radius, boxH + radius, radius);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, boxW, boxH);
      }
      ctx.fillStyle = "#fff";
      ctx.fillText(this.credit, x + padX, y + padY);
      ctx.restore();
    } else {
      const margin = px(0.01, 2);
      const x = this.crop.x + this.crop.width - margin - textW;
      const y = this.crop.y + this.crop.height - margin - fontSize;
      ctx.lineWidth = Math.max(1, fontSize / 9) * 2;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
      ctx.lineJoin = "round";
      ctx.strokeText(this.credit, x, y);
      ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
      ctx.fillText(this.credit, x, y);
    }
  }

  fitImageToCrop() {
    if (!this.img) return;
    const scaleX = this.crop.width / this.img.width;
    const scaleY = this.crop.height / this.img.height;
    // Cover the whole crop box rather than fitting inside it.
    this.transform.scale = Math.max(scaleX, scaleY);
    this.transform.x = this.crop.x + (this.crop.width - this.img.width * this.transform.scale) / 2;
    this.transform.y = this.crop.y + (this.crop.height - this.img.height * this.transform.scale) / 2;
  }

  zoom(factor, centerX, centerY) {
    if (!this.img) return;
    if (centerX === undefined) {
      centerX = this.crop.x + this.crop.width / 2;
      centerY = this.crop.y + this.crop.height / 2;
    }
    const oldScale = this.transform.scale;
    this.transform.scale = Math.max(0.05, Math.min(oldScale * factor, 20));
    const real = this.transform.scale / oldScale;
    this.transform.x = centerX - (centerX - this.transform.x) * real;
    this.transform.y = centerY - (centerY - this.transform.y) * real;
    this.draw();
  }

  // --- source handling ---

  async setSource(result) {
    if (!result) return;
    if (result.error) {
      setStatus(`${this.spec.label}: ${result.error}`);
      return;
    }
    this.originalDataUrl = result.data_url;
    this.enhancedDataUrl = null;
    this.enhanced = false;
    this.transform.rotation = 0;
    this.sourceName = result.filename || "";
    this.saved = false;
    this.record = result.record || null;
    this.img = await loadImage(result.data_url);
    // render() first: it decides whether the attribution row is shown, which
    // changes the stage height the crop box and canvas are measured against.
    this.render();
    this.resize();
    this.fitImageToCrop();
    this.draw();
    setStatus(`${this.spec.label}: ${this.sourceName} (${result.width}×${result.height})`);
  }

  async clearSource() {
    this.img = null;
    this.originalDataUrl = null;
    this.enhancedDataUrl = null;
    this.enhanced = false;
    this.credit = "";
    this.sourceName = "";
    this.saved = false;
    this.record = null;
    this.transform = { x: 0, y: 0, scale: 1, rotation: 0 };
    this.creditInput.value = "";
    this.licenceSelect.selectedIndex = 0;
    this.button("enhance").textContent = "Enhance: OFF";
    this.button("enhance").classList.remove("active");
    this.draw();
    this.render();
    await pywebview.api.clear_slot(this.slot);
  }

  /**
   * The panel has three states, and this is the only thing that sets them:
   *
   *   searching — Claude is off finding an image; progress fills the stage
   *   editing   — a source is loaded; the canvas and every control are live
   *   preview   — the place already has this image; it fills the stage and only
   *               Re-crop, Replace and Clear are offered, so nothing is edited
   *               over the top of an image by accident
   *   empty     — no stored image and no source; Open, paste, drop or Find
   */
  render() {
    const d = this.dims();
    this.dimsEl.textContent = `${d.width}×${d.height}`;
    this.button("save").textContent = `Save ${this.spec.label}`;

    const stored = selectedPlace ? selectedPlace[this.spec.column] : null;
    const editing = !!this.img;
    this.locked = !editing && !!stored && !this.searching;

    this.stateEl.classList.toggle("ok", !!stored);
    this.stateEl.classList.toggle("missing", !!selectedPlace && !stored);
    this.stateEl.textContent = !selectedPlace ? "—" : stored ? (this.saved ? "saved ✓" : "has image") : "missing";

    // Stage
    if (this.locked) {
      this.previewImg.src = imageUrl(stored, selectedPlace && selectedPlace._bust);
      this.previewName.textContent = stored;
    } else {
      this.previewImg.removeAttribute("src");
    }
    this.preview.style.display = this.locked ? "flex" : "none";
    this.finding.style.display = this.searching ? "flex" : "none";
    this.hint.style.display = !editing && !this.locked && !this.searching ? "flex" : "none";
    this.hintText.textContent = selectedPlace
      ? "Open, paste or drop an image"
      : "Select a place from the list";
    this.overlay.style.display = editing && !this.searching ? "block" : "none";

    // Where a found image came from, so its licence can be checked at source.
    this.attrib.style.display = this.record ? "flex" : "none";
    if (this.record) {
      const bits = [this.record.author, this.record.license].filter(Boolean).join(" · ");
      this.attribText.textContent = bits || this.record.source_title || "";
      this.attribText.title = this.record.attribution_line || "";
      this.button("source").disabled = !this.record.source_page;
    }

    // Controls: nothing but the three preview choices while an existing image is
    // shown, and nothing at all while a search is running.
    const live = editing && !this.searching;
    for (const action of EDITOR_ACTIONS) this.button(action).disabled = !live;
    // Copy → reads the other panel's state, so both buttons are refreshed
    // whenever either panel re-renders.
    for (const panel of Object.values(panels)) panel.renderCopyButton();
    this.creditInput.disabled = !live;
    this.licenceSelect.disabled = !live;
    this.button("open").disabled = this.locked || this.searching || !selectedPlace;
    // Saving needs a source and a place to attach it to.
    this.button("save").disabled = !live || !selectedPlace;
    for (const action of ["recrop", "replace", "unlink"]) {
      this.button(action).disabled = !this.locked;
    }
    this.renderFindButton();
    renderFindAll();
    this.renderCollapse();
  }

  renderCollapse() {
    const maximised = layoutMode === this.slot;
    const collapsed = layoutMode !== "both" && !maximised;
    this.root.classList.toggle("pi-maximised", maximised);
    this.root.classList.toggle("pi-collapsed", collapsed);
    const btn = this.button("expand");
    btn.textContent = maximised ? "⤡" : "⤢";
    btn.title = maximised
      ? "Show both panels"
      : `Show only the ${this.spec.label.toLowerCase()}`;
  }

  /** Find is offered only where it applies: a chosen place with nothing there yet. */
  renderFindButton() {
    const btn = this.button("find");
    const offerable = !!selectedPlace && !this.locked && !this.searching && !this.img;
    // Browsing needs no model, so it is offered whenever the panel is free.
    this.button("browse").disabled = !offerable;
    btn.disabled = !offerable || !finderStatus.ready;
    btn.textContent = `Find ${this.spec.label.toLowerCase()} only`;
    btn.title = !finderStatus.ready
      ? finderStatus.reason
      : `Search Wikimedia Commons for this panel alone. Filling both at once ` +
        `shares one search and costs about half as much.`;
  }

  /**
   * Copy → hands this panel's source to the other one, which would edit over an
   * image the place already has. The gate applies there as much as it does to
   * Open, paste and drop, so the button goes dead until that panel is dealt with.
   */
  renderCopyButton() {
    const other = panels[this.spec.other];
    const blocked = !!other && other.locked;
    const btn = this.button("copy-to");
    btn.disabled = !this.img || blocked;
    btn.title = blocked ? copyBlockedReason(other) : "Use this source in the other panel";
  }

  // --- actions ---

  bindTools() {
    const on = (action, fn) => this.button(action).addEventListener("click", fn);

    on("open", () => this.openFromDialog());
    // Replace is Open from inside the preview: it swaps the source without
    // touching the place's column, which keeps the stored image until a save.
    on("replace", () => this.openFromDialog());

    on("zoom-in", () => this.zoom(1.05));
    on("zoom-out", () => this.zoom(1 / 1.05));
    on("rot-ccw", () => {
      this.transform.rotation -= 1;
      this.draw();
    });
    on("rot-cw", () => {
      this.transform.rotation += 1;
      this.draw();
    });
    on("centre", () => {
      this.fitImageToCrop();
      this.draw();
    });

    on("enhance", async () => {
      if (!this.img) return;
      this.enhanced = !this.enhanced;
      const btn = this.button("enhance");
      btn.textContent = this.enhanced ? "Enhance: ON" : "Enhance: OFF";
      btn.classList.toggle("active", this.enhanced);

      if (this.enhanced && !this.enhancedDataUrl) {
        setStatus(`Enhancing ${this.spec.label}…`);
        const result = await pywebview.api.enhance_slot(this.slot);
        if (result.error) {
          setStatus("Enhance error: " + result.error);
          this.enhanced = false;
          btn.textContent = "Enhance: OFF";
          btn.classList.remove("active");
          return;
        }
        this.enhancedDataUrl = result.data_url;
      }
      // Keep the composition when swapping the preview bitmap.
      const keep = { ...this.transform };
      this.img = await loadImage(this.enhanced ? this.enhancedDataUrl : this.originalDataUrl);
      this.transform = keep;
      this.draw();
      setStatus(`${this.spec.label}: ${this.enhanced ? "enhanced" : "original"} view`);
    });

    on("copy-to", async () => {
      const other = panels[this.spec.other];
      if (other.locked) return setStatus(copyBlockedReason(other));
      const result = await pywebview.api.copy_slot_image(this.slot, other.slot);
      await other.setSource(result);
      if (!result.error) setStatus(`Copied source into the ${other.spec.label} panel`);
    });

    on("apply-credit", () => this.applyCredit());

    on("recrop", async () => {
      const stored = selectedPlace && selectedPlace[this.spec.column];
      if (!stored) return;
      setStatus(`Loading ${stored}…`);
      await this.setSource(await pywebview.api.load_slot_image_from_url(this.slot, imageUrl(stored)));
    });

    on("unlink", async () => {
      if (!selectedPlace) return;
      const result = await pywebview.api.clear_place_image(selectedPlace.id, this.slot);
      if (result.error) return setStatus("Clear failed: " + result.error);
      selectedPlace[this.spec.column] = null;
      this.saved = false;
      this.render();
      renderList();
      setStatus(`Cleared ${result.column} on ${selectedPlace.name}`);
    });

    on("save", () => this.save());
    on("expand", (e) => {
      e.stopPropagation();
      setLayout(layoutMode === this.slot ? "both" : this.slot);
    });
    // The whole rail is a target, not just its button.
    this.root.addEventListener("click", () => {
      if (this.root.classList.contains("pi-collapsed")) setLayout(this.slot);
    });
    on("find", () => this.startFind());
    on("browse", () => openPicker(this.slot));
    on("cancel-find", () => this.cancelFind());
    on("source", () => {
      if (this.record && this.record.source_page) {
        pywebview.api.open_url(this.record.source_page);
      }
    });
  }

  /** Puts this panel into the searching state; startFind() does the launching. */
  beginSearch(label) {
    this.searching = true;
    this.findSeen = 0;
    this.findLog.replaceChildren();
    this.findTitle.textContent = label;
    this.render();
  }

  endSearch() {
    this.searching = false;
    this.render();
  }

  startFind() {
    return startFind([this.slot]);
  }

  pollFind() {
    clearTimeout(this.findTimer);
    this.findTimer = setTimeout(async () => {
      const status = await pywebview.api.get_find_status(this.slot, this.findSeen);
      if (!this.searching) return;
      for (const line of status.messages || []) this.appendFindLine(line);
      this.findSeen = status.total_messages || this.findSeen;

      if (status.status === "running") return this.pollFind();

      this.searching = false;
      if (status.status === "done" && status.result) {
        await this.setSource(status.result);
        const r = status.result.record || {};
        setStatus(
          `Found ${this.spec.label.toLowerCase()}: ${r.source_title || ""} — ` +
          `${r.author || "unknown"} / ${r.license || "?"}. Review, then Save.`
        );
      } else {
        this.render();
        setStatus(`${this.spec.label} search: ${status.error || "no image found"}`);
      }
      await pywebview.api.clear_find(this.slot);
      renderFindAll();
    }, FIND_POLL_MS);
  }

  appendFindLine(text) {
    const li = document.createElement("li");
    li.textContent = text;
    this.findLog.appendChild(li);
    this.findLog.scrollTop = this.findLog.scrollHeight;
  }

  async cancelFind() {
    if (!this.searching) return;
    // One run can cover both panels, so the cancel reaches both.
    const result = await pywebview.api.cancel_find(this.slot);
    for (const slot of (result && result.slots) || [this.slot]) {
      if (panels[slot] && panels[slot].searching) panels[slot].appendFindLine("Cancelling…");
    }
  }

  async save() {
    if (!this.img || !selectedPlace) return;
    const filename = filenameInput.value.trim();
    if (!filename) {
      setStatus("Enter a filename first");
      filenameInput.focus();
      return;
    }
    setStatus(`Saving ${this.spec.label}…`);
    const result = await pywebview.api.save_slot_crop(
      this.slot,
      this.canvas.width,
      this.canvas.height,
      this.crop,
      this.transform,
      this.enhanced,
      filename,
      this.transform.rotation,
      this.credit,
      selectedPlace.id,
      this.slot
    );
    if (result.error) return setStatus(`Save ${this.spec.label} error: ${result.error}`);

    const kb = result.size_bytes ? ` ${Math.round(result.size_bytes / 1024)}KB` : "";
    if (result.uploaded) {
      selectedPlace[this.spec.column] = result.stored_filename;
      // The bucket overwrites by name, so bust the cache on the thumbnails.
      selectedPlace._bust = Date.now();
      this.saved = true;
      renderList();
      setStatus(`Saved & uploaded ${this.spec.label} → ${result.column}: ${result.stored_filename}${kb}`);
    } else if (result.supabase_error) {
      setStatus(`Saved ${this.spec.label} locally: ${result.path}${kb} (upload failed: ${result.supabase_error})`);
    } else {
      setStatus(`Saved ${this.spec.label}: ${result.path}${kb}`);
    }
    this.render();
  }

  // --- pointer input ---

  bindCanvas() {
    let dragging = false;
    let startX = 0;
    let startY = 0;

    this.canvas.addEventListener("mousedown", (e) => {
      if (!this.img) return;
      dragging = true;
      focusedPanel = this;
      startX = e.clientX - this.transform.x;
      startY = e.clientY - this.transform.y;
      this.canvas.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      this.transform.x = e.clientX - startX;
      this.transform.y = e.clientY - startY;
      this.draw();
    });

    window.addEventListener("mouseup", () => {
      dragging = false;
      this.canvas.style.cursor = this.img ? "grab" : "default";
    });

    this.canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.img) return;
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        this.zoom(e.deltaY < 0 ? 1.08 : 1 / 1.08, e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false }
    );

    this.stage.addEventListener("mouseenter", () => {
      focusedPanel = this;
    });

    // Drag and drop a file straight onto a panel.
    this.stage.addEventListener("dragover", (e) => {
      if (this.locked) return;
      e.preventDefault();
      this.stage.classList.add("dropping");
    });
    this.stage.addEventListener("dragleave", () => this.stage.classList.remove("dropping"));
    this.stage.addEventListener("drop", async (e) => {
      e.preventDefault();
      this.stage.classList.remove("dropping");
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) await this.loadFile(file);
    });
  }

  async loadFile(file) {
    if (this.searching) return setStatus(`${this.spec.label} search is still running`);
    if (this.locked) {
      return setStatus(`${this.spec.label} already has an image — choose Re-crop or Clear first`);
    }
    if (!file.type.startsWith("image/")) return setStatus("Not an image file");
    setStatus(`Reading ${file.name}…`);
    const dataUrl = await readFileAsDataUrl(file);
    await this.setSource(
      await pywebview.api.load_slot_image_from_data_url(this.slot, dataUrl, file.name)
    );
  }
}

let focusedPanel = null;

/**
 * Launches one search covering every slot given. Card and hero share the search,
 * the shortlist and the thumbnails — the model still picks a different photo per
 * target where one frames better — which costs about half of two separate runs.
 */
async function startFind(slots) {
  if (!selectedPlace) return;
  const wanted = slots.filter((s) => panels[s] && !panels[s].searching);
  if (!wanted.length) return;

  const names = wanted.map((s) => TARGETS[s].label.toLowerCase()).join(" and ");
  const label = `Finding ${names} image${wanted.length > 1 ? "s" : ""} for ${selectedPlace.name}`;
  for (const slot of wanted) panels[slot].beginSearch(label);
  renderFindAll();

  const region = [selectedPlace.town, selectedPlace.county].filter(Boolean).join(", ");
  const result = await pywebview.api.start_find_images(selectedPlace.name, wanted, region);
  if (result && result.error) {
    for (const slot of wanted) panels[slot].endSearch();
    renderFindAll();
    return setStatus(result.error);
  }
  setStatus(`Searching for ${names}…`);
  for (const slot of wanted) panels[slot].pollFind();
}

/** The shared button offers whichever panels are actually empty. */
function findableSlots() {
  if (!selectedPlace) return [];
  return Object.keys(TARGETS).filter((s) => {
    const p = panels[s];
    return p && !p.searching && !p.locked && !p.img;
  });
}

function renderFindAll() {
  if (!btnFindAll) return;
  const slots = findableSlots();
  const busy = Object.values(panels).some((p) => p.searching);
  btnFindAll.disabled = !slots.length || busy || !finderStatus.ready;
  btnFindAll.textContent =
    slots.length === 1
      ? `Find ${TARGETS[slots[0]].label.toLowerCase()} with Claude`
      : "Find both with Claude";
  btnFindAll.title = !finderStatus.ready
    ? finderStatus.reason
    : slots.length > 1
    ? "One search fills both panels — about half the cost of running them separately"
    : "Search Wikimedia Commons for a licensed image";
}

// --- Browse Commons ---------------------------------------------------------
// The same search and the same licence bar as the finder, but the shortlist
// comes here instead of to a model. Choosing loads the full-resolution original
// into the panel, so the crop is made from the source rather than from an image
// that has already been cropped and re-encoded once.

let pickerSlot = "card";
let pickerBusy = false;
// The whole result set is held here, so re-sorting is instant. Switching target
// still re-queries: the minimum width differs per target, so the candidate set
// genuinely differs, whereas the ordering does not.
let pickerCandidates = [];

function openPicker(slot) {
  if (!selectedPlace) return;
  pickerSlot = slot;
  picker.hidden = false;
  pickerTitle.textContent = `Browse Commons — ${selectedPlace.name}`;
  pickerQuery.value = selectedPlace.name;
  renderPickerTarget();
  pickerQuery.focus();
  pickerQuery.select();
  searchPicker();
}

function closePicker() {
  picker.hidden = true;
  pickerGrid.replaceChildren();
}

function renderPickerTarget() {
  for (const btn of pickerTargetBtns) {
    btn.classList.toggle("active", btn.dataset.slot === pickerSlot);
    btn.textContent = TARGETS[btn.dataset.slot].label;
  }
}

function pickerMessage(text) {
  const div = document.createElement("div");
  div.id = "pi-picker-empty";
  div.textContent = text;
  pickerGrid.replaceChildren(div);
}

async function searchPicker() {
  if (pickerBusy) return;
  const query = pickerQuery.value.trim();
  if (!query) return;
  pickerBusy = true;
  pickerCount.textContent = "Searching…";
  pickerMessage("Searching Wikimedia Commons…");

  // 0 = every usable candidate; the grid scrolls and lazy-loads its thumbnails.
  const result = await pywebview.api.browse_commons(
    query, pickerMode.value, pickerSlot, pickerLarge.checked, 0
  );
  pickerBusy = false;

  if (result.error) {
    pickerCount.textContent = "";
    return pickerMessage("Commons search failed: " + result.error);
  }
  const list = result.candidates || [];
  pickerCount.textContent =
    `${list.length} usable of ${result.returned} files` +
    (result.filtered_out ? ` · ${result.filtered_out} filtered out` : "") +
    (result.more_available ? " · more exist, narrow the search" : "");

  pickerCandidates = list;
  if (!list.length) {
    return pickerMessage(
      `Nothing usable for "${result.query}" (${result.mode}). ` +
      (result.filtered_out
        ? `${result.filtered_out} files were filtered out — try unticking "large landscape only", or search different terms.`
        : "Try different search terms, or add the county.")
    );
  }
  renderCandidates(sortCandidates(list));
}

/**
 * Best fit ranks by how much of a photo's height survives this target's crop,
 * which is what matters for a letterbox — but it can float an unusually wide
 * image above a better photograph, so largest is offered as the alternative.
 * Each falls back to the other as a tiebreak.
 */
function sortCandidates(list) {
  const keeps = (c) => c.keeps_height[pickerSlot] || 0;
  const pixels = (c) => c.width * c.height;
  return [...list].sort((a, b) =>
    pickerSort.value === "size"
      ? pixels(b) - pixels(a) || keeps(b) - keeps(a)
      : keeps(b) - keeps(a) || pixels(b) - pixels(a)
  );
}

function renderCandidates(list) {
  const frag = document.createDocumentFragment();
  for (const cand of list) {
    const tile = document.createElement("div");
    tile.className = "pi-cand";
    tile.title = cand.description || cand.name;

    const img = document.createElement("img");
    img.src = cand.thumburl;
    img.alt = "";
    img.loading = "lazy";

    const body = document.createElement("div");
    body.className = "pi-cand-body";

    const name = document.createElement("div");
    name.className = "pi-cand-name";
    name.textContent = cand.name;

    const meta = document.createElement("div");
    meta.className = "pi-cand-meta";
    meta.textContent = `${cand.artist || "Unknown"} · ${cand.licence}`;

    const foot = document.createElement("div");
    foot.className = "pi-cand-foot";
    const dims = document.createElement("span");
    dims.textContent = `${cand.width}×${cand.height}`;
    foot.appendChild(dims);

    // How much of the photo's height survives this target's crop — the same
    // number the finder uses to spot framing that would behead the subject.
    const keeps = cand.keeps_height[pickerSlot];
    const chip = document.createElement("span");
    chip.className = "pi-keeps " + (keeps >= 75 ? "roomy" : keeps < 60 ? "tight" : "");
    chip.textContent = `keeps ${keeps}%`;
    chip.title =
      `${keeps}% of this photo's height survives the ${TARGETS[pickerSlot].label.toLowerCase()} crop` +
      (keeps < 60 ? " — a subject filling the frame would be cut" : "");
    foot.appendChild(chip);

    if (cand.page) {
      const link = document.createElement("a");
      link.textContent = "source";
      link.href = "#";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        pywebview.api.open_url(cand.page);
      });
      foot.appendChild(link);
    }

    body.append(name, meta, foot);
    tile.append(img, body);
    tile.addEventListener("click", () => chooseCandidate(cand));
    frag.appendChild(tile);
  }
  pickerGrid.replaceChildren(frag);
}

/** Loads the chosen original and pre-fills the credit, ready to Apply. */
async function chooseCandidate(cand) {
  const panel = panels[pickerSlot];
  if (!panel) return;
  pickerMessage(`Loading ${cand.name}…`);
  const result = await pywebview.api.load_slot_image_from_url(panel.slot, cand.url);
  if (result && result.error) {
    return pickerMessage("Could not load that image: " + result.error);
  }
  // Enough of a record for the attribution row and its Source button.
  result.record = {
    author: cand.artist,
    license: cand.licence,
    source_title: cand.title,
    source_page: cand.page,
    attribution_line: `"${cand.name}" by ${cand.artist || "Unknown"}, via Wikimedia Commons, ${cand.licence}.`,
  };
  await panel.setSource(result);

  // Credit filled in and applied, so the watermark is on the canvas before you
  // start cropping. Both fields stay editable — Apply re-does it.
  panel.creditInput.value = cand.credit_name || cand.artist || "";
  setLicenceOption(panel.licenceSelect, cand.licence);
  const credit = panel.applyCredit();
  panel.render();

  closePicker();
  setStatus(
    `${TARGETS[pickerSlot].label}: ${cand.name} (${cand.width}×${cand.height}). ` +
    (credit ? `Watermark set — "${credit}". ` : "No author on this file — add a credit. ") +
    "Crop, then Save."
  );
}

/**
 * Selects the file's licence, adding it to the list if it is not one of the
 * presets. Commons carries licences the dropdown was never built for, and
 * silently leaving the wrong one selected would put a false licence on the image.
 */
function setLicenceOption(select, licence) {
  const wanted = (licence || "").trim();
  if (!wanted) return;
  let option = Array.from(select.options)
    .find((o) => o.value.toLowerCase() === wanted.toLowerCase());
  if (!option) {
    option = document.createElement("option");
    option.value = wanted;
    option.textContent = wanted;
    option.dataset.fromCommons = "1";
    select.appendChild(option);
  }
  select.value = option.value;
}

document.getElementById("pi-picker-search").addEventListener("click", searchPicker);
document.getElementById("pi-picker-close").addEventListener("click", closePicker);
pickerQuery.addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchPicker();
});
pickerMode.addEventListener("change", searchPicker);
// Re-sorting needs no round trip: every candidate is already here.
pickerSort.addEventListener("change", () => {
  if (pickerCandidates.length) renderCandidates(sortCandidates(pickerCandidates));
});
pickerLarge.addEventListener("change", searchPicker);
for (const btn of pickerTargetBtns) {
  btn.addEventListener("click", () => {
    pickerSlot = btn.dataset.slot;
    renderPickerTarget();
    searchPicker();
  });
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !picker.hidden) closePicker();
});

/** "both", or one slot on its own. The canvases follow via their observers. */
function setLayout(mode) {
  layoutMode = mode;
  for (const panel of Object.values(panels)) panel.renderCollapse();
}

function copyBlockedReason(panel) {
  return `${panel.spec.label} already has an image — choose Re-crop, Replace or Clear there first`;
}

function loadImage(dataUrl) {
  return new Promise((resolve) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.src = dataUrl;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

// --- Place list ------------------------------------------------------------

function matchesSearch(place, term) {
  if (!term) return true;
  return [place.name, place.town, place.county]
    .filter(Boolean)
    .some((v) => v.toLowerCase().includes(term));
}

function renderList() {
  const term = searchInput.value.trim().toLowerCase();
  const filter = FILTERS[filterSelect.value] || FILTERS.all;
  visiblePlaces = places.filter((p) => filter(p) && matchesSearch(p, term));

  const frag = document.createDocumentFragment();
  for (const place of visiblePlaces) {
    const row = document.createElement("div");
    row.className = "pi-row" + (selectedPlace && selectedPlace.id === place.id ? " selected" : "");
    row.dataset.id = place.id;

    const name = document.createElement("div");
    name.className = "pi-row-name";
    name.textContent = place.name;

    const meta = document.createElement("div");
    meta.className = "pi-row-meta";
    meta.textContent = [place.town, place.county].filter(Boolean).join(", ");

    const badges = document.createElement("div");
    badges.className = "pi-row-badges";
    for (const slot of ["card", "hero"]) {
      const dot = document.createElement("span");
      const has = !!place[TARGETS[slot].column];
      dot.className = "pi-dot " + (has ? "on" : "off");
      dot.textContent = TARGETS[slot].label[0];
      dot.title = `${TARGETS[slot].label}: ${has ? place[TARGETS[slot].column] : "missing"}`;
      badges.appendChild(dot);
    }

    row.append(name, meta, badges);
    frag.appendChild(row);
  }
  listEl.replaceChildren(frag);

  const missingCard = places.filter((p) => !p.image_path).length;
  const missingHero = places.filter((p) => !p.hero_image_path).length;
  countEl.textContent = `${visiblePlaces.length} of ${places.length} shown · ${missingCard} without card · ${missingHero} without hero`;
}

async function selectPlace(place) {
  selectedPlace = place;
  placeNameEl.textContent = place.name;
  placeMetaEl.textContent = [place.town, place.county].filter(Boolean).join(", ");
  renderPlaceLinks();
  filenameInput.disabled = false;
  filenameInput.value = slugify(place.name);

  for (const panel of Object.values(panels)) await panel.clearSource();
  renderList();
  setStatus(`${place.name} — card ${place.image_path ? "✓" : "missing"}, hero ${place.hero_image_path ? "✓" : "missing"}`);
}

// A place often has only one of the two URLs, so a button with nothing behind it
// is hidden rather than left dead.
function renderPlaceLinks() {
  for (const btn of placeLinkButtons) {
    const url = selectedPlace ? selectedPlace[btn.dataset.field] : null;
    btn.hidden = !url;
    btn.disabled = !url;
    btn.title = url || "";
  }
}

for (const btn of placeLinkButtons) {
  btn.addEventListener("click", async () => {
    const url = selectedPlace && selectedPlace[btn.dataset.field];
    if (!url) return;
    try {
      const result = await pywebview.api.open_url(url);
      if (result && result.error) setStatus("Error: " + result.error);
    } catch (e) {
      setStatus("Error opening link");
    }
  });
}

renderPlaceLinks();

listEl.addEventListener("click", (e) => {
  const row = e.target.closest(".pi-row");
  if (!row) return;
  const place = places.find((p) => String(p.id) === row.dataset.id);
  if (place) selectPlace(place);
});

searchInput.addEventListener("input", renderList);
filterSelect.addEventListener("change", renderList);

document.getElementById("btn-back").addEventListener("click", () => {
  window.location.href = "home.html";
});

btnFindAll.addEventListener("click", () => startFind(findableSlots()));

document.getElementById("btn-refresh").addEventListener("click", loadPlaces);

document.getElementById("btn-folder").addEventListener("click", async () => {
  const result = await pywebview.api.choose_output_folder();
  if (result && result.folder) setStatus("Output: " + result.folder);
});

// Paste an image from the clipboard into whichever panel was last used.
window.addEventListener("paste", async (e) => {
  const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
  if (!item) return;
  const target = focusedPanel || panels.card;
  await target.loadFile(item.getAsFile());
});

// Arrow keys nudge the focused panel by a pixel.
window.addEventListener("keydown", (e) => {
  if (!picker.hidden) return;
  const tag = document.activeElement.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  const panel = focusedPanel;
  if (!panel || !panel.img) return;
  const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const move = moves[e.key];
  if (!move) return;
  e.preventDefault();
  panel.transform.x += move[0];
  panel.transform.y += move[1];
  panel.draw();
});

// --- Init ------------------------------------------------------------------

async function loadPlaces() {
  setStatus("Loading places…");
  const result = await pywebview.api.get_places_with_images();
  places = result.places || [];
  imageBaseUrl = result.image_base_url || "";
  if (result.error) {
    setStatus("Could not load places: " + result.error);
  } else {
    setStatus(`${places.length} places loaded`);
  }
  // Keep the selection pointed at the refreshed row.
  if (selectedPlace) {
    selectedPlace = places.find((p) => p.id === selectedPlace.id) || null;
    if (!selectedPlace) {
      placeNameEl.textContent = "Select a place";
      placeMetaEl.textContent = "";
      filenameInput.value = "";
      filenameInput.disabled = true;
    }
    renderPlaceLinks();
  }
  renderList();
  for (const panel of Object.values(panels)) panel.render();
}

async function init() {
  config = await pywebview.api.get_config();
  finderStatus = await pywebview.api.finder_ready();
  for (const slot of Object.keys(TARGETS)) {
    panels[slot] = new Panel(slot);
    panels[slot].resize();
    panels[slot].render();
    panels[slot].draw();
  }
  await loadPlaces();
  searchInput.focus();
}

window.addEventListener("pywebviewready", init);
