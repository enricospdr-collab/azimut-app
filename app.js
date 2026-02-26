/* =========================================================
   CAI Scialpinismo Vicenza 2026 - Azimut Multi-Point Tool
   SALTO DI QUALITÀ:
   - Pendenza "reale" lungo il tracciato: densificazione (step metri) + quote DEM
   - Colorazione del tracciato per classi di pendenza (0-30 / 30-35 / 35-40 / >40)
   - Profilo altimetrico interattivo (Chart.js) con highlight del punto su mappa
   - Base Topografica + Hillshade + Slope overlay già attivi
   - Mappa limitata rigidamente a Veneto + Trentino-AA
========================================================= */

// ----------------- BOUNDS (Veneto + Trentino-AA) -----------------
const REGIONAL_BOUNDS = L.latLngBounds(
  L.latLng(44.6, 10.2),  // SW
  L.latLng(47.3, 13.1)   // NE
);
const NOMINATIM_VIEWBOX = "10.2,47.3,13.1,44.6";

// ----------------- LAYER MAPPE -----------------
const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors"
});
const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors, SRTM | © OpenTopoMap"
});
const hillshade = L.tileLayer("https://tiles.wmflabs.org/hillshading/{z}/{x}/{y}.png", {
  attribution: "Hillshade",
  opacity: 0.4
});
const slopeOverlay = L.tileLayer(
  "https://tileserver1.openslopemap.org/OSloOVERLAY_UHR_AlpsEast_16/{z}/{x}/{y}.png",
  { attribution: "Slope overlay", opacity: 0.65 }
);

// ----------------- MAPPA -----------------
let map = L.map("map", {
  maxBounds: REGIONAL_BOUNDS,
  maxBoundsViscosity: 1.0,
  layers: [topo, hillshade, slopeOverlay] // già attivi
});
map.fitBounds(REGIONAL_BOUNDS);
map.setMinZoom(7);
map.setMaxZoom(18);
map.on("drag", () => map.panInsideBounds(REGIONAL_BOUNDS, { animate: false }));

L.control.layers(
  { "Topografica": topo, "OSM": osm },
  { "Ombreggiatura (Hillshade)": hillshade, "Pendenze (Slope)": slopeOverlay },
  { collapsed: true }
).addTo(map);

// ----------------- STATO -----------------
let markers = [];              // max 20
let addresses = [];

let baseLines = [];            // linee base (rosse, segmento tra marker)
let angleMarkers = [];         // etichette azimut
let slopeClassLines = [];      // linee colorate per classi di pendenza lungo la traccia densificata

let elevationUpdateTimer = null;
let lastSignature = "";

// quote associate ai marker (per pendenza "segmento" accanto a distanza)
let pointElevations = [];

// dati densificati (per profilo + slope reale)
let densifiedPoints = [];      // LatLng[]
let densifiedElev = [];        // number[] (metri)
let densifiedDist = [];        // dist cumulata (metri)
let densifiedSlopeDeg = [];    // pendenza locale per step (gradi, assoluta)

// marker di highlight sul profilo
let profileCursorMarker = null;

// chart
let elevationChart = null;

// caching quote per stabilità (client-side)
const ELEV_CACHE_KEY = "elev_cache_v1";
let elevCache = loadElevationCache();

// ----------------- CONFIG -----------------
const MAX_POINTS = 20;
const MIN_TOTAL_DISTANCE_M = 150;     // blocco calcoli avanzati sotto questa soglia (più sensato di 100)
const DENSIFY_STEP_M = 50;            // salto qualità: punto ogni 50 m (regolabile)
const MAX_DENSIFIED_REQUEST = 300;    // non chiedere più di 300 punti per volta (rate limit)
const MAX_CHART_POINTS = 450;         // downsample profilo per fluidità mobile

// classi slope (gradi)
const SLOPE_THRESHOLDS = [30, 35, 40];

