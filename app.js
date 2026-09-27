// ======================================================
// KUANTAN FLOOD RISK MAP
// ======================================================

// ------------------------------------------------------
// 1. CREATE MAP
// ------------------------------------------------------

const map = L.map("map");
const savedLocationLayerGroup = L.layerGroup().addTo(map);

const navToggle = document.getElementById("nav-toggle");
const siteNav = document.getElementById("site-nav");
const mobileMenuToggle = document.getElementById("mobile-menu-toggle");

function toggleSiteNavigation() {
    const isExpanded = navToggle.getAttribute("aria-expanded") === "true";
    navToggle.setAttribute("aria-expanded", String(!isExpanded));
    navToggle.setAttribute("aria-label", isExpanded ? "Open navigation" : "Close navigation");
    mobileMenuToggle.setAttribute("aria-expanded", String(!isExpanded));
    siteNav.classList.toggle("is-open", !isExpanded);
}

navToggle.addEventListener("click", toggleSiteNavigation);
mobileMenuToggle.addEventListener("click", toggleSiteNavigation);

siteNav.addEventListener("click", event => {
    if (event.target.closest("a")) {
        navToggle.setAttribute("aria-expanded", "false");
        navToggle.setAttribute("aria-label", "Open navigation");
        mobileMenuToggle.setAttribute("aria-expanded", "false");
        siteNav.classList.remove("is-open");
    }
});

// ------------------------------------------------------
// 2. OPENSTREETMAP BASE MAP
// ------------------------------------------------------

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// ------------------------------------------------------
// 3. FLOOD RISK COLOURS
// ------------------------------------------------------

const riskColours = {
    1: "#208edd",   // Very Low
    2: "#26f10f",   // Low
    3: "#f1e90f",   // Moderate
    4: "#eb7b13",   // High
    5: "#e40c0c"    // Very High
};

const riskNames = {
    1: "Very Low",
    2: "Low",
    3: "Moderate",
    4: "High",
    5: "Very High"
};

function getRiskLevel(feature) {
    if (!feature || !feature.properties) {
        return 0;
    }

    const value = Number(feature.properties.DN ?? feature.properties.gridcode ?? 0);
    return Number.isFinite(value) ? value : 0;
}

// ------------------------------------------------------
// 4. STYLE FLOOD POLYGONS
// ------------------------------------------------------

function floodStyle(feature) {
    const risk = getRiskLevel(feature);

    return {
        color: "#555",
        weight: 0.5,
        fillColor: riskColours[risk] || "#999",
        fillOpacity: 0.6
    };
}

// ================================
// PHASE 6 - WEATHER
// ================================

const WEATHER_API_URL = "https://api.open-meteo.com/v1/forecast";
const TEST_MODE = true;
const KUANTAN_LOCATION = {
    name: "Kuantan, Pahang, Malaysia",
    latitude: 3.8077,
    longitude: 103.3260
};

const IMMEDIATE_ALERT_WEATHER_CODES = {
    65: "Heavy rain",
    82: "Violent rain showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Thunderstorm with heavy hail"
};

const DANGEROUS_WEATHER_CODES = Object.keys(IMMEDIATE_ALERT_WEATHER_CODES).map(Number);
const HEAVY_RAIN_THRESHOLD_MM = 10;
const HIGH_FLOOD_RISK_THRESHOLD = 4;
const CONTINUOUS_RAIN_PROBABILITY_THRESHOLD = 60;
const CONTINUOUS_RAIN_HOURS = 3;
const FLOOD_ALERTS_ENABLED_STORAGE_KEY = "kuantan-flood-alerts-enabled";
const FLOOD_ALERT_DEDUPE_STORAGE_KEY = "kuantan-flood-alert-dedupe";
const TEST_ALERT_DEDUPE_STORAGE_KEY = "kuantan-flood-test-alert-dedupe";
const TEST_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const FCM_TOKEN_STORAGE_KEY = "kuantan-flood-fcm-token";
const SAVED_LOCATIONS_STORAGE_KEY = "kuantan-flood-saved-locations";
const MAX_SAVED_LOCATIONS = 5;
const alertState = {
    lastNotificationKey: "",
    deduplicatedAlertKeys: []
};
let floodLayer;
let pendingLocation;
let savedLocation;
let locationMarker;
let radiusCircle;
let userLocationMarker;
let userLocationWatchId;
let hasCenteredOnUserLocation = false;
let floodAlertsEnabled = localStorage.getItem(FLOOD_ALERTS_ENABLED_STORAGE_KEY) !== "false";
let notificationRegistration;
let fcmToken = localStorage.getItem(FCM_TOKEN_STORAGE_KEY) || "";

function acknowledgeNotificationMessage(port) {
    try {
        port?.postMessage({ received: true });
    } catch (error) {
        console.warn("[FCM] Notification acknowledgement failed:", error);
    }
}

function redirectFromNotificationMessage(message, port) {
    if (!message || message.type !== "notification-click" || !message.url) {
        return;
    }

    try {
        const targetUrl = new URL(message.url, window.location.href);
        if (targetUrl.origin !== window.location.origin) {
            return;
        }

        acknowledgeNotificationMessage(port);

        const currentUrl = new URL(window.location.href);
        if (targetUrl.pathname === currentUrl.pathname && targetUrl.search === currentUrl.search) {
            if (targetUrl.hash && targetUrl.hash !== currentUrl.hash) {
                window.location.hash = targetUrl.hash;
            }
            return;
        }

        if (targetUrl.href !== currentUrl.href) {
            window.location.assign(targetUrl.href);
        }
    } catch (error) {
        console.warn("[FCM] Invalid notification redirect URL:", error);
    }
}

if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", event => {
        redirectFromNotificationMessage(event.data, event.ports?.[0]);
    });
}

function getStoredAlertKeys() {
    try {
        const storedKeys = JSON.parse(localStorage.getItem(FLOOD_ALERT_DEDUPE_STORAGE_KEY) || "[]");
        return Array.isArray(storedKeys) ? storedKeys : [];
    } catch (error) {
        console.warn("Unable to read stored alert keys:", error);
        return [];
    }
}

function saveAlertKey(key) {
    const dedupeKeys = getStoredAlertKeys();
    if (!dedupeKeys.includes(key)) {
        dedupeKeys.push(key);
    }

    const recentKeys = dedupeKeys.slice(-120);
    alertState.deduplicatedAlertKeys = recentKeys;
    localStorage.setItem(FLOOD_ALERT_DEDUPE_STORAGE_KEY, JSON.stringify(recentKeys));
}

function isDangerousWeatherCode(code) {
    return DANGEROUS_WEATHER_CODES.includes(Number(code));
}

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

function renderSavedLocationPins() {
    savedLocationLayerGroup.clearLayers();

    getSavedLocationsList().forEach(location => {
        const latitude = Number(location.lat);
        const longitude = Number(location.lng);
        const radius = Number(location.radius);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(radius)) {
            return;
        }

        const point = L.latLng(latitude, longitude);
        const marker = L.marker(point, { title: location.label || "Saved location" });
        marker.bindPopup(`
            <div class="popup-title">${location.label || "Saved location"}</div>
            <div class="popup-risk"><strong>Source:</strong> ${location.source === "gps" ? "GPS" : "Manual pin"}</div>
            <div class="popup-risk"><strong>Radius:</strong> ${radius} m</div>
        `);
        marker.on("click", () => map.setView(point, Math.max(map.getZoom(), 15)));

        L.circle(point, {
            radius,
            color: "#0f766e",
            fillColor: "#2dd4bf",
            fillOpacity: 0.08,
            weight: 1
        }).addTo(savedLocationLayerGroup);
        marker.addTo(savedLocationLayerGroup);
    });
}

