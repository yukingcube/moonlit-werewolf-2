/* ============================================
   game.js v0.5 - 同期型マルチプレイ対応
   ============================================ */

let gameState = null;
let multiplayerMode = false;

// ローカルプレイヤー取得(ソロ/マルチ共通)
function getLocalPlayer() {
    if (!gameState) return null;
    if (multiplayerMode) {
        const uid = getCurrentUserId();
        return gameState.players.find(p => p.character._userId === uid) || null;
    }
    return gameState.players.find(p => p.isHuman) || null;
}

function getAlivePlayers() { return gameState.players.filter(p => p.isAlive); }
function getAlivePlayerNames() { return getAlivePlayers().map(p => p.name); }
function findPlayerByName(name) { return gameState.players.find(p => p.name === name); }
function getWerewolves() { return gameState.players.filter(p => p.role === 'werewolf' && p.isAlive); }
function getVillagerTeam() { return gameState.players.filter(p => p.role !== 'werewolf' && p.isAlive); }
function checkWinCondition() {
    const w = getWerewolves().length, v = getVillagerTeam().length;
    if (w === 0) return 'villager';
    if (w >= v) return 'werewolf';
    return null;
}

function initGameState(characters) {
    const shuffledRoles = shuffleArray(ROLE_COMPOSITION);
    const players = characters.map((char, i) => ({
        id: `player_${i}`, name: char.name, isHuman: char.isHuman,
        avatar: char.avatar, character: char, role: shuffledRoles[i],
        isAlive: true, thoughts: []
    }));
    gameState = {
        day: 1, phase: 'night', players, history: [],
        currentDayData: null, fortuneResults: [], mediumResults: [], winner: null
    };

    // 人狼の騙り戦術をゲーム開始時に決定
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
            p.character._bluffStrategy = { type, fakeTarget: randomPick(candidates), fakeResult: Math.random() < 0.7 ? 'werewolf' : 'villager', startDay: 2 };
        } else {
            p.character._bluffStrategy = { type: 'none' };
        }
    });
    return gameState;
}

// ============================================
// ソロプレイ開始
// ============================================
async function startSoloGame() {
    multiplayerMode = false;
    const apiKey = localStorage.getItem(STORAGE_KEYS.API_KEY);
    const name = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME);
    if (!apiKey) { showModal('Gemini APIキーが必要です。設定画面で入力してください。'); return; }
    if (!name || !name.trim()) { showModal('名前を設定画面で入力してください。'); return; }

    showScreen(Screen.LOADING);
    document.getElementById('loading-title').textContent = '村人たちが集まっています…';
    document.getElementById('loading-message').textContent = 'AIキャラクターを生成中…';

    try {
        const aiChars = await generateAICharacters(6);
        const characters = [{ name, isHuman: true, avatar: HUMAN_AVATAR, occupation: 'あなた', personality_tags: ['プレイヤー'] }];
        const avs = shuffleArray(AI_AVATARS);
        aiChars.forEach((c, i) => characters.push({ ...c, isHuman: false, avatar: avs[i % avs.length] }));
        initGameState(shuffleArray(characters));
        displayCharacters();
        showScreen(Screen.CHARACTERS);
    } catch (e) {
        showModal(`エラー: ${e.message}`);
        showScreen(Screen.TITLE);
    }
}

// ============================================
// マルチプレイ開始(ホストが呼ぶ)
// ============================================
async function startMultiplayerGame(humanPlayers, aiCount) {
    multiplayerMode = true;
    showScreen(Screen.LOADING);
    document.getElementById('loading-title').textContent = '村人たちが集まっています…';
    document.getElementById('loading-message').textContent = 'AIキャラクターを生成中…';

    try {
        const aiChars = aiCount > 0 ? await generateAICharacters(aiCount) : [];
        const avs = shuffleArray(AI_AVATARS);
        const characters = [];
        humanPlayers.forEach(([uid, p]) => {
            characters.push({ name: p.name, isHuman: true, avatar: HUMAN_AVATAR, occupation: 'プレイヤー', personality_tags: ['プレイヤー'], _userId: uid });
        });
        aiChars.forEach((c, i) => characters.push({ ...c, isHuman: false, avatar: avs[i % avs.length] }));
        initGameState(shuffleArray(characters));

        // Firebase にキャラ情報 + 役職を書き込み
        const charData = gameState.players.map(c => ({
            name: c.name, isHuman: c.isHuman, avatar: c.avatar,
            occupation: c.character.occupation || '', personality_tags: c.character.personality_tags || []
        }));
        const rolesByUid = {};
        gameState.players.forEach(p => {
            if (p.isHuman && p.character._userId) {
                const allies = p.role === 'werewolf' ? gameState.players.filter(x => x.role === 'werewolf' && x.id !== p.id).map(x => x.name) : null;
                rolesByUid[p.character._userId] = { role: p.role, allies };
            }
        });
        await fbWriteRoles(rolesByUid);
        await fbWritePhase('characters', { characters: charData });
        // ホスト自身もFirebaseのフェーズ更新で画面遷移する(watchGameで)
    } catch (e) {
        showModal(`エラー: ${e.message}`);
        showScreen(Screen.TITLE);
    }
}

// ============================================
// 表示関数
// ============================================
function displayCharacters(charDataOverride) {
    const grid = document.getElementById('characters-grid');
    grid.innerHTML = '';
    const list = charDataOverride || gameState.players.map(p => ({
        name: p.name, isHuman: p.isHuman, avatar: p.avatar,
        occupation: p.character.occupation, personality_tags: p.character.personality_tags
    }));
    list.forEach(c => {
        const card = document.createElement('div');
        card.className = 'character-card' + (c.isHuman ? ' is-human' : '');
        const tags = c.isHuman ? '' : `<div class="char-tags-emphasized">${(c.personality_tags||[]).map(t=>'<span class="tag-chip-small">#'+escapeHtml(t)+'</span>').join('')}</div>`;
        card.innerHTML = `<div class="char-avatar">${c.avatar}</div><div class="char-name">${escapeHtml(c.name)}</div><div class="char-occupation">${escapeHtml(c.occupation||'')}</div>${tags}<div class="char-badge ${c.isHuman?'human':'ai'}">${c.isHuman?'👤 Player':'🤖 AI'}</div>`;
        grid.appendChild(card);
    });
}

