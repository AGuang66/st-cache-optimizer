/**
 * 算法层单元测试。跑法：node test/algorithms.test.mjs
 */

import {
    collectUnits,
    unitTexts,
    planBreakpoints,
    longestCommonPrefix,
    stripAllCacheControl,
    relocateVolatileSystemBlocks,
    relocateVolatileMessageSystems,
    normalizeText,
    hoistVolatileToLastMessage,
    unitContents,
    findVolatileSystemUnits,
} from '../plugin/lib/analyzer.js';
import { recordSnapshot, getSnapshots, bestStablePrefix, clearSnapshots } from '../plugin/lib/snapshots.js';
import { parseUsage, scanSseUsage, summarize, recordUsage, clearStats } from '../plugin/lib/stats.js';

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
    if (cond) {
        pass++;
        console.log(`  \u2713 ${name}`);
    } else {
        fail++;
        console.log(`  \u2717 ${name} ${extra}`);
    }
}

function section(title) {
    console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------- LCP

section('最长公共前缀');
check('完全相同', longestCommonPrefix(['a', 'b', 'c'], ['a', 'b', 'c']) === 3);
check('部分匹配', longestCommonPrefix(['a', 'b', 'x'], ['a', 'b', 'c']) === 2);
check('首项即不同', longestCommonPrefix(['x', 'b'], ['a', 'b']) === 0);
check('空数组', longestCommonPrefix([], ['a']) === 0);
check('一长一短', longestCommonPrefix(['a'], ['a', 'b']) === 1);

// ---------------------------------------------------------------- collectUnits

section('请求体拆解');
const body = {
    tools: [{ name: 't1' }, { name: 't2' }],
    system: [{ type: 'text', text: 'S1' }, { type: 'text', text: 'S2' }],
    messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    ],
};
const units = collectUnits(body);
check('单元数 = tools2 + system2 + messages2', units.length === 6, `得到 ${units.length}`);
check('顺序严格为 tools -> system -> messages',
    units.slice(0, 2).every(u => u.kind === 'tool')
    && units.slice(2, 4).every(u => u.kind === 'system')
    && units.slice(4).every(u => u.kind === 'message'));

section('断点标记能力');
const cc = { type: 'ephemeral', ttl: '5m' };
check('tool 可标记', units[0].mark(cc) === true);
check('字符串 content 可标记', units[4].mark(cc) === true);
check('数组 content 可标记', units[5].mark(cc) === true);
check('字符串被转成数组（Anthropic 要求）', Array.isArray(body.messages[0].content), JSON.stringify(body.messages[0].content));
check('标记不改变比对文本', unitTexts(collectUnits(body)).length === 6);

section('清除既有断点');
stripAllCacheControl(body);
check('cache_control 全部清掉', (JSON.stringify(body).match(/cache_control/g) ?? []).length === 0);

// ---------------------------------------------------------------- planBreakpoints

section('断点规划：单调追加的对话（敢赌末尾）');
const mkUnits = n => Array.from({ length: n }, (_, i) => ({ kind: 'message', role: 'user', text: `T${i}`, mark: () => true, unmark: () => {} }));
// 上一轮请求长度 10，本轮 12：说明上一轮被完整保留（stableCount >= maxSnapshotLength）
const staticPlan = planBreakpoints({ units: mkUnits(12), stableCount: 10, matchedLength: 10, maxSnapshotLength: 10, maxBreakpoints: 4 });
check('不超过断点上限', staticPlan.indices.length <= 4, `${staticPlan.indices}`);
check('包含稳定边界 (idx 9)', staticPlan.indices.includes(9), `${staticPlan.indices}`);
check('包含末尾 (idx 11)', staticPlan.indices.includes(11), `${staticPlan.indices}`);
check('判定为单调追加', staticPlan.appendOnly === true);
check('无污染点', staticPlan.corruptedAt === null);
check('升序去重', staticPlan.indices.every((v, i) => i === 0 || v > staticPlan.indices[i - 1]));

