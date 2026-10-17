/**
 * 静态检查闸门。
 *
 * 教训：曾经有个 bug 是 `GENERATE_PATH` 的声明被误删，
 * 导致前端拦截每次都抛 ReferenceError —— 逻辑层单测全绿，
 * 只有真浏览器里才暴露。这类「未定义变量」必须用静态检查挡住。
 *
 * 用 npx eslint 跑，不需要在仓库里装依赖。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const targets = [
    path.join(ROOT, 'ui', 'index.js'),
    path.join(ROOT, 'ui', 'client-optimizer.js'),
    path.join(ROOT, 'plugin', 'index.js'),
];

const configPath = path.join(ROOT, '.eslintrc.ci.json');
fs.writeFileSync(configPath, JSON.stringify({
    env: { browser: true, node: true, es2022: true },
    parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
    globals: {
        $: 'readonly',
        jQuery: 'readonly',
        toastr: 'readonly',
        window: 'readonly',
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'warn' },
}, null, 2));

let failed = 0;
try {
    const out = execFileSync('npx', [
        'eslint', '--no-eslintrc', '-c', configPath, ...targets,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(out.trim() || '无问题');
} catch (error) {
    const stdout = error.stdout?.toString() ?? '';
    const stderr = error.stderr?.toString() ?? '';
    console.log(stdout.trim());
    const errors = (stdout.match(/error/g) ?? []).length;
    console.error(stderr.trim());
    failed = errors > 0 ? 1 : 0;
} finally {
    fs.unlinkSync(configPath);
}

console.log(`\n结果: ${failed ? '存在未定义变量等错误' : '通过'}`);
process.exit(failed);
