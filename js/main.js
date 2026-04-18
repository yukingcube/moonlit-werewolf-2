/* ============================================
   main.js v0.5 - ホスト/ゲスト統一フロー
   ============================================ */

let currentScreen = Screen.TITLE;
let _lastPhaseVersion = 0; // 同じフェーズの二重処理防止
let _mpHumanUids = []; // マルチプレイの全人間UID

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) { target.classList.add('active'); currentScreen = screenId; window.scrollTo({ top: 0, behavior: 'instant' }); }
}
function showModal(msg) { document.getElementById('modal-message').innerHTML = msg; document.getElementById('modal-overlay').classList.add('active'); }
function closeModal() { document.getElementById('modal-overlay').classList.remove('active'); }
function showConfirm(msg, okText='OK', cancelText='キャンセル') {
    return new Promise(resolve => {
        document.getElementById('confirm-message').innerHTML = msg;
        const y = document.getElementById('btn-confirm-yes'), n = document.getElementById('btn-confirm-no');
        y.textContent = okText; n.textContent = cancelText;
        const m = document.getElementById('confirm-modal'); m.classList.add('active');
        const clean = () => { m.classList.remove('active'); y.removeEventListener('click', onY); n.removeEventListener('click', onN); };
        const onY = () => { clean(); resolve(true); };
        const onN = () => { clean(); resolve(false); };
        y.addEventListener('click', onY); n.addEventListener('click', onN);
    });
}
function saveSettings() {
    localStorage.setItem(STORAGE_KEYS.PLAYER_NAME, document.getElementById('input-name').value.trim());
    localStorage.setItem(STORAGE_KEYS.API_KEY, document.getElementById('input-api-key').value.trim());
    localStorage.setItem(STORAGE_KEYS.MODEL, document.querySelector('input[name="model"]:checked')?.value || 'gemini-2.5-flash');
}
function loadSettings() {
    document.getElementById('input-name').value = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME) || '';
    document.getElementById('input-api-key').value = localStorage.getItem(STORAGE_KEYS.API_KEY) || '';
    const m = localStorage.getItem(STORAGE_KEYS.MODEL) || 'gemini-2.5-flash';
    const r = document.querySelector(`input[name="model"][value="${m}"]`);
    if (r) r.checked = true;
}
function toggleApiKeyVisibility() { const i = document.getElementById('input-api-key'); i.type = i.type==='password'?'text':'password'; }

