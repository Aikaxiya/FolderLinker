'use strict';

const fs = require('fs');
const path = require('path');
const {toLong} = require('./paths');

const fsp = fs.promises;

class CancelledError extends Error {
    constructor() {
        super('操作已取消');
        this.name = 'CancelledError';
        this.cancelled = true;
    }
}

/**
 * 递归复制目录，保留文件时间戳，不跟随重解析点
 * @param {string} srcRoot 源根目录
 * @param {string} dstRoot 目标根目录
 * @param {{onProgress?:Function,isCancelled?:Function}} [options] 选项
 * @returns {Promise<{files:number,bytes:number,skipped:Array}>} 复制统计
 */
async function copyTree(srcRoot, dstRoot, options = {}) {
    const onProgress = options.onProgress || null;
    const isCancelled = options.isCancelled || (() => false);
    const stats = {files: 0, bytes: 0, skipped: []};
    const stack = [''];
    let lastEmit = 0;

    while (stack.length > 0) {
        if (isCancelled()) {
            throw new CancelledError();
        }
        const rel = stack.pop();
        const srcAbs = rel ? path.join(srcRoot, rel) : srcRoot;
        const dstAbs = rel ? path.join(dstRoot, rel) : dstRoot;
        await fsp.mkdir(toLong(dstAbs), {recursive: true});

        let list;
        try {
            list = await fsp.readdir(toLong(srcAbs), {withFileTypes: true});
        } catch (err) {
            throw new Error('无法读取源目录 ' + srcAbs + '：' + (err.code || err.message));
        }

        for (const item of list) {
            if (isCancelled()) {
                throw new CancelledError();
            }
            const childRel = rel ? path.join(rel, item.name) : item.name;
            const srcFile = path.join(srcRoot, childRel);
            const dstFile = path.join(dstRoot, childRel);
            if (item.isSymbolicLink()) {
                stats.skipped.push({rel: childRel, reason: 'REPARSE'});
                continue;
            }
            if (item.isDirectory()) {
                stack.push(childRel);
                continue;
            }
            if (!item.isFile()) {
                continue;
            }
            try {
                await fsp.copyFile(toLong(srcFile), toLong(dstFile));
                const st = await fsp.stat(toLong(srcFile));
                await fsp.utimes(toLong(dstFile), st.atime, st.mtime);
                stats.files += 1;
                stats.bytes += st.size;
            } catch (err) {
                throw new Error('复制失败 ' + srcFile + '：' + (err.code || err.message));
            }
            const now = Date.now();
            if (onProgress && now - lastEmit > 120) {
                lastEmit = now;
                onProgress({files: stats.files, bytes: stats.bytes, current: childRel});
            }
        }
    }

    if (onProgress) {
        onProgress({files: stats.files, bytes: stats.bytes, current: ''});
    }
    return stats;
}

module.exports = {copyTree, CancelledError};