// ----------------- UTILS -----------------
function toRad(v) { return v * Math.PI / 180; }
function toDeg(v) { return v * 180 / Math.PI; }

function calculateAzimuth(lat1, lon1, lat2, lon2) {
  lat1 = toRad(lat1); lon1 = toRad(lon1);
  lat2 = toRad(lat2); lon2 = toRad(lon2);
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  let brng = Math.atan2(y, x);
  brng = toDeg(brng);
  return (brng + 360) % 360;
}

function totalDistanceMeters(pointsLatLng) {
  let d = 0;
  for (let i = 1; i < pointsLatLng.length; i++) d += map.distance(pointsLatLng[i - 1], pointsLatLng[i]);
  return d;
}

function clampToBounds(latlng) {
  if (REGIONAL_BOUNDS.contains(latlng)) return latlng;
  return REGIONAL_BOUNDS.getCenter();
}

function setElevationInfoEmpty(message = "") {
  document.getElementById("gain").textContent = "0";
  document.getElementById("loss").textContent = "0";
  document.getElementById("minAlt").textContent = "0";
  document.getElementById("maxAlt").textContent = "0";
  const badge = document.getElementById("badge-pendenza");
  badge.textContent = message || "";
  badge.style.color = message ? "red" : "";
  pointElevations = [];
  densifiedPoints = [];
  densifiedElev = [];
  densifiedDist = [];
  densifiedSlopeDeg = [];
  clearSlopeClassLines();
  clearProfileCursor();
  updateProfileChart([]); // svuota
}

function clearBaseOverlays() {
  baseLines.forEach(l => map.removeLayer(l));
  angleMarkers.forEach(a => map.removeLayer(a));
  baseLines = [];
  angleMarkers = [];
}

function clearSlopeClassLines() {
  slopeClassLines.forEach(l => map.removeLayer(l));
  slopeClassLines = [];
}

function clearProfileCursor() {
  if (profileCursorMarker) {
    map.removeLayer(profileCursorMarker);
    profileCursorMarker = null;
  }
}

// ----------------- LOCAL CACHE (quote) -----------------
function loadElevationCache() {
  try {
    const raw = localStorage.getItem(ELEV_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveElevationCache() {
  try {
    localStorage.setItem(ELEV_CACHE_KEY, JSON.stringify(elevCache));
  } catch { /* ignore */ }
}
function elevCacheKey(latlng) {
  // arrotondo per aumentare hit-rate senza perdere troppo
  return `${latlng.lat.toFixed(5)},${latlng.lng.toFixed(5)}`;
}

// ----------------- CHART PROFILO -----------------
function updateProfileChart(profile) {
  // profile: [{d, z, latlng}]
  const ctx = document.getElementById("elevationChart").getContext("2d");

  if (!profile || profile.length === 0) {
    if (elevationChart) {
      elevationChart.destroy();
      elevationChart = null;
    }
    return;
  }

  // downsample per fluidità mobile
  let sampled = profile;
  if (profile.length > MAX_CHART_POINTS) {
    const step = Math.ceil(profile.length / MAX_CHART_POINTS);
    sampled = profile.filter((_, i) => i % step === 0);
  }

  const labels = sampled.map(p => (p.d / 1000).toFixed(2)); // km
  const data = sampled.map(p => Math.round(p.z));

  if (elevationChart) elevationChart.destroy();

  elevationChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Quota (m)",
        data,
        tension: 0.25,
        pointRadius: 0,
        borderWidth: 2,
        fill: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: true }
      },
      scales: {
        x: { title: { display: true, text: "Distanza (km)" } },
        y: { title: { display: true, text: "Quota (m)" } }
      },
      onHover: (event, elements) => {
        // highlight su desktop
        if (!elements || elements.length === 0) return;
        const idx = elements[0].index;
        const p = sampled[idx];
        setProfileCursor(p.latlng);
      },
      onClick: (event, elements) => {
        // su mobile click/tap
        if (!elements || elements.length === 0) return;
        const idx = elements[0].index;
        const p = sampled[idx];
        setProfileCursor(p.latlng, true);
      }
    }
  });
}

