'use strict';

const state = {
    source: '',
    target: '',
    strict: false,
    plan: null,
    jobId: null,
    running: false,
    openPath: '',
    source$: null,
    target$: null
};

const el = {
    sourcePath: document.getElementById('source-path'),
    sourceMeta: document.getElementById('source-meta'),
    targetPath: document.getElementById('target-path'),
    targetMeta: document.getElementById('target-meta'),
    rowSource: document.getElementById('row-source'),
    rowTarget: document.getElementById('row-target'),
    hint: document.getElementById('plan-hint'),
    planbar: document.getElementById('planbar'),
    planbarMain: document.getElementById('planbar-main'),
    planbarSub: document.getElementById('planbar-sub'),
    run: document.getElementById('btn-run'),
    progress: document.getElementById('progress'),
    barFill: document.getElementById('bar-fill'),
    progressText: document.getElementById('progress-text'),
    progressPct: document.getElementById('progress-pct'),
    currentFile: document.getElementById('current-file'),
    cancel: document.getElementById('btn-cancel'),
    result: document.getElementById('result'),
    resultIcon: document.getElementById('result-icon'),
    resultTitle: document.getElementById('result-title'),
    resultSub: document.getElementById('result-sub'),
    resultDetail: document.getElementById('result-detail'),
    history: document.getElementById('history-list'),
    toast: document.getElementById('toast'),
    seg: document.getElementById('seg-strict'),
    steps: document.getElementById('steps'),
    themeBtn: document.getElementById('btn-theme'),
    openTarget: document.getElementById('btn-open-target'),
    confirmMask: document.getElementById('confirm-mask'),
    confirmText: document.getElementById('confirm-text'),
    confirmOk: document.getElementById('confirm-ok'),
    confirmCancel: document.getElementById('confirm-cancel'),
    locksMask: document.getElementById('locks-mask'),
    locksTitle: document.getElementById('locks-title'),
    locksBody: document.getElementById('locks-body'),
    locksRefresh: document.getElementById('locks-refresh'),
    locksClose: document.getElementById('locks-close')
};

let confirmResolve = null;

/**
 * 页面内确认框（原生 confirm 会弹出浏览器样式对话框，和容器窗口不搭）
 * @param {string} text 提示文字
 * @param {{okText?:string, danger?:boolean}} [options] 按钮文案与是否危险操作
 * @returns {Promise<boolean>} 点确定返回 true
 */
function askConfirm(text, options = {}) {
    return new Promise((resolve) => {
        confirmResolve = resolve;
        el.confirmText.textContent = text;
        el.confirmOk.textContent = options.okText || '确定';
        el.confirmOk.className = 'btn ' + (options.danger ? 'danger' : 'primary');
        el.confirmMask.hidden = false;
        el.confirmOk.focus();
    });
}

/**
 * 关闭确认框并返回结果
 * @param {boolean} value 用户选择
 */
function settleConfirm(value) {
    if (!confirmResolve) {
        return;
    }
    const resolve = confirmResolve;
    confirmResolve = null;
    el.confirmMask.hidden = true;
    resolve(value);
}

el.confirmOk.addEventListener('click', () => settleConfirm(true));
el.confirmCancel.addEventListener('click', () => settleConfirm(false));
el.confirmMask.addEventListener('mousedown', (event) => {
    if (event.target === el.confirmMask) {
        settleConfirm(false);
    }
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.locksMask.hidden) {
        event.preventDefault();
        el.locksMask.hidden = true;
        return;
    }
    if (el.confirmMask.hidden) {
        return;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        settleConfirm(false);
    }
    if (event.key === 'Enter') {
        event.preventDefault();
        settleConfirm(true);
    }
});

let locksScanning = false;

/**
 * 打开"占用查询"弹窗
 * @param {'source'|'target'} kind 查询哪一侧
 */
async function openLocks(kind) {
    const input = kind === 'target' ? el.targetPath : el.sourcePath;
    const target = (input.value || '').trim();
    if (!target) {
        toast('先选择或填写路径', 'bad');
        return;
    }
    el.locksMask.hidden = false;
    await scanLocks(target);
}

/**
 * 扫描并渲染占用进程
 * @param {string} target 目标路径
 */