function showRoleScreen(roleOverride) {
    let roleName, roleIcon, roleDesc, roleAllies = null, greeting = 'あなたの役職は…';
    if (roleOverride) {
        // マルチプレイ: Firebaseから取得した役職
        const r = ROLES[roleOverride.role];
        roleName = r.name; roleIcon = r.icon; roleDesc = r.description;
        if (roleOverride.role === 'werewolf' && roleOverride.allies) roleAllies = roleOverride.allies;
    } else {
        // ソロ: gameState から取得
        const local = getLocalPlayer();
        if (!local) return;
        const r = ROLES[local.role];
        greeting = `${local.name}さん、あなたの役職は…`;
        roleName = r.name; roleIcon = r.icon; roleDesc = r.description;
        if (local.role === 'werewolf') {
            roleAllies = gameState.players.filter(p => p.role === 'werewolf' && p.id !== local.id).map(p => p.name);
        }
    }
    document.getElementById('role-greeting').textContent = greeting;
    document.getElementById('role-icon').textContent = roleIcon;
    document.getElementById('role-name').textContent = roleName;
    document.getElementById('role-description').textContent = roleDesc;
    const alliesEl = document.getElementById('role-allies');
    if (roleAllies) { alliesEl.textContent = `🐺 仲間の人狼: ${roleAllies.join('、')}`; alliesEl.style.display = 'block'; }
    else { alliesEl.style.display = 'none'; }
    showScreen(Screen.ROLE);
}

function showCharacterModal(player) {
    const c = player.character || player;
    document.getElementById('char-modal-content').innerHTML = `
        <div class="modal-avatar">${player.avatar||c.avatar}</div>
        <h3 class="modal-name">${escapeHtml(c.name)}</h3>
        <p class="modal-info">${escapeHtml(c.age||'')}歳・${escapeHtml(c.occupation||'')}</p>
        <div class="modal-tags-emphasized">${(c.personality_tags||[]).map(t=>'<span class="tag-chip">#'+escapeHtml(t)+'</span>').join('')}</div>
        <div class="modal-catchphrase">「${escapeHtml(c.catchphrase||'')}」</div>
        <div class="modal-background-text">${escapeHtml(c.background||'')}</div>
        <div class="modal-buttons" style="margin-top:20px;"><button class="btn-primary" onclick="closeCharacterModal()">閉じる</button></div>`;
    document.getElementById('char-modal').classList.add('active');
}
function closeCharacterModal() { document.getElementById('char-modal').classList.remove('active'); }

// ============================================
// 夜フェーズ(ソロ用 - マルチはmain.jsで制御)
// ============================================
async function startNightPhase() {
    gameState.phase = 'night';
    gameState.currentDayData = { attack: null, fortune: null, guard: null, medium: null, morningSpeeches: [], messages: [], votes: {}, execution: null };

    if (multiplayerMode && isHost) {
        // マルチプレイ: 夜フェーズをブロードキャスト、main.jsのhostNightPhase()が処理
        return;
    }

    // ソロプレイ: 従来通り
    document.getElementById('night-title').textContent = `Day ${gameState.day} - 夜`;
    document.getElementById('night-subtitle').textContent = '村は眠りについた…';
    showScreen(Screen.NIGHT);
    const local = getLocalPlayer();
    if (!local || !local.isAlive || local.role === 'villager') {
        document.getElementById('night-action').innerHTML = `<p class="night-action-desc">${local && local.isAlive ? '能力者たちが行動しています…' : '観戦中…'}</p>`;
        await sleep(2500);
        await processAINightActions();
        await startMorningPhase();
        return;
    }
    await showNightActionUI(local);
}