function setProfileCursor(latlng, pan = false) {
  if (!latlng) return;
  if (!profileCursorMarker) {
    profileCursorMarker = L.circleMarker(latlng, {
      radius: 7,
      weight: 2,
      fillOpacity: 0.15
    }).addTo(map);
  } else {
    profileCursorMarker.setLatLng(latlng);
  }
  if (pan) map.panTo(latlng, { animate: true });
}

// ----------------- COLORI CLASSI PENDENZA -----------------
function slopeClassColor(slopeDegAbs) {
  // Nessun vincolo sui colori da parte tua: uso palette chiara e didattica
  if (slopeDegAbs < SLOPE_THRESHOLDS[0]) return "#2e7d32";   // verde
  if (slopeDegAbs < SLOPE_THRESHOLDS[1]) return "#f9a825";   // giallo/arancio
  if (slopeDegAbs < SLOPE_THRESHOLDS[2]) return "#ef6c00";   // arancio forte
  return "#c62828";                                          // rosso
}

function drawSlopeClassPolyline(points, slopesAbs) {
  // points: densifiedPoints, slopesAbs: per-step (points.length-1)
  clearSlopeClassLines();

  for (let i = 1; i < points.length; i++) {
    const s = slopesAbs[i - 1];
    const color = slopeClassColor(s);
    const seg = L.polyline([points[i - 1], points[i]], {
      color,
      weight: 5,
      opacity: 0.9
    }).addTo(map);
    slopeClassLines.push(seg);
  }
}

// ----------------- DENSIFICAZIONE TRACCIATO -----------------
function densifyPath(markerLatLngs, stepMeters) {
  // ritorna array di LatLng (include inizio e fine)
  const out = [];
  if (markerLatLngs.length < 2) return out;

  out.push(markerLatLngs[0]);

  for (let i = 1; i < markerLatLngs.length; i++) {
    const a = markerLatLngs[i - 1];
    const b = markerLatLngs[i];
    const dist = map.distance(a, b);

    if (dist <= stepMeters) {
      out.push(b);
      continue;
    }

    const n = Math.floor(dist / stepMeters);
    for (let k = 1; k <= n; k++) {
      const t = (k * stepMeters) / dist;
      if (t >= 1) break;
      const lat = a.lat + (b.lat - a.lat) * t;
      const lng = a.lng + (b.lng - a.lng) * t;
      out.push(L.latLng(lat, lng));
    }
    out.push(b);
  }
  return out;
}

// ----------------- ELEVATION FETCH (Open-Elevation) -----------------
async function fetchElevationsOpenElevation(pointsLatLng) {
  // usa cache locale per ridurre chiamate
  const elevations = new Array(pointsLatLng.length).fill(null);
  const toRequest = [];
  const toRequestIdx = [];

  for (let i = 0; i < pointsLatLng.length; i++) {
    const key = elevCacheKey(pointsLatLng[i]);
    if (elevCache[key] != null) elevations[i] = elevCache[key];
    else {
      toRequest.push(pointsLatLng[i]);
      toRequestIdx.push(i);
    }
  }

  // se tutto in cache, ritorna
  if (toRequest.length === 0) return elevations;

  // chunk (per evitare payload enormi)
  const chunkSize = 100;
  for (let start = 0; start < toRequest.length; start += chunkSize) {
    const chunk = toRequest.slice(start, start + chunkSize);
    const chunkIdx = toRequestIdx.slice(start, start + chunkSize);

    const locations = chunk.map(p => ({ latitude: p.lat, longitude: p.lng }));
    const res = await fetch("https://api.open-elevation.com/api/v1/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locations })
    });

    if (!res.ok) throw new Error("Open-Elevation non disponibile");
    const data = await res.json();
    if (!data?.results || data.results.length !== locations.length) throw new Error("Risposta altimetria non valida");

    for (let j = 0; j < data.results.length; j++) {
      const z = data.results[j].elevation;
      const idx = chunkIdx[j];
      elevations[idx] = z;
      elevCache[elevCacheKey(pointsLatLng[idx])] = z;
    }
  }

  saveElevationCache();
  return elevations;
}

