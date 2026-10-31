'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const {startServer} = require('../src/server');
const {isJunction, readJunctionTarget} = require('../src/core/link');

const TMP = path.join(os.tmpdir(), 'folder-linker-e2e');
const SRC = path.join(TMP, 'demo-folder');
const TGT = 'D:\\test\\fl-e2e-target';
const DEST = path.join(TGT, 'demo-folder');

/**
 * 发送 JSON 请求
 * @param {number} port 端口
 * @param {string} pathname 路径
 * @param {object} body 请求体
 * @returns {Promise<object>} 响应
 */
function post(port, pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(body || {}));
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: pathname,
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'Content-Length': payload.length}
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    try {
                        resolve({status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8'))});
                    } catch (err) {
                        reject(new Error('响应解析失败'));
                    }
                });
            }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

/**
 * 等待任务结束
 * @param {number} port 端口
 * @param {string} jobId 任务 id
 * @returns {Promise<object>} 最终状态
 */
function waitJob(port, jobId) {
    return new Promise((resolve, reject) => {
        const req = http.get({host: '127.0.0.1', port, path: '/api/events?job=' + jobId}, (res) => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                buf += chunk;
                const blocks = buf.split('\n\n');
                buf = blocks.pop();
                for (const block of blocks) {
                    const line = block.split('\n').find((l) => l.startsWith('data: '));
                    if (!line) {
                        continue;
                    }
                    let data;
                    try {
                        data = JSON.parse(line.slice(6));
                    } catch (err) {
                        continue;
                    }
                    if (data.phase === 'done' || data.phase === 'failed' || data.phase === 'cancelled') {
                        req.destroy();
                        resolve(data);
                    }
                }
            });
        });
        req.on('error', (err) => {
            if (err.code !== 'ECONNRESET') {
                reject(err);
            }
        });
    });
}

/**
 * 生成测试数据
 */
function makeFixture() {
    fs.rmSync(TMP, {recursive: true, force: true});
    fs.rmSync(TGT, {recursive: true, force: true});
    fs.mkdirSync(path.join(SRC, 'nested', 'deep'), {recursive: true});
    fs.mkdirSync(path.join(SRC, 'empty-dir'), {recursive: true});
    for (let i = 0; i < 12; i += 1) {
        fs.writeFileSync(path.join(SRC, 'file-' + i + '.bin'), crypto.randomBytes(1024 * (i + 1)));
    }
    fs.writeFileSync(path.join(SRC, 'nested', 'note.txt'), '中文内容测试\nsecond line\n', 'utf8');
    fs.writeFileSync(path.join(SRC, 'nested', 'deep', 'deep.txt'), 'deep file', 'utf8');
    fs.writeFileSync(path.join(SRC, '空 格 文件.txt'), 'spaces', 'utf8');
    fs.mkdirSync(TGT, {recursive: true});
}

/**
 * 统计目录内容摘要
 * @param {string} dir 目录
 * @returns {{files:number,bytes:number,hash:string}} 摘要
 */
function digest(dir) {
    const files = [];
    const stack = [''];
    while (stack.length) {
        const rel = stack.pop();
        const abs = rel ? path.join(dir, rel) : dir;
        for (const item of fs.readdirSync(abs, {withFileTypes: true})) {
            const childRel = rel ? path.join(rel, item.name) : item.name;
            if (item.isDirectory()) {
                stack.push(childRel);
            } else {
                files.push(childRel);
            }
        }
    }
    files.sort();
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for (const rel of files) {
        const buf = fs.readFileSync(path.join(dir, rel));
        bytes += buf.length;
        hash.update(rel);
        hash.update(buf);
    }
    return {files: files.length, bytes, hash: hash.digest('hex')};
}

/**
 * 断言
 * @param {boolean} cond 条件
 * @param {string} msg 说明
 */
function assert(cond, msg) {
    if (!cond) {
        throw new Error('断言失败：' + msg);
    }
    console.log('  ✓ ' + msg);
}

async function main() {
    const portArg = process.argv.find((arg) => arg.startsWith('--port='));
    console.log('[1] 准备测试数据');
    makeFixture();
    const before = digest(SRC);
    console.log('  源目录：' + before.files + ' 文件 / ' + before.bytes + ' 字节');

    let server = null;
    let port;
    if (portArg) {
        port = Number(portArg.split('=')[1]);
        console.log('[2] 使用已运行的服务，端口 ' + port);
    } else {
        server = await startServer({});
        port = server.address().port;
        console.log('[2] 服务已启动，端口 ' + port);
    }

    console.log('[3] 预检');
    const plan = await post(port, '/api/plan', {source: SRC, target: TGT});
    assert(plan.status === 200 && plan.data.ok === true, '预检通过');
    assert(plan.data.dest === DEST, '目标路径计算正确');
    assert(plan.data.stats.files === before.files, '预检文件数与实际一致');

    console.log('[4] 执行迁移');
    const started = await post(port, '/api/run', {source: SRC, target: TGT, strict: true});
    assert(started.status === 200 && Boolean(started.data.id), '任务已创建');
    const final = await waitJob(port, started.data.id);
    assert(final.phase === 'done', '任务状态为 done');

    console.log('[5] 验证结果');
    assert(isJunction(SRC), '原路径已变为目录联接');
    assert(path.resolve(readJunctionTarget(SRC)).toLowerCase() === DEST.toLowerCase(), '联接指向目标目录');
    assert(fs.existsSync(path.join(SRC, 'nested', 'note.txt')), '可通过联接读到文件');
    const after = digest(SRC);
    assert(after.files === before.files, '文件数一致（' + after.files + '）');
    assert(after.bytes === before.bytes, '总字节一致（' + after.bytes + '）');
    assert(after.hash === before.hash, '内容哈希完全一致');
    assert(fs.existsSync(DEST), '目标目录存在');
    const baks = fs.readdirSync(TMP).filter((n) => n.includes('__bak_'));
    assert(baks.length === 0, '备份目录已清理');

    console.log('[6] 撤销');
    const list = await post(port, '/api/journal', {});
    const rec = list.data.records.find((r) => r.status === 'done');
    assert(Boolean(rec), '存在已完成记录');
    const undone = await post(port, '/api/undo', {id: rec.id});
    assert(undone.status === 200 && undone.data.ok === true, '撤销接口返回成功');
    assert(!isJunction(SRC), '原路径恢复为普通目录');
    const restored = digest(SRC);
    assert(restored.hash === before.hash, '撤销后内容与原始完全一致');
    assert(!fs.existsSync(DEST), '目标副本已清理');

    console.log('[7] 清理测试数据');
    fs.rmSync(TMP, {recursive: true, force: true});
    fs.rmSync(TGT, {recursive: true, force: true});
    if (server) {
        server.close();
    }
    console.log('\n全部通过');
}

main().catch((err) => {
    console.error('\n测试失败：' + (err.stack || err.message));
    process.exitCode = 1;
});
