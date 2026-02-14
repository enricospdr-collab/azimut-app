/* =========================================================
   AZIMUT MULTI-POINT + ALTIMETRIA + PDF/CSV
   Compatibile con index.html fornito (gain/loss/minAlt/maxAlt)
========================================================= */

// ----------------- MAPPA BASE -----------------
let map = L.map('map').setView([45.545, 11.535], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// ----------------- STATO APP -----------------
let markers = [];          // array di marker (max 20)
let addresses = [];        // nome/descrizione punto
let multiLines = [];       // segmenti base (rossi)
let angleMarkers = [];     // etichette azimut
let steepLines = [];       // segmenti ripidi (>30°) evidenziati

// per ridurre chiamate altimetriche
let elevationUpdateTimer = null;
let lastElevationSignature = "";

// ----------------- AUTOCOMPLETE NOMINATIM -----------------
let timeout = null;

document.getElementById("searchInput").addEventListener("input", function () {
  clearTimeout(timeout);
  let query = this.value;
  if (query.length < 3) {
    document.getElementById("searchResults").innerHTML = "";
    return;
  }
  timeout = setTimeout(() => searchLocation(query), 450);
});

async function searchLocation(query) {
  try {
    let url = "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=" +
      encodeURIComponent(query);
    let response = await fetch(url);
    let data = await response.json();

    let resultsDiv = document.getElementById("searchResults");
    resultsDiv.innerHTML = "";

    data.slice(0, 6).forEach(place => {
      let div = document.createElement("div");
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
    addPoint(pos.coords.latitude, pos.coords.longitude, "Posizione GPS");
    map.setView([pos.coords.latitude, pos.coords.longitude], 15);
  }, () => {
    alert("Impossibile ottenere la posizione GPS.");
  }, { enableHighAccuracy: true, timeout: 8000 });
};

// ----------------- CLICK MAPPA -----------------
map.on('click', function (e) {
  addPoint(e.latlng.lat, e.latlng.lng, "Punto selezionato manualmente");
});

// ----------------- AGGIUNGI PUNTO (MAX 20) -----------------
function addPoint(lat, lon, address) {
  if (markers.length >= 20) {
    alert("Limite massimo 20 punti raggiunto");
    return;
  }

  let draggable = !document.getElementById("lockPoints").checked;

  let marker = L.marker([lat, lon], { draggable }).addTo(map);

  marker.bindPopup(`${address}<br>Lat: ${lat.toFixed(6)}, Lon: ${lon.toFixed(6)}`).openPopup();

  if (draggable) {
    marker.on('drag', function () {
      // durante drag aggiorna solo popup, senza fare chiamate API
      let p = marker.getLatLng();
      marker.setPopupContent(`Punto spostato manualmente<br>Lat: ${p.lat.toFixed(6)}, Lon: ${p.lng.toFixed(6)}`);
      scheduleUpdateAll();
    });
    marker.on('dragend', function () {
      scheduleUpdateAll(true);
    });
  }

  markers.push(marker);
  addresses.push(address);

  scheduleUpdateAll(true);
}

// ----------------- UTILS AZIMUT / DISTANZA -----------------
function toRad(v) { return v * Math.PI / 180; }
function toDeg(v) { return v * 180 / Math.PI; }

function calculateAzimuth(lat1, lon1, lat2, lon2) {
  lat1 = toRad(lat1); lon1 = toRad(lon1);
  lat2 = toRad(lat2); lon2 = toRad(lon2);

  let dLon = lon2 - lon1;
  let y = Math.sin(dLon) * Math.cos(lat2);
  let x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  let brng = Math.atan2(y, x);
  brng = toDeg(brng);
  return (brng + 360) % 360;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  let dLat = toRad(lat2 - lat1);
  let dLon = toRad(lon2 - lon1);
  lat1 = toRad(lat1);
  lat2 = toRad(lat2);

  let a = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  let c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function totalDistanceMeters(pointsLatLng) {
  let d = 0;
  for (let i = 1; i < pointsLatLng.length; i++) {
    d += map.distance(pointsLatLng[i - 1], pointsLatLng[i]);
  }
  return d;
}

// ----------------- AGGIORNA GRAFICA + RISULTATI -----------------
function clearMapOverlays() {
  multiLines.forEach(l => map.removeLayer(l));
  angleMarkers.forEach(a => map.removeLayer(a));
  steepLines.forEach(s => map.removeLayer(s));
  multiLines = [];
  angleMarkers = [];
  steepLines = [];
}

function scheduleUpdateAll(forceElevation = false) {
  // aggiornamento immediato linee/azimut (sempre)
  updateLinesAndAzimuth();

  // aggiornamento altimetria con debounce
  if (forceElevation) {
    scheduleElevationUpdate();
  } else {
    scheduleElevationUpdate(700);
  }
}

function updateLinesAndAzimuth() {
  clearMapOverlays();

  let decl = parseFloat(document.getElementById("decl").value || "0");
  let resultsHTML = "";

  for (let i = 0; i < markers.length - 1; i++) {
    let a = markers[i].getLatLng();
    let b = markers[i + 1].getLatLng();

    let az = calculateAzimuth(a.lat, a.lng, b.lat, b.lng);
    let azMag = (az - decl + 360) % 360;
    let dist = map.distance(a, b);

    let line = L.polyline([a, b], { color: 'red' }).addTo(map);
    multiLines.push(line);

    let angleMarker = L.marker(a, {
      icon: L.divIcon({ className: 'address-label', html: az.toFixed(1) + '°' })
    }).addTo(map);
    angleMarkers.push(angleMarker);

    resultsHTML += `<b>Segmento ${i + 1}:</b> ${addresses[i]} → ${addresses[i + 1]}<br>`;
    resultsHTML += `Azimut geografico: ${az.toFixed(2)}° | Azimut magnetico: ${azMag.toFixed(2)}° | Distanza: ${dist.toFixed(2)} m<br><br>`;
  }

  document.getElementById("results").innerHTML = resultsHTML;

  // se meno di 2 punti, reset info altimetria
  if (markers.length < 2) {
    setElevationInfoEmpty();
  }
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

// ----------------- ESPORTAZIONI -----------------
window.resetAll = function resetAll() {
  // rimuovi marker
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

  let decl = parseFloat(document.getElementById("decl").value || "0");

  let csv = "Segmento,Punto1,Punto2,Lat1,Lon1,Lat2,Lon2,Azimut,Azimut_magnetico,Distanza_m\n";
  for (let i = 0; i < markers.length - 1; i++) {
    let a = markers[i].getLatLng();
    let b = markers[i + 1].getLatLng();

    let az = calculateAzimuth(a.lat, a.lng, b.lat, b.lng);
    let azMag = (az - decl + 360) % 360;
    let dist = map.distance(a, b);

    csv += `${i + 1},"${addresses[i].replace(/"/g, '""')}","${addresses[i + 1].replace(/"/g, '""')}",${a.lat},${a.lng},${b.lat},${b.lng},${az},${azMag},${dist}\n`;
  }

  let blob = new Blob([csv], { type: "text/csv" });
  let url = URL.createObjectURL(blob);
  let a = document.createElement("a");
  a.href = url;
  a.download = "azimut_multi_segment.csv";
  a.click();
};

window.exportMapPDF = async function exportMapPDF() {
  try {
    const { jsPDF } = window.jspdf;

    const mapDiv = document.getElementById('map');
    const canvas = await html2canvas(mapDiv, { useCORS: true });
    const imgData = canvas.toDataURL('image/png');

    // calcola spazio testo (max righe)
    const extraH = 220;

    const pdf = new jsPDF({
      orientation: 'landscape',
      unit: 'px',
      format: [canvas.width, canvas.height + extraH]
    });

    pdf.addImage(imgData, 'PNG', 0, 0, canvas.width, canvas.height);

    let y = canvas.height + 16;
    pdf.setFontSize(11);

    let decl = parseFloat(document.getElementById("decl").value || "0");
    for (let i = 0; i < markers.length - 1; i++) {
      let a = markers[i].getLatLng();
      let b = markers[i + 1].getLatLng();
      let az = calculateAzimuth(a.lat, a.lng, b.lat, b.lng);
      let azMag = (az - decl + 360) % 360;
      let dist = map.distance(a, b);

      const line = `Seg ${i + 1}: ${addresses[i]} → ${addresses[i + 1]} | Az: ${az.toFixed(2)}° | AzMag: ${azMag.toFixed(2)}° | Dist: ${dist.toFixed(0)} m`;
      pdf.text(10, y, line);
      y += 14;
      if (y > canvas.height + extraH - 10) break;
    }

    // aggiungi riepilogo altimetria (se presente)
    const gain = document.getElementById("gain").textContent;
    const loss = document.getElementById("loss").textContent;
    const minAlt = document.getElementById("minAlt").textContent;
    const maxAlt = document.getElementById("maxAlt").textContent;

    pdf.text(10, canvas.height + extraH - 24, `Dislivello +: ${gain} m  |  Dislivello -: ${loss} m  |  Quota min: ${minAlt} m  |  Quota max: ${maxAlt} m`);

    pdf.save('mappa_tracciato.pdf');
  } catch (e) {
    console.error(e);
    alert("Errore durante l'esportazione PDF.");
  }
};

// ----------------- ALTIMETRIA + DISLIVELLI + PENDENZE -----------------

function scheduleElevationUpdate(delay = 600) {
  if (elevationUpdateTimer) clearTimeout(elevationUpdateTimer);
  elevationUpdateTimer = setTimeout(() => updateElevationStats(), delay);
}

function getPointsLatLng() {
  return markers.map(m => m.getLatLng());
}

// campionamento: massimo ~60 punti per API
function samplePoints(points) {
  if (points.length <= 60) return points;
  const step = Math.ceil(points.length / 60);
  return points.filter((_, idx) => idx % step === 0);
}

async function fetchElevationsOpenElevation(pointsLatLng) {
  // Open-Elevation: POST locations [{latitude, longitude}, ...]
  const locations = pointsLatLng.map(p => ({ latitude: p.lat, longitude: p.lng }));

  const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations })
  });

  if (!res.ok) throw new Error("Open-Elevation non disponibile");
  const data = await res.json();
  if (!data || !data.results || data.results.length !== locations.length) {
    throw new Error("Risposta altimetria non valida");
  }
  return data.results.map(r => r.elevation);
}

