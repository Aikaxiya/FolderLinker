'use strict';

const fs = require('fs');
const path = require('path');
const {toLong, formatBytes} = require('./paths');
const {preflight} = require('./preflight');
const {copyTree, CancelledError} = require('./copy');
const {verify} = require('./verify');
const {createJunction, removeJunction, verifyThroughLink} = require('./link');
const journal = require('./journal');

const fsp = fs.promises;

/**
 * 判断路径是否存在
 * @param {string} p 路径
 * @returns {boolean} 是否存在
 */
function exists(p) {
    try {
        fs.lstatSync(toLong(p));
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * 递归删除目录
 * @param {string} p 目录路径
 */
async function removeDir(p) {
    await fsp.rm(toLong(p), {recursive: true, force: true, maxRetries: 3});
}

/**
 * 带重试的目录改名
 * 占用经常是瞬时的（比如某个程序正在写目录里的日志），重试几次往往就过了
 * @param {string} from 原路径
 * @param {string} to 新路径
 * @param {number} [attempts] 最多尝试次数
 * @returns {Promise<void>} 改名结果
 */
async function renameWithRetry(from, to, attempts = 3) {
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
        try {
            fs.renameSync(toLong(from), toLong(to));
            return;
        } catch (err) {
            lastError = err;
            if (err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'EBUSY') {
                throw err;
            }
            if (i < attempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }
    }
    throw lastError;
}

/**
 * 单次迁移任务
 */
class Job {
    /**
     * @param {{source:string,target:string,strict:boolean}} options 任务参数
     */
    constructor(options) {
        this.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        this.source = options.source;
        this.target = options.target;
        this.strict = Boolean(options.strict);
        this.cancelled = false;
        this.finished = false;
        this.events = [];
        this.listeners = new Set();
        this.state = {
            id: this.id,
            phase: 'idle',
            message: '等待开始',
            files: 0,
            bytes: 0,
            totalFiles: 0,
            totalBytes: 0,
            current: '',
            errors: [],
            warnings: [],
            result: null
        };
    }

    /**
     * 推送事件给所有订阅者
     * @param {object} patch 状态增量
     */
    emit(patch) {
        Object.assign(this.state, patch);
        const payload = Object.assign({ts: Date.now()}, this.state);
        this.events.push(payload);
        if (this.events.length > 400) {
            this.events.shift();
        }
        for (const fn of this.listeners) {
            try {
                fn(payload);
            } catch (err) {
                /* 忽略订阅者异常 */
            }
        }
    }

    /**
     * 订阅任务事件
     * @param {Function} fn 回调
     * @returns {Function} 取消订阅函数
     */
    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /**
     * 请求取消任务
     */
    cancel() {
        this.cancelled = true;
    }

    /**
     * 执行迁移全流程
     * @returns {Promise<object>} 最终状态
     */
    async run() {
        const src = path.resolve(this.source);
        const dstRoot = path.resolve(this.target);
        const dest = path.join(dstRoot, path.basename(src));
        const bak = src + '.__bak_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        let linkCreated = false;
        let destCreated = false;
        let record = null;

        try {
            this.emit({phase: 'preflight', message: '正在检查目录…'});
            const plan = await preflight(src, dstRoot, {
                withScan: true,
                onProgress: (p) => this.emit({phase: 'preflight', message: '正在统计文件…', current: p.current})
            });
            if (!plan.ok) {
                throw new Error(plan.errors.join('；'));
            }
            if (plan.warnings.length > 0) {
                this.emit({warnings: plan.warnings});
            }

            // 先探测能不能改名：被占用的目录要在复制几 GB 之前就拦下来，别让用户白等
            this.emit({phase: 'preflight', message: '正在确认目录可以改名…', current: ''});
            const probeName = src + '.__probe_' + Date.now();
            try {
                await renameWithRetry(src, probeName);
            } catch (err) {
                if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY') {
                    throw new Error(
                        '原目录正被其它程序占用，无法改名：' + src +
                        '。点源文件夹后面的「检查」按钮可以查出是哪个进程，结束它后重试；也可以关掉相关程序或重启电脑后再试。'
                    );
                }
                throw err;
            }
            try {
                fs.renameSync(toLong(probeName), toLong(src));
            } catch (err) {
                throw new Error('改名探测后无法还原，目录当前名为 ' + probeName + '，请手动改回 ' + src);
            }

            record = journal.append({
                source: src,
                target: dest,
                files: plan.stats.files,
                bytes: plan.stats.bytes,
                strict: this.strict,
                status: 'running'
            });

            this.emit({
                phase: 'copy',
                message: '正在复制文件',
                totalFiles: plan.stats.files,
                totalBytes: plan.stats.bytes,
                files: 0,
                bytes: 0
            });

            destCreated = true;
            await copyTree(src, dest, {
                isCancelled: () => this.cancelled,
                onProgress: (p) => {
                    this.emit({
                        phase: 'copy',
                        files: p.files,
                        bytes: p.bytes,
                        current: p.current,
                        message: '正在复制 ' + p.files + ' / ' + plan.stats.files + ' 个文件'
                    });
                }
            });

            if (this.cancelled) {
                throw new CancelledError();
            }

            this.emit({phase: 'verify', message: '正在校验副本…', current: ''});
            const check = await verify(src, plan.scanResult, dest, {
                strict: this.strict,
                isCancelled: () => this.cancelled,
                onProgress: (p) => this.emit({phase: 'verify', message: '正在校验…', current: p.current})
            });
            if (!check.ok) {
                throw new Error('校验未通过：' + check.errors.slice(0, 3).join('；'));
            }

            if (this.cancelled) {
                throw new CancelledError();
            }

            this.emit({phase: 'swap', message: '正在替换原目录…'});
            try {
                await renameWithRetry(src, bak);
            } catch (err) {
                if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY') {
                    throw new Error(
                        '原目录正被其它程序占用，无法改名：' + src +
                        '。点源文件夹后面的「检查」按钮可以查出是哪个进程，结束它后重试；已复制的内容已清理，原目录未改动。'
                    );
                }
                throw err;
            }

            try {
                createJunction(src, dest);
                linkCreated = true;
            } catch (err) {
                fs.renameSync(toLong(bak), toLong(src));
                throw new Error('创建联接失败：' + (err.message || err));
            }

            this.emit({phase: 'check', message: '正在验证联接…'});
            const probe = plan.scanResult.entries.size > 0 ? plan.scanResult.entries.keys().next().value : null;
            if (probe) {
                const expected = plan.scanResult.entries.get(probe);
                if (!verifyThroughLink(src, probe, expected)) {
                    removeJunction(src);
                    linkCreated = false;
                    fs.renameSync(toLong(bak), toLong(src));
                    throw new Error('联接验证失败，已还原原目录');
                }
            }

            this.emit({phase: 'cleanup', message: '正在清理备份…'});
            await removeDir(bak);

            const summary = {
                source: src,
                target: dest,
                files: plan.stats.files,
                bytes: plan.stats.bytes,
                bytesText: formatBytes(plan.stats.bytes),
                strict: this.strict
            };
            if (record) {
                journal.update(record.id, {status: 'done', finishedAt: new Date().toISOString()});
            }
            journal.log('迁移完成 ' + src + ' -> ' + dest + '，' + plan.stats.files + ' 文件 / ' + summary.bytesText);
            this.finished = true;
            this.emit({phase: 'done', message: '迁移完成', result: summary, current: ''});
            return this.state;
        } catch (err) {
            const cancelled = err instanceof CancelledError || this.cancelled;
            let rollbackError = null;

            try {
                if (linkCreated && exists(src)) {
                    removeJunction(src);
                    linkCreated = false;
                }
                if (exists(bak) && !exists(src)) {
                    fs.renameSync(toLong(bak), toLong(src));
                }
            } catch (rollbackErr) {
                rollbackError = rollbackErr.message || String(rollbackErr);
            }

            if (destCreated && exists(dest) && exists(src)) {
                try {
                    await removeDir(dest);
                } catch (cleanupErr) {
                    rollbackError = rollbackError || cleanupErr.message;
                }
            }

            const message = cancelled ? '已取消，原始目录未改动' : err.message || String(err);
            const notes = [];
            if (rollbackError) {
                notes.push('回滚异常：' + rollbackError);
            }
            if (!exists(src) && exists(bak)) {
                // 原目录没回到原位：副本和 .__bak 都可能装着完整数据，保留并如实报出来
                notes.push('原目录当前名为 ' + bak + '，完整副本保留在 ' + dest + '，请手动确认后再处理');
            }
            if (record) {
                journal.update(record.id, {
                    status: cancelled ? 'cancelled' : 'failed',
                    finishedAt: new Date().toISOString(),
                    error: message
                });
            }
            journal.log((cancelled ? '取消 ' : '失败 ') + src + '：' + message + (notes.length ? ' | ' + notes.join(' | ') : ''));
            this.finished = true;
            this.emit({
                phase: cancelled ? 'cancelled' : 'failed',
                message,
                errors: [message].concat(notes),
                result: null
            });
            return this.state;
        }
    }
}

module.exports = {Job};
