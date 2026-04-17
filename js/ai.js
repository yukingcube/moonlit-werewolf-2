/* ============================================
   groq.js - AI API 連携 (Gemini対応版)
   ============================================ */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGroq(messages, temperature = 0.8, retries = 3) {
    const apiKey = localStorage.getItem(STORAGE_KEYS.API_KEY);
    const primaryModel = localStorage.getItem(STORAGE_KEYS.MODEL) || 'gemini-2.5-flash';
    if (!apiKey) throw new Error('ERR_NO_KEY: APIキーが設定されていません');

    const systemParts = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const userParts = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');

    const body = {
        contents: [{ parts: [{ text: userParts }], role: 'user' }],
        generationConfig: { temperature: temperature, responseMimeType: 'application/json' }
    };
    if (systemParts) body.systemInstruction = { parts: [{ text: systemParts }] };

    // 503エラーが続いたら軽量モデルにフォールバック
    const modelsToTry = [primaryModel];
    if (primaryModel === 'gemini-2.5-flash') modelsToTry.push('gemini-2.5-flash-lite');
    if (primaryModel === 'gemini-2.5-pro') modelsToTry.push('gemini-2.5-flash', 'gemini-2.5-flash-lite');

    for (const model of modelsToTry) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
                console.log(`[AI] Calling ${model}, attempt ${attempt+1}/${retries+1}`);

                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });

                if (response.status === 429) {
                    const wait = (attempt + 1) * 4000;
                    console.warn(`[AI] Rate limited (429). Wait ${wait}ms`);
                    if (attempt < retries) { await new Promise(r => setTimeout(r, wait)); continue; }
                    throw new Error('ERR_RATE: レート制限(429)');
                }

                if (response.status === 503) {
                    const wait = (attempt + 1) * 3000;
                    console.warn(`[AI] Server overloaded (503) on ${model}. Wait ${wait}ms`);
                    if (attempt < retries) { await new Promise(r => setTimeout(r, wait)); continue; }
                    // このモデルでのリトライを使い切った → 次のモデルへ
                    console.warn(`[AI] ${model} exhausted. Trying next model...`);
                    break; // 内側のforループを抜けて次のモデルへ
                }

                if (!response.ok) {
                    const errText = await response.text();
                    console.error('[AI] HTTP Error:', response.status, errText);
                    if (response.status === 400) throw new Error(`ERR_400: リクエスト不正 - ${errText.substring(0, 200)}`);
                    if (response.status === 403) throw new Error('ERR_403: APIキーの権限不足');
                    throw new Error(`ERR_HTTP_${response.status}: ${errText.substring(0, 100)}`);
                }

                const data = await response.json();
                console.log('[AI] Response received:', JSON.stringify(data).substring(0, 200));

                if (data.promptFeedback?.blockReason) {
                    throw new Error(`ERR_BLOCKED: 安全フィルターでブロック(${data.promptFeedback.blockReason})`);
                }
                if (!data.candidates || data.candidates.length === 0) {
                    throw new Error(`ERR_NO_CANDIDATES: candidates空。応答: ${JSON.stringify(data).substring(0, 200)}`);
                }
                const finishReason = data.candidates[0].finishReason;
                if (finishReason && finishReason !== 'STOP') {
                    throw new Error(`ERR_FINISH: 生成途中停止(${finishReason})`);
                }
                const text = data.candidates[0]?.content?.parts?.[0]?.text;
                if (!text) {
                    throw new Error(`ERR_EMPTY: 応答テキスト空`);
                }

                if (model !== primaryModel) console.log(`[AI] Success with fallback model: ${model}`);
                const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
                try { return JSON.parse(cleaned); }
                catch (parseErr) {
                    const m = cleaned.match(/\{[\s\S]*\}/);
                    if (m) { try { return JSON.parse(m[0]); } catch (e2) { throw new Error(`ERR_JSON: 解析失敗: ${m[0].substring(0, 100)}`); } }
                    throw new Error(`ERR_JSON: 解析失敗: ${cleaned.substring(0, 150)}`);
                }

            } catch (error) {
                console.error(`[AI] Attempt ${attempt+1} on ${model} failed:`, error.message);
                if (attempt < retries && (error.message.includes('ERR_RATE') || error.message.includes('fetch'))) {
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                // 503以外のエラーはモデルフォールバックせずにそのまま投げる
                if (!error.message.includes('503')) throw error;
                break; // 503なら次のモデルへ
            }
        }
    }
    // 全モデル・全リトライ失敗
    throw new Error('ERR_ALL_FAILED: 全モデルで失敗。Geminiサーバーが混雑中です。少し時間を置いてお試しください');
}

