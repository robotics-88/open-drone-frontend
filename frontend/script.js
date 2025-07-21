let apiHost;
let ws;
let lastTelemetryTimestamp = 0;
let droneInFlight = false; // update this dynamically from telemetry
let rpicLocationWatchId = null;

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

// helper to toggle the “stale” class on all HUD elements
function setHUDStale(isStale) {
  const hudIds = [
    'gpsCount','cameraCount',
    'batteryVolts','droneState',
    'heightVal','distanceVal','speedVal'
  ];
  hudIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('stale', isStale);
  });
}

// === Leaflet map setup ===
const map = L.map("map").setView([37.422, -122.084], 17);
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Tiles © Esri",
}).addTo(map);

const missionSelect = document.getElementById("missionSelect");
const missionMap = {};
let selectedMissionConfig = null;
let availableDEMs = [];

async function loadCapabilities() {
    missionSelect.innerHTML = '<option value="">Loading missions…</option>';

    try {
        const res = await fetch(`${apiHost}/capabilities`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        if (!data.capabilities) {
        missionSelect.innerHTML = '<option value="">(No capabilities provided)</option>';
        return;
        }

        const caps = JSON.parse(data.capabilities);
        const missionArray = Array.isArray(caps.missions) ? caps.missions : Object.values(caps.missions);

        missionSelect.innerHTML = '<option value="">-- Select Mission --</option>';
        if (missionArray.length === 0) {
        missionSelect.innerHTML = '<option value="">(No missions found)</option>';
        } else {
        missionArray.forEach((m) => {
            missionMap[m.name.toLowerCase()] = m;
            const opt = document.createElement("option");
            opt.value = m.name;

            if (m.available) {
            opt.textContent = m.name;
            } else {
            const needs = Array.isArray(m.requires_activation) ? m.requires_activation.join(", ") : "";
            opt.textContent = `${m.name} (locked: ${needs})`;
            opt.style.opacity = 0.5;
            }

            missionSelect.appendChild(opt);
        });
        }

        // Render perception modules
        const perceptionModulesDiv = document.getElementById("perceptionModules");
        perceptionModulesDiv.innerHTML = "";

        if (caps.perception_modules) {
            for (const [moduleName, info] of Object.entries(caps.perception_modules)) {
                console.log(`Module: ${moduleName}`, info);
                const isActive = info.active;
                const isTogglable = info.togglable;

                const modDiv = document.createElement("div");
                modDiv.className = "perception-module";

                const label = document.createElement("span");
                label.textContent = moduleName;
                if (!isTogglable) {
                label.style.opacity = "0.6";
                }

                const toggle = document.createElement("input");
                toggle.type = "checkbox";
                toggle.checked = isActive;
                toggle.dataset.module = moduleName;
                toggle.disabled = !isTogglable;

                toggle.addEventListener("change", (e) => {
                const newState = e.target.checked;
                fetch(`${apiHost}/set_module_active`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                    module_name: e.target.dataset.module,
                    active: newState,
                    }),
                }).catch((err) => console.error("Failed to set module state", err));
                });

                modDiv.appendChild(label);
                modDiv.appendChild(toggle);
                perceptionModulesDiv.appendChild(modDiv);
            }
        }


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

    missionSelect.addEventListener("change", () => {
        const missionName = missionSelect.value;
        const lowerName = missionName.toLowerCase();
        selectedMissionConfig = missionMap[lowerName];
        renderMissionDetails(selectedMissionConfig);
    });

    setInterval(() => {
    if (Date.now() - lastTelemetryTimestamp > 5000) {
        setHUDStale(true);
        console.log("No telemetry received in 5 seconds, marking HUD as stale.");
        setDroneConnected(false);
    }
    }, 1000);
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

    const demDropdown = document.getElementById("demSelector");
    const demUpload = document.getElementById("demUpload");

    const selectedDEM = demDropdown?.value || "";
    const uploadedFile = demUpload?.files?.[0];

    if (uploadedFile) {
        // Convert file to base64
        const arrayBuffer = await uploadedFile.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        const binaryString = Array.from(uint8Array).map(b => String.fromCharCode(b)).join('');
        const base64Data = btoa(binaryString);

        payload.dem_uploaded = base64Data;
        payload.dem_filename = uploadedFile.name;
    } else if (selectedDEM) {
        payload.dem = selectedDEM;
    }

    demUpload.addEventListener("change", () => {
        if (demUpload.files.length > 0) {
            demDropdown.selectedIndex = 0; // Reset to "-- No DEM --"
            highlightSelectedDEM(""); // Remove highlight
        }
    });


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
        appendLog(`Sending mission: ${mission}`, "normal");
    
        const res = await fetch(`${apiHost}/run_mission`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
    
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        appendLog("✅ Mission sent successfully.", "normal");

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
    const arrowImg = document.getElementById("drone-arrow");
    if (arrowImg) {
        arrowImg.style.transform = `rotate(${data.heading}deg)`;
    }
}

