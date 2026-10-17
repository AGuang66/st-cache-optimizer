/**
 * intercept.js —— 出站 HTTP 请求拦截层。
 *
 * 为什么不直接包装 globalThis.fetch：
 *   SillyTavern 的模型后端（chat-completions.js、anthropic.js、openrouter.js …）
 *   全都写了 `import fetch from 'node-fetch'`，**不走全局 fetch**。
 *   而 node-fetch 内部是运行时做
 *     const send = (proto === 'https:' ? https : http).request
 *   这种属性查找后调用 —— 所以在 node:http / node:https 模块对象上替换 request
 *   就能拦到它，且对调用方完全透明。
 *
 * 拦到之后：把 body 缓冲下来，在 end() 时改写，并修正 Content-Length。
 * 铁律：任何解析失败都原样放行，绝不损坏请求。
 */

import http from 'node:http';
import https from 'node:https';

/** 保存原始方法，退出时还原 */
let originals = null;

/** 统计 */
export const counters = {
    seen: 0,
    intercepted: 0,
    rewritten: 0,
    errors: 0,
};

function noop() { }

/**
 * 归一化 request 的调用参数。
 * 同时支持 http.request(url, options, cb) 和 http.request(options, cb)。
 */
function normalizeArgs(urlOrOptions, optionsOrCallback, maybeCallback, defaultProtocol) {
    if (typeof urlOrOptions === 'string' || urlOrOptions instanceof URL) {
        const urlString = String(urlOrOptions);
        if (typeof optionsOrCallback === 'function') {
            return { urlString, options: undefined, callback: optionsOrCallback };
        }
        return { urlString, options: optionsOrCallback, callback: maybeCallback };
    }

    const options = urlOrOptions ?? {};
    let urlString = '';
    try {
        if (options.href) {
            urlString = String(options.href);
        } else {
            const protocol = options.protocol ?? defaultProtocol;
            const host = options.hostname ?? options.host ?? '';
            const port = options.port ? `:${options.port}` : '';
            const path = options.path ?? '/';
            urlString = `${protocol}//${host}${port}${path}`;
        }
    } catch {
        urlString = '';
    }
    return { urlString, options, callback: optionsOrCallback };
}

/** 从 URL 串里取 host */
export function hostOf(urlString) {
    try {
        return new URL(urlString).host;
    } catch {
        return '';
    }
}

/**
 * 安装拦截器。
 *
 * @param {object} params
 * @param {(req: {url: string, headers: object, body: string}) => (string|undefined|null)} params.onBody
 *        拿到 body 后返回改写结果；返回空值表示不改写
 * @param {(url: string, headers: object) => boolean} params.shouldIntercept
 * @param {(res: import('node:http').IncomingMessage, url: string) => void} [params.onResponse]
 *        拿到响应对象；实现方必须只做旁观，不能消费流
 * @param {(msg: string, err?: Error) => void} [params.onError]
 */