async function scanLocks(target) {
    if (locksScanning) {
        return;
    }
    locksScanning = true;
    locksPath = target;
    el.locksTitle.textContent = '占用情况';
    el.locksBody.innerHTML = '<div class="locks-empty">正在扫描系统句柄表，通常要几秒…</div>';
    try {
        const data = await post('/api/locks', {path: target});
        renderLocks(target, data);
    } catch (err) {
        el.locksBody.innerHTML = '';
        const tip = document.createElement('div');
        tip.className = 'locks-empty';
        tip.textContent = err.message;
        el.locksBody.appendChild(tip);
    } finally {
        locksScanning = false;
    }
}

/**
 * 渲染占用列表
 * @param {string} target 目标路径
 * @param {object} data 接口返回
 */
function renderLocks(target, data) {
    const holders = data.holders || [];
    el.locksTitle.textContent = '占用 ' + target + ' 的进程';
    el.locksBody.innerHTML = '';
    if (holders.length === 0) {
        const tip = document.createElement('div');
        tip.className = 'locks-empty';
        tip.textContent =
            '没有查到占用（扫描 ' + data.scanned + ' 个句柄 / 其中文件句柄 ' + data.fileHandles + '，用时 ' +
            (data.elapsed / 1000).toFixed(1) + ' 秒）';
        el.locksBody.appendChild(tip);
        toast('没有进程占用该路径', 'ok');
        return;
    }

    // 同一个进程可能占着多个文件，按 PID 合并成一条
    const grouped = new Map();
    for (const holder of holders) {
        const item = grouped.get(holder.pid);
        if (item) {
            item.paths.push(holder.path);
        } else {
            grouped.set(holder.pid, {pid: holder.pid, name: holder.name, paths: [holder.path]});
        }
    }
    toast('有 ' + grouped.size + ' 个进程正在占用该路径', 'bad');

    for (const item of grouped.values()) {
        const row = document.createElement('div');
        row.className = 'lock-row';

        const main = document.createElement('div');
        main.className = 'lock-main';
        const name = document.createElement('div');
        name.className = 'lock-name';
        name.textContent = (item.name || '未知进程') + ' · PID ' + item.pid;
        const file = document.createElement('div');
        file.className = 'lock-file';
        file.textContent =
            item.paths[0] + (item.paths.length > 1 ? '（另有 ' + (item.paths.length - 1) + ' 个句柄）' : '');
        main.appendChild(name);
        main.appendChild(file);

        const kill = document.createElement('button');
        kill.className = 'btn sm danger';
        kill.textContent = '结束进程';
        kill.addEventListener('click', () => doKill(item, kill));

        row.appendChild(main);
        row.appendChild(kill);
        el.locksBody.appendChild(row);
    }
}

/**
 * 结束占用进程
 * @param {object} holder 占用信息
 * @param {HTMLButtonElement} btn 按钮
 */
async function doKill(holder, btn) {
    const label = holder.name || '该进程';
    const ok = await askConfirm(
        '结束 ' + label + '（PID ' + holder.pid + '）？未保存的数据会丢失。',
        {okText: '结束进程', danger: true}
    );
    if (!ok) {
        return;
    }
    btn.disabled = true;
    btn.textContent = '结束中…';
    try {
        await post('/api/kill', {pid: holder.pid});
        toast('已结束 ' + label + '（PID ' + holder.pid + '）', 'ok');
        if (locksPath) {
            await scanLocks(locksPath);
        }
    } catch (err) {
        toast(err.message, 'bad');
        btn.disabled = false;
        btn.textContent = '结束进程';
    }
}

let locksPath = '';

document.querySelectorAll('[data-check]').forEach((btn) => {
    btn.addEventListener('click', () => openLocks(btn.dataset.check));
});
el.locksClose.addEventListener('click', () => {
    el.locksMask.hidden = true;
});
el.locksRefresh.addEventListener('click', () => {
    if (locksPath) {
        scanLocks(locksPath);
    }
});
el.locksMask.addEventListener('mousedown', (event) => {
    if (event.target === el.locksMask) {
        el.locksMask.hidden = true;
    }
});

/**
 * 格式化字节数
 * @param {number} bytes 字节数
 * @returns {string} 可读文本
 */
function fmtBytes(bytes) {
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

/**
 * 发送 JSON 请求
 * @param {string} url 接口地址
 * @param {object} body 请求体
 * @returns {Promise<object>} 响应数据
 */
async function post(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || '请求失败');
    }
    return data;
}

