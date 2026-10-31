'use strict';

const fs = require('fs');
const path = require('path');
const {toLong} = require('./paths');
const {copyTree} = require('./copy');
const {scan} = require('./scan');
const {verify} = require('./verify');
const {isJunction, readJunctionTarget, removeJunction, createJunction} = require('./link');

/**
 * 判断两个路径是否位于同一卷
 * @param {string} a 路径一
 * @param {string} b 路径二
 * @returns {boolean} 是否同卷
 */
function sameVolume(a, b) {
    return path.parse(path.resolve(a)).root.toLowerCase() === path.parse(path.resolve(b)).root.toLowerCase();
}

/**
 * 撤销一次迁移：删除联接并把数据搬回原路径
 * @param {{source:string,target:string}} record 迁移记录
 * @returns {Promise<{files:number,bytes:number}>} 搬回统计
 */
async function undoRecord(record) {
    const src = path.resolve(record.source);
    const dest = path.resolve(record.target);

    if (!fs.existsSync(toLong(src))) {
        throw new Error('原路径不存在，无法撤销');
    }
    if (!isJunction(src)) {
        throw new Error('原路径已不是联接，可能已被手动修改，已中止');
    }
    const target = readJunctionTarget(src);
    if (!target || path.resolve(target).toLowerCase() !== dest.toLowerCase()) {
        throw new Error('联接指向与记录不一致，已中止');
    }
    if (!fs.existsSync(toLong(dest))) {
        throw new Error('目标目录不存在，无法撤销');
    }

    removeJunction(src);

    try {
        if (sameVolume(src, dest)) {
            fs.renameSync(toLong(dest), toLong(src));
            return {files: 0, bytes: 0, mode: 'rename'};
        }
        const srcScan = await scan(dest);
        const copied = await copyTree(dest, src, {});
        const check = await verify(dest, srcScan, src, {strict: false});
        if (!check.ok) {
            throw new Error('搬回校验失败：' + check.errors.slice(0, 2).join('；'));
        }
        await fs.promises.rm(toLong(dest), {recursive: true, force: true, maxRetries: 3});
        return {files: copied.files, bytes: copied.bytes, mode: 'copy'};
    } catch (err) {
        try {
            if (!isJunction(src) && !fs.existsSync(toLong(src))) {
                createJunction(src, dest);
            }
        } catch (restoreErr) {
            throw new Error('撤销失败且联接恢复失败，请手动处理：' + restoreErr.message);
        }
        throw err;
    }
}

module.exports = {undoRecord, sameVolume};
