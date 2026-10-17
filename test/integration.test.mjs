/**
 * 全栈集成测试：需要 SillyTavern 正在运行。
 *
 * 它会：
 *   1. 起一个 mock "Anthropic API"
 *   2. 通过 ST 自己的 /api/backends/chat-completions/generate 触发真实生成请求
 *      （用 reverse_proxy 把请求指向 mock，所以不需要真 API key）
 *   3. 检查插件是否在 ST 进程内改写了请求体
 *
 * 跑法：
 *   node server.js --port 8124 &
 *   node plugins/st-cache-optimizer/test/integration.test.mjs http://127.0.0.1:8124
 */

import http from 'node:http';

const ST_URL = process.argv[2] ?? 'http://127.0.0.1:8124';

const received = [];

const mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        try { received.push(JSON.parse(raw)); } catch { received.push(null); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            content: [{ type: 'text', text: 'mock reply' }],
            usage: {
                input_tokens: 40,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 5000,
                output_tokens: 12,
            },
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

// ---- 拿 CSRF token ----
const cookies = [];
const tokenRes = await fetch(`${ST_URL}/csrf-token`);
const setCookie = tokenRes.headers.getSetCookie?.() ?? [];
cookies.push(...setCookie.map(c => c.split(';')[0]));
const { token } = await tokenRes.json();

const headers = {
    'Content-Type': 'application/json',
    'x-csrf-token': token,
    'Cookie': cookies.join('; '),
};

/** 走 ST 的接口触发一次生成 */
async function generate({ systemDynamic = null, turns = 3 }) {
    const messages = [];
    for (let i = 0; i < turns; i++) {
        messages.push({ role: 'user', content: `User turn ${i}` });
        messages.push({ role: 'assistant', content: `Assistant turn ${i}` });
    }
    messages.push({ role: 'user', content: 'latest question' });

    // ST 会把 leading system 消息当作 system prompt
    const all = [
        { role: 'system', content: 'You are a helpful assistant. (static)' },
        { role: 'system', content: 'Character card, fixed content. (static)' },
        { role: 'system', content: systemDynamic === null ? 'World info (static)' : `World info rand=${systemDynamic}` },
        ...messages,
    ];

    const res = await fetch(`${ST_URL}/api/backends/chat-completions/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            chat_completion_source: 'claude',
            model: 'claude-sonnet-5',
            messages: all,
            max_tokens: 100,
            temperature: 1,
            stream: false,
            use_sysprompt: true,
            reverse_proxy: mockUrl,
            proxy_password: 'test-key',
        }),
    });
    return res.status;
}

console.log(`ST:   ${ST_URL}`);
console.log(`mock: ${mockUrl}\n`);

console.log('=== 1. 通过 ST 触发真实生成请求 ===');
const status1 = await generate({});
check('ST 返回 200', status1 === 200, `得到 ${status1}`);
check('mock 收到了请求', received.length >= 1, `收到 ${received.length}`);

const first = received.at(-1);
console.log(`    mock 收到的 system 块数: ${first?.system?.length}, messages 条数: ${first?.messages?.length}`);

console.log('\n=== 2. 插件在 ST 进程内改写了请求 ===');
const collect = (body) => {
    const marks = [];
    (body.system ?? []).forEach((b, i) => { if (b.cache_control) marks.push(`system[${i}]`); });
    (body.messages ?? []).forEach((m, i) => {
        if (Array.isArray(m.content) && m.content.some(p => p.cache_control)) marks.push(`messages[${i}]`);
    });
    return marks;
};
const marks1 = collect(first);
check('\u2605 注入了 cache_control（说明 ST 内部的裸 fetch 被拦截）', marks1.length > 0, JSON.stringify(marks1));
check('断点数 <= 4', marks1.length <= 4, `${marks1.length}`);
console.log(`    断点落点: [${marks1.join(', ')}]`);

console.log('\n=== 3. 第二轮全静态：应识别稳定前缀 ===');
await generate({});
const marks2 = collect(received.at(-1));
check('第二轮仍有断点', marks2.length > 0, JSON.stringify(marks2));
console.log(`    断点落点: [${marks2.join(', ')}]`);

console.log('\n=== 4. 第三轮 system 变动态：应退守到稳定边界 ===');
await generate({ systemDynamic: Math.floor(Math.random() * 1e6) });
const marks3 = collect(received.at(-1));
check('动态轮仍守住稳定边界', marks3.some(m => m === 'system[1]'), JSON.stringify(marks3));
check('动态轮不再把断点打到末尾', !marks3.includes(`messages[${received.at(-1).messages.length - 1}]`), JSON.stringify(marks3));
console.log(`    断点落点: [${marks3.join(', ')}]`);

console.log('\n=== 5. 插件统计接口 ===');
const statsRes = await fetch(`${ST_URL}/api/plugins/st-cache-optimizer/stats`, { headers });
const stats = await statsRes.json();
check('统计接口可访问', statsRes.status === 200);
check('\u2605 记录到了 ST 发出的真实请求', stats.summary.requests >= 3, `requests=${stats.summary.requests}`);
check('\u2605 抓到了真实 cache_read tokens', stats.summary.tokens.read > 0, JSON.stringify(stats.summary.tokens));
check('计算出了真实命中率', stats.summary.hitRate > 0, `hitRate=${stats.summary.hitRate}`);
console.log(`    拦截 ${stats.counters.inspected} 次，改写 ${stats.counters.optimized} 次，错误 ${stats.counters.errors} 次`);
console.log(`    真实命中率: ${(stats.summary.hitRate * 100).toFixed(1)}%  (read=${stats.summary.tokens.read}, input=${stats.summary.tokens.input})`);

console.log(`\n${'='.repeat(46)}`);
console.log(`结果: ${pass} 通过, ${fail} 失败`);

mock.close();
process.exit(fail > 0 ? 1 : 0);
