/* =========================================================
   AZIMUT MULTI-POINT + PDF/CSV + ALTIMETRIA + MAPPE MONTAGNA
   - Base Topografica (OpenTopoMap)
   - Overlay Hillshade (ombre versanti) ATTIVO
   - Overlay Slope (pendenze) ATTIVO
   - Mappa limitata rigidamente a Veneto + Trentino-Alto Adige
========================================================= */

// ----------------- BOUNDS (Veneto + Trentino-AA) -----------------
const REGIONAL_BOUNDS = L.latLngBounds(
  L.latLng(44.6, 10.2),  // SW
  L.latLng(47.3, 13.1)   // NE
);

// viewbox per Nominatim: left,top,right,bottom
const NOMINATIM_VIEWBOX = "10.2,47.3,13.1,44.6";

// ----------------- LAYER MAPPE -----------------
const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors"
});

const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors, SRTM | © OpenTopoMap"
});

// Hillshade (ombre rilievo)
const hillshade = L.tileLayer("https://tiles.wmflabs.org/hillshading/{z}/{x}/{y}.png", {
  attribution: "Hillshade",
  opacity: 0.4
});

// Slope overlay (pendenze)
// Nota: alcuni overlay sono regionali; questo è un endpoint comunemente usato per Alps East.
// Se in futuro noti tile mancanti, lo sostituiamo con un overlay più adatto al tuo perimetro.
const slopeOverlay = L.tileLayer(
  "https://tileserver1.openslopemap.org/OSloOVERLAY_UHR_AlpsEast_16/{z}/{x}/{y}.png",
  {
    attribution: "Slope overlay",
    opacity: 0.65
  }
);

// ----------------- MAPPA (overlay già attivi) -----------------
let map = L.map("map", {
  maxBounds: REGIONAL_BOUNDS,
  maxBoundsViscosity: 1.0,
  layers: [topo, hillshade, slopeOverlay] // ✅ attivi all’avvio
});

map.fitBounds(REGIONAL_BOUNDS);
map.setMinZoom(7);
map.setMaxZoom(18);

// sicurezza extra (mobile)
map.on("drag", () => {
  map.panInsideBounds(REGIONAL_BOUNDS, { animate: false });
});

// selettore layer
L.control.layers(
  {
    "Topografica": topo,
    "OSM": osm
  },
  {
    "Ombreggiatura (Hillshade)": hillshade,
    "Pendenze (Slope)": slopeOverlay
  },
  { collapsed: true }
).addTo(map);

// ----------------- STATO APP -----------------
let markers = [];          // max 20
let addresses = [];
let multiLines = [];
let angleMarkers = [];
let steepLines = [];       // evidenziazione pendenza > 30° (segmenti campionati)

let elevationUpdateTimer = null;
let lastElevationSignature = "";

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
      div.onclick = () => selectLocation(place);
      resultsDiv.appendChild(div);
    });
  } catch (e) {
    console.error("Errore ricerca:", e);
  }
}