// ----------------- AUTOCOMPLETE NOMINATIM -----------------
let timeout = null;
document.getElementById("searchInput").addEventListener("input", function () {
  clearTimeout(timeout);
  const query = this.value;
  if (query.length < 3) {
    document.getElementById("searchResults").innerHTML = "";
    return;
  }
  timeout = setTimeout(() => searchLocation(query), 450);
});

async function searchLocation(query) {
  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1" +
      "&bounded=1" +
      "&viewbox=" + NOMINATIM_VIEWBOX +
      "&q=" + encodeURIComponent(query);

    const response = await fetch(url);
    const data = await response.json();

    const resultsDiv = document.getElementById("searchResults");
    resultsDiv.innerHTML = "";

    data.slice(0, 6).forEach(place => {
      const div = document.createElement("div");
      div.className = "result-item";
      div.innerText = place.display_name;
      div.onclick = () => {
        addPoint(parseFloat(place.lat), parseFloat(place.lon), place.display_name);
        map.setView([place.lat, place.lon], 15);
        resultsDiv.innerHTML = "";
      };
      resultsDiv.appendChild(div);
    });
  } catch (e) {
    console.error("Errore ricerca:", e);
  }
}

// ----------------- GEOLOCALIZZAZIONE -----------------
window.goToMyLocation = function goToMyLocation() {
  if (!navigator.geolocation) {
    alert("Geolocalizzazione non supportata");
    return;
  }
  navigator.geolocation.getCurrentPosition(pos => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const p = L.latLng(lat, lon);

    if (!REGIONAL_BOUNDS.contains(p)) {
      alert("Posizione fuori dall'area consentita (Veneto + Trentino-AA).");
      return;
    }
    addPoint(lat, lon, "Posizione GPS");
    map.setView([lat, lon], 15);
  }, () => {
    alert("Impossibile ottenere la posizione GPS.");
  }, { enableHighAccuracy: true, timeout: 8000 });
};

// ----------------- CLICK MAPPA -----------------
map.on("click", function (e) {
  if (!REGIONAL_BOUNDS.contains(e.latlng)) return;
  addPoint(e.latlng.lat, e.latlng.lng, "Punto selezionato manualmente");
});

// ----------------- AGGIUNGI PUNTO -----------------
function addPoint(lat, lon, address) {
  if (markers.length >= MAX_POINTS) {
    alert("Limite massimo 20 punti raggiunto");
    return;
  }

  const p = L.latLng(lat, lon);
  if (!REGIONAL_BOUNDS.contains(p)) {
    alert("Punto fuori dall'area consentita (Veneto + Trentino-AA).");
    return;
  }

  const draggable = !document.getElementById("lockPoints").checked;
  const marker = L.marker([lat, lon], { draggable }).addTo(map);

  marker.bindPopup(`${address}<br>Lat: ${lat.toFixed(6)}, Lon: ${lon.toFixed(6)}`).openPopup();

  if (draggable) {
    marker.on("drag", () => scheduleUpdateAll(false));
    marker.on("dragend", () => {
      const pt = clampToBounds(marker.getLatLng());
      marker.setLatLng(pt);
      scheduleUpdateAll(true);
    });
  }

  markers.push(marker);
  addresses.push(address);

  scheduleUpdateAll(true);
}

// ----------------- UI EVENTS -----------------
document.getElementById("decl").addEventListener("input", () => scheduleUpdateAll(false));
document.getElementById("lockPoints").addEventListener("change", () => {
  const locked = document.getElementById("lockPoints").checked;
  markers.forEach(m => {
    if (!m.dragging) return;
    if (locked) m.dragging.disable();
    else m.dragging.enable();
  });
});

