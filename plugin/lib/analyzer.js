/**
 * analyzer.js — 把一次出站请求拆成「可缓存前缀单元」，并计算最优断点位置。
 *
 * Anthropic 的缓存前缀顺序是固定的：tools → system → messages。
 * 命中要求「逐字节前缀完全一致」，所以断点只能吃它前面那段。
 */

/** 从任意 JSON 值里去掉 cache_control 后序列化，用于跨请求比对 */
export function normalizeText(value) {
    return JSON.stringify(value, (key, val) => (key === 'cache_control' ? undefined : val));
}

/** 给一个 message 的最后一块文本打 cache_control */
function markMessageContent(message, cacheControl) {
    const content = message?.content;
    if (typeof content === 'string') {
        if (content.length === 0) {
            return false;
        }
        message.content = [{ type: 'text', text: content, cache_control: cacheControl }];
        return true;
    }
    if (Array.isArray(content)) {
        for (let i = content.length - 1; i >= 0; i--) {
            const block = content[i];
            if (block && typeof block === 'object' && block.type !== 'image' && block.type !== 'tool_result' && block.type !== 'tool_use') {
                block.cache_control = cacheControl;
                return true;
            }
        }
    }
    return false;
}

/** 去掉一个 message 上所有 cache_control（把字符串形式的 content 还原回字符串） */
function unmarkMessageContent(message) {
    const content = message?.content;
    if (!Array.isArray(content)) {
        return;
    }
    if (content.length === 1 && content[0]?.type === 'text' && content[0]?.cache_control && !content[0]?.__wasArray) {
        message.content = content[0].text;
        return;
    }
    for (const block of content) {
        if (block && typeof block === 'object') {
            delete block.cache_control;
        }
    }
}

/**
 * 把一个请求体摊平成有序的缓存单元列表。
 * @param {object} body 请求体（Anthropic 原生格式或 OAI 兼容格式）
 * @param {number} ttlMs 不参与比对，仅用于打标记
 * @returns {Array<object>} 单元列表
 */
export function collectUnits(body) {
    /** @type {Array<object>} */
    const units = [];

    // 1. tools
    if (Array.isArray(body.tools)) {
        for (const tool of body.tools) {
            units.push({
                kind: 'tool',
                text: normalizeText(tool),
                searchText: normalizeText(tool),
                mark(cacheControl) {
                    if (tool && typeof tool === 'object') {
                        tool.cache_control = cacheControl;
                        return true;
                    }
                    return false;
                },
                unmark() {
                    if (tool && typeof tool === 'object') {
                        delete tool.cache_control;
                    }
                },
            });
        }
    }

    // 2. system —— Anthropic 原生是顶层 system 字段
    const systemBlocks = [];
    if (typeof body.system === 'string') {
        // 字符串形式：不直接打标记，交给 messages 侧的断点覆盖
        systemBlocks.push({ ref: null, text: body.system, isString: true });
    } else if (Array.isArray(body.system)) {
        for (const block of body.system) {
            systemBlocks.push({ ref: block, text: normalizeText(block), isString: false });
        }
    }
    for (const entry of systemBlocks) {
        units.push({
            kind: 'system',
            text: entry.text,
            // 纯文本形态：判断「内容是否在上一轮出现过」要用它，
            // 因为被 hoist 的内容是嵌在消息正文里的，整块签名匹配不上
            searchText: entry.isString ? entry.text : String(entry.ref?.text ?? entry.text),
            ref: entry.ref,
            isString: entry.isString,
            mark(cacheControl) {
                if (!entry.ref || typeof entry.ref !== 'object') {
                    return false;
                }
                entry.ref.cache_control = cacheControl;
                return true;
            },
            unmark() {
                if (entry.ref && typeof entry.ref === 'object') {
                    delete entry.ref.cache_control;
                }
            },
        });
    }

    // 3. messages —— OAI 兼容格式的 system 也是在这一段里
    if (Array.isArray(body.messages)) {
        for (const message of body.messages) {
            units.push({
                kind: 'message',
                role: message?.role,
                text: normalizeText(message),
                searchText: typeof message?.content === 'string'
                    ? message.content
                    : Array.isArray(message?.content)
                        ? message.content.map(part => part?.text ?? '').join('\n')
                        : normalizeText(message),
                mark(cacheControl) {
                    return markMessageContent(message, cacheControl);
                },
                unmark() {
                    unmarkMessageContent(message);
                },
            });
        }
    }

    return units;
}

