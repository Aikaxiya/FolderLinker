'use strict';

const fs = require('fs');
const path = require('path');
const {toLong} = require('./paths');

const fsp = fs.promises;

/**
 * 递归扫描目录，统计文件数、字节数与相对路径集合
 * 不跟随重解析点，避免循环
 * @param {string} root 根目录
 * @param {{onProgress?:Function}} [options] 选项
 * @returns {Promise<{files:number,dirs:number,bytes:number,entries:Map<string,number>,skipped:Array}>} 扫描结果
 */
async function scan(root, options = {}) {
    const onProgress = options.onProgress || null;
    const result = {
        files: 0,
        dirs: 0,
        bytes: 0,
        entries: new Map(),
        skipped: []
    };
    const stack = [''];
    let tick = 0;

    while (stack.length > 0) {
        const rel = stack.pop();
        const abs = rel ? path.join(root, rel) : root;
        let list;
        try {
            list = await fsp.readdir(toLong(abs), {withFileTypes: true});
        } catch (err) {
            result.skipped.push({rel, reason: err.code || err.message});
            continue;
        }
        for (const item of list) {
            const childRel = rel ? path.join(rel, item.name) : item.name;
            const childAbs = path.join(root, childRel);
            if (item.isSymbolicLink()) {
                result.skipped.push({rel: childRel, reason: 'REPARSE'});
                continue;
            }
            if (item.isDirectory()) {
                result.dirs += 1;
                stack.push(childRel);
                continue;
            }
            if (!item.isFile()) {
                continue;
            }
            try {
                const st = await fsp.stat(toLong(childAbs));
                result.files += 1;
                result.bytes += st.size;
                result.entries.set(childRel, st.size);
            } catch (err) {
                result.skipped.push({rel: childRel, reason: err.code || err.message});
            }
            tick += 1;
            if (onProgress && tick % 400 === 0) {
                onProgress({files: result.files, bytes: result.bytes, current: childRel});
            }
        }
    }
    return result;
}

module.exports = {scan};
