// Dataset registry — mirrors PlaceDatasetRegistry / DiscoverPage in the MAUI app.
// "featured" and "other" are pseudo-datasets: featured places are pulled out of
// their managed_by bucket and shown on their own layer, as the app does.
const FEATURED_KEY = "__featured";
const OTHER_KEY = "__other";

const DATASETS = [
  { key: "English Heritage", label: "English Heritage", color: "#E62506" },
  { key: "National Trust", label: "National Trust", color: "#228B22" },
  { key: "Historic Houses", label: "Historic Houses", color: "#4B0082" },
  { key: "Historic Royal Palaces", label: "Historic Royal Palaces", color: "#00566B" },
  { key: "Cadw", label: "Cadw", color: "#14382E" },
  { key: "Historic Environment Scotland", label: "Historic Environment Scotland", color: "#006390" },
  { key: "National Trust for Scotland", label: "National Trust for Scotland", color: "#00847e" },
  { key: OTHER_KEY, label: "Other", color: "#512BD4" },
  { key: FEATURED_KEY, label: "Featured", color: "#0353A4" },
];

const PIN_SVG =
  '<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M16 1c5.3 0 9.6 4.3 9.6 9.6 0 1.7-0.4 3.3-1.3 4.8L16 29.8 7.7 15.4c-0.8-1.5-1.3-3.1-1.3-4.8C6.4 5.3 10.7 1 16 1z" fill="{COLOR}"/>' +
  '<circle cx="16" cy="10.7" r="3.7" fill="#FFFFFF"/>' +
  "</svg>";

// State
let map = null;
const layers = {}; // dataset key -> L.LayerGroup
const counts = {}; // dataset key -> number of places
const enabled = {}; // dataset key -> bool
let totalPlaces = 0;
const icons = {}; // dataset key -> L.DivIcon
const markersById = {}; // place id -> L.Marker
const records = []; // { place, marker, key } for every mapped place
let pinFilter = "all"; // all | not-updated | updated
const baseLayers = {}; // street | aerial
let labelsLayer = null;
let basemap = "street";

// DOM
const statusText = document.getElementById("status-text");
const datasetList = document.getElementById("dataset-list");
const placeOverlay = document.getElementById("place-overlay");
const placeName = document.getElementById("place-name");
const placePinStatus = document.getElementById("place-pin-status");
const placeSaveStatus = document.getElementById("place-save-status");
const officialWebsiteInput = document.getElementById("input-official-website");
const websiteInput = document.getElementById("input-website");
const pinFilterSelect = document.getElementById("pin-filter");
const basemapToggle = document.getElementById("basemap-toggle");
const crosshair = document.getElementById("crosshair");
const repositionBar = document.getElementById("reposition-bar");
const repositionLabel = document.getElementById("reposition-label");
const repositionCoords = document.getElementById("reposition-coords");

// Back
document.getElementById("btn-back").addEventListener("click", () => {
  window.location.href = "home.html";
});

// Init
function initMap() {
  map = L.map("map").setView([54.5, -3.0], 6);

  baseLayers.street = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  });
  // Same imagery the app's satellite toggle uses (DiscoverPage.CreateSatelliteLayer)
  baseLayers.aerial = L.tileLayer(
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" }
  );
  // Transparent place names and boundaries, for reading imagery at close zoom
  labelsLayer = L.tileLayer(
    "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Labels &copy; Esri" }
  );
  setBasemap("street");

  DATASETS.forEach((ds) => {
    layers[ds.key] = L.layerGroup().addTo(map);
    counts[ds.key] = 0;
    enabled[ds.key] = true;
    icons[ds.key] = L.divIcon({
      html: PIN_SVG.replace("{COLOR}", ds.color),
      className: "place-pin",
      iconSize: [32, 32],
      iconAnchor: [16, 30],
    });
  });
}

async function init() {
  initMap();
  renderDatasetList();
  statusText.textContent = "Loading places...";
  try {
    const result = await pywebview.api.get_map_places();
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      return;
    }
    addPlaces(result.places || []);
    applyPinFilter();
  } catch (e) {
    statusText.textContent = "Error loading places";
  }
}

function datasetKeyFor(place) {
  if (place.featured) return FEATURED_KEY;
  const managedBy = place.managed_by;
  if (managedBy && layers[managedBy]) return managedBy;
  return OTHER_KEY;
}

function addPlaces(places) {
  places.forEach((place) => {
    const lat = place.latitude;
    const lon = place.longitude;
    if (lat == null || lon == null) return;
    const key = datasetKeyFor(place);
    const marker = L.marker([lat, lon], { icon: icons[key], title: place.name });
    marker.on("click", () => showPlace(place));
    markersById[place.id] = marker;
    records.push({ place: place, marker: marker, key: key });
    totalPlaces += 1;
  });
}

// Pin position filter. Works alongside the dataset toggles: a marker is on the
// map only if its dataset is enabled AND it passes this filter.
function matchesPinFilter(place) {
  if (pinFilter === "not-updated") return !place.pin_position_updated_at;
  if (pinFilter === "updated") return !!place.pin_position_updated_at;
  return true;
}

