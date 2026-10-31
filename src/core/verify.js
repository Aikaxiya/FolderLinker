'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {toLong, formatBytes} = require('./paths');
const {scan} = require('./scan');

const fsp = fs.promises;

/**
 * 计算文件 SHA-256
 * @param {string} file 文件路径
 * @returns {Promise<string>} 十六进制摘要
 */
function hashFile(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(toLong(file));
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * 校验目标副本与源目录是否一致
 * @param {string} srcRoot 源目录
 * @param {{files:number,bytes:number,entries:Map<string,number>}} srcScan 源扫描结果
 * @param {string} dstRoot 目标目录
 * @param {{strict?:boolean,onProgress?:Function,isCancelled?:Function}} [options] 选项
 * @returns {Promise<{ok:boolean,errors:Array<string>,checked:number}>} 校验结果
 */
async function verify(srcRoot, srcScan, dstRoot, options = {}) {
    const strict = Boolean(options.strict);
    const onProgress = options.onProgress || null;
    const isCancelled = options.isCancelled || (() => false);
    const errors = [];

    const dstScan = await scan(dstRoot, {
        onProgress: onProgress
            ? (p) => onProgress({phase: 'scan', files: p.files, bytes: p.bytes, current: p.current})
            : null
    });

    if (dstScan.files !== srcScan.files) {
        errors.push('文件数不一致：源 ' + srcScan.files + '，目标 ' + dstScan.files);
    }
    if (dstScan.bytes !== srcScan.bytes) {
        errors.push('总字节不一致：源 ' + formatBytes(srcScan.bytes) + '，目标 ' + formatBytes(dstScan.bytes));
    }

    let missing = 0;
    let sizeMismatch = 0;
    for (const [rel, size] of srcScan.entries) {
        if (isCancelled()) {
            return {ok: false, errors: ['操作已取消'], checked: 0};
        }
        const dstSize = dstScan.entries.get(rel);
        if (dstSize === undefined) {
            missing += 1;
            if (missing <= 5) {
                errors.push('目标缺少文件：' + rel);
            }
            continue;
        }
        if (dstSize !== size) {
            sizeMismatch += 1;
            if (sizeMismatch <= 5) {
                errors.push('文件大小不一致：' + rel);
            }
        }
    }
    if (missing > 5) {
        errors.push('目标共缺少 ' + missing + ' 个文件');
    }
    if (sizeMismatch > 5) {
        errors.push('共 ' + sizeMismatch + ' 个文件大小不一致');
    }

    if (strict && errors.length === 0) {
        let checked = 0;
        for (const rel of srcScan.entries.keys()) {
            if (isCancelled()) {
                return {ok: false, errors: ['操作已取消'], checked};
            }
            const srcHash = await hashFile(path.join(srcRoot, rel));
            const dstHash = await hashFile(path.join(dstRoot, rel));
            if (srcHash !== dstHash) {
                errors.push('内容哈希不一致：' + rel);
                if (errors.length > 20) {
                    break;
                }
            }
            checked += 1;
            if (onProgress && checked % 200 === 0) {
                onProgress({phase: 'hash', files: checked, total: srcScan.files, current: rel});
            }
        }
    }

    return {ok: errors.length === 0, errors, checked: srcScan.files};
}

module.exports = {verify, hashFile};