// ============================================
// アクションハンドラ(ソロ/マルチ統一)
// ============================================
function handleAction(action) {
    switch(action) {
        case 'start-solo': startSoloGame(); break;
        case 'show-create-room': handleCreateRoom(); break;
        case 'show-join-room': showScreen('screen-join-room'); break;
        case 'do-join-room': handleJoinRoom(); break;
        case 'copy-room-id': { const id = document.getElementById('room-id-display').textContent; navigator.clipboard.writeText(id).then(()=>showModal(`「${id}」をコピーしました`)); } break;
        case 'host-start-game': handleHostStartGame(); break;
        case 'leave-room': handleLeaveRoom(); break;
        case 'show-rules': showScreen(Screen.RULES); break;
        case 'show-settings': loadSettings(); showScreen(Screen.SETTINGS); break;
        case 'back-to-title': if (currentScreen===Screen.SETTINGS) saveSettings(); showScreen(Screen.TITLE); break;
        case 'back-to-result': showScreen(Screen.RESULT); break;
        case 'toggle-api-visibility': toggleApiKeyVisibility(); break;
        case 'clear-api-key':
            showConfirm('APIキーをクリアしますか?','削除する').then(ok => { if(!ok) return; document.getElementById('input-api-key').value=''; localStorage.removeItem(STORAGE_KEYS.API_KEY); showModal('クリアしました'); });
            break;
        case 'close-modal': closeModal(); break;

        // ゲーム進行(ソロ/マルチで分岐)
        case 'go-to-role':
            if (multiplayerMode) {
                fbMarkReady('characters');
                showWaiting('他のプレイヤーを待っています…', '全員が確認するまでお待ちください');
            } else { showRoleScreen(); }
            break;

        case 'role-confirmed':
            if (multiplayerMode) {
                fbMarkReady('role');
                showWaiting('他のプレイヤーを待っています…', 'ゲームが始まります…');
            } else { startNightPhase(); }
            break;

        case 'go-to-discussion':
            if (multiplayerMode) {
                const d = gameState ? gameState.day : (window._mpDay || 1);
                fbMarkReady(`morning_day${d}`);
                showWaiting('他のプレイヤーを待っています…', '');
            } else { startDiscussionPhase(); }
            break;

        case 'end-discussion':
            if (multiplayerMode) {
                showConfirm('議論を終了しますか?', '終了する').then(ok => { if(ok) endDiscussion(); });
            } else {
                showConfirm('議論を終了して投票に移りますか?', '終了する').then(ok => { if(ok) endDiscussion(); });
            }
            break;

        case 'continue-game':
            if (multiplayerMode) { continueGame(); }
            else { advanceToNextDay(); }
            break;

        case 'show-thoughts': showThoughtsScreen(); break;
        case 'play-again':
            if (multiplayerMode) handleLeaveRoom();
            multiplayerMode = false;
            showScreen(Screen.TITLE);
            break;
        default: console.warn('Unknown action:', action);
    }
}

// ============================================
// マルチプレイ: ルーム作成
// ============================================
async function handleCreateRoom() {
    const name = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME);
    const apiKey = localStorage.getItem(STORAGE_KEYS.API_KEY);
    if (!name?.trim()) { showModal('設定画面で名前を入力してください'); return; }
    if (!apiKey?.trim()) { showModal('ホストにはGemini APIキーが必要です。設定画面で入力してください。'); return; }
    if (!window.currentUserId) { showModal('Firebase認証中です。少し待ってください。'); return; }
    fbDb = window.fbDb;

    showScreen('screen-create-room');
    document.getElementById('room-creating').style.display = 'block';
    document.getElementById('room-lobby').style.display = 'none';

    try {
        const roomId = await createRoom();
        document.getElementById('room-id-display').textContent = roomId;
        document.getElementById('room-creating').style.display = 'none';
        document.getElementById('room-lobby').style.display = 'block';
        watchRoom(data => { if (data?.players) updateLobbyList(data.players, true); });
    } catch(e) { showModal('ルーム作成失敗: '+e.message); showScreen(Screen.TITLE); }
}

async function handleJoinRoom() {
    const roomIdInput = document.getElementById('input-room-id').value.trim().toUpperCase();
    if (!roomIdInput || roomIdInput.length !== 6) { showModal('6桁のルームIDを入力してください'); return; }
    const name = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME);
    if (!name?.trim()) { showModal('設定画面で名前を入力してください'); return; }
    if (!window.currentUserId) { showModal('Firebase認証中です。'); return; }
    fbDb = window.fbDb;

    try {
        multiplayerMode = true;
        await joinRoom(roomIdInput);
        document.getElementById('guest-room-id').textContent = roomIdInput;
        showScreen('screen-guest-lobby');

        // ルーム監視: ロビー表示 + ゲーム開始検知
        watchRoom(data => {
            if (!data) { showModal('ルームが解散されました'); showScreen(Screen.TITLE); return; }
            updateLobbyList(data.players, false);
            if (data.meta?.status === 'playing') {
                stopWatchingRoom();
                startWatchingGame();
            }
        });
    } catch(e) { showModal('参加失敗: '+e.message); multiplayerMode = false; }
}