section('断点规划：前缀被动态内容污染（不敢赌末尾）');
// 20 个单元，最长公共前缀只有 5，上一轮快照长 18 -> 中间被污染
const riskyPlan = planBreakpoints({ units: mkUnits(20), stableCount: 5, matchedLength: 0, maxSnapshotLength: 18, maxBreakpoints: 4 });
check('判定为前缀已污染', riskyPlan.appendOnly === false, `stableCount=${riskyPlan.corruptedAt}`);
check('\u2605 末尾没有断点（避免整段历史按写入价计费）', !riskyPlan.indices.includes(19), `${riskyPlan.indices}`);
check('\u2605 稳定边界仍有断点', riskyPlan.indices.includes(4), `${riskyPlan.indices}`);
check('断点全部落在安全区内', riskyPlan.indices.every(i => i <= 4), `${riskyPlan.indices}`);
console.log(`    污染点 idx${riskyPlan.corruptedAt}，断点 [${riskyPlan.indices}]，末尾断点已放弃`);

section('断点规划：多会话共用 key 时不误判');
// 另一个会话留下了一条很长的快照(maxSnapshotLength=50)，
// 本会话最近一次只有 10 个单元且被完整保留 —— 应判定为单调追加，
// 而不是被别的会话的 50 拖成"已污染"。
const multi = planBreakpoints({
    units: mkUnits(12), stableCount: 10, matchedLength: 10,
    maxSnapshotLength: 50, latestSnapshotLength: 10, maxBreakpoints: 4,
});
check('\u2605 按最近快照判断为单调追加', multi.appendOnly === true, `stable=${10} latest=10`);
check('末尾有断点', multi.indices.includes(11), `${multi.indices}`);

section('断点规划：首次请求（无历史）');
const firstPlan = planBreakpoints({ units: mkUnits(12), stableCount: 0, matchedLength: 0, maxSnapshotLength: 0, maxBreakpoints: 4 });
check('仍能规划出断点', firstPlan.indices.length > 0, `${firstPlan.indices}`);
check('首次视为单调追加', firstPlan.appendOnly === true);

section('断点规划：边界情况');
check('空单元不崩', planBreakpoints({ units: [], stableCount: 0, matchedLength: 0, maxSnapshotLength: 0, maxBreakpoints: 4 }).indices.length === 0);
check('断点上限为 0', planBreakpoints({ units: mkUnits(5), stableCount: 0, matchedLength: 0, maxSnapshotLength: 0, maxBreakpoints: 0 }).indices.length === 0);
check('单单元数组', planBreakpoints({ units: mkUnits(1), stableCount: 0, matchedLength: 0, maxSnapshotLength: 0, maxBreakpoints: 4 }).indices.length === 1);
check('stableCount 超出长度不崩', planBreakpoints({ units: mkUnits(3), stableCount: 99, matchedLength: 0, maxSnapshotLength: 0, maxBreakpoints: 4 }).indices.length <= 4);

// ---------------------------------------------------------------- snapshots

section('跨请求稳定前缀识别');
clearSnapshots();
const sys = (n, extra = '') => ({ role: 'system', content: `S${n}${extra}` });

const req1 = { messages: [sys(1), sys(2), sys(3)] };
recordSnapshot('k1', unitTexts(collectUnits(req1)));

const req2 = { messages: [sys(1), sys(2), sys(3, '-rand42')] };
const r2 = bestStablePrefix(unitTexts(collectUnits(req2)), getSnapshots('k1'));
check('动态块之前的稳定前缀 = 2', r2.stableCount === 2, `得到 ${r2.stableCount}`);
check('整个旧快照未被完整保留', r2.matchedLength === 0, `得到 ${r2.matchedLength}`);

section('追加式对话：整个旧快照都是前缀');
clearSnapshots();
const conv1 = { messages: [sys(1), sys(2), { role: 'user', content: 'hi' }] };
recordSnapshot('k2', unitTexts(collectUnits(conv1)));
const conv2 = { messages: [sys(1), sys(2), { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'more' }] };
const r3 = bestStablePrefix(unitTexts(collectUnits(conv2)), getSnapshots('k2'));
check('完整旧快照被识别', r3.matchedLength === 3, `得到 ${r3.matchedLength}`);
check('LCP 覆盖整个旧请求', r3.stableCount === 3, `得到 ${r3.stableCount}`);
check('maxSnapshotLength 正确', r3.maxSnapshotLength === 3);

// ---------------------------------------------------------------- relocate

