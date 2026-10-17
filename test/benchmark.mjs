/**
 * 基准测试：按 Anthropic 的真实缓存语义，逐轮模拟三种策略的命中率。
 *
 * 缓存语义（这是整个分析的基础）：
 *   - 前缀 = tools → system → messages，逐字节比对
 *   - 断点把「从头到该断点」的内容写进缓存
 *   - 下一轮请求能读出「最长的、确实是本轮前缀」的历史缓存
 *
 * 对比三种策略：
 *   A. ST 默认       —— 两个开关都关，不打任何断点
 *   B. ST 自带       —— enableSystemPromptCache + cachingAtDepth=0（用 ST 真实函数算断点）
 *   C. 本插件        —— 跨请求比对 + 最优断点布局
 *
 * 跑法：node test/benchmark.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectUnits, unitTexts, unitContents, planBreakpoints, findVolatileSystemUnits, findVolatileInjectedMessages, hoistVolatileToLastMessage, normalizeText } from '../plugin/lib/analyzer.js';
import { recordSnapshot, getSnapshots, bestStablePrefix, clearSnapshots } from '../plugin/lib/snapshots.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 复用 ST 自己的断点函数，保证对比真实
let cachingAtDepthForClaude = null;
try {
    const { setConfigFilePath } = await import(path.resolve(__dirname, '../../../src/util.js'));
    setConfigFilePath(path.resolve(__dirname, '../../../config.yaml'));
    ({ cachingAtDepthForClaude } = await import(path.resolve(__dirname, '../../../src/prompt-converters.js')));
} catch {
    console.warn('（未能加载 ST 的 prompt-converters，ST 自带策略将用等价实现代替）');
}

const T = s => JSON.stringify(s).length;

// ------------------------------------------------------------------ 场景

/**
 * 生成第 turn 轮的请求体。
 * @param {object} opts
 * @param {number} opts.turn 轮次
 * @param {boolean} opts.dynamicSystem system prompt 里有没有每轮变化的宏
 * @param {number|null} opts.deepInjection 深度注入的深度（null = 无）
 */
function buildRequest({ turn, dynamicSystem = false, deepInjection = null }) {
    const system = [
        { type: 'text', text: 'MAIN SYSTEM PROMPT. ' + 'a'.repeat(600) },
        { type: 'text', text: 'CHARACTER CARD. ' + 'b'.repeat(1800) },
        {
            type: 'text',
            text: dynamicSystem
                ? `WORLD INFO. ${'c'.repeat(900)} seed=${Math.floor(Math.random() * 1e9)}`
                : 'WORLD INFO. ' + 'c'.repeat(900),
        },
    ];

    const messages = [];
    for (let i = 0; i < turn; i++) {
        messages.push({ role: 'user', content: `User turn ${i}. ` + 'd'.repeat(150) });
        messages.push({ role: 'assistant', content: `Assistant turn ${i}. ` + 'e'.repeat(450) });
    }

    if (deepInjection !== null) {
        const idx = Math.max(0, messages.length - deepInjection);
        messages.splice(idx, 0, { role: 'system', content: `[MEMORY] recap ${turn}. ` + 'f'.repeat(300) });
    }

    // 关键：本轮待回复的这条，措辞要和它将来进入历史时一致。
    // 否则「第 N 轮的 prompt」就不是「第 N+1 轮 prompt」的前缀，
    // 测出来的命中率会被人为压低（这不是真实 ST 的行为）。
    messages.push({ role: 'user', content: `User turn ${turn}. ` + 'd'.repeat(150) });

    return { model: 'claude-sonnet-5', system, messages };
}

// ------------------------------------------------------------------ 缓存模型

/** 一轮请求里写入的缓存前缀（用单元文本签名表示） */
function prefixesFromBreakpoints(texts, indices) {
    return indices.map(i => texts.slice(0, i + 1));
}

function isPrefixOf(candidate, full) {
    if (candidate.length > full.length) {
        return false;
    }
    for (let i = 0; i < candidate.length; i++) {
        if (candidate[i] !== full[i]) {
            return false;
        }
    }
    return true;
}

