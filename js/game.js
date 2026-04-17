/* ============================================
   game.js - ゲームロジック (v0.5.0 再設計版)

   【設計原則】
   - ソロモード: ホスト = プレイヤー (従来通り)
   - マルチプレイ: ホストが唯一のロジック保持者
       * 夜: 人間プレイヤーからの行動を inbox で受信
       * 議論: タイマー同期
       * 投票: 全人間プレイヤーから受信、集計
   - ゲスト向け画面更新は main.js で sync 購読して処理
   ============================================ */

let gameState = null;
let multiplayerMode = false;

// ============================================
// ゲーム状態初期化
// ============================================
function initGameState(characters) {
    const shuffledRoles = shuffleArray(ROLE_COMPOSITION);
    const players = characters.map((char, i) => ({
        id: `player_${i}`,
        userId: char._userId || null,           // Firebase UID (人間のみ)
        name: char.name,
        isHuman: char.isHuman,
        avatar: char.avatar,
        character: char,
        role: shuffledRoles[i],
        isAlive: true,
        votes: 0,
        thoughts: []
    }));

    gameState = {
        day: 1,
        phase: Phase.NIGHT,
        players: players,
        // ソロモードでの「自分」: ホスト自身
        selfPlayer: players.find(p => p.userId === getCurrentUserId()) || players.find(p => p.isHuman),
        history: [],
        currentDayData: null,
        fortuneResults: [],
        mediumResults: [],
        winner: null
    };

    // 人狼の騙り戦術を決定
    gameState.players.filter(p => p.role === 'werewolf').forEach(p => {
        const tags = (p.character.personality_tags || []).join('');
        const isCunning = /狡猾|策略|大胆|抜け目|冷徹|演技|謎めい/.test(tags);
        const isHonest = /素直|純粋|愚直|正直|お人好し/.test(tags);
        let threshold = 0.40;
        if (isCunning) threshold = 0.75;
        if (isHonest) threshold = 0.15;
        if (Math.random() < threshold) {
            const type = Math.random() < 0.7 ? 'seer' : 'medium';
            const allies = gameState.players.filter(x => x.role === 'werewolf').map(x => x.name);
            const candidates = gameState.players.filter(x => !allies.includes(x.name)).map(x => x.name);
            const fakeTarget = candidates.length > 0 ? randomPick(candidates) : null;
            const fakeResult = Math.random() < 0.7 ? 'werewolf' : 'villager';
            p.character._bluffStrategy = { type, fakeTarget, fakeResult, startDay: 2 };
        } else {
            p.character._bluffStrategy = { type: 'none' };
        }
    });

    return gameState;
}

function getAlivePlayers() { return gameState.players.filter(p => p.isAlive); }
function getAlivePlayerNames() { return getAlivePlayers().map(p => p.name); }
function findPlayerByName(name) { return gameState.players.find(p => p.name === name); }
function findPlayerByUserId(uid) { return gameState.players.find(p => p.userId === uid); }
function getWerewolves() { return gameState.players.filter(p => p.role === 'werewolf' && p.isAlive); }
function getVillagerTeam() { return gameState.players.filter(p => p.role !== 'werewolf' && p.isAlive); }

function checkWinCondition() {
    const w = getWerewolves();
    const v = getVillagerTeam();
    if (w.length === 0) return 'villager';
    if (w.length >= v.length) return 'werewolf';
    return null;
}

function getAliveHumanPlayers() {
    return getAlivePlayers().filter(p => p.isHuman);
}

// alivePlayers を Firebase 用 JSON に
function aliveToJson() {
    return getAlivePlayers().map(p => ({ name: p.name, avatar: p.avatar, isHuman: p.isHuman }));
}

function allPlayersToJson() {
    return gameState.players.map(p => ({
        name: p.name, avatar: p.avatar, isHuman: p.isHuman,
        role: p.role, isAlive: p.isAlive
    }));
}

// ============================================
// ソロゲーム開始
// ============================================
async function startSoloGame() {
    const apiKey = localStorage.getItem(STORAGE_KEYS.API_KEY);
    const name = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME);
    if (!apiKey) { showModal('Gemini APIキーが必要です。設定画面で入力してください。'); return; }
    if (!name || !name.trim()) { showModal('まず設定画面で名前を入力してください。'); return; }

    multiplayerMode = false;
    showScreen(Screen.LOADING);
    document.getElementById('loading-title').textContent = '村人たちが集まっています…';
    document.getElementById('loading-message').textContent = 'AIキャラクターを生成中…';

    try {
        const aiChars = await generateAICharacters(6);
        const characters = [{
            name: name, isHuman: true, avatar: HUMAN_AVATAR,
            occupation: 'あなた', personality_tags: ['プレイヤー'],
            _userId: getCurrentUserId() || 'solo-host'
        }];
        const shuffledAvatars = shuffleArray(AI_AVATARS);
        aiChars.forEach((char, i) => {
            characters.push({ ...char, isHuman: false, avatar: shuffledAvatars[i % shuffledAvatars.length] });
        });
        const shuffled = shuffleArray(characters);
        initGameState(shuffled);
        displayCharacters();
        showScreen(Screen.CHARACTERS);
        // ソロでは「役職を確認」ボタンを自分で押す
    } catch (error) {
        console.error('ゲーム開始エラー:', error);
        showModal(`エラーが発生しました:<br>${error.message}`);
        showScreen(Screen.TITLE);
    }
}

// ============================================
// マルチプレイ ゲーム開始 (ホスト)
// ============================================
async function startMultiplayerGame(humanEntries, aiCount) {
    // humanEntries: [[uid, {name, isHost, joinedAt}], ...]
    multiplayerMode = true;
    showScreen(Screen.LOADING);
    document.getElementById('loading-title').textContent = '村人たちが集まっています…';
    document.getElementById('loading-message').textContent = 'AIキャラクターを生成中…';

    try {
        const aiChars = aiCount > 0 ? await generateAICharacters(aiCount) : [];
        const shuffledHumanAvatars = shuffleArray(HUMAN_AVATARS);
        const shuffledAiAvatars = shuffleArray(AI_AVATARS);
        const characters = [];

        humanEntries.forEach(([uid, p], i) => {
            characters.push({
                name: p.name,
                isHuman: true,
                avatar: shuffledHumanAvatars[i % shuffledHumanAvatars.length],
                occupation: 'プレイヤー',
                personality_tags: ['プレイヤー'],
                _userId: uid
            });
        });

        aiChars.forEach((char, i) => {
            characters.push({
                ...char,
                isHuman: false,
                avatar: shuffledAiAvatars[i % shuffledAiAvatars.length]
            });
        });

        const shuffled = shuffleArray(characters);
        initGameState(shuffled);

        // ゲーム中ステータスに変更
        await setRoomStatus('playing');

        // Firebase にキャラ情報を書き込み (ゲストのキャラ画面用)
        const charData = shuffled.map(c => ({
            name: c.name, isHuman: c.isHuman, avatar: c.avatar,
            occupation: c.occupation || '',
            personality_tags: c.personality_tags || [],
            age: c.age || '', catchphrase: c.catchphrase || '',
            background: c.background || ''
        }));

        // 役職をFirebaseに書き込み(各人間プレイヤーは自分の役職のみ閲覧可能)
        const rolesByUid = {};
        gameState.players.forEach(p => {
            if (p.isHuman && p.userId) {
                const allies = p.role === 'werewolf'
                    ? gameState.players.filter(x => x.role === 'werewolf' && x.id !== p.id).map(x => x.name)
                    : null;
                rolesByUid[p.userId] = {
                    role: p.role,
                    allies: allies,
                    playerName: p.name
                };
            }
        });
        await writeRoles(rolesByUid);

        // sync: characters フェーズへ
        await broadcastSync(Phase.CHARACTERS, 0, { characters: charData });

        // ホスト画面表示
        displayCharacters();
        showScreen(Screen.CHARACTERS);

    } catch (error) {
        console.error('マルチプレイ開始エラー:', error);
        showModal(`エラー: ${error.message}`);
        await leaveRoom();
        showScreen(Screen.TITLE);
    }
}

