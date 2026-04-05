const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const https = require('https');

const client = new SteamUser({
    // Ownership and random rotation rely on `getOwnedApps`.
    // This requires PICS cache support in steam-user.
    enablePicsCache: true,
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
let ownershipRetryTimer = null;
let ownershipRetryAttempts = 0;
let webCookies = [];

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseCommunityGamesFromHtml(html) {
    if (typeof html !== 'string' || !html.trim()) {
        return [];
    }

    const fromRgGames = parseRgGamesFromHtml(html);
    if (fromRgGames.length > 0) {
        return Array.from(new Set(fromRgGames.map((game) => game.appid)));
    }

    const appIdSet = new Set();
    // Keep parsing conservative here to avoid grabbing unrelated app links from page chrome/recommendations.
    const patterns = [
        /"appid"\s*:\s*(\d+)/gi,
        /\bappid\s*:\s*(\d+)/gi,
        /<appID>\s*(\d+)\s*<\/appID>/gi,
    ];

    for (const pattern of patterns) {
        let match = null;
        while ((match = pattern.exec(html)) !== null) {
            const id = Number.parseInt(match[1], 10);
            if (Number.isInteger(id) && id > 0) {
                appIdSet.add(id);
            }
        }
    }

    return Array.from(appIdSet);
}

function fetchUrl(url, headers = {}) {
    return new Promise((resolve) => {
        const req = https.get(url, { timeout: 15000, headers }, (res) => {
            if (!res || (res.statusCode && res.statusCode >= 400)) {
                resolve('');
                return;
            }

            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                resolve(body);
            });
        });

        req.on('error', () => resolve(''));
        req.on('timeout', () => {
            req.destroy();
            resolve('');
        });
    });
}

function parseRgGamesFromHtml(html) {
    if (typeof html !== 'string' || !html.trim()) {
        return [];
    }

    // On /my/games?tab=all Steam renders JS object: var rgGames = [...];
    const rgGamesMatch = html.match(/var\s+rgGames\s*=\s*(\[[\s\S]*?\]);/i);
    if (!rgGamesMatch) {
        return [];
    }

    try {
        const games = JSON.parse(rgGamesMatch[1]);
        if (!Array.isArray(games)) {
            return [];
        }
        return games
            .map((game) => ({
                appid: Number.parseInt(String(game?.appid ?? ''), 10),
                name: String(game?.name || '').trim(),
            }))
            .filter((game) => Number.isInteger(game.appid) && game.appid > 0);
    } catch (_) {
        return [];
    }
}

async function fetchOwnedAppsFromMyProfile() {
    if (!Array.isArray(webCookies) || webCookies.length === 0) {
        return [];
    }

    const headers = {
        Cookie: webCookies.join('; '),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://steamcommunity.com/my/games/?tab=all',
    };

    const urls = [
        'https://steamcommunity.com/my/games/?tab=all',
        'https://steamcommunity.com/id/me/games/?tab=all',
    ];

    for (const url of urls) {
        const body = await fetchUrl(url, headers);
        const games = parseRgGamesFromHtml(body);
        if (games.length > 0) {
            const appIds = Array.from(new Set(games.map((game) => game.appid)));
            const sampleTitles = games
                .map((game) => game.name)
                .filter(Boolean)
                .slice(0, 5)
                .join(', ');
            console.log(`[${login}] Ownership via authenticated profile: ${games.length} games (${sampleTitles || 'titles unavailable'})`);
            return appIds;
        }
    }

    return [];
}

async function fetchOwnedAppsFromCommunity(steamId) {
    const urls = [
        `https://steamcommunity.com/profiles/${steamId}/games?xml=1`,
        `https://steamcommunity.com/profiles/${steamId}/games/?xml=1`,
        `https://steamcommunity.com/profiles/${steamId}/games?tab=all&l=english`,
        `https://steamcommunity.com/profiles/${steamId}/games?tab=all`,
    ];

    for (const url of urls) {
        const body = await fetchUrl(url);
        let appIds = [];

        if (url.includes('xml=1')) {
            appIds = parseCommunityGamesFromHtml(body);
        } else {
            // For HTML tabs we trust only rgGames payload, to avoid accidental overcount
            // from unrelated app links in the page chrome.
            const rgGames = parseRgGamesFromHtml(body);
            appIds = Array.from(new Set(rgGames.map((game) => game.appid)));
        }

        if (appIds.length > 0) {
            console.log(`[${login}] Ownership fallback succeeded via ${url} (${appIds.length} appids)`);
            return appIds;
        }
    }

    return [];
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
        let picsCacheNotReady = false;
        try {
            const appIdsFromLicenses = client.getOwnedApps({ excludeShared: true }) || [];
            if (Array.isArray(appIdsFromLicenses) && appIdsFromLicenses.length > 0) {
                availableGameIds = appIdsFromLicenses;
            }
        } catch (err) {
            const errText = String(err?.message || err || '');
            picsCacheNotReady = /no data in pics package cache yet/i.test(errText);
            console.warn(`[${login}] License cache unavailable, will use community profile fallback: ${errText}`);
        }

        if (availableGameIds.length === 0) {
            const appIdsFromMyProfile = await fetchOwnedAppsFromMyProfile();
            if (appIdsFromMyProfile.length > 0) {
                availableGameIds = appIdsFromMyProfile;
            }
        }

        if (availableGameIds.length === 0) {
            const appIdsFromCommunity = await fetchOwnedAppsFromCommunity(steamIdArg);
            if (appIdsFromCommunity.length > 0) {
                console.log(`[${login}] Ownership fallback: loaded ${appIdsFromCommunity.length} appids from community profile`);
                availableGameIds = appIdsFromCommunity;
            }
        }

        if (availableGameIds.length === 0) {
            if (picsCacheNotReady && ownershipRetryAttempts < 4) {
                ownershipLoadStarted = false;
                ownershipRetryAttempts += 1;
                const retryDelayMs = 4000 * ownershipRetryAttempts;
                if (ownershipRetryTimer) {
                    clearTimeout(ownershipRetryTimer);
                }
                ownershipRetryTimer = setTimeout(() => {
                    ownershipRetryTimer = null;
                    loadOwnershipAndStart();
                }, retryDelayMs);
                console.warn(`[${login}] PICS cache not ready yet, retrying ownership load in ${Math.round(retryDelayMs / 1000)}s (${ownershipRetryAttempts}/4)`);
                return;
            }

            if (mustPlayIds.length > 0) {
                console.warn(`[${login}] Could not load full library, continuing with fixed appids only`);
                availableGameIds = mustPlayIds.slice();
            } else {
                console.error(`[${login}] Could not find any games on account`);
                shutdown(5);
                return;
            }
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
        ownershipRetryAttempts = 0;

        // If we already started with fixed appids only, refresh activity immediately
        // once library data arrives so random slots become active without waiting for next rotation.
        if (startedPlaying && randomSlotsCount > 0) {
            startRandomActivity();
        }

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
    if (ownershipRetryTimer) {
        clearTimeout(ownershipRetryTimer);
        ownershipRetryTimer = null;
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
    try {
        client.webLogOn();
    } catch (_) {
        // noop
    }

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

client.on('webSession', (_sessionId, cookies) => {
    if (Array.isArray(cookies) && cookies.length > 0) {
        webCookies = cookies;
    }
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
