/**
 * ui-installer.js —— 把插件自带的 UI 扩展自动铺到用户扩展目录。
 *
 * 为什么需要它：
 *   服务端插件装在 plugins/，UI 扩展必须装在 data/<用户>/extensions/。
 *   两处目录互不相干，没法用一条命令覆盖。
 *   所以插件启动时自己把 ui/ 目录复制过去 —— 用户只需 `node plugins.js install`，
 *   刷新页面就能在设置里看到开关。
 *
 * 行为：
 *   - 目标目录不存在 → 复制
 *   - 版本号变了 → 覆盖（用户手改的内容会丢，所以只覆盖本插件自己的文件）
 *   - 版本一致 → 什么都不做
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = import.meta.dirname ?? path.dirname(url.fileURLToPath(import.meta.url));

/** 本文件在 plugin/lib/ 下，而 ui/ 在仓库根，所以要往上两层 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const UI_SOURCE_DIR = path.join(REPO_ROOT, 'ui');

/** 扩展在用户目录下的文件夹名 */
const EXTENSION_DIR_NAME = 'ST-Cache-Optimizer';

/** 需要同步的文件（相对 ui/） */
const FILES = [
    'manifest.json',
    'index.js',
    'settings.html',
    'style.css',
];

function readUIVersion() {
    try {
        const manifestPath = path.join(UI_SOURCE_DIR, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return String(manifest.version ?? '0.0.0');
    } catch {
        return null;
    }
}

/**
 * 扫描同一目录下是否已经有「同款」扩展。
 *
 * 场景：用户既在酒馆 UI 里用 URL 装了这个仓库（目录名 = 仓库名），
 * 又装了服务端插件（插件会把 ui/ 铺成 ST-Cache-Optimizer）。
 * 两次安装的目录名不同，但其实是同一个面板 —— 会出现两个一模一样的设置栏。
 *
 * 所以部署前先看兄弟目录里有没有认领了同一身份的扩展。
 *
 * @param {string} parentDir 用户的 extensions 目录
 * @param {string} excludeDirName 本次要写入的目录名（不算冲突）
 * @returns {boolean}
 */
function hasSiblingCopy(parentDir, excludeDirName) {
    const own = readBundledManifest();
    if (!own) {
        return false;
    }

    let entries;
    try {
        entries = fs.readdirSync(parentDir, { withFileTypes: true });
    } catch {
        return false;
    }

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === excludeDirName) {
            continue;
        }
        try {
            const manifestPath = path.join(parentDir, entry.name, 'manifest.json');
            if (!fs.existsSync(manifestPath)) {
                continue;
            }
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (manifest.display_name === own.display_name && manifest.author === own.author) {
                return true;
            }
        } catch {
            // 读不动就跳过，不因为这个阻断部署
        }
    }
    return false;
}

/** 读自带的 manifest（用于身份比对） */
function readBundledManifest() {
    try {
        return JSON.parse(fs.readFileSync(path.join(UI_SOURCE_DIR, 'manifest.json'), 'utf8'));
    } catch {
        return null;
    }
}

function readInstalledVersion(targetDir) {
    try {
        const manifestPath = path.join(targetDir, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return String(manifest.version ?? '0.0.0');
    } catch {
        return null;
    }
}

/**
 * 把 UI 扩展安装/更新到指定用户目录。
 * @param {string} userExtensionsDir 形如 data/default-user/extensions
 * @returns {'installed'|'updated'|'skipped'|'failed'}
 */
function installInto(userExtensionsDir) {
    const targetDir = path.join(userExtensionsDir, EXTENSION_DIR_NAME);
    const bundledVersion = readUIVersion();
    if (!bundledVersion) {
        return 'failed';
    }

    const installedVersion = readInstalledVersion(targetDir);
    if (installedVersion === bundledVersion) {
        return 'skipped';
    }

    // 已经有同款扩展（比如用 URL 装的这个仓库本身）→ 不要再来一份
    if (hasSiblingCopy(userExtensionsDir, EXTENSION_DIR_NAME)) {
        return 'duplicate';
    }

    try {
        fs.mkdirSync(targetDir, { recursive: true });
        for (const file of FILES) {
            const from = path.join(UI_SOURCE_DIR, file);
            const to = path.join(targetDir, file);
            if (!fs.existsSync(from)) {
                continue;
            }
            fs.copyFileSync(from, to);
        }
        return installedVersion === null ? 'installed' : 'updated';
    } catch {
        return 'failed';
    }
}

/**
 * 对所有用户执行安装。
 * @param {string[]} userExtensionsDirs 各用户的 extensions 目录
 * @returns {{installed: string[], updated: string[], duplicates: string[], failed: string[]}}
 */
export function installUIExtension(userExtensionsDirs) {
    const result = { installed: [], updated: [], duplicates: [], failed: [] };
    for (const dir of userExtensionsDirs) {
        if (!dir) {
            continue;
        }
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        } catch {
            result.failed.push(dir);
            continue;
        }

        const outcome = installInto(dir);
        if (outcome === 'duplicate') {
            result.duplicates.push(dir);
        } else if (outcome === 'installed') {
            result.installed.push(dir);
        } else if (outcome === 'updated') {
            result.updated.push(dir);
        } else if (outcome === 'failed') {
            result.failed.push(dir);
        }
    }
    return result;
}

/** 供 status 接口展示 */
export function uiExtensionInfo() {
    return {
        directoryName: EXTENSION_DIR_NAME,
        version: readUIVersion(),
        files: [...FILES],
    };
}