// ============================================
// キャラ紹介表示 (ソロ & ホスト共通)
// ============================================
function displayCharacters() {
    const grid = document.getElementById('characters-grid');
    grid.innerHTML = '';
    gameState.players.forEach(player => {
        const card = document.createElement('div');
        card.className = 'character-card' + (player.isHuman ? ' is-human' : '');
        const tagsText = player.isHuman ? ''
            : `<div class="char-tags-emphasized">${(player.character.personality_tags || []).map(t => '<span class="tag-chip-small">#' + escapeHtml(t) + '</span>').join('')}</div>`;
        const badgeClass = player.isHuman ? 'human' : 'ai';
        const badgeText = player.isHuman ? '👤 Player' : '🤖 AI';
        card.innerHTML = `
            <div class="char-avatar">${player.avatar}</div>
            <div class="char-name">${escapeHtml(player.name)}</div>
            <div class="char-occupation">${escapeHtml(player.character.occupation || 'あなた')}</div>
            ${tagsText}
            <div class="char-badge ${badgeClass}">${badgeText}</div>
        `;
        if (!player.isHuman) card.addEventListener('click', () => showCharacterModal(player));
        grid.appendChild(card);
    });
}

function showCharacterModal(player) {
    const char = player.character;
    document.getElementById('char-modal-content').innerHTML = `
        <div class="modal-avatar">${player.avatar}</div>
        <h3 class="modal-name">${escapeHtml(char.name)}</h3>
        <p class="modal-info">${escapeHtml(char.age || '')}歳・${escapeHtml(char.occupation || '')}</p>
        <div class="modal-tags-emphasized">${(char.personality_tags || []).map(t => '<span class="tag-chip">#' + escapeHtml(t) + '</span>').join('')}</div>
        <div class="modal-catchphrase">「${escapeHtml(char.catchphrase || '')}」</div>
        <div class="modal-background-text">${escapeHtml(char.background || '')}</div>
        <div class="modal-buttons" style="margin-top: 20px;">
            <button class="btn-primary" onclick="closeCharacterModal()">閉じる</button>
        </div>
    `;
    document.getElementById('char-modal').classList.add('active');
}
function closeCharacterModal() { document.getElementById('char-modal').classList.remove('active'); }

// ============================================
// 役職確認画面 (自分の役職を表示)
// ============================================
function showMyRoleScreen() {
    const self = gameState.selfPlayer;
    if (!self) { showModal('プレイヤー情報が取得できませんでした'); return; }
    const role = ROLES[self.role];
    document.getElementById('role-greeting').textContent = `${self.name}さん、あなたの役職は…`;
    document.getElementById('role-icon').textContent = role.icon;
    document.getElementById('role-name').textContent = role.name;
    document.getElementById('role-description').textContent = role.description;
    if (self.role === 'werewolf') {
        const allies = gameState.players.filter(p => p.role === 'werewolf' && p.id !== self.id).map(p => p.name);
        document.getElementById('role-allies').textContent = `🐺 仲間の人狼: ${allies.join('、')}`;
        document.getElementById('role-allies').style.display = 'block';
    } else {
        document.getElementById('role-allies').style.display = 'none';
    }
    showScreen(Screen.ROLE);
}

// ============================================
// ホスト: キャラ画面→役職画面に進む
// ============================================
async function hostProceedToRole() {
    if (multiplayerMode) {
        await broadcastSync(Phase.ROLE, 0, {});
    }
    showMyRoleScreen();
}

// ============================================
// ホスト: 役職確認後 → 夜フェーズ
// ============================================
async function hostProceedToNight() {
    await startNightPhase();
}

// ============================================
// 夜フェーズ (ホスト主導)
// ============================================
async function startNightPhase() {
    gameState.phase = Phase.NIGHT;
    gameState.currentDayData = {
        attack: null, fortune: null, guard: null, medium: null,
        morningSpeeches: [], messages: [], votes: {}, execution: null,
        humanActions: {}  // userId → {role, targetName}
    };

    if (multiplayerMode) {
        await broadcastSync(Phase.NIGHT, gameState.day, {
            title: `Day ${gameState.day} - 夜`,
            alivePlayers: aliveToJson()
        });
    }

    document.getElementById('night-title').textContent = `Day ${gameState.day} - 夜`;
    document.getElementById('night-subtitle').textContent = '村は眠りについた…';
    showScreen(Screen.NIGHT);

    // ホスト(=selfPlayer)の夜アクション
    const self = gameState.selfPlayer;
    await showNightActionForSelf(self);

    // マルチプレイ: 他の人間プレイヤーの夜アクション完了を待つ
    if (multiplayerMode) {
        const aliveHumans = getAliveHumanPlayers().filter(p => p.userId !== getCurrentUserId());
        const needActionHumans = aliveHumans.filter(p => humanNeedsNightAction(p));
        if (needActionHumans.length > 0) {
            // 夜アクションが必要な役職のみ待つ
            const expectedIds = new Set(needActionHumans.map(p => p.userId));
            document.getElementById('night-action').innerHTML =
                `<p class="night-action-desc">他のプレイヤーの行動を待っています…<br>${needActionHumans.map(p => escapeHtml(p.name)).join('、')}</p><div class="loading-spinner" style="margin:20px auto;"></div>`;
            const inbox = await waitForInbox(gameState.day, 'night', expectedIds, 120000);
            // 受信したアクションを currentDayData に統合
            for (const [uid, action] of Object.entries(inbox)) {
                const p = findPlayerByUserId(uid);
                if (!p) continue;
                gameState.currentDayData.humanActions[uid] = { role: p.role, targetName: action.targetName };
            }
        }
    }

    await processAINightActions();
    await moveToMorning();
}