/** 清掉请求体里所有既有的 cache_control（插件接管时用） */
export function stripAllCacheControl(body) {
    const strip = (obj) => {
        if (!obj || typeof obj !== 'object') {
            return;
        }
        if (Array.isArray(obj)) {
            obj.forEach(strip);
            return;
        }
        delete obj.cache_control;
        for (const value of Object.values(obj)) {
            strip(value);
        }
    };
    strip(body);
}

/**
 * 计算两串单元的最长公共前缀长度（按单元计）。
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function longestCommonPrefix(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) {
        i++;
    }
    return i;
}

/** 单元签名列表（用于前缀比对） */
export function unitTexts(units) {
    return units.map(u => `${u.kind}:${u.role ?? ''}:${u.text}`);
}

/** 单元纯文本列表（用于「这条内容上一轮见过没有」） */
export function unitContents(units) {
    return units.map(u => u.searchText ?? u.text);
}

/**
 * 计算最优断点位置。
 *
 * 核心权衡：
 * - 打在「已验证稳定的边界」上 → 稳赚，动态内容变天时也能命中
 * - 打在整个 prompt 末尾 → 命中最狠，但**前提是这段前缀下轮还在**
 *
 * 末尾断点是赌注：命中省 90% 输入费，没中要多付 25%（写入价 1.25x）。
 * 判断该不该赌，看的是「上一轮请求是否被完整保留」：
 * - 是 → 对话在单调追加，末尾断点下轮必然命中，放心打
 * - 否 → 前缀中间被动态内容污染了，污染点之后整段都吃不到缓存，
 *        这时候在末尾打断点只会让整段历史按写入价计费，纯亏
 *
 * @param {object} params
 * @param {object[]} params.units 当前请求的单元
 * @param {number} params.stableCount 与历史快照的最长公共前缀单元数
 * @param {number} params.matchedLength 被完整保留的最长历史快照长度
 * @param {number} params.maxSnapshotLength 历史快照的最大长度（仅作兜底参考）
 * @param {number} params.maxBreakpoints 断点上限（Anthropic 为 4）
 * @returns {{indices: number[], appendOnly: boolean, corruptedAt: number|null}}
 */