section('动态 system 块重排（Anthropic 格式）');
const body2 = { system: [{ type: 'text', text: 'STATIC-A' }, { type: 'text', text: 'DYN' }, { type: 'text', text: 'STATIC-B' }] };
const moved = relocateVolatileSystemBlocks(body2, new Set([normalizeText({ type: 'text', text: 'DYN' })]));
check('移动了 1 块', moved === 1, `得到 ${moved}`);
check('稳定块保持相对顺序在前', body2.system[0].text === 'STATIC-A' && body2.system[1].text === 'STATIC-B');
check('动态块被推到末尾', body2.system[2].text === 'DYN');

section('动态 system 消息重排（OAI 格式）');
const body3 = {
    messages: [
        { role: 'system', content: 'STATIC-A' },
        { role: 'system', content: 'DYN' },
        { role: 'system', content: 'STATIC-B' },
        { role: 'user', content: 'hello' },
    ],
};
const moved2 = relocateVolatileMessageSystems(body3, new Set([normalizeText({ role: 'system', content: 'DYN' })]));
check('移动了 1 条', moved2 === 1, `得到 ${moved2}`);
check('稳定 system 在前', body3.messages[0].content === 'STATIC-A' && body3.messages[1].content === 'STATIC-B');
check('动态 system 被推到末尾', body3.messages[2].content === 'DYN');
check('\u2605 对话历史没有被跨段移动', body3.messages[3].content === 'hello');
check('顺序未变时不动（幂等）', relocateVolatileMessageSystems(body3, new Set([normalizeText({ role: 'system', content: 'DYN' })])) === 0);

// ---------------------------------------------------------------- stats

section('命中率解析');
const parsed = parseUsage({ input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 700, output_tokens: 50 });
check('总输入 = 100 + 200 + 700', parsed.total === 1000, `${parsed.total}`);
check('命中率 = 700 / 1000', Math.abs(parsed.rate - 0.7) < 1e-9, `${parsed.rate}`);
check('空 usage 返回 null', parseUsage(null) === null);
check('零总量返回 null', parseUsage({ input_tokens: 0 }) === null);

section('SSE 流式 usage 抓取');
const acc = { read: 0, creation: 0, input: 0, output: 0, total: undefined };
scanSseUsage('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":990,"cache_creation_input_tokens":0}}}\n\n', acc);
scanSseUsage('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":123}}\n\n', acc);
check('抓到输入侧', acc.read === 990, `${acc.read}`);
check('抓到输出侧', acc.output === 123, `${acc.output}`);
check('忽略坏 JSON 不崩', (() => { scanSseUsage('data: {broken', acc); return true; })());

section('统计汇总');
clearStats();
recordUsage({ read: 900, creation: 0, input: 100, output: 50 });
recordUsage({ read: 0, creation: 800, input: 200, output: 60 });
const sum = summarize(50);
check('请求数 = 2', sum.requests === 2, `${sum.requests}`);
check('命中率 = 900 / 2000', Math.abs(sum.hitRate - 0.45) < 1e-9, `${sum.hitRate}`);
check('最近一条可读', sum.last !== null);

section('hoist：把易变块搬到本轮最后一条 user 消息');
const hoistBody = {
    system: [
        { type: 'text', text: 'STATIC-A' },
        { type: 'text', text: 'DYN' },
        { type: 'text', text: 'STATIC-B' },
    ],
    messages: [
        { role: 'user', content: 'older question' },
        { role: 'assistant', content: 'older answer' },
        { role: 'user', content: 'latest question' },
    ],
};
const hoisted = hoistVolatileToLastMessage(hoistBody, new Set([normalizeText({ type: 'text', text: 'DYN' })]));
check('搬走了 1 个块', hoisted === 1, `得到 ${hoisted}`);
check('\u2605 易变块已从 system 段移除', !hoistBody.system.some(b => b.text === 'DYN'));
check('静态块仍在 system 里', hoistBody.system.length === 2 && hoistBody.system[0].text === 'STATIC-A');
check('\u2605 易变内容被追加到最后一条 user 消息', String(hoistBody.messages[2].content).includes('DYN'), JSON.stringify(hoistBody.messages[2].content));
check('末尾消息仍然是最后一条', hoistBody.messages.length === 3);
check('没有把内容塞进 assistant 消息', !String(hoistBody.messages[1].content).includes('DYN'));

