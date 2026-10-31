'use strict';

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const {decodePng, encodePng, resizeArea} = require('./png-tools');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const MASTER = 1024;
const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'assets', 'icon', 'icon.html');
const OUT_ICO = path.join(ROOT, 'assets', 'app.ico');
const TMP = path.join(ROOT, 'assets', 'icon', 'tmp');

/**
 * 同步等待
 * @param {number} ms 毫秒
 */
function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 查找 Chromium 内核浏览器
 * @returns {string} 浏览器路径
 */
function findBrowser() {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean);
    for (const root of roots) {
        for (const rel of [
            ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
            ['Google', 'Chrome', 'Application', 'chrome.exe']
        ]) {
            const file = path.join(root, ...rel);
            if (fs.existsSync(file)) {
                return file;
            }
        }
    }
    throw new Error('未找到 Edge 或 Chrome，无法渲染图标');
}

/**
 * 渲染一张大尺寸母版（小尺寸会被系统最小窗口限制裁切，不能直接用）
 * @param {string} browser 浏览器路径
 * @param {string} html 图标页面
 * @param {string} name 输出文件名
 * @returns {string} 母版路径
 */
function renderMaster(browser, html, name) {
    const out = path.join(TMP, name);
    if (fs.existsSync(out)) {
        fs.unlinkSync(out);
    }
    const args = [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=' + path.join(TMP, 'profile'),
        '--default-background-color=00000000',
        '--window-size=' + MASTER + ',' + MASTER,
        '--screenshot=' + out,
        'file:///' + html.replace(/\\/g, '/')
    ];
    spawnSync(browser, args, {windowsHide: true, timeout: 60000});

    const deadline = Date.now() + 20000;
    let lastSize = -1;
    while (Date.now() < deadline) {
        if (fs.existsSync(out)) {
            const size = fs.statSync(out).size;
            if (size > 0 && size === lastSize) {
                return out;
            }
            lastSize = size;
        }
        sleep(120);
    }
    throw new Error('母版渲染超时：' + name);
}

/**
 * 把多张 PNG 打包成 ICO
 * @param {Array<{size:number,data:Buffer}>} images 图像列表
 * @returns {Buffer} ICO 内容
 */
function buildIco(images) {
    const count = images.length;
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(count, 4);

    const entries = [];
    let offset = 6 + count * 16;
    for (const image of images) {
        const entry = Buffer.alloc(16);
        entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
        entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
        entry.writeUInt8(0, 2);
        entry.writeUInt8(0, 3);
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(image.data.length, 8);
        entry.writeUInt32LE(offset, 12);
        offset += image.data.length;
        entries.push(entry);
    }

    return Buffer.concat([header, ...entries, ...images.map((item) => item.data)]);
}

function main() {
    const smallHtml = path.join(ROOT, 'assets', 'icon', 'icon-small.html');
    if (fs.existsSync(OUT_ICO)) {
        const icoTime = fs.statSync(OUT_ICO).mtimeMs;
        const newest = Math.max(fs.statSync(HTML).mtimeMs, fs.statSync(smallHtml).mtimeMs);
        if (icoTime > newest) {
            console.log('图标已是最新，跳过生成：' + OUT_ICO);
            return;
        }
    }

    const browser = findBrowser();
    fs.mkdirSync(TMP, {recursive: true});

    console.log('渲染母版 ' + MASTER + 'x' + MASTER + ' …');
    const bigMaster = decodePng(fs.readFileSync(renderMaster(browser, HTML, 'master-big.png')));
    const smallMaster = decodePng(
        fs.readFileSync(renderMaster(browser, smallHtml, 'master-small.png'))
    );
    console.log('  大图标母版 ' + bigMaster.width + 'x' + bigMaster.height + '，小图标母版 ' + smallMaster.width + 'x' + smallMaster.height);

    const images = [];
    for (const size of SIZES) {
        const master = size <= 32 ? smallMaster : bigMaster;
        const pixels = resizeArea(master, size, size);
        const png = encodePng(size, size, pixels);
        images.push({size, data: png});
        console.log('  ' + size + 'x' + size + '  ' + Math.round(png.length / 1024) + ' KB');
    }

    fs.writeFileSync(OUT_ICO, buildIco(images));
    for (const size of [16, 32, 256]) {
        const item = images.find((entry) => entry.size === size);
        fs.writeFileSync(path.join(TMP, 'preview-' + size + '.png'), item.data);
    }
    console.log('已生成 ' + OUT_ICO + '（' + Math.round(fs.statSync(OUT_ICO).size / 1024) + ' KB）');
}

main();
