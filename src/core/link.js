'use strict';

const fs = require('fs');
const path = require('path');
const {toLong, toDisplay} = require('./paths');

/**
 * 在指定路径创建指向目标的目录联接
 * @param {string} linkPath 联接所在路径
 * @param {string} target 目标目录
 */
function createJunction(linkPath, target) {
    fs.symlinkSync(path.resolve(target), path.resolve(linkPath), 'junction');
}

/**
 * 判断路径是否为目录联接
 * @param {string} p 路径
 * @returns {boolean} 是否为联接
 */
function isJunction(p) {
    try {
        return fs.lstatSync(toLong(p)).isSymbolicLink();
    } catch (err) {
        return false;
    }
}

/**
 * 读取联接指向的目标
 * @param {string} p 联接路径
 * @returns {string|null} 目标路径，失败返回 null
 */
function readJunctionTarget(p) {
    try {
        return toDisplay(fs.readlinkSync(toLong(p)));
    } catch (err) {
        return null;
    }
}

/**
 * 删除联接本身，不触碰目标内容
 * @param {string} p 联接路径
 */
function removeJunction(p) {
    const long = toLong(p);
    const st = fs.lstatSync(long);
    if (!st.isSymbolicLink()) {
        throw new Error('该路径不是联接，拒绝删除：' + p);
    }
    fs.unlinkSync(long);
}

/**
 * 穿透联接读取文件，验证联接是否可用
 * @param {string} linkPath 联接路径
 * @param {string} relFile 相对文件路径
 * @param {number} expectedSize 期望字节数
 * @returns {boolean} 是否可正常读取且大小一致
 */
function verifyThroughLink(linkPath, relFile, expectedSize) {
    try {
        const st = fs.statSync(toLong(path.join(linkPath, relFile)));
        return st.isFile() && st.size === expectedSize;
    } catch (err) {
        return false;
    }
}

module.exports = {
    createJunction,
    isJunction,
    readJunctionTarget,
    removeJunction,
    verifyThroughLink
};