section('hoist：OAI 格式（system 在 messages 里）');
const hoistOai = {
    messages: [
        { role: 'system', content: 'STATIC-A' },
        { role: 'system', content: 'DYN' },
        { role: 'user', content: 'hello' },
    ],
};
const hoisted2 = hoistVolatileToLastMessage(hoistOai, new Set([normalizeText({ role: 'system', content: 'DYN' })]));
check('搬走了 1 条', hoisted2 === 1, `得到 ${hoisted2}`);
check('开头 system 段只剩静态', hoistOai.messages[0].role === 'system' && hoistOai.messages[0].content === 'STATIC-A');
check('易变内容进了最后的 user 消息', String(hoistOai.messages.at(-1).content).includes('DYN'));

section('hoist：无易变块时不动');
const untouched = { system: [{ type: 'text', text: 'A' }], messages: [{ role: 'user', content: 'q' }] };
const snapshotBefore = JSON.stringify(untouched);
check('返回 0', hoistVolatileToLastMessage(untouched, new Set(['nope'])) === 0);
check('请求体未被改动', JSON.stringify(untouched) === snapshotBefore);

section('hoist：数组形式的 content');
const hoistArr = {
    system: [{ type: 'text', text: 'DYN' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'question' }] }],
};
check('搬走成功', hoistVolatileToLastMessage(hoistArr, new Set([normalizeText({ type: 'text', text: 'DYN' })])) === 1);
check('追加为新的内容块', hoistArr.messages[0].content.length === 2 && hoistArr.messages[0].content[1].text === 'DYN');

section('易变块检测：必须按内容，不能按下标');
// 场景：世界书块(第2个 system)每轮变 → 只该判定它易变，
// 不能因为下标前移把后面的角色卡、示例对话也误判
const sysUnits = (wiText) => collectUnits({
    system: [
        { type: 'text', text: 'MAIN' },
        { type: 'text', text: wiText },
        { type: 'text', text: 'CARD' },
        { type: 'text', text: 'EXAMPLES' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
});
const prev = sysUnits('WORLD-A');
const prevContents = unitContents(prev);
const curr = sysUnits('WORLD-B');
const volatile = findVolatileSystemUnits(curr, prevContents);
const volatileTexts = volatile.map(i => curr[i].searchText);
check('\u2605 世界书块被识别为易变', volatileTexts.includes('WORLD-B'), JSON.stringify(volatileTexts));
check('\u2605 角色卡没被误判', !volatileTexts.includes('CARD'), JSON.stringify(volatileTexts));
check('\u2605 示例对话没被误判', !volatileTexts.includes('EXAMPLES'), JSON.stringify(volatileTexts));
check('\u2605 主提示词没被误判', !volatileTexts.includes('MAIN'), JSON.stringify(volatileTexts));

section('易变块检测：内容稳定后必须停止 hoist');
const stablePrev = sysUnits('WORLD-A');
const stableCurr = sysUnits('WORLD-A');
check('内容相同时不判定易变', findVolatileSystemUnits(stableCurr, unitContents(stablePrev)).length === 0);

section('易变块检测：被 hoist 过的内容要能认出来');
// 上一轮 WORLD-A 被搬进了 user 消息 → 本轮 WORLD-A 稳定，不该再被搬
const hoistedBody = {
    system: [{ type: 'text', text: 'MAIN' }, { type: 'text', text: 'CARD' }],
    messages: [{ role: 'user', content: 'hi\n\nWORLD-A' }],
};
const hoistedUnits = collectUnits(hoistedBody);
const backToSystem = collectUnits({
    system: [
        { type: 'text', text: 'MAIN' },
        { type: 'text', text: 'WORLD-A' },
        { type: 'text', text: 'CARD' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
});
const stillVolatile = findVolatileSystemUnits(backToSystem, unitContents(hoistedUnits));
check('\u2605 世界里已出现过的内容不再判为易变（否则会一直白搬）',
    stillVolatile.map(i => backToSystem[i].searchText).includes('WORLD-A') === false,
    JSON.stringify(stillVolatile.map(i => backToSystem[i].searchText)));

console.log(`\n${'='.repeat(46)}`);
console.log(`结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
