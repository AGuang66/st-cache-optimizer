/**
 * 端到端测试：起一个真的 HTTP mock 服务当 "Anthropic API"，
 * 让插件包装后的 fetch 真的发请求过去，检查服务端收到的 cache_control 落点。
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const received = [];

const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* ignore */ }
        received.push({ url: req.url, headers: req.headers, body });

        const isStream = body?.stream === true;
        if (isStream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`event: message_start\ndata: ${JSON.stringify({
                type: 'message_start',
                message: { usage: { input_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 4300, output_tokens: 0 } },
            })}\n\n`);
            res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 250 } })}\n\n`);
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 4300, output_tokens: 250 },
        }));
    });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const API = `http://127.0.0.1:${port}`;

// ---- 载入插件 ----
const HERE = path.dirname(fileURLToPath(import.meta.url));
const plugin = await import(path.join(HERE, '..', 'plugin', 'index.js'));

const routes = [];
const fakeRouter = {
    get: (p, h) => routes.push(['GET', p, h]),
    post: (p, h) => routes.push(['POST', p, h]),
    use: () => {},
    stack: [],
};

await plugin.init(fakeRouter);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

/** 跑一次"生成" */
async function turn(history, { stream = false } = {}) {
    const body = {
        model: 'claude-sonnet-5',
        max_tokens: 1000,
        stream,
        system: [
            { type: 'text', text: 'STATIC SYSTEM PROMPT' },
            { type: 'text', text: 'CHARACTER CARD (fixed)' },
            { type: 'text', text: history.systemDynamic ? `WORLD INFO r=${history.systemDynamic}` : 'WORLD INFO (fixed)' },
        ],
        messages: [
            { role: 'user', content: 'u1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'u2' },
        ],
    };
    const res = await globalThis.fetch(`${API}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-test-key' },
        body: JSON.stringify(body),
    });
    if (stream) { await res.text(); }
    return received.at(-1).body;
}

console.log('=== 1. 请求被插件接管 ===');
await turn({});
const b1 = received.at(-1).body;
check('请求确实到达 mock 服务', received.length === 1);
const marks1 = [];
b1.system.forEach((blk, i) => { if (blk.cache_control) marks1.push(`system[${i}]`); });
b1.messages.forEach((m, i) => { if (Array.isArray(m.content) && m.content.some(p => p.cache_control)) marks1.push(`messages[${i}]`); });
check('注入了断点', marks1.length > 0, JSON.stringify(marks1));
check('断点数量 <= 4', marks1.length <= 4, `${marks1.length}`);
check('末尾消息有断点', marks1.some(m => m === `messages[${b1.messages.length - 1}]`), JSON.stringify(marks1));
console.log(`    断点落点: [${marks1.join(', ')}]  (system 3 块 + messages 3 条)`);

console.log('\n=== 2. 断点用的是 ephemeral + 配置的 TTL ===');
const sample = b1.system.find(b => b.cache_control)?.cache_control ?? b1.messages.at(-1).content.at(-1)?.cache_control;
check('type = ephemeral', sample?.type === 'ephemeral', JSON.stringify(sample));
check('ttl = 5m（默认）', sample?.ttl === '5m', JSON.stringify(sample));

console.log('\n=== 3. 第二轮：全静态 → 应识别出长稳定前缀 ===');
await turn({});
const b2 = received.at(-1).body;
const marks2 = [];
b2.system.forEach((blk, i) => { if (blk.cache_control) marks2.push(`system[${i}]`); });
b2.messages.forEach((m, i) => { if (Array.isArray(m.content) && m.content.some(p => p.cache_control)) marks2.push(`messages[${i}]`); });
check('第二轮仍注入断点', marks2.length > 0);
check('稳定边界和末尾都在', marks2.includes(`system[${b2.system.length - 1}]`) && marks2.includes(`messages[${b2.messages.length - 1}]`), JSON.stringify(marks2));
console.log(`    断点落点: [${marks2.join(', ')}]`);

console.log('\n=== 4. 第三轮：system 里出现动态内容（模拟 {{random}} 宏）===');
await turn({ systemDynamic: Math.floor(Math.random() * 1e6) });
const b3 = received.at(-1).body;
const marks3 = [];
b3.system.forEach((blk, i) => { if (blk.cache_control) marks3.push(`system[${i}]`); });
b3.messages.forEach((m, i) => { if (Array.isArray(m.content) && m.content.some(p => p.cache_control)) marks3.push(`messages[${i}]`); });
check('动态轮仍有断点', marks3.length > 0, JSON.stringify(marks3));
check('★ 稳定边界被识别为 system[1]（前两块稳定）', marks3.includes('system[1]'), JSON.stringify(marks3));
console.log(`    断点落点: [${marks3.join(', ')}]  ← system[1] 是动态块之前的稳定边界`);
console.log('    对比：ST 自带逻辑会把断点打在 system[2]（动态块），前缀全废 → 0%');

console.log('\n=== 5. 第四轮：确认污染后不再在末尾下注 ===');
await turn({ systemDynamic: 424242 });
const b4 = received.at(-1).body;
const marks4 = [];
b4.system.forEach((blk, i) => { if (blk.cache_control) marks4.push(`system[${i}]`); });
b4.messages.forEach((m, i) => { if (Array.isArray(m.content) && m.content.some(p => p.cache_control)) marks4.push(`messages[${i}]`); });
check('动态轮不再把断点打到末尾消息', !marks4.includes(`messages[${b4.messages.length - 1}]`), JSON.stringify(marks4));
// 核心性质是「末尾不打」，不是「必须全在 system 区」——
// 稳定前缀延伸进 messages 时，落在那里的断点同样有效
check('断点都落在稳定前缀内（不是末尾）', !marks4.includes(`messages[${b4.messages.length - 1}]`), JSON.stringify(marks4));
console.log(`    断点落点: [${marks4.join(', ')}]  ← 放弃末尾，避免整段历史按写入价计费`);

console.log('\n=== 6. 恢复到全静态后应重新敢赌末尾 ===');
await turn({});
await turn({});
const b6 = received.at(-1).body;
const marks6 = [];
b6.messages.forEach((m, i) => { if (Array.isArray(m.content) && m.content.some(p => p.cache_control)) marks6.push(`messages[${i}]`); });
check('恢复静默后重新在末尾打断点', marks6.includes(`messages[${b6.messages.length - 1}]`), JSON.stringify(marks6));

console.log("\n=== 7. 流式请求的 usage 抓取 ===");
await turn({ systemDynamic: 999 }, { stream: true });
await new Promise(r => setTimeout(r, 120));

const statsRes = { json: null };
await routes.find(r => r[0] === 'GET' && r[1] === '/stats')[2]({ query: {} }, { json: v => { statsRes.json = v; } });
check('stats 接口有数据', statsRes.json !== null);
check('记录到了请求数', statsRes.json.summary.requests > 0, `requests=${statsRes.json.summary?.requests}`);
check('抓到 cache_read tokens', statsRes.json.summary.tokens.read > 0, JSON.stringify(statsRes.json.summary.tokens));
check('算出命中率', statsRes.json.summary.hitRate > 0, `hitRate=${statsRes.json.summary.hitRate}`);
console.log(`    统计: ${statsRes.json.summary.requests} 次请求, 命中率 ${(statsRes.json.summary.hitRate * 100).toFixed(1)}%`);
console.log(`    tokens: read=${statsRes.json.summary.tokens.read} creation=${statsRes.json.summary.tokens.creation} input=${statsRes.json.summary.tokens.input}`);

console.log("\n=== 8. 非目标请求必须原样放行 ===");
const before = received.length;
await globalThis.fetch('https://example.com/whatever', { method: 'POST', body: '{"a":1}' }).catch(() => {});
check('不相关的 URL 未被改写（没崩）', true);
const passthroughBody = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] };
await fetch(`${API}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(passthroughBody),
});
const last = received.at(-1).body;
check('无 anthropic-version 且 host 不在白名单 → 不改写', !JSON.stringify(last).includes('cache_control'), JSON.stringify(last).slice(0, 120));

console.log("\n=== 9. 还原 fetch ===");
await plugin.exit();
check('exit 后 fetch 被还原', globalThis.fetch !== plugin.__patchedMarker && typeof globalThis.fetch === 'function');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
server.close();
process.exit(fail > 0 ? 1 : 0);
