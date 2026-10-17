/**
 * st-cache-optimizer —— SillyTavern 服务端插件
 *
 * 作用：在请求真正发往模型 API 之前，重新规划 cache_control 断点，
 *       让「能命中的前缀」最大化。
 *
 * 原理：Anthropic / OpenRouter 的缓存是「前缀逐字节匹配」。
 *       ST 自带的实现只在 system 段的最后一个块打断点 —— 一旦那个块是动态的
 *       （{{random}} 宏、实时世界书、会变的作者注），整段前缀全部失效，命中率归零。
 *       本插件通过跨请求比对，自己算出「真正稳定的前缀边界」，把断点打在那里，
 *       所以动态内容不再拖垮它前面的静态部分。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';

import { color } from '../../../src/util.js';
import {
    collectUnits,
    stripAllCacheControl,
    unitTexts,
    planBreakpoints,
    unitContents,
    findVolatileSystemUnits,
    findVolatileInjectedMessages,
    relocateVolatileSystemBlocks,
    relocateVolatileMessageSystems,
    hoistVolatileToLastMessage,
} from './lib/analyzer.js';
import { getSnapshots, recordSnapshot, bestStablePrefix, clearSnapshots, snapshotStats } from './lib/snapshots.js';
import { parseUsage, recordUsage, summarize, recentRecords, clearStats, scanSseUsage, createUsageObserver } from './lib/stats.js';
import { installHttpInterceptor, uninstallHttpInterceptor, sendRawRequest, hostOf, counters as interceptCounters } from './lib/intercept.js';
import { installUIExtension, uiExtensionInfo } from './lib/ui-installer.js';
import { createKeepalive, ttlToMs, toKeepaliveBody } from './lib/keepalive.js';

const __dirname = import.meta.dirname ?? path.dirname(url.fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

/** 默认配置。写进 config.json 后可在运行时通过接口修改。 */
const DEFAULT_CONFIG = {
    /** 总开关 */
    enabled: true,
    /** 断点上限。Anthropic 硬上限是 4。 */
    maxBreakpoints: 4,
    /** 缓存 TTL：'5m'（写入 1.25 倍价）或 '1h'（写入 2 倍价） */
    ttl: '5m',
    /**
     * 是否接管 ST 自带的 cache_control。
     * false = 先清掉 ST 打的断点，再按本插件的最优布局重打（推荐）
     * true  = 保留 ST 的断点，只做补充
     */
    respectStBuiltin: false,
    /**
     * 动态内容处置策略：
     *   false      —— 不动内容，只优化断点（纯增强，零风险）
     *   'reorder'  —— 把易变 system 块在 system 段内挪到末尾（语义影响很小）
     *   'hoist'    —— 把易变块搬到本轮最后一条 user 消息里
     *                 ★ 这是唯一能让「动态内容不再拖垮整个历史」的模式，
     *                   命中率随对话增长趋近 100%，但会改变内容在 prompt 中的位置
     */
    relocateVolatile: false,
    /** 命中率统计所需的最小样本数，少于它不输出结论 */
    minSamples: 3,
    /** 启动时把自带的 UI 扩展铺到用户扩展目录（关掉就只保留手动安装） */
    autoInstallUI: true,
    /**
     * 缓存保活。默认关闭 —— 它会按周期产生真实的 API 调用（虽然很便宜）。
     * 开启后，在 TTL 到期前发一个 max_tokens=1 的请求把缓存续期，
     * 避免「挂机超过 5 分钟 → 下一轮整段冷启动」。
     */
    keepalive: {
        enabled: false,
        /** 提前多少比例触发（0.75 = TTL 的 75%） */
        factor: 0.75,
        /** 最多续期几次，防止人走了还在烧钱 */
        maxCycles: 2,
        /** 生产环境最短触发间隔下限（毫秒） */
        minIntervalMs: 60_000,
        /** 显式指定触发间隔（毫秒），0 = 按 TTL×factor 自动算。主要给测试用 */
        intervalMs: 0,
    },
    /** 打印详细日志 */
    debug: false,
    /** 允许处理的 API 地址特征 */
    targets: [
        'api.anthropic.com',
        'openrouter.ai',
        'api.nano-gpt.com',
        'api.deepseek.com',
        'generativelanguage.googleapis.com',
        'api.moonshot.cn',
        'api.x.ai',
    ],
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            return { ...DEFAULT_CONFIG, ...parsed };
        }
    } catch (error) {
        console.error(color.red(`[cache-optimizer] config.json 解析失败，使用默认值: ${error.message}`));
    }
    return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** @type {typeof DEFAULT_CONFIG} */
