const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const https = require('https');

const client = new SteamUser({
    // Keep process footprint low for multi-account boosting.
    // PICS cache can consume a lot of memory per process and is not needed here.
    enablePicsCache: false,
});

const [, , login, password, sharedSecret, steamIdArg, minIntervalArg, maxIntervalArg, preferredAppIdsArg] = process.argv;

if (!login || !password || !sharedSecret || !steamIdArg) {
    console.error('Usage: node activity_booster.js <login> <password> <shared_secret> <steamid> [min_minutes=60] [max_minutes=100] [app_ids_csv]');
    process.exit(1);
}


const minIntervalMinutes = Math.max(1, Number.parseInt(minIntervalArg || '60', 10));
const maxIntervalMinutes = Math.max(minIntervalMinutes, Number.parseInt(maxIntervalArg || '100', 10));
const rawPreferredAppIds = (preferredAppIdsArg || '')
    .split(',')
    .map((id) => Number.parseInt(String(id).trim(), 10))
    .filter((id) => Number.isInteger(id) && id >= 0)
    .filter((id, idx, arr) => arr.indexOf(id) === idx)
    .slice(0, 8);

let availableGameIds = [];
let rotateTimer = null;
let isShuttingDown = false;
let startedPlaying = false;
let fixedPlayableIds = [];
let mustPlayIds = [];
let randomSlotsCount = 0;
let lastRandomIds = [];
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 6;
let ownershipLoaded = false;
let reconnectTimer = null;
let shouldLoadOwnership = true;
let ownershipLoadStarted = false;

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseCommunityGamesFromHtml(html) {
    if (typeof html !== 'string' || !html.trim()) {
        return [];
    }

    const appIdSet = new Set();
    const appidRegex = /\"appid\"\s*:\s*(\d+)/g;
    let match = null;
    while ((match = appidRegex.exec(html)) !== null) {
        const id = Number.parseInt(match[1], 10);
        if (Number.isInteger(id) && id > 0) {
            appIdSet.add(id);
        }
    }

    return Array.from(appIdSet);
}

function fetchOwnedAppsFromCommunity(steamId) {
    return new Promise((resolve) => {
        const url = `https://steamcommunity.com/profiles/${steamId}/games?tab=all`;
        const req = https.get(url, { timeout: 15000 }, (res) => {
            if (!res || (res.statusCode && res.statusCode >= 400)) {
                resolve([]);
                return;
            }

            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                resolve(parseCommunityGamesFromHtml(body));
            });
        });

        req.on('error', () => resolve([]));
        req.on('timeout', () => {
            req.destroy();
            resolve([]);
        });
    });
}

function startIfReady() {
    if (startedPlaying) {
        return;
    }
    startRandomActivity();
    if (!rotateTimer) {
        scheduleNextRotate();
    }
}