/**
 * 显示轻提示
 * @param {string} text 文本
 * @param {string} [type] 类型 ok/bad
 */
let toastTimer = null;

function toast(text, type) {
    el.toast.textContent = text;
    el.toast.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.toast.className = 'toast';
    }, 2600);
}

/**
 * 渲染路径文本
 */
function renderPaths() {
    if (el.sourcePath.value !== state.source) {
        el.sourcePath.value = state.source;
    }
    if (el.targetPath.value !== state.target) {
        el.targetPath.value = state.target;
    }
    document.querySelectorAll('[data-reveal]').forEach((btn) => {
        btn.disabled = !state[btn.dataset.reveal];
    });
    document.querySelectorAll('[data-check]').forEach((btn) => {
        btn.disabled = !state[btn.dataset.check];
    });
}

/**
 * 规范化手工输入的路径：去引号、去多余空白、去掉末尾多余分隔符
 * @param {string} raw 原始输入
 * @returns {string} 规范化后的路径
 */
function normalizeInput(raw) {
    let value = String(raw || '').trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1).trim();
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1).trim();
    }
    if (value.length > 3) {
        value = value.replace(/[\\/]+$/, '');
    }
    if (/^[a-zA-Z]:$/.test(value)) {
        value += '\\';
    }
    return value;
}

/**
 * 应用手工输入的路径
 * @param {string} kind source/target
 * @param {string} raw 输入内容
 */
async function applyPath(kind, raw) {
    const value = normalizeInput(raw);
    state[kind] = value;
    renderPaths();
    if (!value) {
        renderMeta(kind, null);
        await refreshPlan();
        return;
    }
    try {
        const info = await post('/api/inspect', {path: value, role: kind});
        if (guardPath(kind, info)) {
            await refreshPlan();
            return;
        }
        renderMeta(kind, info);
    } catch (err) {
        toast(err.message, 'bad');
    }
    await refreshPlan();
}

/**
 * 系统关键路径直接拦下：提示并清空这一侧的路径
 * @param {string} kind source/target
 * @param {object} info /api/inspect 返回
 * @returns {boolean} 是否被拦下
 */
function guardPath(kind, info) {
    const guarded = info && info.guarded;
    if (!guarded || !guarded.errors || guarded.errors.length === 0) {
        return false;
    }
    const message = guarded.errors[0];
    toast(message, 'bad');
    state[kind] = '';
    renderPaths();
    const meta = kind === 'source' ? el.sourceMeta : el.targetMeta;
    const row = kind === 'source' ? el.rowSource : el.rowTarget;
    meta.className = 'path-meta bad';
    meta.textContent = message;
    row.classList.add('is-invalid');
    return true;
}

/**
 * 在资源管理器中打开指定路径
 * @param {string} target 路径
 */
async function reveal(target) {
    if (!target) {
        return;
    }
    try {
        await post('/api/reveal', {path: target});
    } catch (err) {
        toast(err.message, 'bad');
    }
}

/**
 * 设置路径元信息
 * @param {string} kind source/target
 * @param {object} info 检查结果
 */
function renderMeta(kind, info) {
    const meta = kind === 'source' ? el.sourceMeta : el.targetMeta;
    const row = kind === 'source' ? el.rowSource : el.rowTarget;
    meta.className = 'path-meta';
    row.classList.remove('is-invalid');
    if (!state[kind]) {
        meta.textContent = '';
        return;
    }
    if (!info || !info.exists) {
        meta.textContent = '路径不存在或无法访问';
        meta.classList.add('bad');
        row.classList.add('is-invalid');
        return;
    }
    if (info.isReparse) {
        meta.textContent = '这是联接，指向 ' + (info.junctionTarget || '未知位置');
        meta.classList.add('warn');
        return;
    }
    if (info.guarded && info.guarded.warnings && info.guarded.warnings.length > 0) {
        meta.textContent = info.guarded.warnings[0];
        meta.classList.add('warn');
        return;
    }
    meta.textContent = info.drive + ' 可用 ' + info.freeText;
}

/**
 * 选择文件夹
 * @param {string} kind source/target
 */