function focusSavedLocationFromQuery() {
    const locationId = new URLSearchParams(window.location.search).get("location");
    if (!locationId) {
        return;
    }

    const location = getSavedLocationsList().find(item => item.id === locationId);
    if (!location || !Number.isFinite(Number(location.lat)) || !Number.isFinite(Number(location.lng))) {
        return;
    }

    const point = L.latLng(Number(location.lat), Number(location.lng));
    map.setView(point, 16);
    savedLocationLayerGroup.eachLayer(layer => {
        if (layer instanceof L.Marker && layer.getLatLng().equals(point)) {
            layer.openPopup();
        }
    });
}

function getAlertWeatherLabel(code) {
    return IMMEDIATE_ALERT_WEATHER_CODES[Number(code)] || "Hazardous weather";
}

function getCurrentDangerousWeatherCode(weatherData) {
    if (!weatherData || !weatherData.current || !weatherData.hourly || !Array.isArray(weatherData.hourly.time)) {
        return null;
    }

    const currentCode = Number(weatherData.current.weather_code ?? -1);
    if (isDangerousWeatherCode(currentCode)) {
        return currentCode;
    }

    const currentTime = weatherData.current.time || "";
    const currentHourIndex = weatherData.hourly.time.findIndex(time => String(time).slice(0, 13) === String(currentTime).slice(0, 13));
    const startIndex = currentHourIndex >= 0 ? currentHourIndex : 0;

    for (let index = startIndex; index < Math.min(weatherData.hourly.time.length, startIndex + 4); index += 1) {
        const hourlyCode = Number(weatherData.hourly.weather_code[index] ?? -1);
        if (isDangerousWeatherCode(hourlyCode)) {
            return hourlyCode;
        }
    }

    return null;
}

function buildAlertKey(weatherCode, category, location, hourKey) {
    if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
        return `${Number(weatherCode)}-${Number(category)}-unknown-${hourKey}`;
    }

    return `${Number(weatherCode)}-${Number(category)}-${location.lat.toFixed(4)}-${location.lng.toFixed(4)}-${hourKey}`;
}

function getTestAlertKeys() {
    try {
        const storedKeys = JSON.parse(localStorage.getItem(TEST_ALERT_DEDUPE_STORAGE_KEY) || "[]");
        return Array.isArray(storedKeys) ? storedKeys : [];
    } catch (error) {
        console.warn("[TEST] Unable to read test alert keys:", error);
        return [];
    }
}

function saveTestAlertKey(key) {
    const recentKeys = [...getTestAlertKeys(), key].slice(-120);
    localStorage.setItem(TEST_ALERT_DEDUPE_STORAGE_KEY, JSON.stringify(recentKeys));
}

function clearTestScenarioKeys(scenarios) {
    const keysToClear = new Set(scenarios.map(scenario => evaluateFloodAlert({ ...scenario, mode: "test" }).alertKey));
    const remainingKeys = getTestAlertKeys().filter(key => !keysToClear.has(key));
    localStorage.setItem(TEST_ALERT_DEDUPE_STORAGE_KEY, JSON.stringify(remainingKeys));
}

function evaluateFloodAlert({ floodRiskCategory, radiusAffected, weatherCode, mode = "production", location, timeKey }) {
    const category = Number(floodRiskCategory);
    const code = Number(weatherCode);
    const affected = radiusAffected === true;
    const thresholdMet = (category === 4 || category === 5) && affected && isDangerousWeatherCode(code);
    const categoryName = riskNames[category] || "Unknown";
    const weatherLabel = getAlertWeatherLabel(code);
    const effectiveTimeKey = timeKey || (mode === "test"
        ? Math.floor(Date.now() / TEST_ALERT_COOLDOWN_MS)
        : new Date().toISOString().slice(0, 13));
    const testLocationKey = location?.id || (location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))
        ? `${Number(location.lat).toFixed(4)}-${Number(location.lng).toFixed(4)}`
        : "unknown");
    const alertKey = mode === "test"
        ? `test-${code}-${category}-${affected}-${testLocationKey}-${effectiveTimeKey}`
        : buildAlertKey(code, category, location, effectiveTimeKey);
    const knownKeys = mode === "test" ? getTestAlertKeys() : getStoredAlertKeys();

    return {
        category,
        categoryName,
        code,
        weatherLabel,
        radiusAffected: affected,
        thresholdMet,
        alertKey,
        duplicate: thresholdMet && knownKeys.includes(alertKey)
    };
}

function rememberEvaluatedAlert(result, mode = "production") {
    if (mode === "test") {
        saveTestAlertKey(result.alertKey);
    } else {
        saveAlertKey(result.alertKey);
    }
}

if (window.isSecureContext && "serviceWorker" in navigator) {
    notificationRegistration = navigator.serviceWorker.register("firebase-messaging-sw.js").then(registration => {
        console.log("[FCM] Service worker registered");
        return registration;
    }).catch(error => {
        console.warn("[FCM] Service worker registration failed:", error);
        return null;
    });
} else {
    console.info("[FCM] Service worker not registered because the page is not running in a secure context.");
}

const weatherElements = {
    panel: document.getElementById("weather-panel"),
    toggle: document.getElementById("weather-toggle"),
    toggleIcon: document.getElementById("weather-toggle-icon"),
    summaryTemperature: document.getElementById("weather-summary-temperature"),
    icon: document.getElementById("weather-icon"),
    loading: document.getElementById("weather-loading"),
    content: document.getElementById("weather-content"),
    error: document.getElementById("weather-error"),
    condition: document.getElementById("weather-condition"),
    temperature: document.getElementById("weather-temperature"),
    humidity: document.getElementById("weather-humidity"),
    rainfall: document.getElementById("weather-rainfall"),
    rainProbability: document.getElementById("weather-rain-probability"),
    wind: document.getElementById("weather-wind"),
    highLow: document.getElementById("weather-high-low"),
    updated: document.getElementById("weather-updated"),
    warning: document.getElementById("weather-warning"),
    forecast: document.getElementById("weather-forecast")
};

const floodAlertButton = document.getElementById("enable-flood-alerts");
const sendTestFloodAlertButton = document.getElementById("send-test-flood-alert");
const notificationStatus = document.getElementById("notification-status");
const notificationSettingsToggle = document.getElementById("notification-settings-toggle");
const notificationSettingsPanel = document.getElementById("notification-settings");

function toggleNotificationSettings() {
    if (!notificationSettingsToggle || !notificationSettingsPanel) {
        return;
    }

    const isHidden = notificationSettingsPanel.hidden;
    notificationSettingsPanel.hidden = !isHidden;
    notificationSettingsToggle.setAttribute("aria-expanded", String(isHidden));
}

if (notificationSettingsToggle) {
    notificationSettingsToggle.addEventListener("click", toggleNotificationSettings);
}

if (window.location.hash === "#notification-settings") {
    toggleNotificationSettings();
}