function applyPinFilter() {
  DATASETS.forEach((ds) => {
    counts[ds.key] = 0;
  });
  records.forEach((rec) => {
    const layer = layers[rec.key];
    if (matchesPinFilter(rec.place)) {
      counts[rec.key] += 1;
      if (!layer.hasLayer(rec.marker)) layer.addLayer(rec.marker);
    } else if (layer.hasLayer(rec.marker)) {
      layer.removeLayer(rec.marker);
    }
  });
  renderDatasetList();
  updateStatus();
}

pinFilterSelect.addEventListener("change", () => {
  pinFilter = pinFilterSelect.value;
  applyPinFilter();
});

// Base map — the toggle cycles Street -> Aerial -> Aerial with labels
const BASEMAPS = [
  { key: "street", label: "Street" },
  { key: "aerial", label: "Aerial" },
  { key: "aerial-labels", label: "Aerial + labels" },
];

function setBasemap(choice) {
  basemap = choice;
  const wantAerial = choice !== "street";
  const nextBase = wantAerial ? baseLayers.aerial : baseLayers.street;
  const prevBase = wantAerial ? baseLayers.street : baseLayers.aerial;
  if (map.hasLayer(prevBase)) map.removeLayer(prevBase);
  if (!map.hasLayer(nextBase)) nextBase.addTo(map);
  nextBase.bringToBack();

  if (choice === "aerial-labels") {
    if (!map.hasLayer(labelsLayer)) labelsLayer.addTo(map);
  } else if (map.hasLayer(labelsLayer)) {
    map.removeLayer(labelsLayer);
  }

  const current = BASEMAPS.find((b) => b.key === choice);
  const next = BASEMAPS[(BASEMAPS.indexOf(current) + 1) % BASEMAPS.length];
  basemapToggle.textContent = current.label;
  basemapToggle.title = "Switch to " + next.label;
}

basemapToggle.addEventListener("click", () => {
  const index = BASEMAPS.findIndex((b) => b.key === basemap);
  setBasemap(BASEMAPS[(index + 1) % BASEMAPS.length].key);
});

// Dataset toggles
function renderDatasetList() {
  datasetList.innerHTML = "";
  DATASETS.forEach((ds) => {
    const row = document.createElement("label");
    row.className = "dataset-row";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = enabled[ds.key];
    check.addEventListener("change", () => setDatasetEnabled(ds.key, check.checked));

    const swatch = document.createElement("span");
    swatch.className = "dataset-swatch";
    swatch.style.background = ds.color;

    const label = document.createElement("span");
    label.className = "dataset-label";
    label.textContent = ds.label;

    const count = document.createElement("span");
    count.className = "dataset-count";
    count.textContent = counts[ds.key];

    row.appendChild(check);
    row.appendChild(swatch);
    row.appendChild(label);
    row.appendChild(count);
    datasetList.appendChild(row);
  });
}

function setDatasetEnabled(key, on) {
  enabled[key] = on;
  if (on) {
    layers[key].addTo(map);
  } else {
    map.removeLayer(layers[key]);
  }
  updateStatus();
}

function setAllDatasets(on) {
  DATASETS.forEach((ds) => setDatasetEnabled(ds.key, on));
  renderDatasetList();
}

document.getElementById("btn-datasets-all").addEventListener("click", () => setAllDatasets(true));
document.getElementById("btn-datasets-none").addEventListener("click", () => setAllDatasets(false));

function updateStatus() {
  const shown = DATASETS.reduce((sum, ds) => sum + (enabled[ds.key] ? counts[ds.key] : 0), 0);
  statusText.textContent = totalPlaces + " places · " + shown + " shown";
}

// Pin dialog. selectedPlace is kept for future actions (view details, reposition).
let selectedPlace = null;

function showPlace(place) {
  selectedPlace = place;
  placeName.textContent = place.name || "(no name)";
  placePinStatus.textContent = place.pin_position_updated_at
    ? "Pin repositioned " + formatTimestamp(place.pin_position_updated_at)
    : "Pin not repositioned yet";
  officialWebsiteInput.value = place.official_website || "";
  websiteInput.value = place.website || "";
  placeSaveStatus.textContent = "";
  placeOverlay.classList.remove("hidden");
}

function formatTimestamp(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString();
}

async function saveWebsites() {
  const place = selectedPlace;
  if (!place) return;
  const official = officialWebsiteInput.value.trim();
  const website = websiteInput.value.trim();
  placeSaveStatus.textContent = "Saving...";
  try {
    const result = await pywebview.api.update_place_websites(place.id, official, website);
    if (result.error) {
      placeSaveStatus.textContent = result.error;
      return;
    }
    place.official_website = official || null;
    place.website = website || null;
    placeSaveStatus.textContent = "Saved";
  } catch (e) {
    placeSaveStatus.textContent = "Error saving websites";
  }
}

document.getElementById("btn-save-websites").addEventListener("click", saveWebsites);

