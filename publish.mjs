#!/usr/bin/env node
/**
 * publish.mjs —— 把这个仓库推上 GitHub，并打印两个安装入口的链接。
 *
 * 酒馆 UI 的安装器只认 github.com / gitlab.com / gitee.com 三个域名，
 * 所以仓库必须落在其中一家，自建服务器不行。
 *
 * 用法（先配好 git 凭据；gh 只在 GitHub 分支用到）：
 *   node publish.mjs                              # GitHub，默认仓库名 st-cache-optimizer
 *   node publish.mjs my-name                      # GitHub，自定义仓库名
 *   node publish.mjs --gitee <你的gitee用户名>     # 推到 Gitee（国内最省事）
 *   node publish.mjs --gitlab <你的gitlab用户名>   # 推到 GitLab
 *   node publish.mjs --private                    # 私有仓库（UI 匿名克隆会失败）
 *
 * 用部署密钥（SSH）推送，不把 token 交出去：
 *   node publish.mjs --gitee <用户名> --ssh
 *   （公钥贴到平台，私钥留在本机 ~/.ssh/st_publish_ed25519）
 *
 * 只做三件事：建仓库 → 推代码 → 打印链接。不做任何破坏性操作。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const positional = args.filter(a => !a.startsWith('--'));

const repoName = positional[0] ?? 'st-cache-optimizer';
const visibility = flags.includes('--private') ? 'private' : 'public';

/** 酒馆 UI 安装器白名单里的三家 */
const HOSTS = {
    github: 'github.com',
    gitlab: 'gitlab.com',
    gitee: 'gitee.com',
};

const target = flags.includes('--gitee') ? 'gitee'
    : flags.includes('--gitlab') ? 'gitlab'
        : 'github';

const useSsh = flags.includes('--ssh');
const SSH_HOSTS = { github: 'github.com', gitlab: 'gitlab.com', gitee: 'gitee.com' };
const SSH_KEY = process.env.ST_PUBLISH_KEY ?? `${process.env.HOME}/.ssh/st_publish_ed25519`;

/** Gitee / GitLab 用「--gitee <用户名>」的形式传账号 */
function optionValue(flag) {
    const index = args.indexOf(flag);
    return index !== -1 ? args[index + 1] : null;
}
const account = optionValue(`--${target}`) ?? process.env.GIT_USER ?? null;

function run(cmd, cmdArgs, { allowFail = false } = {}) {
    try {
        const out = execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return out.trim();
    } catch (error) {
        if (allowFail) {
            return null;
        }
        console.error(`\n命令失败：${cmd} ${cmdArgs.join(' ')}`);
        console.error(error.stderr?.toString() ?? error.message);
        process.exit(1);
    }
}

function hasGh() {
    return run('gh', ['--version'], { allowFail: true }) !== null;
}

function ghAuthed() {
    return run('gh', ['auth', 'status'], { allowFail: true }) !== null;
}

console.log(`目标平台：${target}（${HOSTS[target]}）`);

if (target !== 'github') {
    if (!account) {
        console.error(`
推到 ${target} 需要你的用户名：

  node publish.mjs ${repoName} --${target} <你的${target}用户名>

然后在 ${target} 网页上先建一个空仓库（不要勾 README / gitignore），再重跑本命令。
`);
        process.exit(1);
    }

    const remoteUrl = useSsh
        ? `git@${SSH_HOSTS[target]}:${account}/${repoName}.git`
        : `https://${HOSTS[target]}/${account}/${repoName}.git`;
    console.log(`远程地址：${remoteUrl}`);

    const existing = run('git', ['remote', 'get-url', 'origin'], { allowFail: true });
    if (existing) {
        run('git', ['remote', 'set-url', 'origin', remoteUrl]);
    } else {
        run('git', ['remote', 'add', 'origin', remoteUrl]);
    }

    console.log(`推送中…（${useSsh ? '用 SSH 部署密钥' : 'HTTPS，需要 token'}）`);
    if (useSsh) {
        if (!existsSync(SSH_KEY)) {
            console.error(`
找不到私钥：${SSH_KEY}

生成一个：
  ssh-keygen -t ed25519 -N "" -f ${SSH_KEY}
然后把 ${SSH_KEY}.pub 的内容贴到平台后台的「SSH 公钥 / 部署密钥」。
`);
            process.exit(1);
        }
        run('git', ['-c', `core.sshCommand=ssh -i ${SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`, 'push', '-u', 'origin', 'HEAD']);
    } else {
        run('git', ['push', '-u', 'origin', 'HEAD']);
    }

    console.log(`
============================================================
已推送到：${remoteUrl}

【酒馆 UI 一键安装】
  「扩展」面板 → Install extension → 粘贴：
  ${remoteUrl}
============================================================
`);
    process.exit(0);
}