function getGameRulesBrief() {
    return `═══ 人狼ゲームのルール ═══
【概要】7人制。人狼2/占い師1/騎士1/霊媒師1/村人2
【勝利】村人陣営:人狼全員処刑 / 人狼陣営:生存人狼≧村人陣営
【流れ】夜(襲撃/占い/護衛/霊媒)→朝(結果+発言)→議論(伝言)→投票→処刑 ※Day1夜は襲撃なし
【用語】CO=役職公開/騙り=偽CO/白=村人側/黒=人狼
【必守】発言は推理・戦略のみ。キャラ設定(星占い等)を根拠にしない。「なんとなく」禁止。具体的根拠で発言する。`;
}

async function generateAICharacters(count) {
    const prompt = `ダークファンタジー世界の人狼ゲーム用キャラクター${count}人をJSON生成。
【項目】name(カタカナ2〜5文字),age(数字or"不詳"),occupation(職業),personality_tags(性格3つ配列),speech_style(口調+一人称),catchphrase(セリフ1文),background(背景1〜2文),lie_style(人狼時行動1文),reasoning_style(推理傾向1文),message_reaction_style("straightforward"/"skeptical"/"contrarian"/"logical"/"emotional"から1つ)
【制約】全員違う性格・職業・口調。暗く神秘的。
【出力】{"characters":[{...}]}のみ`;
    try {
        const r = await callGroq([{role:'system',content:'JSON形式のみ返す'},{role:'user',content:prompt}],1.0);
        if (r?.characters) return r.characters.slice(0,count);
        throw new Error('レスポンスにcharactersがない');
    } catch(e) {
        console.error('キャラ生成失敗:',e);
        // エラーメッセージをローディング画面に表示
        const loadingMsg = document.getElementById('loading-message');
        if (loadingMsg) {
            loadingMsg.innerHTML = `⚠️ API Error: ${escapeHtml ? escapeHtml(e.message) : e.message}<br>フォールバックキャラを使用します`;
            loadingMsg.style.color = '#c41e3a';
        }
        await new Promise(r => setTimeout(r, 2000)); // エラーを2秒間表示
        return shuffleArray(FALLBACK_CHARACTERS).slice(0,count);
    }
}

async function generateMorningSpeech(character, role, context) {
    const roleInfo = buildRoleContext(role, character, context);
    const roleStrategy = getRoleStrategy(role, character, context);
    const tags = (character.personality_tags||[]).map(t=>t.toLowerCase());
    const isDishonest = tags.some(t=>['狡猾','抜け目','策略','冷徹','謎めい','底知れ','皮肉'].some(k=>t.includes(k)));
    const isHonest = tags.some(t=>['素直','誠実','正直','お人好し','純粋','愚直'].some(k=>t.includes(k)));
    let hn = '';
    if (role==='werewolf'&&isHonest) hn='\n⚠️素直な性格で嘘が苦手。';
    if (role==='werewolf'&&isDishonest) hn='\n✓狡猾なので堂々と嘘をつける。';

    const prompt = `${getGameRulesBrief()}
═══ キャラ ═══ 名前:${character.name} 職業:${character.occupation}(雰囲気のみ) 性格:${character.personality_tags.join('、')}
═══ 役職:${ROLES[role].name} ═══ ${roleInfo}${hn}
═══ 戦略 ═══ ${roleStrategy}
═══ Day${context.day}朝 ═══
襲撃:${context.day===1?'なし(初日)':context.lastVictim?context.lastVictim+'死亡':'なし(護衛成功?)'}
処刑:${context.lastExecuted||'なし'} 生存者:${context.alivePlayers.join('、')}
═══ 履歴 ═══ ${context.gameHistory||'(初日)'}
${context.day===1?'⚠️Day1:過去の発言は存在しない。「○○の発言が」等禁止。役職に基づく方針のみ述べよ。':`Day${context.day}:過去の発言・投票を引用して推理せよ。`}
═══ 指示 ═══ 50〜120文字。推理・戦略のみ。❌星が告げる ❌なんとなく ❌雑談
占い師CO→宣言+対象+結果の3点セット必須。しないなら完全に村人として振る舞う。
騎士→「守る」「護衛」「騎士」禁止。完全に村人として発言。
霊媒師CO→宣言+対象+正体必須。しないなら完全に村人として振る舞う。
⚠️重要:「COしない」「今は控える」という発言自体が役職暴露になる。COしない場合は役職の存在すら匂わせず、普通の村人として推理発言のみ行うこと。
【出力】{"speech":"発言","internal_thought":"本音(1文)"}`;

    try {
        const r = await callGroq([{role:'system',content:'人狼プレイヤー。論理的発言。JSONのみ。'},{role:'user',content:prompt}],0.7);
        return {speech:r.speech||'...',internal_thought:r.internal_thought||'',error:null};
    } catch(e) {
        console.error('朝発言失敗:',e);
        return {speech:null,internal_thought:'',error:e.message||'不明なエラー'};
    }
}

