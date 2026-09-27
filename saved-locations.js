// ======================================================
// SAVED LOCATIONS PAGE
// ======================================================

const SAVED_LOCATIONS_STORAGE_KEY = "kuantan-flood-saved-locations";
const MAX_SAVED_LOCATIONS = 5;
const WEATHER_API_URL = "https://api.open-meteo.com/v1/forecast";
const GEOJSON_URL = "new_fr_kuantan.geojson";

const riskNames = {
    1: "Very Low",
    2: "Low",
    3: "Moderate",
    4: "High",
    5: "Very High"
};

const IMMEDIATE_ALERT_WEATHER_CODES = {
    65: "Heavy rain",
    82: "Violent rain showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Thunderstorm with heavy hail"
};

const DANGEROUS_WEATHER_CODES = Object.keys(IMMEDIATE_ALERT_WEATHER_CODES).map(Number);

const weatherCodeDetails = {
    0: ["Clear sky", "☀️"],
    1: ["Mainly clear", "🌤️"],
    2: ["Partly cloudy", "⛅"],
    3: ["Overcast", "☁️"],
    45: ["Fog", "🌫️"],
    48: ["Depositing rime fog", "🌫️"],
    51: ["Light drizzle", "🌦️"],
    53: ["Moderate drizzle", "🌦️"],
    55: ["Dense drizzle", "🌧️"],
    61: ["Slight rain", "🌦️"],
    63: ["Moderate rain", "🌧️"],
    65: ["Heavy rain", "🌧️"],
    71: ["Slight snow", "🌨️"],
    73: ["Moderate snow", "🌨️"],
    75: ["Heavy snow", "❄️"],
    80: ["Slight rain showers", "🌦️"],
    81: ["Moderate rain showers", "🌧️"],
    82: ["Violent rain showers", "⛈️"],
    95: ["Thunderstorm", "⛈️"],
    96: ["Thunderstorm with hail", "⛈️"],
    99: ["Thunderstorm with heavy hail", "⛈️"]
};

const listElement = document.getElementById("saved-locations-list");
const countElement = document.getElementById("saved-locations-count");
const emptyElement = document.getElementById("saved-locations-empty");

let floodFeatures = [];

function getSavedLocationsList() {
    try {
        const list = JSON.parse(localStorage.getItem(SAVED_LOCATIONS_STORAGE_KEY) || "[]");
        return Array.isArray(list) ? list : [];
    } catch (error) {
        console.warn("Unable to read saved locations:", error);
        return [];
    }
}

function setSavedLocationsList(list) {
    localStorage.setItem(SAVED_LOCATIONS_STORAGE_KEY, JSON.stringify(list));
}

function getSafeLocationLabel(label) {
    const value = String(label || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    return value.slice(0, 80) || "Saved location";
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[character]));
}

function getRiskLevel(feature) {
    if (!feature || !feature.properties) {
        return 0;
    }

    const value = Number(feature.properties.DN ?? feature.properties.gridcode ?? 0);
    return Number.isFinite(value) ? value : 0;
}

function haversineDistance(lat1, lng1, lat2, lng2) {
    const earthRadius = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function localPoint(point, origin) {
    const earthRadius = 6371000;
    const latitudeScale = Math.cos(origin.lat * Math.PI / 180);

    return {
        x: (point.lng - origin.lng) * Math.PI / 180 * earthRadius * latitudeScale,
        y: (point.lat - origin.lat) * Math.PI / 180 * earthRadius
    };
}

function distanceToSegment(point, start, end) {
    const target = localPoint(point, point);
    const first = localPoint(start, point);
    const second = localPoint(end, point);
    const deltaX = second.x - first.x;
    const deltaY = second.y - first.y;
    const segmentLengthSquared = deltaX * deltaX + deltaY * deltaY;

    if (!segmentLengthSquared) {
        return haversineDistance(point.lat, point.lng, start.lat, start.lng);
    }

    const position = Math.max(0, Math.min(1,
        ((target.x - first.x) * deltaX + (target.y - first.y) * deltaY) / segmentLengthSquared
    ));
    const closestLat = point.lat + (first.y + position * deltaY) / 6371000 * 180 / Math.PI;
    const closestLng = point.lng + (first.x + position * deltaX) / (6371000 * Math.cos(point.lat * Math.PI / 180)) * 180 / Math.PI;

    return haversineDistance(point.lat, point.lng, closestLat, closestLng);
}

function pointInRing(point, ring) {
    let inside = false;

    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
        const currentPoint = ring[index];
        const previousPoint = ring[previous];
        const crossesLatitude = currentPoint[1] > point.lat !== previousPoint[1] > point.lat;
        const crossingLongitude = (previousPoint[0] - currentPoint[0]) *
            (point.lat - currentPoint[1]) /
            (previousPoint[1] - currentPoint[1]) + currentPoint[0];

        if (crossesLatitude && point.lng < crossingLongitude) {
            inside = !inside;
        }
    }

    return inside;
}