console.log('检查环境…');

if (!hasGh()) {
    console.error(`
没找到 gh（GitHub CLI）。

两个选择：

  A. 装 gh 后重新运行本脚本
     https://cli.github.com/

  B. 不用 gh，手动三步：
     1. 在 https://github.com/new 新建仓库 ${repoName}（不要勾选 README/gitignore）
     2. git remote add origin https://github.com/<你的用户名>/${repoName}.git
     3. git push -u origin HEAD
`);
    process.exit(1);
}

if (!ghAuthed()) {
    console.error(`
gh 已安装但没登录。先跑：

  gh auth login

然后再执行：node publish.mjs ${repoName}
`);
    process.exit(1);
}

if (run('git', ['rev-parse', '--is-inside-work-tree'], { allowFail: true }) !== 'true') {
    console.error('当前目录不是 git 仓库。');
    process.exit(1);
}

const dirty = run('git', ['status', '--porcelain']);
if (dirty) {
    console.error('工作区有未提交的改动，先提交再发布：\n');
    console.error(dirty);
    process.exit(1);
}

if (useSsh) {
    const repoOwner = process.env.GIT_USER ?? run('gh', ['api', 'user', '--jq', '.login'], { allowFail: true });
    if (!repoOwner) {
        console.error('用 --ssh 需要知道仓库所有者，请设置 GIT_USER=<你的用户名>');
        process.exit(1);
    }
    const sshUrl = `git@github.com:${repoOwner}/${repoName}.git`;
    console.log(`远程地址：${sshUrl}`);
    const existingSsh = run('git', ['remote', 'get-url', 'origin'], { allowFail: true });
    if (existingSsh) {
        run('git', ['remote', 'set-url', 'origin', sshUrl]);
    } else {
        run('git', ['remote', 'add', 'origin', sshUrl]);
    }
    run('git', ['-c', `core.sshCommand=ssh -i ${SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`, 'push', '-u', 'origin', 'HEAD']);
    console.log(`\n已推送：https://github.com/${repoOwner}/${repoName}\n`);
    process.exit(0);
}

const existingRemote = run('git', ['remote', 'get-url', 'origin'], { allowFail: true });
if (existingRemote) {
    console.log(`已有 origin：${existingRemote}，直接推送。`);
    run('git', ['push', '-u', 'origin', 'HEAD']);
} else {
    console.log(`创建 GitHub 仓库 ${repoName}（${visibility}）…`);
    run('gh', ['repo', 'create', repoName, `--${visibility}`, '--source', '.', '--remote', 'origin', '--push']);
}

const login = run('gh', ['api', 'user', '--jq', '.login'], { allowFail: true });
const url = run('gh', ['repo', 'view', '--json', 'url', '--jq', '.url'], { allowFail: true })
    ?? `https://github.com/${login}/${repoName}`;

console.log(`
============================================================
仓库已发布：${url}

【方式一】酒馆 UI 一键安装（推荐）
  1. 打开「扩展」面板 → Install extension
  2. 粘贴：
     ${url}
  3. 重启 SillyTavern

【方式二】命令行安装服务端插件
  cd /path/to/SillyTavern
  node plugins.js install ${url}
============================================================

说明：方式一装的是 UI 面板，方式二装的是真正干活的 Node 端拦截层。
两者可以都装 —— 插件会自动避免面板重复。
`);