/** 在历史缓存里找最长的、确实是本轮前缀的那一条 */
function findHit(history, texts) {
    let best = 0;
    for (const prefix of history) {
        if (prefix.length > best && isPrefixOf(prefix, texts)) {
            best = prefix.length;
        }
    }
    return best;
}

// ------------------------------------------------------------------ 策略

const strategies = {
    /** A. ST 默认：不打断点，也就没有缓存写入 */
    'ST 默认（开关全关）': {
        plan() { return []; },
    },

    /** B. ST 自带：system 打末块 + 深度断点 */
    'ST 自带（全开）': {
        plan(units, body) {
            const indices = [];
            // enableSystemPromptCache → 标记最后一个 system 块
            let lastSystem = -1;
            units.forEach((u, i) => { if (u.kind === 'system') lastSystem = i; });
            if (lastSystem >= 0) {
                indices.push(lastSystem);
            }
            // cachingAtDepth = 0 → 在 messages 上按深度打 2 个点
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
                    if (m.content.some(p => p.cache_control)) {
                        indices.push(systemCount + mi);
                    }
                });
            }
            return [...new Set(indices)].sort((a, b) => a - b).slice(0, 4);
        },
    },

    /** C. 本插件：跨请求比对 + 最优布局 + 风险闸门 */
    '本插件': {
        plan(units, body, key) {
            const texts = unitTexts(units);
            const { stableCount, matchedLength, maxSnapshotLength, latestSnapshotLength } = bestStablePrefix(texts, getSnapshots(key));
            const plan = planBreakpoints({
                units, stableCount, matchedLength, maxSnapshotLength, latestSnapshotLength, maxBreakpoints: 4,
            });
            return plan.indices;
        },
        after(units, body, key) {
            recordSnapshot(key, unitTexts(units), [...unitContents(units), ...(globalThis.__beforeHoist ?? [])]);
        },
        reset() { clearSnapshots(); },
    },

    /** D. 本插件 + hoist：额外把易变块搬到本轮最后一条 user 消息 */
    '本插件 + hoist': {
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
            const { stableCount, matchedLength, maxSnapshotLength, latestSnapshotLength } = bestStablePrefix(texts, getSnapshots(key));
            const plan = planBreakpoints({
                units, stableCount, matchedLength, maxSnapshotLength, latestSnapshotLength, maxBreakpoints: 4,
            });
            return plan.indices;
        },
        after(units, body, key) {
            recordSnapshot(key, unitTexts(collectUnits(body)), unitContents(collectUnits(body)));
        },
        reset() { clearSnapshots(); },
    },

    /** E. 本插件 + hoist + 缓存保活：挂机也不会冷启动 */
    '本插件+hoist+保活': {
        keepalive: true,
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
            const { stableCount, matchedLength, maxSnapshotLength, latestSnapshotLength } = bestStablePrefix(texts, getSnapshots(key));
            const plan = planBreakpoints({
                units, stableCount, matchedLength, maxSnapshotLength, latestSnapshotLength, maxBreakpoints: 4,
            });
            return plan.indices;
        },
        after(units, body, key) {
            recordSnapshot(key, unitTexts(collectUnits(body)), unitContents(collectUnits(body)));
        },
        reset() { clearSnapshots(); },
    },
};

// ------------------------------------------------------------------ 跑一轮