// ----------------- AGGIORNA (linee+altimetria) -----------------
function scheduleUpdateAll(forceElevation) {
  updateBaseSegmentsAndResults();
  scheduleElevationUpdate(forceElevation ? 50 : 650);
}

function scheduleElevationUpdate(delay) {
  if (elevationUpdateTimer) clearTimeout(elevationUpdateTimer);
  elevationUpdateTimer = setTimeout(updateElevationAndSlopeQuality, delay);
}

function getMarkerPoints() {
  return markers.map(m => m.getLatLng());
}

function updateBaseSegmentsAndResults() {
  clearBaseOverlays();

  const decl = parseFloat(document.getElementById("decl").value || "0");
  let html = "";

  for (let i = 0; i < markers.length - 1; i++) {
    const a = markers[i].getLatLng();
    const b = markers[i + 1].getLatLng();

    const az = calculateAzimuth(a.lat, a.lng, b.lat, b.lng);
    const azMag = (az - decl + 360) % 360;
    const dist = map.distance(a, b);

    // linea base rossa
    baseLines.push(L.polyline([a, b], { color: "red" }).addTo(map));

    // etichetta azimut sul punto
    angleMarkers.push(L.marker(a, {
      icon: L.divIcon({ className: "address-label", html: az.toFixed(1) + "°" })
    }).addTo(map));

    // pendenza “segmento” (solo se quote marker disponibili)
    let slopeStr = "—";
    let slopeBadge = "";

    if (pointElevations[i] != null && pointElevations[i + 1] != null && dist > 0) {
      const dh = pointElevations[i + 1] - pointElevations[i];
      const s = Math.abs(Math.atan(dh / dist) * (180 / Math.PI));
      slopeStr = `${s.toFixed(1)}°`;
      if (s >= 30) slopeBadge = ` <span style="color:red;">⚠️ ≥30°</span>`;
    }

    html += `<b>Segmento ${i + 1}:</b> ${addresses[i]} → ${addresses[i + 1]}<br>`;
    html += `Azimut geografico: ${az.toFixed(2)}° | Azimut magnetico: ${azMag.toFixed(2)}° | Distanza: ${dist.toFixed(2)} m | Pendenza: ${slopeStr}${slopeBadge}<br><br>`;
  }

  document.getElementById("results").innerHTML = html;

  if (markers.length < 2) {
    setElevationInfoEmpty();
  }
}