function slopeDeg(deltaH, horizontalMeters) {
  // pendenza in gradi rispetto all'orizzontale
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

  // blocco se troppo corto
  if (distTot < 100) {
    setElevationInfoEmpty("Percorso troppo corto per altimetria");
    return;
  }

  // signature per evitare chiamate identiche
  const signature = allPoints.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");
  if (signature === lastElevationSignature) return;
  lastElevationSignature = signature;

  const sampled = samplePoints(allPoints);

  try {
    const elevations = await fetchElevationsOpenElevation(sampled);

    // min/max
    let minAlt = Math.min(...elevations);
    let maxAlt = Math.max(...elevations);

    // dislivelli
    let gain = 0;
    let loss = 0;

    // pendenza max + segmenti ripidi
    let maxSlope = 0;

    // pulisci vecchie linee ripide
    steepLines.forEach(s => map.removeLayer(s));
    steepLines = [];

    for (let i = 1; i < elevations.length; i++) {
      const dh = elevations[i] - elevations[i - 1];
      if (dh > 0) gain += dh;
      else loss += Math.abs(dh);

      const d = map.distance(sampled[i - 1], sampled[i]);
      const s = slopeDeg(dh, d);
      if (s > maxSlope) maxSlope = s;

      // evidenzia tratti >30°
      if (s > 30) {
        const seg = L.polyline([sampled[i - 1], sampled[i]], { color: 'red', weight: 6, opacity: 0.85 }).addTo(map);
        steepLines.push(seg);
      }
    }

    // aggiorna UI (senza cambiare struttura)
    const gainEl = document.getElementById("gain");
    const lossEl = document.getElementById("loss");
    const minEl = document.getElementById("minAlt");
    const maxEl = document.getElementById("maxAlt");
    const badgeEl = document.getElementById("badge-pendenza");

    gainEl.textContent = Math.round(gain).toString();
    lossEl.textContent = Math.round(loss).toString();
    minEl.textContent = Math.round(minAlt).toString();
    maxEl.textContent = Math.round(maxAlt).toString();

    // colorazione: senza cambiare layout
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

// ----------------- INIT: aggiorna quando cambiano declinazione / lock -----------------
document.getElementById("decl").addEventListener("input", () => scheduleUpdateAll(false));
document.getElementById("lockPoints").addEventListener("change", () => {
  // aggiorna draggable dei marker esistenti
  const locked = document.getElementById("lockPoints").checked;
  markers.forEach(m => {
    if (locked) m.dragging && m.dragging.disable();
    else m.dragging && m.dragging.enable();
  });
});

// ----------------- SERVICE WORKER (se presente) -----------------
if ('serviceWorker' in navigator) {
  // se esiste service-worker.js nel repo, si registra; altrimenti non fa nulla
  navigator.serviceWorker.register('service-worker.js').catch(() => {});
}

// prima render
scheduleUpdateAll(false);