async function showNightActionUI(player) {
    const action = document.getElementById('night-action');
    document.getElementById('night-title').textContent = `Day ${gameState.day} - 夜`;
    showScreen(Screen.NIGHT);

    const addFinishBtn = (html) => {
        action.innerHTML = html + `<button class="btn-primary night-finish-btn" style="margin-top:20px;"><span class="btn-text">確認した</span></button>`;
        action.querySelector('.night-finish-btn').addEventListener('click', () => finishNightAction());
    };

    if (player.role === 'medium') {
        if (gameState.day === 1) {
            addFinishBtn('<div class="night-action-title">👻 霊媒師</div><p class="night-action-desc">今夜はまだ霊媒の対象がいません</p>');
        } else {
            const lastDay = gameState.history[gameState.history.length - 1];
            if (lastDay?.execution) {
                const ex = findPlayerByName(lastDay.execution);
                gameState.mediumResults.push({ target: lastDay.execution, role: ex.role });
                gameState.currentDayData.medium = { target: lastDay.execution, role: ex.role };
                addFinishBtn(`<div class="night-action-title">👻 霊媒師</div><div class="fortune-result"><div class="fortune-result-text">${escapeHtml(lastDay.execution)} の正体は</div><div class="fortune-result-role">${ROLES[ex.role].icon} ${ROLES[ex.role].name}</div></div>`);
            } else {
                addFinishBtn('<div class="night-action-title">👻 霊媒師</div><p class="night-action-desc">対象がいません</p>');
            }
        }
        return;
    }

    if (player.role === 'werewolf' && gameState.day === 1) {
        const allies = gameState.players.filter(p => p.role === 'werewolf' && p.id !== player.id).map(p => p.name);
        addFinishBtn(`<div class="night-action-title">🐺 人狼</div><p class="night-action-desc">初日は仲間を確認しましょう。</p><div class="fortune-result"><div class="fortune-result-text">仲間の人狼</div><div class="fortune-result-role" style="color:var(--color-accent-red-glow);font-size:20px;margin-top:15px;">${escapeHtml(allies.join('、'))}</div></div>`);
        return;
    }

    if (player.role === 'knight' && gameState.day === 1) {
        addFinishBtn('<div class="night-action-title">🛡️ 騎士</div><p class="night-action-desc">初日は襲撃がないため護衛不要です。</p>');
        return;
    }

    // 対象選択UI
    let title, desc;
    if (player.role === 'werewolf') { title = '🐺 誰を襲撃する?'; desc = '村人を1人選んで襲撃'; }
    else if (player.role === 'seer') { title = '🔮 誰を占う?'; desc = '人狼かどうかが分かります'; }
    else if (player.role === 'knight') { title = '🛡️ 誰を守る?'; desc = '襲撃から守ります'; }

    let targets = getAlivePlayers().filter(p => p.id !== player.id);
    if (player.role === 'werewolf') {
        const wolfIds = gameState.players.filter(p => p.role === 'werewolf').map(p => p.id);
        targets = targets.filter(p => !wolfIds.includes(p.id));
    }
    console.log('[Night] targets for', player.name, ':', targets.map(t => t.name));

    if (targets.length === 0) {
        action.innerHTML = `<div class="night-action-title">${title}</div><p class="night-action-desc">対象がいません</p><button class="btn-primary night-finish-btn" style="margin-top:20px;"><span class="btn-text">確認した</span></button>`;
        action.querySelector('.night-finish-btn').addEventListener('click', () => finishNightAction());
        return;
    }

    const gridHtml = targets.map(p => `<div class="night-target" data-target-id="${p.id}"><div class="night-target-emoji">${p.avatar}</div><div class="night-target-name">${escapeHtml(p.name)}</div></div>`).join('');
    action.innerHTML = `<div class="night-action-title">${title}</div><p class="night-action-desc">${desc}</p><div class="night-target-grid">${gridHtml}</div><div id="night-confirm-area"></div>`;

    // イベントリスナーで対象選択（onclick属性ではなくaddEventListenerを使う）
    action.querySelectorAll('.night-target').forEach(el => {
        el.addEventListener('click', function() {
            const targetId = this.dataset.targetId;
            _selectedNightTarget = targetId;
            action.querySelectorAll('.night-target').forEach(e => e.classList.remove('selected'));
            this.classList.add('selected');
            document.getElementById('night-confirm-area').innerHTML = `<button class="btn-primary" style="margin-top:20px;" id="night-confirm-btn"><span class="btn-text">決定</span></button>`;
            document.getElementById('night-confirm-btn').addEventListener('click', () => confirmNightAction());
        });
    });
}

let _selectedNightTarget = null;

async function confirmNightAction() {
    if (!_selectedNightTarget) return;
    const target = gameState.players.find(p => p.id === _selectedNightTarget);
    const local = getLocalPlayer();
    if (!target || !local) return;
    const action = document.getElementById('night-action');

    // 占い結果表示のヘルパー
    function showSeerResult(isW) {
        action.innerHTML = `<div class="night-action-title">🔮 占いの結果</div><div class="fortune-result"><div class="fortune-result-text">${escapeHtml(target.name)} の正体は</div><div class="fortune-result-role" style="color:${isW?'var(--color-accent-red-glow)':'var(--color-accent-moon)'}">${isW?'🐺 人狼':'✨ 人狼ではない'}</div></div><button class="btn-primary night-finish-btn" style="margin-top:20px;"><span class="btn-text">確認した</span></button>`;
        action.querySelector('.night-finish-btn').addEventListener('click', () => finishNightAction());
    }

    if (multiplayerMode) {
        await fbSubmitNightAction(gameState.day, { role: local.role, targetName: target.name });

        if (local.role === 'seer') {
            const isW = target.role === 'werewolf';
            gameState.fortuneResults.push({ target: target.name, isWerewolf: isW });
            gameState.currentDayData.fortune = { target: target.name, isWerewolf: isW };
            showSeerResult(isW);
            _selectedNightTarget = null;
            return;
        }

        await fbMarkReady(`night_day${gameState.day}`);
        showWaiting('他のプレイヤーを待っています…', '');
        _selectedNightTarget = null;
        return;
    }

    // ソロプレイ
    if (local.role === 'werewolf') {
        gameState.currentDayData._humanAttackChoice = target.name;
    } else if (local.role === 'seer') {
        const isW = target.role === 'werewolf';
        gameState.fortuneResults.push({ target: target.name, isWerewolf: isW });
        gameState.currentDayData.fortune = { target: target.name, isWerewolf: isW };
        showSeerResult(isW);
        _selectedNightTarget = null;
        return;
    } else if (local.role === 'knight') {
        gameState.currentDayData.guard = target.name;
    }
    _selectedNightTarget = null;
    await finishNightAction();
}

async function finishNightAction() {
    if (multiplayerMode) {
        // マルチプレイ: Firebaseに準備完了を書く
        await fbMarkReady(`night_day${gameState.day}`);
        showWaiting('他のプレイヤーを待っています…', '');
        return;
    }
    // ソロ
    document.getElementById('night-action').innerHTML = '<p class="night-action-desc">他の能力者が行動しています…</p>';
    await sleep(1500);
    await processAINightActions();
    await startMorningPhase();
}