function updateFloodAlertButton() {
    if (!floodAlertButton) {
        return;
    }

    if (!window.isSecureContext) {
        floodAlertButton.textContent = "Notifications need HTTPS";
        floodAlertButton.disabled = true;
        return;
    }

    if (!("Notification" in window)) {
        floodAlertButton.textContent = "Notifications unavailable";
        floodAlertButton.disabled = true;
        return;
    }

    if (Notification.permission === "granted") {
        floodAlertButton.textContent = floodAlertsEnabled ? "Disable Flood Alerts" : "Enable Flood Alerts";
        floodAlertButton.disabled = false;
        floodAlertButton.setAttribute("aria-pressed", String(floodAlertsEnabled));
        notificationStatus.textContent = floodAlertsEnabled
            ? "Notifications enabled"
            : "Notifications disabled";
    } else if (Notification.permission === "denied") {
        floodAlertButton.textContent = "Flood Alerts Blocked";
        floodAlertButton.disabled = true;
        notificationStatus.textContent = "Notification permission denied";
    } else {
        floodAlertButton.textContent = "Enable Flood Alerts";
        floodAlertButton.disabled = false;
    }

    if (sendTestFloodAlertButton) {
        const showTestButton = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.hostname.includes("localhost") || window.location.hostname.includes("127.0.0.1");
        sendTestFloodAlertButton.hidden = !showTestButton;
        sendTestFloodAlertButton.disabled = Notification.permission !== "granted";
    }
}

if (floodAlertButton) {
    floodAlertButton.addEventListener("click", async () => {
        if (!window.isSecureContext || !("Notification" in window)) {
            updateFloodAlertButton();
            return;
        }

        try {
            if (Notification.permission === "granted") {
                floodAlertsEnabled = !floodAlertsEnabled;
                localStorage.setItem(FLOOD_ALERTS_ENABLED_STORAGE_KEY, String(floodAlertsEnabled));
                alertState.lastNotificationKey = "";
                updateFloodAlertButton();
                notificationStatus.textContent = floodAlertsEnabled
                    ? "Notifications enabled"
                    : "Notifications disabled";
                if (floodAlertsEnabled && latestWeatherData) {
                    checkAndSendFloodAlert();
                }
                return;
            }

            const permission = await Notification.requestPermission();
            console.info("[FCM] Notification permission:", permission);
            if (permission === "granted") {
                floodAlertsEnabled = true;
                localStorage.setItem(FLOOD_ALERTS_ENABLED_STORAGE_KEY, "true");
                window.dispatchEvent(new Event("fcm-permission-granted"));
            }
            updateFloodAlertButton();

            if (permission === "granted") {
                notificationStatus.textContent = "Notifications enabled";
                if (latestWeatherData) {
                    checkAndSendFloodAlert();
                }
            } else if (permission === "default") {
                notificationStatus.textContent = "Choose Allow when your browser asks for notifications.";
            } else if (permission === "denied") {
                notificationStatus.textContent = "Notification permission denied";
            }
        } catch (error) {
            console.error("Notification permission request failed:", error);
            notificationStatus.textContent = "Notifications could not be enabled. Check browser permissions and try again.";
        }
    });
    updateFloodAlertButton();
}

if (sendTestFloodAlertButton) {
    sendTestFloodAlertButton.addEventListener("click", async () => {
        if (!window.isSecureContext || !("Notification" in window) || Notification.permission !== "granted") {
            notificationStatus.textContent = "Notification permission is required before sending a test alert.";
            return;
        }

        await showFloodNotification("⚠️ Test Flood Alert", {
            body: "This is a test notification to confirm Firebase and browser notifications are working.",
            tag: "kuantan-flood-test-alert"
        });
        notificationStatus.textContent = "Test alert sent";
    });
}

async function showFloodNotification(title, options) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
        return false;
    }

    try {
        const registration = notificationRegistration
            ? await notificationRegistration
            : null;
        const targetUrl = registration?.scope || new URL(".", window.location.href).href;
        const notificationOptions = {
            ...options,
            data: {
                ...(options?.data || {}),
                url: options?.data?.url || targetUrl
            }
        };

        if (registration) {
            await registration.showNotification(title, notificationOptions);
        } else {
            new Notification(title, notificationOptions);
        }
        return true;
    } catch (error) {
        console.error("Flood notification failed:", error);
        return false;
    }
}

const testModePanel = document.getElementById("flood-alert-test-panel");
const testModeLauncher = document.getElementById("test-mode-launcher");
const testWidgetContent = document.getElementById("test-widget-content");
const advancedTestPanel = document.getElementById("advanced-test-panel");
const toggleAdvancedTestsButton = document.getElementById("toggle-advanced-tests");
const testThresholdStatus = document.getElementById("test-threshold-status");
const testLog = document.getElementById("test-log");
const testIntervalInput = document.getElementById("test-interval-seconds");
let testRunActive = false;

function toggleTestWidget() {
    if (!testModePanel || !testWidgetContent || !testModeLauncher) {
        return;
    }

    const isHidden = testModePanel.hidden;
    testModePanel.hidden = !isHidden;
    testModeLauncher.setAttribute("aria-expanded", String(!isHidden));
    testModeLauncher.setAttribute("aria-label", isHidden ? "Hide test mode panel" : "Open test mode panel");
    testWidgetContent.setAttribute("aria-hidden", String(isHidden));
}

function toggleAdvancedTests() {
    if (!advancedTestPanel || !toggleAdvancedTestsButton) {
        return;
    }

    const isHidden = advancedTestPanel.hidden;
    advancedTestPanel.hidden = !isHidden;
    toggleAdvancedTestsButton.setAttribute("aria-expanded", String(!isHidden));
    toggleAdvancedTestsButton.textContent = isHidden ? "Advanced test scenarios ▴" : "Advanced test scenarios ▾";
}

if (testModeLauncher) {
    testModeLauncher.addEventListener("click", toggleTestWidget);
}

if (toggleAdvancedTestsButton) {
    toggleAdvancedTestsButton.addEventListener("click", toggleAdvancedTests);
}

function addTestLog(message, status = "") {
    if (!testLog) {
        return;
    }

    const timestamp = new Intl.DateTimeFormat("en-MY", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: "Asia/Kuala_Lumpur"
    }).format(new Date());
    const item = document.createElement("li");
    item.className = status ? `test-log-${status}` : "";
    item.textContent = `[${timestamp}] ${message}`;
    testLog.prepend(item);
}

function getFloodRiskForLocation(location, radius) {
    let highestRisk = 0;
    let affectedFeatures = 0;

    if (!location || !floodLayer || !radius) {
        return { highestRisk, affectedFeatures };
    }

    floodLayer.eachLayer(layer => {
        if (featureIntersectsRadius(layer.feature, location, radius)) {
            affectedFeatures += 1;
            highestRisk = Math.max(highestRisk, getRiskLevel(layer.feature));
        }
    });

    return { highestRisk, affectedFeatures };
}

function getCurrentTestLocationContext() {
    const savedLocations = getSavedLocationsList();
    const latestSavedLocation = savedLocations[savedLocations.length - 1];

    if (savedLocation || latestSavedLocation) {
        const location = savedLocation || latestSavedLocation;
        const storedRadius = latestSavedLocation && Number.isFinite(Number(latestSavedLocation.radius))
            ? Number(latestSavedLocation.radius)
            : getActiveRadius();
        return {
            location,
            radius: storedRadius,
            radiusAffected: false,
            floodRiskCategory: 0,
            source: latestSavedLocation?.source || "saved-location"
        };
    }

    if (userLocationMarker && userLocationMarker.getLatLng) {
        const gpsPoint = userLocationMarker.getLatLng();
        if (gpsPoint && Number.isFinite(gpsPoint.lat) && Number.isFinite(gpsPoint.lng)) {
            return {
                location: { lat: gpsPoint.lat, lng: gpsPoint.lng },
                radius: Number(gpsRadiusSelect?.value || 0),
                radiusAffected: false,
                floodRiskCategory: 0,
                source: "gps-location"
            };
        }
    }

    return {
        location: null,
        radius: 0,
        radiusAffected: false,
        floodRiskCategory: 0,
        source: "none"
    };
}

