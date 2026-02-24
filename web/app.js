// State
let img = null;
let imgTransform = { x: 0, y: 0, scale: 1, rotation: 0 };
let cropBox = { x: 0, y: 0, width: 0, height: 0 };
let enhanced = false;
let enhancedDataUrl = null;
let originalDataUrl = null;
let config = null;
let creditText = "";
let places = [];
let selectedPlaceId = null;

// DOM
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const container = document.getElementById("canvas-container");
const overlay = document.getElementById("crop-overlay");
const dropHint = document.getElementById("drop-hint");
const statusText = document.getElementById("status-text");

const btnOpen = document.getElementById("btn-open");
const btnZoomIn = document.getElementById("btn-zoom-in");
const btnZoomOut = document.getElementById("btn-zoom-out");
const btnEnhance = document.getElementById("btn-enhance");
const btnSave = document.getElementById("btn-save");
const btnFolder = document.getElementById("btn-folder");
const btnRotateCCW = document.getElementById("btn-rotate-ccw");
const btnRotateCW = document.getElementById("btn-rotate-cw");
const btnCentre = document.getElementById("btn-centre");
const filenameInput = document.getElementById("filename-input");
const creditInput = document.getElementById("credit-input");
const licenceSelect = document.getElementById("licence-select");
const btnApplyCredit = document.getElementById("btn-apply-credit");
const placeInput = document.getElementById("place-input");
const placesList = document.getElementById("places-list");

// Init
async function init() {
  config = await pywebview.api.get_config();
  resizeCanvas();
  updateCropOverlay();
  draw();

  try {
    const result = await pywebview.api.get_places();
    if (result && result.places) {
      places = result.places;
      populatePlaces();
    }
  } catch (e) {
    // Supabase is optional — silently ignore
  }
}

function populatePlaces() {
  placesList.innerHTML = "";
  for (const place of places) {
    const opt = document.createElement("option");
    opt.value = place.name;
    placesList.appendChild(opt);
  }
}

function resizeCanvas() {
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
}

function updateCropOverlay() {
  if (!config) return;

  const containerW = container.clientWidth;
  const containerH = container.clientHeight;

  // Scale crop box to fit within canvas with some padding
  const maxW = containerW * 0.85;
  const maxH = containerH * 0.85;
  const ratio = config.crop_width / config.crop_height;

  let boxW, boxH;
  if (maxW / ratio <= maxH) {
    boxW = maxW;
    boxH = maxW / ratio;
  } else {
    boxH = maxH;
    boxW = maxH * ratio;
  }

  cropBox.width = boxW;
  cropBox.height = boxH;
  cropBox.x = (containerW - boxW) / 2;
  cropBox.y = (containerH - boxH) / 2;

  overlay.style.left = cropBox.x + "px";
  overlay.style.top = cropBox.y + "px";
  overlay.style.width = cropBox.width + "px";
  overlay.style.height = cropBox.height + "px";
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (img) {
    ctx.save();
    // Translate to image center, rotate, then draw offset
    const cx = imgTransform.x + (img.width * imgTransform.scale) / 2;
    const cy = imgTransform.y + (img.height * imgTransform.scale) / 2;
    ctx.translate(cx, cy);
    ctx.rotate((imgTransform.rotation * Math.PI) / 180);
    ctx.scale(imgTransform.scale, imgTransform.scale);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    ctx.restore();
  }
  if (creditText) {
    const padding = 8;
    const fontSize = Math.max(12, Math.round(cropBox.height * 0.03));
    ctx.font = fontSize + "px sans-serif";
    const metrics = ctx.measureText(creditText);
    const textW = metrics.width;
    const textH = fontSize;
    const tx = cropBox.x + cropBox.width - textW - padding * 2;
    const ty = cropBox.y + cropBox.height - textH - padding * 2;
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillRect(tx, ty, textW + padding * 2, textH + padding * 2);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "top";
    ctx.fillText(creditText, tx + padding, ty + padding);
  }
}

function fitImageToCrop() {
  if (!img) return;
  const scaleX = cropBox.width / img.width;
  const scaleY = cropBox.height / img.height;
  // Use the larger scale so image covers the entire crop box
  imgTransform.scale = Math.max(scaleX, scaleY);
  // Center the image on the crop box
  imgTransform.x = cropBox.x + (cropBox.width - img.width * imgTransform.scale) / 2;
  imgTransform.y = cropBox.y + (cropBox.height - img.height * imgTransform.scale) / 2;
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const newImg = new window.Image();
    newImg.onload = () => resolve(newImg);
    newImg.src = dataUrl;
  });
}

