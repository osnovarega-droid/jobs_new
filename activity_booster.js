const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

const client = new SteamUser({
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

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
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
    startedPlaying = true;
    const selected = composeCurrentActivity();
    if (selected.length === 0) {
        console.log('No games available for activity');
        return;
    }

    console.log(`Playing appids: ${selected.join(', ')}`);
    client.setPersona(SteamUser.EPersonaState.Online);
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
    if (!ownershipLoaded) {
        client.webLogOn();
    } else {
        startRandomActivity();
        if (!rotateTimer) {
            scheduleNextRotate();
        }
    }
});

client.on('ownershipCached', async () => {
    try {
        availableGameIds = client.getOwnedApps({
            excludeShared: true,
        });

        if (!Array.isArray(availableGameIds) || availableGameIds.length === 0) {
            availableGameIds = client.getOwnedApps({ excludeShared: true }) || [];
        }

        if (availableGameIds.length === 0) { 
            console.error(`[${login}] Could not find any games on account`); 
            shutdown(5); 
            return; 
        } 

        if (rawPreferredAppIds.length > 0) {
            const availableSet = new Set(availableGameIds);
            fixedPlayableIds = rawPreferredAppIds
                .filter((id) => id > 0 && availableSet.has(id))
                .slice(0, 4);
            const requestedFixed = rawPreferredAppIds.filter((id) => id > 0).slice(0, 4);
            const hasRandomToken = rawPreferredAppIds.includes(0);
            randomSlotsCount = hasRandomToken ? Math.max(0, 4 - fixedPlayableIds.length) : 0;
            mustPlayIds = fixedPlayableIds.slice();

            if (requestedFixed.length > 0 && fixedPlayableIds.length !== requestedFixed.length) {
                const missing = requestedFixed.filter((id) => !fixedPlayableIds.includes(id));
                console.error(`[${login}] Missing requested appids in library: ${missing.join(', ')}`);
                shutdown(7);
                return;
            }

            if (mustPlayIds.length === 0 && randomSlotsCount === 0) {
                console.error(`[${login}] None of requested appids are present in the library: ${rawPreferredAppIds.join(', ')}`);
                shutdown(7);
                return;
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
        startRandomActivity();
        scheduleNextRotate();
    } catch (err) {
        console.error(`[${login}] Failed to build owned app list: ${err.message}`);
        shutdown(6);
    }
});

client.on('webSession', () => {
    if (!startedPlaying) {
        console.log(`[${login}] Web session started`);
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

startLogon();
