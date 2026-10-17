/**
 * Cache Optimizer —— UI 扩展
 *
 * 它本身不干活，只负责给服务端插件 st-cache-optimizer 提供一个开关和读数面板。
 * 真正的断点重排发生在 Node 进程里（plugins/st-cache-optimizer/index.js）。
 *
 * 注意：第三方扩展比内置扩展多一层 third-party/，所以一律用绝对路径导入。
 */

import { getRequestHeaders, saveSettingsDebounced } from '/script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { createClientOptimizer } from './client-optimizer.js';

/** 服务端插件的路由前缀（有则用，没有也能跑） */
const API_BASE = '/api/plugins/st-cache-optimizer';

/** 前端要拦截的接口 */
const GENERATE_PATH = '/api/backends/chat-completions/generate';

/** 前端优化的配置存在 ST 的 extension_settings 里，随 settings.json 持久化 */
const SETTINGS_KEY = 'cache_optimizer';

function getClientConfig() {
    extension_settings[SETTINGS_KEY] ??= { enabled: true, maxBreakpoints: 4, ttl: '5m' };
    return extension_settings[SETTINGS_KEY];
}

/** 前端优化器实例 */
const clientOptimizer = createClientOptimizer({ getConfig: getClientConfig });

/** 服务端插件是否可用（只影响 Claude 直连与统计展示） */
let serverAvailable = false;
/** 是否已经探测过服务端；探测过就不再重复打 404 */
let serverProbed = false;

/**
 * 拦截前端出站请求，在发出去之前把 cache_control 打好。
 * 这是整个插件的主路径 —— 不需要服务端插件也能工作。
 */
function installFetchHook() {
    if (window.__stCacheOptimizerInstalled) {
        return;
    }
    window.__stCacheOptimizerInstalled = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = async function patchedFetch(input, init) {
        let isGenerate = false;
        try {
            const url = typeof input === 'string' ? input : (input?.url ?? '');
            if (url.endsWith(GENERATE_PATH) && init?.body && typeof init.body === 'string') {
                isGenerate = true;
                const body = JSON.parse(init.body);
                // optimize 会顺带注入 stream_options，所以无论是否改动断点都要回写 body
                clientOptimizer.optimize(body);
                init = { ...init, body: JSON.stringify(body) };
            }
        } catch (error) {
            console.error('[cache-optimizer] 拦截失败，按原样发送', error);
        }

        const response = await originalFetch(input, init);

        // 旁观响应，把 usage 里的缓存命中数据取出来
        if (isGenerate) {
            clientOptimizer.trackResponse(response);
        }

        return response;
    };
}

/**
 * 推导「扩展名 + 模板目录」前缀，供 renderExtensionTemplateAsync 使用。
 *
 * 它内部拼的是 `scripts/extensions/${name}/${templateId}.html`（注意：**没有前导斜杠**，
 * 也不认 manifest.js 指向的子目录）。所以要给它从 `scripts/extensions/` 之后、
 * 到入口文件所在目录为止的整段。
 *
 * 两种安装形态：
 *   酒馆 UI 装的仓库本体 → /scripts/extensions/third-party/<repo>/ui/index.js
 *                          → "third-party/<repo>/ui"
 *   服务端插件铺的副本   → /scripts/extensions/third-party/ST-Cache-Optimizer/index.js
 *                          → "third-party/ST-Cache-Optimizer"
 */
const EXTENSION_NAME = (() => {
    const basePath = new URL('.', import.meta.url).pathname;
    const marker = '/scripts/extensions/';
    const index = basePath.indexOf(marker);
    if (index === -1) {
        console.warn('[cache-optimizer] 无法从 URL 推导扩展路径：', basePath);
        return '';
    }
    return basePath.slice(index + marker.length).replace(/\/+$/, '');
})();

/** 轮询句柄 */
let pollTimer = null;
/** 面板是否已挂载 */
let mounted = false;

const MODE_HINTS = {
    false: '只优化断点，不改动任何内容。零语义风险，动态内容在历史深处时已能拿到高命中。',
    reorder: '把易变块在 system 段内挪到末尾。内容不变，仅调整块顺序。',
    hoist: '把易变块搬到本轮最后一条 user 消息。命中率最高，但会改变内容在 prompt 中的位置。',
};

/** 统一的接口调用（自动带 CSRF） */
async function callApi(path, { method = 'GET', body = null } = {}) {
    const options = {
        method,
        headers: getRequestHeaders(),
    };
    if (body !== null) {
        options.body = JSON.stringify(body);
    }
    const response = await fetch(`${API_BASE}${path}`, options);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return method === 'GET' ? response.json() : response.json().catch(() => ({}));
}