function connectWebSocket() {
    const wsHost = apiHost.replace(/^http/, "ws");
    ws = new WebSocket(`${wsHost}/ws`);

    ws.onopen = () => {
        appendLog("Drone connected.", "normal");
        setDroneConnected(true);
    };      

    ws.onmessage = (event) => {
        if (!event.data || event.data.trim() === "") {
            console.warn("Received empty message over WebSocket");
            return;
        }

        let data;
        try {
            data = JSON.parse(event.data);
        } catch (err) {
            console.error("Failed to parse WebSocket message:", event.data);
            return;
        }

        // Handle telemetry
        if (data.type === "telemetry") {
            updateDroneMarker(data);
            updateHUD(data);
            lastTelemetryTimestamp = Date.now();
            setHUDStale(false);
        }

        // Handle logs
        if (data.type === "log" || data.log) {
            const log = data.log || data;
            appendLog(log.message, log.level.toLowerCase());
        }

        // Handle capability reload
        if (data.type === "capability_reload" || data.log) {
            appendLog("Capabilities reloaded from drone.", "normal");
            loadCapabilities();
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
    iframe.src = `http://drone.local:8889/camera1`; // reconnect
    btn.textContent = "📹 Hide Camera";
    } else {
    container.style.display = "none";
    iframe.src = ""; // disconnect
    btn.textContent = "📹 Show Camera";
    }
});