// AI夜行動処理(ホストが実行)
async function processAINightActions() {
    const alive = getAlivePlayers();
    let attackTarget = null;
    if (gameState.day >= 2) {
        const wTargets = alive.filter(p => p.role !== 'werewolf');
        attackTarget = gameState.currentDayData._humanAttackChoice;
        if (!attackTarget) {
            const aiWolves = alive.filter(p => !p.isHuman && p.role === 'werewolf');
            if (aiWolves.length > 0 && wTargets.length > 0) attackTarget = randomPick(wTargets).name;
        }
    }

    // AI占い師
    const aiSeer = alive.find(p => !p.isHuman && p.role === 'seer');
    if (aiSeer && !gameState.currentDayData.fortune) {
        const targets = alive.filter(p => p.id !== aiSeer.id);
        const already = gameState.fortuneResults.map(r => r.target);
        const newT = targets.filter(p => !already.includes(p.name));
        const t = randomPick(newT.length > 0 ? newT : targets);
        if (t) { gameState.fortuneResults.push({ target: t.name, isWerewolf: t.role === 'werewolf' }); gameState.currentDayData.fortune = { target: t.name, isWerewolf: t.role === 'werewolf' }; }
    }

    // AI騎士
    const aiKnight = alive.find(p => !p.isHuman && p.role === 'knight');
    if (aiKnight && gameState.day >= 2 && !gameState.currentDayData.guard) {
        const targets = alive.filter(p => p.id !== aiKnight.id);
        const guardTarget = decideKnightGuardTarget(aiKnight, targets);
        if (guardTarget) gameState.currentDayData.guard = guardTarget.name;
    }

    // AI霊媒師
    const aiMedium = alive.find(p => !p.isHuman && p.role === 'medium');
    if (aiMedium && gameState.day >= 2 && !gameState.currentDayData.medium) {
        const lastDay = gameState.history[gameState.history.length - 1];
        if (lastDay?.execution) {
            const ex = findPlayerByName(lastDay.execution);
            if (ex) { gameState.mediumResults.push({ target: lastDay.execution, role: ex.role }); gameState.currentDayData.medium = { target: lastDay.execution, role: ex.role }; }
        }
    }

    // 襲撃判定
    if (attackTarget) {
        if (gameState.currentDayData.guard === attackTarget) { gameState.currentDayData.attack = null; }
        else { const v = findPlayerByName(attackTarget); if (v) { v.isAlive = false; gameState.currentDayData.attack = attackTarget; } }
    }
}

function decideKnightGuardTarget(knight, targets) {
    if (targets.length === 0) return null;
    const coPlayers = findCOPlayers();
    const aliveCO = coPlayers.filter(co => targets.some(t => t.name === co.name));
    const tags = (knight.character.personality_tags || []).join('');
    const isTrusting = /素直|誠実|正直|純粋|お人好し|信心深い|忠実/.test(tags);
    const isSuspicious = /疑い深い|懐疑|慎重|冷徹|分析/.test(tags);
    let prob = 0.60;
    if (isTrusting) prob = 0.85; else if (isSuspicious) prob = 0.40;
    if (aliveCO.length > 0 && Math.random() < prob) {
        const seerCO = aliveCO.find(co => co.claimedRole === 'seer');
        if (seerCO) return targets.find(t => t.name === seerCO.name);
        return targets.find(t => t.name === aliveCO[0].name);
    }
    return randomPick(targets);
}

function findCOPlayers() {
    const co = [];
    const check = (s) => {
        if (/占い師/.test(s.speech) && /占っ|占い結果|結果は/.test(s.speech)) { if (!co.find(c => c.name === s.name && c.claimedRole === 'seer')) co.push({ name: s.name, claimedRole: 'seer' }); }
        if (/霊媒師/.test(s.speech) && /正体|結果|処刑/.test(s.speech)) { if (!co.find(c => c.name === s.name && c.claimedRole === 'medium')) co.push({ name: s.name, claimedRole: 'medium' }); }
    };
    gameState.history.forEach(d => (d.morningSpeeches||[]).forEach(check));
    (gameState.currentDayData?.morningSpeeches||[]).forEach(check);
    return co;
}

// ============================================
// 朝フェーズ
// ============================================
async function startMorningPhase() {
    gameState.phase = 'morning';
    const attack = gameState.currentDayData.attack;

    // 勝敗判定(襲撃後)
    const winner = checkWinCondition();
    if (winner) {
        if (multiplayerMode && isHost) {
            const speechData = buildMorningData();
            await fbWritePhase('morning', speechData);
            await sleep(3000);
            gameState.history.push(buildDayHistory());
            gameState.winner = winner;
            await broadcastResult();
        } else if (!multiplayerMode) {
            showMorningUI(attack);
            await sleep(3000);
            gameState.history.push(buildDayHistory());
            gameState.winner = winner;
            showResultScreen();
        }
        return;
    }

    if (multiplayerMode && isHost) {
        // AIの朝発言を生成
        await generateAllMorningSpeeches();
        const data = buildMorningData();
        await fbWritePhase('morning', data);
        // ホスト自身もwatchGameで画面遷移する
    } else if (!multiplayerMode) {
        showMorningUI(attack);
        await generateAllMorningSpeeches();
        document.getElementById('btn-to-discussion').style.display = 'flex';
    }
}