export function planBreakpoints({
    units,
    stableCount,
    matchedLength = 0,
    maxSnapshotLength = 0,
    latestSnapshotLength = 0,
    maxBreakpoints,
}) {
    const total = units.length;
    if (total === 0 || maxBreakpoints <= 0) {
        return { indices: [], appendOnly: false, corruptedAt: null };
    }

    // 「有没有历史」看的是最大快照长度；「上一轮是否被完整保留」只该跟**最近一次**快照比。
    // 多会话共用一个 key 时，用全局最大值会让 appendOnly 被别的会话误判成 false。
    const referenceLength = latestSnapshotLength > 0 ? latestSnapshotLength : maxSnapshotLength;
    const hasHistory = referenceLength > 0;

    const appendOnly = !hasHistory || stableCount >= referenceLength;

    // 污染点：稳定边界之后的内容下轮大概率还会变
    const corruptedAt = appendOnly ? null : stableCount;

    /** @type {Set<number>} */
    const picked = new Set();

    // 1) 已知稳定边界 —— 无论赌不赌末尾都要打，这是动态内容下的唯一锚点
    if (stableCount > 0 && stableCount <= total) {
        picked.add(stableCount - 1);
    }

    // 2) 末尾 —— 只在单调追加时才打
    if (appendOnly) {
        picked.add(total - 1);
    }

    const remaining = maxBreakpoints - picked.size;
    if (remaining > 0) {
        // 单调追加 → 在稳定边界和末尾之间均分
        // 已被污染 → 全部收在稳定边界之内（多几个粒度，成本极低）
        const to = appendOnly ? total - 1 : Math.max(stableCount - 1, 0);
        const from = stableCount > 0 ? stableCount - 1 : 0;
        const span = to - from;

        if (span > 1) {
            for (let i = 1; i <= remaining; i++) {
                const idx = from + Math.round((span * i) / (remaining + 1));
                if (idx > from && idx < to) {
                    picked.add(idx);
                }
            }
        } else if (!appendOnly) {
            // 稳定区太窄，就在边界往前铺不同粒度的锚点
            for (let i = 1; i <= remaining && stableCount - 1 - i >= 0; i++) {
                picked.add(stableCount - 1 - i);
            }
        }
    }

    // 3) 还没填满就贴着末尾补（仅单调追加）
    if (appendOnly) {
        for (let i = total - 2; i >= 0 && picked.size < maxBreakpoints; i--) {
            picked.add(i);
        }
    }

    // 4) 兜底：一个断点都没有等于永远不写缓存，直接死锁在 0%。
    //    宁可花一点写入费换一次机会。
    if (picked.size === 0) {
        picked.add(Math.min(1, total - 1));
    }

    return {
        indices: [...picked].sort((a, b) => a - b).slice(0, maxBreakpoints),
        appendOnly,
        corruptedAt,
    };
}

/**
 * 找出「上一轮没出现过」的 system 块下标 —— 也就是易变内容。
 *
 * 注意必须按**内容**判断，不能按下标。
 * 一旦某块被搬走（hoist），后面所有块的下标都会前移，
 * 按下标比对会把角色卡、示例对话统统误判成易变，越搬越乱。
 *
 * 判断「出现过」时**不能带 kind**：上一轮被 hoist 进 user 消息的内容，
 * 这一轮会以 message 单元的形式留在快照里。如果只认 system 签名，
 * 就永远认为它没出现过 —— 于是世界书一旦收敛，插件还会一直白白 hoist，
 * 反而把稳定内容从缓存前缀里赶出去（实测会从 95% 掉到 84%）。
 *
 * @param {object[]} units 当前单元
 * @param {string[]} prevTexts 上一个快照的单元文本
 * @returns {number[]} 易变的 system 单元下标（升序）
 */
export function findVolatileSystemUnits(units, prevContents) {
    if (!Array.isArray(prevContents) || prevContents.length === 0) {
        return [];
    }

    // 上一轮所有单元的纯文本拼成一个大串，用来做「包含」判断。
    // 被 hoist 的内容是追加进 user 消息正文的，只有包含匹配才能认出来
    // ——否则世界书一旦收敛，插件还会一直白白 hoist，把稳定内容赶出缓存前缀。
    const haystack = prevContents.join('\n\u0000\n');

    /** @type {number[]} */
    const changed = [];

    for (let i = 0; i < units.length; i++) {
        if (units[i].kind !== 'system') {
            continue;
        }
        const probe = units[i].searchText;
        if (!probe || !haystack.includes(probe)) {
            changed.push(i);
        }
    }

    return changed;
}

/**
 * 把易变的 system 块整体挪到 system 段末尾，让稳定的部分留在前面。
 * 只改变同一段内的顺序，不跨段搬内容。
 *
 * @param {object} body 请求体
 * @param {Set<string>} volatileTexts 易变块的文本集合
 * @returns {number} 实际移动的块数
 */
