/**
 * realistic.mjs —— 真实 ST prompt 结构下的缓存命中率。
 *
 * 和 benchmark.mjs 的区别：那个用的是理想化的「3 段系统提示 + 纯历史」，
 * 这里按 SillyTavern 实际的组装方式建模：
 *
 *   系统区（= Anthropic 的 system 数组，按顺序）
 *     [0] 预设主提示词        （可能含 {{random}}）
 *     [1] 世界书 ↑Char        （激活集合每轮会变）
 *     [2] 角色卡（描述/性格/场景）
 *     [3] 世界书 ↓Char
 *     [4] 对话示例
 *   消息区
 *     [..] 对话历史（逐轮增长）
 *     [..] atDepth 注入（世界书深度条目 / 记忆 / 向量召回）
 *     [..] 本轮用户输入
 *
 * 世界书激活用的是「关键字命中最近 N 条消息」这套真实机制，
 * 所以激活集合会随对话漂移 —— 这正是缓存最大的威胁。
 *
 * 跑法：node test/realistic.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectUnits, unitTexts, unitContents, planBreakpoints, findVolatileSystemUnits, findVolatileInjectedMessages, hoistVolatileToLastMessage } from '../plugin/lib/analyzer.js';
import { recordSnapshot, getSnapshots, bestStablePrefix, clearSnapshots } from '../plugin/lib/snapshots.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachingAtDepthForClaude = null;
try {
    const { setConfigFilePath } = await import(path.resolve(__dirname, '../../../src/util.js'));
    setConfigFilePath(path.resolve(__dirname, '../../../config.yaml'));
    ({ cachingAtDepthForClaude } = await import(path.resolve(__dirname, '../../../src/prompt-converters.js')));
} catch {
    console.warn('（未加载 ST 的 prompt-converters，ST 自带策略用等价实现）');
}

const T = s => JSON.stringify(s).length;

/** 确定性伪随机，保证每次跑结果一致 */
function mulberry32(seed) {
    return function rand() {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ------------------------------------------------------------------ 素材

const MAIN_PROMPT = 'You are a roleplay assistant. Stay in character. '.repeat(10);   // ~500 chars
const CARD_DESCRIPTION = 'Name: Alice. Appearance: ... Personality: ... '.repeat(40);  // ~2k
const CARD_SCENARIO = 'The story takes place in a quiet coastal town. '.repeat(20);
const EXAMPLES = 'Example dialogue line. '.repeat(30);

/** 20 条世界书条目，各带 2 个触发关键词 */
const WORLD_ENTRIES = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    keys: [`kw${i}a`, `kw${i}b`],
    content: `[WI ${i}] ` + 'lore text '.repeat(30),   // ~300 chars each
    order: i,
}));

/** 关键字命中最近 N 条消息 → 该条目激活（这就是 ST 的真实机制） */
function activeEntries(turn, scanWindow = 6, churn = 0, settleAt = Infinity) {
    // 话题收敛：过了 settleAt 轮之后，激活集合冻结不再变化
    if (turn > settleAt) {
        turn = settleAt;
    }
    const rand = mulberry32(turn * 7919);
    /** @type {number[]} */
    const active = [];

    // 底噪：早期主题留下 3 条常驻条目
    for (let i = 0; i < 3; i++) {
        active.push(i);
    }

    // 近期主题：最近几轮提到的关键词
    const recentStart = Math.max(0, turn - scanWindow);
    for (let t = recentStart; t <= turn; t++) {
        const r = mulberry32(t * 104729);
        active.push(3 + Math.floor(r() * 10));
    }

    // churn：每轮额外的进出（模拟话题漂移）
    if (churn > 0) {
        const r = mulberry32(turn * 15485863);
        for (let i = 0; i < churn; i++) {
            active.push(3 + Math.floor(r() * 17));
        }
    }

    return [...new Set(active)].sort((a, b) => a - b);
}

// ------------------------------------------------------------------ 构建请求

/**
 * @param {object} opts
 * @param {number} opts.turn
 * @param {'none'|'static'|'drift'} opts.worldInfo 世界书模式
 * @param {boolean} opts.wiRandom 世界书内容含随机
 * @param {boolean} opts.presetRandom 预设主提示词含随机
 * @param {boolean} opts.wiAtDepth 世界书放在 atDepth 而非系统区
 * @param {number} opts.depthInjection 记忆/向量注入的深度（0=无）
 */
