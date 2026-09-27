importScripts("https://www.gstatic.com/firebasejs/12.0.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.0.0/firebase-messaging-compat.js");

firebase.initializeApp({
    apiKey: "AIzaSyDN9ZfO6yF_5ieIzV_Hv1_udoUERMjsm0s",
    authDomain: "mykuantanflood-f767e.firebaseapp.com",
    projectId: "mykuantanflood-f767e",
    storageBucket: "mykuantanflood-f767e.firebasestorage.app",
    messagingSenderId: "66275186842",
    appId: "1:66275186842:web:d3b34d906c0c1fb65f6723",
    measurementId: "G-QW11X13ZC4"
});

const messaging = firebase.messaging();

const APP_SCOPE_URL = new URL(self.registration.scope);
const APP_SCOPE_SEGMENTS = APP_SCOPE_URL.pathname.split("/").filter(Boolean);
const NOTIFICATION_FALLBACK_URL = APP_SCOPE_URL.href;
const NOTIFICATION_ICON_URL = new URL("favicon.svg", self.registration.scope).href;

function isAllowedNotificationUrl(url) {
    if (url.origin !== APP_SCOPE_URL.origin) {
        return false;
    }

    const candidateSegments = url.pathname.split("/").filter(Boolean);
    return APP_SCOPE_SEGMENTS.every((segment, index) => candidateSegments[index] === segment);
}

function resolveNotificationUrl(payload = {}) {
    const notification = payload.notification || {};
    const candidateUrl = notification.click_action || payload.fcmOptions?.link || payload.data?.url;

    if (!candidateUrl) {
        return NOTIFICATION_FALLBACK_URL;
    }

    try {
        const resolvedUrl = new URL(candidateUrl, self.registration.scope);
        return isAllowedNotificationUrl(resolvedUrl) ? resolvedUrl.href : NOTIFICATION_FALLBACK_URL;
    } catch (error) {
        return NOTIFICATION_FALLBACK_URL;
    }
}

function resolveNotificationClickUrl(notificationData = {}) {
    const fcmMessage = notificationData.FCM_MSG || {};
    return resolveNotificationUrl({
        notification: fcmMessage.notification,
        fcmOptions: fcmMessage.fcmOptions,
        data: {
            url: notificationData.url || fcmMessage.data?.url
        }
    });
}

function isSameNotificationTarget(clientUrl, targetUrl) {
    return clientUrl.origin === targetUrl.origin &&
        clientUrl.pathname === targetUrl.pathname &&
        clientUrl.search === targetUrl.search &&
        clientUrl.hash === targetUrl.hash;
}

function sendNotificationClickMessage(client, targetUrl) {
    return new Promise(resolve => {
        if (!client?.postMessage) {
            resolve(false);
            return;
        }

        const messageChannel = new MessageChannel();
        const timeoutId = setTimeout(() => resolve(false), 1500);
        messageChannel.port1.onmessage = event => {
            clearTimeout(timeoutId);
            resolve(event.data?.received === true);
        };

        try {
            client.postMessage({
                type: "notification-click",
                url: targetUrl
            }, [messageChannel.port2]);
        } catch (error) {
            clearTimeout(timeoutId);
            console.warn("[FCM] Notification click handoff failed:", error);
            resolve(false);
        }
    });
}

messaging.onBackgroundMessage(payload => {
    const notification = payload.notification || {};
    const title = notification.title || "Kuantan Flood Alert";

    self.registration.showNotification(title, {
        body: notification.body || "New flood information is available.",
        icon: notification.icon || NOTIFICATION_ICON_URL,
        data: {
            url: resolveNotificationUrl(payload)
        }
    });
});

async function openNotificationTarget(targetUrl) {
    const resolvedTarget = new URL(targetUrl);
    const windowClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const inScopeClients = windowClients.filter(client => {
        try {
            return isAllowedNotificationUrl(new URL(client.url));
        } catch (error) {
            return false;
        }
    });
    const existingClient = inScopeClients.find(client => {
        try {
            return isSameNotificationTarget(new URL(client.url), resolvedTarget);
        } catch (error) {
            return false;
        }
    }) || inScopeClients[0];

    if (existingClient) {
        try {
            const existingClientUrl = new URL(existingClient.url);
            if (isSameNotificationTarget(existingClientUrl, resolvedTarget) && "focus" in existingClient) {
                return existingClient.focus();
            }
        } catch (error) {
            console.warn("[FCM] Notification click focus failed:", error);
        }

        try {
            const focusedClient = "focus" in existingClient
                ? await existingClient.focus()
                : existingClient;
            const handoffSucceeded = await sendNotificationClickMessage(existingClient, resolvedTarget.href);
            if (handoffSucceeded) {
                return focusedClient;
            }
        } catch (error) {
            console.warn("[FCM] Notification click message handoff failed:", error);
        }

        try {
            const openedClient = await clients.openWindow(resolvedTarget.href);
            if (openedClient && "focus" in openedClient) {
                return openedClient.focus();
            }
            if (openedClient) {
                return openedClient;
            }
        } catch (error) {
            console.warn("[FCM] Notification click openWindow fallback failed:", error);
        }
    }

    try {
        return await clients.openWindow(resolvedTarget.href);
    } catch (error) {
        if (resolvedTarget.href !== NOTIFICATION_FALLBACK_URL) {
            try {
                return await clients.openWindow(NOTIFICATION_FALLBACK_URL);
            } catch (fallbackError) {
                return null;
            }
        }
        return null;
    }
}

self.addEventListener("notificationclick", event => {
    event.notification.close();
    const targetUrl = resolveNotificationClickUrl(event.notification.data);
    event.waitUntil(openNotificationTarget(targetUrl));
});