let config = loadConfig();

/** 原始 fetch（用于同时覆盖走全局 fetch 的少数路径），exit() 时还原 */
const originalFetch = globalThis.fetch;
let fetchPatched = false;
let httpPatched = false;

/** 缓存保活管理器 */
const keepalive = createKeepalive({
    send: sendRawRequest,
    log: msg => debugLog(msg),
});

/** 计数器（含拦截层统计） */
const counters = {
    inspected: 0,
    get optimized() { return interceptCounters.rewritten; },
    get seen() { return interceptCounters.seen; },
    get intercepted() { return interceptCounters.intercepted; },
    get httpErrors() { return interceptCounters.errors; },
    errors: 0,
};

function debugLog(...args) {
    if (config.debug) {
        console.log(color.gray('[cache-optimizer]'), ...args);
    }
}

/**
 * 稳定标识一次对话：同一份凭证 + 同一个模型，就算同一个会话池。
 * @param {HeadersInit|undefined} headers
 * @param {object} body
 */
function snapshotKey(headers, body) {
    const normalized = normalizeHeaders(headers);
    const auth = normalized['x-api-key'] || normalized['authorization'] || '';
    const model = String(body?.model ?? '');
    return crypto.createHash('sha256').update(`${auth.slice(0, 120)}|${model}`).digest('hex').slice(0, 16);
}

function normalizeHeaders(headers) {
    /** @type {Record<string,string>} */
    const out = {};
    if (!headers) {
        return out;
    }
    if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
        headers.forEach((value, key) => { out[String(key).toLowerCase()] = String(value); });
        return out;
    }
    if (Array.isArray(headers)) {
        for (const [key, value] of headers) {
            out[String(key).toLowerCase()] = String(value);
        }
        return out;
    }
    for (const [key, value] of Object.entries(headers)) {
        out[String(key).toLowerCase()] = String(value);
    }
    return out;
}

function resolveUrl(input) {
    if (typeof input === 'string') {
        return input;
    }
    if (input instanceof URL) {
        return input.href;
    }
    if (input && typeof input === 'object' && typeof input.url === 'string') {
        return input.url;
    }
    return '';
}

/**
 * 判断这个请求是否归本插件管。
 * 只在能确认是「对话补全」请求时才动手，其余一律放行。
 *
 * @param {string} url 请求地址
 * @param {object} headers 请求头（大小写不敏感）
 */
function shouldHandle(url, headers) {
    if (!url) {
        return false;
    }
    const normalized = normalizeHeaders(headers);
    // Anthropic 直连带这个头，是最可靠的信号
    if (normalized['anthropic-version']) {
        return true;
    }
    const host = hostOf(url);
    if (!host) {
        return false;
    }
    return config.targets.some(t => host === t || host.endsWith(`.${t}`));
}

/**
 * 从一个已被拦截的 HTTP 请求里取出 body 并重排断点。
 * @param {{url: string, headers: object, body: string}} req
 * @returns {string|null} 改写后的 body；null 表示不改
 */