function updateLobbyList(players, isHostView) {
    const listId = isHostView ? 'players-list' : 'guest-players-list';
    const countId = isHostView ? 'player-count' : 'guest-player-count';
    const el = document.getElementById(listId), count = document.getElementById(countId);
    if (!players) { el.innerHTML = '<p style="color:var(--color-text-muted)">参加者がいません</p>'; count.textContent = '0'; return; }
    const arr = Object.entries(players);
    count.textContent = arr.length;
    el.innerHTML = arr.map(([uid,p]) => `<div class="players-list-item ${p.isHost?'is-host':''}">${p.isHost?'👑':'👤'} ${escapeHtml(p.name)}${uid===window.currentUserId?' (あなた)':''}</div>`).join('');
}

async function handleLeaveRoom() {
    if (discussionTimer) { clearInterval(discussionTimer); discussionTimer = null; }
    stopWatchingGame();
    await leaveRoom();
    multiplayerMode = false;
    _lastPhaseVersion = 0;
    showScreen(Screen.TITLE);
}

// ============================================
// ホスト: ゲーム開始
// ============================================
async function handleHostStartGame() {
    const data = await fbGet(`rooms/${currentRoomId}`);
    if (!data?.players) return;
    const humanPlayers = Object.entries(data.players);
    if (humanPlayers.length < 1 || humanPlayers.length > 7) { showModal('参加者数が不正です'); return; }

    multiplayerMode = true;
    _mpHumanUids = humanPlayers.map(([uid]) => uid);
    await fbSet(`rooms/${currentRoomId}/meta/status`, 'playing');
    stopWatchingRoom();

    // ゲーム開始 → startMultiplayerGame がFirebaseに書き込み → watchGameで全員に反映
    startWatchingGame();
    await startMultiplayerGame(humanPlayers, 7 - humanPlayers.length);
}

// ============================================
// Firebase ゲーム状態監視(ホスト/ゲスト共通)
// ============================================
function startWatchingGame() {
    watchGame(async (gameData) => {
        if (!gameData) return;
        const version = gameData.phaseVersion || 0;
        if (version <= _lastPhaseVersion) return; // 二重処理防止
        _lastPhaseVersion = version;
        const phase = gameData.phase;
        const pd = gameData.phaseData || {};
        console.log(`[Game] Phase: ${phase}, isHost: ${isHost}`);

        switch(phase) {
            case 'characters':
                displayCharacters(pd.characters);
                showScreen(Screen.CHARACTERS);
                // ホスト: 全員readyを監視
                if (isHost) hostWaitAndAdvance('characters', async () => {
                    await fbClearReady('characters');
                    await fbWritePhase('role', {});
                });
                break;

            case 'role':
                // 全プレイヤーがFirebaseから自分の役職を取得
                try {
                    const myRole = await fbGetMyRole();
                    if (myRole) showRoleScreen(myRole);
                    else showWaiting('役職情報を待っています…', '');
                } catch(e) { showWaiting('役職取得中…', ''); }
                if (isHost) hostWaitAndAdvance('role', () => hostStartNight());
                break;

            case 'night':
                await handleNightPhase(pd);
                break;

            case 'morning':
                if (pd.day) window._mpDay = pd.day;
                window._mpSpeeches = pd.speeches || [];
                window._mpAlivePlayers = pd.alivePlayers || [];
                showMorningUI(pd.attackText);
                displaySpeeches(pd.speeches);
                if (isHost) hostWaitAndAdvance(`morning_day${pd.day}`, async () => {
                    await fbClearReady(`morning_day${pd.day}`);
                    await fbWritePhase('discussion', { day: pd.day, alivePlayers: pd.alivePlayers });
                });
                break;

            case 'discussion':
                // gameStateがない(ゲスト)場合でも議論画面を表示
                if (!gameState) {
                    window._mpAlivePlayers = pd.alivePlayers || [];
                    window._mpDay = pd.day || 1;
                }
                startDiscussionPhase();
                if (isHost) hostWaitAndAdvance(`discussion_day${pd.day}`, () => hostStartVoting(pd.day));
                break;

            case 'voting':
                if (pd.day) window._mpDay = pd.day;
                if (pd.alivePlayers) {
                    showVotingForPlayer(pd.alivePlayers);
                }
                break;

            case 'execution':
                if (pd.day) window._mpDay = pd.day;
                document.getElementById('execution-votes').innerHTML = pd.votesHtml || '';
                document.getElementById('execution-result').innerHTML = pd.resultHtml || '';
                document.getElementById('btn-continue').style.display = 'none';
                showScreen(Screen.EXECUTION);
                await sleep(4000);
                document.getElementById('btn-continue').style.display = 'flex';
                if (isHost) hostWaitAndAdvance(`execution_day${gameState.day}`, () => hostAdvanceDay());
                break;

            case 'result':
                if (gameData.result) {
                    if (gameState) showResultScreen();
                    else showResultFromFirebase(gameData.result);
                }
                break;
        }
    });
}

