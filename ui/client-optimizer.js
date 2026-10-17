/**
 * client-optimizer.js —— 纯前端缓存优化核心。
 *
 * 为什么不依赖服务端插件：
 *   SillyTavern 的前端把整个请求体（含 messages）POST 给
 *   /api/backends/chat-completions/generate，服务端只是转发给上游。
 *   所以在浏览器里拦一层 fetch、改好 body 再发出去，效果和服务端插件等价。
 *
 * 适用边界（很重要）：
 *   - OpenRouter / NanoGPT / 自定义 OAI 兼容端点 → messages 原样透传，cache_control 能到上游 ✓
 *   - Claude 直连 → 服务端 convertClaudeMessages() 会重建 text 块，
 *                  cache_control 会被丢掉，只能靠服务端插件 ✗
 */

const DEFAULT_CONFIG = {
    enabled: true,
    maxBreakpoints: 4,
    ttl: '5m',
    /** 流式请求时是否要求上游回传 usage（否则流里没有缓存数据） */
    requestUsage: true,
};

/**
 * 兼容各家不同的 usage 形状。
 *   Anthropic 直连/透传 : cache_read_input_tokens / cache_creation_input_tokens
 *   OpenAI 兼容（含 OR）: prompt_tokens_details.cached_tokens
 *   DeepSeek            : prompt_cache_hit_tokens / prompt_cache_miss_tokens
 */
function parseUsage(usage) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }

    let read = 0;
    let creation = 0;
    let uncached = 0;

    // --- Anthropic 原生：input_tokens 本身**不含**缓存部分，直接取用 ---
    if (usage.cache_read_input_tokens !== undefined
        || usage.cache_creation_input_tokens !== undefined
        || usage.input_tokens !== undefined) {
        read = Number(usage.cache_read_input_tokens ?? 0) || 0;
        creation = Number(usage.cache_creation_input_tokens ?? 0) || 0;
        uncached = Number(usage.input_tokens ?? 0) || 0;
    } else if (usage.prompt_cache_hit_tokens !== undefined || usage.prompt_cache_miss_tokens !== undefined) {
        // --- DeepSeek：命中/未命中分开给 ---
        read = Number(usage.prompt_cache_hit_tokens ?? 0) || 0;
        uncached = Number(usage.prompt_cache_miss_tokens ?? 0) || 0;
        creation = 0;
    } else {
        // --- OpenAI 兼容：prompt_tokens **含**缓存部分，要减掉 ---
        read = Number(usage.prompt_tokens_details?.cached_tokens ?? 0) || 0;
        creation = 0;
        const prompt = Number(usage.prompt_tokens ?? 0) || 0;
        uncached = Math.max(0, prompt - read);
    }

    const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
    const total = read + creation + uncached;

    if (total <= 0 && output <= 0) {
        return null;
    }

    return {
        read,
        creation,
        input: uncached,
        output,
        total,
        rate: total > 0 ? read / total : 0,
    };
}


/** 从 URL 判断后端路径 */
function detectMode(body) {
    const source = String(body?.chat_completion_source ?? '');
    if (source === 'claude' && !body?.reverse_proxy) {
        return 'claude-direct';
    }
    if (source === 'openrouter' || source === 'nanogpt' || source === 'custom') {
        return 'passthrough';
    }
    return 'unsupported';
}

/**
 * 从 messages 里取出「可缓存单元」的签名，用于跨请求比对。
 *
 * 只取纯文本，不取结构：我们自己在断点里把 content 从字符串转成了数组，
 * 如果签名带上结构信息，同一个请求的两次签名就会不一样，
 * 于是历史比对永远不匹配 —— 断点会从 4 个塌成 1 个，缓存直接白费。
 */
function textOf(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map(part => part?.text ?? '').join('\n');
    }
    return '';
}

function signatureOf(body) {
    const units = [];
    const system = body?.system;
    if (typeof system === 'string') {
        units.push(`sys:${system}`);
    } else if (Array.isArray(system)) {
        for (const block of system) {
            units.push(`sys:${block?.text ?? ''}`);
        }
    }
    for (const message of body?.messages ?? []) {
        units.push(`${message?.role}:${textOf(message?.content)}`);
    }
    return units;
}

/** 最长公共前缀（按单元） */
function commonPrefix(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) {
        i++;
    }
    return i;
}

