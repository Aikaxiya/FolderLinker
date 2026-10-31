'use strict';

const fs = require('fs');
const path = require('path');

const LONG_PREFIX = '\\\\?\\';

/**
 * 转换为支持长路径（>260）的绝对路径形式
 * @param {string} p 原始路径
 * @returns {string} 带 \\?\ 前缀的绝对路径
 */
function toLong(p) {
    if (!p) {
        return p;
    }
    if (p.startsWith(LONG_PREFIX)) {
        return p;
    }
    const abs = path.resolve(p);
    if (abs.startsWith('\\\\')) {
        return LONG_PREFIX + 'UNC\\' + abs.slice(2);
    }
    return LONG_PREFIX + abs;
}

/**
 * 去掉长路径前缀，用于界面展示
 * @param {string} p 路径
 * @returns {string} 普通路径
 */
function toDisplay(p) {
    if (!p) {
        return p;
    }
    return p.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
}

/**
 * 判断 child 是否位于 parent 内部（不含相等）
 * @param {string} parent 父路径
 * @param {string} child 子路径
 * @returns {boolean} 是否为其子路径
 */
function isSubPath(parent, child) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    if (!rel) {
        return false;
    }
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 判断两个路径是否指向同一位置
 * @param {string} a 路径一
 * @param {string} b 路径二
 * @returns {boolean} 是否相同
 */
function isSamePath(a, b) {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * 判断路径是否为重解析点（联接或符号链接）
 * @param {string} p 路径
 * @returns {boolean} 是否为重解析点
 */
function isReparse(p) {
    try {
        return fs.lstatSync(toLong(p)).isSymbolicLink();
    } catch (err) {
        return false;
    }
}

/**
 * 读取卷的可用空间与总容量
 * @param {string} p 卷内任意路径
 * @returns {{free:number,total:number}|null} 空间信息，失败返回 null
 */
function volumeSpace(p) {
    try {
        const root = path.parse(path.resolve(p)).root;
        const st = fs.statfsSync(root);
        return {free: st.bavail * st.bsize, total: st.blocks * st.bsize};
    } catch (err) {
        return null;
    }
}

/**
 * 确保目录存在
 * @param {string} p 目录路径
 */
async function ensureDir(p) {
    await fs.promises.mkdir(toLong(p), {recursive: true});
}

/**
 * 格式化字节数为可读文本
 * @param {number} bytes 字节数
 * @returns {string} 如 2.57 GB
 */
function formatBytes(bytes) {
    if (!bytes || bytes < 0) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    const digits = value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2;
    return value.toFixed(digits) + ' ' + units[index];
}

module.exports = {
    toLong,
    toDisplay,
    isSubPath,
    isSamePath,
    isReparse,
    volumeSpace,
    ensureDir,
    formatBytes
};
