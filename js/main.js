/* ============================================
   main.js v0.5.0 - 同期修正版

   【設計原則】
   - ソロとマルチで挙動を分岐: multiplayerMode && !isHost がゲスト
   - ゲストは sync を turnId で追跡、各フェーズで適切な画面を表示
   - ゲストのアクションは inbox に送信
   ============================================ */

let currentScreen = Screen.TITLE;
// multiplayerMode / isHost は firebase.js / game.js のグローバル

// ゲスト側の状態
const guestState = {
    role: null,              // {role, allies, playerName}
    alivePlayers: [],
    currentDay: 0,
    speeches: [],            // 今日の発言
    historySpeeches: [],     // 過去の発言
    lastTurnId: -1,
    phaseEndTime: 0,
    timerInterval: null,
    morningSpeakingDone: false
};

// ============================================
// UIヘルパー
// ============================================
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) { target.classList.add('active'); currentScreen = screenId; window.scrollTo({ top: 0, behavior: 'instant' }); }
}
function showModal(message) { document.getElementById('modal-message').innerHTML = message; document.getElementById('modal-overlay').classList.add('active'); }
function closeModal() { document.getElementById('modal-overlay').classList.remove('active'); }
function showConfirm(message, okText = 'OK', cancelText = 'キャンセル') {
    return new Promise((resolve) => {
        document.getElementById('confirm-message').innerHTML = message;
        const yesBtn = document.getElementById('btn-confirm-yes');
        const noBtn = document.getElementById('btn-confirm-no');
        yesBtn.textContent = okText; noBtn.textContent = cancelText;
        const modal = document.getElementById('confirm-modal');
        modal.classList.add('active');
        const cleanup = () => { modal.classList.remove('active'); yesBtn.removeEventListener('click', onYes); noBtn.removeEventListener('click', onNo); };
        const onYes = () => { cleanup(); resolve(true); };
        const onNo = () => { cleanup(); resolve(false); };
        yesBtn.addEventListener('click', onYes);
        noBtn.addEventListener('click', onNo);
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
    const model = localStorage.getItem(STORAGE_KEYS.MODEL) || 'gemini-2.5-flash';
    const radio = document.querySelector(`input[name="model"][value="${model}"]`);
    if (radio) radio.checked = true;
}
function toggleApiKeyVisibility() { const i = document.getElementById('input-api-key'); i.type = i.type === 'password' ? 'text' : 'password'; }
async function clearApiKey() {
    const ok = await showConfirm('APIキーをクリアしますか?', '削除する');
    if (!ok) return;
    document.getElementById('input-api-key').value = '';
    localStorage.removeItem(STORAGE_KEYS.API_KEY);
    showModal('APIキーをクリアしました。');
}

function isGuestInMultiplayer() { return multiplayerMode && !isHost; }

// ============================================
// アクションハンドラ
// ============================================
function handleAction(action) {
    switch (action) {
        case 'start-solo': startSoloGame(); break;
        case 'show-create-room': handleCreateRoom(); break;
        case 'show-join-room': showScreen('screen-join-room'); break;
        case 'do-join-room': handleJoinRoom(); break;
        case 'copy-room-id': copyRoomId(); break;
        case 'host-start-game': handleHostStartGame(); break;
        case 'leave-room': handleLeaveRoom(); break;
        case 'show-rules': showScreen(Screen.RULES); break;
        case 'show-settings': loadSettings(); showScreen(Screen.SETTINGS); break;
        case 'back-to-title': if (currentScreen === Screen.SETTINGS) saveSettings(); showScreen(Screen.TITLE); break;
        case 'back-to-result': showScreen(Screen.RESULT); break;
        case 'toggle-api-visibility': toggleApiKeyVisibility(); break;
        case 'clear-api-key': clearApiKey(); break;
        case 'close-modal': closeModal(); break;

        // ゲーム進行
        case 'go-to-role':
            if (isGuestInMultiplayer()) {
                showGuestRoleFromFirebase();
            } else {
                hostProceedToRole();
            }
            break;

        case 'role-confirmed':
            if (isGuestInMultiplayer()) {
                showGuestWaiting('他のプレイヤーを待っています…', 'ホストが夜を進行します');
            } else {
                hostProceedToNight();
            }
            break;

        case 'go-to-discussion':
            if (isGuestInMultiplayer()) {
                // ゲストは morning 画面から discussion フェーズを sync で自動的に受信する
                // 手動でも進めるようにするが、まだ来てなければ待機
                showGuestWaiting('議論開始を待っています…', 'ホストが議論フェーズに移行中');
            } else {
                startDiscussionPhase();
            }
            break;

        case 'end-discussion':
            if (isGuestInMultiplayer()) {
                handleGuestEndDiscussion();
            } else {
                showConfirm('議論を終了して投票に移りますか?', '終了する').then(ok => { if (ok) endDiscussion(); });
            }
            break;

        case 'continue-game':
            if (isGuestInMultiplayer()) {
                showGuestWaiting('次のフェーズを待っています…', 'ホストがゲームを進行中');
            } else {
                continueGame();
            }
            break;

        case 'show-thoughts': showThoughtsScreen(); break;
        case 'play-again':
            if (multiplayerMode) {
                handleLeaveRoom();
            } else {
                startSoloGame();
            }
            break;
        default: console.warn('Unknown action:', action);
    }
}

// ============================================
// ゲスト共通: 待機画面
// ============================================
function showGuestWaiting(title, subtitle) {
    document.getElementById('loading-title').textContent = title;
    document.getElementById('loading-message').textContent = subtitle || '';
    showScreen(Screen.LOADING);
}

// ============================================
// ゲスト: 役職取得
// ============================================
async function showGuestRoleFromFirebase() {
    showGuestWaiting('役職を確認しています…', '');
    // 最大 10 秒リトライ
    let tries = 0;
    while (tries < 10) {
        const myRole = await getMyRole();
        if (myRole && myRole.role) {
            guestState.role = myRole;
            const role = ROLES[myRole.role];
            if (!role) { showGuestWaiting('役職情報が不正です', ''); return; }
            document.getElementById('role-greeting').textContent = `${myRole.playerName || 'あなた'}さん、あなたの役職は…`;
            document.getElementById('role-icon').textContent = role.icon;
            document.getElementById('role-name').textContent = role.name;
            document.getElementById('role-description').textContent = role.description;
            if (myRole.role === 'werewolf' && myRole.allies && myRole.allies.length > 0) {
                document.getElementById('role-allies').textContent = `🐺 仲間: ${myRole.allies.join('、')}`;
                document.getElementById('role-allies').style.display = 'block';
            } else {
                document.getElementById('role-allies').style.display = 'none';
            }
            showScreen(Screen.ROLE);
            return;
        }
        await sleep(1000); tries++;
    }
    showGuestWaiting('役職情報を取得できませんでした', 'しばらくお待ちください');
}

// ============================================
// ゲスト: キャラ一覧表示
// ============================================
function displayGuestCharacters(characters) {
    const grid = document.getElementById('characters-grid');
    grid.innerHTML = '';
    characters.forEach(c => {
        const card = document.createElement('div');
        card.className = 'character-card' + (c.isHuman ? ' is-human' : '');
        const tagsHtml = c.isHuman ? '' :
            `<div class="char-tags-emphasized">${(c.personality_tags || []).map(t => '<span class="tag-chip-small">#' + escapeHtml(t) + '</span>').join('')}</div>`;
        card.innerHTML = `
            <div class="char-avatar">${c.avatar}</div>
            <div class="char-name">${escapeHtml(c.name)}</div>
            <div class="char-occupation">${escapeHtml(c.occupation || '')}</div>
            ${tagsHtml}
            <div class="char-badge ${c.isHuman ? 'human' : 'ai'}">${c.isHuman ? '👤 Player' : '🤖 AI'}</div>
        `;
        if (!c.isHuman) {
            card.addEventListener('click', () => showGuestCharacterModal(c));
        }
        grid.appendChild(card);
    });
}

function showGuestCharacterModal(c) {
    document.getElementById('char-modal-content').innerHTML = `
        <div class="modal-avatar">${c.avatar}</div>
        <h3 class="modal-name">${escapeHtml(c.name)}</h3>
        <p class="modal-info">${escapeHtml(c.age || '')}${c.age ? '歳・' : ''}${escapeHtml(c.occupation || '')}</p>
        <div class="modal-tags-emphasized">${(c.personality_tags || []).map(t => '<span class="tag-chip">#' + escapeHtml(t) + '</span>').join('')}</div>
        ${c.catchphrase ? `<div class="modal-catchphrase">「${escapeHtml(c.catchphrase)}」</div>` : ''}
        ${c.background ? `<div class="modal-background-text">${escapeHtml(c.background)}</div>` : ''}
        <div class="modal-buttons" style="margin-top: 20px;">
            <button class="btn-primary" onclick="document.getElementById('char-modal').classList.remove('active')">閉じる</button>
        </div>
    `;
    document.getElementById('char-modal').classList.add('active');
}

// ============================================
// ゲスト: 夜フェーズ
// ============================================
async function showGuestNightScreen(payload) {
    document.getElementById('night-title').textContent = payload.title || `Day ${guestState.currentDay} - 夜`;
    document.getElementById('night-subtitle').textContent = '村は眠りについた…';

    if (!guestState.role) {
        const r = await getMyRole(); if (r) guestState.role = r;
    }
    const role = guestState.role?.role;
    const actionEl = document.getElementById('night-action');

    if (!role) {
        actionEl.innerHTML = `<p class="night-action-desc">役職情報を読み込めません…</p>`;
        showScreen(Screen.NIGHT); return;
    }

    // 死亡チェック (ゲストはプレイヤー死亡状態を payload から推定)
    const myName = guestState.role.playerName;
    const alivePlayerNames = (payload.alivePlayers || []).map(p => p.name);
    const iAmAlive = alivePlayerNames.includes(myName);

    if (!iAmAlive) {
        actionEl.innerHTML = `<p class="night-action-desc">あなたは亡くなっています。観戦中…</p>`;
        showScreen(Screen.NIGHT); return;
    }

    // 村人
    if (role === 'villager') {
        actionEl.innerHTML = `<p class="night-action-desc">村人は夜に行動できません。能力者の行動を待っています…</p><div class="loading-spinner" style="margin:20px auto;"></div>`;
        showScreen(Screen.NIGHT); return;
    }

    // 霊媒師
    if (role === 'medium') {
        if (guestState.currentDay === 1) {
            actionEl.innerHTML = `<div class="night-action-title">👻 霊媒師</div>
                <p class="night-action-desc">今夜はまだ霊媒の対象がいません</p>
                <button class="btn-primary" onclick="guestFinishNight()"><span class="btn-text">確認した</span></button>`;
        } else {
            // Firebase から自分宛ての霊媒結果を取得
            const result = await fbGet(`rooms/${currentRoomId}/privateResults/day${guestState.currentDay}/medium/${getCurrentUserId()}`);
            if (result) {
                actionEl.innerHTML = `<div class="night-action-title">👻 霊媒師</div>
                    <p class="night-action-desc">昨日処刑された…</p>
                    <div class="fortune-result">
                        <div class="fortune-result-text">${escapeHtml(result.target)}</div>
                        <div class="fortune-result-text" style="margin-top:15px;">その正体は</div>
                        <div class="fortune-result-role">${ROLES[result.role].icon} ${ROLES[result.role].name}</div>
                    </div>
                    <button class="btn-primary" onclick="guestFinishNight()"><span class="btn-text">確認した</span></button>`;
            } else {
                actionEl.innerHTML = `<div class="night-action-title">👻 霊媒師</div>
                    <p class="night-action-desc">霊媒結果を待っています…</p><div class="loading-spinner" style="margin:20px auto;"></div>`;
                // 1.5 秒後リトライ
                setTimeout(() => showGuestNightScreen(payload), 1500);
            }
        }
        showScreen(Screen.NIGHT); return;
    }

    // Day1 人狼 → 仲間確認のみ
    if (role === 'werewolf' && guestState.currentDay === 1) {
        const allies = guestState.role.allies || [];
        actionEl.innerHTML = `<div class="night-action-title">🐺 人狼</div>
            <p class="night-action-desc">初日は様子を見る夜です。仲間を覚えておきましょう。</p>
            <div class="fortune-result">
                <div class="fortune-result-text">あなたの仲間の人狼</div>
                <div class="fortune-result-role" style="color: var(--color-accent-red-glow); font-size: 20px; margin-top: 15px;">${escapeHtml(allies.join('、'))}</div>
            </div>
            <button class="btn-primary" onclick="guestFinishNight()"><span class="btn-text">確認した</span></button>`;
        showScreen(Screen.NIGHT); return;
    }

    // Day1 騎士
    if (role === 'knight' && guestState.currentDay === 1) {
        actionEl.innerHTML = `<div class="night-action-title">🛡️ 騎士</div>
            <p class="night-action-desc">初日の夜は襲撃がないため、護衛の必要はありません。</p>
            <button class="btn-primary" onclick="guestFinishNight()"><span class="btn-text">確認した</span></button>`;
        showScreen(Screen.NIGHT); return;
    }

    // 対象選択画面 (人狼/占い師/騎士)
    let title, desc;
    if (role === 'werewolf') { title = '🐺 誰を襲撃する?'; desc = '仲間の人狼と協力して村人を倒しましょう'; }
    else if (role === 'seer') { title = '🔮 誰を占う?'; desc = '選んだ人が人狼かどうかが分かります'; }
    else if (role === 'knight') { title = '🛡️ 誰を守る?'; desc = '選んだ人を今夜の人狼襲撃から守ります'; }

    let targets = (payload.alivePlayers || []).filter(p => p.name !== myName);
    if (role === 'werewolf') {
        const allies = guestState.role.allies || [];
        targets = targets.filter(p => !allies.includes(p.name));
    }
    const gridHtml = targets.map(p => `
        <div class="night-target" data-target-name="${escapeHtml(p.name)}" onclick="guestSelectNightTarget('${escapeHtml(p.name)}', this)">
            <div class="night-target-emoji">${p.avatar}</div>
            <div class="night-target-name">${escapeHtml(p.name)}</div>
        </div>`).join('');
    actionEl.innerHTML = `<div class="night-action-title">${title}</div>
        <p class="night-action-desc">${desc}</p>
        <div class="night-target-grid">${gridHtml}</div>
        <div id="night-confirm-area"></div>`;
    showScreen(Screen.NIGHT);
}

let _guestSelectedTarget = null;
function guestSelectNightTarget(targetName, el) {
    _guestSelectedTarget = targetName;
    document.querySelectorAll('.night-target').forEach(n => n.classList.remove('selected'));
    el.classList.add('selected');
    document.getElementById('night-confirm-area').innerHTML = `
        <button class="btn-primary" style="margin-top: 20px;" onclick="guestConfirmNight()"><span class="btn-text">決定</span></button>`;
}

async function guestConfirmNight() {
    if (!_guestSelectedTarget) return;
    const target = _guestSelectedTarget;
    const role = guestState.role?.role;
    try {
        await submitNightAction(guestState.currentDay, { targetName: target });
    } catch (e) {
        showModal('送信エラー: ' + e.message); return;
    }

    // 占い師 → 結果を Firebase から取得して表示
    if (role === 'seer') {
        document.getElementById('night-action').innerHTML = `
            <div class="night-action-title">🔮 占い中…</div>
            <p class="night-action-desc">${escapeHtml(target)} を占っています</p>
            <div class="loading-spinner" style="margin:20px auto;"></div>`;
        // 結果を待機
        let tries = 0;
        while (tries < 30) {
            await sleep(1000);
            const result = await fbGet(`rooms/${currentRoomId}/privateResults/day${guestState.currentDay}/fortune/${getCurrentUserId()}`);
            if (result) {
                document.getElementById('night-action').innerHTML = `
                    <div class="night-action-title">🔮 占いの結果</div>
                    <div class="fortune-result">
                        <div class="fortune-result-text">${escapeHtml(result.target)} の正体は</div>
                        <div class="fortune-result-role" style="color: ${result.isWerewolf ? 'var(--color-accent-red-glow)' : 'var(--color-accent-moon)'};">
                            ${result.isWerewolf ? '🐺 人狼' : '✨ 人狼ではない'}
                        </div>
                    </div>
                    <button class="btn-primary" onclick="guestFinishNight()"><span class="btn-text">確認した</span></button>`;
                _guestSelectedTarget = null;
                return;
            }
            tries++;
        }
        // タイムアウト: ホストが進んだ可能性
        document.getElementById('night-action').innerHTML = `
            <p class="night-action-desc">結果を受信できませんでした。次のフェーズをお待ちください…</p>`;
    } else {
        _guestSelectedTarget = null;
        guestFinishNight();
    }
}

function guestFinishNight() {
    document.getElementById('night-action').innerHTML = `<p class="night-action-desc">他の能力者たちが行動しています…</p><div class="loading-spinner" style="margin:20px auto;"></div>`;
}

// ============================================
// ゲスト: 朝フェーズ
// ============================================
function showGuestMorning(payload) {
    document.getElementById('morning-title').textContent = payload.title || `朝がきた - Day ${guestState.currentDay}`;
    document.getElementById('morning-attack-result').innerHTML = payload.attackHtml || '';
    const container = document.getElementById('speeches-container');

    const speeches = payload.speeches || [];
    guestState.speeches = speeches;
    guestState.alivePlayers = payload.alivePlayers || [];

    // 差分更新: 既に表示済みの発言は再表示しない
    const currentCount = container.querySelectorAll('.speech-bubble').length;
    for (let i = currentCount; i < speeches.length; i++) {
        const s = speeches[i];
        const bubble = document.createElement('div');
        bubble.className = 'speech-bubble';
        bubble.innerHTML = `<div class="speech-header">
            <span class="speech-avatar">${s.avatar || '🤖'}</span>
            <span class="speech-name">${escapeHtml(s.name)}</span>
            <span class="speech-badge">AI</span>
        </div><div class="speech-text">「${escapeHtml(s.speech)}」</div>`;
        container.appendChild(bubble);
        if (i === speeches.length - 1) bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    const btn = document.getElementById('btn-to-discussion');
    if (payload.allSpeakingDone) {
        btn.style.display = 'flex';
        guestState.morningSpeakingDone = true;
    } else {
        btn.style.display = 'none';
        guestState.morningSpeakingDone = false;
    }

    showScreen(Screen.MORNING);
}

// ============================================
// ゲスト: 議論フェーズ
// ============================================
function showGuestDiscussion(payload) {
    guestState.alivePlayers = payload.alivePlayers || [];
    guestState.speeches = payload.speeches || [];
    guestState.historySpeeches = payload.historySpeeches || [];

    document.getElementById('discussion-day').textContent = `Day ${guestState.currentDay}`;
    document.getElementById('message-input').value = '';
    document.getElementById('message-count').textContent = '0/100';
    document.getElementById('discussion-timer').classList.remove('warning');

    // 生存プレイヤー表示
    const container = document.getElementById('alive-players');
    container.innerHTML = '';
    const aliveSet = new Set(guestState.alivePlayers.map(p => p.name));
    // ゲストは全プレイヤーリストを持っていないので、alivePlayers のみを表示
    guestState.alivePlayers.forEach(p => {
        const el = document.createElement('div');
        el.className = 'alive-player';
        el.innerHTML = `<div class="alive-player-emoji">${p.avatar}</div>
            <div class="alive-player-name">${escapeHtml(p.name)}</div>
            <div class="alive-player-badge">${p.isHuman ? '👤' : '🤖'}</div>`;
        container.appendChild(el);
    });

    // 人狼仲間
    const box = document.getElementById('werewolf-allies-box');
    const namesEl = document.getElementById('werewolf-allies-names');
    if (guestState.role && guestState.role.role === 'werewolf') {
        const allies = guestState.role.allies || [];
        namesEl.innerHTML = '🐺 ' + allies.map(n => escapeHtml(n)).join('、');
        box.style.display = 'block';
    } else { box.style.display = 'none'; }

    // 発言ログ (履歴 + 今日)
    const listEl = document.getElementById('speech-log-list');
    listEl.innerHTML = '';
    const allSpeeches = [
        ...guestState.historySpeeches,
        ...guestState.speeches.map(s => ({ ...s, day: guestState.currentDay }))
    ];
    if (allSpeeches.length === 0) {
        listEl.innerHTML = '<p style="color:var(--color-text-muted);font-size:13px;padding:10px;text-align:center;">まだ発言がありません</p>';
    } else {
        allSpeeches.forEach(s => {
            const item = document.createElement('div');
            item.className = 'speech-log-item';
            item.innerHTML = `<div class="speech-log-header">
                <span class="speech-log-avatar">${s.avatar || '🤖'}</span>
                <span class="speech-log-name">${escapeHtml(s.name)}</span>
                <span class="speech-log-day">Day ${s.day}</span>
            </div><div class="speech-log-text">「${escapeHtml(s.speech)}」</div>`;
            listEl.appendChild(item);
        });
    }

    // 自分が生存しているか
    const myName = guestState.role?.playerName;
    const iAmAlive = aliveSet.has(myName);
    const messageBox = document.getElementById('message-box-wrapper');
    const endBtn = document.getElementById('btn-end-discussion');
    const deadBox = document.getElementById('dead-spectator-box');
    const bottomSection = document.querySelector('.discussion-bottom');
    if (iAmAlive) {
        if (messageBox) messageBox.style.display = '';
        if (endBtn) endBtn.style.display = '';
        if (deadBox) deadBox.style.display = 'none';
        if (bottomSection) bottomSection.style.display = '';
    } else {
        if (messageBox) messageBox.style.display = 'none';
        if (endBtn) endBtn.style.display = 'none';
        if (bottomSection) bottomSection.style.display = 'none';
        if (deadBox) deadBox.style.display = 'block';
    }

    // タイマー同期
    guestState.phaseEndTime = payload.endTime || (Date.now() + 180 * 1000);
    if (guestState.timerInterval) clearInterval(guestState.timerInterval);
    const updateTimer = () => {
        const remaining = Math.max(0, Math.ceil((guestState.phaseEndTime - Date.now()) / 1000));
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        document.getElementById('discussion-timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
        if (remaining <= 30) document.getElementById('discussion-timer').classList.add('warning');
        if (remaining <= 0) {
            clearInterval(guestState.timerInterval); guestState.timerInterval = null;
            // ゲストは自動で伝言を送信して待機画面に移行
            submitGuestMessageAndWait();
        }
    };
    updateTimer();
    guestState.timerInterval = setInterval(updateTimer, 500);

    showScreen(Screen.DISCUSSION);
}

async function handleGuestEndDiscussion() {
    const ok = await showConfirm('議論を終了して伝言を送信しますか?<br><small>投票画面に進むにはホスト側のタイマー終了を待ちます</small>', '送信する');
    if (!ok) return;
    await submitGuestMessageAndWait();
}

async function submitGuestMessageAndWait() {
    if (guestState.timerInterval) { clearInterval(guestState.timerInterval); guestState.timerInterval = null; }
    const msgEl = document.getElementById('message-input');
    const message = msgEl ? msgEl.value.trim() : '';
    if (message) {
        try { await submitMessage(guestState.currentDay, message); }
        catch(e) { console.error('伝言送信エラー:', e); }
    }
    showGuestWaiting('投票を待っています…', 'ホストが投票を処理中');
}

// ============================================
// ゲスト: 投票画面
// ============================================
function showGuestVoting(payload) {
    const alivePlayers = payload.alivePlayers || [];
    const myName = guestState.role?.playerName;
    const aliveSet = new Set(alivePlayers.map(p => p.name));
    const iAmAlive = aliveSet.has(myName);

    if (!iAmAlive) {
        showGuestWaiting('投票中…', '他のプレイヤーの投票を待っています');
        return;
    }

    const grid = document.getElementById('voting-grid');
    grid.innerHTML = '';
    alivePlayers.filter(p => p.name !== myName).forEach(p => {
        const el = document.createElement('div');
        el.className = 'voting-target';
        el.innerHTML = `<div class="voting-target-emoji">${p.avatar}</div><div class="voting-target-name">${escapeHtml(p.name)}</div>`;
        el.addEventListener('click', () => {
            showConfirm(`<strong>${escapeHtml(p.name)}</strong> に投票しますか?`, '投票する').then(async ok => {
                if (!ok) return;
                try {
                    await submitVote(guestState.currentDay, p.name);
                    showGuestWaiting('投票を送信しました', '結果を待っています…');
                } catch(e) { showModal('投票送信エラー: ' + e.message); }
            });
        });
        grid.appendChild(el);
    });
    showScreen(Screen.VOTING);
}

// ============================================
// ゲスト: 処刑演出
// ============================================
function showGuestExecution(payload) {
    document.getElementById('execution-votes').innerHTML = payload.votesHtml || '';
    document.getElementById('execution-result').innerHTML = payload.resultHtml || '';
    const btn = document.getElementById('btn-continue');
    btn.style.display = payload.canContinue ? 'flex' : 'none';
    // ゲストは自動で次フェーズを受信するため、ボタンは「お知らせ」のみ
    btn.onclick = null;
    showScreen(Screen.EXECUTION);
}

// ============================================
// ゲスト: 結果画面
// ============================================
function showGuestResult(payload) {
    const isVW = payload.winner === 'villager';
    document.getElementById('result-icon').textContent = isVW ? '☀️' : '🐺';
    const titleEl = document.getElementById('result-title');
    titleEl.textContent = isVW ? '村人陣営の勝利' : '人狼陣営の勝利';
    titleEl.className = 'result-title' + (isVW ? '' : ' werewolf-win');
    const playersEl = document.getElementById('result-players');
    playersEl.innerHTML = '';
    (payload.players || []).forEach(p => {
        const el = document.createElement('div');
        el.className = 'result-player' + (p.isAlive ? '' : ' dead') + (p.role === 'werewolf' ? ' werewolf-role' : '');
        el.innerHTML = `<div class="result-player-emoji">${p.isAlive ? p.avatar : '🪦'}</div>
            <div class="result-player-name">${escapeHtml(p.name)}</div>
            <div class="result-player-role">${ROLES[p.role].icon} ${ROLES[p.role].name}</div>`;
        playersEl.appendChild(el);
    });
    showScreen(Screen.RESULT);
}

// ============================================
// ゲスト: sync の受信ハンドラ (唯一の画面遷移入口)
// ============================================
function handleGuestSyncUpdate(sync) {
    if (!sync || typeof sync !== 'object') return;
    if (sync.turnId <= guestState.lastTurnId) return;   // 重複防止
    guestState.lastTurnId = sync.turnId;
    guestState.currentDay = sync.day || 0;
    const payload = sync.payload || {};
    console.log(`[Guest] Sync turn=${sync.turnId} phase=${sync.phase} day=${sync.day}`);

    switch (sync.phase) {
        case Phase.LOBBY:
            // ロビーは players 監視で処理済み
            break;
        case Phase.CHARACTERS:
            if (payload.characters) {
                displayGuestCharacters(payload.characters);
                showScreen(Screen.CHARACTERS);
            }
            break;
        case Phase.ROLE:
            showGuestRoleFromFirebase();
            break;
        case Phase.NIGHT:
            showGuestNightScreen(payload);
            break;
        case Phase.MORNING:
            showGuestMorning(payload);
            break;
        case Phase.DISCUSSION:
            showGuestDiscussion(payload);
            break;
        case Phase.VOTING:
            showGuestVoting(payload);
            break;
        case Phase.EXECUTION:
            showGuestExecution(payload);
            break;
        case Phase.RESULT:
            showGuestResult(payload);
            break;
        default:
            console.warn('Unknown phase:', sync.phase);
    }
}

// ============================================
// マルチプレイ: ルーム作成 (ホスト)
// ============================================
async function handleCreateRoom() {
    const name = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME);
    const apiKey = localStorage.getItem(STORAGE_KEYS.API_KEY);
    if (!name || !name.trim()) { showModal('設定画面で名前を入力してください'); return; }
    if (!apiKey || !apiKey.trim()) { showModal('ホストにはGemini APIキーが必要です。<br>設定画面で入力してください。'); return; }
    if (!window.currentUserId) { showModal('Firebase認証中です。少し待ってからお試しください。'); return; }

    showScreen('screen-create-room');
    document.getElementById('room-creating').style.display = 'block';
    document.getElementById('room-lobby').style.display = 'none';

    try {
        fbDb = window.fbDb;
        const roomId = await createRoom();
        document.getElementById('room-id-display').textContent = roomId;
        document.getElementById('room-creating').style.display = 'none';
        document.getElementById('room-lobby').style.display = 'block';

        // プレイヤー一覧を監視
        watchPlayers((players) => {
            updateLobbyPlayersList(players, true);
        });
    } catch (error) {
        console.error(error);
        showModal('ルーム作成に失敗: ' + error.message);
        showScreen(Screen.TITLE);
    }
}

// ============================================
// マルチプレイ: ルーム参加 (ゲスト)
// ============================================
async function handleJoinRoom() {
    const roomIdInput = document.getElementById('input-room-id').value.trim().toUpperCase();
    if (!roomIdInput || roomIdInput.length !== 6) { showModal('6桁のルームIDを入力してください'); return; }
    const name = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME);
    if (!name || !name.trim()) { showModal('設定画面で名前を入力してください'); return; }
    if (!window.currentUserId) { showModal('Firebase認証中です。'); return; }

    try {
        fbDb = window.fbDb;
        await joinRoom(roomIdInput);
        multiplayerMode = true;
        document.getElementById('guest-room-id').textContent = roomIdInput;
        showScreen('screen-guest-lobby');

        // ゲスト: 自分のプレイヤー一覧を監視 (ロビー表示用)
        watchPlayers((players) => {
            if (!players) { showModal('ルームが解散されました'); handleLeaveRoom(); return; }
            updateLobbyPlayersList(players, false);
        });

        // メタ監視: ゲーム開始/終了を検知
        watchMeta((meta) => {
            if (!meta) return;
            if (meta.status === 'playing') {
                // sync 購読を開始 (既に購読中ならスキップ)
                // 実際は下の watchSync が即座に最新状態を配信する
            }
        });

        // sync 監視: これが唯一の画面遷移経路
        watchSync((sync) => {
            if (!sync) return;
            handleGuestSyncUpdate(sync);
        });

    } catch (error) {
        showModal('参加失敗: ' + error.message);
    }
}

function updateLobbyPlayersList(players, isHostView) {
    const listId = isHostView ? 'players-list' : 'guest-players-list';
    const countId = isHostView ? 'player-count' : 'guest-player-count';
    const listEl = document.getElementById(listId);
    const countEl = document.getElementById(countId);
    if (!listEl || !countEl) return;
    if (!players) { listEl.innerHTML = '<p style="color:var(--color-text-muted)">参加者がいません</p>'; countEl.textContent = '0'; return; }
    const arr = Object.entries(players);
    countEl.textContent = arr.length;
    listEl.innerHTML = arr.map(([uid, p]) => `
        <div class="players-list-item ${p.isHost ? 'is-host' : ''}">
            ${p.isHost ? '👑' : '👤'} ${escapeHtml(p.name)}${uid === window.currentUserId ? ' (あなた)' : ''}
        </div>`).join('');
}

function copyRoomId() {
    const roomId = document.getElementById('room-id-display').textContent;
    navigator.clipboard.writeText(roomId).then(() => showModal(`ルームID「${roomId}」をコピーしました`));
}

// ============================================
// ホスト: ゲーム開始
// ============================================
async function handleHostStartGame() {
    if (!currentRoomId) return;
    const roomData = await fbGet(`rooms/${currentRoomId}`);
    if (!roomData || !roomData.players) return;

    const humanEntries = Object.entries(roomData.players);
    if (humanEntries.length < 1 || humanEntries.length > 7) { showModal('参加者数が不正です(1〜7人)'); return; }

    multiplayerMode = true;
    await startMultiplayerGame(humanEntries, 7 - humanEntries.length);
}

// ============================================
// ルーム退出
// ============================================
async function handleLeaveRoom() {
    try { await leaveRoom(); } catch(e) { console.warn(e); }
    multiplayerMode = false;
    guestState.lastTurnId = -1;
    guestState.role = null;
    guestState.currentDay = 0;
    guestState.speeches = [];
    guestState.historySpeeches = [];
    if (guestState.timerInterval) { clearInterval(guestState.timerInterval); guestState.timerInterval = null; }
    gameState = null;
    showScreen(Screen.TITLE);
}

// ============================================
// 初期化
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (target) handleAction(target.dataset.action);
    });
    document.getElementById('modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'modal-overlay') closeModal(); });
    document.getElementById('char-modal').addEventListener('click', (e) => { if (e.target.id === 'char-modal') document.getElementById('char-modal').classList.remove('active'); });

    let saveTimer;
    ['input-name', 'input-api-key'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', () => {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => localStorage.setItem(id === 'input-name' ? STORAGE_KEYS.PLAYER_NAME : STORAGE_KEYS.API_KEY, el.value.trim()), 500);
        });
    });
    document.querySelectorAll('input[name="model"]').forEach(r => r.addEventListener('change', () => localStorage.setItem(STORAGE_KEYS.MODEL, r.value)));

    const msgInput = document.getElementById('message-input');
    if (msgInput) msgInput.addEventListener('input', (e) => document.getElementById('message-count').textContent = `${e.target.value.length}/100`);

    window.addEventListener('firebase-ready', () => {
        console.log('🔥 Firebase ready:', window.currentUserId);
        fbDb = window.fbDb;
    });

    if (!localStorage.getItem(STORAGE_KEYS.HAS_ONBOARDED)) {
        setTimeout(() => {
            showModal('🌙 ようこそ、月夜の村へ。<br><br>遊ぶ前に<strong>設定画面</strong>で<strong>名前</strong>を入力してください。<br><br>1人プレイ・ルーム作成には<strong>Gemini APIキー</strong>も必要です。<br>ルーム参加のみならAPIキー不要です。');
            localStorage.setItem(STORAGE_KEYS.HAS_ONBOARDED, 'true');
        }, 500);
    }
    console.log('🌙 月夜の村に狼が来る v0.5.0 (同期修正版) 起動');
});