function updateHUD(data) {
    // === GPS Icon + count
    document.getElementById("gpsSatellites").textContent =
      data.gps_satellites >= 10 ? "gps_fixed" : "gps_not_fixed";
    document.getElementById("gpsCount").textContent = data.gps_satellites;
  
    // === Num cameras
    document.getElementById("cameraCount").textContent = data.num_cameras || 0;
  
    // === Battery
    const vb = data.battery_voltage.toFixed(4);
    document.getElementById("batteryVolts").textContent = `${vb}V`;
  
    // === Drone state
    const stateEl = document.getElementById("droneState");
    stateEl.textContent = `Status: ${data.status || "--"}`;
    stateEl.classList.remove("status-green","status-yellow","status-red");
    if (["READY","MANUAL_FLIGHT","MISSION","COMPLETE"].includes(data.status))      stateEl.classList.add("status-green");
    else if (["INITIALIZING","PREFLIGHT_CHECK","RTL_88","TAKING_OFF","LANDING"].includes(data.status)) stateEl.classList.add("status-yellow");
    else                                                       stateEl.classList.add("status-red");

    if (["RTL_88","MANUAL_FLIGHT","MISSION","TAKING_OFF", "LANDING"].includes(data.status)) droneInFlight = true;
    else droneInFlight = false;

    // === Height / Distance / Speed
    document.getElementById("heightVal").textContent   = `${(data.height || 0).toFixed(1)} m`;
    document.getElementById("distanceVal").textContent = `${(data.distance || 0).toFixed(1)} m`;
    document.getElementById("speedVal").textContent    = `${(data.speed || 0).toFixed(1)} m/s`;
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

async function renderMissionDetails(config) {
    const container = document.getElementById("missionDetails");
    container.innerHTML = "";

    if (!config) return;

    const isLocked = !config.available;
    if (!isLocked) {
        renderDemSection(container);
        return;
    }

    const required = Array.isArray(config.requires_activation) ? config.requires_activation : [];

    // Title
    const header = document.createElement("h4");
    header.innerHTML = `<span class="material-icons">lock</span> Locked Mission Requirements`;
    container.appendChild(header);

    // Required perception modules
    const checkboxWrapper = document.createElement("div");
    checkboxWrapper.style.display = "flex";
    checkboxWrapper.style.alignItems = "center";
    checkboxWrapper.style.gap = "8px";

    const acceptBox = document.createElement("input");
    acceptBox.type = "checkbox";
    acceptBox.id = "acceptModules";

    const acceptLabel = document.createElement("label");
    acceptLabel.textContent = `Requires activating: ${required.join(", ")}`;
    acceptLabel.setAttribute("for", "acceptModules");

    checkboxWrapper.appendChild(acceptBox);
    checkboxWrapper.appendChild(acceptLabel);
    container.appendChild(checkboxWrapper);

    // DEM selection
    renderDemSection(container);

    // Enable Run only if acceptBox is checked
    const runBtn = document.querySelector("button[onclick='runMission()']");
    if (isLocked) {
        runBtn.disabled = true;

        acceptBox.addEventListener("change", () => {
            runBtn.disabled = !acceptBox.checked;
        });
    } else {
        runBtn.disabled = false;
    }

}

async function fetchAvailableDEMs() {
    try {
        const res = await fetch(`${apiHost}/dems`);
        const json = await res.json();
        if (Array.isArray(json)) availableDEMs = json;
        renderDEMPreviews(availableDEMs);
    } catch (err) {
        console.warn("Could not fetch DEM list", err);
    }
}

function renderDemSection(container) {
    const demHeader = document.createElement("h4");
    demHeader.innerHTML = `<span class="material-icons">folder</span> Attach DEM (optional)`;
    container.appendChild(demHeader);

    const demDropdown = document.createElement("select");
    demDropdown.id = "demSelector";
    demDropdown.innerHTML = "<option value=''>-- No DEM --</option>";
    container.appendChild(demDropdown);

    const uploadInput = document.createElement("input");
    uploadInput.type = "file";
    uploadInput.accept = ".tif";
    uploadInput.id = "demUpload";
    container.appendChild(uploadInput);

    if (availableDEMs.length === 0) {
        fetchAvailableDEMs().then(() => {
            availableDEMs.forEach((dem) => {
                const opt = document.createElement("option");
                opt.value = dem.filename;
                opt.textContent = dem.filename;
                demDropdown.appendChild(opt);
            });
        });
    } else {
        availableDEMs.forEach((dem) => {
            const opt = document.createElement("option");
            opt.value = dem.filename;
            opt.textContent = dem.filename;
            demDropdown.appendChild(opt);
        });
    }
    demDropdown.addEventListener("change", () => {
        const selected = demDropdown.value;

        for (const [filename, rect] of Object.entries(demRectangles)) {
            rect.setStyle({
                color: filename === selected ? "#2196F3" : "#888888", // blue if selected
                weight: 1
            });
        }
    });

}

const demLayerGroup = L.layerGroup().addTo(map); // Clears and holds DEM previews
const demRectangles = {}; // filename → rectangle

function renderDEMPreviews(demList) {
    demLayerGroup.clearLayers();
    Object.keys(demRectangles).forEach(k => delete demRectangles[k]);

    demList.forEach(dem => {
        if (dem.bounds) {
            const lat1 = Math.min(dem.bounds.min_lat, dem.bounds.max_lat);
            const lat2 = Math.max(dem.bounds.min_lat, dem.bounds.max_lat);
            const lon1 = Math.min(dem.bounds.min_lon, dem.bounds.max_lon);
            const lon2 = Math.max(dem.bounds.min_lon, dem.bounds.max_lon);

            const bounds = [[lat1, lon1], [lat2, lon2]];

            const rect = L.rectangle(bounds, {
                color: "#888888",       // gray
                weight: 1,
                fillOpacity: 0.2
            }).bindTooltip(dem.filename, { permanent: false });

            demLayerGroup.addLayer(rect);
            demRectangles[dem.filename] = rect;
        }
    });
}

let holdTimer = null;
const HOLD_DURATION = 2000;

function holdStart(event, actionName, endpoint) {
  const button = event.currentTarget;
  if (button.disabled) return;

  const label = button.querySelector('.label');
  const progress = button.querySelector('.progress');

  // Save original label
  if (!button.dataset.holdLabel) {
    button.dataset.holdLabel = label.textContent;
  }

  label.textContent = 'Hold...';
  progress.style.transition = `width ${HOLD_DURATION}ms linear`;
  progress.style.width = '100%';

  holdTimer = setTimeout(() => {
    sendEmergencyCommand(actionName, endpoint);
    label.textContent = '✓';
    progress.style.width = '0%';
    setTimeout(() => {
      label.textContent = button.dataset.holdLabel;
    }, 1000);
  }, HOLD_DURATION);
}

function holdEnd(event) {
  clearTimeout(holdTimer);

  const button = event.currentTarget;
  const label = button.querySelector('.label');
  const progress = button.querySelector('.progress');

  if (button.dataset.holdLabel) {
    label.textContent = button.dataset.holdLabel;
  }

  progress.style.transition = 'none';
  progress.style.width = '0%';
}

function sendEmergencyCommand(actionName, endpoint) {
  const url = `${apiHost}${endpoint}`;
  console.log(`Sending ${actionName} to ${url}`);

  fetch(url, { method: 'POST' })
    .then(response => {
      if (!response.ok) throw new Error(`Server responded with ${response.status}`);
      return response.text();
    })
    .then(data => {
      console.log(`${actionName} sent:`, data);
    })
    .catch(err => {
      console.error(`Failed to send ${actionName}:`, err);
      alert(`Failed to send ${actionName}.`);
    });
}

// Enable/disable emergency buttons based on drone connection
function setDroneConnected(isConnected) {
  const buttons = document.querySelectorAll('#emergencyButtons button');
  buttons.forEach(btn => {
    btn.disabled = !isConnected;
  });
}

document.getElementById('settingsBtn').onclick = () => {
  if (droneInFlight) {
    alert("Settings can only be viewed when the drone is grounded.");
    return;
  }
  openSettings();
};

function openSettings() {
  document.getElementById('settingsScreen').style.display = 'flex';
  document.getElementById('flightHours').textContent = "12.4";  // Replace with real data
  document.getElementById('logCount').textContent = "18";
  document.getElementById('droneId').textContent = "DRN-00123";

  document.getElementById('pilotName').value = localStorage.getItem("pilotName") || "";
  document.getElementById('pilotLicense').value = localStorage.getItem("pilotLicense") || "";
}

function closeSettings() {
  document.getElementById('settingsScreen').style.display = 'none';
}

function saveSettings() {
  const name = document.getElementById('pilotName').value;
  const license = document.getElementById('pilotLicense').value;
  localStorage.setItem("pilotName", name);
  localStorage.setItem("pilotLicense", license);
  alert("Settings saved!");
}

let latestPosition = null;

document.getElementById("rpicToggle").addEventListener("change", (e) => {
  const isRPIC = e.target.checked;
  const statusText = document.getElementById("rpicStatus");

  if (isRPIC) {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser.");
      e.target.checked = false;
      return;
    }

    statusText.textContent = "Sharing your location with the drone backend...";

    rpicLocationWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        latestPosition = pos;
      },
      (err) => {
        console.error("Location error:", err.message);
        statusText.textContent = "Location sharing failed.";
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000,
      }
    );

    rpicIntervalId = setInterval(() => {
      if (!latestPosition) return;

      const pos = latestPosition;
      const payload = {
        uas_id: 123456,
        operator_id: parseInt(localStorage.getItem("pilotLicense")) || 0,
        operator_latitude: pos.coords.latitude,
        operator_longitude: pos.coords.longitude,
        operator_altitude_geo: pos.coords.altitude || 0,
        timestamp: Math.floor(Date.now() / 1000),
      };

      fetch(`${apiHost}/remote_id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch((err) => console.error("Failed to send Remote ID:", err));
    }, 1000); // 1Hz
  } else {
    statusText.textContent = "RPIC mode disabled.";
    if (rpicLocationWatchId !== null) {
      navigator.geolocation.clearWatch(rpicLocationWatchId);
      rpicLocationWatchId = null;
    }
    if (rpicIntervalId !== null) {
      clearInterval(rpicIntervalId);
      rpicIntervalId = null;
    }
    latestPosition = null;
  }
});