function getSelectedTestScenario(overrides = {}) {
    const selectedWeather = document.getElementById("test-weather-code");
    const context = getCurrentTestLocationContext();
    const radius = Number(context.radius || getActiveRadius());
    const { highestRisk, affectedFeatures } = getFloodRiskForLocation(context.location, radius);

    const scenario = {
        floodRiskCategory: Number(overrides.floodRiskCategory ?? highestRisk ?? 0),
        radiusAffected: overrides.radiusAffected ?? affectedFeatures > 0,
        weatherCode: Number(overrides.weatherCode ?? selectedWeather?.value ?? 65),
        location: context.location
    };

    if (!context.location) {
        scenario.floodRiskCategory = 0;
        scenario.radiusAffected = false;
    }

    return scenario;
}

function getTestScenariosForAllSavedLocations(overrides = {}) {
    const savedLocations = getSavedLocationsList();

    if (!savedLocations.length) {
        const fallbackScenario = getSelectedTestScenario(overrides);
        return fallbackScenario.location ? [fallbackScenario] : [];
    }

    return savedLocations.map(location => {
        const radius = Number(location.radius || 0);
        const { highestRisk, affectedFeatures } = getFloodRiskForLocation(location, radius);

        return {
            floodRiskCategory: Number(overrides.floodRiskCategory ?? highestRisk ?? 0),
            radiusAffected: overrides.radiusAffected ?? affectedFeatures > 0,
            weatherCode: Number(overrides.weatherCode ?? document.getElementById("test-weather-code")?.value ?? 65),
            location
        };
    });
}

function updateTestThresholdStatus() {
    if (!testThresholdStatus) {
        return;
    }

    const context = getCurrentTestLocationContext();
    if (!context.location) {
        testThresholdStatus.textContent = "⚠️ Save a location or enable GPS before testing alerts.";
        testThresholdStatus.className = "test-threshold-status is-not-met";
        return;
    }

    const evaluations = getTestScenariosForAllSavedLocations().map(scenario =>
        evaluateFloodAlert({ ...scenario, mode: "test" })
    );
    const eligibleCount = evaluations.filter(evaluation => evaluation.thresholdMet).length;
    testThresholdStatus.textContent = eligibleCount
        ? `✅ ${eligibleCount}/${evaluations.length} saved location${evaluations.length === 1 ? "" : "s"} meet the alert threshold`
        : `❌ 0/${evaluations.length} saved locations meet the alert threshold`;
    testThresholdStatus.className = `test-threshold-status ${eligibleCount ? "is-met" : "is-not-met"}`;
}

async function runTestScenario(scenario, label = "Test alert") {
    const context = getCurrentTestLocationContext();
    if (!context.location) {
        addTestLog("⚠️ Test blocked: save a location or enable GPS before running test alerts.", "error");
        return { sent: false, thresholdMet: false, duplicate: false, alertKey: "", category: 0, categoryName: "Unknown", code: Number(scenario.weatherCode), weatherLabel: getAlertWeatherLabel(Number(scenario.weatherCode)) };
    }

    const evaluation = evaluateFloodAlert({ ...scenario, mode: "test" });
    const locationLabel = scenario.location?.label || "active location";
    addTestLog(`${label} started`);
    addTestLog(`Location: ${locationLabel}`);
    addTestLog(`Flood risk: Category ${evaluation.category}`);
    addTestLog(`Radius affected: ${evaluation.radiusAffected ? "YES" : "NO"}`);
    addTestLog(`Weather code: ${evaluation.code} - ${evaluation.weatherLabel}`);

    if (!evaluation.thresholdMet) {
        addTestLog("❌ CONDITION NOT MET", "not-met");
        return { ...evaluation, sent: false };
    }

    addTestLog("✅ CONDITION MET", "met");
    if (evaluation.duplicate) {
        addTestLog("🛑 Duplicate notification blocked", "duplicate");
        return { ...evaluation, sent: false };
    }

    if (!("Notification" in window) || Notification.permission !== "granted") {
        addTestLog("⚠️ FCM ERROR: grant notification permission first", "error");
        return { ...evaluation, sent: false };
    }

    const title = evaluation.category === 4
        ? "🧪 TEST — High Flood Risk Alert"
        : "🧪 TEST — Very High Flood Risk Alert";
    const body = `TEST ALERT: ${evaluation.weatherLabel} (WMO ${evaluation.code}) simulated for ${locationLabel} in a Category ${evaluation.category} ${evaluation.categoryName} Flood Risk area affecting the saved ${scenario.location?.radius || "selected"} m radius.`;

    addTestLog("🔔 FCM notification requested");
    console.log("[FCM] Sending test notification:", title);
    const notificationSent = await showFloodNotification(title, {
        body,
        tag: `kuantan-flood-test-${evaluation.category}-${evaluation.code}`
    });

    if (!notificationSent) {
        addTestLog("⚠️ FCM ERROR: notification could not be displayed", "error");
        return { ...evaluation, sent: false };
    }

    rememberEvaluatedAlert(evaluation, "test");
    addTestLog("🔔 NOTIFICATION SENT", "sent");
    addTestLog("Notification sent successfully", "sent");
    return { ...evaluation, sent: true };
}

function getTestIntervalMs() {
    const seconds = Math.max(1, Math.min(120, Number(testIntervalInput?.value) || 10));
    if (testIntervalInput) {
        testIntervalInput.value = String(seconds);
    }
    return seconds * 1000;
}

function waitForTestInterval() {
    return new Promise(resolve => setTimeout(resolve, getTestIntervalMs()));
}

async function runTestSequence(sequence, label) {
    if (testRunActive) {
        addTestLog("⚠️ Another test sequence is already running", "error");
        return;
    }

    if (!sequence.length) {
        addTestLog("⚠️ Test blocked: save at least one location or enable GPS before running test alerts.", "error");
        return;
    }

    testRunActive = true;
    clearTestScenarioKeys(sequence);
    addTestLog(`${label} started`);
    try {
        for (let index = 0; index < sequence.length; index += 1) {
            await runTestScenario(sequence[index], `${label} ${index + 1}/${sequence.length}`);
            if (index < sequence.length - 1) {
                addTestLog(`Waiting ${getTestIntervalMs() / 1000} seconds...`);
                await waitForTestInterval();
            }
        }
        addTestLog(`${label} complete`, "sent");
    } finally {
        testRunActive = false;
    }
}

function setupTestMode() {
    if (!testModePanel) {
        return;
    }

    testModePanel.hidden = !TEST_MODE;
    if (!TEST_MODE) {
        return;
    }

    document.getElementById("test-weather-code")?.addEventListener("change", updateTestThresholdStatus);

    document.getElementById("run-test-alert")?.addEventListener("click", () => {
        runTestSequence(getTestScenariosForAllSavedLocations(), "Saved location test");
    });
    document.getElementById("run-all-weather-tests")?.addEventListener("click", () => {
        runTestSequence(
            [65, 82, 95, 96, 99].flatMap(weatherCode => getTestScenariosForAllSavedLocations({ weatherCode })),
            "All dangerous weather codes"
        );
    });
    document.getElementById("run-duplicate-test")?.addEventListener("click", async () => {
        const scenario = getSelectedTestScenario({ weatherCode: 65 });
        clearTestScenarioKeys([scenario]);
        addTestLog("Duplicate prevention test started");
        const first = await runTestScenario(scenario, "First attempt");
        const second = await runTestScenario(scenario, "Second attempt");
        addTestLog(first.sent ? "✅ Notification sent" : "⚠️ First attempt did not send", first.sent ? "sent" : "error");
        addTestLog(!second.sent && second.duplicate ? "🛑 Duplicate notification blocked" : "⚠️ Duplicate test failed", second.duplicate ? "duplicate" : "error");
    });
    document.getElementById("run-risk-escalation-test")?.addEventListener("click", () => {
        runTestSequence([
            getSelectedTestScenario({ weatherCode: 65 }),
            getSelectedTestScenario({ weatherCode: 65 }),
            getSelectedTestScenario({ weatherCode: 65 })
        ], "Risk escalation test");
    });
    document.getElementById("run-weather-escalation-test")?.addEventListener("click", () => {
        runTestSequence([65, 95, 99, 99].map(weatherCode => getSelectedTestScenario({ weatherCode })), "Weather escalation test");
    });

    updateTestThresholdStatus();
}

