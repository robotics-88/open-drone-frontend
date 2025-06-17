let apiHost;
let ws;

function onHostChange() {
    const select = document.getElementById("hostSelect");
    const input = document.getElementById("customHost");

    if (select.value === "custom") {
    input.style.display = "inline-block";
    input.focus();
    return; // Wait for custom input to be typed
    } else {
    input.style.display = "none";
    apiHost = "http://" + select.value;
    reloadHostDependentFeatures();
    }
}

function onCustomHostInput() {
    const input = document.getElementById("customHost");
    let raw = input.value.trim();
    if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    raw = "http://" + raw;
    }
    apiHost = raw;
    reloadHostDependentFeatures();
}

function reloadHostDependentFeatures() {
    loadCapabilities();

    if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
    }
    connectWebSocket();
}

// === Leaflet map setup ===
const map = L.map("map").setView([37.422, -122.084], 17);
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Tiles © Esri",
}).addTo(map);

const missionSelect = document.getElementById("missionSelect");
const missionMap = {};

async function loadCapabilities() {
    missionSelect.innerHTML = '<option value="">Loading missions…</option>';

    try {
    const res = await fetch(`${apiHost}/capabilities`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const caps = JSON.parse(data.capabilities);

    missionSelect.innerHTML = '<option value="">-- Select Mission --</option>';

    const missionArray = Array.isArray(caps.missions) ? caps.missions : Object.values(caps.missions);

    if (missionArray.length === 0) {
        missionSelect.innerHTML = '<option value="">(No missions found)</option>';
        return;
    }

    missionArray.forEach((m) => {
        missionMap[m.name.toLowerCase()] = m;
        const opt = document.createElement("option");
        opt.value = m.name;

        if (m.available) {
        opt.textContent = m.name;
        } else {
        const needs = Array.isArray(m.requires_activation) ? m.requires_activation.join(", ") : "";
        opt.textContent = `${m.name} (locked: ${needs})`;
        opt.disabled = true;
        opt.style.opacity = 0.5;
        }

        missionSelect.appendChild(opt);
    });
    } catch (err) {
    console.error(err);
    missionSelect.innerHTML = '<option value="">Error loading missions</option>';
    }
}

window.addEventListener("DOMContentLoaded", () => {
    const initialSelect = document.getElementById("hostSelect");
    apiHost = "http://" + initialSelect.value;

    loadCapabilities();
    connectWebSocket();
});

const DroneIcon = L.divIcon({
    className: "",
    iconSize: [40, 40],
    html: '<img id="drone-arrow" src="arrow-bluev2.png" class="rotating-drone" />',
});
const droneMarker = L.marker([37.422, -122.084], { icon: DroneIcon }).addTo(map);

let setpointMarker = null;
let polygonLayer = null;
let drawing = false;
let followDrone = true;

const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);
const drawControl = new L.Control.Draw({
    draw: {
    polyline: false,
    rectangle: false,
    circle: false,
    circlemarker: false,
    marker: false,
    polygon: {
        allowIntersection: false,
        showArea: true,
    },
    },
    edit: {
    featureGroup: drawnItems,
    },
});
map.addControl(drawControl);

map.on("draw:created", function (e) {
    const layer = e.layer;
    if (e.layerType === "polygon") {
    if (polygonLayer) drawnItems.removeLayer(polygonLayer);
    polygonLayer = layer;
    drawnItems.addLayer(layer);
    }
});

map.on("draw:drawstart", () => (drawing = true));
map.on("draw:drawstop", () => (drawing = false));
map.on("draw:editstart", () => (drawing = true));
map.on("draw:editstop", () => (drawing = false));
map.on("draw:deletestart", () => (drawing = true));
map.on("draw:deletestop", () => (drawing = false));

map.on("movestart", () => (followDrone = false));

map.on("click", function (e) {
    if (drawing) return;
    if (setpointMarker) map.removeLayer(setpointMarker);
    setpointMarker = L.marker(e.latlng).addTo(map);
});

