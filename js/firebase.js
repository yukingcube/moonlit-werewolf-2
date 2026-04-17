/* ============================================
   firebase.js - 同期プロトコル (v0.5.0 再設計版)

   【設計原則】
   1. ホストが唯一の真実の源 (Single Source of Truth)
   2. フェーズ切替ごとに turnId (ユニーク数値) を発行
      → 同じフェーズ名でも Day が進めば turnId が変わるため、
        ゲストは turnId の差分だけを監視すれば取りこぼさない
   3. ゲストは /rooms/<id>/sync を購読して画面を更新
   4. ゲストは /rooms/<id>/inbox/<day>/<userId>/* に自分のアクションを書き込む
   5. ホストは必要なタイミングでアクションを読み取る
   ============================================ */

let fbReady = false;
let fbDb = null;
let fbAuth = null;
let currentRoomId = null;
let isHost = false;
let roomUnsubscribers = []; // 全監視解除用

function getCurrentUserId() { return window.currentUserId || null; }

function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

// ============================================
// Firebase 基本ヘルパー
// ============================================
function fbRef(path) { return window.fbFunctions.ref(fbDb, path); }
async function fbSet(path, data) { return window.fbFunctions.set(fbRef(path), data); }
async function fbGet(path) {
    const snap = await window.fbFunctions.get(fbRef(path));
    return snap.exists() ? snap.val() : null;
}
async function fbUpdate(path, updates) { return window.fbFunctions.update(fbRef(path), updates); }
async function fbRemove(path) { return window.fbFunctions.remove(fbRef(path)); }
function fbOnValue(path, callback) {
    const r = fbRef(path);
    const unsubCallback = window.fbFunctions.onValue(r, (snap) => callback(snap.val()));
    // onValue は unsubscribe 関数を返す(v9 モジュラー版)
    const unsubscribe = () => {
        try { window.fbFunctions.off(r); } catch(e){}
    };
    roomUnsubscribers.push(unsubscribe);
    return unsubscribe;
}

function cleanupAllListeners() {
    roomUnsubscribers.forEach(u => { try { u(); } catch(e){} });
    roomUnsubscribers = [];
}

// ============================================
// ルーム作成
// ============================================
async function createRoom() {
    const userId = getCurrentUserId();
    const playerName = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME);
    if (!userId) throw new Error('Firebase未認証');
    if (!playerName) throw new Error('名前未設定');

    const roomId = generateRoomId();
    await fbSet(`rooms/${roomId}`, {
        meta: {
            hostUserId: userId,
            hostName: playerName,
            status: 'waiting',
            createdAt: Date.now()
        },
        players: {
            [userId]: { name: playerName, isHost: true, joinedAt: Date.now() }
        },
        sync: {
            turnId: 0,
            phase: Phase.LOBBY,
            day: 0,
            payload: null
        }
    });

    currentRoomId = roomId;
    isHost = true;
    return roomId;
}

// ============================================
// ルーム参加
// ============================================
async function joinRoom(roomId) {
    const userId = getCurrentUserId();
    const playerName = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME);
    if (!userId) throw new Error('Firebase未認証');
    if (!playerName) throw new Error('名前未設定');

    const roomData = await fbGet(`rooms/${roomId}`);
    if (!roomData) throw new Error('ルームが見つかりません');
    if (roomData.meta.status !== 'waiting') throw new Error('既にゲームが始まっています');

    const playerCount = Object.keys(roomData.players || {}).length;
    if (playerCount >= 7) throw new Error('ルームが満員です(最大7人)');

    await fbSet(`rooms/${roomId}/players/${userId}`, {
        name: playerName, isHost: false, joinedAt: Date.now()
    });

    currentRoomId = roomId;
    isHost = false;
    return roomData;
}

// ============================================
// ルーム退出
// ============================================
async function leaveRoom() {
    if (!currentRoomId) return;
    const userId = getCurrentUserId();
    try {
        if (isHost) {
            // ホストがルームを閉じる
            await fbRemove(`rooms/${currentRoomId}`);
        } else if (userId) {
            await fbSet(`rooms/${currentRoomId}/players/${userId}`, null);
        }
    } catch(e) { console.warn('leaveRoom err', e); }
    cleanupAllListeners();
    currentRoomId = null;
    isHost = false;
}