setupTestMode();

weatherElements.toggle.addEventListener("click", () => {
    const isExpanded = weatherElements.toggle.getAttribute("aria-expanded") === "true";
    weatherElements.toggle.setAttribute("aria-expanded", String(!isExpanded));
    document.getElementById("weather-details-content").setAttribute("aria-hidden", String(isExpanded));
    weatherElements.panel.classList.toggle("is-expanded", !isExpanded);
    weatherElements.toggleIcon.textContent = isExpanded ? "⌄" : "⌃";
});

const floodRiskToggle = document.getElementById("flood-risk-toggle");
const floodRiskContent = document.getElementById("flood-risk-content");
const floodRiskToggleIcon = document.getElementById("flood-risk-toggle-icon");

floodRiskToggle.addEventListener("click", () => {
    const isExpanded = floodRiskToggle.getAttribute("aria-expanded") === "true";
    floodRiskToggle.setAttribute("aria-expanded", String(!isExpanded));
    floodRiskContent.setAttribute("aria-hidden", String(isExpanded));
    floodRiskContent.parentElement.classList.toggle("is-expanded", !isExpanded);
    floodRiskToggleIcon.textContent = isExpanded ? "⌄" : "⌃";
});

const mapToolsToggle = document.getElementById("map-tools-toggle");
const mapToolsContent = document.getElementById("map-tools-content");
const mapToolsToggleIcon = document.getElementById("map-tools-toggle-icon");

mapToolsToggle.addEventListener("click", () => {
    const isExpanded = mapToolsToggle.getAttribute("aria-expanded") === "true";
    mapToolsToggle.setAttribute("aria-expanded", String(!isExpanded));
    mapToolsContent.setAttribute("aria-hidden", String(isExpanded));
    mapToolsContent.parentElement.classList.toggle("is-expanded", !isExpanded);
    mapToolsToggleIcon.textContent = isExpanded ? "⌄" : "⌃";
});

let latestWeatherData;

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

function formatWeatherTime(time) {
    return new Intl.DateTimeFormat("en-MY", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Kuala_Lumpur"
    }).format(new Date(time));
}

function renderWeatherForecast(weatherData) {
    if (!weatherData || !weatherData.daily || !Array.isArray(weatherData.daily.time)) {
        weatherElements.forecast.innerHTML = "";
        return;
    }

    const times = weatherData.daily.time.slice(1, 4);
    if (!times.length) {
        weatherElements.forecast.innerHTML = "";
        return;
    }

    const maxTemps = weatherData.daily.temperature_2m_max.slice(1, 4);
    const minTemps = weatherData.daily.temperature_2m_min.slice(1, 4);
    const weatherCodes = weatherData.daily.weather_code.slice(1, 4);

    weatherElements.forecast.innerHTML = times.map((date, index) => {
        const details = weatherCodeDetails[weatherCodes[index]] || ["Forecast unavailable", "🌡️"];
        const summary = details[0];
        const icon = details[1];
        const dayLabel = index === 0
            ? "Tomorrow"
            : new Intl.DateTimeFormat("en-MY", { weekday: "short", timeZone: "Asia/Kuala_Lumpur" }).format(new Date(date));

        return `
            <div class="forecast-item">
                <span class="forecast-day">${dayLabel}</span>
                <span class="forecast-condition">${icon} ${summary}</span>
                <span class="forecast-temp">${maxTemps[index] === null ? "--" : `${Math.round(maxTemps[index])}°`} / ${minTemps[index] === null ? "--" : `${Math.round(minTemps[index])}°`}</span>
            </div>
        `;
    }).join("");
}

function getMetWeatherIcon(summary) {
    const text = String(summary || "").toLowerCase();

    if (text.includes("thunder") || text.includes("storm") || text.includes("petir")) {
        return "⛈️";
    }
    if (text.includes("rain") || text.includes("shower") || text.includes("hujan")) {
        return "🌧️";
    }
    if (text.includes("cloud") || text.includes("jerebu")) {
        return "☁️";
    }

    return "☀️";
}

function getHighestFloodRisk() {
    let highestRisk = 0;

    if (floodLayer) {
        floodLayer.eachLayer(layer => {
            highestRisk = Math.max(highestRisk, getRiskLevel(layer.feature));
        });
    }

    return highestRisk;
}

function getHighestAnalysisRisk() {
    if (!savedLocation || !floodLayer) {
        return getHighestFloodRisk();
    }

    const radius = getActiveRadius();
    let highestRisk = 0;

    floodLayer.eachLayer(layer => {
        if (featureIntersectsRadius(layer.feature, savedLocation, radius)) {
            highestRisk = Math.max(highestRisk, getRiskLevel(layer.feature));
        }
    });

    return highestRisk;
}

function checkAndSendFloodAlert(weatherData = latestWeatherData) {
    const savedLocations = getSavedLocationsList();
    if (!weatherData || !floodLayer || !savedLocations.length) {
        console.info("[ALERT] Missing location, flood layer, or weather data.");
        return false;
    }

    const dangerousWeatherCode = getCurrentDangerousWeatherCode(weatherData);
    console.log("[WEATHER] Weather code:", dangerousWeatherCode ?? "No dangerous code");

    if (!dangerousWeatherCode) {
        console.info("[ALERT] Dangerous weather condition: No");
        return false;
    }

    const hourKey = (weatherData.current && weatherData.current.time)
        ? String(weatherData.current.time).slice(0, 13)
        : new Date().toISOString().slice(0, 13);
    let alertSent = false;

    savedLocations.forEach(location => {
        const center = L.latLng(Number(location.lat), Number(location.lng));
        const radius = Number(location.radius || 0);
        if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng) || !radius) {
            return;
        }

        let highestRisk = 0;
        floodLayer.eachLayer(layer => {
            if (featureIntersectsRadius(layer.feature, center, radius)) {
                highestRisk = Math.max(highestRisk, getRiskLevel(layer.feature));
            }
        });

        const radiusAffected = highestRisk >= HIGH_FLOOD_RISK_THRESHOLD;
        const evaluation = evaluateFloodAlert({
            floodRiskCategory: highestRisk,
            radiusAffected,
            weatherCode: dangerousWeatherCode,
            location: center,
            timeKey: hourKey
        });

        console.log("[FLOOD] Saved location:", location.id, "Risk:", highestRisk || "No mapped risk", "Affected:", radiusAffected ? "Yes" : "No");

        if (!evaluation.thresholdMet || evaluation.duplicate) {
            if (evaluation.duplicate) {
                console.info("[FCM] Duplicate alert prevented:", evaluation.alertKey);
            }
            return;
        }

        const title = evaluation.category === 4 ? "⚠️ High Flood Risk Alert" : "🚨 Very High Flood Risk Alert";
        const locationLabel = location.label || "Saved location";
        const body = `${evaluation.weatherLabel} detected near ${locationLabel}. Your ${radius} m radius overlaps a ${evaluation.categoryName} Flood Risk (Category ${evaluation.category}) area. Please monitor local conditions and plan travel carefully.`;

        rememberEvaluatedAlert(evaluation);
        alertState.lastNotificationKey = evaluation.alertKey;
        alertSent = true;

        if (floodAlertsEnabled && "Notification" in window && Notification.permission === "granted") {
            showFloodNotification(title, {
                body,
                tag: `kuantan-flood-risk-${evaluation.category}-${evaluation.code}-${location.id}`
            });
        }
    });

    return alertSent;
}