function handleInterceptedRequest({ url, headers, body }) {
    if (!config.enabled || !body) {
        return null;
    }

    // 只看 JSON 请求
    const normalized = normalizeHeaders(headers);
    const contentType = String(normalized['content-type'] ?? '');
    if (contentType && !contentType.includes('json')) {
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch {
        return null;
    }

    // 必须是对话补全：得有 messages
    if (!parsed || !Array.isArray(parsed.messages)) {
        return null;
    }

    counters.inspected++;
    const result = optimizeBody(parsed, headers);

    if (!result.changed) {
        return null;
    }

    if (config.debug) {
        debugLog(
            `[${hostOf(url)}] ${result.info.units} units, stable=${result.info.stableCount}, ` +
            `bps=[${result.info.breakpoints}], appendOnly=${result.info.appendOnly}`,
        );
    }

    const serialized = JSON.stringify(parsed);

    // 真实请求来了 → 取消上一轮排的保活，并按需重新安排
    const key = result.info.key;
    keepalive.cancel(key);
    if (config.keepalive?.enabled) {
        try {
            keepalive.schedule(key, {
                url,
                headers: normalizeHeaders(headers),
                body: JSON.stringify(toKeepaliveBody(parsed)),
                ttlMs: ttlToMs(config.ttl),
                factor: Number(config.keepalive.factor) || 0.75,
                maxCycles: Number(config.keepalive.maxCycles) || 2,
                minIntervalMs: Number(config.keepalive.minIntervalMs) || 60_000,
                intervalMs: Number(config.keepalive.intervalMs) || 0,
            });
        } catch (error) {
            debugLog('安排保活失败:', error.message);
        }
    }

    return serialized;
}

/**
 * 核心：重排断点。
 * @returns {{changed: boolean, info: object}}
 */
function optimizeBody(body, headers) {
    const key = snapshotKey(headers, body);

    // 1) 接管：清掉既有断点，避免和 ST 自带的布局打架
    if (!config.respectStBuiltin) {
        stripAllCacheControl(body);
    }

    // 2) 摊平成缓存单元
    let units = collectUnits(body);
    if (units.length === 0) {
        return { changed: false, info: { reason: 'no-units' } };
    }

    let texts = unitTexts(units);
    const snapshots = getSnapshots(key);
    // 注意：这一组值算的是「内容重排之前」的稳定前缀，只用来判断哪些块是易变的。
    // 重排之后必须重新比对 —— 内容变了，稳定边界也会变。
    const initial = bestStablePrefix(texts, snapshots);
    let { stableCount, matchedLength, maxSnapshotLength, latestSnapshotLength } = initial;

    // 3) 可选：处置易变内容，让稳定前缀更长
    let relocated = 0;
    // 拆分前的原文也要留在快照里：否则下一轮看不清「这块其实没变」，
    // 会一直重复拆分 —— 实测会把稳定内容永久赶出前缀。
    const beforeHoistContents = unitContents(units);
    const mode = config.relocateVolatile;
    if (mode && snapshots.length > 0) {
        const prevContents = snapshots[0].contents ?? [];
        const volatileIdx = findVolatileSystemUnits(units, prevContents);
        const volatileInjected = findVolatileInjectedMessages(units, prevContents);
        if (volatileIdx.length > 0 || volatileInjected.length > 0) {
            const volatileTexts = new Set([
                ...volatileIdx.map(i => units[i].text),
                ...volatileInjected.map(i => units[i].text),
            ]);
            if (mode === 'hoist') {
                const injectedTexts = new Set(volatileInjected.map(i => units[i].text));
                relocated = hoistVolatileToLastMessage(body, volatileTexts, snapshots.map(s => s.contents ?? []), injectedTexts);
            } else {
                relocated = relocateVolatileSystemBlocks(body, volatileTexts);
                relocated += relocateVolatileMessageSystems(body, volatileTexts);
            }
            if (relocated > 0) {
                // 内容变了：重新收集，并基于新内容重新比对稳定前缀
                units = collectUnits(body);
                texts = unitTexts(units);
                ({ stableCount, matchedLength, maxSnapshotLength, latestSnapshotLength } = bestStablePrefix(texts, snapshots));
            }
        }
    }

    // 4) 规划断点
    const maxBreakpoints = Math.max(1, Math.min(4, Number(config.maxBreakpoints) || 4));
    const plan = planBreakpoints({
        units,
        stableCount,
        matchedLength,
        maxSnapshotLength,
        latestSnapshotLength,
        maxBreakpoints,
    });
    const indices = plan.indices;

    const cacheControl = { type: 'ephemeral', ttl: config.ttl };
    let marked = 0;
    for (const index of indices) {
        if (units[index]?.mark(cacheControl)) {
            marked++;
        }
    }

    // 5) 记住这一轮，供下一轮比对
    recordSnapshot(key, texts, [...unitContents(units), ...beforeHoistContents]);

    return {
        changed: marked > 0,
        info: {
            key,
            units: units.length,
            stableCount,
            matchedLength,
            maxSnapshotLength,
            breakpoints: indices,
            marked,
            relocated,
            appendOnly: plan.appendOnly,
            corruptedAt: plan.corruptedAt,
            estimatedHitRate: units.length > 0 ? matchedLength / units.length : 0,
        },
    };
}

/** 读响应里的真实 usage（全局 fetch 路径） */
function attachStats(response, info) {
    try {
        if (!response || typeof response.clone !== 'function') {
            return;
        }
        const contentType = String(response.headers?.get?.('content-type') ?? '');

        if (contentType.includes('text/event-stream')) {
            const cloned = response.clone();
            const reader = cloned.body?.getReader?.();
            if (!reader) {
                return;
            }
            const decoder = new TextDecoder();
            const acc = { read: 0, creation: 0, input: 0, output: 0, total: undefined };
            (async () => {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            break;
                        }
                        scanSseUsage(decoder.decode(value, { stream: true }), acc);
                    }
                } catch {
                    // 流被中断属正常现象，忽略
                } finally {
                    if (acc.total !== undefined) {
                        recordUsage({ ...acc, estimated: info?.estimatedHitRate ?? null });
                        debugLog(`usage(stream) hit=${(acc.rate * 100).toFixed(1)}%`);
                    }
                }
            })();
            return;
        }

        const cloned = response.clone();
        cloned.json().then(json => {
            const parsed = parseUsage(json?.usage ?? json?.message?.usage);
            if (parsed) {
                recordUsage({ ...parsed, estimated: info?.estimatedHitRate ?? null });
                debugLog(`usage hit=${(parsed.rate * 100).toFixed(1)}%`);
            }
        }).catch(() => { });
    } catch (error) {
        debugLog('attachStats failed:', error.message);
    }
}

