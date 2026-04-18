/* ============================================
   gameData.js - 定数と基本データ
   ============================================ */

const ROLES = {
    werewolf: { name: '人狼', icon: '🐺', team: 'werewolf', description: '夜に1人を襲撃します。人狼仲間と協力して村人を倒しましょう。' },
    seer: { name: '占い師', icon: '🔮', team: 'villager', description: '夜に1人を占い、その人が人狼かどうかを知ることができます。' },
    knight: { name: '騎士', icon: '🛡️', team: 'villager', description: '夜に1人を選び、人狼の襲撃から守ることができます。' },
    medium: { name: '霊媒師', icon: '👻', team: 'villager', description: '夜に、前日処刑された人物の役職を知ることができます。' },
    villager: { name: '村人', icon: '🧑', team: 'villager', description: '特殊能力はありませんが、議論と投票で人狼を見つけ出しましょう。' }
};

const ROLE_COMPOSITION = ['werewolf', 'werewolf', 'seer', 'knight', 'medium', 'villager', 'villager'];

const AI_AVATARS = ['🧙‍♂️', '🧙‍♀️', '🧝‍♂️', '🧝‍♀️', '🧛‍♂️', '🧛‍♀️', '🕵️‍♂️', '🕵️‍♀️', '👨‍🎤', '👩‍🎤', '🧑‍🌾', '👨‍🍳', '👩‍⚕️', '🤴', '👸', '🧞', '🧚', '🧜'];
const HUMAN_AVATAR = '👤';

const FALLBACK_CHARACTERS = [
    { name: 'タロウ', age: '28', occupation: '元刑事', personality_tags: ['冷静', '論理的', '疑い深い'], speech_style: '〜だな / 俺', catchphrase: '真実は現場にある', background: '5年前の未解決事件を追う元刑事。', lie_style: '話題を逸らす', reasoning_style: '矛盾を突く', message_reaction_style: 'skeptical' },
    { name: 'エルシー', age: '19', occupation: '薬草売り', personality_tags: ['優しい', '素直', '天然'], speech_style: '〜なの / わたし', catchphrase: '森の声を聞いてみて', background: '森の奥で母と暮らしていたが村に降りてきた。', lie_style: '嘘が下手', reasoning_style: '直感で判断', message_reaction_style: 'straightforward' },
    { name: 'カルロ', age: '不詳', occupation: '仮面の道化', personality_tags: ['謎めいた', '皮肉屋', '底知れない'], speech_style: '〜さ / 私', catchphrase: '素顔など忘れたさ', background: '数年前に村に流れ着いた旅芸人。', lie_style: '飄々と語る', reasoning_style: '皮肉な観察眼', message_reaction_style: 'contrarian' },
    { name: 'アルフ', age: '52', occupation: '墓守', personality_tags: ['寡黙', '信心深い', '秘密主義'], speech_style: '〜じゃ / わし', catchphrase: '死者は語らぬが見ている', background: '30年この村の墓地を守り続けている。', lie_style: '無口を装う', reasoning_style: '長年の観察', message_reaction_style: 'logical' },
    { name: 'リリア', age: '23', occupation: '星占い師', personality_tags: ['気まぐれ', '感情的', '情熱的'], speech_style: '〜わ / あたし', catchphrase: '星は嘘をつかないわ', background: '星を読む力を受け継いだ。', lie_style: '感情的になって失言', reasoning_style: '直感と印象', message_reaction_style: 'emotional' },
    { name: 'グレン', age: '41', occupation: '元騎士', personality_tags: ['誠実', '傷心', '責任感'], speech_style: '〜だ / 私', catchphrase: '守れぬ者に何の価値がある', background: '王国騎士だったが守れなかった過去を背負う。', lie_style: '嘘が続かない', reasoning_style: '騎士の観察眼', message_reaction_style: 'logical' },
    { name: 'ミラ', age: '17', occupation: '見習い錬金術師', personality_tags: ['好奇心旺盛', '大胆', '抜け目ない'], speech_style: '〜だよ / ボク', catchphrase: '実験は成功の母だよ', background: '師匠の元を飛び出した見習い。', lie_style: '堂々と嘘をつく', reasoning_style: '実験的に仮説検証', message_reaction_style: 'logical' },
    { name: 'ヴァル', age: '35', occupation: '傭兵', personality_tags: ['豪快', '直情的', '義理堅い'], speech_style: '〜ぜ / 俺', catchphrase: '剣で解決できねぇ問題だな', background: '戦場を渡り歩く流れ者の傭兵。', lie_style: '嘘がバレやすい', reasoning_style: '直感と力で押す', message_reaction_style: 'emotional' },
    { name: 'セレナ', age: '29', occupation: '修道女', personality_tags: ['穏やか', '聡明', '策略家'], speech_style: '〜ですわ / わたくし', catchphrase: '神は全てをご覧になっていますわ', background: '修道院から派遣された聡明な女性。', lie_style: '巧みに立ち回る', reasoning_style: '冷静に分析', message_reaction_style: 'skeptical' },
    { name: 'ダリオ', age: '45', occupation: '商人', personality_tags: ['狡猾', '計算高い', '社交的'], speech_style: '〜でしょう / 私', catchphrase: '取引は信頼が全てですよ', background: '各地を巡る旅商人。情報通。', lie_style: '自然に嘘を混ぜる', reasoning_style: '利害関係から推理', message_reaction_style: 'skeptical' },
    { name: 'フィン', age: '20', occupation: '吟遊詩人', personality_tags: ['陽気', 'お調子者', '鋭い'], speech_style: '〜だね / 僕', catchphrase: '歌にすればみんなの記憶に残るさ', background: '旅をしながら歌を歌う青年。', lie_style: '笑いでごまかす', reasoning_style: '人の表情を読む', message_reaction_style: 'emotional' },
    { name: 'ノワール', age: '不詳', occupation: '呪術師', personality_tags: ['冷徹', '孤高', '洞察力'], speech_style: '〜だ / 我', catchphrase: '闇の中にこそ真実がある', background: '村外れに住む謎多き呪術師。', lie_style: '沈黙で逃げる', reasoning_style: '論理と洞察', message_reaction_style: 'logical' }
];

const STORAGE_KEYS = {
    PLAYER_NAME: 'player_name',
    API_KEY: 'gemini_api_key',
    MODEL: 'preferred_model',
    HAS_ONBOARDED: 'has_completed_onboarding',
};

const Screen = {
    TITLE: 'screen-title', SETTINGS: 'screen-settings', RULES: 'screen-rules',
    LOADING: 'screen-loading', CHARACTERS: 'screen-characters', ROLE: 'screen-role',
    NIGHT: 'screen-night', MORNING: 'screen-morning', DISCUSSION: 'screen-discussion',
    VOTING_PROCESS: 'screen-voting-process', VOTING: 'screen-voting',
    EXECUTION: 'screen-execution', RESULT: 'screen-result', THOUGHTS: 'screen-thoughts',
};

function shuffleArray(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function randomPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