function formatNumber(value) {
    const n = Number(value) || 0;
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(2)}M`;
    }
    if (n >= 1_000) {
        return `${(n / 1_000).toFixed(1)}k`;
    }
    return String(n);
}

function setStatus(text, kind) {
    const el = document.getElementById('cache_optimizer_status');
    if (!el) {
        return;
    }
    el.textContent = text;
    el.classList.remove('is-on', 'is-off');
    if (kind) {
        el.classList.add(kind);
    }
}

function showMissing(isMissing) {
    const missing = document.getElementById('cache_optimizer_missing');
    const body = document.getElementById('cache_optimizer_body');
    // 前端模式下不再隐藏功能面板 —— 大部分场景不装服务端插件也能用
    if (missing) {
        missing.style.display = isMissing ? '' : 'none';
    }
    if (body) {
        body.style.display = '';
    }
}

/** 刷新界面：优先用服务端数据，没有就退到前端统计 */
async function refresh() {
    const clientCfg = getClientConfig();

    // 先试服务端插件（只探一次，之后不再重复请求）
    if (!serverProbed) {
        try {
            const [config, stats] = await Promise.all([
                callApi('/config'),
                callApi('/stats?limit=50'),
            ]);
            serverProbed = true;
            serverAvailable = true;
            applyServerState(config, stats);
            return config;
        } catch {
            serverProbed = true;
            serverAvailable = false;
        }
    } else if (serverAvailable) {
        try {
            const [config, stats] = await Promise.all([
                callApi('/config'),
                callApi('/stats?limit=50'),
            ]);
            applyServerState(config, stats);
            return config;
        } catch {
            serverAvailable = false;
        }
    }

    // 没有服务端插件 —— 纯前端模式，照常工作
    showMissing(false);
    setActiveMode('client');

    const enabledEl = document.getElementById('cache_optimizer_enabled');
    if (enabledEl) {
        enabledEl.checked = !!clientCfg.enabled;
    }

    const modeEl = document.getElementById('cache_optimizer_mode');
    if (modeEl) {
        modeEl.value = 'false';
    }
    const modeHint = document.getElementById('cache_optimizer_mode_hint');
    if (modeHint) {
        modeHint.textContent = '纯前端模式：只能优化断点，无法改变内容位置。'
            + '要走 hoist（把动态内容搬到末尾）需要装服务端插件。';
    }

    const kaEl = document.getElementById('cache_optimizer_keepalive');
    if (kaEl) {
        kaEl.checked = false;
    }

    updateBackendHint();

    const cs = clientOptimizer.stats();
    const rate = clientOptimizer.hitRate();

    setText('cache_optimizer_hitrate', rate === null ? '—' : `${(rate * 100).toFixed(1)}%`);
    setText('cache_optimizer_read', rate === null ? '—' : formatNumber(cs.tokens.read));
    setText('cache_optimizer_creation', rate === null ? '—' : formatNumber(cs.tokens.creation));

    const footer = document.getElementById('cache_optimizer_footer');
    if (footer) {
        footer.textContent = buildClientFooter(cs, rate);
    }

    setStatus(clientCfg.enabled ? '已开启（前端）' : '已关闭', clientCfg.enabled ? 'is-on' : 'is-off');
    syncWandButton(clientCfg.enabled);
    return clientCfg;
}

/**
 * 面板上直接显示当前后端能不能用前端优化。
 * 别等用户发完消息发现没数据才去猜。
 */
function updateBackendHint() {
    const el = document.getElementById('cache_optimizer_backend');
    if (!el) {
        return;
    }

    let source = '';
    try {
        source = String(getContext().chatCompletionSettings?.chat_completion_source ?? '');
    } catch {
        el.textContent = '';
        return;
    }

    const PASSTHROUGH = ['openrouter', 'nanogpt', 'custom'];
    const NAME = {
        claude: 'Claude 直连',
        openrouter: 'OpenRouter',
        nanogpt: 'NanoGPT',
        custom: '自定义端点',
        openai: 'OpenAI',
        makersuite: 'Google AI Studio',
        deepseek: 'DeepSeek',
        mistralai: 'Mistral',
        cohere: 'Cohere',
        groq: 'Groq',
        xai: 'xAI',
        aimlapi: 'AIML API',
    };
    const label = NAME[source] ?? (source || '未知后端');

    if (PASSTHROUGH.includes(source)) {
        el.classList.remove('is-warn');
        el.textContent = `当前后端：${label} · 前端优化已生效`;
        return;
    }

    el.classList.add('is-warn');
    if (source === 'claude') {
        el.textContent = `当前后端：${label} · 注意：服务端会重建消息块，前端断点会被丢弃，需装服务端插件`;
    } else if (source === '') {
        el.textContent = '';
    } else {
        el.textContent = `当前后端：${label} · 注意：未验证是否透传 cache_control，可能不生效`;
    }
}

/** 前端模式下给出可操作的诊断信息 */
function buildClientFooter(cs, rate) {
    if (cs.inspected === 0) {
        return '纯前端模式已就绪。发一条消息后回来看。';
    }

    const base = `纯前端模式 · 已检查 ${cs.inspected} 次 · 改写 ${cs.optimized} 次`;

    // 识别到 Claude 直连：这不是 bug，是服务端行为
    if (cs.lastMode === 'claude-direct') {
        return `${base} · 注意：Claude 直连无法在前端生效（服务端会重建消息块），需装服务端插件`;
    }

    if (cs.lastReason?.startsWith('unsupported-source')) {
        return `${base} · 注意：当前后端不支持前端缓存优化：${cs.lastReason.split(':')[1]}`;
    }

    // 改写成功但没拿到 usage
    if (cs.optimized > 0 && cs.usageReports === 0) {
        return `${base} · 已注入断点，但上游没返回 usage 数据，无法计算命中率`
            + '（部分中转/自定义端点不返回缓存统计）';
    }

    if (rate !== null) {
        return `${base} · 命中率基于 ${cs.usageReports} 次响应的 usage 统计`;
    }

    return base;
}

/** 服务端可用时，用服务端的数据填充界面 */
function applyServerState(config, stats) {
    showMissing(false);
    setActiveMode('server');
    updateBackendHint();

    const enabledEl = document.getElementById('cache_optimizer_enabled');
    if (enabledEl) {
        enabledEl.checked = !!config.enabled;
    }

    const modeEl = document.getElementById('cache_optimizer_mode');
    if (modeEl) {
        modeEl.disabled = false;
        modeEl.value = config.relocateVolatile === false ? 'false' : String(config.relocateVolatile);
    }
    const modeHint = document.getElementById('cache_optimizer_mode_hint');
    if (modeHint) {
        modeHint.textContent = MODE_HINTS[config.relocateVolatile === false ? 'false' : String(config.relocateVolatile)] ?? '';
    }

    const kaEl = document.getElementById('cache_optimizer_keepalive');
    if (kaEl) {
        kaEl.disabled = false;
        kaEl.checked = !!config.keepalive?.enabled;
    }

    const summary = stats.summary ?? {};
    const tokens = summary.tokens ?? {};
    setText('cache_optimizer_hitrate', summary.requests > 0 ? `${(summary.hitRate * 100).toFixed(1)}%` : '—');
    setText('cache_optimizer_read', summary.requests > 0 ? formatNumber(tokens.read) : '—');
    setText('cache_optimizer_creation', summary.requests > 0 ? formatNumber(tokens.creation) : '—');

    const counters = stats.counters ?? {};
    const ka = stats.keepalive ?? {};
    const kaText = ka.sent > 0 ? ` · 保活 ${ka.ok}/${ka.sent} 次` : '';
    const footer = document.getElementById('cache_optimizer_footer');
    if (footer) {
        footer.textContent = summary.requests > 0
            ? `服务端模式 · 已统计 ${summary.requests} 次请求 · 拦截 ${counters.intercepted ?? 0} 次${kaText}`
            : '服务端模式已就绪。发一条消息后回来看。';
    }

    setStatus(config.enabled ? '已开启' : '已关闭', config.enabled ? 'is-on' : 'is-off');
    syncWandButton(config.enabled);
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = value;
    }
}

/** 记录当前模式：server / client */
let activeMode = 'client';
function setActiveMode(next) {
    activeMode = next;
}

/** 切换总开关 */
async function setEnabled(enabled) {
    // 前端模式：直接改本地配置并持久化，不依赖服务端
    if (activeMode === 'client') {
        const cfg = getClientConfig();
        cfg.enabled = enabled;
        saveSettingsDebounced();
        setStatus(enabled ? '已开启（前端）' : '已关闭', enabled ? 'is-on' : 'is-off');
        syncWandButton(enabled);
        toastr.success(enabled ? '前端缓存优化已开启' : '前端缓存优化已关闭');
        await refresh();

    // 用户展开面板的那一刻立即刷新一次，别让他盯着旧数字等轮询
    $(document).on('click', '.cache-optimizer-panel .inline-drawer-toggle', () => {
        setTimeout(() => refresh(), 50);
    });
        return;
    }

    try {
        await callApi('/config', { method: 'POST', body: { enabled } });
        setStatus(enabled ? '已开启' : '已关闭', enabled ? 'is-on' : 'is-off');
        syncWandButton(enabled);
        await refresh();
        toastr.success(enabled ? '缓存优化已开启' : '缓存优化已关闭');
    } catch (error) {
        console.error('[cache-optimizer] 切换失败', error);
        toastr.error('切换失败，服务端插件可能未就绪');
        await refresh();
    }
}

/** 切换动态内容处置策略 */
async function setMode(value) {
    if (activeMode === 'client') {
        toastr.info('纯前端模式不支持改变内容位置，需要装服务端插件');
        await refresh();
        return;
    }
    // 下拉框里 "false" 是字符串，要还原成布尔
    const relocateVolatile = value === 'false' ? false : value;
    try {
        await callApi('/config', { method: 'POST', body: { relocateVolatile } });
        const modeHint = document.getElementById('cache_optimizer_mode_hint');
        if (modeHint) {
            modeHint.textContent = MODE_HINTS[value] ?? '';
        }
        await refresh();
    } catch (error) {
        console.error('[cache-optimizer] 改策略失败', error);
        toastr.error('修改失败');
    }
}

/** 魔法棒菜单里的小开关 */
let wandButton = null;

function syncWandButton(enabled, missing = false) {
    if (!wandButton) {
        return;
    }
    const icon = wandButton.querySelector('.cache_optimizer_wand_icon');
    if (icon) {
        icon.className = `cache_optimizer_wand_icon extensionsMenuExtensionButton fa-solid ${
            missing ? 'fa-triangle-exclamation' : (enabled ? 'fa-bolt' : 'fa-bolt-slash')
        }`;
    }
    wandButton.title = missing
        ? '服务端插件未就绪'
        : (enabled ? '缓存优化：已开启（点击关闭）' : '缓存优化：已关闭（点击开启）');
}

function addWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('cache_optimizer_wand')) {
        return;
    }

    const button = document.createElement('div');
    button.id = 'cache_optimizer_wand';
    button.className = 'list-group-item flex-container flexGap5';
    button.innerHTML = `
        <div class="cache_optimizer_wand_icon extensionsMenuExtensionButton fa-solid fa-bolt-slash"></div>
        <span>Cache Optimizer</span>`;
    menu.append(button);

    button.addEventListener('click', async () => {
        const config = await refresh();
        if (!config) {
            return;
        }
        await setEnabled(!config.enabled);
    });

    wandButton = button;
}

/** 扩展入口：manifest 里 hooks.activate = 'init' */
export async function init() {
    if (mounted) {
        return;
    }

    // ★ 主路径：先装前端拦截，不依赖服务端插件
    installFetchHook();

    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
    if (typeof html !== 'string' || html.length === 0) {
        // ST 在渲染失败时不抛错，只返回 undefined —— 面板会静默消失。
        // 这里显式报出来，别让人对着一个空抽屉找原因。
        console.error(
            '[cache-optimizer] 设置面板模板渲染失败。',
            '\n  扩展路径: ' + EXTENSION_NAME,
            '\n  实际请求: scripts/extensions/' + EXTENSION_NAME + '/settings.html',
            '\n  请确认这个地址能访问，或查看上一条 Error rendering template 的详情。',
        );
        toastr.error('设置面板加载失败，请查看控制台', 'Cache Optimizer');
        return;
    }

    $('#extensions_settings2').append(html);
    mounted = true;

    addWandButton();

    // 总开关
    $('#cache_optimizer_enabled').on('input', function () {
        setEnabled(!!$(this).prop('checked'));
    });

    // 策略选择
    $('#cache_optimizer_mode').on('change', function () {
        setMode(String($(this).val()));
    });

    // 缓存保活
    $('#cache_optimizer_keepalive').on('input', async function () {
        const enabled = !!$(this).prop('checked');
        if (activeMode === 'client') {
            $(this).prop('checked', false);
            toastr.info('缓存保活需要服务端插件（要在后台定时发送续期请求）');
            return;
        }
        try {
            await callApi('/config', {
                method: 'POST',
                body: { keepalive: { enabled, factor: 0.75, maxCycles: 2, minIntervalMs: 60000 } },
            });
            toastr.success(enabled ? '缓存保活已开启' : '缓存保活已关闭');
            await refresh();
        } catch {
            toastr.error('切换失败');
            await refresh();
        }
    });

    // 手动刷新 / 清零
    $('#cache_optimizer_refresh').on('click', () => refresh());
    $('#cache_optimizer_reset').on('click', async () => {
        try {
            await callApi('/reset', { method: 'POST', body: {} });
            toastr.success('统计已清零');
            await refresh();
        } catch {
            toastr.error('清零失败');
        }
    });

    await refresh();

    // 面板开着时才轮询，关掉就停，避免空转
    pollTimer = setInterval(() => {
        const panel = document.querySelector('.cache-optimizer-panel');
        if (!panel) {
            return;
        }
        refresh();
    }, 10_000);

    console.log('[cache-optimizer] UI 扩展已加载');
}

/** 卸载时清掉轮询 */
export function onDisable() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}