function showMorningUI(attackOrText) {
    const day = gameState ? gameState.day : (window._mpDay || 1);
    document.getElementById('morning-title').textContent = `朝がきた - Day ${day}`;
    const resultEl = document.getElementById('morning-attack-result');
    // マルチプレイからのHTML文字列 or ソロからの攻撃対象名
    if (typeof attackOrText === 'string' && (attackOrText.includes('<') || attackOrText.includes('🌅') || attackOrText.includes('☀️'))) {
        resultEl.innerHTML = attackOrText;
    } else if (day === 1) {
        resultEl.textContent = '🌅 最初の朝、村はまだ平穏。';
    } else if (attackOrText) {
        resultEl.innerHTML = `💀 <strong>${escapeHtml(attackOrText)}</strong> が亡くなりました`;
    } else {
        resultEl.textContent = '☀️ 今夜は平和な夜だった…';
    }
    document.getElementById('speeches-container').innerHTML = '';
    document.getElementById('btn-to-discussion').style.display = 'none';
    showScreen(Screen.MORNING);
}

function displaySpeeches(speechesData) {
    const container = document.getElementById('speeches-container');
    container.innerHTML = '';
    (speechesData || []).forEach(s => {
        const bubble = document.createElement('div');
        bubble.className = 'speech-bubble' + (s.error ? ' speech-error' : '');
        bubble.innerHTML = `<div class="speech-header"><span class="speech-avatar">${s.avatar||'🤖'}</span><span class="speech-name">${escapeHtml(s.name)}</span><span class="speech-badge">AI</span></div><div class="speech-text">${s.error ? escapeHtml(s.speech) : '「'+escapeHtml(s.speech)+'」'}</div>`;
        container.appendChild(bubble);
    });
    document.getElementById('btn-to-discussion').style.display = 'flex';
}

async function generateAllMorningSpeeches() {
    const aliveAIs = getAlivePlayers().filter(p => !p.isHuman);
    const gameHistoryText = buildGameHistoryText();
    const context = { day: gameState.day, lastVictim: gameState.currentDayData.attack, lastExecuted: gameState.history.length > 0 ? gameState.history[gameState.history.length-1].execution : null, alivePlayers: getAlivePlayerNames(), gameHistory: gameHistoryText };

    for (const ai of aliveAIs) {
        const ctx = { ...context };
        if (ai.role === 'werewolf') ctx.werewolfAllies = gameState.players.filter(p => p.role === 'werewolf' && p.id !== ai.id && p.isAlive).map(p => p.name);
        else if (ai.role === 'seer') ctx.fortuneResults = gameState.fortuneResults;
        else if (ai.role === 'medium') ctx.mediumResults = gameState.mediumResults;
        try {
            const result = await generateMorningSpeech(ai.character, ai.role, ctx);
            const speech = result.error ? `⚠️ [API Error] ${result.error}` : result.speech;
            if (!ai.thoughts[gameState.day - 1]) ai.thoughts[gameState.day - 1] = {};
            ai.thoughts[gameState.day - 1].speech = speech;
            ai.thoughts[gameState.day - 1].internal_thought = result.internal_thought;
            gameState.currentDayData.morningSpeeches.push({ name: ai.name, speech, thought: result.internal_thought, error: !!result.error });

            // ソロプレイ時はリアルタイム表示
            if (!multiplayerMode) {
                const container = document.getElementById('speeches-container');
                const bubble = document.createElement('div');
                bubble.className = 'speech-bubble' + (result.error ? ' speech-error' : '');
                bubble.innerHTML = `<div class="speech-header"><span class="speech-avatar">${ai.avatar}</span><span class="speech-name">${escapeHtml(ai.name)}</span><span class="speech-badge">AI</span></div><div class="speech-text">${result.error ? escapeHtml(speech) : '「'+escapeHtml(speech)+'」'}</div>`;
                container.appendChild(bubble);
                bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }
            await sleep(2000);
        } catch (e) {
            console.error('発言失敗', e);
            gameState.currentDayData.morningSpeeches.push({ name: ai.name, speech: `⚠️ ${e.message}`, thought: '', error: true });
            await sleep(500);
        }
    }
}

function buildMorningData() {
    const speeches = gameState.currentDayData.morningSpeeches.map(s => {
        const p = findPlayerByName(s.name);
        return { name: s.name, speech: s.speech, avatar: p ? p.avatar : '🤖', error: s.error };
    });
    const attack = gameState.currentDayData.attack;
    const alivePlayers = getAlivePlayers().map(p => ({ name: p.name, avatar: p.avatar, isHuman: p.isHuman, isAlive: p.isAlive }));
    return {
        day: gameState.day,
        title: `朝がきた - Day ${gameState.day}`,
        attackText: gameState.day === 1 ? '🌅 最初の朝、村はまだ平穏。' : (attack ? `💀 <strong>${escapeHtml(attack)}</strong> が亡くなりました` : '☀️ 平和な夜だった…'),
        speeches, alivePlayers
    };
}

// ============================================
// 議論フェーズ
// ============================================
let discussionTimer = null;
let discussionTimeRemaining = 180;

function startDiscussionPhase() {
    const day = gameState ? gameState.day : (window._mpDay || 1);
    if (gameState) gameState.phase = 'discussion';
    discussionTimeRemaining = 180;
    document.getElementById('discussion-day').textContent = `Day ${day}`;
    document.getElementById('message-input').value = '';
    document.getElementById('message-count').textContent = '0/100';
    document.getElementById('discussion-timer').classList.remove('warning');

    const local = getLocalPlayer();
    // ゲストの場合localはnull → 伝言は送れる(生存とみなす)
    const localAlive = local ? local.isAlive : true;
    const msgBox = document.getElementById('message-box-wrapper');
    const endBtn = document.getElementById('btn-end-discussion');
    const deadBox = document.getElementById('dead-spectator-box');
    const bottom = document.querySelector('.discussion-bottom');

    if (localAlive) {
        if (msgBox) msgBox.style.display = '';
        if (endBtn) endBtn.style.display = '';
        if (deadBox) deadBox.style.display = 'none';
        if (bottom) bottom.style.display = '';
    } else {
        if (msgBox) msgBox.style.display = 'none';
        if (endBtn) endBtn.style.display = 'none';
        if (bottom) bottom.style.display = 'none';
        if (deadBox) deadBox.style.display = 'block';
        discussionTimeRemaining = 15;
    }

    displayAlivePlayers();
    displayWerewolfAllies();
    displaySpeechLog();
    showScreen(Screen.DISCUSSION);

    updateTimerDisplay();
    if (discussionTimer) clearInterval(discussionTimer);
    discussionTimer = setInterval(() => {
        discussionTimeRemaining--;
        updateTimerDisplay();
        if (discussionTimeRemaining <= 0) { clearInterval(discussionTimer); discussionTimer = null; endDiscussion(); return; }
        if (discussionTimeRemaining <= 30) document.getElementById('discussion-timer').classList.add('warning');
    }, 1000);
}

