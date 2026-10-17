/**
 * UI 开关行为测试：需要 SillyTavern 正在运行。
 *
 * 验证「UI 上点开关」确实控制住了服务端行为 —— 不是改了个没人读的变量。
 *   · enabled=false  → 出站请求里不再出现 cache_control
 *   · enabled=true   → 恢复注入
 *   · relocateVolatile=hoist → 易变块被搬到末尾
 *
 * 跑法：
 *   node server.js --port 8124 &
 *   node plugins/st-cache-optimizer/test/toggle.test.mjs http://127.0.0.1:8124
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
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000, output_tokens: 10 },
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

// CSRF
const tokenRes = await fetch(`${ST_URL}/csrf-token`);
const setCookie = tokenRes.headers.getSetCookie?.() ?? [];
const { token } = await tokenRes.json();
const headers = {
    'Content-Type': 'application/json',
    'x-csrf-token': token,
    'Cookie': setCookie.map(c => c.split(';')[0]).join('; '),
};

async function setConfig(patch) {
    const res = await fetch(`${ST_URL}/api/plugins/st-cache-optimizer/config`, {
        method: 'POST', headers, body: JSON.stringify(patch),
    });
    if (!res.ok) {
        throw new Error(`setConfig failed: ${res.status}`);
    }
    return res.json();
}

/** 触发一次生成；返回 mock 收到的请求体 */
async function generate({ dynamicSystem = false } = {}) {
    const before = received.length;
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
            { role: 'system', content: 'Static system prompt.' },
            { role: 'system', content: dynamicSystem ? `World info r=${Math.random()}` : 'World info static.' },
            { role: 'user', content: 'turn one' },
            { role: 'assistant', content: 'reply one' },
            { role: 'user', content: 'latest question' },
        ],
    };
    const res = await fetch(`${ST_URL}/api/backends/chat-completions/generate`, {
        method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`generate failed: ${res.status}`);
    }
    return received.length > before ? received.at(-1) : null;
}

function hasCacheControl(body) {
    return JSON.stringify(body ?? {}).includes('cache_control');
}

console.log(`ST:   ${ST_URL}`);
console.log(`mock: ${mockUrl}\n`);

console.log('=== 1. 关掉开关后，不应再注入断点 ===');
await setConfig({ enabled: false, relocateVolatile: false });
const offBody = await generate();
check('请求到达 mock', offBody !== null);
check('\u2605 enabled=false → 请求里没有 cache_control', !hasCacheControl(offBody), JSON.stringify(offBody).slice(0, 100));
// 注意：use_sysprompt 会把开头的 system 消息收进 body.system，messages 只剩 3 条
check('请求内容本身完好', offBody?.messages?.length === 3, `得到 ${offBody?.messages?.length}`);

console.log('\n=== 2. 打开开关后，恢复注入 ===');
await setConfig({ enabled: true });
const onBody = await generate();
check('\u2605 enabled=true → 重新注入 cache_control', hasCacheControl(onBody));
check('断点数 <= 4', (JSON.stringify(onBody).match(/"cache_control"/g) ?? []).length <= 4);

console.log('\n=== 3. 切到 hoist：易变块被搬到末尾 ===');
await setConfig({ relocateVolatile: false });
await generate({ dynamicSystem: true });
await setConfig({ relocateVolatile: 'hoist' });
// hoist 靠与上一轮快照比对来找易变块，先垫一轮建立基线
await generate({ dynamicSystem: true });
const hoistBody = await generate({ dynamicSystem: true });

const systemTexts = (hoistBody?.system ?? []).map(b => String(b.text));
const lastUser = hoistBody?.messages?.at(-1);
const lastUserText = Array.isArray(lastUser?.content)
    ? lastUser.content.map(p => p.text ?? '').join('')
    : String(lastUser?.content ?? '');

check('\u2605 动态块已不在 system 段', !systemTexts.some(t => t.includes('World info r=')), JSON.stringify(systemTexts.map(t => t.slice(0, 20))));
check('\u2605 动态内容出现在最后一条 user 消息里', lastUserText.includes('World info r='), lastUserText.slice(0, 80));
check('静态 system 块仍保留', systemTexts.some(t => t.includes('Static system prompt')));

console.log('\n=== 4. 关掉开关时 hoist 也不该动手 ===');
await setConfig({ enabled: false });
const offHoist = await generate({ dynamicSystem: true });
const offSystem = (offHoist?.system ?? []).map(b => String(b.text));
check('关掉后动态块留在 system 里（内容未被搬动）', offSystem.some(t => t.includes('World info r=')), JSON.stringify(offSystem.map(t => t.slice(0, 20))));
check('关掉后没有 cache_control', !hasCacheControl(offHoist));

console.log('\n=== 5. 恢复默认配置 ===');
const restored = await setConfig({ enabled: true, relocateVolatile: false });
check('enabled 恢复为 true', restored.config.enabled === true);
check('relocateVolatile 恢复为 false', restored.config.relocateVolatile === false);

console.log(`\n${'='.repeat(46)}`);
console.log(`结果: ${pass} 通过, ${fail} 失败`);

mock.close();
process.exit(fail > 0 ? 1 : 0);
