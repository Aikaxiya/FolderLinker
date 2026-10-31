'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {toLong} = require('./paths');

const APP_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'FolderLinker');
const JOURNAL_FILE = path.join(APP_DIR, 'journal.json');
const LOG_DIR = path.join(APP_DIR, 'logs');
const MAX_RECORDS = 100;

/**
 * 确保应用数据目录存在
 */
function ensureAppDir() {
    if (!fs.existsSync(APP_DIR)) {
        fs.mkdirSync(APP_DIR, {recursive: true});
    }
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, {recursive: true});
    }
}

/**
 * 读取全部记录
 * @returns {Array<object>} 记录列表
 */
function readAll() {
    try {
        const raw = fs.readFileSync(JOURNAL_FILE, 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        return [];
    }
}

/**
 * 写入全部记录
 * @param {Array<object>} records 记录列表
 */
function writeAll(records) {
    ensureAppDir();
    const list = records.slice(-MAX_RECORDS);
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(list, null, 2), 'utf8');
}

/**
 * 追加一条记录
 * @param {object} record 记录内容
 * @returns {object} 带 id 的完整记录
 */
function append(record) {
    const records = readAll();
    const entry = Object.assign(
        {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            time: new Date().toISOString()
        },
        record
    );
    records.push(entry);
    writeAll(records);
    return entry;
}

/**
 * 更新指定记录
 * @param {string} id 记录 id
 * @param {object} patch 待合并字段
 * @returns {object|null} 更新后的记录
 */
function update(id, patch) {
    const records = readAll();
    const index = records.findIndex((item) => item.id === id);
    if (index < 0) {
        return null;
    }
    records[index] = Object.assign({}, records[index], patch);
    writeAll(records);
    return records[index];
}

/**
 * 删除指定记录
 * @param {string} id 记录 id
 */
function remove(id) {
    const records = readAll().filter((item) => item.id !== id);
    writeAll(records);
}

/**
 * 写运行日志到文件
 * @param {string} text 日志内容
 */
function log(text) {
    try {
        ensureAppDir();
        const name = new Date().toISOString().slice(0, 10) + '.log';
        fs.appendFileSync(path.join(LOG_DIR, name), '[' + new Date().toISOString() + '] ' + text + '\r\n', 'utf8');
    } catch (err) {
        /* 日志失败不影响主流程 */
    }
}

module.exports = {
    APP_DIR,
    LOG_DIR,
    JOURNAL_FILE,
    ensureAppDir,
    readAll,
    append,
    update,
    remove,
    log
};
