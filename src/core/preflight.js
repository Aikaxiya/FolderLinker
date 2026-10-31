'use strict';

const fs = require('fs');
const path = require('path');
const {toLong, isSubPath, isSamePath, isReparse, volumeSpace, formatBytes} = require('./paths');
const {scan} = require('./scan');

const MIN_EXTRA_BYTES = 100 * 1024 * 1024;
const SAFETY_FACTOR = 1.05;

/**
 * 检查路径是不是系统关键目录
 * 整棵子树都不许动的、只禁止目录本身的、以及允许但需要提示风险的，分三档
 * @param {string} src 路径（绝对路径）
 * @param {'source'|'target'} [role] 这侧是源还是目标，只影响文案
 * @returns {{errors:string[],warnings:string[]}} 检查结果
 */
function checkProtectedPath(src, role = 'source') {
    const errors = [];
    const warnings = [];
    const abs = path.resolve(src);
    const root = path.parse(abs).root;
    const env = process.env;
    const verb = role === 'target' ? '不能把数据放在' : '不能迁移';

    if (abs.toLowerCase() === root.toLowerCase()) {
        errors.push(verb + '整个磁盘分区：' + abs + '（请选择分区里的具体文件夹）');
        return {errors, warnings};
    }

    const trees = [
        {p: env.SystemRoot, label: 'Windows 系统目录'},
        {p: path.join(root, 'System Volume Information'), label: '系统卷信息目录'},
        {p: path.join(root, '$Recycle.Bin'), label: '回收站'},
        {p: path.join(root, 'Recovery'), label: '系统恢复目录'},
        {p: path.join(root, 'Boot'), label: '启动目录'}
    ];
    for (const item of trees) {
        if (!item.p) {
            continue;
        }
        if (isSamePath(abs, item.p) || isSubPath(item.p, abs)) {
            errors.push(verb + item.label + '：' + abs + '（属于系统保护范围）');
        }
    }

    const exact = [
        {p: path.join(root, 'Users'), label: '用户目录根'},
        {p: env.USERPROFILE, label: '当前用户的主目录'},
        {p: env.ProgramData, label: 'ProgramData'},
        {p: env.ProgramFiles, label: 'Program Files'},
        {p: env['ProgramFiles(x86)'], label: 'Program Files (x86)'}
    ];
    for (const item of exact) {
        if (!item.p) {
            continue;
        }
        if (isSamePath(abs, item.p)) {
            errors.push(verb + item.label + '：' + item.p + '（可以选它下面的具体文件夹）');
        }
    }

    const risky = [
        {p: env.ProgramFiles, label: 'Program Files'},
        {p: env['ProgramFiles(x86)'], label: 'Program Files (x86)'}
    ];
    for (const item of risky) {
        if (!item.p) {
            continue;
        }
        if (isSubPath(item.p, abs)) {
            warnings.push('目录位于 ' + item.label + ' 下，迁移后该程序可能无法升级或卸载：' + abs);
        }
    }

    return {errors, warnings};
}

/**
 * 迁移前预检，全部为只读操作
 * @param {string} source 源目录
 * @param {string} target 目标父目录
 * @param {{withScan?:boolean,onProgress?:Function}} [options] 选项
 * @returns {Promise<object>} 预检结果
 */
async function preflight(source, target, options = {}) {
    const withScan = options.withScan !== false;
    const onProgress = options.onProgress || null;
    const errors = [];
    const warnings = [];

    if (!source || !target) {
        return {ok: false, errors: ['请先选择源文件夹和目标文件夹'], warnings};
    }

    const src = path.resolve(source);
    const dstRoot = path.resolve(target);

    if (!fs.existsSync(toLong(src))) {
        errors.push('源文件夹不存在：' + src);
    } else if (!fs.statSync(toLong(src)).isDirectory()) {
        errors.push('源路径不是文件夹：' + src);
    } else if (isReparse(src)) {
        errors.push('源路径本身已是联接或符号链接，请勿重复迁移：' + src);
    }

    const guarded = checkProtectedPath(src, 'source');
    errors.push.apply(errors, guarded.errors);
    warnings.push.apply(warnings, guarded.warnings);

    if (!fs.existsSync(toLong(dstRoot))) {
        errors.push('目标文件夹不存在：' + dstRoot);
    } else if (!fs.statSync(toLong(dstRoot)).isDirectory()) {
        errors.push('目标路径不是文件夹：' + dstRoot);
    } else if (isReparse(dstRoot)) {
        errors.push('目标路径是联接，请选择真实目录：' + dstRoot);
    }

    if (errors.length > 0) {
        return {ok: false, errors, warnings, source: src, target: dstRoot};
    }

    if (isSamePath(src, dstRoot)) {
        errors.push('源文件夹与目标文件夹不能相同');
    }
    if (isSubPath(src, dstRoot)) {
        errors.push('目标文件夹不能位于源文件夹内部');
    }
    if (isSubPath(dstRoot, src)) {
        errors.push('源文件夹不能位于目标文件夹内部');
    }

    const dest = path.join(dstRoot, path.basename(src));
    if (fs.existsSync(toLong(dest))) {
        errors.push('目标位置已存在同名项：' + dest);
    }

    let stats = {files: 0, bytes: 0, dirs: 0, entries: new Map(), skipped: []};
    if (withScan && errors.length === 0) {
        stats = await scan(src, {onProgress});
    }

    const space = volumeSpace(dstRoot);
    const required = Math.ceil(stats.bytes * SAFETY_FACTOR) + MIN_EXTRA_BYTES;
    if (space && space.free < required) {
        errors.push(
            '目标盘空间不足：需要约 ' + formatBytes(required) + '，当前可用 ' + formatBytes(space.free)
        );
    }

    if (stats.skipped.length > 0) {
        warnings.push('源目录内含 ' + stats.skipped.length + ' 个联接或无法访问的项，将不会迁移');
    }
    if (stats.files === 0) {
        warnings.push('源文件夹为空，迁移后联接将指向空目录');
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
        source: src,
        target: dstRoot,
        dest,
        stats: {
            files: stats.files,
            dirs: stats.dirs,
            bytes: stats.bytes,
            skipped: stats.skipped.length
        },
        scanResult: stats,
        free: space ? space.free : null
    };
}

module.exports = {preflight, checkProtectedPath, MIN_EXTRA_BYTES, SAFETY_FACTOR};