/**
 * 旁观 HTTP 响应，抓真实 usage（node-fetch 路径）。
 * 只包 res.push，把每个 chunk 转发给观察器 —— 不改流、不改内容、不影响 pipe / async 迭代。
 */
function observeResponse(response, url) {
    try {
        if (!response || typeof response.push !== 'function') {
            return;
        }

        const observer = createUsageObserver();
        const originalPush = response.push;

        response.push = function push(chunk, encoding) {
            try {
                observer.observe(chunk);
            } catch {
                // 旁观失败绝不能影响数据流
            }
            return originalPush.call(this, chunk, encoding);
        };

        const finalize = () => {
            try {
                const contentType = response.headers?.['content-type'];
                const acc = observer.finish(contentType);
                if (acc?.total !== undefined) {
                    recordUsage({ ...acc, host: hostOf(url) });
                    debugLog(`usage ${hostOf(url)} hit=${(acc.rate * 100).toFixed(1)}%`);
                }
            } catch (error) {
                debugLog('响应统计失败:', error.message);
            }
        };

        // 'end' / 'close' 都试，哪个先来都行
        response.once('end', finalize);
        response.once('close', finalize);
    } catch (error) {
        debugLog('observeResponse 失败:', error.message);
    }
}

/**
 * 包装 globalThis.fetch —— 少数走全局 fetch 的路径（如 util.js）也能覆盖。
 * Undici 不走 node:http，所以和 HTTP 拦截器不会重复处理同一个请求。
 */