function buildRequest({
    turn,
    worldInfo = 'none',
    wiRandom = false,
    wiRandomCount = Infinity,
    presetRandom = false,
    wiAtDepth = false,
    depthInjection = 0,
    wiSettleAt = Infinity,
    // 真实扮演里回复通常很长，这是决定「固定开销」占比的关键参数
    assistantChars = 1200,
    userChars = 300,
}) {
    const rand = mulberry32(turn * 31337);

    const system = [];

    // [0] 预设主提示词
    system.push({
        type: 'text',
        text: presetRandom ? `${MAIN_PROMPT} seed=${Math.floor(rand() * 1e9)}` : MAIN_PROMPT,
    });

    const wiEntries = worldInfo === 'none'
        ? []
        : worldInfo === 'static'
            ? WORLD_ENTRIES.slice(0, 8)          // 固定 8 条
            : activeEntries(turn, 6, 2, wiSettleAt).map(i => WORLD_ENTRIES[i]);   // 漂移

    const wiText = (entries) => entries
        .map((e, i) => (wiRandom && i < wiRandomCount)
            ? `${e.content} r=${Math.floor(rand() * 1e9)}`
            : e.content)
        .join('\n');

    // [1] 世界书 ↑Char（系统区）
    if (wiEntries.length && !wiAtDepth) {
        system.push({ type: 'text', text: wiText(wiEntries) });
    }

    // [2] 角色卡
    system.push({ type: 'text', text: CARD_DESCRIPTION + CARD_SCENARIO });
    // [3] 对话示例
    system.push({ type: 'text', text: EXAMPLES });

    // ---- 消息区 ----
    const messages = [];
    for (let i = 0; i < turn; i++) {
        messages.push({
            role: 'user',
            content: `Turn ${i}: I look around and ask about kw${i % 20}a. ` + 'u'.repeat(Math.max(0, userChars - 40)),
        });
        messages.push({
            role: 'assistant',
            content: `Turn ${i}: Alice responds thoughtfully. ` + 'a'.repeat(Math.max(0, assistantChars - 35)),
        });
    }

    // atDepth 注入：世界书深度条目 / 记忆 / 向量召回
    if (depthInjection > 0) {
        const idx = Math.max(0, messages.length - depthInjection);
        messages.splice(idx, 0, {
            role: 'system',
            content: `[MEMORY] recap for turn ${turn}. ` + 'm'.repeat(250),
        });
    }

    // 世界书放 atDepth（真实 ST 的 depth 位置）
    if (wiEntries.length && wiAtDepth) {
        messages.splice(Math.max(0, messages.length - 4), 0, {
            role: 'system',
            content: wiText(wiEntries),
        });
    }

    messages.push({ role: 'user', content: `Turn ${turn}: I continue the conversation.` });

    return { model: 'claude-sonnet-5', system, messages };
}

// ------------------------------------------------------------------ 缓存模型

const isPrefixOf = (candidate, full) =>
    candidate.length <= full.length && candidate.every((k, i) => k === full[i]);

function findHit(history, texts) {
    let best = 0;
    for (const prefix of history) {
        if (prefix.length > best && isPrefixOf(prefix, texts)) {
            best = prefix.length;
        }
    }
    return best;
}

function prefixesFrom(texts, indices) {
    return indices.map(i => texts.slice(0, i + 1));
}

// ------------------------------------------------------------------ 策略

const strategies = {
    'ST自带': {
        plan(units, body) {
            const indices = [];
            let lastSystem = -1;
            units.forEach((u, i) => { if (u.kind === 'system') lastSystem = i; });
            if (lastSystem >= 0) indices.push(lastSystem);

            if (cachingAtDepthForClaude) {
                const converted = {
                    messages: body.messages.map(m => ({
                        role: m.role,
                        content: [{ type: 'text', text: typeof m.content === 'string' ? m.content : '' }],
                    })),
                };
                cachingAtDepthForClaude(converted.messages, 0, '5m');
                const systemCount = units.filter(u => u.kind === 'system').length;
                converted.messages.forEach((m, mi) => {
                    if (m.content.some(p => p.cache_control)) indices.push(systemCount + mi);
                });
            }
            return [...new Set(indices)].sort((a, b) => a - b).slice(0, 4);
        },
    },

    '本插件': {
        plan(units, body, key) {
            const texts = unitTexts(units);
            const b = bestStablePrefix(texts, getSnapshots(key));
            return planBreakpoints({ units, ...b, maxBreakpoints: 4 }).indices;
        },
        after(units, body, key) {
            recordSnapshot(key, unitTexts(units), [...unitContents(units), ...(globalThis.__beforeHoist ?? [])]);
        },
        reset() { clearSnapshots(); },
    },

    '本插件+hoist': {
        plan(units, body, key) {
            const snapshots = getSnapshots(key);
            const beforeHoist = unitContents(units);
            globalThis.__beforeHoist = beforeHoist;
            if (snapshots.length > 0) {
                const prevC = snapshots[0].contents ?? [];
                const idx = findVolatileSystemUnits(units, prevC);
                const inj = findVolatileInjectedMessages(units, prevC);
                if (idx.length > 0 || inj.length > 0) {
                    const volatileTexts = new Set([...idx.map(i => units[i].text), ...inj.map(i => units[i].text)]);
                    const injected = new Set(inj.map(i => units[i].text));
                    if (hoistVolatileToLastMessage(body, volatileTexts, snapshots.map(s => s.contents ?? []), injected) > 0) {
                        units = collectUnits(body);
                    }
                }
            }
            const texts = unitTexts(units);
            const b = bestStablePrefix(texts, getSnapshots(key));
            return planBreakpoints({ units, ...b, maxBreakpoints: 4 }).indices;
        },
        after(units, body, key) {
            recordSnapshot(key, unitTexts(units), [...unitContents(units), ...(globalThis.__beforeHoist ?? [])]);
        },
        reset() { clearSnapshots(); },
    },
};