function selectLocation(place) {
  addPoint(parseFloat(place.lat), parseFloat(place.lon), place.display_name);
  map.setView([place.lat, place.lon], 15);
  document.getElementById("searchResults").innerHTML = "";
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

// ----------------- AGGIUNGI PUNTO (MAX 20) -----------------
function addPoint(lat, lon, address) {
  if (markers.length >= 20) {
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
    marker.on("drag", function () {
      const pt = marker.getLatLng();
      marker.setPopupContent(`Punto spostato manualmente<br>Lat: ${pt.lat.toFixed(6)}, Lon: ${pt.lng.toFixed(6)}`);
      scheduleUpdateAll(false);
    });
    marker.on("dragend", function () {
      const pt = marker.getLatLng();
      if (!REGIONAL_BOUNDS.contains(pt)) {
        // riporta dentro bounds
        marker.setLatLng(REGIONAL_BOUNDS.getCenter());
      }
      scheduleUpdateAll(true);
    });
  }

  markers.push(marker);
  addresses.push(address);

  scheduleUpdateAll(true);
}

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

function clearMapOverlays() {
  multiLines.forEach(l => map.removeLayer(l));
  angleMarkers.forEach(a => map.removeLayer(a));
  steepLines.forEach(s => map.removeLayer(s));
  multiLines = [];
  angleMarkers = [];
  steepLines = [];
}

function setElevationInfoEmpty(message = "") {
  document.getElementById("gain").textContent = "0";
  document.getElementById("loss").textContent = "0";
  document.getElementById("minAlt").textContent = "0";
  document.getElementById("maxAlt").textContent = "0";
  const badge = document.getElementById("badge-pendenza");
  badge.textContent = message || "";
  badge.style.color = message ? "red" : "";
}

// ----------------- AGGIORNA LINEE + RISULTATI -----------------
function scheduleUpdateAll(forceElevation = false) {
  updateLinesAndAzimuth();
  scheduleElevationUpdate(forceElevation ? 50 : 650);
}

function updateLinesAndAzimuth() {
  clearMapOverlays();

  const decl = parseFloat(document.getElementById("decl").value || "0");
  let resultsHTML = "";

  for (let i = 0; i < markers.length - 1; i++) {
    const a = markers[i].getLatLng();
    const b = markers[i + 1].getLatLng();

    const az = calculateAzimuth(a.lat, a.lng, b.lat, b.lng);
    const azMag = (az - decl + 360) % 360;
    const dist = map.distance(a, b);

    const line = L.polyline([a, b], { color: "red" }).addTo(map);
    multiLines.push(line);

    const angleMarker = L.marker(a, {
      icon: L.divIcon({ className: "address-label", html: az.toFixed(1) + "°" })
    }).addTo(map);
    angleMarkers.push(angleMarker);

    resultsHTML += `<b>Segmento ${i + 1}:</b> ${addresses[i]} → ${addresses[i + 1]}<br>`;
    resultsHTML += `Azimut geografico: ${az.toFixed(2)}° | Azimut magnetico: ${azMag.toFixed(2)}° | Distanza: ${dist.toFixed(2)} m<br><br>`;
  }

  document.getElementById("results").innerHTML = resultsHTML;

  if (markers.length < 2) setElevationInfoEmpty();
}

// ----------------- RESET / EXPORT -----------------
window.resetAll = function resetAll() {
  markers.forEach(m => map.removeLayer(m));
  markers = [];
  addresses = [];
  clearMapOverlays();
  document.getElementById("results").innerHTML = "";
  document.getElementById("searchResults").innerHTML = "";
  document.getElementById("searchInput").value = "";
  setElevationInfoEmpty();
};

window.exportCSV = function exportCSV() {
  if (markers.length < 2) return;

  const decl = parseFloat(document.getElementById("decl").value || "0");
  let csv = "Segmento,Punto1,Punto2,Lat1,Lon1,Lat2,Lon2,Azimut,Azimut_magnetico,Distanza_m\n";

  for (let i = 0; i < markers.length - 1; i++) {
    const a = markers[i].getLatLng();
    const b = markers[i + 1].getLatLng();
    const az = calculateAzimuth(a.lat, a.lng, b.lat, b.lng);
    const azMag = (az - decl + 360) % 360;
    const dist = map.distance(a, b);

    csv += `${i + 1},"${addresses[i].replace(/"/g, '""')}","${addresses[i + 1].replace(/"/g, '""')}",${a.lat},${a.lng},${b.lat},${b.lng},${az},${azMag},${dist}\n`;
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

    const extraH = 220;
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

      const line = `Seg ${i + 1}: ${addresses[i]} → ${addresses[i + 1]} | Az: ${az.toFixed(2)}° | AzMag: ${azMag.toFixed(2)}° | Dist: ${dist.toFixed(0)} m`;
      pdf.text(10, y, line);
      y += 14;
      if (y > canvas.height + extraH - 10) break;
    }

    const gain = document.getElementById("gain").textContent;
    const loss = document.getElementById("loss").textContent;
    const minAlt = document.getElementById("minAlt").textContent;
    const maxAlt = document.getElementById("maxAlt").textContent;

    pdf.text(10, canvas.height + extraH - 24, `Dislivello +: ${gain} m  |  Dislivello -: ${loss} m  |  Quota min: ${minAlt} m  |  Quota max: ${maxAlt} m`);
    pdf.save("mappa_tracciato.pdf");
  } catch (e) {
    console.error(e);
    alert("Errore durante l'esportazione PDF.");
  }
};

