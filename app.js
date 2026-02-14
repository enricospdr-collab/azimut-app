// ===============================
// INIZIALIZZAZIONE MAPPA
// ===============================

const map = L.map('map').setView([45.8, 11.5], 10);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let punti = [];
let polyline = L.polyline([], { color: 'blue', weight: 4 }).addTo(map);
let segmentiRipidi = [];
let chart;

// ===============================
// CLICK MAPPA
// ===============================

map.on('click', function(e) {
  punti.push(e.latlng);
  polyline.addLatLng(e.latlng);
  aggiornaStatistiche();
});

// ===============================
// RESET
// ===============================

function resetPercorso() {
  punti = [];
  polyline.setLatLngs([]);

  segmentiRipidi.forEach(seg => map.removeLayer(seg));
  segmentiRipidi = [];

  if (chart) chart.destroy();

  document.getElementById("distanza").textContent = 0;
  document.getElementById("dislivello-positivo").textContent = 0;
  document.getElementById("dislivello-negativo").textContent = 0;
  document.getElementById("quota-min").textContent = 0;
  document.getElementById("quota-max").textContent = 0;
}

// ===============================
// DISTANZA
// ===============================

function calcolaDistanza(points) {
  let distanza = 0;
  for (let i = 1; i < points.length; i++) {
    distanza += map.distance(points[i - 1], points[i]);
  }
  return distanza;
}

// ===============================
// API ALTIMETRIA
// ===============================

async function getElevations(points) {

  const locations = points.map(p => ({
    latitude: p.lat,
    longitude: p.lng
  }));

  const response = await fetch('https://api.open-elevation.com/api/v1/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations })
  });

  const data = await response.json();
  return data.results;
}

// ===============================
// CALCOLO PENDENZA
// ===============================

function calcolaPendenza(elev1, elev2, distanza) {
  const diff = elev2 - elev1;
  return Math.atan(diff / distanza) * (180 / Math.PI);
}

// ===============================
// AGGIORNA STATISTICHE
// ===============================

async function aggiornaStatistiche() {

  if (punti.length < 2) return;

  const distanzaTot = calcolaDistanza(punti);

  if (distanzaTot < 100) {
    return; // blocca calcolo sotto 100 metri
  }

  const puntiRidotti = punti.filter((_, i) => i % 2 === 0);

  const elevations = await getElevations(puntiRidotti);

  let dislivelloPos = 0;
  let dislivelloNeg = 0;
  let minQuota = elevations[0].elevation;
  let maxQuota = elevations[0].elevation;

  segmentiRipidi.forEach(seg => map.removeLayer(seg));
  segmentiRipidi = [];

  for (let i = 1; i < elevations.length; i++) {

    const elev1 = elevations[i - 1].elevation;
    const elev2 = elevations[i].elevation;

    const distanzaSegmento = map.distance(
      puntiRidotti[i - 1],
      puntiRidotti[i]
    );

    const diff = elev2 - elev1;

    if (diff > 0) dislivelloPos += diff;
    else dislivelloNeg += Math.abs(diff);

    const pendenza = calcolaPendenza(elev1, elev2, distanzaSegmento);

    if (pendenza > 30) {
      const seg = L.polyline(
        [puntiRidotti[i - 1], puntiRidotti[i]],
        { color: 'red', weight: 6 }
      ).addTo(map);
      segmentiRipidi.push(seg);
    }

    if (elev2 < minQuota) minQuota = elev2;
    if (elev2 > maxQuota) maxQuota = elev2;
  }

  document.getElementById("distanza").textContent = (distanzaTot / 1000).toFixed(2);
  document.getElementById("dislivello-positivo").textContent = Math.round(dislivelloPos);
  document.getElementById("dislivello-negativo").textContent = Math.round(dislivelloNeg);
  document.getElementById("quota-min").textContent = Math.round(minQuota);
  document.getElementById("quota-max").textContent = Math.round(maxQuota);

  creaGrafico(elevations);
}

// ===============================
// PROFILO ALTIMETRICO
// ===============================

function creaGrafico(elevations) {

  const ctx = document.getElementById('elevationChart').getContext('2d');

  const labels = elevations.map((_, i) => i);
  const dati = elevations.map(e => e.elevation);

  if (chart) chart.destroy();

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Profilo altimetrico',
        data: dati,
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      scales: {
        y: {
          title: {
            display: true,
            text: 'Altitudine (m)'
          }
        }
      }
    }
  });
}