async function patchedFetch(input, init) {
    let info = null;
    try {
        if (config.enabled) {
            const requestUrl = resolveUrl(input);
            const bodyText = typeof init?.body === 'string' ? init.body : null;

            if (requestUrl && bodyText) {
                const body = JSON.parse(bodyText);
                if (shouldHandle(requestUrl, init?.headers) && Array.isArray(body.messages)) {
                    counters.inspected++;
                    const result = optimizeBody(body, init?.headers);
                    info = result.info;
                    if (result.changed) {
                        init = { ...init, body: JSON.stringify(body) };
                    }
                }
            }
        }
    } catch (error) {
        counters.errors++;
        debugLog('global fetch 改写失败，按原样发送:', error.message);
    }

    const response = await originalFetch(input, init);
    attachStats(response, info);
    return response;
}

/**
 * 找出所有需要安装 UI 扩展的目录。
 *
 * 为什么不 import src/users.js：
 *   那条链路会拉进 src/endpoints/secrets.js → src/util.js:getConfig(),
 *   而 getConfig() 在配置未初始化时直接 process.exit(1) —— 兜不住。
 *   数据目录布局是稳定的（DATA_ROOT/<handle>/extensions），自己扫更安全。
 *
 * @returns {string[]} 各用户的 extensions 目录（绝对或相对于 DATA_ROOT 的路径）
 */
function isInstalledAsUiExtension() {
    // 本仓库同时是一个合法的 UI 扩展（根目录有 manifest.json）。
    // 如果用户是用「酒馆 UI 一键安装」把这个仓库装进了 extensions/ 目录，
    // 就不该再往同一个地方铺一份 —— 否则会加载出两个一模一样的面板。
    const here = path.resolve(__dirname, '..');
    return here.split(path.sep).includes('extensions');
}

function resolveExtensionTargets() {
    const dataRoot = globalThis.DATA_ROOT;
    if (!dataRoot) {
        return [];
    }

    let entries;
    try {
        entries = fs.readdirSync(dataRoot, { withFileTypes: true });
    } catch {
        return [];
    }

    return entries
        .filter(entry => entry.isDirectory())
        // 下划线开头的是 ST 内部目录（_cache / _uploads / _errors …），不是用户
        .filter(entry => !entry.name.startsWith('_') && !entry.name.startsWith('.'))
        .map(entry => path.join(dataRoot, entry.name, 'extensions'));
}

/**
 * 把自带的 UI 扩展铺到所有用户的 extensions 目录。
 * 失败不影响插件主功能 —— UI 只是开关，拦截层才是干活的。
 */
async function deployUIExtension() {
    try {
        if (isInstalledAsUiExtension()) {
            console.log(color.gray('[cache-optimizer] 本插件是从 extensions/ 目录加载的（UI 一键安装），跳过重复部署。'));
            return null;
        }

        const targets = resolveExtensionTargets();
        if (targets.length === 0) {
            console.log(color.yellow('[cache-optimizer] 没找到用户数据目录，跳过 UI 扩展安装（可手动复制 ui/ 到 data/<用户>/extensions/）'));
            return null;
        }

        const result = installUIExtension(targets);

        for (const dir of result.installed) {
            console.log(color.green(`[cache-optimizer] 已安装 UI 扩展 → ${dir}`));
        }
        for (const dir of result.updated) {
            console.log(color.green(`[cache-optimizer] 已更新 UI 扩展 → ${dir}`));
        }
        for (const dir of result.duplicates) {
            console.log(color.gray(`[cache-optimizer] 检测到同款扩展已存在于 ${dir}，跳过重复部署。`));
        }
        for (const dir of result.failed) {
            console.log(color.yellow(`[cache-optimizer] UI 扩展安装失败 → ${dir}（可手动复制 ui/ 到该目录）`));
        }
        if (result.installed.length > 0 || result.updated.length > 0) {
            console.log(color.gray('[cache-optimizer] 刷新 SillyTavern 页面，即可在「扩展」面板看到开关。'));
        }
        return result;
    } catch (error) {
        console.log(color.yellow(`[cache-optimizer] UI 扩展自动安装跳过：${error.message}`));
        return null;
    }
}