// 役職が夜アクションを必要とするか
function humanNeedsNightAction(player) {
    if (!player.isAlive) return false;
    if (player.role === 'villager') return false;
    if (player.role === 'medium') return false; // 霊媒は受動的(表示のみ)
    if (gameState.day === 1) {
        // Day1: 襲撃・護衛なし、人狼は仲間確認のみ、占いはOK
        if (player.role === 'werewolf' || player.role === 'knight') return false;
    }
    return player.role === 'werewolf' || player.role === 'seer' || player.role === 'knight';
}

async function showNightActionForSelf(self) {
    const action = document.getElementById('night-action');
    if (!self.isAlive) {
        action.innerHTML = `<p class="night-action-desc">あなたは亡くなっています。観戦中…</p>`;
        return;
    }

    // 村人
    if (self.role === 'villager') {
        action.innerHTML = `<p class="night-action-desc">村人は夜に行動できません。能力者の行動を待っています…</p><div class="loading-spinner" style="margin:20px auto;"></div>`;
        return;
    }

    // 霊媒師
    if (self.role === 'medium') {
        if (gameState.day === 1) {
            action.innerHTML = `<div class="night-action-title">👻 霊媒師</div>
                <p class="night-action-desc">今夜はまだ霊媒の対象がいません</p>
                <button class="btn-primary" onclick="finishSelfNightAction()"><span class="btn-text">確認した</span></button>`;
        } else {
            const lastDay = gameState.history[gameState.history.length - 1];
            if (lastDay && lastDay.execution) {
                const executed = findPlayerByName(lastDay.execution);
                if (executed) {
                    const result = { target: lastDay.execution, role: executed.role };
                    gameState.mediumResults.push(result);
                    gameState.currentDayData.medium = result;
                    action.innerHTML = `<div class="night-action-title">👻 霊媒師</div>
                        <p class="night-action-desc">昨日処刑された…</p>
                        <div class="fortune-result">
                            <div class="fortune-result-text">${escapeHtml(lastDay.execution)}</div>
                            <div class="fortune-result-text" style="margin-top:15px;">その正体は</div>
                            <div class="fortune-result-role">${ROLES[executed.role].icon} ${ROLES[executed.role].name}</div>
                        </div>
                        <button class="btn-primary" onclick="finishSelfNightAction()"><span class="btn-text">確認した</span></button>`;
                }
            } else {
                action.innerHTML = `<div class="night-action-title">👻 霊媒師</div>
                    <p class="night-action-desc">今夜は霊媒の対象がいません</p>
                    <button class="btn-primary" onclick="finishSelfNightAction()"><span class="btn-text">確認した</span></button>`;
            }
        }
        return new Promise((resolve) => { window._nightActionResolve = resolve; });
    }

    // Day1 人狼 → 仲間確認のみ
    if (self.role === 'werewolf' && gameState.day === 1) {
        const allies = gameState.players.filter(p => p.role === 'werewolf' && p.id !== self.id).map(p => p.name);
        action.innerHTML = `<div class="night-action-title">🐺 人狼</div>
            <p class="night-action-desc">初日は様子を見る夜です。仲間を覚えておきましょう。</p>
            <div class="fortune-result">
                <div class="fortune-result-text">あなたの仲間の人狼</div>
                <div class="fortune-result-role" style="color: var(--color-accent-red-glow); font-size: 20px; margin-top: 15px;">${escapeHtml(allies.join('、'))}</div>
            </div>
            <button class="btn-primary" onclick="finishSelfNightAction()"><span class="btn-text">確認した</span></button>`;
        return new Promise((resolve) => { window._nightActionResolve = resolve; });
    }

    // Day1 騎士
    if (self.role === 'knight' && gameState.day === 1) {
        action.innerHTML = `<div class="night-action-title">🛡️ 騎士</div>
            <p class="night-action-desc">初日の夜は襲撃がないため、護衛の必要はありません。明日に備えましょう。</p>
            <button class="btn-primary" onclick="finishSelfNightAction()"><span class="btn-text">確認した</span></button>`;
        return new Promise((resolve) => { window._nightActionResolve = resolve; });
    }

    // 通常の対象選択 (人狼/占い師/騎士)
    let title, desc;
    if (self.role === 'werewolf') { title = '🐺 誰を襲撃する?'; desc = '仲間の人狼と協力して村人を倒しましょう'; }
    else if (self.role === 'seer') { title = '🔮 誰を占う?'; desc = '選んだ人が人狼かどうかが分かります'; }
    else if (self.role === 'knight') { title = '🛡️ 誰を守る?'; desc = '選んだ人を今夜の人狼襲撃から守ります'; }

    let targets = getAlivePlayers().filter(p => p.id !== self.id);
    if (self.role === 'werewolf') {
        const allyIds = gameState.players.filter(p => p.role === 'werewolf').map(p => p.id);
        targets = targets.filter(p => !allyIds.includes(p.id));
    }
    const gridHtml = targets.map(p => `
        <div class="night-target" onclick="selectNightTarget('${p.id}')" data-target-id="${p.id}">
            <div class="night-target-emoji">${p.avatar}</div>
            <div class="night-target-name">${escapeHtml(p.name)}</div>
        </div>`).join('');
    action.innerHTML = `<div class="night-action-title">${title}</div>
        <p class="night-action-desc">${desc}</p>
        <div class="night-target-grid">${gridHtml}</div>
        <div id="night-confirm-area"></div>`;

    return new Promise((resolve) => { window._nightActionResolve = resolve; });
}

let selectedNightTargetId = null;
function selectNightTarget(targetId) {
    selectedNightTargetId = targetId;
    document.querySelectorAll('.night-target').forEach(el => el.classList.toggle('selected', el.dataset.targetId === targetId));
    document.getElementById('night-confirm-area').innerHTML = `
        <button class="btn-primary" style="margin-top: 20px;" onclick="confirmSelfNightAction()"><span class="btn-text">決定</span></button>`;
}

async function confirmSelfNightAction() {
    if (!selectedNightTargetId) return;
    const target = gameState.players.find(p => p.id === selectedNightTargetId);
    const self = gameState.selfPlayer;

    if (self.role === 'werewolf') {
        gameState.currentDayData._hostAttackChoice = target.name;
        gameState.currentDayData.humanActions[self.userId] = { role: 'werewolf', targetName: target.name };
    } else if (self.role === 'seer') {
        const isWerewolf = target.role === 'werewolf';
        gameState.fortuneResults.push({ target: target.name, isWerewolf });
        gameState.currentDayData.fortune = { target: target.name, isWerewolf };
        document.getElementById('night-action').innerHTML = `
            <div class="night-action-title">🔮 占いの結果</div>
            <div class="fortune-result">
                <div class="fortune-result-text">${escapeHtml(target.name)} の正体は</div>
                <div class="fortune-result-role" style="color: ${isWerewolf ? 'var(--color-accent-red-glow)' : 'var(--color-accent-moon)'};">
                    ${isWerewolf ? '🐺 人狼' : '✨ 人狼ではない'}
                </div>
            </div>
            <button class="btn-primary" onclick="finishSelfNightAction()"><span class="btn-text">確認した</span></button>`;
        selectedNightTargetId = null;
        return;
    } else if (self.role === 'knight') {
        gameState.currentDayData.guard = target.name;
        gameState.currentDayData.humanActions[self.userId] = { role: 'knight', targetName: target.name };
    }
    selectedNightTargetId = null;
    await finishSelfNightAction();
}