function updateFloodWeatherWarning(weatherData) {
    const highestRisk = getHighestAnalysisRisk();
    const rainfall = Number(weatherData.current.precipitation || 0);
    if (!weatherData.rainDataAvailable) {
        weatherElements.warning.hidden = true;
        return;
    }
    const rainStatus = getRainStatus(weatherData);
    const warningApplies = highestRisk >= HIGH_FLOOD_RISK_THRESHOLD &&
        (rainStatus.heavyRain || rainStatus.continuousRain || rainStatus.thunderstorm);

    weatherElements.warning.hidden = !warningApplies;
    if (warningApplies) {
        weatherElements.warning.textContent =
            `Warning: ${riskNames[highestRisk]} flood-risk area with hazardous weather ` +
            `(${rainfall} mm current rain). ` +
            "Review local guidance before using this as an operational alert.";
    } else {
        weatherElements.warning.hidden = true;
    }

    if (floodAlertsEnabled) {
        checkAndSendFloodAlert(weatherData);
    }
}

function getRainStatus(weatherData) {
    if (!weatherData.rainDataAvailable) {
        return {
            noRain: false,
            heavyRain: false,
            continuousRain: false,
            thunderstorm: false,
            currentRainfall: null,
            continuousRainHours: 0
        };
    }

    const current = weatherData.current;
    const hourly = weatherData.hourly;
    const currentRainfall = Number(current.precipitation || 0);
    const thunderstorm = [95, 96, 99].includes(Number(current.weather_code));
    const currentHourIndex = hourly.time.findIndex(time => time.slice(0, 13) === current.time.slice(0, 13));
    const currentProbability = currentHourIndex >= 0
        ? Number(hourly.precipitation_probability[currentHourIndex] || 0)
        : 0;
    const noRain = currentRainfall === 0 && currentProbability === 0;
    let continuousRainHours = 0;

    for (let index = Math.max(0, currentHourIndex); index < hourly.time.length; index += 1) {
        if (Number(hourly.precipitation_probability[index] || 0) >= CONTINUOUS_RAIN_PROBABILITY_THRESHOLD) {
            continuousRainHours += 1;
        } else {
            break;
        }
    }

    return {
        noRain,
        heavyRain: currentRainfall >= HEAVY_RAIN_THRESHOLD_MM,
        continuousRain: continuousRainHours >= CONTINUOUS_RAIN_HOURS,
        thunderstorm,
        currentRainfall,
        continuousRainHours
    };
}

function updateFloodStatus() {
    if (!savedLocation || !floodLayer || !latestWeatherData) {
        floodStatus.textContent = "Save a location to calculate flood status.";
        floodStatus.className = "flood-status";
        return;
    }

    const radius = getActiveRadius();
    let highestRisk = 0;

    floodLayer.eachLayer(layer => {
        if (featureIntersectsRadius(layer.feature, savedLocation, radius)) {
            highestRisk = Math.max(highestRisk, getRiskLevel(layer.feature));
        }
    });

    const rainStatus = getRainStatus(latestWeatherData);
    const highRiskArea = highestRisk >= HIGH_FLOOD_RISK_THRESHOLD;
    const rainIsDangerous = rainStatus.heavyRain || rainStatus.continuousRain;

    floodStatus.className = "flood-status";

    if (rainStatus.noRain) {
        floodStatus.textContent = "Flood status: Not flood-prone currently - no rain detected.";
        floodStatus.classList.add("status-safe");
    } else if (highRiskArea && rainIsDangerous) {
        floodStatus.textContent =
            `Flood status: FLOOD-PRONE - ${riskNames[highestRisk]} area with ` +
            `${rainStatus.heavyRain ? "heavy" : "continuous"} rain.`;
        floodStatus.classList.add("status-warning");
    } else if (highRiskArea) {
        floodStatus.textContent =
            `Flood status: High-risk area, but heavy or continuous rain is not detected currently.`;
        floodStatus.classList.add("status-warning");
    } else {
        floodStatus.textContent =
            `Flood status: Not flood-prone currently - highest mapped risk is ${riskNames[highestRisk] || "Unknown"}.`;
        floodStatus.classList.add("status-safe");
    }
}

async function loadWeather(latitude = KUANTAN_LOCATION.latitude, longitude = KUANTAN_LOCATION.longitude) {
    weatherElements.loading.hidden = false;
    weatherElements.content.hidden = true;
    weatherElements.error.hidden = true;

    const query = new URLSearchParams({
        latitude,
        longitude,
        current: "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
        hourly: "weather_code,precipitation_probability,precipitation",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        timezone: "Asia/Kuala_Lumpur",
        forecast_days: 8
    });

    try {
        const response = await fetch(`${WEATHER_API_URL}?${query}`);
        if (!response.ok) {
            throw new Error(`Weather request failed with status ${response.status}`);
        }

        const weatherData = await response.json();
        weatherData.rainDataAvailable = true;
        const current = weatherData.current;
        const hourly = weatherData.hourly;

        if (!current || !hourly || !Array.isArray(hourly.time)) {
            throw new Error("Weather response is missing required fields");
        }

        const details = weatherCodeDetails[current.weather_code] || ["Unknown conditions", "🌡️"];
        const currentHourIndex = hourly.time.findIndex(time => time.slice(0, 13) === current.time.slice(0, 13));
        const rainProbability = currentHourIndex >= 0
            ? hourly.precipitation_probability[currentHourIndex]
            : null;

        weatherElements.icon.textContent = details[1];
        weatherElements.summaryTemperature.textContent = `${Math.round(current.temperature_2m)}°C`;
        weatherElements.condition.textContent = details[0];
        weatherElements.temperature.textContent = `${current.temperature_2m} °C`;
        weatherElements.humidity.textContent = `${current.relative_humidity_2m}%`;
        weatherElements.rainfall.textContent = `${current.precipitation} mm`;
        weatherElements.rainProbability.textContent = rainProbability === null
            ? "Unavailable"
            : `${rainProbability}%`;
        weatherElements.wind.textContent = `${current.wind_speed_10m} km/h`;
        weatherElements.highLow.textContent = `${Math.round(weatherData.daily.temperature_2m_max[0])}°C / ${Math.round(weatherData.daily.temperature_2m_min[0])}°C`;
        weatherElements.updated.textContent = `Updated: ${formatWeatherTime(current.time)}`;
        weatherElements.loading.hidden = true;
        weatherElements.content.hidden = false;
        latestWeatherData = weatherData;
        renderWeatherForecast(weatherData);
        updateFloodWeatherWarning(weatherData);
        updateFloodStatus();
    } catch (error) {
        console.error("Weather data unavailable:", error);
        weatherElements.loading.hidden = true;
        weatherElements.content.hidden = true;
        weatherElements.error.hidden = false;
    }
}

loadWeather();

setInterval(() => {
    if (savedLocation && floodAlertsEnabled) {
        loadWeather(savedLocation.lat, savedLocation.lng);
    }
}, 5 * 60 * 1000);

// ------------------------------------------------------
// 5. LOCATION ANALYSIS
// ------------------------------------------------------