// ----------------- SALTO QUALITÀ: pendenza reale lungo traccia + profilo -----------------
async function updateElevationAndSlopeQuality() {
  if (markers.length < 2) {
    setElevationInfoEmpty();
    return;
  }

  const markerPts = getMarkerPoints();
  const distTot = totalDistanceMeters(markerPts);

  if (distTot < MIN_TOTAL_DISTANCE_M) {
    setElevationInfoEmpty("Percorso troppo corto per analisi avanzata");
    return;
  }

  // firma per evitare rifare tutto inutilmente
  const signature = markerPts.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");
  if (signature === lastSignature) return;
  lastSignature = signature;

  // densifica
  let dens = densifyPath(markerPts, DENSIFY_STEP_M);

  // limita richieste (se troppo lungo, aumenta step automaticamente)
  if (dens.length > MAX_DENSIFIED_REQUEST) {
    const factor = Math.ceil(dens.length / MAX_DENSIFIED_REQUEST);
    dens = densifyPath(markerPts, DENSIFY_STEP_M * factor);
  }

  try {
    const z = await fetchElevationsOpenElevation(dens);

    // costruisci dist cumulata
    const cumDist = [0];
    for (let i = 1; i < dens.length; i++) {
      cumDist[i] = cumDist[i - 1] + map.distance(dens[i - 1], dens[i]);
    }

    // slope locale per step
    const slopesAbs = [];
    let gain = 0, loss = 0;
    let maxSlope = 0;

    for (let i = 1; i < dens.length; i++) {
      const dh = z[i] - z[i - 1];
      const d = map.distance(dens[i - 1], dens[i]);
      const s = Math.abs(Math.atan(dh / d) * (180 / Math.PI));
      slopesAbs.push(s);
      if (s > maxSlope) maxSlope = s;

      if (dh > 0) gain += dh;
      else loss += Math.abs(dh);
    }

    // percentuale sopra soglia
    const over30 = slopesAbs.filter(v => v >= 30).length;
    const pctOver30 = slopesAbs.length ? (over30 / slopesAbs.length) * 100 : 0;

    // aggiorna UI altimetrica
    const minAlt = Math.min(...z);
    const maxAlt = Math.max(...z);

    document.getElementById("gain").textContent = String(Math.round(gain));
    document.getElementById("loss").textContent = String(Math.round(loss));
    document.getElementById("minAlt").textContent = String(Math.round(minAlt));
    document.getElementById("maxAlt").textContent = String(Math.round(maxAlt));

    document.getElementById("gain").style.color = "green";
    document.getElementById("loss").style.color = "red";

    const badge = document.getElementById("badge-pendenza");
    badge.style.color = (maxSlope >= 30) ? "red" : "";
    badge.textContent = (maxSlope >= 30)
      ? `⚠️ max ${maxSlope.toFixed(1)}° | >30°: ${pctOver30.toFixed(0)}%`
      : `max ${maxSlope.toFixed(1)}° | >30°: ${pctOver30.toFixed(0)}%`;

    // salva dati densificati globali
    densifiedPoints = dens;
    densifiedElev = z;
    densifiedDist = cumDist;
    densifiedSlopeDeg = slopesAbs;

    // colorazione del tracciato per classi pendenza (salto qualità)
    drawSlopeClassPolyline(densifiedPoints, densifiedSlopeDeg);

    // associa quote ai marker (per pendenza in riga segmento)
    pointElevations = new Array(markers.length).fill(null);
    for (let i = 0; i < markers.length; i++) {
      const p = markers[i].getLatLng();
      let bestIdx = 0, bestDist = Infinity;
      for (let j = 0; j < densifiedPoints.length; j++) {
        const dd = map.distance(p, densifiedPoints[j]);
        if (dd < bestDist) { bestDist = dd; bestIdx = j; }
      }
      pointElevations[i] = densifiedElev[bestIdx];
    }

    // aggiorna righe (ora con pendenza segmento affidabile)
    updateBaseSegmentsAndResults();

    // profilo altimetrico interattivo
    const profile = densifiedPoints.map((latlng, i) => ({
      d: densifiedDist[i],
      z: densifiedElev[i],
      latlng
    }));
    updateProfileChart(profile);

  } catch (e) {
    console.error(e);
    setElevationInfoEmpty("Altimetria non disponibile");
    updateBaseSegmentsAndResults();
  }
}

// ----------------- RESET / EXPORT -----------------
window.resetAll = function resetAll() {
  markers.forEach(m => map.removeLayer(m));
  markers = [];
  addresses = [];
  clearBaseOverlays();
  clearSlopeClassLines();
  clearProfileCursor();
  document.getElementById("results").innerHTML = "";
  document.getElementById("searchResults").innerHTML = "";
  document.getElementById("searchInput").value = "";
  lastSignature = "";
  setElevationInfoEmpty();
};