async function finishSelfNightAction() {
    document.getElementById('night-action').innerHTML = `<p class="night-action-desc">他の能力者たちが行動しています…</p><div class="loading-spinner" style="margin:20px auto;"></div>`;
    if (window._nightActionResolve) { window._nightActionResolve(); window._nightActionResolve = null; }
}

// ============================================
// AI + 人間プレイヤー の夜アクション集計・処理
// ============================================
async function processAINightActions() {
    const alivePlayers = getAlivePlayers();

    // 襲撃対象決定
    let attackTarget = null;
    if (gameState.day >= 2) {
        const werewolfTargets = alivePlayers.filter(p => p.role !== 'werewolf');

        // ホストの人狼アクション優先
        if (gameState.currentDayData._hostAttackChoice) {
            attackTarget = gameState.currentDayData._hostAttackChoice;
        }

        // マルチプレイ: ゲストの人狼アクションを考慮
        if (!attackTarget && multiplayerMode) {
            for (const action of Object.values(gameState.currentDayData.humanActions || {})) {
                if (action.role === 'werewolf' && action.targetName) {
                    attackTarget = action.targetName; break;
                }
            }
        }

        // AI人狼が決定(人間人狼がいない/決めなかった場合)
        if (!attackTarget) {
            const aiWolves = alivePlayers.filter(p => !p.isHuman && p.role === 'werewolf');
            if (aiWolves.length > 0 && werewolfTargets.length > 0) {
                attackTarget = randomPick(werewolfTargets).name;
            }
        }
    }

    // 護衛対象
    let guardTarget = gameState.currentDayData.guard;
    if (!guardTarget && multiplayerMode) {
        for (const action of Object.values(gameState.currentDayData.humanActions || {})) {
            if (action.role === 'knight' && action.targetName) {
                guardTarget = action.targetName;
                gameState.currentDayData.guard = guardTarget;
                break;
            }
        }
    }

    // AI占い師 (人間占い師が既にアクションしていたらスキップ)
    const aiSeer = alivePlayers.find(p => !p.isHuman && p.role === 'seer');
    if (aiSeer && !gameState.currentDayData.fortune) {
        const targets = alivePlayers.filter(p => p.id !== aiSeer.id);
        const already = gameState.fortuneResults.map(r => r.target);
        const newT = targets.filter(p => !already.includes(p.name));
        const t = randomPick(newT.length > 0 ? newT : targets);
        if (t) {
            const isW = t.role === 'werewolf';
            gameState.fortuneResults.push({ target: t.name, isWerewolf: isW });
            gameState.currentDayData.fortune = { target: t.name, isWerewolf: isW };
        }
    }

    // マルチプレイ: 人間占い師の結果を計算 (ゲスト占い師)
    if (multiplayerMode) {
        for (const [uid, action] of Object.entries(gameState.currentDayData.humanActions || {})) {
            const p = findPlayerByUserId(uid);
            if (!p) continue;
            if (p.role === 'seer' && action.targetName && p.userId !== getCurrentUserId()) {
                const target = findPlayerByName(action.targetName);
                if (target) {
                    const isW = target.role === 'werewolf';
                    gameState.fortuneResults.push({ target: target.name, isWerewolf: isW });
                    if (!gameState.currentDayData.fortune) {
                        gameState.currentDayData.fortune = { target: target.name, isWerewolf: isW };
                    }
                    // 占い結果を当該プレイヤーに返送
                    await fbSet(`rooms/${currentRoomId}/privateResults/day${gameState.day}/fortune/${uid}`,
                        { target: target.name, isWerewolf: isW });
                }
            }
        }
    }

    // AI騎士(Day 2以降)
    const aiKnight = alivePlayers.find(p => !p.isHuman && p.role === 'knight');
    if (aiKnight && gameState.day >= 2 && !gameState.currentDayData.guard) {
        const targets = alivePlayers.filter(p => p.id !== aiKnight.id);
        const g = decideKnightGuardTarget(aiKnight, targets);
        if (g) gameState.currentDayData.guard = g.name;
    }

    // AI霊媒師
    const aiMedium = alivePlayers.find(p => !p.isHuman && p.role === 'medium');
    if (aiMedium && gameState.day >= 2 && !gameState.currentDayData.medium) {
        const lastDay = gameState.history[gameState.history.length - 1];
        if (lastDay && lastDay.execution) {
            const executed = findPlayerByName(lastDay.execution);
            if (executed) {
                gameState.mediumResults.push({ target: lastDay.execution, role: executed.role });
                gameState.currentDayData.medium = { target: lastDay.execution, role: executed.role };
            }
        }
    }

    // マルチプレイ: 人間霊媒師にも結果を返送
    if (multiplayerMode && gameState.day >= 2) {
        const humanMedium = gameState.players.find(p => p.isHuman && p.role === 'medium' && p.isAlive && p.userId !== getCurrentUserId());
        if (humanMedium) {
            const lastDay = gameState.history[gameState.history.length - 1];
            if (lastDay && lastDay.execution) {
                const executed = findPlayerByName(lastDay.execution);
                if (executed) {
                    await fbSet(`rooms/${currentRoomId}/privateResults/day${gameState.day}/medium/${humanMedium.userId}`,
                        { target: lastDay.execution, role: executed.role });
                }
            }
        }
    }

    // 襲撃判定
    if (attackTarget) {
        if (gameState.currentDayData.guard === attackTarget) {
            gameState.currentDayData.attack = null;
        } else {
            const victim = findPlayerByName(attackTarget);
            if (victim) { victim.isAlive = false; gameState.currentDayData.attack = attackTarget; }
        }
    }
}

function decideKnightGuardTarget(knight, targets) {
    if (targets.length === 0) return null;
    const coPlayers = findCOPlayers();
    const aliveCO = coPlayers.filter(co => targets.some(t => t.name === co.name));
    const tags = (knight.character.personality_tags || []).join('');
    const isTrusting = /素直|誠実|正直|純粋|お人好し|信心深い|忠実/.test(tags);
    const isSuspicious = /疑い深い|懐疑|慎重|冷徹|分析/.test(tags);
    const isProtective = /責任感|誠実|騎士|守る|忠義|正義/.test(tags);
    const isLogical = /論理|冷静|分析|計算/.test(tags);

    if (aliveCO.length > 0) {
        let prob = 0.60;
        if (isTrusting || isProtective) prob = 0.85;
        else if (isSuspicious) prob = 0.40;
        else if (isLogical) prob = 0.65;
        if (Math.random() < prob) {
            const seerCO = aliveCO.find(co => co.claimedRole === 'seer');
            if (seerCO) return targets.find(t => t.name === seerCO.name);
            return targets.find(t => t.name === aliveCO[0].name);
        }
    }
    return randomPick(targets);
}