// ============================================
// ホスト: Ready待ち → 次のフェーズへ
// ============================================
async function hostWaitAndAdvance(readyPhase, advanceFn) {
    if (!isHost) return;
    if (!_mpHumanUids.length) _mpHumanUids = await fbGetHumanUids();
    const result = await waitForAllReadyWithTimeout(readyPhase, _mpHumanUids, 120000);
    console.log(`[Host] All ready for ${readyPhase}: ${result}`);
    await advanceFn();
}

// ============================================
// マルチプレイ: 夜フェーズ
// ============================================
async function handleNightPhase(pd) {
    const myRole = await fbGetMyRole();
    if (!myRole) { showWaiting('夜の処理中…', ''); return; }

    document.getElementById('night-title').textContent = pd.title || `Day ${pd.day || 1} - 夜`;
    document.getElementById('night-subtitle').textContent = '村は眠りについた…';

    const role = myRole.role;
    const day = pd.day || 1;
    const needsAction = (role === 'seer') || (role === 'knight' && day >= 2) || (role === 'werewolf' && day >= 2) || (role === 'medium');

    if (!needsAction || role === 'villager') {
        // 行動不要: 自動ready
        showScreen(Screen.NIGHT);
        document.getElementById('night-action').innerHTML = '<p class="night-action-desc">能力者たちが行動しています…</p>';
        await fbMarkReady(`night_day${day}`);
        return;
    }

    // ホストの場合: gameStateから自分のプレイヤーを取得してUI表示
    if (isHost && gameState) {
        const local = getLocalPlayer();
        if (local) {
            await showNightActionUI(local);
        } else {
            document.getElementById('night-action').innerHTML = '<p class="night-action-desc">行動中…</p>';
            showScreen(Screen.NIGHT);
            await fbMarkReady(`night_day${day}`);
        }
    } else {
        // ゲスト: 簡易夜アクション(役職情報のみで表示)
        showGuestNightAction(myRole, day);
    }
}