function selectLocation(latlng) {
    pendingLocation = latlng;

    if (locationMarker) {
        locationMarker.setLatLng(pendingLocation);
    } else {
        locationMarker = L.marker(pendingLocation).addTo(map);
    }

    const manualModeInput = document.querySelector("input[name='location-mode'][value='manual']");
    if (manualModeInput && !manualModeInput.checked) {
        manualModeInput.checked = true;
        updateLocationModeVisibility();
    }

    updateSaveLocationAvailability();
    locationStatus.textContent = "Location selected. Click Save This Location to analyse it.";
}

function onEachFloodFeature(feature, layer) {
    const risk = getRiskLevel(feature);
    const riskName = riskNames[risk] || "Unknown";

    const popupContent = `
        <div class="popup-title">
            Flood Risk Information
        </div>

        <div class="popup-risk">
            <strong>Risk Category:</strong> ${risk}
        </div>

        <div class="popup-risk">
            <strong>Risk Level:</strong> ${riskName}
        </div>
    `;

    layer.bindPopup(popupContent);

    layer.on("click", event => {
        selectLocation(event.latlng);
    });

    layer.on({
        mouseover: function (event) {
            const targetLayer = event.target;
            targetLayer.setStyle({
                weight: 2,
                color: "#000",
                fillOpacity: 0.8
            });
            targetLayer.bringToFront();
        },

        mouseout: function (event) {
            floodLayer.resetStyle(event.target);
        }
    });
}

// ------------------------------------------------------
// 6. LOAD GEOJSON
// ------------------------------------------------------

const saveLocationButton = document.getElementById("save-location");
const radiusSelect = document.getElementById("radius-select");
const gpsRadiusSelect = document.getElementById("gps-radius-select");
const floodLayerToggle = document.getElementById("flood-layer-toggle");
const locationStatus = document.getElementById("location-status");
const analysisResult = document.getElementById("analysis-result");
const floodStatus = document.getElementById("flood-status");
const gpsToggle = document.getElementById("gps-toggle");
const gpsStatus = document.getElementById("gps-status");
const gpsDetails = document.getElementById("gps-details");
const gpsLatitude = document.getElementById("gps-latitude");
const gpsLongitude = document.getElementById("gps-longitude");
const gpsAccuracy = document.getElementById("gps-accuracy");
const manualLocationSection = document.getElementById("manual-location-section");
const gpsLocationSection = document.getElementById("gps-location-section");
const savedLocationsSummary = document.getElementById("saved-locations-summary");

function getLocationMode() {
    const checked = document.querySelector("input[name='location-mode']:checked");
    return checked ? checked.value : "manual";
}

function getActiveRadius() {
    if (radiusCircle) {
        return radiusCircle.getRadius();
    }

    return Number((getLocationMode() === "gps" ? gpsRadiusSelect : radiusSelect)?.value || 0);
}

function updateSavedLocationsSummary() {
    if (!savedLocationsSummary) {
        return;
    }

    const count = getSavedLocationsList().length;
    savedLocationsSummary.innerHTML = `${count} / ${MAX_SAVED_LOCATIONS} saved locations · <a href="saved-locations.html">View saved locations</a>`;
}

function updateSaveLocationAvailability() {
    if (!saveLocationButton) {
        return;
    }

    const mode = getLocationMode();
    const hasCandidate = mode === "manual" ? Boolean(pendingLocation) : Boolean(userLocationMarker);
    const atCapacity = getSavedLocationsList().length >= MAX_SAVED_LOCATIONS;

    saveLocationButton.disabled = !hasCandidate || atCapacity;
    saveLocationButton.textContent = atCapacity
        ? `Saved locations full (${MAX_SAVED_LOCATIONS}/${MAX_SAVED_LOCATIONS})`
        : "Save This Location";
}

function updateLocationModeVisibility() {
    const mode = getLocationMode();

    if (manualLocationSection) {
        manualLocationSection.hidden = mode !== "manual";
    }

    if (gpsLocationSection) {
        gpsLocationSection.hidden = mode !== "gps";
    }

    updateSaveLocationAvailability();
}

function restoreLatestSavedLocation() {
    const savedLocations = getSavedLocationsList();
    const latest = savedLocations[savedLocations.length - 1];

    if (!latest || !Number.isFinite(Number(latest.lat)) || !Number.isFinite(Number(latest.lng))) {
        return;
    }

    savedLocation = L.latLng(Number(latest.lat), Number(latest.lng));
    radiusCircle = L.circle(savedLocation, {
        radius: Number(latest.radius) || 500,
        color: "#2563eb",
        fillColor: "#60a5fa",
        fillOpacity: 0.15,
        weight: 2
    }).addTo(map);

    locationStatus.textContent = `Latest saved location active (${latest.radius} m radius).`;
}

document.querySelectorAll("input[name='location-mode']").forEach(input => {
    input.addEventListener("change", updateLocationModeVisibility);
});

updateLocationModeVisibility();
updateSavedLocationsSummary();

function updateUserLocation(position) {
    const { latitude, longitude, accuracy } = position.coords;
    const userLatLng = L.latLng(latitude, longitude);

    gpsStatus.classList.remove("gps-status-error");
    gpsToggle.disabled = true;
    gpsToggle.textContent = "GPS Active";

    if (userLocationMarker) {
        userLocationMarker.setLatLng(userLatLng);
    } else {
        userLocationMarker = L.circleMarker(userLatLng, {
            radius: 8,
            color: "#ffffff",
            weight: 3,
            fillColor: "#2563eb",
            fillOpacity: 1
        }).addTo(map);
        userLocationMarker.bindTooltip("Your live location", { direction: "top" });
    }

    gpsLatitude.textContent = latitude.toFixed(6);
    gpsLongitude.textContent = longitude.toFixed(6);
    gpsAccuracy.textContent = `${Math.round(accuracy)} m`;
    gpsDetails.hidden = false;
    gpsStatus.textContent = "Live location updates active.";

    if (!hasCenteredOnUserLocation) {
        map.setView(userLatLng, Math.max(map.getZoom(), 13));
        hasCenteredOnUserLocation = true;
    }

    updateSaveLocationAvailability();
}

function handleUserLocationError(error) {
    const messages = {
        1: "Location permission was denied. Enable it in your browser settings to use GPS.",
        2: "Your location could not be determined. Check your device GPS or network.",
        3: "Location request timed out. Try again when GPS reception improves."
    };

    gpsStatus.textContent = messages[error.code] || "Unable to access your location. Try again.";
    gpsStatus.classList.add("gps-status-error");

    if (error.code === 1 && userLocationWatchId !== undefined) {
        navigator.geolocation.clearWatch(userLocationWatchId);
        userLocationWatchId = undefined;
    }

    gpsToggle.disabled = false;
    gpsToggle.textContent = "Try Again";
}

function startUserLocationTracking() {
    if (!navigator.geolocation) {
        gpsStatus.textContent = "Geolocation is not supported by this browser.";
        gpsStatus.classList.add("gps-status-error");
        return;
    }

    if (!window.isSecureContext) {
        gpsStatus.textContent = "GPS needs HTTPS or localhost. Open the deployed HTTPS site on your phone.";
        gpsStatus.classList.add("gps-status-error");
        return;
    }

    if (userLocationWatchId !== undefined) {
        return;
    }

    gpsToggle.disabled = true;
    gpsToggle.textContent = "Requesting GPS...";
    gpsStatus.classList.remove("gps-status-error");
    gpsStatus.textContent = "Requesting location permission...";

    userLocationWatchId = navigator.geolocation.watchPosition(
        updateUserLocation,
        handleUserLocationError,
        {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 15000
        }
    );
}

gpsToggle.addEventListener("click", startUserLocationTracking);