function findCOPlayers() {
    const coPlayers = [];
    const check = (s) => {
        const sp = s.speech || '';
        if (/占い師/.test(sp) && /占っ|占い結果|結果は/.test(sp)) {
            if (!coPlayers.find(co => co.name === s.name && co.claimedRole === 'seer'))
                coPlayers.push({ name: s.name, claimedRole: 'seer' });
        }
        if (/霊媒師/.test(sp) && /正体|結果|処刑/.test(sp)) {
            if (!coPlayers.find(co => co.name === s.name && co.claimedRole === 'medium'))
                coPlayers.push({ name: s.name, claimedRole: 'medium' });
        }
    };
    gameState.history.forEach(d => (d.morningSpeeches || []).forEach(check));
    (gameState.currentDayData.morningSpeeches || []).forEach(check);
    return coPlayers;
}

// ============================================
// 朝フェーズ
// ============================================
async function moveToMorning() {
    gameState.phase = Phase.MORNING;
    const attack = gameState.currentDayData.attack;

    document.getElementById('morning-title').textContent = `朝がきた - Day ${gameState.day}`;
    const resultEl = document.getElementById('morning-attack-result');
    let attackHtml;
    if (gameState.day === 1) {
        attackHtml = '🌅 最初の朝、村はまだ平穏。ここから議論が始まる…';
    } else if (attack) {
        attackHtml = `💀 <strong>${escapeHtml(attack)}</strong> が亡くなりました`;
    } else {
        attackHtml = '☀️ 今夜は平和な夜だった…';
    }
    resultEl.innerHTML = attackHtml;
    document.getElementById('speeches-container').innerHTML = '';
    document.getElementById('btn-to-discussion').style.display = 'none';
    showScreen(Screen.MORNING);

    // 初期 morning ブロードキャスト (発言前の画面表示)
    if (multiplayerMode) {
        await broadcastSync(Phase.MORNING, gameState.day, {
            title: `朝がきた - Day ${gameState.day}`,
            attackHtml: attackHtml,
            speeches: [],
            alivePlayers: aliveToJson(),
            allSpeakingDone: false
        });
    }

    // 勝敗判定 (襲撃時点)
    const winnerAfterAttack = checkWinCondition();
    if (winnerAfterAttack) {
        await sleep(3000);
        gameState.history.push({
            day: gameState.day, attack: gameState.currentDayData.attack,
            execution: null, votes: {}, morningSpeeches: [],
            messages: [...(gameState.currentDayData.messages || [])]
        });
        gameState.winner = winnerAfterAttack;
        await showResultScreen();
        return;
    }

    // AI の朝発言を順次生成 & 表示
    const aliveAIs = getAlivePlayers().filter(p => !p.isHuman);
    const gameHistoryText = buildGameHistoryText();
    const context = {
        day: gameState.day,
        lastVictim: attack,
        lastExecuted: gameState.history.length > 0 ? gameState.history[gameState.history.length - 1].execution : null,
        alivePlayers: getAlivePlayerNames(),
        gameHistory: gameHistoryText,
    };

    for (const ai of aliveAIs) {
        const aiContext = { ...context };
        if (ai.role === 'werewolf') aiContext.werewolfAllies = gameState.players.filter(p => p.role === 'werewolf' && p.id !== ai.id && p.isAlive).map(p => p.name);
        else if (ai.role === 'seer') aiContext.fortuneResults = gameState.fortuneResults;
        else if (ai.role === 'medium') aiContext.mediumResults = gameState.mediumResults;

        try {
            const result = await generateMorningSpeech(ai.character, ai.role, aiContext);
            let speechText;
            if (result.error) {
                speechText = `⚠️ [API Error] ${result.error}`;
                displaySpeech(ai, speechText, true);
                if (!ai.thoughts[gameState.day - 1]) ai.thoughts[gameState.day - 1] = {};
                ai.thoughts[gameState.day - 1].speech = `(エラー: ${result.error})`;
                gameState.currentDayData.morningSpeeches.push({ name: ai.name, speech: `(エラー: ${result.error})`, thought: '', avatar: ai.avatar });
            } else {
                speechText = result.speech;
                displaySpeech(ai, speechText);
                if (!ai.thoughts[gameState.day - 1]) ai.thoughts[gameState.day - 1] = {};
                ai.thoughts[gameState.day - 1].speech = speechText;
                ai.thoughts[gameState.day - 1].internal_thought = result.internal_thought;
                gameState.currentDayData.morningSpeeches.push({ name: ai.name, speech: speechText, thought: result.internal_thought, avatar: ai.avatar });
            }

            // 発言のたびにゲスト画面を更新
            if (multiplayerMode) {
                await broadcastSync(Phase.MORNING, gameState.day, {
                    title: `朝がきた - Day ${gameState.day}`,
                    attackHtml: attackHtml,
                    speeches: gameState.currentDayData.morningSpeeches.map(s => ({
                        name: s.name, speech: s.speech, avatar: s.avatar || '🤖'
                    })),
                    alivePlayers: aliveToJson(),
                    allSpeakingDone: false
                });
            }
            await sleep(2000);
        } catch (e) {
            console.error('発言生成失敗', e);
            displaySpeech(ai, `⚠️ [Error] ${e.message || '不明なエラー'}`, true);
            await sleep(1000);
        }
    }

    // 全発言完了 → 「議論へ」ボタン表示
    document.getElementById('btn-to-discussion').style.display = 'flex';
    if (multiplayerMode) {
        await broadcastSync(Phase.MORNING, gameState.day, {
            title: `朝がきた - Day ${gameState.day}`,
            attackHtml: attackHtml,
            speeches: gameState.currentDayData.morningSpeeches.map(s => ({
                name: s.name, speech: s.speech, avatar: s.avatar || '🤖'
            })),
            alivePlayers: aliveToJson(),
            allSpeakingDone: true
        });
    }
}