// ------------------------------------------------------------------ 跑

function run(opts, turns = 40) {
    const results = {};

    for (const [label, strategy] of Object.entries(strategies)) {
        strategy.reset?.();
        let history = [];
        let hitTotal = 0;
        let totalChars = 0;
        const perTurn = [];

        for (let turn = 1; turn <= turns; turn++) {
            const body = buildRequest({ ...opts, turn });

            const indices = strategy.plan(collectUnits(body), body, 'k');
            strategy.after?.(collectUnits(body), body, 'k');

            const texts = unitTexts(collectUnits(body));
            const total = texts.reduce((a, t) => a + T(t), 0);

            const hitUnits = findHit(history, texts);
            const hit = texts.slice(0, hitUnits).reduce((a, t) => a + T(t), 0);

            const written = prefixesFrom(texts, indices);
            if (written.length) {
                history = [...history, ...written];
                if (history.length > 400) history = history.slice(-400);
            }

            hitTotal += hit;
            totalChars += total;
            perTurn.push(total > 0 ? hit / total : 0);
        }

        const tail = perTurn.slice(-10);
        results[label] = {
            avg: totalChars > 0 ? hitTotal / totalChars : 0,
            tail: tail.reduce((a, r) => a + r, 0) / tail.length,
        };
    }

    return results;
}

// ------------------------------------------------------------------ 场景

const scenarios = [
    { name: '① 全静态（无世界书）', opts: {} },
    { name: '①b 全静态·短消息(300字)', opts: { assistantChars: 300 } },
    { name: '② 世界书固定 8 条', opts: { worldInfo: 'static' } },
    { name: '③ 世界书激活集漂移', opts: { worldInfo: 'drift' } },
    { name: '④ 世界书内容含随机', opts: { worldInfo: 'static', wiRandom: true } },
    { name: '⑤ 预设主提示词含随机', opts: { presetRandom: true } },
    { name: '⑥ 世界书放 atDepth', opts: { worldInfo: 'drift', wiAtDepth: true } },
    { name: '⑦ 记忆注入 depth=4', opts: { worldInfo: 'drift', depthInjection: 4 } },
    { name: '⑨ 世界书漂移→第15轮收敛', opts: { worldInfo: 'drift', wiSettleAt: 15 } },
    {
        name: '⑧ 最恶劣组合',
        opts: { worldInfo: 'drift', wiRandom: true, presetRandom: true, depthInjection: 4 },
    },
    {
        name: '⑧r 部分随机(10条中3条)',
        opts: { worldInfo: 'drift', wiRandom: true, wiRandomCount: 3, presetRandom: true, depthInjection: 4 },
    },
    {
        name: '⑧@60轮 最恶劣组合',
        opts: { worldInfo: 'drift', wiRandom: true, presetRandom: true, depthInjection: 4 },
        turns: 60,
    },
    {
        name: '⑧b 最恶劣·短消息(300字)',
        opts: { worldInfo: 'drift', wiRandom: true, presetRandom: true, depthInjection: 4, assistantChars: 300 },
    },
];

console.log('真实 ST prompt 结构下的缓存命中率');
console.log('（40 轮，含世界书激活漂移、预设/世界书随机、深度注入）\n');

const rows = [];
for (const { name, opts, turns } of scenarios) {
    const r = run(opts, turns);
    rows.push({ name, r });
}

console.log('场景'.padEnd(30) + 'ST自带'.padStart(10) + '本插件'.padStart(10) + '+hoist'.padStart(10));
console.log('-'.repeat(60));
for (const { name, r } of rows) {
    console.log(
        name.padEnd(28)
        + `${(r['ST自带'].tail * 100).toFixed(1)}%`.padStart(10)
        + `${(r['本插件'].tail * 100).toFixed(1)}%`.padStart(10)
        + `${(r['本插件+hoist'].tail * 100).toFixed(1)}%`.padStart(10),
    );
}

console.log('\n（稳态命中率，末 10 轮）');