/** 给 message 的最后一块文本打断点 */
function markMessage(message, cacheControl) {
    const content = message?.content;
    if (typeof content === 'string') {
        if (!content) {
            return false;
        }
        message.content = [{ type: 'text', text: content, cache_control: cacheControl }];
        return true;
    }
    if (Array.isArray(content)) {
        for (let i = content.length - 1; i >= 0; i--) {
            const part = content[i];
            if (part && typeof part === 'object' && part.type !== 'image_url' && part.type !== 'image') {
                part.cache_control = cacheControl;
                return true;
            }
        }
    }
    return false;
}

/** 清掉已有断点 */
function stripCacheControl(body) {
    const walk = (node) => {
        if (!node || typeof node !== 'object') {
            return;
        }
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        delete node.cache_control;
        Object.values(node).forEach(walk);
    };
    walk(body.messages);
    walk(body.system);
    walk(body.tools);
}

/**
 * 规划断点。
 * 和 service 端同一套规则：
 *   - 稳定边界（跨请求公共前缀）必须打
 *   - 整段末尾在「单调追加」时才打
 *   - 其余分摊对冲
 */
function planBreakpoints({ total, stableCount, appendOnly, maxBreakpoints }) {
    const picked = new Set();
    if (total === 0) {
        return [];
    }

    if (stableCount > 0 && stableCount <= total) {
        picked.add(stableCount - 1);
    }
    if (appendOnly) {
        picked.add(total - 1);
    }

    const remaining = maxBreakpoints - picked.size;
    if (remaining > 0) {
        const from = stableCount > 0 ? stableCount - 1 : 0;
        const to = appendOnly ? total - 1 : Math.max(stableCount - 1, 0);
        const span = to - from;
        if (span > 1) {
            for (let i = 1; i <= remaining; i++) {
                const idx = from + Math.round((span * i) / (remaining + 1));
                if (idx > from && idx < to) {
                    picked.add(idx);
                }
            }
        }
    }

    if (picked.size === 0) {
        picked.add(0);
    }

    return [...picked].sort((a, b) => a - b).slice(0, maxBreakpoints);
}

/**
 * 创建前端优化器。
 * @param {object} options
 * @param {() => object} options.getConfig 读取当前配置
 */