export function relocateVolatileSystemBlocks(body, volatileTexts) {
    if (!Array.isArray(body.system) || volatileTexts.size === 0) {
        return 0;
    }
    const stable = [];
    const volatile = [];
    for (const block of body.system) {
        if (volatileTexts.has(normalizeText(block))) {
            volatile.push(block);
        } else {
            stable.push(block);
        }
    }
    if (volatile.length === 0 || stable.length === 0) {
        return 0;
    }
    body.system = [...stable, ...volatile];
    return volatile.length;
}


/** 两段文本的最长公共前缀长度（按字符） */
function commonPrefixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
        i++;
    }
    return i;
}

/**
 * 把一段易变文本拆成「能留在前缀里的稳定部分」和「必须搬走的尾巴」。
 *
 * 动机：`{{random}}` 往往只改一小截。比如预设主提示词有 500 字，
 * 只有末尾 `seed=123456` 在变 —— 整块搬走等于白扔 500 字的缓存。
 * 和上一轮的内容做公共前缀比对，只把真正变化的那截搬到末尾。
 *
 * 门槛定得高（默认 90% 以上必须稳定）：世界书这类「全文都在变」的块
 * 如果只留个短前缀在 system 里，下轮前缀再变就把后面的角色卡全废了，
 * 比整块搬走更糟 —— 实测会从 83% 掉到 63%。
 *
 * @param {string} text 当前块文本
 * @param {string[]} prevContents 上一轮所有单元的纯文本
 * @param {object} [options]
 * @param {number} [options.minKeepChars] 值得保留的最小字符数
 * @param {number} [options.minKeepRatio] 至少要占整块的比例
 * @returns {{keep: string, hoist: string}} keep 为空表示整块搬走
 */
