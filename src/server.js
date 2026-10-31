'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {Job} = require('./core/job');
const journal = require('./core/journal');
const {preflight, checkProtectedPath} = require('./core/preflight');
const {undoRecord} = require('./core/undo');
const {isJunction, readJunctionTarget} = require('./core/link');
const {findHolders} = require('./core/handles');
const {volumeSpace, formatBytes, isReparse} = require('./core/paths');

const UI_DIR = path.join(__dirname, 'ui');
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

const jobs = new Map();
const PING_TIMEOUT_MS = 10 * 60 * 1000;
let lastPing = 0;
let pingSeen = false;
let onShutdown = null;

/**
 * 是否有迁移任务正在执行
 * @returns {boolean} 有未结束的任务返回 true
 */
function hasRunningJob() {
    for (const job of jobs.values()) {
        if (!job.finished) {
            return true;
        }
    }
    return false;
}

/**
 * 读取请求体 JSON
 * @param {http.IncomingMessage} req 请求
 * @returns {Promise<object>} 解析后的对象
 */
function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 1024 * 1024) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (chunks.length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (err) {
                reject(new Error('请求格式错误'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * 返回 JSON 响应
 * @param {http.ServerResponse} res 响应对象
 * @param {number} code 状态码
 * @param {object} data 数据
 */
function sendJson(res, code, data) {
    const body = JSON.stringify(data);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

/**
 * 弹出系统文件夹选择对话框
 * @param {string} initial 初始目录
 * @returns {Promise<string|null>} 选中的路径，取消返回 null
 */
function pickFolder(initial) {
    const safeInitial = String(initial || '').replace(/'/g, "''");
    const script = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$owner = New-Object System.Windows.Forms.Form',
        "$owner.Text = 'FolderLinker'",
        "$owner.FormBorderStyle = 'None'",
        '$owner.ShowInTaskbar = $false',
        "$owner.StartPosition = 'CenterScreen'",
        '$owner.Size = New-Object System.Drawing.Size(1, 1)',
        '$owner.MinimumSize = New-Object System.Drawing.Size(1, 1)',
        '$owner.BackColor = [System.Drawing.Color]::Black',
        '$owner.Opacity = 0',
        '$owner.TopMost = $true',
        '$owner.Show()',
        '$owner.Activate()',
        '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$dlg.Description = '请选择文件夹'",
        '$dlg.ShowNewFolderButton = $true'
    ];

    if (safeInitial) {
        script.push("if (Test-Path -LiteralPath '" + safeInitial + "') { $dlg.SelectedPath = '" + safeInitial + "' }");
    }

    script.push(
        'try { $result = $dlg.ShowDialog($owner) } catch { $result = $dlg.ShowDialog() }',
        'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }',
        '$owner.Close()',
        '$owner.Dispose()'
    );

    const content = script.join('\r\n');
    const file = path.join(os.tmpdir(), 'folder-linker-pick-' + process.pid + '.ps1');
    fs.writeFileSync(file, '\uFEFF' + content, 'utf8');

    return new Promise((resolve) => {
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', file],
            {windowsHide: true}
        );
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => {
            out += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
            err += chunk.toString('utf8');
        });
        child.on('close', (code) => {
            try {
                fs.unlinkSync(file);
            } catch (unlinkErr) {
                /* 临时文件清理失败可忽略 */
            }
            const value = out.trim();
            if (!value && err.trim()) {
                journal.log('选择文件夹失败（退出码 ' + code + '）：' + err.trim().slice(0, 500));
            }
            resolve(value || null);
        });
        child.on('error', () => resolve(null));
    });
}

/**
 * 展开路径中的 %ENV% 环境变量
 * @param {string} value 原始路径
 * @returns {string} 展开后的路径
 */
function expandPath(value) {
    if (!value) {
        return value;
    }
    return String(value).replace(/%([^%\\/]+)%/g, (match, name) => {
        const resolved = process.env[name];
        return resolved === undefined ? match : resolved;
    });
}

/**
 * 读取目录概况
 * @param {string} target 路径
 * @param {'source'|'target'} [role] 这侧是源还是目标
 * @returns {object} 概况信息
 */
function inspectPath(target, role) {
    if (!target) {
        return {exists: false};
    }
    const p = path.resolve(target);
    try {
        const st = fs.statSync(p);
        const space = volumeSpace(p);
        return {
            exists: true,
            path: p,
            isDir: st.isDirectory(),
            isReparse: isReparse(p),
            junctionTarget: isJunction(p) ? readJunctionTarget(p) : null,
            free: space ? space.free : null,
            freeText: space ? formatBytes(space.free) : '',
            drive: path.parse(p).root,
            guarded: st.isDirectory() ? checkProtectedPath(p, role) : null
        };
    } catch (err) {
        return {exists: false, path: p};
    }
}

/**
 * 启动本地服务
 * @param {{onReady?:Function}} [options] 选项
 * @returns {Promise<http.Server>} 服务实例
 */
function startServer(options = {}) {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const pathname = url.pathname;

        try {
            if (pathname === '/' || pathname === '/index.html') {
                const html = fs.readFileSync(path.join(UI_DIR, 'index.html'));
                res.writeHead(200, {'Content-Type': MIME['.html'], 'Cache-Control': 'no-store'});
                res.end(html);
                return;
            }
            if (pathname === '/style.css' || pathname === '/app.js') {
                const file = path.join(UI_DIR, pathname.slice(1));
                const body = fs.readFileSync(file);
                res.writeHead(200, {
                    'Content-Type': MIME[path.extname(file)],
                    'Cache-Control': 'no-store'
                });
                res.end(body);
                return;
            }

            if (pathname === '/favicon.ico') {
                const iconFile = path.join(UI_DIR, 'favicon.ico');
                if (!fs.existsSync(iconFile)) {
                    sendJson(res, 404, {error: '图标不存在'});
                    return;
                }
                const iconBody = fs.readFileSync(iconFile);
                res.writeHead(200, {
                    'Content-Type': MIME['.ico'],
                    'Cache-Control': 'public, max-age=31536000',
                    'Content-Length': iconBody.length
                });
                res.end(iconBody);
                return;
            }

            if (pathname.startsWith('/fonts/')) {
                const fontFile = path.join(UI_DIR, 'fonts', path.basename(pathname));
                if (!fs.existsSync(fontFile)) {
                    sendJson(res, 404, {error: '字体不存在'});
                    return;
                }
                const fontBody = fs.readFileSync(fontFile);
                res.writeHead(200, {
                    'Content-Type': 'font/woff2',
                    'Cache-Control': 'public, max-age=31536000',
                    'Content-Length': fontBody.length
                });
                res.end(fontBody);
                return;
            }

            if (pathname === '/api/ping') {
                lastPing = Date.now();
                pingSeen = true;
                sendJson(res, 200, {ok: true});
                return;
            }

            if (pathname === '/api/inspect') {
                const body = await readJson(req);
                sendJson(res, 200, inspectPath(expandPath(body.path), body.role === 'target' ? 'target' : 'source'));
                return;
            }

            if (pathname === '/api/pick') {
                const body = await readJson(req);
                const picked = await pickFolder(body.initial || '');
                sendJson(res, 200, {path: picked});
                return;
            }

            if (pathname === '/api/plan') {
                const body = await readJson(req);
                const plan = await preflight(expandPath(body.source), expandPath(body.target), {withScan: true});
                sendJson(res, 200, {
                    ok: plan.ok,
                    errors: plan.errors,
                    warnings: plan.warnings,
                    dest: plan.dest,
                    stats: plan.stats,
                    freeText: plan.free ? formatBytes(plan.free) : '',
                    bytesText: plan.stats ? formatBytes(plan.stats.bytes) : '0 B'
                });
                return;
            }

            if (pathname === '/api/run') {
                const body = await readJson(req);
                for (const job of jobs.values()) {
                    if (!job.finished) {
                        sendJson(res, 409, {error: '已有任务正在执行'});
                        return;
                    }
                }
                const job = new Job({
                    source: expandPath(body.source),
                    target: expandPath(body.target),
                    strict: Boolean(body.strict)
                });
                jobs.set(job.id, job);
                job.run();
                sendJson(res, 200, {id: job.id});
                return;
            }

            if (pathname === '/api/events') {
                const job = jobs.get(url.searchParams.get('job'));
                if (!job) {
                    sendJson(res, 404, {error: '任务不存在'});
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });
                const write = (payload) => {
                    res.write('data: ' + JSON.stringify(payload) + '\n\n');
                };
                write(job.state);
                const unsubscribe = job.subscribe(write);
                const timer = setInterval(() => res.write(': keep-alive\n\n'), 15000);
                req.on('close', () => {
                    clearInterval(timer);
                    unsubscribe();
                });
                return;
            }

            if (pathname === '/api/cancel') {
                const body = await readJson(req);
                const job = jobs.get(body.id);
                if (job) {
                    job.cancel();
                }
                sendJson(res, 200, {ok: true});
                return;
            }

            if (pathname === '/api/locks') {
                const body = await readJson(req);
                const target = expandPath(body.path);
                if (!target) {
                    sendJson(res, 400, {error: '路径为空'});
                    return;
                }
                try {
                    const result = await findHolders(target);
                    sendJson(res, 200, result);
                } catch (err) {
                    sendJson(res, 400, {error: err.message || String(err)});
                }
                return;
            }

            if (pathname === '/api/kill') {
                const body = await readJson(req);
                const pid = Number(body.pid);
                if (!pid || pid <= 4) {
                    sendJson(res, 400, {error: '进程号无效'});
                    return;
                }
                if (pid === process.pid) {
                    sendJson(res, 400, {error: '不能结束本程序自己的进程'});
                    return;
                }
                const protectedNames = ['system', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'svchost'];
                let name = '';
                try {
                    name = require('child_process')
                        .execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], {encoding: 'utf8'})
                        .split(',')[0]
                        .replace(/"/g, '')
                        .trim()
                        .toLowerCase();
                } catch (err) {
                    /* 取不到名字时按未知处理 */
                }
                if (protectedNames.indexOf(name) >= 0) {
                    sendJson(res, 400, {error: '系统关键进程不允许结束：' + name});
                    return;
                }
                try {
                    process.kill(pid);
                    journal.log('结束进程 ' + pid + (name ? '（' + name + '）' : ''));
                    sendJson(res, 200, {ok: true, name});
                } catch (err) {
                    sendJson(res, 400, {error: '结束进程失败：' + (err.message || String(err))});
                }
                return;
            }

            if (pathname === '/api/journal') {
                sendJson(res, 200, {records: journal.readAll().slice().reverse()});
                return;
            }

            if (pathname === '/api/journal/delete') {
                const body = await readJson(req);
                if (!body.id) {
                    sendJson(res, 400, {error: '缺少记录 id'});
                    return;
                }
                journal.remove(body.id);
                journal.log('删除迁移记录：' + body.id);
                sendJson(res, 200, {ok: true});
                return;
            }

            if (pathname === '/api/undo') {
                const body = await readJson(req);
                const record = journal.readAll().find((item) => item.id === body.id);
                if (!record) {
                    sendJson(res, 404, {error: '记录不存在'});
                    return;
                }
                try {
                    const result = await undoRecord(record);
                    journal.update(record.id, {status: 'undone', undoneAt: new Date().toISOString()});
                    journal.log('撤销 ' + record.source + '：' + result.mode);
                    sendJson(res, 200, {ok: true, result});
                } catch (err) {
                    sendJson(res, 400, {error: err.message || String(err)});
                }
                return;
            }

            if (pathname === '/api/reveal') {
                const body = await readJson(req);
                if (!body.path) {
                    sendJson(res, 400, {error: '路径为空'});
                    return;
                }
                const abs = path.resolve(expandPath(body.path));
                if (!fs.existsSync(abs)) {
                    sendJson(res, 400, {error: '路径不存在：' + abs});
                    return;
                }
                const st = fs.statSync(abs);
                if (st.isDirectory()) {
                    spawn('explorer.exe', [abs], {detached: true, stdio: 'ignore'}).unref();
                } else {
                    spawn('explorer.exe', ['/select,' + abs], {detached: true, stdio: 'ignore'}).unref();
                }
                sendJson(res, 200, {ok: true});
                return;
            }

            if (pathname === '/api/open-log') {
                spawn('explorer.exe', [journal.LOG_DIR], {detached: true, stdio: 'ignore'}).unref();
                sendJson(res, 200, {ok: true});
                return;
            }

            if (pathname === '/api/shutdown') {
                sendJson(res, 200, {ok: true});
                setTimeout(() => {
                    if (onShutdown) {
                        onShutdown();
                    }
                }, 80);
                return;
            }

            sendJson(res, 404, {error: '未找到该接口'});
        } catch (err) {
            sendJson(res, 500, {error: err.message || String(err)});
        }
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const timer = setInterval(() => {
                if (!pingSeen || hasRunningJob()) {
                    return;
                }
                // 只作兜底：窗口关闭由看守进程上报。页面定时器在窗口被遮挡或最小化时会被节流，
                // 阈值必须远大于节流后的心跳间隔，否则窗口一被盖住程序就会自己退出
                if (Date.now() - lastPing > PING_TIMEOUT_MS) {
                    clearInterval(timer);
                    if (onShutdown) {
                        onShutdown();
                    }
                }
            }, 15000);
            timer.unref();
            if (options.onReady) {
                options.onReady(server.address().port);
            }
            resolve(server);
        });
    });
}

/**
 * 注册退出回调
 * @param {Function} fn 回调
 */
function setShutdownHandler(fn) {
    onShutdown = fn;
}

module.exports = {startServer, setShutdownHandler, hasRunningJob};