async function loadOwnershipAndStart() {
    if (ownershipLoadStarted || ownershipLoaded) {
        return;
    }
    ownershipLoadStarted = true;

    try {
        const appIdsFromLicenses = client.getOwnedApps({ excludeShared: true }) || [];
        if (Array.isArray(appIdsFromLicenses) && appIdsFromLicenses.length > 0) {
            availableGameIds = appIdsFromLicenses;
        }

        if (availableGameIds.length === 0) {
            const appIdsFromCommunity = await fetchOwnedAppsFromCommunity(steamIdArg);
            if (appIdsFromCommunity.length > 0) {
                console.log(`[${login}] Ownership fallback: loaded ${appIdsFromCommunity.length} appids from community profile`);
                availableGameIds = appIdsFromCommunity;
            }
        }

        if (availableGameIds.length === 0) {
            console.error(`[${login}] Could not find any games on account`);
            shutdown(5);
            return;
        }

        if (rawPreferredAppIds.length > 0) {
            fixedPlayableIds = rawPreferredAppIds
                .filter((id) => id > 0)
                .slice(0, 4);
            const requestedFixed = rawPreferredAppIds.filter((id) => id > 0).slice(0, 4);
            const hasRandomToken = rawPreferredAppIds.includes(0);
            randomSlotsCount = hasRandomToken ? Math.max(0, 4 - fixedPlayableIds.length) : 0;
            mustPlayIds = fixedPlayableIds.slice();

            if (requestedFixed.length > 0 && fixedPlayableIds.length !== requestedFixed.length) {
                const missing = requestedFixed.filter((id) => !fixedPlayableIds.includes(id));
                console.warn(`[${login}] Requested appids are invalid and will be ignored: ${missing.join(', ')}`);
            }

            if (mustPlayIds.length === 0 && randomSlotsCount === 0) {
                console.warn(`[${login}] Requested appids are unavailable. Falling back to random games from account library.`);
                randomSlotsCount = Math.min(4, availableGameIds.length);
            }

            if (randomSlotsCount > 0) {
                console.log(`[${login}] Fixed appids: ${mustPlayIds.join(', ') || '-'}, random rotating slots: ${randomSlotsCount}`);
            } else {
                console.log(`[${login}] Will play configured appids: ${mustPlayIds.join(', ')}`);
            }
        } else {
            mustPlayIds = [];
            randomSlotsCount = Math.min(4, availableGameIds.length);
        }

        console.log(`[${login}] Found ${availableGameIds.length} games`);
        ownershipLoaded = true;
        startIfReady();
    } catch (err) {
        console.error(`[${login}] Failed to build owned app list: ${err?.message || err}`);
        shutdown(6);
    }
}

function pickRandomGames(appIds, count = 2, excludeIds = []) {
    const excludeSet = new Set(excludeIds);
    const uniquePool = appIds.filter((id, idx, arr) => arr.indexOf(id) === idx && !excludeSet.has(id));
    const pool = [...uniquePool];
    for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const picked = pool.slice(0, Math.min(count, pool.length));
    if (picked.length < count && excludeIds.length > 0) {
        const fallback = appIds.filter((id) => !picked.includes(id));
        for (let i = fallback.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [fallback[i], fallback[j]] = [fallback[j], fallback[i]];
        }
        for (const id of fallback) {
            if (picked.length >= count) {
                break;
            }
            picked.push(id);
        }
    }

    return picked.slice(0, count);
}

function parsePreferredGamePlan() {
    if (rawPreferredAppIds.length === 0) {
        mustPlayIds = [];
        randomSlotsCount = 0;
        shouldLoadOwnership = true;
        return;
    }

    const requestedFixed = rawPreferredAppIds.filter((id) => id > 0).slice(0, 4);
    const hasRandomToken = rawPreferredAppIds.includes(0);

    // Use Set to keep IDs unique without repeated O(n²) scans.
    const uniqueFixed = Array.from(new Set(requestedFixed)).slice(0, 4);
    mustPlayIds = uniqueFixed;
    randomSlotsCount = hasRandomToken ? Math.max(0, 4 - mustPlayIds.length) : 0;

    // If no random slots requested, we can skip ownership loading entirely,
    // which noticeably lowers RAM usage per account.
    shouldLoadOwnership = randomSlotsCount > 0 || mustPlayIds.length === 0;
}

function composeCurrentActivity() {
    const nextRandom = randomSlotsCount > 0
        ? pickRandomGames(availableGameIds, randomSlotsCount, [...mustPlayIds, ...lastRandomIds])
        : [];
    if (nextRandom.length < randomSlotsCount) {
        const refill = pickRandomGames(availableGameIds, randomSlotsCount - nextRandom.length, [...mustPlayIds, ...nextRandom]);
        nextRandom.push(...refill);
    }
    lastRandomIds = nextRandom.slice(0, randomSlotsCount);
    return [...mustPlayIds, ...lastRandomIds].slice(0, 4);
}