function showGuestNightAction(myRole, day) {
    const action = document.getElementById('night-action');
    document.getElementById('night-title').textContent = `Day ${day} - 夜`;
    showScreen(Screen.NIGHT);

    const role = myRole.role;

    if (role === 'medium') {
        if (day === 1) {
            action.innerHTML = `<div class="night-action-title">👻 霊媒師</div><p class="night-action-desc">今夜はまだ対象がいません</p><button class="btn-primary" onclick="guestFinishNight(${day})"><span class="btn-text">確認した</span></button>`;
        } else {
            action.innerHTML = `<div class="night-action-title">👻 霊媒師</div><p class="night-action-desc">ホストが霊媒結果を処理中です…</p><button class="btn-primary" onclick="guestFinishNight(${day})"><span class="btn-text">確認した</span></button>`;
        }
        return;
    }
    if (role === 'werewolf' && day === 1) {
        const allies = myRole.allies || [];
        action.innerHTML = `<div class="night-action-title">🐺 人狼</div><p class="night-action-desc">初日は仲間を確認しましょう。</p><div class="fortune-result"><div class="fortune-result-text">仲間の人狼</div><div class="fortune-result-role" style="color:var(--color-accent-red-glow);font-size:20px;margin-top:15px;">${escapeHtml(allies.join('、'))}</div></div><button class="btn-primary" onclick="guestFinishNight(${day})"><span class="btn-text">確認した</span></button>`;
        return;
    }
    if (role === 'knight' && day === 1) {
        action.innerHTML = `<div class="night-action-title">🛡️ 騎士</div><p class="night-action-desc">初日は護衛不要です。</p><button class="btn-primary" onclick="guestFinishNight(${day})"><span class="btn-text">確認した</span></button>`;
        return;
    }

    // ゲストの能力行使(対象選択はFirebase経由)
    // ゲストはgameStateを持っていないため、簡易版
    action.innerHTML = `<div class="night-action-title">${role==='seer'?'🔮 占い師':role==='knight'?'🛡️ 騎士':'🐺 人狼'}</div><p class="night-action-desc">ホストのゲーム画面で処理中です。しばらくお待ちください。</p><button class="btn-primary" onclick="guestFinishNight(${day})"><span class="btn-text">確認した</span></button>`;
}

async function guestFinishNight(day) {
    await fbMarkReady(`night_day${day}`);
    showWaiting('他のプレイヤーを待っています…', '');
}

// ============================================
// ホスト: 夜→朝の処理
// ============================================
async function hostStartNight() {
    await fbClearReady('role');
    gameState.phase = 'night';
    gameState.currentDayData = { attack: null, fortune: null, guard: null, medium: null, morningSpeeches: [], messages: [], votes: {}, execution: null };
    await fbWritePhase('night', { day: gameState.day, title: `Day ${gameState.day} - 夜` });

    // 全員のreadyを待ってから処理
    if (!_mpHumanUids.length) _mpHumanUids = await fbGetHumanUids();
    await waitForAllReadyWithTimeout(`night_day${gameState.day}`, _mpHumanUids, 90000);
    await fbClearReady(`night_day${gameState.day}`);

    // 夜アクション収集
    const actions = await fbGetNightActions(gameState.day);
    for (const [uid, act] of Object.entries(actions)) {
        if (!act || !act.targetName) continue;
        const player = gameState.players.find(p => p.character._userId === uid);
        if (!player) continue;
        if (act.role === 'werewolf') gameState.currentDayData._humanAttackChoice = act.targetName;
        else if (act.role === 'seer') {
            const t = findPlayerByName(act.targetName);
            if (t) { gameState.fortuneResults.push({ target: t.name, isWerewolf: t.role === 'werewolf' }); gameState.currentDayData.fortune = { target: t.name, isWerewolf: t.role === 'werewolf' }; }
        } else if (act.role === 'knight') gameState.currentDayData.guard = act.targetName;
    }

    await processAINightActions();
    await startMorningPhase();
}

// ============================================
// ホスト: 投票処理
// ============================================
async function hostStartVoting(day) {
    await fbClearReady(`discussion_day${day}`);

    // 伝言を収集
    const msgs = await fbGetMessages(day);
    msgs.forEach(m => {
        if (m?.text && !gameState.currentDayData.messages.find(x => x.from === m.from && x.text === m.text)) {
            gameState.currentDayData.messages.push({ from: m.from, text: m.text });
        }
    });

    // AI投票を計算
    showScreen(Screen.VOTING_PROCESS);
    await calculateAIVotes();

    // 投票フェーズをブロードキャスト
    const alivePlayers = getAlivePlayers().map(p => ({ name: p.name, avatar: p.avatar, isHuman: p.isHuman }));
    await fbWritePhase('voting', { alivePlayers, day });

    // 全人間の投票を待つ
    const aliveHumanUids = gameState.players.filter(p => p.isHuman && p.isAlive && p.character._userId).map(p => p.character._userId);
    if (aliveHumanUids.length > 0) {
        // 投票をポーリングで待つ(30秒タイムアウト)
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            const votes = await fbGetVotes(day);
            const allVoted = aliveHumanUids.every(uid => votes[uid]);
            if (allVoted) {
                // 全員の投票をgameStateに反映
                for (const [uid, target] of Object.entries(votes)) {
                    const player = gameState.players.find(p => p.character._userId === uid);
                    if (player) gameState.currentDayData.votes[player.name] = target;
                }
                break;
            }
            await sleep(2000);
        }
    }

    await processVoting();
}