function getRoleStrategy(role, character, context) {
    switch(role) {
        case 'werewolf': {
            const allies=context.werewolfAllies||[];
            const s=character._bluffStrategy;
            let b='';
            if(s?.type==='seer'&&s.fakeTarget) {
                const fr=s.fakeResult==='werewolf'?'人狼だった':'人狼ではなかった';
                b=`\n🎭占い師騙り。偽CO:${s.fakeTarget}→${fr}\n${context.day>=(s.startDay||2)?`今日CO。「私は占い師だ。${s.fakeTarget}を占った結果${fr}」と宣言。`:'まだCOしない。'}⚠️これは嘘。`;
            } else if(s?.type==='medium'&&context.lastExecuted) {
                const fr=s.fakeResult==='werewolf'?'人狼':'村人側';
                b=`\n🎭霊媒師騙り。「${context.lastExecuted}は${fr}だった」と偽CO。`;
            } else b=`\n村人として振る舞う。仲間(${allies.join('、')})を庇いすぎない。`;
            return `人狼。仲間:${allies.join('、')||'なし'}${b}\n❌自白❌仲間かばいすぎ❌仲間を黒出し`;
        }
        case 'villager': return '村人。能力なし。具体的推理で発言。';
        case 'seer': {
            const l=(context.fortuneResults||[]).slice(-1)[0];
            const d=l?`占い結果:${l.target}は${l.isWerewolf?'🐺人狼':'✨村人側'}`:'占い結果:なし';
            const a=(context.fortuneResults||[]).map(r=>`${r.target}→${r.isWerewolf?'黒':'白'}`).join('、');
            return `占い師。${d}${a?'\n全結果:'+a:''}
■ A: CO する → 「私は占い師です。昨夜○○を占って結果は△△でした」と3点セットで明言
■ B: CO しない → 完全に村人として振る舞う。以下全て禁止:
  ❌「占い」「結果」「占った」の単語を使う
  ❌「COしない」「まだCOは控える」等(=自分がCOできる立場だと暴露している)
  ❌ 占い師であることを匂わせるあらゆる表現`;
        }
        case 'knight': return `騎士。護衛能力あり。
■ 完全に村人として振る舞う。以下全て禁止:
  ❌「騎士」「守る」「護衛」の単語
  ❌「COしない」「役目を果たす」等(=特別な役職を持っていると暴露)
  ❌ 騎士であることを匂わせるあらゆる表現
→ 普通の村人として推理・疑いの発言のみ行う`;
        case 'medium': {
            const l=(context.mediumResults||[]).slice(-1)[0];
            const d=l?`霊媒結果:${l.target}は${ROLES[l.role].name}`:'霊媒結果:なし';
            return `霊媒師。${d}
■ A: CO する → 「私は霊媒師です。○○は△△でした」と明言
■ B: CO しない → 完全に村人として振る舞う。以下全て禁止:
  ❌「霊媒」「結果」「正体を知る」の単語を使う
  ❌「COしない」「霊媒師COはしない」等(=自分が霊媒師だと暴露している)
  ❌「結果がない」「対象がいない」等(=霊媒能力を持っていると暴露)
  ❌ 霊媒師であることを匂わせるあらゆる表現
→ COしないなら、自分はただの村人であるかのように推理発言のみ行う`;
        }
        default: return '';
    }
}