async function pick(kind) {
    try {
        const current = kind === 'source' ? state.source : state.target;
        const data = await post('/api/pick', {initial: current || ''});
        if (!data.path) {
            return;
        }
        state[kind] = data.path;
        renderPaths();
        const info = await post('/api/inspect', {path: data.path, role: kind});
        if (guardPath(kind, info)) {
            await refreshPlan();
            return;
        }
        renderMeta(kind, info);
        await refreshPlan();
    } catch (err) {
        toast(err.message, 'bad');
    }
}

/**
 * 预检并渲染计划
 */
async function refreshPlan() {
    if (!state.source || !state.target) {
        el.planbar.hidden = true;
        el.run.disabled = true;
        el.hint.textContent = '选择源文件夹与目标文件夹';
        return;
    }
    el.hint.textContent = '正在统计…';
    el.run.disabled = true;
    try {
        const plan = await post('/api/plan', {source: state.source, target: state.target});
        state.plan = plan;
        el.planbar.hidden = false;
        if (plan.ok) {
            el.planbar.className = plan.warnings && plan.warnings.length ? 'planbar warn' : 'planbar';
            el.planbarMain.textContent =
                '将迁移 ' + plan.stats.files + ' 个文件 · ' + plan.bytesText + ' → ' + plan.dest;
            const parts = [];
            parts.push('源目录将保留为联接，指向目标位置');
            if (plan.freeText) {
                parts.push('目标盘可用 ' + plan.freeText);
            }
            if (plan.warnings && plan.warnings.length) {
                parts.push(plan.warnings.join('；'));
            }
            el.planbarSub.textContent = parts.join(' · ');
            el.hint.textContent = '检查通过，可以开始';
            el.run.disabled = state.running;
        } else {
            el.planbar.className = 'planbar error';
            el.planbarMain.textContent = '无法开始迁移';
            el.planbarSub.textContent = plan.errors.join('；');
            el.hint.textContent = '存在 ' + plan.errors.length + ' 个问题';
        }
    } catch (err) {
        el.planbar.hidden = false;
        el.planbar.className = 'planbar error';
        el.planbarMain.textContent = '预检失败';
        el.planbarSub.textContent = err.message;
        el.hint.textContent = '预检失败';
    }
}

const STEP_OF = {
    preflight: 0,
    copy: 0,
    verify: 1,
    swap: 2,
    check: 2,
    cleanup: 2,
    done: 3
};

/**
 * 更新步骤指示器
 * @param {number} index 当前步骤索引
 * @param {boolean} allDone 是否全部完成
 */
function renderSteps(index, allDone) {
    const nodes = el.steps.querySelectorAll('.step');
    nodes.forEach((node, i) => {
        node.classList.remove('active', 'done');
        if (allDone || i < index) {
            node.classList.add('done');
        } else if (i === index) {
            node.classList.add('active');
        }
    });
}

/**
 * 计算进度百分比
 * @param {object} s 状态
 * @returns {number} 百分比
 */
function percentOf(s) {
    if (s.phase === 'done') {
        return 100;
    }
    if (s.phase === 'copy') {
        if (!s.totalBytes) {
            return 2;
        }
        return Math.min(85, Math.max(2, (s.bytes / s.totalBytes) * 85));
    }
    if (s.phase === 'verify') {
        return 90;
    }
    if (s.phase === 'swap' || s.phase === 'check' || s.phase === 'cleanup') {
        return 96;
    }
    return 0;
}

/**
 * 渲染进度
 * @param {object} s 任务状态
 */
function renderProgress(s) {
    el.progress.hidden = false;
    const index = STEP_OF[s.phase] === undefined ? 0 : STEP_OF[s.phase];
    renderSteps(index, s.phase === 'done');
    const pct = percentOf(s);
    el.barFill.style.width = pct.toFixed(1) + '%';
    el.barFill.className = 'bar-fill' + (s.phase === 'done' ? ' ok' : '');
    el.progressPct.textContent = Math.round(pct) + '%';
    el.progressText.textContent = s.message || '';
    el.currentFile.textContent = s.current || '';
}

/**
 * 开始迁移
 */