// Confirms the pin is already in the right place: stamps it as checked without
// moving it, so it drops out of the "not repositioned yet" list.
async function confirmPin() {
  const place = selectedPlace;
  if (!place) return;
  placeSaveStatus.textContent = "Confirming...";
  try {
    const result = await pywebview.api.confirm_place_position(place.id);
    if (result.error) {
      placeSaveStatus.textContent = result.error;
      return;
    }
    place.pin_position_updated_at = result.pin_position_updated_at || new Date().toISOString();
    closePlace();
    applyPinFilter();
    statusText.textContent = "Confirmed " + (place.name || "pin");
  } catch (e) {
    placeSaveStatus.textContent = "Error confirming pin";
  }
}

document.getElementById("btn-confirm-pin").addEventListener("click", confirmPin);

// Opens in the system browser — a plain href would navigate the app window.
document.querySelectorAll(".btn-open-url").forEach((btn) => {
  btn.addEventListener("click", () => {
    const url = document.getElementById(btn.dataset.input).value.trim();
    if (url) openUrl(url);
  });
});

async function openUrl(url) {
  try {
    const result = await pywebview.api.open_url(url);
    if (result.error) statusText.textContent = "Error: " + result.error;
  } catch (e) {
    statusText.textContent = "Error opening link";
  }
}

function closePlace() {
  selectedPlace = null;
  placeOverlay.classList.add("hidden");
}

document.getElementById("btn-close-place").addEventListener("click", closePlace);
placeOverlay.addEventListener("click", (e) => {
  if (e.target === placeOverlay) closePlace();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (repositionPlace) cancelReposition();
  else if (!placeOverlay.classList.contains("hidden")) closePlace();
});

// Reposition pin. Mirrors the app's reposition modal: centre on the place, keep a
// fixed crosshair, drag the map until the crosshair sits where the pin should be.
let repositionPlace = null;
let repositionMarker = null;
let repositionStartCentre = null;

function startReposition() {
  const place = selectedPlace;
  if (!place) return;
  closePlace();
  repositionPlace = place;
  repositionMarker = markersById[place.id] || null;
  if (repositionMarker) repositionMarker.setOpacity(0);

  repositionLabel.textContent = "Drag the map to reposition " + (place.name || "this pin");
  crosshair.classList.remove("hidden");
  repositionBar.classList.remove("hidden");
  // Keep whatever zoom the user was working at; only recentre on the place.
  // Unanimated, so the crosshair and the coordinate readout are correct
  // immediately — an animated pan would leave Save reading a stale centre.
  map.setView([place.latitude, place.longitude], map.getZoom(), { animate: false });
  // Leaflet snaps the centre to whole pixels, so it lands near the place rather
  // than exactly on it — a whole kilometre out at low zoom. Remember where we
  // started so an undragged Save can use the original coordinates instead.
  repositionStartCentre = map.getCenter();
  updateRepositionCoords();
  map.on("move", updateRepositionCoords);
}

function updateRepositionCoords() {
  const c = map.getCenter();
  repositionCoords.textContent = c.lat.toFixed(6) + ", " + c.lng.toFixed(6);
}

function endReposition() {
  map.off("move", updateRepositionCoords);
  if (repositionMarker) repositionMarker.setOpacity(1);
  repositionPlace = null;
  repositionMarker = null;
  repositionStartCentre = null;
  crosshair.classList.add("hidden");
  repositionBar.classList.add("hidden");
}

function cancelReposition() {
  endReposition();
  updateStatus();
}

async function saveReposition() {
  const place = repositionPlace;
  const marker = repositionMarker;
  if (!place) return;
  const centre = map.getCenter();
  const dragged = !repositionStartCentre || !centre.equals(repositionStartCentre);
  statusText.textContent = "Saving position...";
  try {
    // Saving without dragging means "this pin is already right", which is a
    // confirm — writing the pixel-snapped centre would nudge the pin instead.
    const result = dragged
      ? await pywebview.api.update_place_coordinates(place.id, centre.lat, centre.lng)
      : await pywebview.api.confirm_place_position(place.id);
    if (result.error) {
      statusText.textContent = "Error: " + result.error;
      return;
    }
    if (dragged) {
      place.latitude = centre.lat;
      place.longitude = centre.lng;
    }
    // Stamped by the database trigger; keep the local copy in step so the pin
    // position filter reflects the save without a reload.
    place.pin_position_updated_at = result.pin_position_updated_at || new Date().toISOString();
    if (marker && dragged) marker.setLatLng([centre.lat, centre.lng]);
    endReposition();
    applyPinFilter();
    statusText.textContent =
      (dragged ? "Moved " : "Confirmed (not moved) ") + (place.name || "pin");
  } catch (e) {
    statusText.textContent = "Error saving position";
  }
}

document.getElementById("btn-reposition").addEventListener("click", startReposition);
document.getElementById("btn-reposition-save").addEventListener("click", saveReposition);
document.getElementById("btn-reposition-cancel").addEventListener("click", cancelReposition);

// Wait for pywebview API
window.addEventListener("pywebviewready", init);