function updateTimerDisplay() {
    const m = Math.floor(discussionTimeRemaining / 60), s = discussionTimeRemaining % 60;
    document.getElementById('discussion-timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

function displayAlivePlayers() {
    const container = document.getElementById('alive-players');
    container.innerHTML = '';
    const players = gameState ? gameState.players : (window._mpAlivePlayers || []);
    players.forEach(p => {
        const el = document.createElement('div');
        el.className = 'alive-player' + ((p.isAlive !== false) ? '' : ' dead');
        el.innerHTML = `<div class="alive-player-emoji">${(p.isAlive !== false) ? (p.avatar||'👤') : '🪦'}</div><div class="alive-player-name">${escapeHtml(p.name)}</div><div class="alive-player-badge">${p.isHuman ? '👤' : '🤖'}</div>`;
        container.appendChild(el);
    });
}

function displayWerewolfAllies() {
    const box = document.getElementById('werewolf-allies-box');
    const namesEl = document.getElementById('werewolf-allies-names');
    if (!gameState) { box.style.display = 'none'; return; }
    const local = getLocalPlayer();
    if (local && local.role === 'werewolf') {
        const allies = gameState.players.filter(p => p.role === 'werewolf' && p.id !== local.id).map(p => escapeHtml(p.name) + (p.isAlive ? '' : ' (死亡)'));
        namesEl.innerHTML = '🐺 ' + allies.join('、');
        box.style.display = 'block';
    } else { box.style.display = 'none'; }
}

function displaySpeechLog() {
    const listEl = document.getElementById('speech-log-list');
    listEl.innerHTML = '';

    // ゲスト(gameStateなし)の場合、保存された発言データを使う
    if (!gameState) {
        const speeches = window._mpSpeeches || [];
        if (speeches.length === 0) { listEl.innerHTML = '<p style="color:var(--color-text-muted);text-align:center;font-size:13px;padding:10px;">まだ発言がありません</p>'; return; }
        speeches.forEach(s => {
            const item = document.createElement('div');
            item.className = 'speech-log-item';
            item.innerHTML = `<div class="speech-log-header"><span class="speech-log-avatar">${s.avatar||'🤖'}</span><span class="speech-log-name">${escapeHtml(s.name)}</span></div><div class="speech-log-text">「${escapeHtml(s.speech)}」</div>`;
            listEl.appendChild(item);
        });
        return;
    }
    const all = [];
    gameState.history.forEach((d, idx) => (d.morningSpeeches||[]).forEach(s => all.push({ ...s, day: idx + 1 })));
    (gameState.currentDayData?.morningSpeeches||[]).forEach(s => all.push({ ...s, day: gameState.day }));
    if (all.length === 0) { listEl.innerHTML = '<p style="color:var(--color-text-muted);text-align:center;font-size:13px;padding:10px;">まだ発言がありません</p>'; return; }
    all.forEach(s => {
        const p = findPlayerByName(s.name);
        const item = document.createElement('div');
        item.className = 'speech-log-item';
        item.innerHTML = `<div class="speech-log-header"><span class="speech-log-avatar">${p?p.avatar:'🤖'}</span><span class="speech-log-name">${escapeHtml(s.name)}</span><span class="speech-log-day">Day ${s.day}</span></div><div class="speech-log-text">「${escapeHtml(s.speech)}」</div>`;
        listEl.appendChild(item);
    });
    listEl.scrollTop = listEl.scrollHeight;
}

async function endDiscussion() {
    if (discussionTimer) { clearInterval(discussionTimer); discussionTimer = null; }
    const local = getLocalPlayer();
    const day = gameState ? gameState.day : (window._mpDay || 1);

    if (multiplayerMode) {
        // 伝言をFirebaseに送信(ホスト/ゲスト共通)
        if (!local || local.isAlive) {
            const msg = document.getElementById('message-input').value.trim();
            if (msg) await fbSubmitMessage(day, msg);
        }
        await fbMarkReady(`discussion_day${day}`);
        showWaiting('投票の準備を待っています…', '');
        return;
    }

    // ソロ
    if (local && local.isAlive) {
        const msg = document.getElementById('message-input').value.trim();
        if (msg) gameState.currentDayData.messages.push({ from: local.name, text: msg });
    }
    showScreen(Screen.VOTING_PROCESS);
    await calculateAIVotes();
    if (local && local.isAlive) showHumanVotingScreen();
    else { await sleep(1000); processVoting(); }
}

// ============================================
// 投票
// ============================================
async function calculateAIVotes() {
    const aliveAIs = getAlivePlayers().filter(p => !p.isHuman);
    const messages = gameState.currentDayData.messages;
    const speechesText = gameState.currentDayData.morningSpeeches.map(s => `${s.name}: 「${s.speech}」`).join('\n');
    const gameHistoryText = buildGameHistoryText();

    for (const ai of aliveAIs) {
        const ctx = { day: gameState.day, alivePlayers: getAlivePlayerNames(), morningSpeeches: speechesText, gameHistory: gameHistoryText };
        if (ai.role === 'werewolf') ctx.werewolfAllies = gameState.players.filter(p => p.role === 'werewolf' && p.id !== ai.id && p.isAlive).map(p => p.name);
        else if (ai.role === 'seer') ctx.fortuneResults = gameState.fortuneResults;
        else if (ai.role === 'medium') ctx.mediumResults = gameState.mediumResults;
        try {
            const r = await decideAIVote(ai.character, ai.role, ctx, messages);
            gameState.currentDayData.votes[ai.name] = r.vote_target;
            if (!ai.thoughts[gameState.day-1]) ai.thoughts[gameState.day-1] = {};
            ai.thoughts[gameState.day-1].vote_target = r.vote_target;
            ai.thoughts[gameState.day-1].vote_reasoning = r.reasoning;
            ai.thoughts[gameState.day-1].message_reaction = r.message_reaction;
            await sleep(1500);
        } catch(e) {
            let v = getAlivePlayerNames().filter(n => n !== ai.name);
            if (ai.role === 'werewolf') { const a = gameState.players.filter(p=>p.role==='werewolf'&&p.id!==ai.id).map(p=>p.name); const s = v.filter(n=>!a.includes(n)); if(s.length>0) v=s; }
            gameState.currentDayData.votes[ai.name] = randomPick(v);
            if (!ai.thoughts[gameState.day-1]) ai.thoughts[gameState.day-1] = {};
            ai.thoughts[gameState.day-1].vote_target = gameState.currentDayData.votes[ai.name];
            ai.thoughts[gameState.day-1].vote_reasoning = `⚠️API失敗: ${e.message}`;
            await sleep(500);
        }
    }
}

function showHumanVotingScreen() {
    const grid = document.getElementById('voting-grid');
    grid.innerHTML = '';
    const local = getLocalPlayer();
    getAlivePlayers().filter(p => !local || p.id !== local.id).forEach(p => {
        const el = document.createElement('div');
        el.className = 'voting-target';
        el.innerHTML = `<div class="voting-target-emoji">${p.avatar}</div><div class="voting-target-name">${escapeHtml(p.name)}</div>`;
        el.addEventListener('click', () => submitHumanVote(p.name));
        grid.appendChild(el);
    });
    showScreen(Screen.VOTING);
}

function submitHumanVote(targetName) {
    showConfirm(`<strong>${escapeHtml(targetName)}</strong> に投票しますか?`, '投票する').then(async ok => {
        if (!ok) return;
        if (multiplayerMode) {
            await fbSubmitVote(gameState.day, targetName);
            showWaiting('投票を送信しました', '結果を待っています…');
        } else {
            const local = getLocalPlayer();
            gameState.currentDayData.votes[local.name] = targetName;
            processVoting();
        }
    });
}

async function processVoting() {
    const votes = gameState.currentDayData.votes;
    const voteCount = {};
    Object.values(votes).forEach(t => { voteCount[t] = (voteCount[t]||0)+1; });
    const sorted = Object.entries(voteCount).sort((a,b) => b[1]-a[1]);
    const topCount = sorted.length > 0 ? sorted[0][1] : 0;
    const topVoted = sorted.filter(([_,c]) => c === topCount).map(([n]) => n);

    const votesEl = document.getElementById('execution-votes');
    const indHtml = Object.entries(votes).map(([voter,target]) => {
        const vp = findPlayerByName(voter);
        return `<div class="execution-vote-individual"><span class="vote-from">${vp?vp.avatar:'👤'} ${escapeHtml(voter)}</span><span class="vote-arrow">→</span><span class="vote-to">${escapeHtml(target)}</span></div>`;
    }).join('');
    const sumHtml = sorted.map(([n,c]) => `<div class="execution-vote-item"><span>${escapeHtml(n)}</span><span class="execution-vote-count">${c}票</span></div>`).join('');
    votesEl.innerHTML = `<div class="vote-individual-list">${indHtml}</div><div class="vote-summary-divider">── 集計 ──</div>${sumHtml}`;

    const resultEl = document.getElementById('execution-result');
    if (topVoted.length > 1) {
        resultEl.innerHTML = '<div class="execution-no-vote">票は割れ、誰も処刑されなかった。</div>';
        gameState.currentDayData.execution = null;
    } else {
        const ex = findPlayerByName(topVoted[0]);
        if (ex) { ex.isAlive = false; gameState.currentDayData.execution = ex.name;
            resultEl.innerHTML = `<div class="execution-victim-emoji">🪦</div><div class="execution-victim-name">${escapeHtml(ex.name)}</div><div class="execution-message">その正体は、月明かりの下に沈んだ…</div>`;
        }
    }
    showScreen(Screen.EXECUTION);
    document.getElementById('btn-continue').style.display = 'none';

    if (multiplayerMode && isHost) {
        await fbWritePhase('execution', { votesHtml: votesEl.innerHTML, resultHtml: resultEl.innerHTML, day: gameState.day });
    }

    await sleep(4000);
    document.getElementById('btn-continue').style.display = 'flex';
}

// ============================================
// 次の日 / 勝敗判定
// ============================================
function continueGame() {
    if (multiplayerMode) {
        const day = gameState ? gameState.day : (window._mpDay || 1);
        fbMarkReady(`execution_day${day}`);
        showWaiting('次のフェーズを待っています…', '');
        return;
    }
    advanceToNextDay();
}

function advanceToNextDay() {
    gameState.history.push(buildDayHistory());
    const winner = checkWinCondition();
    if (winner) { gameState.winner = winner; showResultScreen(); return; }
    gameState.day++;
    if (gameState.day > 10) { gameState.winner = 'werewolf'; showResultScreen(); return; }
    startNightPhase();
}

function buildDayHistory() {
    return {
        day: gameState.day, attack: gameState.currentDayData.attack,
        execution: gameState.currentDayData.execution,
        votes: { ...gameState.currentDayData.votes },
        morningSpeeches: [...gameState.currentDayData.morningSpeeches],
        messages: [...gameState.currentDayData.messages]
    };
}

// ============================================
// 結果/思考ログ
// ============================================
function showResultScreen() {
    gameState.phase = 'result';
    const isVW = gameState.winner === 'villager';
    document.getElementById('result-icon').textContent = isVW ? '☀️' : '🐺';
    const titleEl = document.getElementById('result-title');
    titleEl.textContent = isVW ? '村人陣営の勝利' : '人狼陣営の勝利';
    titleEl.className = 'result-title' + (isVW ? '' : ' werewolf-win');
    const el = document.getElementById('result-players'); el.innerHTML = '';
    gameState.players.forEach(p => {
        const d = document.createElement('div');
        d.className = 'result-player'+(p.isAlive?'':' dead')+(p.role==='werewolf'?' werewolf-role':'');
        d.innerHTML = `<div class="result-player-emoji">${p.isAlive?p.avatar:'🪦'}</div><div class="result-player-name">${escapeHtml(p.name)}</div><div class="result-player-role">${ROLES[p.role].icon} ${ROLES[p.role].name}</div>`;
        el.appendChild(d);
    });
    showScreen(Screen.RESULT);
}

async function broadcastResult() {
    const playersData = gameState.players.map(p => ({ name: p.name, role: p.role, isAlive: p.isAlive, avatar: p.avatar }));
    await fbWriteResult(gameState.winner, playersData);
    await fbWritePhase('result', {});
    showResultScreen();
}

function showResultFromFirebase(result) {
    const isVW = result.winner === 'villager';
    document.getElementById('result-icon').textContent = isVW ? '☀️' : '🐺';
    const titleEl = document.getElementById('result-title');
    titleEl.textContent = isVW ? '村人陣営の勝利' : '人狼陣営の勝利';
    titleEl.className = 'result-title'+(isVW?'':' werewolf-win');
    const el = document.getElementById('result-players'); el.innerHTML = '';
    (result.players||[]).forEach(p => {
        const d = document.createElement('div');
        d.className = 'result-player'+(p.isAlive?'':' dead')+(p.role==='werewolf'?' werewolf-role':'');
        d.innerHTML = `<div class="result-player-emoji">${p.isAlive?p.avatar:'🪦'}</div><div class="result-player-name">${escapeHtml(p.name)}</div><div class="result-player-role">${ROLES[p.role].icon} ${ROLES[p.role].name}</div>`;
        el.appendChild(d);
    });
    showScreen(Screen.RESULT);
}

function showThoughtsScreen() {
    const container = document.getElementById('thoughts-content'); container.innerHTML = '';
    if (!gameState) { container.innerHTML = '<p style="color:var(--color-text-muted);text-align:center;">思考ログはホストのみ閲覧できます</p>'; showScreen(Screen.THOUGHTS); return; }
    gameState.players.filter(p => !p.isHuman).forEach(ai => {
        const card = document.createElement('div');
        card.className = 'thought-card'+(ai.role==='werewolf'?' werewolf-role':'');
        const dayLogs = ai.thoughts.map((t,idx) => {
            if(!t) return '';
            const parts = [];
            if(t.speech) parts.push(`<strong>朝の発言:</strong>「${escapeHtml(t.speech)}」`);
            if(t.internal_thought) parts.push(`<strong>🧠 裏の思考:</strong> ${escapeHtml(t.internal_thought)}`);
            if(t.vote_target) parts.push(`<strong>🗳️ 投票先:</strong> ${escapeHtml(t.vote_target)}`);
            if(t.vote_reasoning) parts.push(`<strong>理由:</strong> ${escapeHtml(t.vote_reasoning)}`);
            if(t.message_reaction) parts.push(`<strong>📝 伝言反応:</strong> ${escapeHtml(t.message_reaction)}`);
            return parts.length ? `<div class="thought-day"><div class="thought-day-label">Day ${idx+1}</div><div class="thought-day-text">${parts.join('<br>')}</div></div>` : '';
        }).join('');
        card.innerHTML = `<div class="thought-header"><div class="thought-emoji">${ai.avatar}</div><div class="thought-info"><div class="thought-name">${escapeHtml(ai.name)}</div><div class="thought-role-info">${ROLES[ai.role].icon} ${ROLES[ai.role].name}</div></div></div>${dayLogs}`;
        container.appendChild(card);
    });
    showScreen(Screen.THOUGHTS);
}

// ============================================
// ユーティリティ
// ============================================
function showWaiting(title, sub) {
    document.getElementById('loading-title').textContent = title;
    document.getElementById('loading-message').textContent = sub;
    showScreen(Screen.LOADING);
}

function buildGameHistoryText() {
    if (!gameState || gameState.history.length === 0) return '（初日のため履歴なし。過去を参照しないでください。）';
    let t = '';
    gameState.history.forEach((d, idx) => {
        const n = idx + 1;
        t += `\n--- Day ${n} ---\n`;
        t += n === 1 ? `襲撃: なし\n` : (d.attack ? `襲撃: ${d.attack} 死亡\n` : `襲撃: なし\n`);
        if (d.morningSpeeches?.length > 0) { t += `発言:\n`; d.morningSpeeches.forEach(s => { t += `  ${s.name}: 「${s.speech}」\n`; }); }
        if (d.votes && Object.keys(d.votes).length > 0) { t += `投票:\n`; Object.entries(d.votes).forEach(([v,tgt]) => { t += `  ${v} → ${tgt}\n`; }); }
        t += d.execution ? `処刑: ${d.execution}\n` : `処刑: なし\n`;
    });
    return t;
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