// ----------------- ALTIMETRIA / DISLIVELLI / PENDENZE -----------------
function scheduleElevationUpdate(delay = 600) {
  if (elevationUpdateTimer) clearTimeout(elevationUpdateTimer);
  elevationUpdateTimer = setTimeout(() => updateElevationStats(), delay);
}

function getPointsLatLng() {
  return markers.map(m => m.getLatLng());
}

// campionamento: max ~60 punti per API
function samplePoints(points) {
  if (points.length <= 60) return points;
  const step = Math.ceil(points.length / 60);
  return points.filter((_, idx) => idx % step === 0);
}

async function fetchElevationsOpenElevation(pointsLatLng) {
  const locations = pointsLatLng.map(p => ({ latitude: p.lat, longitude: p.lng }));
  const res = await fetch("https://api.open-elevation.com/api/v1/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locations })
  });
  if (!res.ok) throw new Error("Open-Elevation non disponibile");
  const data = await res.json();
  if (!data?.results || data.results.length !== locations.length) throw new Error("Risposta altimetria non valida");
  return data.results.map(r => r.elevation);
}

function slopeDeg(deltaH, horizontalMeters) {
  if (horizontalMeters <= 0) return 0;
  return Math.atan(deltaH / horizontalMeters) * (180 / Math.PI);
}

async function updateElevationStats() {
  if (markers.length < 2) {
    setElevationInfoEmpty();
    return;
  }

  const allPoints = getPointsLatLng();
  const distTot = totalDistanceMeters(allPoints);

  if (distTot < 100) {
    setElevationInfoEmpty("Percorso troppo corto per altimetria");
    return;
  }

  const signature = allPoints.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");
  if (signature === lastElevationSignature) return;
  lastElevationSignature = signature;

  const sampled = samplePoints(allPoints);

  try {
    const elevations = await fetchElevationsOpenElevation(sampled);

    let minAlt = Math.min(...elevations);
    let maxAlt = Math.max(...elevations);
    let gain = 0;
    let loss = 0;
    let maxSlope = 0;

    // pulisci evidenziazione ripida
    steepLines.forEach(s => map.removeLayer(s));
    steepLines = [];

    for (let i = 1; i < elevations.length; i++) {
      const dh = elevations[i] - elevations[i - 1];
      if (dh > 0) gain += dh; else loss += Math.abs(dh);

      const d = map.distance(sampled[i - 1], sampled[i]);
      const s = slopeDeg(dh, d);
      if (s > maxSlope) maxSlope = s;

      if (s > 30) {
        const seg = L.polyline([sampled[i - 1], sampled[i]], { color: "red", weight: 6, opacity: 0.85 }).addTo(map);
        steepLines.push(seg);
      }
    }

    const gainEl = document.getElementById("gain");
    const lossEl = document.getElementById("loss");
    const minEl = document.getElementById("minAlt");
    const maxEl = document.getElementById("maxAlt");
    const badgeEl = document.getElementById("badge-pendenza");

    gainEl.textContent = String(Math.round(gain));
    lossEl.textContent = String(Math.round(loss));
    minEl.textContent = String(Math.round(minAlt));
    maxEl.textContent = String(Math.round(maxAlt));

    // colori inline senza cambiare UI
    gainEl.style.color = "green";
    lossEl.style.color = "red";

    badgeEl.textContent = "";
    badgeEl.style.color = "";

    if (maxSlope > 30) {
      badgeEl.textContent = "⚠️ Pendenza critica (>30°)";
      badgeEl.style.color = "red";
    }

  } catch (e) {
    console.error("Altimetria errore:", e);
    setElevationInfoEmpty("Altimetria non disponibile");
  }
}

// ----------------- EVENTI UI -----------------
document.getElementById("decl").addEventListener("input", () => scheduleUpdateAll(false));
document.getElementById("lockPoints").addEventListener("change", () => {
  const locked = document.getElementById("lockPoints").checked;
  markers.forEach(m => {
    if (!m.dragging) return;
    if (locked) m.dragging.disable();
    else m.dragging.enable();
  });
});

// ----------------- SERVICE WORKER -----------------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("service-worker.js").catch(() => {});
}

// prima render
scheduleUpdateAll(false);