async function decideAIVote(character, role, context, messages) {
    const rp=buildRoleContext(role,character,context);
    const mt=messages.length>0?messages.map((m,i)=>typeof m==='string'?`伝言${i+1}:${m}`:`伝言${i+1}-${m.from}より:${m.text}`).join('\n'):'(伝言なし)';
    let bw='';
    if(role==='werewolf'&&character._bluffStrategy) {
        const s=character._bluffStrategy;
        if(s.type==='seer'&&s.fakeTarget) {
            const fr=s.fakeResult==='werewolf'?'人狼':'村人側';
            bw=`\n⚠️占い師騙り中。${s.fakeTarget}→${fr}は嘘。自分の嘘を信じるな。仲間(${(context.werewolfAllies||[]).join('、')})に投票するな。`;
        } else if(s.type==='medium') bw='\n⚠️霊媒師騙り中。偽結果を信じるな。仲間に投票するな。';
    }
    const prompt = `${getGameRulesBrief()}
═══投票═══ ${character.name}/性格:${character.personality_tags.join('、')}/推理:${character.reasoning_style}/伝言反応:${character.message_reaction_style}
役職:${ROLES[role].name} ${rp}${bw}
Day${context.day||1} 生存者:${context.alivePlayers.join('、')} 投票可能:${context.alivePlayers.filter(p=>p!==character.name).join('、')}
═══履歴═══ ${context.gameHistory||'(初日)'}
═══今日の発言═══ ${context.morningSpeeches||'(なし)'}
═══伝言═══ ${mt}
═══指示═══ 具体的理由で投票。「なんとなく」禁止。過去の発言・投票を引用。
{"vote_target":"名前","reasoning":"理由(1〜2文)","message_reaction":"伝言反応(1文)"}`;
    try {
        const r=await callGroq([{role:'system',content:'人狼プレイヤー。論理的投票。JSONのみ。'},{role:'user',content:prompt}],0.7);
        const valid=context.alivePlayers.filter(p=>p!==character.name);
        let t=r.vote_target;
        if(role==='werewolf'&&context.werewolfAllies?.includes(t)){const safe=valid.filter(x=>!context.werewolfAllies.includes(x));t=safe.length>0?randomPick(safe):t;}
        if(!valid.includes(t))t=valid.find(p=>t&&t.includes(p))||randomPick(valid);
        return{vote_target:t,reasoning:r.reasoning||'議論を踏まえて判断',message_reaction:r.message_reaction||''};
    } catch(e) {
        console.error('投票失敗:',e);
        let v=context.alivePlayers.filter(p=>p!==character.name);
        if(role==='werewolf'&&context.werewolfAllies){const s=v.filter(t=>!context.werewolfAllies.includes(t));if(s.length>0)v=s;}
        return{vote_target:randomPick(v),reasoning:`⚠️投票API失敗: ${e.message||'不明'}`,message_reaction:''};
    }
}

function buildRoleContext(role,character,context) {
    let t='';
    if(role==='werewolf'&&context.werewolfAllies)t+=`仲間:${context.werewolfAllies.join('、')}\n`;
    if(role==='seer'&&context.fortuneResults)t+=`占い:${context.fortuneResults.map(r=>`${r.target}=${r.isWerewolf?'黒':'白'}`).join(',')}\n`;
    if(role==='medium'&&context.mediumResults)t+=`霊媒:${context.mediumResults.map(r=>`${r.target}=${ROLES[r.role].name}`).join(',')}\n`;
    return t;
}

function fallbackSpeech(character,role,context) {
    const d=context?context.day:1;
    if(d===1)return randomPick(['まだ情報が少ないですが、占い師COを待ちたいと思います。','初日なので慎重に。皆の発言を聞いて判断しましょう。','全員が生存している今、冷静に議論を進めましょう。']);
    const m={werewolf:['怪しい人物がいます。投票先を慎重に考えましょう。'],seer:['占い結果について共有すべきか考えています。'],knight:['議論の流れから人狼の狙いを読みたいです。'],medium:['処刑結果について皆に伝えるべきことがあります。'],villager:['昨日の投票の流れが気になります。']};
    return randomPick(m[role]||m.villager);
}