export function createClientOptimizer({ getConfig }) {
    /** key -> 历史快照列表 */
    const snapshots = new Map();
    const stats = {
        inspected: 0,
        optimized: 0,
        skipped: 0,
        errors: 0,
        lastMode: null,
        lastReason: '',
        /** 响应里拿到 usage 的次数 */
        usageReports: 0,
        tokens: { read: 0, creation: 0, input: 0, output: 0 },
    };

    function snapshotKey(body) {
        return `model:${body?.model ?? ''}|src:${body?.chat_completion_source ?? ''}`;
    }

    /**
     * 处理一个出站请求体。
     * @param {object} body
     * @returns {boolean} 是否改动
     */
    function optimize(body) {
        const config = { ...DEFAULT_CONFIG, ...(getConfig() ?? {}) };
        if (!config.enabled) {
            return false;
        }

        stats.inspected++;
        const mode = detectMode(body);
        stats.lastMode = mode;

        if (mode === 'claude-direct') {
            // 服务端会重建 text 块，断点保不住 —— 交给服务端插件
            stats.skipped++;
            stats.lastReason = 'claude-direct';
            return false;
        }
        if (mode !== 'passthrough') {
            stats.skipped++;
            stats.lastReason = `unsupported-source:${body?.chat_completion_source ?? '?'}`;
            return false;
        }
        stats.lastReason = 'passthrough';

        try {
            // 流式请求默认不带 usage，缓存数据就无从得知。
            // OpenAI 兼容端点都支持 stream_options.include_usage。
            if (config.requestUsage && body.stream === true && body.stream_options?.include_usage !== true) {
                body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
            }

            stripCacheControl(body);

            const signature = signatureOf(body);
            const key = snapshotKey(body);
            const history = snapshots.get(key) ?? [];

            // 稳定边界 = 与历史任一快照的最长公共前缀。
            // 先跳过「内容完全相同」的快照：那是对同一请求的重复调用，
            // 拿它当历史会让 stableCount 等于全长，断点从多个塌成末尾一个。
            const currentKey = signature.join('\u0000');
            const comparable = history.filter(snap => snap.signature.join('\u0000') !== currentKey);
            const baseline = comparable.length > 0 ? comparable : history;

            let stableCount = 0;
            let latestLength = 0;
            let matchedLength = 0;
            for (const snap of baseline) {
                const common = commonPrefix(snap.signature, signature);
                stableCount = Math.max(stableCount, common);
                if (snap.signature.length > latestLength) {
                    latestLength = snap.signature.length;
                }
                if (common === snap.signature.length) {
                    matchedLength = Math.max(matchedLength, snap.signature.length);
                }
            }

            // 没有可比较的历史 → 首次请求，乐观布局
            const appendOnly = comparable.length === 0 || latestLength === 0 || stableCount >= latestLength;
            const indices = planBreakpoints({
                total: signature.length,
                stableCount,
                appendOnly,
                maxBreakpoints: Number(config.maxBreakpoints) || 4,
            });

            const cacheControl = { type: 'ephemeral', ttl: config.ttl };
            let marked = 0;

            for (const index of indices) {
                // system 段在前，messages 在后
                const systemCount = Array.isArray(body.system) ? body.system.length : (body.system ? 1 : 0);
                if (index < systemCount) {
                    const block = Array.isArray(body.system) ? body.system[index] : null;
                    if (block && typeof block === 'object') {
                        block.cache_control = cacheControl;
                        marked++;
                    }
                    continue;
                }
                const message = body.messages?.[index - systemCount];
                if (message && markMessage(message, cacheControl)) {
                    marked++;
                }
            }

            // 记快照（保留最近 6 条）。
            // 若内容与最近一条完全一致，说明是对同一请求重复调用，
            // 不再追加 —— 否则历史里塞满同一条，稳定边界会退化成「整段都稳定」，
            // 断点从多个塌成末尾一个。
            const last = history[0];
            if (!last || last.signature.join('\u0000') !== signature.join('\u0000')) {
                history.unshift({ signature, at: Date.now() });
                if (history.length > 6) {
                    history.length = 6;
                }
                snapshots.set(key, history);
            }

            if (marked > 0) {
                stats.optimized++;
                return true;
            }
            return false;
        } catch (error) {
            stats.errors++;
            console.error('[cache-optimizer] 前端优化失败，按原样发送', error);
            return false;
        }
    }

    /** 把一次 usage 计入统计 */
    function recordUsage(usage) {
        const parsed = parseUsage(usage);
        if (!parsed) {
            return false;
        }
        stats.usageReports++;
        stats.tokens.read += parsed.read;
        stats.tokens.creation += parsed.creation;
        stats.tokens.input += parsed.input;
        stats.tokens.output += parsed.output;
        return true;
    }

    /**
     * 旁观响应，抓 usage。
     * 必须 clone 之后把副本读干净 —— 只 tee 不消费会让原始流被背压卡住。
     * @param {Response} response
     * @returns {Response} 原样返回
     */
    function trackResponse(response) {
        try {
            if (!response || typeof response.clone !== 'function') {
                return response;
            }

            const copy = response.clone();
            const contentType = String(copy.headers?.get?.('content-type') ?? '');

            if (contentType.includes('text/event-stream') && copy.body) {
                (async () => {
                    const reader = copy.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) {
                                break;
                            }
                            buffer += decoder.decode(value, { stream: true });
                            const lines = buffer.split('\n');
                            buffer = lines.pop() ?? '';
                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (!trimmed.startsWith('data:')) {
                                    continue;
                                }
                                const payload = trimmed.slice(5).trim();
                                if (!payload || payload === '[DONE]') {
                                    continue;
                                }
                                try {
                                    const json = JSON.parse(payload);
                                    // 分别兼容 OpenAI 尾包、Anthropic message_start/delta
                                    recordUsage(json?.usage);
                                    recordUsage(json?.message?.usage);
                                    if (json?.type === 'message_delta' && json?.usage) {
                                        recordUsage(json.usage);
                                    }
                                } catch {
                                    // 半行或不完整 JSON，忽略
                                }
                            }
                        }
                    } catch {
                        // 用户中断 / 连接断开，正常情况
                    } finally {
                        try {
                            await reader.cancel();
                        } catch {
                            // ignore
                        }
                    }
                })();
                return response;
            }

            copy.json().then(json => {
                recordUsage(json?.usage);
                recordUsage(json?.message?.usage);
            }).catch(() => { });
            return response;
        } catch (error) {
            stats.errors++;
            console.error('[cache-optimizer] 读取 usage 失败', error);
            return response;
        }
    }

    /** 命中率（输入侧） */
    function hitRate() {
        const { read, creation, input } = stats.tokens;
        const denominator = read + creation + input;
        return denominator > 0 ? read / denominator : null;
    }

    return {
        optimize,
        trackResponse,
        hitRate,
        stats: () => ({ ...stats }),
        reset() {
            snapshots.clear();
            stats.inspected = 0;
            stats.optimized = 0;
            stats.skipped = 0;
            stats.errors = 0;
            stats.usageReports = 0;
            stats.tokens = { read: 0, creation: 0, input: 0, output: 0 };
        },
        snapshotCount: () => snapshots.size,
    };
}
