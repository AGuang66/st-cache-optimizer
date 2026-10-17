/**
 * stats.js — 从响应里读出真实的缓存命中数据，并做滚动统计。
 *
 * ST 本体完全不解析 usage，所以用户在界面上看不到任何缓存命中率。
 * 插件既然已经挂在 fetch 上，顺手把 usage 读出来，就有了真实数据。
 *
 * Anthropic 的 usage 字段：
 *   input_tokens                  —— 未走缓存的输入
 *   cache_creation_input_tokens   —— 本轮写入缓存的量（写入价更贵）
 *   cache_read_input_tokens       —— 本轮从缓存读到的量（命中）
 *   output_tokens                 —— 输出
 */

const MAX_RECORDS = 200;

/** @type {Array<object>} */
const records = [];

/**
 * 从 usage 对象算命中率。
 * @param {object} usage
 * @returns {{read: number, creation: number, input: number, output: number, total: number, rate: number} | null}
 */
export function parseUsage(usage) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }
    const read = Number(usage.cache_read_input_tokens ?? 0) || 0;
    const creation = Number(usage.cache_creation_input_tokens ?? 0) || 0;
    const input = Number(usage.input_tokens ?? 0) || 0;
    const output = Number(usage.output_tokens ?? 0) || 0;
    const total = read + creation + input;
    if (total <= 0) {
        return null;
    }
    return { read, creation, input, output, total, rate: read / total };
}

/**
 * 记录一次请求的用量。
 * @param {object} entry
 */
export function recordUsage(entry) {
    records.push({ at: Date.now(), ...entry });
    if (records.length > MAX_RECORDS) {
        records.shift();
    }
}

/**
 * 汇总统计。
 * @param {number} [limit] 只统计最近 N 条
 * @returns {object}
 */
export function summarize(limit = 50) {
    const recent = records.slice(-limit);
    const totals = recent.reduce((acc, r) => {
        acc.read += r.read ?? 0;
        acc.creation += r.creation ?? 0;
        acc.input += r.input ?? 0;
        acc.output += r.output ?? 0;
        return acc;
    }, { read: 0, creation: 0, input: 0, output: 0 });

    const denominator = totals.read + totals.creation + totals.input;
    return {
        requests: recent.length,
        totalRequests: records.length,
        tokens: totals,
        /** 输入侧命中率 */
        hitRate: denominator > 0 ? totals.read / denominator : 0,
        last: recent.at(-1) ?? null,
    };
}

/** 最近若干条明细 */
export function recentRecords(limit = 20) {
    return records.slice(-limit);
}

/** 清空统计 */
export function clearStats() {
    records.length = 0;
}

/**
 * 从 SSE 文本块里抓 usage。
 * Anthropic 流式分两个事件：
 *   message_start → 输入侧（input / cache_read / cache_creation）
 *   message_delta → 输出侧（output_tokens）
 * 后者没有输入字段，所以不能用 parseUsage 的总量校验去卡它。
 *
 * 注意：本函数只处理「完整的行」。跨 chunk 断行由 createUsageObserver 负责拼接。
 * @param {string} text
 * @param {object} acc 累积器
 */

/**
 * 创建一个响应观察器。
 *
 * 为什么包 res.push 而不是监听 'data'：
 *   ST 的 forwardFetchResponse 用 `body.pipe(to)` 消费响应流，
 *   有些地方又用 async 迭代。监听 'data' 会把流切成流动模式，可能干扰 async 迭代。
 *   而 push() 是数据进入可读缓冲区的唯一入口 —— 包住它就能对任何消费方式零侵入地旁观。
 *
 * @returns {{observe: Function, scan: Function, finish: Function, getAcc: Function}}
 */
export function createUsageObserver({ maxRawBytes = 512 * 1024 } = {}) {
    const acc = { read: 0, creation: 0, input: 0, output: 0, total: undefined };
    const decoder = new TextDecoder();
    let pending = '';
    let raw = '';

    return {
        /** 包在 res.push 上 */
        observe(chunk) {
            if (!chunk) {
                return;
            }
            let text;
            try {
                text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
            } catch {
                return;
            }

            if (raw.length < maxRawBytes) {
                raw += text;
            }

            // 按行切，SSE 的一行可能被拆在多个 chunk 里
            pending += text;
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) {
                scanSseUsage(line, acc);
            }
        },

        /** 响应结束时兜底：非流式的 JSON 响应走这里 */
        finish(contentType) {
            if (acc.total !== undefined) {
                return acc;
            }
            if (pending) {
                scanSseUsage(pending, acc);
            }
            if (acc.total !== undefined) {
                return acc;
            }
            if (String(contentType ?? '').includes('json')) {
                try {
                    const json = JSON.parse(raw);
                    const parsed = parseUsage(json?.usage ?? json?.message?.usage);
                    if (parsed) {
                        Object.assign(acc, parsed);
                    }
                } catch {
                    // 截断或非法 JSON，忽略
                }
            }
            return acc;
        },

        getAcc() {
            return acc;
        },
    };
}

/**
 * 从 SSE 文本块里抓 usage。
 *
 * Anthropic 流式分两个事件：
 *   message_start → 输入侧（input / cache_read / cache_creation）
 *   message_delta → 输出侧（output_tokens）
 * 后者没有输入字段，所以不能用 parseUsage 的总量校验去卡它。
 *
 * 注意：本函数只处理「完整的行」。跨 chunk 断行由 createUsageObserver 负责拼接。
 * @param {string} text
 * @param {object} acc 累积器
 */
export function scanSseUsage(text, acc) {
    for (const line of String(text).split('\n')) {
        if (!line.startsWith('data:')) {
            continue;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') {
            continue;
        }
        let json;
        try {
            json = JSON.parse(payload);
        } catch {
            continue;
        }

        const usage = json?.message?.usage ?? json?.usage;
        if (!usage || typeof usage !== 'object') {
            continue;
        }

        // 输入侧：只认第一次带输入数据的出现
        if (acc.total === undefined) {
            const parsed = parseUsage(usage);
            if (parsed) {
                Object.assign(acc, parsed);
                continue;
            }
        }

        // 输出侧：取最新的非零值
        const output = Number(usage.output_tokens ?? 0) || 0;
        if (output > 0) {
            acc.output = output;
        }
    }
    return acc;
}