export function installHttpInterceptor({ onBody, shouldIntercept, onResponse, onError = noop }) {
    if (originals) {
        return false; // 已安装，幂等
    }

    originals = { http: http.request, https: https.request };

    const makePatched = (original, defaultProtocol) => function patchedRequest(urlOrOptions, optionsOrCallback, maybeCallback) {
        const { urlString, options } = normalizeArgs(
            urlOrOptions, optionsOrCallback, maybeCallback, defaultProtocol,
        );

        counters.seen++;

        let handle = false;
        try {
            handle = Boolean(urlString) && shouldIntercept(urlString, options?.headers ?? {});
        } catch (error) {
            onError('shouldIntercept 抛错', error);
        }

        if (!handle) {
            return original.apply(this, arguments);
        }

        const request = original.apply(this, arguments);
        counters.intercepted++;

        // 旁观响应。用 'response' 事件而不是替换回调 —— node-fetch 自己也是这么监听的，
        // 多加一个监听器不会影响它。
        if (typeof onResponse === 'function') {
            request.on('response', response => {
                try {
                    onResponse(response, urlString);
                } catch (error) {
                    onError('响应观察失败', error);
                }
            });
        }

        // 关键：在覆盖之前先抓住实例原本的 end
        const originalEnd = request.end.bind(request);

        /** @type {Buffer[]} */
        const chunks = [];
        let finished = false;

        const push = (chunk, encoding) => {
            if (!chunk) {
                return;
            }
            chunks.push(Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
        };

        request.write = function write(chunk, encoding, writeCallback) {
            try {
                push(chunk, encoding);
            } catch (error) {
                counters.errors++;
                onError('缓冲请求体失败', error);
            }
            // 真实写入推迟到 end()，这里只消化回调
            if (typeof encoding === 'function') {
                encoding();
            } else if (typeof writeCallback === 'function') {
                writeCallback();
            }
            return true;
        };

        request.end = function end(chunk, encoding, endCallback) {
            if (finished) {
                return request;
            }
            finished = true;

            try {
                push(chunk, encoding);
            } catch (error) {
                counters.errors++;
                onError('缓冲请求体失败', error);
            }

            let body = Buffer.concat(chunks).toString('utf8');

            try {
                const rewritten = onBody({ url: urlString, headers: options?.headers ?? {}, body });
                if (typeof rewritten === 'string' && rewritten !== body) {
                    const byteLength = Buffer.byteLength(rewritten);
                    body = rewritten;
                    // 长度变了必须同步，否则对端会截断或多读
                    try {
                        request.removeHeader('transfer-encoding');
                        request.setHeader('Content-Length', String(byteLength));
                    } catch (error) {
                        onError('修正 Content-Length 失败', error);
                    }
                    counters.rewritten++;
                }
            } catch (error) {
                counters.errors++;
                onError('改写请求体失败，按原样发送', error);
            }

            if (typeof encoding === 'function') {
                return originalEnd(body, encoding);
            }
            return originalEnd(body, encoding, endCallback);
        };

        return request;
    };

    http.request = makePatched(originals.http, 'http:');
    https.request = makePatched(originals.https, 'https:');
    return true;
}

/**
 * 用**未经改写**的原始 request 发一个请求。
 *
 * 供缓存保活使用：保活请求带着已经优化好的 body 出去，
 * 绕开我们自己的拦截层，避免递归改写和重复记账。
 *
 * @param {string} urlString
 * @param {Record<string,string>} headers
 * @param {string} body
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export function sendRawRequest(urlString, headers, body) {
    return new Promise(resolve => {
        let settled = false;
        const done = (value) => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        };

        try {
            const parsed = new URL(urlString);
            const isHttps = parsed.protocol === 'https:';
            const requestFn = isHttps
                ? (originals?.https ?? https.request)
                : (originals?.http ?? http.request);

            const payload = Buffer.from(body, 'utf8');
            // content-length 必须按新 body 重算；其余头原样带上（鉴权、beta 头等）
            const outgoingHeaders = { ...headers, 'content-length': String(payload.length) };
            delete outgoingHeaders['transfer-encoding'];

            const request = requestFn(urlString, { method: 'POST', headers: outgoingHeaders }, response => {
                // 保活只关心状态码，响应体直接丢弃
                response.resume();
                response.on('end', () => done({
                    ok: response.statusCode >= 200 && response.statusCode < 300,
                    status: response.statusCode,
                }));
                response.on('error', error => done({ ok: false, error: error.message }));
            });

            request.on('error', error => done({ ok: false, error: error.message }));
            request.setTimeout(60_000, () => {
                request.destroy();
                done({ ok: false, error: 'timeout' });
            });
            request.end(payload);
        } catch (error) {
            done({ ok: false, error: error.message });
        }
    });
}

/** 还原 */
export function uninstallHttpInterceptor() {
    if (!originals) {
        return false;
    }
    http.request = originals.http;
    https.request = originals.https;
    originals = null;
    return true;
}