async function runMission() {
    const mission = missionSelect.value;
    if (!mission) return alert("Select a mission first.");

    const config = missionMap[mission.toLowerCase()];
    if (!config) return alert("Mission config not found.");

    let payload = { type: mission };

    if (config.geometry_type === "point") {
        if (!setpointMarker) return alert("Click on the map to set a target point.");
        const { lat, lng } = setpointMarker.getLatLng();
        payload.setpoint = { lat: lat, lon: lng, alt: 12.0 };
    }
    else if (config.geometry_type === "polygon") {
        if (!polygonLayer) return alert("Draw a polygon first.");
        const latlngs = polygonLayer.getLatLngs()[0].map((p) => ({ lat: p.lat, lon: p.lng }));
        payload.polygon = latlngs;
    }

    try {
        appendLog(`Sending mission: ${mission}`, "info");
    
        const res = await fetch(`${apiHost}/run_mission`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
    
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
        appendLog("✅ Mission sent successfully.", "info");
    
        const result = await res.json(); // assuming your API returns a confirmation
        if (result.status) {
          appendLog(`Mission confirmed: ${result.status}`);
        } else {
          appendLog("Mission accepted.");
        }
    } catch (err) {
        appendLog(`Mission send failed: ${err.message}`, "error");
    }
}

function recenter() {
    followDrone = true;
    if (droneMarker) {
    const pos = droneMarker.getLatLng();
    map.panTo([pos.lat, pos.lng]);
    }
}

function updateDroneMarker(data) {
    droneMarker.setLatLng([data.lat, data.lon]);
    if (followDrone) {
    map.panTo([data.lat, data.lon]);
    }
    document.getElementById("statusText").textContent = `Status: ${data.status}`;
    const arrowImg = document.getElementById("drone-arrow");
    if (arrowImg) {
    arrowImg.style.transform = `rotate(${data.heading}deg)`;
    }
}

function connectWebSocket() {
    const wsHost = apiHost.replace(/^http/, "ws");
    ws = new WebSocket(`${wsHost}/ws`);

    ws.onopen = () => {
        appendLog("Drone connected.", "info");
    };      

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        // If it's a drone status update
        if (data.lat && data.lon) {
            updateDroneMarker(data);
        }

        // If it's a log message
        if (data.type === "log" || data.log) {
            const log = data.log || data;
            appendLog(log.message, log.level);
        }
    };

    ws.onerror = (e) => {
        console.error("WebSocket error", e);
        document.getElementById("statusText").textContent = "Status: WS error";
        appendLog("Drone connection error.", "error");
    };
}

document.getElementById("toggleVideoBtn").addEventListener("click", () => {
    const container = document.getElementById("videoContainer");
    const iframe = document.getElementById("webrtcFrame");
    const btn = document.getElementById("toggleVideoBtn");

    const isHidden = container.style.display === "none";

    if (isHidden) {
    container.style.display = "block";
    iframe.src = `http://drone.local:8889/mapir`; // reconnect
    btn.textContent = "📹 Hide Camera";
    } else {
    container.style.display = "none";
    iframe.src = ""; // disconnect
    btn.textContent = "📹 Show Camera";
    }
});

function updateHUD(data) {
    // === GPS Satellites (assume it's a number)
    const gpsIcon = document.getElementById("gpsSatellites");
    gpsIcon.textContent = data.gps_satellites >= 10 ? "gps_fixed" : "gps_not_fixed";
  
    // === Number of Cameras
    const numCameras = document.getElementById("numCameras");
    numCameras.nextSibling.textContent = ` ${data.num_cameras || 0}`;
  
    // === Battery Voltage + Red if low
    const batteryIcon = document.getElementById("batteryIcon");
    const batteryVolts = document.getElementById("batteryVolts");
    batteryVolts.textContent = `${data.battery_voltage.toFixed(1)}V`;
  
    if (data.battery_voltage < 10.5) {
      batteryIcon.classList.add("low-battery");
    } else {
      batteryIcon.classList.remove("low-battery");
    }
  
    // === Drone State Text + Color
    const droneState = document.getElementById("droneState");
    const status = data.status || "Unknown";
    droneState.textContent = `Status: ${status}`;
    droneState.classList.remove("status-green", "status-yellow", "status-red");
  
    if (["Ready", "Armed", "Flying"].includes(status)) {
      droneState.classList.add("status-green");
    } else if (["Initializing", "RTL", "Landing"].includes(status)) {
      droneState.classList.add("status-yellow");
    } else if (["Disconnected", "Failsafe", "Connection lost", "Error"].includes(status)) {
      droneState.classList.add("status-red");
    }
  
    // === Height
    const heightIcon = document.getElementById("heightAboveHome");
    heightIcon.nextSibling.textContent = ` H: ${data.height?.toFixed(1) || "--"} m`;
  
    // === Distance
    const distIcon = document.getElementById("distanceToHome");
    distIcon.nextSibling.textContent = ` D: ${data.distance?.toFixed(1) || "--"} m`;
  
    // === Speed
    const speedIcon = document.getElementById("speed");
    speedIcon.nextSibling.textContent = ` HS: ${data.speed?.toFixed(1) || "--"} m/s`;
}  
  
document.getElementById("toggleMissionBtn").addEventListener("click", () => {
    const panel = document.getElementById("missionPanel");
    panel.style.display = panel.style.display === "none" ? "block" : "none";
});

function appendLog(message, level = "normal") {
    const logContent = document.getElementById("logContent");
    const line = document.createElement("div");
    line.className = `log-line log-${level}`;
    line.textContent = message;
  
    logContent.appendChild(line);
    logContent.scrollTop = logContent.scrollHeight; // auto-scroll to bottom
}  