/** 某个前缀是否在全部历史快照里都出现过（二分：前缀性质单调） */
function prefixAppearsEverywhere(line, haystacks, minChars) {
    if (line.length < minChars) {
        return 0;
    }
    let lo = minChars;
    let hi = line.length;
    let best = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const probe = line.slice(0, mid);
        if (haystacks.every(haystack => haystack.includes(probe))) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

/**
 * 把一段易变文本拆成「能留在前缀里的稳定部分」和「必须搬走的尾巴」。
 *
 * 分两级判定：
 *   1. **逐行拆分**（主要手段）—— 世界书是一行一条，往往只有几条带随机尾巴，
 *      其余整行没变。整块搬走会把没变的那几条一起扔出缓存。
 *   2. **整块公共前缀**（兜底）—— 单行超长的情况（如一行装完的主提示词），
 *      只搬真正变化的那截。
 *
 * 判定要求「跨多轮都稳定」：只看上一轮是不够的。留下一个下轮还会变的前缀，
 * 等于在 system 区埋了个会变的东西，后面全部跟着失效 —— 比整块搬走更糟。
 *
 * @param {string} text 当前块文本
 * @param {string[][]} snapshotContents 各轮快照的纯文本
 * @param {object} [options]
 * @param {number} [options.minKeepChars] 值得保留的总字符下限
 * @param {number} [options.minLineKeepChars] 单行值得保留的字符下限
 * @param {number} [options.minKeepRatio] 至少占整块的比例
 * @returns {{keep: string, hoist: string}} keep 为空表示整块搬走
 */
export function splitVolatileText(text, snapshotContents, { minKeepChars = 200, minKeepRatio = 0.9 } = {}) {
    if (!text || !Array.isArray(snapshotContents)) {
        return { keep: '', hoist: text ?? '' };
    }

    // 逐轮求「和该轮内容的最长公共前缀」，取最小值 —— 必须每轮都成立才算稳
    const prefixes = [];
    for (const contents of snapshotContents.slice(0, 3)) {
        if (!Array.isArray(contents)) {
            continue;
        }
        let best = 0;
        for (const prev of contents) {
            if (typeof prev !== 'string' || prev.length <= best) {
                continue;
            }
            const length = commonPrefixLength(text, prev);
            if (length > best) {
                best = length;
            }
        }
        prefixes.push(best);
    }

    if (prefixes.length < 2) {
        return { keep: '', hoist: text };
    }

    const stable = Math.min(...prefixes);
    if (stable < minKeepChars || stable < text.length * minKeepRatio) {
        return { keep: '', hoist: text };
    }

    // 别把单词切成两半
    let cut = stable;
    while (cut > minKeepChars && !/[\s\n]/.test(text[cut - 1])) {
        cut--;
    }
    if (cut < minKeepChars) {
        return { keep: '', hoist: text };
    }

    return { keep: text.slice(0, cut).trimEnd(), hoist: text.slice(cut).trim() };
}

/**
 * 找出「注入在消息区里的易变 system 内容」的下标。
 *
 * ST 的 atDepth 世界书、记忆摘要、向量召回都是这么放的：role=system 的消息
 * 插在距离末尾 depth 条的位置。它们每轮内容在变，而且**位置也随历史增长而移动** ——
 * 上一轮它在第 P 条，这一轮跑到第 P+2 条，于是 P 之后的内容全部对不上。
 *
 * 实测这是最恶劣场景里最大的一块浪费：depth=4 时每轮白扔 4 条消息的缓存
 * （长回复下差不多 5000 字符）。把这些注入搬到真正的末尾，就只剩尾巴不可缓存。
 *
 * @param {object[]} units
 * @param {string[]} prevContents
 * @returns {number[]} 下标（升序）
 */
export function findVolatileInjectedMessages(units, prevContents) {
    if (!Array.isArray(prevContents) || prevContents.length === 0) {
        return [];
    }

    const haystack = prevContents.join('\n\u0000\n');
    /** @type {number[]} */
    const changed = [];

    for (let i = 0; i < units.length; i++) {
        if (units[i].kind !== 'message' || units[i].role !== 'system') {
            continue;
        }
        const probe = units[i].searchText;
        if (!probe || !haystack.includes(probe)) {
            changed.push(i);
        }
    }

    return changed;
}

/**
 * 把易变内容从中段搬到 prompt 末尾（最后一条 user 消息里）。
 *
 * 为什么这是「适配任何动态」的关键：
 *   缓存是前缀匹配。动态块卡在 system 里时，它**后面的一切**都吃不到缓存 ——
 *   包括全部对话历史。历史越长，命中率越趋近 0。
 *   把它挪到末尾之后，它只污染「本来就要 miss 的尾巴」，
 *   前面所有静态内容 + 历史都能稳定命中，随历史增长趋近 100%。
 *
 * 副作用：改变了模型看到的内容位置。对 {{random}} 风味文本、实时世界书、
 * 时间戳这类内容通常无害甚至更合理（它们本来就该属于当前轮），
 * 但会改变位置敏感的提示词行为，所以默认关闭、需显式开启。
 *
 * @param {object} body 请求体
 * @param {Set<string>} volatileTexts 易变块的文本集合（normalizeText 后的形式）
 * @param {string[][]} [snapshotContents] 各轮快照的纯文本，用于按公共前缀拆分
 * @param {Set<string>} [volatileInjectedTexts] 消息区里易变的 system 注入内容（normalizeText 形式）
 * @returns {number} 实际搬走的块数
 */
export function hoistVolatileToLastMessage(body, volatileTexts, snapshotContents = [], volatileInjectedTexts = new Set()) {
    if (volatileTexts.size === 0 || !Array.isArray(body.messages) || body.messages.length === 0) {
        return 0;
    }

    /** @type {string[]} */
    const moved = [];

    // 1) Anthropic 原生格式：从顶层 system 数组里摘
    if (Array.isArray(body.system)) {
        const survivors = [];
        for (const block of body.system) {
            if (!volatileTexts.has(normalizeText(block))) {
                survivors.push(block);
                continue;
            }

            const original = typeof block?.text === 'string' ? block.text : normalizeText(block);
            // 只搬真正变化的那截，稳定前缀留在 system 里继续吃缓存
            const { keep, hoist } = splitVolatileText(original, snapshotContents);

            if (keep && typeof block?.text === 'string') {
                block.text = keep;
                survivors.push(block);
                if (hoist) {
                    moved.push(hoist);
                }
            } else {
                moved.push(original);
            }
        }
        body.system = survivors;
    }

    // 2) OAI 格式：从 messages 开头连续的 system 段里摘
    let leadEnd = 0;
    while (leadEnd < body.messages.length && body.messages[leadEnd]?.role === 'system') {
        leadEnd++;
    }
    if (leadEnd > 0) {
        const survivors = [];
        for (const message of body.messages.slice(0, leadEnd)) {
            if (!volatileTexts.has(normalizeText(message))) {
                survivors.push(message);
                continue;
            }

            const original = typeof message.content === 'string' ? message.content : normalizeText(message);
            const { keep, hoist } = splitVolatileText(original, snapshotContents);

            if (keep && typeof message.content === 'string') {
                message.content = keep;
                survivors.push(message);
                if (hoist) {
                    moved.push(hoist);
                }
            } else {
                moved.push(original);
            }
        }
        body.messages = [...survivors, ...body.messages.slice(leadEnd)];
    }

    // 3) 消息区里易变的 system 注入（atDepth 世界书 / 记忆 / 向量召回）
    //    它们卡在中段会把后面几条历史一起废掉，搬到末尾只剩尾巴不可缓存
    if (volatileInjectedTexts.size > 0 && Array.isArray(body.messages) && body.messages.length > 1) {
        const kept = [];
        for (let i = 0; i < body.messages.length; i++) {
            const message = body.messages[i];
            // 最后一条留着当落点，别把自己也搬了
            if (i === body.messages.length - 1 || !volatileInjectedTexts.has(normalizeText(message))) {
                kept.push(message);
                continue;
            }
            moved.push(typeof message.content === 'string' ? message.content : normalizeText(message));
        }
        body.messages = kept;
    }

    if (moved.length === 0) {
        return 0;
    }

    // 4) 塞进最后一条 user 消息
    let target = null;
    for (let i = body.messages.length - 1; i >= 0; i--) {
        if (body.messages[i]?.role === 'user') {
            target = body.messages[i];
            break;
        }
    }
    if (!target) {
        return 0;
    }

    const payload = moved.join('\n\n');
    if (typeof target.content === 'string') {
        target.content = `${target.content}\n\n${payload}`;
    } else if (Array.isArray(target.content)) {
        target.content.push({ type: 'text', text: payload });
    } else {
        return 0;
    }

    return moved.length;
}

/**
 * OAI 兼容格式（OpenRouter / DeepSeek 等）里 system 是 messages 开头的若干条。
 * 只在「开头连续 system 段」内部重排，不把内容搬到对话历史之后 ——
 * 这样语义影响最小，同时把稳定内容顶到最前面。
 *
 * @param {object} body 请求体
 * @param {Set<string>} volatileTexts 易变块的文本集合
 * @returns {number} 实际移动的条数
 */
export function relocateVolatileMessageSystems(body, volatileTexts) {
    if (!Array.isArray(body.messages) || volatileTexts.size === 0) {
        return 0;
    }

    // 找开头连续的 system 段
    let end = 0;
    while (end < body.messages.length && body.messages[end]?.role === 'system') {
        end++;
    }
    if (end <= 1) {
        return 0;
    }

    const leading = body.messages.slice(0, end);
    const stable = [];
    const volatile = [];
    for (const message of leading) {
        if (volatileTexts.has(normalizeText(message))) {
            volatile.push(message);
        } else {
            stable.push(message);
        }
    }
    if (volatile.length === 0 || stable.length === 0) {
        return 0;
    }

    // 顺序没变就不动，避免无谓的写入
    const next = [...stable, ...volatile];
    const changed = next.some((m, i) => m !== leading[i]);
    if (!changed) {
        return 0;
    }

    body.messages = [...next, ...body.messages.slice(end)];
    return volatile.length;
}
