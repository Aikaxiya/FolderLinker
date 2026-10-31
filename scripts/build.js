'use strict';

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG_BIN = path.join(ROOT, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
const RCEDIT = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
const ICO = path.join(ROOT, 'assets', 'app.ico');
const FAVICON = path.join(ROOT, 'src', 'ui', 'favicon.ico');
const OUT = path.join(ROOT, 'dist', 'FolderLinker.exe');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const VERSION_STRINGS = {
    FileDescription: '文件夹联接器',
    ProductName: '文件夹联接器',
    CompanyName: 'FolderLinker',
    InternalName: 'FolderLinker',
    OriginalFilename: 'FolderLinker.exe',
    FileVersion: VERSION,
    ProductVersion: VERSION
};

/**
 * 执行命令，失败即中断
 * @param {string} cmd 可执行文件
 * @param {string[]} args 参数
 * @param {object} [options] spawn 选项
 */
function run(cmd, args, options = {}) {
    const result = spawnSync(cmd, args, Object.assign({stdio: 'inherit', cwd: ROOT}, options));
    if (result.status !== 0) {
        throw new Error('命令执行失败（' + result.status + '）：' + cmd + ' ' + args.join(' '));
    }
}

/**
 * 定位 pkg 缓存里的基础二进制
 * @returns {string} 基础二进制路径
 */
function findBase() {
    const cache = path.join(process.env.USERPROFILE || '', '.pkg-cache');
    if (!fs.existsSync(cache)) {
        throw new Error('找不到 pkg 缓存目录，请先成功构建一次');
    }
    const candidates = [];
    for (const dir of fs.readdirSync(cache)) {
        const full = path.join(cache, dir);
        if (!/^v\d+\.\d+$/.test(dir) || !fs.statSync(full).isDirectory()) {
            continue;
        }
        for (const name of fs.readdirSync(full)) {
            if (/^fetched-v\d+\.\d+\.\d+-win-x64$/.test(name)) {
                candidates.push(path.join(full, name));
            }
        }
    }
    if (candidates.length === 0) {
        throw new Error('找不到基础二进制，请先联网执行一次 pkg');
    }
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0];
}

/**
 * 给基础二进制预置图标与版本信息
 * pkg 会把载荷位置硬编码进引导脚本，成品 exe 再改 PE 会让载荷定位失效，
 * 所以这些资源必须在 pkg 追加载荷之前打进去。
 * @param {string} base 基础二进制
 */
function patchBaseResources(base) {
    const backup = base + '.orig';
    if (!fs.existsSync(backup)) {
        fs.copyFileSync(base, backup);
    }
    const marker = base + '.res-stamp';
    const stamp = JSON.stringify({ico: fs.statSync(ICO).mtimeMs, ver: VERSION_STRINGS});
    if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === stamp) {
        console.log('基础二进制已带最新图标与版本信息，跳过注入');
        return;
    }
    fs.copyFileSync(backup, base);
    const args = [base, '--set-icon', ICO];
    for (const [key, value] of Object.entries(VERSION_STRINGS)) {
        args.push('--set-version-string', key, value);
    }
    args.push('--set-file-version', VERSION, '--set-product-version', VERSION);
    run(RCEDIT, args);
    fs.writeFileSync(marker, stamp);
    console.log('已向基础二进制注入图标与版本信息');
}

function main() {
    console.log('[1/4] 生成图标');
    run(process.execPath, [path.join(__dirname, 'build-icon.js')]);
    fs.copyFileSync(ICO, FAVICON);

    console.log('[2/4] 准备基础二进制');
    const base = findBase();
    patchBaseResources(base);

    console.log('[3/4] 打包');
    if (fs.existsSync(OUT)) {
        try {
            fs.unlinkSync(OUT);
        } catch (err) {
            throw new Error('旧产物被占用，请先关闭正在运行的 FolderLinker.exe');
        }
    }
    run(process.execPath, [PKG_BIN, '.', '--targets', 'node22-win-x64', '--output', 'dist/FolderLinker.exe', '--compress', 'Brotli'], {
        env: Object.assign({}, process.env, {PKG_NODE_PATH: base})
    });

    console.log('[4/4] 修正子系统（去掉控制台窗口）');
    run(process.execPath, [path.join(__dirname, 'patch-subsystem.js'), OUT]);

    const size = Math.round(fs.statSync(OUT).size / 1024 / 1024 * 10) / 10;
    console.log('构建完成：' + OUT + '（' + size + ' MB）');
}

try {
    main();
} catch (err) {
    console.error('构建失败：' + err.message);
    process.exit(1);
}