async function run() {
    if (!state.plan || !state.plan.ok || state.running) {
        return;
    }
    state.running = true;
    el.run.disabled = true;
    el.result.hidden = true;
    el.progress.hidden = false;
    el.barFill.style.width = '0%';
    el.barFill.className = 'bar-fill';
    el.progressPct.textContent = '0%';
    el.progressText.textContent = '正在准备…';
    el.currentFile.textContent = '';
    renderSteps(0, false);

    try {
        const data = await post('/api/run', {
            source: state.source,
            target: state.target,
            strict: state.strict
        });
        state.jobId = data.id;
        subscribe(data.id);
    } catch (err) {
        state.running = false;
        el.run.disabled = false;
        toast(err.message, 'bad');
    }
}

/**
 * 订阅任务事件
 * @param {string} id 任务 id
 */
function subscribe(id) {
    if (state.es) {
        state.es.close();
    }
    const es = new EventSource('/api/events?job=' + encodeURIComponent(id));
    state.es = es;
    es.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (err) {
            return;
        }
        renderProgress(data);
        if (data.phase === 'done' || data.phase === 'failed' || data.phase === 'cancelled') {
            es.close();
            state.es = null;
            finish(data);
        }
    };
    es.onerror = () => {
        es.close();
        state.es = null;
    };
}

/**
 * 任务结束处理
 * @param {object} s 最终状态
 */
function finish(s) {
    state.running = false;
    el.run.disabled = false;
    el.progress.hidden = true;
    el.result.hidden = false;
    el.openTarget.hidden = true;
    state.openPath = '';

    if (s.phase === 'done' && s.result) {
        el.result.className = 'panel result ok';
        el.resultIcon.textContent = '✓';
        el.resultTitle.textContent = '迁移完成，联接已建立';
        el.resultSub.textContent =
            s.result.files + ' 个文件 · ' + s.result.bytesText + ' · ' + (s.result.strict ? '严格校验' : '快速校验');
        el.resultDetail.textContent = s.result.source + '  →  ' + s.result.target;
        state.openPath = s.result.target;
        el.openTarget.hidden = false;
        toast('迁移完成', 'ok');
        state.plan = null;
        refreshPlan();
    } else if (s.phase === 'cancelled') {
        el.result.className = 'panel result bad';
        el.resultIcon.textContent = '!';
        el.resultTitle.textContent = '已取消';
        el.resultSub.textContent = '原始目录未改动，已复制的内容已清理';
        el.resultDetail.textContent = '';
        toast('已取消', 'bad');
    } else {
        el.result.className = 'panel result bad';
        el.resultIcon.textContent = '!';
        el.resultTitle.textContent = '迁移失败';
        el.resultSub.textContent = (s.errors && s.errors[0]) || '未知错误';
        el.resultDetail.textContent = (s.errors || []).slice(1).join('\n');
        toast('迁移失败', 'bad');
    }
    loadHistory();
}

/**
 * 取消迁移
 */
async function cancel() {
    if (!state.jobId) {
        return;
    }
    try {
        await post('/api/cancel', {id: state.jobId});
        el.progressText.textContent = '正在取消…';
    } catch (err) {
        toast(err.message, 'bad');
    }
}

/**
 * 加载迁移记录
 */
async function loadHistory() {
    try {
        const res = await fetch('/api/journal');
        const data = await res.json();
        renderHistory(data.records || []);
    } catch (err) {
        /* 忽略 */
    }
}

const STATUS_TEXT = {
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
    running: '进行中',
    undone: '已撤销'
};

/**
 * 渲染迁移记录
 * @param {Array<object>} records 记录列表
 */
function renderHistory(records) {
    const list = records.filter((item) => item.status !== 'running').slice(0, 8);
    if (list.length === 0) {
        el.history.innerHTML = '<div class="empty-state">暂无记录</div>';
        return;
    }
    el.history.innerHTML = '';
    for (const record of list) {
        const row = document.createElement('div');
        row.className = 'hist';

        const main = document.createElement('div');
        main.className = 'hist-main';
        const p1 = document.createElement('div');
        p1.className = 'hist-path';
        p1.textContent = record.source;
        const p2 = document.createElement('div');
        p2.className = 'hist-sub';
        const time = new Date(record.time).toLocaleString('zh-CN', {hour12: false});
        p2.textContent =
            time + ' · ' + (record.files || 0) + ' 个文件 · ' + fmtBytes(record.bytes || 0) + ' → ' + record.target;
        main.appendChild(p1);
        main.appendChild(p2);

        const pill = document.createElement('span');
        pill.className = 'pill ' + record.status;
        pill.textContent = STATUS_TEXT[record.status] || record.status;

        row.appendChild(main);
        row.appendChild(pill);

        if (record.status === 'done') {
            const undo = document.createElement('button');
            undo.className = 'btn sm';
            undo.textContent = '撤销';
            undo.addEventListener('click', () => doUndo(record.id, undo));
            row.appendChild(undo);
        }

        const del = document.createElement('button');
        del.className = 'icon-btn hist-del';
        del.title = '删除这条记录';
        del.setAttribute('aria-label', '删除这条记录');
        del.innerHTML =
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"></path>' +
            '<path d="M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7"></path>' +
            '<path d="M10.5 11v5M13.5 11v5"></path></svg>';
        del.addEventListener('click', () => doDeleteRecord(record, del));
        row.appendChild(del);

        el.history.appendChild(row);
    }
}

