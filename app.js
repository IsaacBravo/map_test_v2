/* global Cesium */

// Minimal Cesium globe with robust country polygon filtering + country-name lookup
const viewer = new Cesium.Viewer("cesiumContainer", {
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  imageryProvider: new Cesium.OpenStreetMapImageryProvider({
    url: "https://a.tile.openstreetmap.org/",
  }),
  baseLayerPicker: false,
  geocoder: false,
  animation: false,
  timeline: false,
  navigationHelpButton: false,
  sceneModePicker: false,
  fullscreenButton: false,
  homeButton: true,
  infoBox: false,
  selectionIndicator: false,
  shouldAnimate: false,
});

viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(0, 20, 26_000_000),
});

// -------------------------
// Country lookup index
// -------------------------
const countryIndex = new Map(); // normalized -> { lon, lat, iso2, iso3, displayName }

function normalizeCountryName(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Ring area (shoelace) in degrees^2 (used to choose largest outer ring if needed)
function ringAreaDeg2(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

// Centroid of a closed ring (lon/lat degrees). Falls back to mean if degenerate.
function ringCentroidDeg(ring) {
  let a = 0, cx = 0, cy = 0;

  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }

  a *= 0.5;
  if (Math.abs(a) < 1e-12) {
    let sx = 0, sy = 0;
    for (const [x, y] of ring) { sx += x; sy += y; }
    const n = ring.length || 1;
    return { lon: sx / n, lat: sy / n };
  }

  cx /= (6 * a);
  cy /= (6 * a);
  return { lon: cx, lat: cy };
}

function normalizeRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return null;

  const cleaned = [];
  for (const p of ring) {
    if (!p || p.length < 2) continue;
    const lon = p[0], lat = p[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    cleaned.push([lon, lat]);
  }
  if (cleaned.length < 4) return null;

  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) cleaned.push([first[0], first[1]]);
  return cleaned;
}

function ringToDegreesArray(ring) {
  const flat = [];
  for (const [lon, lat] of ring) flat.push(lon, lat);
  return flat;
}

// -------------------------
// Manual markers
// -------------------------
const manualMarkers = new Cesium.CustomDataSource("Manual Markers");
viewer.dataSources.add(manualMarkers);

function openPopup({ title, description }) {
  // Minimal fallback popup (if you have HTML popup, replace this)
  alert(`${title}\n\n${description}`);
}

function addPopupAtLonLat({ lon, lat, title, description }) {
  manualMarkers.entities.removeAll();

  manualMarkers.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    point: {
      pixelSize: 10,
      color: Cesium.Color.RED.withAlpha(0.95),
      outlineColor: Cesium.Color.BLACK.withAlpha(0.9),
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: title || "",
      font: "14px sans-serif",
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      outlineWidth: 3,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -12),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      showBackground: true,
      backgroundPadding: new Cesium.Cartesian2(6, 4),
    },
  });

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 2_500_000),
    duration: 0.9,
  });

  openPopup({ title, description });
}

function addPopupByCountryName(inputName) {
  const key = normalizeCountryName(inputName);
  const hit = countryIndex.get(key);

  if (!hit) {
    const suggestions = suggestCountryNames(inputName, 10);
    alert(
      `Country not found: "${inputName}".\n\nTry one of these:\n- ${suggestions.join("\n- ")}`
    );
    return;
  }

  const desc = [
    hit.iso2 ? `ISO-2: ${hit.iso2}` : null,
    hit.iso3 ? `ISO-3: ${hit.iso3}` : null,
  ].filter(Boolean).join(" • ");

  addPopupAtLonLat({
    lon: hit.lon,
    lat: hit.lat,
    title: hit.displayName || inputName,
    description: desc || "",
  });
}

// Small helper to show possible names
function suggestCountryNames(inputName, max = 10) {
  const q = normalizeCountryName(inputName);
  const all = Array.from(countryIndex.entries()).map(([k, v]) => ({ k, name: v.displayName }));

  // Simple contains match first, then prefix match
  const contains = all.filter(o => o.k.includes(q));
  const prefix = all.filter(o => o.k.startsWith(q));

  const merged = [...new Map([...prefix, ...contains].map(o => [o.k, o])).values()]
    .slice(0, max)
    .map(o => o.name);

  return merged.length ? merged : all.slice(0, max).map(o => o.name);
}

// Expose a debug function so you can inspect names in console
window.listCountryNames = function () {
  const names = Array.from(countryIndex.values())
    .map(d => d.displayName)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  console.table(names);
  return names;
};

// -------------------------
// Load countries (white fill + bold borders) and build name->centroid index
// -------------------------
(async function () {
  try {
    const geojson = await (await fetch("./data/map_simplified.geojson")).json();

    const fillDs = new Cesium.CustomDataSource("Countries (Fill)");
    const borderDs = new Cesium.CustomDataSource("Countries (Borders)");

    const MAX_RING_POINTS = 2000;

    function addCountryFromPolygonRings(rings, props) {
      // Choose outer ring as the largest ring by area (more robust than rings[0])
      let bestRing = null;
      let bestArea = -1;

      for (const ring of rings || []) {
        const norm = normalizeRing(ring);
        if (!norm) continue;
        if (norm.length > MAX_RING_POINTS) continue;

        const a = ringAreaDeg2(norm);
        if (a > bestArea) {
          bestArea = a;
          bestRing = norm;
        }
      }

      if (!bestRing) return;

      const name = props?.name || "Country";
      const iso2 = props?.["ISO3166-1-Alpha-2"] || "";
      const iso3 = props?.["ISO3166-1-Alpha-3"] || "";

      // Build centroid index (once)
      const key = normalizeCountryName(name);
      if (key && !countryIndex.has(key)) {
        const c = ringCentroidDeg(bestRing);
        countryIndex.set(key, { lon: c.lon, lat: c.lat, iso2, iso3, displayName: name });
      }

      // Fill polygon
      const flat = ringToDegreesArray(bestRing);
      fillDs.entities.add({
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
          material: Cesium.Color.WHITE.withAlpha(1.0),
          outline: false,
          perPositionHeight: false,
        },
      });

      // Bold border as polyline (works reliably)
      borderDs.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(flat),
          clampToGround: true,
          width: 1.5,
          material: Cesium.Color.BLACK.withAlpha(1.0),
        },
      });
    }

    for (const f of geojson.features || []) {
      const geom = f.geometry;
      if (!geom) continue;

      if (geom.type === "Polygon") {
        addCountryFromPolygonRings(geom.coordinates, f.properties || {});
      } else if (geom.type === "MultiPolygon") {
        for (const poly of geom.coordinates || []) {
          addCountryFromPolygonRings(poly, f.properties || {});
        }
      }
    }

    await viewer.dataSources.add(fillDs);
    await viewer.dataSources.add(borderDs);

    console.log("Countries loaded. Names:", countryIndex.size);
  } catch (err) {
    console.error("Failed to load country polygons:", err);
  }
})();

// -------------------------
// Button (ask country name)
// -------------------------
window.addEventListener("DOMContentLoaded", () => {
  const addPopupBtn = document.createElement("button");
  addPopupBtn.textContent = "Add Manual Popup";
  addPopupBtn.className = "manualPopupBtn";

  const appDiv = document.getElementById("app");
  (appDiv || document.body).appendChild(addPopupBtn);

  addPopupBtn.addEventListener("click", () => {
    const name = prompt("Country name:");
    if (!name) return;
    addPopupByCountryName(name);
  });
});