/** 1. 必须导出 info */
export const info = {    id: 'st-cache-optimizer',
    name: 'Prompt Cache Optimizer',
    description: '在请求发出前重排 cache_control 断点，让动态提示词不再拖垮缓存命中率，并统计真实命中数据。',
};

/** 2. 必须导出 init(router) */
export async function init(router) {
    config = loadConfig();

    // 主通道：ST 的模型后端走 node-fetch，最终落到 node:http / node:https
    if (!httpPatched) {
        httpPatched = installHttpInterceptor({
            shouldIntercept: (url, headers) => config.enabled && shouldHandle(url, headers),
            onBody: handleInterceptedRequest,
            onResponse: observeResponse,
            onError: (msg, err) => debugLog(msg, err?.message ?? ''),
        });
    }

    // 辅通道：走全局 fetch 的少数路径
    if (!fetchPatched) {
        globalThis.fetch = patchedFetch;
        fetchPatched = true;
    }

    console.log(color.magenta(`[cache-optimizer] 已接管出站请求缓存断点（enabled=${config.enabled}, maxBreakpoints=${config.maxBreakpoints}, ttl=${config.ttl}）`));

    if (!config.respectStBuiltin) {
        console.log(color.gray('[cache-optimizer] 提示：本插件已接管断点布局，ST 的 enableSystemPromptCache / cachingAtDepth 设置不再必要。'));
    }

    // 把自带的 UI 扩展铺到各用户的 extensions 目录，这样一条 install 命令就够了
    if (config.autoInstallUI) {
        await deployUIExtension();
    }

    // GET /api/plugins/st-cache-optimizer/stats
    router.get('/stats', (request, response) => {
        const limit = Number(request.query.limit) || 50;
        response.json({
            summary: summarize(limit),
            recent: recentRecords(Number(request.query.detail) || 20),
            snapshots: snapshotStats(),
            uiExtension: uiExtensionInfo(),
            keepalive: keepalive.stats(),
            counters: {
                inspected: counters.inspected,
                seen: counters.seen,
                intercepted: counters.intercepted,
                optimized: counters.optimized,
                skipped: counters.skipped,
                errors: counters.errors,
                httpErrors: counters.httpErrors,
            },
            config: { ...config },
            minSamples: config.minSamples,
        });
    });

    // GET /api/plugins/st-cache-optimizer/config
    router.get('/config', (request, response) => {
        response.json(config);
    });

    // POST /api/plugins/st-cache-optimizer/config
    router.post('/config', (request, response) => {
        const patch = request.body ?? {};
        const next = { ...config, ...patch };
        next.maxBreakpoints = Math.max(1, Math.min(4, Number(next.maxBreakpoints) || 4));
        next.ttl = next.ttl === '1h' ? '1h' : '5m';
        config = next;
        saveConfig(config);
        response.json({ ok: true, config });
    });

    // POST /api/plugins/st-cache-optimizer/install-ui —— 手动重铺 UI 扩展
    router.post('/install-ui', async (request, response) => {
        const result = await deployUIExtension();
        response.json({ ok: result !== null, result, uiExtension: uiExtensionInfo() });
    });

    // POST /api/plugins/st-cache-optimizer/reset
    router.post('/reset', (request, response) => {
        clearStats();
        clearSnapshots();
        counters.inspected = 0;
        counters.errors = 0;
        keepalive.cancelAll();
        for (const key of Object.keys(interceptCounters)) {
            interceptCounters[key] = 0;
        }
        response.json({ ok: true });
    });
}

/** 3. 可选导出 exit() */
export async function exit() {
    keepalive.cancelAll();
    if (fetchPatched) {
        globalThis.fetch = originalFetch;
        fetchPatched = false;
    }
    if (httpPatched) {
        uninstallHttpInterceptor();
        httpPatched = false;
    }
    console.log(color.yellow('[cache-optimizer] 出站请求拦截已还原，插件退出。'));
}