function runScenario({ name, dynamicSystem = false, deepInjection = null, turns = 40, idleOverTtl = false }) {
    const results = {};

    for (const [label, strategy] of Object.entries(strategies)) {
        strategy.reset?.();
        let history = [];
        let hitTotal = 0;
        let allTotal = 0;
        const perTurn = [];

        for (let turn = 1; turn <= turns; turn++) {
            const body = buildRequest({ turn, dynamicSystem, deepInjection });

            // 策略可能改写 body（hoist 会搬动内容）。命中、写入、分母三者
            // 都必须基于「改写后真正发出去的那份内容」，否则指标会自欺欺人。
            const indices = strategy.plan(collectUnits(body), body, 'bench');
            strategy.after?.(collectUnits(body), body, 'bench');

            const texts = unitTexts(collectUnits(body));
            const total = texts.reduce((a, t) => a + T(t), 0);

            // 超过 TTL 且没有保活 → 缓存已经过期，一条都读不到
            if (idleOverTtl && !strategy.keepalive) {
                history = [];
            }

            // 先算命中，再写新缓存（与真实时序一致）
            const hitUnits = findHit(history, texts);
            const hit = texts.slice(0, hitUnits).reduce((a, t) => a + T(t), 0);

            const written = prefixesFromBreakpoints(texts, indices);
            if (written.length > 0) {
                history = [...history, ...written];
                // 控制历史规模
                if (history.length > 60) {
                    history = history.slice(-60);
                }
            }

            hitTotal += hit;
            allTotal += total;
            perTurn.push({ turn, rate: total > 0 ? hit / total : 0 });
        }

        results[label] = {
            avg: allTotal > 0 ? hitTotal / allTotal : 0,
            tail: perTurn.slice(-10).reduce((a, r) => a + r.rate, 0) / Math.min(10, perTurn.length),
            perTurn,
        };
    }

    return { name, results };
}

// ------------------------------------------------------------------ 输出

const scenarios = [
    { name: '① 全静态提示词（理想情况）', dynamicSystem: false, deepInjection: null },
    { name: '② system 含 {{random}} 宏', dynamicSystem: true, deepInjection: null },
    { name: '③ 深度注入（memory/向量，depth=2）', dynamicSystem: false, deepInjection: 2 },
    { name: '④ 动态 system + 深度注入（最恶劣）', dynamicSystem: true, deepInjection: 2 },
    // ★ 真实使用最常见的情形：回完消息你去想、去查、去改，间隔常常超过 5 分钟 TTL
    { name: '⑤ 全静态 + 每轮间隔超过 TTL', dynamicSystem: false, deepInjection: null, idleOverTtl: true },
    { name: '⑥ 动态 system + 间隔超 TTL', dynamicSystem: true, deepInjection: null, idleOverTtl: true },
];

console.log('SillyTavern 提示词缓存命中率基准');
console.log('（40 轮对话，按 Anthropic 前缀精确匹配语义模拟）\n');

const summary = [];
for (const scenario of scenarios) {
    const { name, results } = runScenario(scenario);
    console.log(`\n${name}`);
    console.log('  策略'.padEnd(26) + '平均命中率   稳态命中率(末10轮)');
    console.log('  ' + '-'.repeat(52));
    for (const [label, r] of Object.entries(results)) {
        const avg = (r.avg * 100).toFixed(1).padStart(8);
        const tail = (r.tail * 100).toFixed(1).padStart(14);
        console.log(`  ${label.padEnd(24)}${avg}%${tail}%`);
    }
    summary.push({ name, results });
}

console.log('\n\n===== 汇总（稳态命中率，末 10 轮）=====');
const COLS = [
    ['ST 默认（开关全关）', 'ST默认'],
    ['ST 自带（全开）', 'ST自带'],
    ['本插件', '本插件'],
    ['本插件 + hoist', '+hoist'],
    ['本插件+hoist+保活', '+保活'],
];
console.log('场景'.padEnd(30) + COLS.map(c => c[1].padStart(9)).join(''));
console.log('-'.repeat(30 + COLS.length * 9));
for (const { name, results } of summary) {
    console.log(
        name.padEnd(28)
        + COLS.map(([k]) => `${(results[k].tail * 100).toFixed(1)}%`.padStart(9)).join(''),
    );
}

console.log('\n说明：');
console.log('  · hoist = 把检测到的易变块搬到本轮最后一条 user 消息里，');
console.log('    使静态内容 + 对话历史连成一条稳定的前缀，命中率随对话增长趋近 100%。');
console.log('  · hoist 会改变内容在 prompt 中的位置，默认关闭，需在 config 里显式开启。');
console.log('  · 剩余 miss 是「本轮新增内容」（上一轮回复 + 本轮输入），这部分不可能命中，');
console.log('    因此稳态上限不是 100% 而是趋近 100%。');