window.exportCSV = function exportCSV() {
  if (markers.length < 2) return;

  const decl = parseFloat(document.getElementById("decl").value || "0");
  let csv = "Segmento,Punto1,Punto2,Lat1,Lon1,Lat2,Lon2,Azimut,Azimut_magnetico,Distanza_m,Pendenza_segmento_gradi\n";

  for (let i = 0; i < markers.length - 1; i++) {
    const a = markers[i].getLatLng();
    const b = markers[i + 1].getLatLng();
    const az = calculateAzimuth(a.lat, a.lng, b.lat, b.lng);
    const azMag = (az - decl + 360) % 360;
    const dist = map.distance(a, b);

    let slopeVal = "";
    if (pointElevations[i] != null && pointElevations[i + 1] != null && dist > 0) {
      const dh = pointElevations[i + 1] - pointElevations[i];
      slopeVal = Math.abs(Math.atan(dh / dist) * (180 / Math.PI)).toFixed(1);
    }

    csv += `${i + 1},"${addresses[i].replace(/"/g,'""')}","${addresses[i+1].replace(/"/g,'""')}",${a.lat},${a.lng},${b.lat},${b.lng},${az},${azMag},${dist},${slopeVal}\n`;
  }

  // extra: riepilogo qualità (max slope e %>30)
  if (densifiedSlopeDeg.length) {
    const maxS = Math.max(...densifiedSlopeDeg);
    const pct = (densifiedSlopeDeg.filter(v => v >= 30).length / densifiedSlopeDeg.length) * 100;
    csv += `\nRiepilogo,Max_slope_gradi,${maxS.toFixed(1)}\n`;
    csv += `Riepilogo,Percento_sopra_30,${pct.toFixed(0)}\n`;
  }

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "azimut_multi_segment.csv";
  a.click();
};

window.exportMapPDF = async function exportMapPDF() {
  try {
    const { jsPDF } = window.jspdf;
    const mapDiv = document.getElementById("map");
    const canvas = await html2canvas(mapDiv, { useCORS: true });
    const imgData = canvas.toDataURL("image/png");

    const extraH = 250;
    const pdf = new jsPDF({
      orientation: "landscape",
      unit: "px",
      format: [canvas.width, canvas.height + extraH]
    });

    pdf.addImage(imgData, "PNG", 0, 0, canvas.width, canvas.height);

    let y = canvas.height + 16;
    pdf.setFontSize(11);

    const decl = parseFloat(document.getElementById("decl").value || "0");
    for (let i = 0; i < markers.length - 1; i++) {
      const a = markers[i].getLatLng();
      const b = markers[i + 1].getLatLng();
      const az = calculateAzimuth(a.lat, a.lng, b.lat, b.lng);
      const azMag = (az - decl + 360) % 360;
      const dist = map.distance(a, b);

      let slopeTxt = "—";
      if (pointElevations[i] != null && pointElevations[i + 1] != null && dist > 0) {
        const dh = pointElevations[i + 1] - pointElevations[i];
        slopeTxt = Math.abs(Math.atan(dh / dist) * (180 / Math.PI)).toFixed(1) + "°";
      }

      const line = `Seg ${i + 1}: Az ${az.toFixed(1)}° | Dist ${dist.toFixed(0)} m | Pend ${slopeTxt} | ${addresses[i]} → ${addresses[i + 1]}`;
      pdf.text(10, y, line);
      y += 14;
      if (y > canvas.height + extraH - 50) break;
    }

    const gain = document.getElementById("gain").textContent;
    const loss = document.getElementById("loss").textContent;
    const minAlt = document.getElementById("minAlt").textContent;
    const maxAlt = document.getElementById("maxAlt").textContent;

    let extra = `Dislivello +: ${gain} m  |  Dislivello -: ${loss} m  |  Quota min: ${minAlt} m  |  Quota max: ${maxAlt} m`;
    if (densifiedSlopeDeg.length) {
      const maxS = Math.max(...densifiedSlopeDeg);
      const pct = (densifiedSlopeDeg.filter(v => v >= 30).length / densifiedSlopeDeg.length) * 100;
      extra += `  |  max slope: ${maxS.toFixed(1)}°  |  >30°: ${pct.toFixed(0)}%`;
    }
    pdf.text(10, canvas.height + extraH - 24, extra);

    pdf.save("mappa_tracciato.pdf");
  } catch (e) {
    console.error(e);
    alert("Errore durante l'esportazione PDF.");
  }
};

// ----------------- SERVICE WORKER -----------------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("service-worker.js").catch(() => {});
}

// prima render
setElevationInfoEmpty();