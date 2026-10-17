/**
 * usage 解析与命中率计算测试。
 * 各家字段语义不同，算错就会得出「100%」这种假象。
 */
import { createClientOptimizer } from '../ui/client-optimizer.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + e)); };

const cfg = { enabled: true, maxBreakpoints: 4, ttl: '5m', requestUsage: true };
const opt = createClientOptimizer({ getConfig: () => cfg });

/** 造一个假的 Response */
function fakeResponse(body, contentType) {
    return {
        clone() {
            return {
                headers: { get: () => contentType },
                json: async () => body,
                body: null,
            };
        },
    };
}

function fakeStreamResponse(chunks) {
    let i = 0;
    const encoder = new TextEncoder();
    return {
        clone() {
            return {
                headers: { get: () => 'text/event-stream' },
                json: async () => { throw new Error('not json'); },
                body: {
                    getReader() {
                        return {
                            async read() {
                                if (i >= chunks.length) return { done: true, value: undefined };
                                return { done: false, value: encoder.encode(chunks[i++]) };
                            },
                            async cancel() { },
                        };
                    },
                },
            };
        },
    };
}

console.log('=== 1. Anthropic 原生：input_tokens 不含缓存 ===');
opt.reset();
opt.trackResponse(fakeResponse({
    usage: { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 50 },
}, 'application/json'));
await new Promise(r => setTimeout(r, 20));
check('命中率 = 9000/10000 = 90%', Math.abs(opt.hitRate() - 0.9) < 1e-9, `${opt.hitRate()}`);
check('命中 tokens', opt.stats().tokens.read === 9000, `${opt.stats().tokens.read}`);
check('未命中 tokens = 1000（不是减出来的 0）', opt.stats().tokens.input === 1000, `${opt.stats().tokens.input}`);

console.log('\n=== 2. OpenAI 兼容：prompt_tokens 含缓存，要减 ===');
opt.reset();
opt.trackResponse(fakeResponse({
    usage: { prompt_tokens: 10000, prompt_tokens_details: { cached_tokens: 9000 }, completion_tokens: 50 },
}, 'application/json'));
await new Promise(r => setTimeout(r, 20));
check('命中率 = 9000/10000 = 90%', Math.abs(opt.hitRate() - 0.9) < 1e-9, `${opt.hitRate()}`);
check('未命中 = 1000', opt.stats().tokens.input === 1000, `${opt.stats().tokens.input}`);

console.log('\n=== 3. DeepSeek：hit/miss 分开给 ===');
opt.reset();
opt.trackResponse(fakeResponse({
    usage: { prompt_cache_hit_tokens: 8000, prompt_cache_miss_tokens: 2000, completion_tokens: 50 },
}, 'application/json'));
await new Promise(r => setTimeout(r, 20));
check('命中率 = 8000/10000 = 80%', Math.abs(opt.hitRate() - 0.8) < 1e-9, `${opt.hitRate()}`);

console.log('\n=== 4. 流式：usage 在尾包 ===');
opt.reset();
const stream = fakeStreamResponse([
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":12000,"prompt_tokens_details":{"cached_tokens":11000},"completion_tokens":30}}\n\n',
    'data: [DONE]\n\n',
]);
opt.trackResponse(stream);
await new Promise(r => setTimeout(r, 60));
check('从流里抓到 usage', opt.stats().usageReports > 0, `${opt.stats().usageReports}`);
check('命中率 ≈ 91.7%', Math.abs(opt.hitRate() - 11000 / 12000) < 1e-9, `${opt.hitRate()}`);

console.log('\n=== 5. 流式：Anthropic message_start ===');
opt.reset();
const anth = fakeStreamResponse([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":500,"cache_read_input_tokens":4500,"cache_creation_input_tokens":0}}}\n\n',
    'data: {"type":"message_delta","usage":{"output_tokens":100}}\n\n',
]);
opt.trackResponse(anth);
await new Promise(r => setTimeout(r, 60));
check('命中率 = 4500/5000 = 90%', Math.abs(opt.hitRate() - 0.9) < 1e-9, `${opt.hitRate()}`);

console.log('\n=== 6. 没有 usage 时返回 null（而不是 0%）===');
opt.reset();
opt.trackResponse(fakeResponse({ choices: [{ message: { content: 'x' } }] }, 'application/json'));
await new Promise(r => setTimeout(r, 20));
check('hitRate 为 null', opt.hitRate() === null, `${opt.hitRate()}`);
check('usageReports 为 0', opt.stats().usageReports === 0);

console.log('\n=== 7. 注入 stream_options ===');
opt.reset();
const req = {
    chat_completion_source: 'openrouter',
    model: 'anthropic/claude-sonnet-4',
    stream: true,
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }],
};
opt.optimize(req);
check('流式请求注入了 include_usage', req.stream_options?.include_usage === true, JSON.stringify(req.stream_options));

console.log('\n=== 8. 非流式不注入 ===');
const req2 = {
    chat_completion_source: 'openrouter',
    model: 'm',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
};
opt.optimize(req2);
check('非流式不加 stream_options', req2.stream_options === undefined);

console.log('\n=== 9. 真实 Response 对象：clone + 流式消费 ===');
opt.reset();
const sseBody = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n'
    + 'data: {"choices":[],"usage":{"prompt_tokens":5000,"prompt_tokens_details":{"cached_tokens":4500}}}\n\n'
    + 'data: [DONE]\n\n';
const realStream = new Response(sseBody, { headers: { 'content-type': 'text/event-stream' } });
const returned = opt.trackResponse(realStream);
check('原样返回同一个 Response', returned === realStream);
// 模拟 ST 消费原始流
const originalText = await realStream.text();
check('原始流仍可被正常消费', originalText.includes('[DONE]'), originalText.slice(0, 40));
await new Promise(r => setTimeout(r, 80));
check('\u2605 从真实流里抓到 usage', opt.stats().usageReports > 0, `${opt.stats().usageReports}`);
check('命中率 = 4500/5000 = 90%', Math.abs(opt.hitRate() - 0.9) < 1e-9, `${opt.hitRate()}`);

console.log('\n=== 10. 真实 Response：非流式 JSON ===');
opt.reset();
const realJson = new Response(JSON.stringify({
    usage: { input_tokens: 200, cache_read_input_tokens: 1800, output_tokens: 10 },
}), { headers: { 'content-type': 'application/json' } });
opt.trackResponse(realJson);
const jsonText = await realJson.text();
check('原始响应仍可读', jsonText.includes('cache_read_input_tokens'));
await new Promise(r => setTimeout(r, 40));
check('命中率 = 1800/2000 = 90%', Math.abs(opt.hitRate() - 0.9) < 1e-9, `${opt.hitRate()}`);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