function polygonIntersectsRadius(polygon, center, radius) {
    for (let index = 0; index < polygon.length; index += 1) {
        const ring = polygon[index];

        if (pointInRing(center, ring)) {
            return true;
        }

        for (let pointIndex = 0; pointIndex < ring.length; pointIndex += 1) {
            const current = { lat: ring[pointIndex][1], lng: ring[pointIndex][0] };
            const next = { lat: ring[(pointIndex + 1) % ring.length][1], lng: ring[(pointIndex + 1) % ring.length][0] };

            if (haversineDistance(center.lat, center.lng, current.lat, current.lng) <= radius ||
                distanceToSegment(center, current, next) <= radius) {
                return true;
            }
        }
    }

    return false;
}

function featureIntersectsRadius(feature, center, radius) {
    if (!feature || !feature.geometry) {
        return false;
    }

    if (feature.geometry.type === "Polygon") {
        return polygonIntersectsRadius(feature.geometry.coordinates, center, radius);
    }

    if (feature.geometry.type === "MultiPolygon") {
        return feature.geometry.coordinates.some(polygon => polygonIntersectsRadius(polygon, center, radius));
    }

    return false;
}

function getHighestRiskForLocation(location) {
    let highestRisk = 0;
    let affectedFeatures = 0;

    floodFeatures.forEach(feature => {
        if (featureIntersectsRadius(feature, location, location.radius)) {
            affectedFeatures += 1;
            highestRisk = Math.max(highestRisk, getRiskLevel(feature));
        }
    });

    return { highestRisk, affectedFeatures };
}

function formatSavedDate(isoString) {
    if (!isoString) {
        return "Unknown date";
    }

    return new Intl.DateTimeFormat("en-MY", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Kuala_Lumpur"
    }).format(new Date(isoString));
}

async function fetchWeatherForLocation(location) {
    const query = new URLSearchParams({
        latitude: location.lat,
        longitude: location.lng,
        current: "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
        hourly: "precipitation_probability",
        timezone: "Asia/Kuala_Lumpur",
        forecast_days: 1
    });

    const response = await fetch(`${WEATHER_API_URL}?${query}`);

    if (!response.ok) {
        throw new Error(`Weather request failed with status ${response.status}`);
    }

    return response.json();
}

function buildRiskBadge(highestRisk, affectedFeatures) {
    if (!highestRisk) {
        return `<span class="risk-badge risk-badge-none">No mapped flood risk in this radius</span>`;
    }

    const level = Math.min(5, Math.max(1, highestRisk));
    return `<span class="risk-badge risk-badge-${level}">Category ${level} · ${riskNames[level]} (${affectedFeatures} area${affectedFeatures === 1 ? "" : "s"})</span>`;
}

function buildWeatherSummary(weatherData) {
    if (!weatherData || !weatherData.current) {
        return `<p class="saved-location-weather-error">Weather data unavailable.</p>`;
    }

    const current = weatherData.current;
    const details = weatherCodeDetails[Number(current.weather_code)] || ["Unknown conditions", "🌡️"];
    const hourly = weatherData.hourly;
    const currentHourIndex = hourly && Array.isArray(hourly.time)
        ? hourly.time.findIndex(time => String(time).slice(0, 13) === String(current.time).slice(0, 13))
        : -1;
    const rainChance = currentHourIndex >= 0 ? hourly.precipitation_probability[currentHourIndex] : null;
    const isDangerous = DANGEROUS_WEATHER_CODES.includes(Number(current.weather_code));

    return `
        <div class="saved-location-weather">
            <span class="saved-location-weather-icon" aria-hidden="true">${details[1]}</span>
            <div>
                <p class="saved-location-weather-condition">${details[0]}${isDangerous ? " · ⚠️ Dangerous" : ""}</p>
                <p class="saved-location-weather-detail">${Math.round(current.temperature_2m)}°C · Humidity ${current.relative_humidity_2m}% · Rain ${current.precipitation} mm${rainChance === null ? "" : ` · Chance ${rainChance}%`}</p>
            </div>
        </div>
    `;
}

function renderEmptyState() {
    listElement.innerHTML = "";
    emptyElement.hidden = false;
    countElement.textContent = `0 / ${MAX_SAVED_LOCATIONS} saved locations`;
}

function removeLocation(id) {
    const updatedList = getSavedLocationsList().filter(location => location.id !== id);
    setSavedLocationsList(updatedList);
    renderSavedLocations();
}

