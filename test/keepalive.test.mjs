/**
 * 缓存保活测试：需要 SillyTavern 正在运行。
 *
 * 验证的是「保活请求确实按周期发出去了」，而不是「代码看起来对」。
 * 为了不真等 5 分钟，测试里把 minIntervalMs 调到 1 秒。
 *
 * 跑法：
 *   node server.js --port 8124 &
 *   node plugins/st-cache-optimizer/test/keepalive.test.mjs http://127.0.0.1:8124
 */

import http from 'node:http';

const ST_URL = process.argv[2] ?? 'http://127.0.0.1:8124';

const received = [];
const mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* ignore */ }
        received.push({ body, at: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 2 },
        }));
    });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  \u2713 ${name}`); }
    else { fail++; console.log(`  \u2717 ${name} ${extra}`); }
};

const tokenRes = await fetch(`${ST_URL}/csrf-token`);
const cookies = (tokenRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
const { token } = await tokenRes.json();
const headers = {
    'Content-Type': 'application/json',
    'x-csrf-token': token,
    'Cookie': cookies,
};

async function setConfig(patch) {
    const res = await fetch(`${ST_URL}/api/plugins/st-cache-optimizer/config`, {
        method: 'POST', headers, body: JSON.stringify(patch),
    });
    return res.json();
}

async function getStats() {
    const res = await fetch(`${ST_URL}/api/plugins/st-cache-optimizer/stats`, { headers });
    return res.json();
}

/** 触发一次真实生成 */
async function generate() {
    const body = {
        chat_completion_source: 'claude',
        model: 'claude-sonnet-5',
        max_tokens: 64,
        temperature: 1,
        stream: false,
        use_sysprompt: true,
        reverse_proxy: mockUrl,
        proxy_password: 'test-key',
        messages: [
            { role: 'system', content: 'Static system prompt for keepalive test.' },
            { role: 'user', content: 'hello there' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'ping me' },
        ],
    };
    await fetch(`${ST_URL}/api/backends/chat-completions/generate`, {
        method: 'POST', headers, body: JSON.stringify(body),
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log(`ST:   ${ST_URL}`);
console.log(`mock: ${mockUrl}\n`);

console.log('=== 1. 保活关闭时不发任何额外请求 ===');
await setConfig({ enabled: true, relocateVolatile: false, keepalive: { enabled: false, factor: 0.75, maxCycles: 2, intervalMs: 1000 } });
const before1 = received.length;
await generate();
await sleep(2500);
check('只收到那 1 次真实请求', received.length - before1 === 1, `多出 ${received.length - before1 - 1}`);

console.log('\n=== 2. 打开保活后，按周期自动发轻量续期请求 ===');
await setConfig({ keepalive: { enabled: true, factor: 0.75, maxCycles: 2, intervalMs: 1000 } });
const before2 = received.length;
await generate();          // 真实请求
await sleep(3000);         // 等两轮保活

const extra = received.slice(before2 + 1);
check('\u2605 发出了保活请求', extra.length > 0, `收到 ${extra.length} 次`);
check('保活请求被限制在 maxCycles 内', extra.length <= 2, `收到 ${extra.length} 次`);

const ka = extra[0]?.body;
check('\u2605 保活用 max_tokens = 1', ka?.max_tokens === 1, `得到 ${ka?.max_tokens}`);
check('保活不是流式', ka?.stream === false, `得到 ${ka?.stream}`);
check('\u2605 保活仍带 cache_control（这样才读得到缓存）',
    JSON.stringify(ka ?? {}).includes('cache_control'), JSON.stringify(ka ?? null).slice(0, 120));
check('保活摘掉了 tools', ka?.tools === undefined);

console.log('\n=== 3. 统计里能看到保活次数 ===');
const stats = await getStats();
check('stats 有 keepalive 字段', stats.keepalive !== undefined);
check('\u2605 记录了已发送的保活', stats.keepalive.sent > 0, JSON.stringify(stats.keepalive));
console.log(`    保活: sent=${stats.keepalive.sent} ok=${stats.keepalive.ok} failed=${stats.keepalive.failed} pending=${stats.keepalive.pending}`);

console.log('\n=== 4. 新请求会取消上一轮排的保活 ===');
await setConfig({ keepalive: { enabled: true, factor: 0.75, maxCycles: 5, intervalMs: 2000 } });
await generate();
const pendingBefore = (await getStats()).keepalive.pending;
await generate();  // 立刻再来一次，应该重排而不是叠加
const pendingAfter = (await getStats()).keepalive.pending;
check('待发保活没有随请求累积', pendingAfter <= 1, `before=${pendingBefore} after=${pendingAfter}`);

console.log('\n=== 5. 关闭后不再安排 ===');
await setConfig({ keepalive: { enabled: false, factor: 0.75, maxCycles: 2, intervalMs: 1000 } });
await generate();
const before5 = received.length;
await sleep(2500);
check('关闭后没有新的保活请求', received.length === before5, `多出 ${received.length - before5}`);

console.log('\n=== 6. 恢复默认 ===');
const restored = await setConfig({ enabled: true, relocateVolatile: false, keepalive: { enabled: false, factor: 0.75, maxCycles: 2, intervalMs: 0 } });
check('keepalive.enabled 恢复为 false', restored.config.keepalive.enabled === false);

console.log(`\n${'='.repeat(46)}`);
console.log(`结果: ${pass} 通过, ${fail} 失败`);

mock.close();
process.exit(fail > 0 ? 1 : 0);