// ============================================
// ルーム監視 (ロビー用)
// ============================================
function watchPlayers(callback) {
    if (!currentRoomId) return;
    return fbOnValue(`rooms/${currentRoomId}/players`, callback);
}
function watchMeta(callback) {
    if (!currentRoomId) return;
    return fbOnValue(`rooms/${currentRoomId}/meta`, callback);
}
function watchSync(callback) {
    if (!currentRoomId) return;
    return fbOnValue(`rooms/${currentRoomId}/sync`, callback);
}

// ============================================
// ホスト: フェーズを進める (turnId 必ずインクリメント)
// ============================================
let _localTurnCounter = 0;
async function broadcastSync(phase, day, payload) {
    if (!currentRoomId || !isHost) return;
    _localTurnCounter = Math.max(_localTurnCounter, Date.now()) + 1;
    const sync = {
        turnId: _localTurnCounter,
        phase: phase,
        day: day || 0,
        payload: payload || null,
        updatedAt: Date.now()
    };
    await fbSet(`rooms/${currentRoomId}/sync`, sync);
    return sync.turnId;
}

// ============================================
// ホスト: 個別プレイヤーに役職情報を配信
// ============================================
async function writeRoles(rolesByUserId) {
    if (!currentRoomId || !isHost) return;
    const updates = {};
    for (const [uid, roleData] of Object.entries(rolesByUserId)) {
        updates[uid] = roleData;
    }
    await fbUpdate(`rooms/${currentRoomId}/roles`, updates);
}

async function getMyRole() {
    if (!currentRoomId) return null;
    const userId = getCurrentUserId();
    return await fbGet(`rooms/${currentRoomId}/roles/${userId}`);
}

// ============================================
// プレイヤー → ホスト アクション送信 (inbox)
// ============================================
async function submitInboxAction(day, kind, data) {
    // kind: 'night' | 'vote' | 'message' | 'ack'
    if (!currentRoomId) return;
    const userId = getCurrentUserId();
    await fbSet(
        `rooms/${currentRoomId}/inbox/day${day}/${kind}/${userId}`,
        { ...data, at: Date.now() }
    );
}

async function submitNightAction(day, action) {
    // action: { targetName: '○○' } など
    return submitInboxAction(day, 'night', action);
}
async function submitVote(day, targetName) {
    return submitInboxAction(day, 'vote', { targetName });
}
async function submitMessage(day, text) {
    const playerName = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME);
    return submitInboxAction(day, 'message', { from: playerName, text });
}
async function submitAck(day, kind) {
    return submitInboxAction(day, `ack_${kind}`, { ok: true });
}

// ============================================
// ホスト: inbox を読み取り
// ============================================
async function getInbox(day, kind) {
    if (!currentRoomId || !isHost) return {};
    return await fbGet(`rooms/${currentRoomId}/inbox/day${day}/${kind}`) || {};
}

// ホスト: 条件を満たすまで inbox をポーリング待機
//   expectedUserIds: Set<string> 待機すべき userId
//   timeoutMs: タイムアウト (ms)
async function waitForInbox(day, kind, expectedUserIds, timeoutMs = 60000) {
    if (!currentRoomId || !isHost) return {};
    const start = Date.now();
    const pollInterval = 1500;
    while (Date.now() - start < timeoutMs) {
        const data = await getInbox(day, kind);
        const submitted = new Set(Object.keys(data));
        let allDone = true;
        for (const uid of expectedUserIds) {
            if (!submitted.has(uid)) { allDone = false; break; }
        }
        if (allDone) return data;
        await sleep(pollInterval);
    }
    // タイムアウト: 現状のデータを返す
    console.warn(`[HOST] waitForInbox timeout: day=${day} kind=${kind}`);
    return await getInbox(day, kind);
}

// ============================================
// 最終結果の書き込み
// ============================================
async function writeGameResult(winner, players) {
    if (!currentRoomId || !isHost) return;
    await fbSet(`rooms/${currentRoomId}/result`, { winner, players, at: Date.now() });
}

async function writeThoughtsLog(thoughtsData) {
    if (!currentRoomId || !isHost) return;
    await fbSet(`rooms/${currentRoomId}/thoughts`, thoughtsData);
}
async function getThoughtsLog() {
    if (!currentRoomId) return null;
    return await fbGet(`rooms/${currentRoomId}/thoughts`);
}

// ============================================
// ルーム状態更新
// ============================================
async function setRoomStatus(status) {
    if (!currentRoomId || !isHost) return;
    await fbSet(`rooms/${currentRoomId}/meta/status`, status);
}