function renameLocation(id) {
    const locations = getSavedLocationsList();
    const location = locations.find(item => item.id === id);
    if (!location) {
        return;
    }

    const nextLabel = window.prompt("Rename saved location", getSafeLocationLabel(location.label));
    if (nextLabel === null) {
        return;
    }

    location.label = getSafeLocationLabel(nextLabel);
    setSavedLocationsList(locations);
    renderSavedLocations();
}

function buildLocationCard(location) {
    const { highestRisk, affectedFeatures } = getHighestRiskForLocation(location);
    const sourceLabel = location.source === "gps" ? "GPS location" : "Manual pin";
    const label = getSafeLocationLabel(location.label);

    const card = document.createElement("article");
    card.className = "saved-location-card";
    card.innerHTML = `
        <div class="saved-location-header">
            <div>
                <h2>${escapeHtml(label)}</h2>
                <p class="saved-location-meta">${location.lat.toFixed(5)}, ${location.lng.toFixed(5)} · ${sourceLabel} · ${location.radius} m radius</p>
                <p class="saved-location-meta">Saved ${formatSavedDate(location.savedAt)}</p>
            </div>
            <div class="saved-location-actions">
                <a class="show-location-button" href="index.html?location=${encodeURIComponent(location.id)}#map">Show on map</a>
                <button class="rename-location-button" type="button" data-id="${escapeHtml(location.id)}">Rename</button>
                <button class="remove-location-button" type="button" data-id="${escapeHtml(location.id)}" aria-label="Remove ${escapeHtml(label)}">Remove</button>
            </div>
        </div>
        ${buildRiskBadge(highestRisk, affectedFeatures)}
        <div class="saved-location-weather-slot" data-id="${location.id}">
            <p class="saved-location-weather-loading">Loading weather...</p>
        </div>
    `;

    card.querySelector(".rename-location-button").addEventListener("click", () => renameLocation(location.id));
    card.querySelector(".remove-location-button").addEventListener("click", () => removeLocation(location.id));

    return card;
}

async function renderSavedLocations() {
    const locations = getSavedLocationsList();

    if (!locations.length) {
        renderEmptyState();
        return;
    }

    emptyElement.hidden = true;
    countElement.textContent = `${locations.length} / ${MAX_SAVED_LOCATIONS} saved locations`;
    listElement.innerHTML = "";

    locations.forEach(location => {
        listElement.appendChild(buildLocationCard(location));
    });

    await Promise.all(locations.map(async location => {
        const slot = listElement.querySelector(`.saved-location-weather-slot[data-id="${location.id}"]`);
        if (!slot) {
            return;
        }

        try {
            const weatherData = await fetchWeatherForLocation(location);
            slot.innerHTML = buildWeatherSummary(weatherData);
        } catch (error) {
            console.error("Unable to load weather for saved location:", error);
            slot.innerHTML = `<p class="saved-location-weather-error">Weather data unavailable.</p>`;
        }
    }));
}

async function loadFloodFeatures() {
    try {
        const response = await fetch(GEOJSON_URL);

        if (!response.ok) {
            throw new Error(`Unable to load ${GEOJSON_URL}`);
        }

        const data = await response.json();
        floodFeatures = Array.isArray(data.features) ? data.features : [];
    } catch (error) {
        console.error("Unable to load flood risk data for saved locations:", error);
        floodFeatures = [];
    }
}

function setupNavigation() {
    const navToggle = document.getElementById("nav-toggle");
    const mobileMenuToggle = document.getElementById("mobile-menu-toggle");
    const siteNav = document.getElementById("site-nav");

    function toggleNavigation() {
        const isExpanded = navToggle.getAttribute("aria-expanded") === "true";
        navToggle.setAttribute("aria-expanded", String(!isExpanded));
        navToggle.setAttribute("aria-label", isExpanded ? "Open navigation" : "Close navigation");
        mobileMenuToggle.setAttribute("aria-expanded", String(!isExpanded));
        siteNav.classList.toggle("is-open", !isExpanded);
    }

    navToggle.addEventListener("click", toggleNavigation);
    mobileMenuToggle.addEventListener("click", toggleNavigation);
    siteNav.addEventListener("click", event => {
        if (event.target.closest("a")) {
            navToggle.setAttribute("aria-expanded", "false");
            mobileMenuToggle.setAttribute("aria-expanded", "false");
            siteNav.classList.remove("is-open");
        }
    });
}

async function init() {
    setupNavigation();
    countElement.textContent = "Loading saved locations...";
    await loadFloodFeatures();
    await renderSavedLocations();
}

init();