function setStatus(text) {
  statusText.textContent = text;
}

function enableButtons() {
  btnZoomIn.disabled = false;
  btnZoomOut.disabled = false;
  btnRotateCCW.disabled = false;
  btnRotateCW.disabled = false;
  btnCentre.disabled = false;
  btnEnhance.disabled = false;
  btnSave.disabled = false;
  creditInput.disabled = false;
  licenceSelect.disabled = false;
  btnApplyCredit.disabled = false;
}

// --- Event handlers ---

btnOpen.addEventListener("click", async () => {
  setStatus("Opening file...");
  const result = await pywebview.api.open_file_dialog();
  if (!result) {
    setStatus("Cancelled");
    return;
  }
  if (result.error) {
    setStatus("Error: " + result.error);
    return;
  }
  originalDataUrl = result.data_url;
  enhancedDataUrl = null;
  enhanced = false;
  imgTransform.rotation = 0;
  creditText = "";
  creditInput.value = "";
  licenceSelect.selectedIndex = 0;
  placeInput.value = "";
  selectedPlaceId = null;
  btnEnhance.textContent = "Auto Enhance: OFF";
  btnEnhance.classList.remove("active");

  img = await loadImageFromDataUrl(result.data_url);
  overlay.style.display = "block";
  dropHint.style.display = "none";
  fitImageToCrop();
  draw();
  enableButtons();
  // Pre-fill filename input (without extension)
  filenameInput.value = result.filename.replace(/\.[^/.]+$/, "");
  setStatus(result.filename + " (" + result.width + "x" + result.height + ")");
});

btnEnhance.addEventListener("click", async () => {
  if (!img) return;
  enhanced = !enhanced;
  btnEnhance.textContent = enhanced ? "Auto Enhance: ON" : "Auto Enhance: OFF";
  btnEnhance.classList.toggle("active", enhanced);

  if (enhanced) {
    if (!enhancedDataUrl) {
      setStatus("Enhancing...");
      const result = await pywebview.api.auto_enhance();
      if (result.error) {
        setStatus("Enhance error: " + result.error);
        enhanced = false;
        btnEnhance.textContent = "Auto Enhance: OFF";
        btnEnhance.classList.remove("active");
        return;
      }
      enhancedDataUrl = result.data_url;
    }
    // Keep current position/scale
    const oldTransform = { ...imgTransform };
    img = await loadImageFromDataUrl(enhancedDataUrl);
    imgTransform = oldTransform;
    setStatus("Enhanced view");
  } else {
    const oldTransform = { ...imgTransform };
    img = await loadImageFromDataUrl(originalDataUrl);
    imgTransform = oldTransform;
    setStatus("Original view");
  }
  draw();
});

btnApplyCredit.addEventListener("click", () => {
  const name = creditInput.value.trim();
  if (name) {
    const licence = licenceSelect.value;
    creditText = "Photo: " + name + " / " + licence + " (modified)";
  } else {
    creditText = "";
  }
  draw();
});

