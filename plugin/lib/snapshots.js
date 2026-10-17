/**
 * snapshots.js — 跨请求前缀快照。
 *
 * 缓存能不能命中，取决于「这一轮的 prompt 和上一轮共享多长的前缀」。
 * 插件自己记住历史请求的单元序列，下一轮拿来比对，就能算出稳定边界在哪。
 */

/** 每个 key 保留的快照条数。留多条是为了同时兼容多会话 / 重新生成 / 滑动。 */
const MAX_SNAPSHOTS_PER_KEY = 6;

/** key 总数上限，超出按最近使用淘汰 */
const MAX_KEYS = 64;

/**
 * @typedef {object} Snapshot
 * @property {string[]} texts 单元签名序列（用于前缀比对）
 * @property {string[]} contents 单元纯文本序列（用于「内容是否见过」判断）
 * @property {number} length 单元数
 * @property {number} at 时间戳
 */

/** @type {Map<string, Snapshot[]>} */
const store = new Map();

/**
 * 取某个 key 的快照列表（按最近使用排序，最新的在前）。
 * @param {string} key
 * @returns {Snapshot[]}
 */
export function getSnapshots(key) {
    const list = store.get(key);
    if (!list) {
        return [];
    }
    // 重新插入以更新 LRU 顺序
    store.delete(key);
    store.set(key, list);
    return list;
}

/**
 * 记录一次请求的快照。
 * @param {string} key
 * @param {string[]} texts 单元签名序列
 * @param {string[]} [contents] 单元纯文本序列
 */
export function recordSnapshot(key, texts, contents = []) {
    const list = getSnapshots(key);
    list.unshift({ texts, contents, length: texts.length, at: Date.now() });
    if (list.length > MAX_SNAPSHOTS_PER_KEY) {
        list.length = MAX_SNAPSHOTS_PER_KEY;
    }
    store.set(key, list);

    while (store.size > MAX_KEYS) {
        const oldest = store.keys().next().value;
        store.delete(oldest);
    }
}

/**
 * 用当前单元序列和所有历史快照比对，取最长的公共前缀。
 * @param {string[]} currentTexts
 * @param {Snapshot[]} snapshots
 * @returns {{stableCount: number, matchedLength: number, maxSnapshotLength: number, latestSnapshotLength: number}}
 *   stableCount          最长公共前缀（单元数），任何位置比它靠前的都能命中
 *   matchedLength        被「完整保留为前缀」的最长历史快照长度
 *   maxSnapshotLength    历史快照的最大长度
 *   latestSnapshotLength 最近一次快照的长度（判断「上一轮是否还在」该用它）
 */
export function bestStablePrefix(currentTexts, snapshots) {
    let stableCount = 0;
    let matchedLength = 0;
    let maxSnapshotLength = 0;
    // snapshots 按最近使用排序，第 0 条就是上一次请求
    const latestSnapshotLength = snapshots[0]?.length ?? 0;
    for (const snap of snapshots) {
        maxSnapshotLength = Math.max(maxSnapshotLength, snap.length);
        // 只有当历史快照确实是当前请求的前缀时，它的长度才有意义
        if (snap.length > currentTexts.length) {
            continue;
        }
        let i = 0;
        const max = Math.min(snap.length, currentTexts.length);
        while (i < max && snap.texts[i] === currentTexts[i]) {
            i++;
        }
        // 整个快照都是前缀 → 它缓存过的内容本轮全能命中
        if (i === snap.length && snap.length > matchedLength) {
            matchedLength = snap.length;
        }
        if (i > stableCount) {
            stableCount = i;
        }
    }
    return { stableCount, matchedLength, maxSnapshotLength, latestSnapshotLength };
}

/** 清空所有状态 */
export function clearSnapshots() {
    store.clear();
}

/** 当前状态规模，供 /status 接口展示 */
export function snapshotStats() {
    let snapshots = 0;
    for (const list of store.values()) {
        snapshots += list.length;
    }
    return { keys: store.size, snapshots };
}