function scheduleNextRotate() {
    const nextMinutes = randInt(minIntervalMinutes, maxIntervalMinutes);
    const nextMs = nextMinutes * 60 * 1000;

    console.log(`Next rotation in ${nextMinutes} minutes`);
    rotateTimer = setTimeout(() => {
        if (isShuttingDown) {
            return;
        }
        startRandomActivity();
        scheduleNextRotate();
    }, nextMs);
}

function startRandomActivity() { 
    client.setPersona(SteamUser.EPersonaState.Online);
    startedPlaying = true;
    const selected = composeCurrentActivity();
    if (selected.length === 0) {
        console.log('No games available for activity');
        return;
    }

    console.log(`Playing appids: ${selected.join(', ')}`);
    client.gamesPlayed(selected, true); 
} 

function shutdown(code = 0) {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;

    if (rotateTimer) {
        clearTimeout(rotateTimer);
        rotateTimer = null;
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    try {
        client.gamesPlayed([]);
    } catch (_) {
        // noop
    }
    try {
        client.logOff();
    } catch (_) {
        // noop
    }

    process.exit(code);
}

function scheduleReconnect(reason) {
    if (isShuttingDown) {
        return;
    }
    if (reconnectTimer) {
        return;
    }
    reconnectAttempts += 1;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.error(`[${login}] Too many reconnect attempts, stopping booster (${reason})`);
        shutdown(8);
        return;
    }

    const delaySeconds = Math.min(45, reconnectAttempts * 7);
    console.log(`[${login}] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delaySeconds}s (${reason})`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (isShuttingDown) {
            return;
        }
        try {
            client.logOn({
                accountName: login,
                password,
                twoFactorCode: SteamTotp.getAuthCode(sharedSecret),
                machineName: `booster_${login}`,
            });
        } catch (err) {
            console.error(`[${login}] Reconnect failed to start: ${err?.message || err}`);
            scheduleReconnect('logon exception');
        }
    }, delaySeconds * 1000);
}

function startLogon() {
    try {
        client.logOn({
            accountName: login,
            password,
            twoFactorCode: SteamTotp.getAuthCode(sharedSecret),
            machineName: `booster_${login}`,
        });
    } catch (err) {
        console.error(`[${login}] Initial logon failed to start: ${err?.message || err}`);
        scheduleReconnect('initial logon exception');
    }
}

client.on('loggedOn', () => { 
    reconnectAttempts = 0;
    reconnectTimer = null;
    console.log(`[${login}] Logged on`); 
    client.setPersona(SteamUser.EPersonaState.Online);

    // Always start fixed appids immediately if they were explicitly configured.
    // This guarantees activity even if ownership loading is delayed.
    if (mustPlayIds.length > 0 && !startedPlaying) {
        startIfReady();
    }

    if (!ownershipLoaded && shouldLoadOwnership) {
        loadOwnershipAndStart();
    } else {
        startIfReady();
    }
});

client.on('licenses', () => {
    if (shouldLoadOwnership && !ownershipLoaded) {
        loadOwnershipAndStart();
    }
});

client.on('webSession', () => {
    if (!startedPlaying) {
        console.log(`[${login}] Web session started`);
    }
    if (shouldLoadOwnership && !ownershipLoaded) {
        loadOwnershipAndStart();
    }
});
client.on('error', (err) => {
    console.error(`[${login}] Steam error: ${err?.message || err}`);
    scheduleReconnect(`error: ${err?.message || err}`);
});

client.on('disconnected', (eresult, msg) => {
    console.error(`[${login}] Disconnected: ${msg || eresult}`);
    scheduleReconnect(`disconnected: ${msg || eresult}`)
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

parsePreferredGamePlan();

if (!shouldLoadOwnership && mustPlayIds.length > 0) {
    // Lightweight mode: strictly use configured app ids and avoid loading ownership data.
    availableGameIds = mustPlayIds.slice();
    ownershipLoaded = true;
    console.log(`[${login}] Lightweight mode enabled: ownership cache skipped, fixed appids: ${mustPlayIds.join(', ')}`);
}

startLogon();
