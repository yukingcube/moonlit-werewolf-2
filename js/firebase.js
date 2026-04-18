/* ============================================
   firebase.js v0.5 - Firebase マルチプレイ(同期付き)
   ============================================ */

let fbDb = null;
let currentRoomId = null;
let isHost = false;
let _roomWatcher = null;
let _readyWatcher = null;

function getCurrentUserId() { return window.currentUserId || null; }

function generateRoomId() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = ''; for (let i = 0; i < 6; i++) id += c[Math.floor(Math.random() * c.length)];
    return id;
}

// Firebase helpers
function fbRef(path) {
    return path ? window.fbFunctions.ref(fbDb, path) : window.fbFunctions.ref(fbDb);
}
async function fbSet(path, data) { return window.fbFunctions.set(fbRef(path), data); }
async function fbGet(path) { const s = await window.fbFunctions.get(fbRef(path)); return s.exists() ? s.val() : null; }
function fbOnValue(path, cb) { return window.fbFunctions.onValue(fbRef(path), s => cb(s.val())); }
function fbOff(path) { try { window.fbFunctions.off(fbRef(path)); } catch(e){} }

// ============================================
// ルーム管理
// ============================================
async function createRoom() {
    const uid = getCurrentUserId(), name = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME);
    if (!uid || !name) throw new Error('認証or名前が未設定');
    const roomId = generateRoomId();
    await fbSet(`rooms/${roomId}`, {
        meta: { hostUid: uid, status: 'waiting', createdAt: Date.now() },
        players: { [uid]: { name, isHost: true, joinedAt: Date.now() } }
    });
    currentRoomId = roomId; isHost = true;
    return roomId;
}

async function joinRoom(roomId) {
    const uid = getCurrentUserId(), name = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME);
    if (!uid || !name) throw new Error('認証or名前が未設定');
    const data = await fbGet(`rooms/${roomId}`);
    if (!data) throw new Error('ルームが見つかりません');
    if (data.meta.status !== 'waiting') throw new Error('ゲームが始まっています');
    if (Object.keys(data.players || {}).length >= 7) throw new Error('満員です');
    await fbSet(`rooms/${roomId}/players/${uid}`, { name, isHost: false, joinedAt: Date.now() });
    currentRoomId = roomId; isHost = false;
    return data;
}

async function leaveRoom() {
    if (!currentRoomId) return;
    const uid = getCurrentUserId();
    if (uid) try { await fbSet(`rooms/${currentRoomId}/players/${uid}`, null); } catch(e){}
    stopWatchingRoom(); stopWatchingGame();
    currentRoomId = null; isHost = false;
}

// ============================================
// ルーム監視(ロビー用)
// ============================================
function watchRoom(cb) {
    if (!currentRoomId) return;
    stopWatchingRoom();
    _roomWatcher = fbOnValue(`rooms/${currentRoomId}`, cb);
}
function stopWatchingRoom() {
    if (currentRoomId) fbOff(`rooms/${currentRoomId}`);
    _roomWatcher = null;
}

// ============================================
// ゲーム状態監視(ゲーム中・全プレイヤー共通)
// ============================================
let _gameWatcher = null;
function watchGame(cb) {
    if (!currentRoomId) return;
    stopWatchingGame();
    _gameWatcher = fbOnValue(`rooms/${currentRoomId}/game`, cb);
}
function stopWatchingGame() {
    if (currentRoomId) fbOff(`rooms/${currentRoomId}/game`);
    _gameWatcher = null;
}

// ============================================
// ゲーム状態書き込み(ホスト専用)
// ============================================
async function fbWritePhase(phase, data) {
    if (!currentRoomId || !isHost) return;
    const gamePath = `rooms/${currentRoomId}/game`;
    const updates = {
        phase: phase,
        phaseData: data || {},
        phaseVersion: Date.now()
    };
    await window.fbFunctions.update(fbRef(gamePath), updates);
}

async function fbWriteRoles(rolesByUid) {
    if (!currentRoomId || !isHost) return;
    for (const [uid, data] of Object.entries(rolesByUid)) {
        await fbSet(`rooms/${currentRoomId}/roles/${uid}`, data);
    }
}

async function fbWriteResult(winner, players) {
    if (!currentRoomId || !isHost) return;
    await fbSet(`rooms/${currentRoomId}/game/result`, { winner, players });
}

// ============================================
// プレイヤーアクション
// ============================================
async function fbMarkReady(phase) {
    if (!currentRoomId) return;
    const uid = getCurrentUserId();
    await fbSet(`rooms/${currentRoomId}/ready/${phase}/${uid}`, true);
}

async function fbClearReady(phase) {
    if (!currentRoomId || !isHost) return;
    await fbSet(`rooms/${currentRoomId}/ready/${phase}`, null);
}

function fbWatchReady(phase, cb) {
    if (!currentRoomId) return;
    fbOnValue(`rooms/${currentRoomId}/ready/${phase}`, cb);
}

async function fbSubmitVote(day, targetName) {
    if (!currentRoomId) return;
    const uid = getCurrentUserId();
    await fbSet(`rooms/${currentRoomId}/votes/day${day}/${uid}`, targetName);
}

async function fbSubmitMessage(day, message) {
    if (!currentRoomId) return;
    const uid = getCurrentUserId();
    const name = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME);
    await fbSet(`rooms/${currentRoomId}/messages/day${day}/${uid}`, { from: name, text: message });
}

async function fbSubmitNightAction(day, action) {
    if (!currentRoomId) return;
    const uid = getCurrentUserId();
    await fbSet(`rooms/${currentRoomId}/nightActions/day${day}/${uid}`, action);
}

async function fbGetVotes(day) { return await fbGet(`rooms/${currentRoomId}/votes/day${day}`) || {}; }
async function fbGetMessages(day) {
    const d = await fbGet(`rooms/${currentRoomId}/messages/day${day}`);
    return d ? Object.values(d) : [];
}
async function fbGetNightActions(day) { return await fbGet(`rooms/${currentRoomId}/nightActions/day${day}`) || {}; }
async function fbGetMyRole() { return await fbGet(`rooms/${currentRoomId}/roles/${getCurrentUserId()}`); }
async function fbGetHumanUids() {
    const players = await fbGet(`rooms/${currentRoomId}/players`);
    return players ? Object.keys(players) : [];
}

// 全プレイヤーが準備完了するまで待つPromise
function waitForAllReady(phase, expectedUids) {
    return new Promise((resolve) => {
        const path = `rooms/${currentRoomId}/ready/${phase}`;
        const unsub = fbOnValue(path, (data) => {
            if (!data) return;
            const readyUids = Object.keys(data);
            const allReady = expectedUids.every(uid => readyUids.includes(uid));
            if (allReady) {
                fbOff(path);
                resolve();
            }
        });
    });
}

// タイムアウト付き待機
function waitForAllReadyWithTimeout(phase, expectedUids, timeoutMs = 60000) {
    return new Promise((resolve) => {
        const path = `rooms/${currentRoomId}/ready/${phase}`;
        let resolved = false;
        const timer = setTimeout(() => {
            if (!resolved) { resolved = true; fbOff(path); resolve('timeout'); }
        }, timeoutMs);
        fbOnValue(path, (data) => {
            if (resolved) return;
            if (!data) return;
            const readyUids = Object.keys(data);
            const allReady = expectedUids.every(uid => readyUids.includes(uid));
            if (allReady) {
                resolved = true; clearTimeout(timer); fbOff(path); resolve('ready');
            }
        });
    });
}
