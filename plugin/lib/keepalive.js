/**
 * keepalive.js —— 缓存保活。
 *
 * 为什么需要它：
 *   Anthropic / OpenRouter 的缓存 TTL 默认只有 5 分钟。
 *   真实使用里，人看完回复再想、再打字，经常就超了 ——
 *   下一轮整段历史按「未缓存」重新计费，命中率瞬间归零。
 *   前缀优化做得再好，也架不住这次冷启动。
 *
 * 做法：
 *   每轮生成结束后，在 TTL 到期前（默认 75%）发一个 max_tokens=1 的轻量请求，
 *   把同一份 prompt 再读一次。缓存读的钱是 0.1×，而内容会被刷新，TTL 续上。
 *
 * 成本：
 *   一次保活 ≈ 0.1 × prompt tokens。若它挡下了一次冷启动，
 *   等于省下 0.9 × prompt tokens —— 发一次就回本，之后纯赚。
 *   代价是即使你不再提问，也会按周期产生这 0.1× 的开销，
 *   所以有 maxCycles 上限，且默认关闭。
 */

const DEFAULT_MIN_INTERVAL_MS = 60_000;

/**
 * @param {object} options
 * @param {(url: string, headers: object, body: string) => Promise<{ok: boolean, status?: number, error?: string}>} options.send
 * @param {(msg: string) => void} [options.log]
 */
export function createKeepalive({ send, log = () => { } }) {
    /** key -> { timer, cycles, enabled } */
    const entries = new Map();

    /** 统计 */
    const counters = { sent: 0, ok: 0, failed: 0, cancelled: 0 };

    function clearEntry(key) {
        const entry = entries.get(key);
        if (!entry) {
            return false;
        }
        if (entry.timer) {
            clearTimeout(entry.timer);
        }
        entries.delete(key);
        return true;
    }

    /**
     * 安排一次保活。
     * @param {string} key 会话标识
     * @param {object} params
     * @param {string} params.url
     * @param {Record<string,string>} params.headers
     * @param {string} params.body 已经优化过（含 cache_control）的请求体
     * @param {number} params.ttlMs 缓存 TTL
     * @param {number} [params.factor] 提前多少比例触发（0.75 = TTL 的 75%）
     * @param {number} [params.maxCycles] 最多续期几次
     * @param {number} [params.minIntervalMs] 生产环境的最短间隔下限（防止配置写错导致疯狂请求）
     * @param {number} [params.intervalMs] 显式指定间隔，直接覆盖上面的计算（测试用）
     */
    function schedule(key, {
        url, headers, body, ttlMs, factor = 0.75, maxCycles = 2,
        minIntervalMs = DEFAULT_MIN_INTERVAL_MS, intervalMs = 0,
    }) {
        clearEntry(key);

        if (!url || !body || maxCycles <= 0) {
            return;
        }

        // 注意 Math.max 是取较大值：minIntervalMs 只是下限，不能用来把间隔调小。
        // 测试要走 intervalMs 这条显式覆盖。
        const interval = Number(intervalMs) > 0
            ? Number(intervalMs)
            : Math.max(minIntervalMs, Math.round(ttlMs * factor));
        const entry = { timer: null, cycles: 0 };
        entries.set(key, entry);

        const tick = async () => {
            // 期间来了真实请求的话，这条已经被 cancel 掉了
            if (entries.get(key) !== entry) {
                return;
            }

            entry.cycles++;
            let result;
            try {
                result = await send(url, headers, body);
            } catch (error) {
                result = { ok: false, error: error.message };
            }

            counters.sent++;
            if (result?.ok) {
                counters.ok++;
                log(`保活 ${entry.cycles}/${maxCycles} 成功`);
            } else {
                counters.failed++;
                log(`保活失败：${result?.error ?? result?.status ?? 'unknown'}`);
            }

            if (entries.get(key) !== entry) {
                return;
            }

            if (result?.ok && entry.cycles < maxCycles) {
                entry.timer = setTimeout(tick, interval);
                if (typeof entry.timer?.unref === 'function') {
                    entry.timer.unref();
                }
            } else {
                entries.delete(key);
            }
        };

        entry.timer = setTimeout(tick, interval);
        // 保活不应该拖住进程退出
        if (typeof entry.timer?.unref === 'function') {
            entry.timer.unref();
        }
    }

    /** 真实请求来了 → 取消该会话的保活 */
    function cancel(key) {
        if (clearEntry(key)) {
            counters.cancelled++;
        }
    }

    function cancelAll() {
        for (const key of [...entries.keys()]) {
            clearEntry(key);
        }
    }

    function stats() {
        return { pending: entries.size, ...counters };
    }

    return { schedule, cancel, cancelAll, stats };
}

/**
 * 把 TTL 配置字符串换成毫秒。
 * @param {'5m'|'1h'} ttl
 * @returns {number}
 */
export function ttlToMs(ttl) {
    return ttl === '1h' ? 60 * 60 * 1000 : 5 * 60 * 1000;
}

/**
 * 把一条常规请求改造成保活请求体。
 * 去掉一切有副作用的字段，只要「读一遍前缀」的效果。
 * @param {object} body 已优化的请求体
 * @returns {object}
 */
export function toKeepaliveBody(body) {
    const clone = structuredClone(body);
    clone.max_tokens = 1;
    clone.stream = false;
    // 工具调用会有副作用，必须摘掉
    delete clone.tools;
    delete clone.tool_choice;
    // 思考模式在 max_tokens=1 下会直接报错
    delete clone.thinking;
    delete clone.output_config;
    delete clone.reasoning;
    delete clone.reasoning_effort;
    return clone;
}