function showVotingForPlayer(alivePlayers) {
    const grid = document.getElementById('voting-grid');
    grid.innerHTML = '';
    const myName = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME);
    alivePlayers.filter(p => p.name !== myName).forEach(p => {
        const el = document.createElement('div');
        el.className = 'voting-target';
        el.innerHTML = `<div class="voting-target-emoji">${p.avatar}</div><div class="voting-target-name">${escapeHtml(p.name)}</div>`;
        el.addEventListener('click', () => {
            showConfirm(`<strong>${escapeHtml(p.name)}</strong> に投票しますか?`, '投票する').then(async ok => {
                if (!ok) return;
                const day = gameState ? gameState.day : (window._mpDay || 1);
                await fbSubmitVote(day, p.name);
                showWaiting('投票を送信しました', '結果を待っています…');
            });
        });
        grid.appendChild(el);
    });
    showScreen(Screen.VOTING);
}

// ============================================
// ホスト: 次の日へ進める
// ============================================
async function hostAdvanceDay() {
    await fbClearReady(`execution_day${gameState.day}`);
    gameState.history.push(buildDayHistory());
    const winner = checkWinCondition();
    if (winner) { gameState.winner = winner; await broadcastResult(); return; }
    gameState.day++;
    if (gameState.day > 10) { gameState.winner = 'werewolf'; await broadcastResult(); return; }
    await hostStartNight();
}

// ============================================
// 初期化
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('click', e => {
        const t = e.target.closest('[data-action]');
        if (t) handleAction(t.dataset.action);
    });
    document.getElementById('modal-overlay').addEventListener('click', e => { if(e.target.id==='modal-overlay') closeModal(); });
    document.getElementById('char-modal').addEventListener('click', e => { if(e.target.id==='char-modal') closeCharacterModal(); });

    let saveTimer;
    ['input-name','input-api-key'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.addEventListener('input', () => {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => localStorage.setItem(id==='input-name'?STORAGE_KEYS.PLAYER_NAME:STORAGE_KEYS.API_KEY, el.value.trim()), 500);
        });
    });
    document.querySelectorAll('input[name="model"]').forEach(r => r.addEventListener('change', () => localStorage.setItem(STORAGE_KEYS.MODEL, r.value)));
    const msgInput = document.getElementById('message-input');
    if(msgInput) msgInput.addEventListener('input', e => document.getElementById('message-count').textContent = `${e.target.value.length}/100`);

    window.addEventListener('firebase-ready', () => { console.log('🔥 Firebase ready:', window.currentUserId); fbDb = window.fbDb; });

    if (!localStorage.getItem(STORAGE_KEYS.HAS_ONBOARDED)) {
        setTimeout(() => {
            showModal('🌙 ようこそ、月夜の村へ。<br><br>遊ぶ前に<strong>設定画面</strong>で<strong>名前</strong>を入力してください。<br><br>1人プレイ・ルーム作成には<strong>Gemini APIキー</strong>が必要です。<br>ルーム参加のみならAPIキー不要です。');
            localStorage.setItem(STORAGE_KEYS.HAS_ONBOARDED, 'true');
        }, 500);
    }
    console.log('🌙 月夜の村に狼が来る v0.5.0 起動');
});