function displaySpeech(player, speechText, isError = false) {
    const container = document.getElementById('speeches-container');
    const bubble = document.createElement('div');
    bubble.className = 'speech-bubble' + (isError ? ' speech-error' : '');
    bubble.innerHTML = `<div class="speech-header">
        <span class="speech-avatar">${player.avatar}</span>
        <span class="speech-name">${escapeHtml(player.name)}</span>
        <span class="speech-badge">AI</span>
    </div>
    <div class="speech-text">${isError ? escapeHtml(speechText) : '「' + escapeHtml(speechText) + '」'}</div>`;
    container.appendChild(bubble);
    bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// ============================================
// 議論フェーズ (ホスト主導・タイマー同期)
// ============================================
let discussionTimer = null;
let discussionTimeRemaining = 180;
let discussionEndTime = 0;

async function startDiscussionPhase() {
    gameState.phase = Phase.DISCUSSION;
    discussionTimeRemaining = 180;
    discussionEndTime = Date.now() + 180 * 1000;

    if (multiplayerMode) {
        await broadcastSync(Phase.DISCUSSION, gameState.day, {
            day: gameState.day,
            alivePlayers: aliveToJson(),
            speeches: gameState.currentDayData.morningSpeeches.map(s => ({
                name: s.name, speech: s.speech, avatar: s.avatar || '🤖'
            })),
            historySpeeches: buildHistorySpeechesForGuest(),
            endTime: discussionEndTime
        });
    }

    renderDiscussionScreen(gameState.day, aliveToJson(), buildAllSpeechesList());
    applyDiscussionBoxesForSelf();

    discussionTimer = setInterval(() => {
        discussionTimeRemaining = Math.max(0, Math.ceil((discussionEndTime - Date.now()) / 1000));
        updateTimerDisplay(discussionTimeRemaining);
        if (discussionTimeRemaining <= 30) document.getElementById('discussion-timer').classList.add('warning');
        if (discussionTimeRemaining <= 0) {
            clearInterval(discussionTimer); discussionTimer = null;
            if (!gameState.selfPlayer.isAlive) {
                // 死亡者は自動で投票処理を待機させる
                // ホストだけが投票を開始できる
            }
            endDiscussion();
        }
    }, 500);
    showScreen(Screen.DISCUSSION);
}

function buildAllSpeechesList() {
    const all = [];
    gameState.history.forEach((d, idx) => (d.morningSpeeches || []).forEach(s => all.push({ ...s, day: idx + 1 })));
    (gameState.currentDayData.morningSpeeches || []).forEach(s => all.push({ ...s, day: gameState.day }));
    return all;
}

function buildHistorySpeechesForGuest() {
    // ゲスト用: 全発言履歴
    const all = [];
    gameState.history.forEach((d, idx) => (d.morningSpeeches || []).forEach(s => {
        all.push({ name: s.name, speech: s.speech, avatar: s.avatar || '🤖', day: idx + 1 });
    }));
    return all;
}

function renderDiscussionScreen(day, alivePlayers, allSpeeches) {
    document.getElementById('discussion-day').textContent = `Day ${day}`;
    document.getElementById('message-input').value = '';
    document.getElementById('message-count').textContent = '0/100';
    document.getElementById('discussion-timer').classList.remove('warning');

    // 生存プレイヤー
    const container = document.getElementById('alive-players');
    container.innerHTML = '';
    gameState.players.forEach(p => {
        const el = document.createElement('div');
        el.className = 'alive-player' + (p.isAlive ? '' : ' dead');
        el.innerHTML = `<div class="alive-player-emoji">${p.isAlive ? p.avatar : '🪦'}</div>
            <div class="alive-player-name">${escapeHtml(p.name)}</div>
            <div class="alive-player-badge">${p.isHuman ? '👤' : '🤖'}</div>`;
        if (p.isAlive && !p.isHuman) el.addEventListener('click', () => showCharacterModal(p));
        container.appendChild(el);
    });

    // 人狼仲間ボックス
    const box = document.getElementById('werewolf-allies-box');
    const namesEl = document.getElementById('werewolf-allies-names');
    const self = gameState.selfPlayer;
    if (self && self.role === 'werewolf') {
        const allies = gameState.players.filter(p => p.role === 'werewolf' && p.id !== self.id)
            .map(p => escapeHtml(p.name) + (p.isAlive ? '' : ' (死亡)'));
        namesEl.innerHTML = '🐺 ' + allies.join('、');
        box.style.display = 'block';
    } else { box.style.display = 'none'; }

    // 発言ログ
    const listEl = document.getElementById('speech-log-list');
    listEl.innerHTML = '';
    if (allSpeeches.length === 0) {
        listEl.innerHTML = '<p style="color:var(--color-text-muted);font-size:13px;padding:10px;text-align:center;">まだ発言がありません</p>';
    } else {
        allSpeeches.forEach(s => {
            const player = findPlayerByName ? findPlayerByName(s.name) : null;
            const item = document.createElement('div');
            item.className = 'speech-log-item';
            item.innerHTML = `<div class="speech-log-header">
                <span class="speech-log-avatar">${(player && player.avatar) || s.avatar || '🤖'}</span>
                <span class="speech-log-name">${escapeHtml(s.name)}</span>
                <span class="speech-log-day">Day ${s.day}</span>
            </div><div class="speech-log-text">「${escapeHtml(s.speech)}」</div>`;
            listEl.appendChild(item);
        });
    }
}

function applyDiscussionBoxesForSelf() {
    const selfAlive = gameState.selfPlayer && gameState.selfPlayer.isAlive;
    const messageBox = document.getElementById('message-box-wrapper');
    const endBtn = document.getElementById('btn-end-discussion');
    const deadBox = document.getElementById('dead-spectator-box');
    const bottomSection = document.querySelector('.discussion-bottom');
    if (selfAlive) {
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
}

function updateTimerDisplay(remaining) {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    document.getElementById('discussion-timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

// ============================================
// 議論終了 → 投票
// ============================================
async function endDiscussion() {
    if (discussionTimer) { clearInterval(discussionTimer); discussionTimer = null; }

    // ホストの伝言を記録
    if (gameState.selfPlayer && gameState.selfPlayer.isAlive) {
        const msgEl = document.getElementById('message-input');
        const message = msgEl ? msgEl.value.trim() : '';
        if (message) {
            gameState.currentDayData.messages.push({ from: gameState.selfPlayer.name, text: message });
        }
    }

    // マルチプレイ: ゲストの伝言を取得
    if (multiplayerMode) {
        try {
            const msgInbox = await getInbox(gameState.day, 'message');
            for (const [uid, m] of Object.entries(msgInbox || {})) {
                if (m && m.text && m.from) {
                    if (!gameState.currentDayData.messages.find(x => x.from === m.from && x.text === m.text)) {
                        gameState.currentDayData.messages.push({ from: m.from, text: m.text });
                    }
                }
            }
        } catch(e) { console.error('Firebase伝言取得エラー:', e); }
    }

    // 投票処理画面を表示
    showScreen(Screen.VOTING_PROCESS);
    await calculateAIVotes();

    // マルチプレイ: ゲスト用に投票フェーズをブロードキャスト
    if (multiplayerMode) {
        await broadcastSync(Phase.VOTING, gameState.day, {
            alivePlayers: aliveToJson(),
            day: gameState.day
        });
    }

    // 自分自身が生存 → 投票画面
    if (gameState.selfPlayer && gameState.selfPlayer.isAlive) {
        showSelfVotingScreen();
    } else {
        // 自分は死亡 → AIと他プレイヤーの投票を集計
        await processVoting();
    }
}

async function calculateAIVotes() {
    const aliveAIs = getAlivePlayers().filter(p => !p.isHuman);
    const messages = gameState.currentDayData.messages;
    const speechesText = gameState.currentDayData.morningSpeeches.map(s => `${s.name}: 「${s.speech}」`).join('\n');
    const gameHistoryText = buildGameHistoryText();

    for (const ai of aliveAIs) {
        const aiContext = {
            day: gameState.day, alivePlayers: getAlivePlayerNames(),
            morningSpeeches: speechesText, gameHistory: gameHistoryText,
        };
        if (ai.role === 'werewolf') aiContext.werewolfAllies = gameState.players.filter(p => p.role === 'werewolf' && p.id !== ai.id && p.isAlive).map(p => p.name);
        else if (ai.role === 'seer') aiContext.fortuneResults = gameState.fortuneResults;
        else if (ai.role === 'medium') aiContext.mediumResults = gameState.mediumResults;

        try {
            const result = await decideAIVote(ai.character, ai.role, aiContext, messages);
            gameState.currentDayData.votes[ai.name] = result.vote_target;
            if (!ai.thoughts[gameState.day - 1]) ai.thoughts[gameState.day - 1] = {};
            ai.thoughts[gameState.day - 1].vote_target = result.vote_target;
            ai.thoughts[gameState.day - 1].vote_reasoning = result.reasoning;
            ai.thoughts[gameState.day - 1].message_reaction = result.message_reaction;
            await sleep(1200);
        } catch (e) {
            console.error('AI投票エラー', e);
            let valid = getAlivePlayerNames().filter(n => n !== ai.name);
            if (ai.role === 'werewolf') {
                const allies = gameState.players.filter(p => p.role === 'werewolf' && p.id !== ai.id).map(p => p.name);
                const safe = valid.filter(n => !allies.includes(n));
                if (safe.length > 0) valid = safe;
            }
            gameState.currentDayData.votes[ai.name] = randomPick(valid);
            if (!ai.thoughts[gameState.day - 1]) ai.thoughts[gameState.day - 1] = {};
            ai.thoughts[gameState.day - 1].vote_target = gameState.currentDayData.votes[ai.name];
            ai.thoughts[gameState.day - 1].vote_reasoning = '議論の流れから判断した';
        }
    }
}

// ============================================
// ホスト自身の投票画面
// ============================================
function showSelfVotingScreen() {
    const grid = document.getElementById('voting-grid');
    grid.innerHTML = '';
    getAlivePlayers().filter(p => p.id !== gameState.selfPlayer.id).forEach(p => {
        const el = document.createElement('div');
        el.className = 'voting-target';
        el.innerHTML = `<div class="voting-target-emoji">${p.avatar}</div><div class="voting-target-name">${escapeHtml(p.name)}</div>`;
        el.addEventListener('click', () => submitSelfVote(p.name));
        grid.appendChild(el);
    });
    showScreen(Screen.VOTING);
}

function submitSelfVote(targetName) {
    showConfirm(`<strong>${escapeHtml(targetName)}</strong> に投票します。<br>よろしいですか?`, '投票する').then(async ok => {
        if (!ok) return;
        gameState.currentDayData.votes[gameState.selfPlayer.name] = targetName;
        showScreen(Screen.VOTING_PROCESS);
        await processVoting();
    });
}

// ============================================
// 投票処理 (集計)
// ============================================
async function processVoting() {
    // マルチプレイ: ゲスト(他人間プレイヤー)の投票を取得
    if (multiplayerMode) {
        // 生きている他人間プレイヤーの投票を待機
        const aliveOtherHumans = getAlivePlayers().filter(p => p.isHuman && p.userId !== getCurrentUserId());
        if (aliveOtherHumans.length > 0) {
            const expectedIds = new Set(aliveOtherHumans.map(p => p.userId));
            const voteInbox = await waitForInbox(gameState.day, 'vote', expectedIds, 90000);
            for (const [uid, v] of Object.entries(voteInbox || {})) {
                const p = findPlayerByUserId(uid);
                if (p && v.targetName) {
                    gameState.currentDayData.votes[p.name] = v.targetName;
                }
            }
        }
    }

    const votes = gameState.currentDayData.votes;
    const voteCount = {};
    Object.values(votes).forEach(t => { voteCount[t] = (voteCount[t] || 0) + 1; });
    const sortedVotes = Object.entries(voteCount).sort((a, b) => b[1] - a[1]);
    const topCount = sortedVotes.length > 0 ? sortedVotes[0][1] : 0;
    const topVoted = sortedVotes.filter(([_, c]) => c === topCount).map(([n]) => n);

    const individualHtml = Object.entries(votes).map(([voter, target]) => {
        const vp = findPlayerByName(voter);
        return `<div class="execution-vote-individual">
            <span class="vote-from">${vp ? vp.avatar : '👤'} ${escapeHtml(voter)}</span>
            <span class="vote-arrow">→</span>
            <span class="vote-to">${escapeHtml(target)}</span>
        </div>`;
    }).join('');
    const summaryHtml = sortedVotes.map(([n, c]) => `<div class="execution-vote-item"><span>${escapeHtml(n)}</span><span class="execution-vote-count">${c}票</span></div>`).join('');
    const votesHtml = `<div class="vote-individual-list">${individualHtml}</div><div class="vote-summary-divider">── 集計 ──</div>${summaryHtml}`;

    let resultHtml;
    if (topVoted.length > 1 || topCount === 0) {
        resultHtml = `<div class="execution-no-vote">票は割れ、誰も処刑されなかった。</div>`;
        gameState.currentDayData.execution = null;
    } else {
        const executed = findPlayerByName(topVoted[0]);
        if (executed) {
            executed.isAlive = false;
            gameState.currentDayData.execution = executed.name;
            resultHtml = `<div class="execution-victim-emoji">🪦</div>
                <div class="execution-victim-name">${escapeHtml(executed.name)}</div>
                <div class="execution-message">その正体は、月明かりの下に沈んだ…</div>`;
        } else {
            resultHtml = `<div class="execution-no-vote">処刑対象が見つかりませんでした。</div>`;
        }
    }

    document.getElementById('execution-votes').innerHTML = votesHtml;
    document.getElementById('execution-result').innerHTML = resultHtml;
    showScreen(Screen.EXECUTION);
    document.getElementById('btn-continue').style.display = 'none';

    if (multiplayerMode) {
        await broadcastSync(Phase.EXECUTION, gameState.day, {
            votesHtml: votesHtml,
            resultHtml: resultHtml,
            canContinue: false
        });
    }
    await sleep(4000);
    document.getElementById('btn-continue').style.display = 'flex';
    if (multiplayerMode) {
        await broadcastSync(Phase.EXECUTION, gameState.day, {
            votesHtml: votesHtml,
            resultHtml: resultHtml,
            canContinue: true
        });
    }
}

// ============================================
// 次の日 / 勝敗判定
// ============================================
async function continueGame() {
    gameState.history.push({
        day: gameState.day, attack: gameState.currentDayData.attack,
        execution: gameState.currentDayData.execution,
        votes: { ...gameState.currentDayData.votes },
        morningSpeeches: [...gameState.currentDayData.morningSpeeches],
        messages: [...gameState.currentDayData.messages]
    });
    const winner = checkWinCondition();
    if (winner) { gameState.winner = winner; await showResultScreen(); return; }
    gameState.day++;
    if (gameState.day > 10) { gameState.winner = 'werewolf'; await showResultScreen(); return; }
    await startNightPhase();
}

// ============================================
// 結果画面
// ============================================
async function showResultScreen() {
    gameState.phase = Phase.RESULT;
    const isVW = gameState.winner === 'villager';
    document.getElementById('result-icon').textContent = isVW ? '☀️' : '🐺';
    const titleEl = document.getElementById('result-title');
    titleEl.textContent = isVW ? '村人陣営の勝利' : '人狼陣営の勝利';
    titleEl.className = 'result-title' + (isVW ? '' : ' werewolf-win');

    const playersEl = document.getElementById('result-players');
    playersEl.innerHTML = '';
    gameState.players.forEach(p => {
        const el = document.createElement('div');
        el.className = 'result-player' + (p.isAlive ? '' : ' dead') + (p.role === 'werewolf' ? ' werewolf-role' : '');
        el.innerHTML = `<div class="result-player-emoji">${p.isAlive ? p.avatar : '🪦'}</div>
            <div class="result-player-name">${escapeHtml(p.name)}</div>
            <div class="result-player-role">${ROLES[p.role].icon} ${ROLES[p.role].name}</div>`;
        playersEl.appendChild(el);
    });
    showScreen(Screen.RESULT);

    if (multiplayerMode) {
        await writeGameResult(gameState.winner, gameState.players.map(p => ({
            name: p.name, role: p.role, isAlive: p.isAlive, avatar: p.avatar
        })));
        // 思考ログも書き込み(全員に見せる)
        const thoughtsData = gameState.players.filter(p => !p.isHuman).map(ai => ({
            name: ai.name, avatar: ai.avatar, role: ai.role,
            occupation: ai.character.occupation || '',
            message_reaction_style: ai.character.message_reaction_style || '',
            thoughts: ai.thoughts
        }));
        await writeThoughtsLog(thoughtsData);
        await broadcastSync(Phase.RESULT, gameState.day, {
            winner: gameState.winner,
            players: gameState.players.map(p => ({
                name: p.name, role: p.role, isAlive: p.isAlive, avatar: p.avatar
            }))
        });
        await setRoomStatus('ended');
    }
}

// ============================================
// 思考ログ画面 (ソロ用)
// ============================================
function showThoughtsScreen() {
    // マルチプレイでは Firebase から取得
    if (multiplayerMode) {
        showThoughtsFromFirebase();
        return;
    }
    const container = document.getElementById('thoughts-content');
    container.innerHTML = '';
    gameState.players.filter(p => !p.isHuman).forEach(ai => {
        renderThoughtCard(container, {
            name: ai.name, avatar: ai.avatar, role: ai.role,
            occupation: ai.character.occupation || '',
            message_reaction_style: ai.character.message_reaction_style || '',
            thoughts: ai.thoughts
        });
    });
    showScreen(Screen.THOUGHTS);
}

async function showThoughtsFromFirebase() {
    const container = document.getElementById('thoughts-content');
    container.innerHTML = '<p style="color:var(--color-text-muted);text-align:center;padding:20px;">読み込み中…</p>';
    showScreen(Screen.THOUGHTS);
    try {
        const data = await getThoughtsLog();
        container.innerHTML = '';
        if (!data || !Array.isArray(data) || data.length === 0) {
            container.innerHTML = '<p style="color:var(--color-text-muted);text-align:center;padding:20px;">思考ログがありません</p>';
            return;
        }
        data.forEach(ai => renderThoughtCard(container, ai));
    } catch(e) {
        container.innerHTML = `<p style="color:var(--color-accent-red-glow);text-align:center;padding:20px;">読み込み失敗: ${escapeHtml(e.message)}</p>`;
    }
}

function renderThoughtCard(container, ai) {
    const card = document.createElement('div');
    card.className = 'thought-card' + (ai.role === 'werewolf' ? ' werewolf-role' : '');
    const thoughts = ai.thoughts || [];
    const dayLogs = thoughts.map((t, idx) => {
        if (!t) return '';
        const parts = [];
        if (t.speech) parts.push(`<strong>朝の発言:</strong>「${escapeHtml(t.speech)}」`);
        if (t.internal_thought) parts.push(`<strong>🧠 裏の思考:</strong> ${escapeHtml(t.internal_thought)}`);
        if (t.vote_target) parts.push(`<strong>🗳️ 投票先:</strong> ${escapeHtml(t.vote_target)}`);
        if (t.vote_reasoning) parts.push(`<strong>理由:</strong> ${escapeHtml(t.vote_reasoning)}`);
        if (t.message_reaction) parts.push(`<strong>📝 伝言への反応:</strong> ${escapeHtml(t.message_reaction)}`);
        if (parts.length === 0) return '';
        return `<div class="thought-day"><div class="thought-day-label">Day ${idx + 1}</div><div class="thought-day-text">${parts.join('<br>')}</div></div>`;
    }).join('');
    card.innerHTML = `<div class="thought-header">
        <div class="thought-emoji">${ai.avatar}</div>
        <div class="thought-info">
            <div class="thought-name">${escapeHtml(ai.name)}</div>
            <div class="thought-role-info">${ROLES[ai.role].icon} ${ROLES[ai.role].name} / ${escapeHtml(ai.occupation || '')}</div>
            <div class="thought-style">伝言反応: ${translateReactionStyle(ai.message_reaction_style)}</div>
        </div></div>${dayLogs}`;
    container.appendChild(card);
}

function translateReactionStyle(style) {
    return { straightforward:'素直型(信じる)', skeptical:'疑い深い型', contrarian:'天邪鬼型', logical:'論理型', emotional:'感情型' }[style] || style || '-';
}

// ============================================
// ユーティリティ
// ============================================
function buildGameHistoryText() {
    if (gameState.history.length === 0) return '(まだ履歴なし。最初の日です。過去の発言を参照しないでください。)';
    let text = '';
    gameState.history.forEach((d, idx) => {
        const dayNum = idx + 1;
        text += `\n--- Day ${dayNum} ---\n`;
        text += dayNum === 1 ? `襲撃: なし(初日)\n` : (d.attack ? `襲撃: ${d.attack} が亡くなった\n` : `襲撃: なし\n`);
        if (d.morningSpeeches && d.morningSpeeches.length > 0) {
            text += `朝の発言:\n`;
            d.morningSpeeches.forEach(s => { text += `  ${s.name}: 「${s.speech}」\n`; });
        }
        if (d.votes && Object.keys(d.votes).length > 0) {
            text += `投票:\n`;
            Object.entries(d.votes).forEach(([v, t]) => { text += `  ${v} → ${t}\n`; });
        }
        text += d.execution ? `処刑: ${d.execution}\n` : `処刑: なし\n`;
    });
    return text;
}