function updateFloodLayerVisibility() {
    if (!floodLayer) {
        return;
    }

    if (floodLayerToggle.checked) {
        if (!map.hasLayer(floodLayer)) {
            floodLayer.addTo(map);
        }
    } else if (map.hasLayer(floodLayer)) {
        floodLayer.remove();
    }
}

function distanceInMeters(first, second) {
    return map.distance(first, second);
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
        return distanceInMeters(point, start);
    }

    const position = Math.max(0, Math.min(1,
        ((target.x - first.x) * deltaX + (target.y - first.y) * deltaY) / segmentLengthSquared
    ));
    const closest = {
        lat: point.lat + (first.y + position * deltaY) / 6371000 * 180 / Math.PI,
        lng: point.lng + (first.x + position * deltaX) / (6371000 * Math.cos(point.lat * Math.PI / 180)) * 180 / Math.PI
    };

    return distanceInMeters(point, closest);
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
            const current = L.latLng(ring[pointIndex][1], ring[pointIndex][0]);
            const next = L.latLng(ring[(pointIndex + 1) % ring.length][1], ring[(pointIndex + 1) % ring.length][0]);

            if (distanceInMeters(center, current) <= radius || distanceToSegment(center, current, next) <= radius) {
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

function analyseFloodRisk() {
    if (!savedLocation || !floodLayer) {
        return;
    }

    const radius = getActiveRadius();
    let highestRisk = 0;
    let affectedFeatures = 0;

    floodLayer.eachLayer(layer => {
        if (featureIntersectsRadius(layer.feature, savedLocation, radius)) {
            affectedFeatures += 1;
            highestRisk = Math.max(highestRisk, getRiskLevel(layer.feature));
        }
    });

    if (highestRisk) {
        analysisResult.innerHTML = `
            <strong>Highest risk:</strong> ${riskNames[highestRisk]}<br>
            <strong>Areas found:</strong> ${affectedFeatures}
        `;
    } else {
        analysisResult.innerHTML = "No flood polygons found inside this radius.";
    }

    updateFloodStatus();
}

map.on("click", event => {
    selectLocation(event.latlng);
});

saveLocationButton.addEventListener("click", () => {
    const mode = getLocationMode();
    let candidateLatLng;
    let radius;
    let source;

    if (mode === "manual") {
        if (!pendingLocation) {
            return;
        }

        candidateLatLng = pendingLocation;
        radius = Number(radiusSelect.value);
        source = "manual";
    } else {
        if (!userLocationMarker) {
            gpsStatus.textContent = "Enable GPS before saving a GPS-based location.";
            gpsStatus.classList.add("gps-status-error");
            return;
        }

        candidateLatLng = userLocationMarker.getLatLng();
        radius = Number(gpsRadiusSelect.value);
        source = "gps";
    }

    const existingList = getSavedLocationsList();

    if (existingList.length >= MAX_SAVED_LOCATIONS) {
        locationStatus.textContent = `Maximum of ${MAX_SAVED_LOCATIONS} saved locations reached. Remove one from the Saved Locations page first.`;
        updateSaveLocationAvailability();
        return;
    }

    const entry = {
        id: `loc-${Date.now()}-${Math.round(Math.random() * 1000)}`,
        label: `Saved location ${existingList.length + 1}`,
        lat: candidateLatLng.lat,
        lng: candidateLatLng.lng,
        radius,
        source,
        savedAt: new Date().toISOString()
    };

    existingList.push(entry);
    setSavedLocationsList(existingList);
    updateSavedLocationsSummary();
    renderSavedLocationPins();
    updateTestThresholdStatus();

    savedLocation = L.latLng(candidateLatLng.lat, candidateLatLng.lng);

    if (radiusCircle) {
        radiusCircle.setLatLng(savedLocation).setRadius(radius);
    } else {
        radiusCircle = L.circle(savedLocation, {
            radius,
            color: "#2563eb",
            fillColor: "#60a5fa",
            fillOpacity: 0.15,
            weight: 2
        }).addTo(map);
    }

    locationStatus.textContent = `Location saved (${source === "gps" ? "GPS" : "manual"} · ${radius} m radius). ${existingList.length}/${MAX_SAVED_LOCATIONS} saved.`;
    updateSaveLocationAvailability();
    analyseFloodRisk();
    loadWeather(savedLocation.lat, savedLocation.lng);
});

radiusSelect.addEventListener("change", () => {
    if (getLocationMode() === "manual" && radiusCircle) {
        radiusCircle.setRadius(Number(radiusSelect.value));
        analyseFloodRisk();
    }
});

gpsRadiusSelect.addEventListener("change", () => {
    if (getLocationMode() === "gps" && radiusCircle) {
        radiusCircle.setRadius(Number(gpsRadiusSelect.value));
        analyseFloodRisk();
    }
});

floodLayerToggle.addEventListener("change", () => {
    updateFloodLayerVisibility();
});

fetch("new_fr_kuantan.geojson")
    .then(response => {
        if (!response.ok) {
            throw new Error("Unable to load new_fr_kuantan.geojson");
        }

        return response.json();
    })
    .then(data => {
        console.log("Flood GeoJSON loaded successfully.");
        if (!data || data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
            throw new Error("new_fr_kuantan.geojson must contain a GeoJSON FeatureCollection.");
        }

        console.log("Number of features:", data.features.length);

        floodLayer = L.geoJSON(data, {
            style: floodStyle,
            onEachFeature: onEachFloodFeature
        });

        updateFloodLayerVisibility();

        const bounds = floodLayer.getBounds();

        if (bounds.isValid()) {
            map.fitBounds(bounds, {
                padding: [20, 20]
            });
        } else {
            map.setView([3.8077, 103.3260], 11);
        }

        restoreLatestSavedLocation();
        renderSavedLocationPins();

        if (latestWeatherData) {
            updateFloodWeatherWarning(latestWeatherData);
        }

        updateTestThresholdStatus();

        if (savedLocation) {
            analyseFloodRisk();
        }

        if (savedLocation && Number.isFinite(savedLocation.lat) && Number.isFinite(savedLocation.lng)) {
            loadWeather(savedLocation.lat, savedLocation.lng);
        }

        focusSavedLocationFromQuery();

        const loading = document.getElementById("loading");

        if (loading) {
            loading.textContent = data.features.length
                ? ""
                : "No flood-risk features are available.";
            loading.style.display = data.features.length ? "none" : "block";
            loading.style.color = data.features.length ? "" : "#555";
        }
    })
    .catch(error => {
        console.error(error);

        const loading = document.getElementById("loading");

        if (loading) {
            loading.innerHTML = "Error loading flood risk map. Check your GeoJSON file.";
            loading.style.color = "red";
        }
    });

// ------------------------------------------------------
// 7. MAP LEGEND
// ------------------------------------------------------

const legend = L.control({
    position: "bottomright"
});

legend.onAdd = function () {
    const div = L.DomUtil.create("div", "info legend");

    div.innerHTML = `
        <h4>Flood Risk</h4>

        <div class="legend-item">
            <div class="legend-box" style="background:${riskColours[1]}"></div>
            Very Low
        </div>

        <div class="legend-item">
            <div class="legend-box" style="background:${riskColours[2]}"></div>
            Low
        </div>

        <div class="legend-item">
            <div class="legend-box" style="background:${riskColours[3]}"></div>
            Moderate
        </div>

        <div class="legend-item">
            <div class="legend-box" style="background:${riskColours[4]}"></div>
            High
        </div>

        <div class="legend-item">
            <div class="legend-box" style="background:${riskColours[5]}"></div>
            Very High
        </div>
    `;

    return div;
};

legend.addTo(map);