placeInput.addEventListener("input", () => {
  const val = placeInput.value.trim();
  const match = places.find((p) => p.name === val);
  selectedPlaceId = match ? match.id : null;
  if (match) {
    filenameInput.value = match.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
});

btnSave.addEventListener("click", async () => {
  if (!img) return;
  setStatus("Saving...");
  const result = await pywebview.api.save_crop(
    canvas.width,
    canvas.height,
    cropBox,
    imgTransform,
    enhanced,
    filenameInput.value.trim(),
    imgTransform.rotation,
    creditText,
    selectedPlaceId
  );
  if (result.error) {
    setStatus("Save error: " + result.error);
  } else if (result.supabase_error) {
    setStatus("Saved: " + result.path + " (upload failed: " + result.supabase_error + ")");
  } else if (result.uploaded) {
    setStatus("Saved & uploaded: " + result.path);
  } else {
    setStatus("Saved: " + result.path);
  }
});

btnFolder.addEventListener("click", async () => {
  const result = await pywebview.api.choose_output_folder();
  if (result && result.folder) {
    setStatus("Output: " + result.folder);
  }
});

btnZoomIn.addEventListener("click", () => zoom(1.05));
btnZoomOut.addEventListener("click", () => zoom(1 / 1.05));

btnRotateCCW.addEventListener("click", () => {
  if (!img) return;
  imgTransform.rotation -= 1;
  draw();
});

btnRotateCW.addEventListener("click", () => {
  if (!img) return;
  imgTransform.rotation += 1;
  draw();
});

btnCentre.addEventListener("click", () => {
  if (!img) return;
  fitImageToCrop();
  draw();
});

// Arrow keys for fine nudge (1px per press)
window.addEventListener("keydown", (e) => {
  if (!img) return;
  // Don't capture arrows when typing in an input/select
  const tag = document.activeElement.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  const NUDGE = 1;
  switch (e.key) {
    case "ArrowLeft":
      imgTransform.x -= NUDGE;
      break;
    case "ArrowRight":
      imgTransform.x += NUDGE;
      break;
    case "ArrowUp":
      imgTransform.y -= NUDGE;
      break;
    case "ArrowDown":
      imgTransform.y += NUDGE;
      break;
    default:
      return;
  }
  e.preventDefault();
  draw();
});

function zoom(factor, centerX, centerY) {
  if (!img) return;
  if (centerX === undefined) {
    centerX = cropBox.x + cropBox.width / 2;
    centerY = cropBox.y + cropBox.height / 2;
  }
  const oldScale = imgTransform.scale;
  imgTransform.scale *= factor;
  // Clamp scale
  imgTransform.scale = Math.max(0.05, Math.min(imgTransform.scale, 20));
  const realFactor = imgTransform.scale / oldScale;
  imgTransform.x = centerX - (centerX - imgTransform.x) * realFactor;
  imgTransform.y = centerY - (centerY - imgTransform.y) * realFactor;
  draw();
}

// Mouse drag
let dragging = false;
let dragStartX, dragStartY;

canvas.addEventListener("mousedown", (e) => {
  if (!img) return;
  dragging = true;
  dragStartX = e.clientX - imgTransform.x;
  dragStartY = e.clientY - imgTransform.y;
  canvas.style.cursor = "grabbing";
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  imgTransform.x = e.clientX - dragStartX;
  imgTransform.y = e.clientY - dragStartY;
  draw();
});

window.addEventListener("mouseup", () => {
  dragging = false;
  canvas.style.cursor = img ? "grab" : "default";
});

// Mouse wheel zoom
canvas.addEventListener("wheel", (e) => {
  if (!img) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
  zoom(factor, mx, my);
}, { passive: false });

// Touch support
let lastTouchDist = 0;
let lastTouchX = 0;
let lastTouchY = 0;
let touching = false;

canvas.addEventListener("touchstart", (e) => {
  if (!img) return;
  e.preventDefault();
  if (e.touches.length === 1) {
    touching = true;
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
  } else if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    lastTouchDist = Math.hypot(dx, dy);
    lastTouchX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    lastTouchY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
  }
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
  if (!img) return;
  e.preventDefault();
  if (e.touches.length === 1 && touching) {
    const dx = e.touches[0].clientX - lastTouchX;
    const dy = e.touches[0].clientY - lastTouchY;
    imgTransform.x += dx;
    imgTransform.y += dy;
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
    draw();
  } else if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.hypot(dx, dy);
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const rect = canvas.getBoundingClientRect();

    if (lastTouchDist > 0) {
      const factor = dist / lastTouchDist;
      zoom(factor, cx - rect.left, cy - rect.top);
    }

    // Also pan
    const panDx = cx - lastTouchX;
    const panDy = cy - lastTouchY;
    imgTransform.x += panDx;
    imgTransform.y += panDy;
    draw();

    lastTouchDist = dist;
    lastTouchX = cx;
    lastTouchY = cy;
  }
}, { passive: false });

canvas.addEventListener("touchend", (e) => {
  if (e.touches.length < 2) lastTouchDist = 0;
  if (e.touches.length === 0) touching = false;
});

// Resize handling
window.addEventListener("resize", () => {
  resizeCanvas();
  updateCropOverlay();
  if (img) fitImageToCrop();
  draw();
});

// Wait for pywebview API
window.addEventListener("pywebviewready", init);