/**
 * 删除一条迁移记录（只删记录，不动已迁移的文件）
 * @param {object} record 记录
 * @param {HTMLButtonElement} btn 按钮
 */
async function doDeleteRecord(record, btn) {
    const tip =
        record.status === 'done'
            ? '删除这条记录？删除后不能再通过它撤销这次迁移，但文件位置不受影响。'
            : '删除这条记录？文件位置不受影响。';
    if (!(await askConfirm(tip, {okText: '删除', danger: true}))) {
        return;
    }
    btn.disabled = true;
    try {
        await post('/api/journal/delete', {id: record.id});
        toast('记录已删除', 'ok');
        loadHistory();
    } catch (err) {
        toast(err.message, 'bad');
        btn.disabled = false;
    }
}

/**
 * 撤销一次迁移
 * @param {string} id 记录 id
 * @param {HTMLButtonElement} btn 按钮
 */
async function doUndo(id, btn) {
    if (!(await askConfirm('撤销将删除联接并把文件搬回原路径，确定继续？', {okText: '撤销'}))) {
        return;
    }
    btn.disabled = true;
    btn.textContent = '撤销中…';
    try {
        await post('/api/undo', {id});
        toast('已撤销，文件已搬回原路径', 'ok');
        loadHistory();
        refreshPlan();
    } catch (err) {
        toast(err.message, 'bad');
        btn.disabled = false;
        btn.textContent = '撤销';
    }
}

document.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', () => pick(btn.dataset.pick));
});

document.querySelectorAll('[data-reveal]').forEach((btn) => {
    btn.addEventListener('click', () => {
        const kind = btn.dataset.reveal;
        reveal(kind === 'source' ? state.source : state.target);
    });
});

el.openTarget.addEventListener('click', () => reveal(state.openPath));

[
    ['source', el.sourcePath],
    ['target', el.targetPath]
].forEach(([kind, input]) => {
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            input.blur();
        } else if (event.key === 'Escape') {
            input.value = state[kind];
            input.blur();
        }
    });
    input.addEventListener('change', () => {
        applyPath(kind, input.value);
    });
});

el.themeBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
        localStorage.setItem('fl-theme', next);
    } catch (err) {
        /* 无法持久化时仅本次生效 */
    }
});

el.seg.addEventListener('click', (event) => {
    const btn = event.target.closest('.seg');
    if (!btn) {
        return;
    }
    el.seg.querySelectorAll('.seg').forEach((node) => node.classList.remove('active'));
    btn.classList.add('active');
    state.strict = btn.dataset.strict === '1';
    refreshPlan();
});

el.run.addEventListener('click', run);
el.cancel.addEventListener('click', cancel);

// 容器窗口不需要浏览器菜单：屏蔽右键菜单里的"检查"等入口，输入框保留右键粘贴
document.addEventListener('contextmenu', (event) => {
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
        return;
    }
    event.preventDefault();
});

document.getElementById('btn-refresh').addEventListener('click', loadHistory);
document.getElementById('btn-log').addEventListener('click', () => post('/api/open-log', {}));
document.getElementById('btn-quit').addEventListener('click', async () => {
    if (state.running && !(await askConfirm('迁移正在进行，确定退出？', {okText: '退出', danger: true}))) {
        return;
    }
    try {
        await post('/api/shutdown', {});
    } catch (err) {
        /* 忽略 */
    }
    window.close();
});

setInterval(() => {
    fetch('/api/ping', {method: 'POST'}).catch(() => {
    });
}, 5000);

renderPaths();
loadHistory();
