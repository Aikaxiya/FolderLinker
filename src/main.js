'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const {spawn} = require('child_process');
const {startServer, setShutdownHandler, hasRunningJob} = require('./server');
const journal = require('./core/journal');

const WINDOW_TITLE = '文件夹软连接创建工具';
// 窗口固定尺寸：去掉可缩放边框后窗口就是这个大小，改这里即可调整
// 16:10 且不出现滚动条的最小值是 1280×800（1120×700 会挤出一条竖向滚动条）
const WINDOW_WIDTH = 900;
const WINDOW_HEIGHT = 850;
const WINDOW_STATE_FILE = path.join(journal.APP_DIR, 'window.json');
const BROWSER_PROFILE_DIR = path.join(journal.APP_DIR, 'browser');

// 容器化：屏蔽浏览器的翻译、账号推广、同步、新功能提示等；不认识的特性名会被浏览器直接忽略
const DISABLED_FEATURES = [
    'Translate',
    'TranslateUI',
    'MediaRouter',
    'OptimizationHints',
    'InterestFeedContentSuggestions',
    'PrivacySandboxSettings4',
    'ChromeWhatsNewUI',
    'SigninPromo',
    // 不计算窗口遮挡，避免窗口被盖住/最小化时渲染进程被冻结、页面定时器被节流
    'CalculateNativeWinOcclusion',
    'msEdgeIdentityFRE',
    'msEdgeSyncPromo',
    'msEdgeWelcomePage',
    'msEdgeSidebarV2'
];

let windowWatcher = null;
let server = null;
let shuttingDown = false;

const LOCK_PORT = 49731;
const LOCK_TOKEN = 'folder-linker-instance';

/**
 * 探测占用锁端口的进程是不是本程序
 * @returns {Promise<boolean>} 是本程序返回 true
 */
function probeInstanceLock() {
    return new Promise((resolve) => {
        const req = http.get({host: '127.0.0.1', port: LOCK_PORT, path: '/', timeout: 800}, (res) => {
            let body = '';
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                resolve(body === LOCK_TOKEN);
            });
        });
        req.on('error', () => {
            resolve(false);
        });
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

/**
 * 占用单实例锁
 * 双开会让两个进程共用同一个窗口标题，一方退出时会顺手关掉另一方的窗口，表现就是"窗口突然没了"
 * @returns {Promise<boolean>} 拿到锁返回 true
 */
function acquireInstanceLock() {
    return new Promise((resolve) => {
        const lockServer = net.createServer((socket) => {
            const body = LOCK_TOKEN;
            socket.end(
                'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ' +
                body.length +
                '\r\nConnection: close\r\n\r\n' +
                body
            );
        });
        lockServer.once('error', async (err) => {
            if (err.code !== 'EADDRINUSE') {
                resolve(true);
                return;
            }
            resolve(!(await probeInstanceLock()));
        });
        lockServer.listen(LOCK_PORT, '127.0.0.1', () => {
            lockServer.unref();
            resolve(true);
        });
    });
}

/**
 * 把已有实例的窗口调到前台
 * @returns {Promise<void>} 动作结束
 */
function activateExistingWindow() {
    const script = [
        '$ErrorActionPreference = "SilentlyContinue"',
        'Add-Type -TypeDefinition @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class FlActivate {',
        '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
        '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
        '}',
        '"@',
        "$target = Get-Process -Name msedge,chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '" +
        WINDOW_TITLE +
        "' } | Select-Object -First 1",
        'if ($target) {',
        '  [void][FlActivate]::ShowWindow($target.MainWindowHandle, 9)',
        '  [void][FlActivate]::SetForegroundWindow($target.MainWindowHandle)',
        '  Write-Output "activated"',
        '} else {',
        '  Write-Output "not-found"',
        '}'
    ].join('\r\n');
    const file = path.join(os.tmpdir(), 'folder-linker-activate-' + process.pid + '.ps1');
    fs.writeFileSync(file, '\uFEFF' + script, 'utf8');

    return new Promise((resolve) => {
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', file],
            {windowsHide: true}
        );
        const timer = setTimeout(() => {
            child.kill();
            resolve();
        }, 8000);
        child.on('close', () => {
            clearTimeout(timer);
            resolve();
        });
        child.on('error', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/**
 * 查找可用的 Chromium 内核浏览器
 * @returns {string|null} 浏览器可执行文件路径
 */
function findBrowser() {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean);
    const candidates = [];
    for (const root of roots) {
        candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
        candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    for (const file of candidates) {
        if (fs.existsSync(file)) {
            return file;
        }
    }
    return null;
}

/**
 * 读取上次记录的窗口位置与大小
 * @returns {{x:number|null,y:number|null,width:number,height:number}|null} 无有效记录时返回 null
 */
function readWindowState() {
    let raw = '';
    try {
        raw = fs.readFileSync(WINDOW_STATE_FILE, 'utf8');
    } catch (err) {
        return null;
    }
    let data = null;
    try {
        data = JSON.parse(raw);
    } catch (err) {
        return null;
    }
    const width = Number(data.width);
    const height = Number(data.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }
    const x = Number(data.x);
    const y = Number(data.y);
    return {
        x: Number.isFinite(x) ? Math.round(x) : null,
        y: Number.isFinite(y) ? Math.round(y) : null,
        width: Math.round(width),
        height: Math.round(height)
    };
}

/**
 * 生成 PowerShell 单引号字符串字面量
 * @param {string} text 原始文本
 * @returns {string} 可直接嵌入脚本的字面量
 */
function psString(text) {
    return "'" + String(text).replace(/'/g, "''") + "'";
}

/**
 * 构造窗口监视脚本
 * 浏览器内核无法从命令行限制最小尺寸，这里用独立进程守着窗口：
 * 拖拽（GUI_INMOVESIZE）期间完全不动手，松手后若小于下限才纠正一次，避免拖拽时来回抖
 * @param {boolean} centerFirst 首次启动（无历史记录）时是否居中
 * @returns {string} 脚本内容
 */
function buildWatcherScript(centerFirst) {
    return `$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct FL_RECT { public int Left; public int Top; public int Right; public int Bottom; }
public struct FL_GUIINFO {
  public int cbSize;
  public int flags;
  public IntPtr hwndActive;
  public IntPtr hwndFocus;
  public IntPtr hwndCapture;
  public IntPtr hwndMenuOwner;
  public IntPtr hwndMoveSize;
  public IntPtr hwndCaret;
  public FL_RECT rcCaret;
}
public static class FlWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out FL_RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint tid, ref FL_GUIINFO info);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint key);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookExW(int idHook, HookProc fn, IntPtr hMod, uint threadId);
  [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
  public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
}
"@

try {
  [void][FlWin]::SetProcessDpiAwareness(2)
} catch {
  [void][FlWin]::SetProcessDPIAware()
}

$title = ${psString(WINDOW_TITLE)}
$profileDir = ${psString(BROWSER_PROFILE_DIR)}
$stateFile = ${psString(WINDOW_STATE_FILE)}
$logDir = ${psString(journal.LOG_DIR)}
$targetDipW = ${WINDOW_WIDTH}
$targetDipH = ${WINDOW_HEIGHT}
$centerFirst = ${centerFirst ? 1 : 0}
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$SWP_FRAMECHANGED = 0x0020
$GUI_INMOVESIZE = 0x0002
$GWL_STYLE = -16
$WS_THICKFRAME = 0x00040000
$MOD_CONTROL = 0x0002
$MOD_SHIFT = 0x0004

function Get-Rect($handle) {
  $rect = New-Object FL_RECT
  if (-not [FlWin]::GetWindowRect($handle, [ref]$rect)) {
    return $null
  }
  return $rect
}

function Save-Rect($rect, $width, $height) {
  # 尺寸按当前屏幕可用区域封顶，避免下次启动开出一个超出屏幕的窗口
  $area = [System.Windows.Forms.Screen]::FromHandle($handle).WorkingArea
  $saveW = [Math]::Min($width, $area.Width)
  $saveH = [Math]::Min($height, $area.Height)
  $saveX = [Math]::Min([Math]::Max($rect.Left, $area.Left), $area.Right - $saveW)
  $saveY = [Math]::Min([Math]::Max($rect.Top, $area.Top), $area.Bottom - $saveH)
  $dx = [int][Math]::Round($saveX * 96.0 / $dpi)
  $dy = [int][Math]::Round($saveY * 96.0 / $dpi)
  $dw = [int][Math]::Round($saveW * 96.0 / $dpi)
  $dh = [int][Math]::Round($saveH * 96.0 / $dpi)
  $json = '{"x":' + $dx + ',"y":' + $dy + ',"width":' + $dw + ',"height":' + $dh + '}'
  [System.IO.File]::WriteAllText($stateFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# 按配置目录找窗口：标题是页面里的文案，随时可能改，不能拿来当标识
function Find-AppWindow {
  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -like ('*' + $profileDir + '*')
  }
  foreach ($item in $procs) {
    $proc = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) {
      return $proc.MainWindowHandle
    }
  }
  return [IntPtr]::Zero
}

$handle = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  $handle = Find-AppWindow
  if ($handle -ne [IntPtr]::Zero) {
    break
  }
  Start-Sleep -Milliseconds 400
}
if ($handle -eq [IntPtr]::Zero) {
  exit 1
}

$dpi = [int][FlWin]::GetDpiForWindow($handle)
if ($dpi -le 0) {
  $dpi = 96
}
$fixedW = [int][Math]::Round($targetDipW * $dpi / 96.0)
$fixedH = [int][Math]::Round($targetDipH * $dpi / 96.0)

$rect = Get-Rect $handle
if (-not $rect) {
  exit 1
}
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

# 首帧修正：无历史记录时居中；记录的位置已不在任何屏幕上时拉回主屏
$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
$work = [System.Windows.Forms.Screen]::FromHandle($handle).WorkingArea
$outside = ($rect.Left + $width -le $virtual.Left) -or ($rect.Left -ge $virtual.Right) -or ($rect.Top + $height -le $virtual.Top) -or ($rect.Top -ge $virtual.Bottom)
if ($centerFirst -eq 1 -or $outside) {
  $nx = $work.X + [int](($work.Width - $width) / 2)
  $ny = $work.Y + [int](($work.Height - $height) / 2)
  [void][FlWin]::SetWindowPos($handle, [IntPtr]::Zero, $nx, $ny, $width, $height, $SWP_NOZORDER -bor $SWP_NOACTIVATE)
  $rect = Get-Rect $handle
}

function Test-Busy($target) {
  $ownerPid = [uint32]0
  $threadId = [FlWin]::GetWindowThreadProcessId($target, [ref]$ownerPid)
  if ($threadId -eq 0) {
    return $false
  }
  $info = New-Object FL_GUIINFO
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [FlWin]::GetGUIThreadInfo($threadId, [ref]$info)) {
    return $false
  }
  return (($info.flags -band $GUI_INMOVESIZE) -ne 0)
}

# 固定尺寸：去掉可缩放边框（WS_THICKFRAME），窗口就不能被拖拽改变大小了
# 最大化按钮保留，最大化/还原后仍然回到固定尺寸
function Lock-Size($target) {
  $style = [FlWin]::GetWindowLongPtr($target, $GWL_STYLE).ToInt64()
  if (($style -band $WS_THICKFRAME) -eq 0) {
    return $false
  }
  $locked = $style -band (-bnot [int64]$WS_THICKFRAME)
  [void][FlWin]::SetWindowLongPtr($target, $GWL_STYLE, [IntPtr]$locked)
  [void][FlWin]::SetWindowPos($target, [IntPtr]::Zero, 0, 0, 0, 0, $SWP_FRAMECHANGED -bor $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE)
  return $true
}

# 关掉调试：窗口在前台时把这些快捷键注册成热键，按键被本进程吃掉，浏览器收不到也就打不开开发者工具
function Write-WatcherLog($text) {
  try {
    $file = Join-Path $logDir ((Get-Date).ToString('yyyy-MM-dd') + '.log')
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    [System.IO.File]::AppendAllText($file, '[' + $stamp + '] ' + $text + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
  }
}

# 关掉调试：F12 被 Windows 保留给调试器（RegisterHotKey 返回 1409），只能用键盘钩子吃掉；
# Ctrl+Shift+I/J/C 用热键更省事。钩子常驻，但只在窗口处于前台时吞掉 F12
function Install-KeyHook {
  if ($script:keyHook -ne [IntPtr]::Zero) {
    return $true
  }
  if (-not $script:hookProc) {
    $script:hookProc = [FlWin+HookProc]{
      param($nCode, $wParam, $lParam)
      if ($nCode -ge 0) {
        $vk = [System.Runtime.InteropServices.Marshal]::ReadInt32($lParam)
        if ($vk -eq 0x7B -and [FlWin]::GetForegroundWindow() -eq $script:targetHandle) {
          return [IntPtr]1
        }
      }
      return [FlWin]::CallNextHookEx([IntPtr]::Zero, $nCode, $wParam, $lParam)
    }
  }
  $script:keyHook = [FlWin]::SetWindowsHookExW(13, $script:hookProc, [FlWin]::GetModuleHandle($null), 0)
  return ($script:keyHook -ne [IntPtr]::Zero)
}

function Remove-KeyHook {
  if ($script:keyHook -eq [IntPtr]::Zero) {
    return
  }
  [void][FlWin]::UnhookWindowsHookEx($script:keyHook)
  $script:keyHook = [IntPtr]::Zero
}

function Set-DevToolsBlock($enable) {
  if ($enable) {
    [void][FlWin]::RegisterHotKey([IntPtr]::Zero, 2, $MOD_CONTROL -bor $MOD_SHIFT, 0x49)
    [void][FlWin]::RegisterHotKey([IntPtr]::Zero, 3, $MOD_CONTROL -bor $MOD_SHIFT, 0x4A)
    [void][FlWin]::RegisterHotKey([IntPtr]::Zero, 4, $MOD_CONTROL -bor $MOD_SHIFT, 0x43)
    return
  }
  foreach ($id in 2, 3, 4) {
    [void][FlWin]::UnregisterHotKey([IntPtr]::Zero, $id)
  }
}

$lastSaved = ''
$prevKey = ''
$lastWrite = [DateTime]::MinValue
$tick = 0
$loop = 0
$hotkeysOn = $false

# 先把窗口变成固定尺寸，之后用户就没有拖拽改变大小的入口了
$script:keyHook = [IntPtr]::Zero
$script:hookProc = $null
$script:targetHandle = $handle
[void](Lock-Size $handle)

# 常驻键盘钩子拦 F12（只在窗口前台时生效），安装结果写日志方便排查
if (Install-KeyHook) {
  Write-WatcherLog '已屏蔽调试快捷键：F12（键盘钩子）/ Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C'
} else {
  Write-WatcherLog '键盘钩子安装失败，F12 未能屏蔽'
}

while ([FlWin]::IsWindow($handle)) {
  $loop++
  # 每 3 拍（约 45ms）做一次完整检查，其余拍只泵消息，保证键盘钩子回调不被拖慢
  if (($loop % 3) -eq 1) {
  $rect = Get-Rect $handle
  if (-not $rect) {
    break
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $key = '' + $rect.Left + '|' + $rect.Top + '|' + $width + '|' + $height
  $now = Get-Date

  $minimized = [FlWin]::IsIconic($handle)
  $maximized = [FlWin]::IsZoomed($handle)

  # 每秒复查一次：浏览器在最大化/还原后可能把边框样式加回来，加回来就再锁一次
  $tick++
  if (($tick % 25) -eq 1) {
    [void](Lock-Size $handle)
  }

  # 只在本窗口处于前台时占用调试快捷键，切走后立刻还回去，不影响其它程序
  $active = ([FlWin]::GetForegroundWindow() -eq $handle)
  if ($active -ne $hotkeysOn) {
    Set-DevToolsBlock $active
    $hotkeysOn = $active
  }

  # 记录位置与大小（拖拽过程中也记，节流 400ms，避免关窗瞬间丢失最后一次调整）
  if (-not $minimized -and -not $maximized -and $key -ne $lastSaved -and ($now - $lastWrite).TotalMilliseconds -ge 400) {
    Save-Rect $rect $width $height
    $lastSaved = $key
    $lastWrite = $now
  }

  # 尺寸固定：尺寸被外部改动（边框样式被加回来、系统缩放变化等）时拉回固定值
  # 鼠标左键已松开、连续两次采样一致、不在模态调整循环里才动手，拖拽过程中不碰窗口
  $offSize = ([Math]::Abs($width - $fixedW) -gt 2) -or ([Math]::Abs($height - $fixedH) -gt 2)
  if (-not $minimized -and -not $maximized -and $key -eq $prevKey -and $offSize) {
    $buttonDown = (([FlWin]::GetAsyncKeyState(0x01)) -band 0x8000) -ne 0
    if (-not $buttonDown -and -not (Test-Busy $handle)) {
      [void][FlWin]::SetWindowPos($handle, [IntPtr]::Zero, $rect.Left, $rect.Top, $fixedW, $fixedH, $SWP_NOZORDER -bor $SWP_NOACTIVATE)
      $lastSaved = ''
      $prevKey = ''
    }
  }

  $prevKey = $key
  }

  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 15
}

Remove-KeyHook
`;
}

/**
 * 启动窗口监视进程：维持最小尺寸并记录位置与大小
 * @param {boolean} centerFirst 首次启动时是否居中
 */
function startWindowWatcher(centerFirst) {
    const file = path.join(os.tmpdir(), 'folder-linker-window-' + process.pid + '.ps1');
    try {
        fs.writeFileSync(file, '\uFEFF' + buildWatcherScript(centerFirst), 'utf8');
    } catch (err) {
        journal.log('窗口监视脚本写入失败：' + err.message);
        return;
    }
    try {
        windowWatcher = spawn(
            'powershell.exe',
            ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', file],
            {windowsHide: true, stdio: 'ignore'}
        );
        windowWatcher.on('error', (err) => {
            journal.log('窗口监视进程启动失败：' + err.message);
            windowWatcher = null;
        });
        windowWatcher.on('close', (code) => {
            windowWatcher = null;
            if (shuttingDown) {
                return;
            }
            if (code === 0) {
                // 看守进程看到窗口消失：这才是"用户关掉界面"的可靠信号，比页面心跳可靠得多
                journal.log('界面窗口已关闭');
                waitForIdle().then(shutdown);
                return;
            }
            // 窗口一直没出现（浏览器启动失败等）：不能留着无窗口的进程占着单实例锁
            journal.log('窗口监视进程异常退出（退出码 ' + code + '），窗口未出现，程序退出');
            shutdown();
        });
    } catch (err) {
        journal.log('窗口监视进程启动失败：' + err.message);
    }
}

/**
 * 结束窗口监视进程
 */
function stopWindowWatcher() {
    if (!windowWatcher) {
        return;
    }
    try {
        windowWatcher.kill();
    } catch (err) {
        /* 进程已退出时忽略 */
    }
    windowWatcher = null;
}

/**
 * 以应用窗口模式打开界面
 * 独立配置目录让窗口归属本程序：命令行尺寸参数才会生效，退出时也不会动到用户自己的浏览器
 * @param {number} port 本地服务端口
 */
function openWindow(port) {
    const url = 'http://127.0.0.1:' + port + '/';
    const browser = findBrowser();
    if (!browser) {
        spawn('explorer.exe', [url], {detached: true, stdio: 'ignore'}).unref();
        return;
    }
    const saved = readWindowState();
    const args = [
        '--app=' + url,
        '--user-data-dir=' + BROWSER_PROFILE_DIR,
        // 尺寸固定，只恢复上次的位置
        '--window-size=' + WINDOW_WIDTH + ',' + WINDOW_HEIGHT,
        // 只当容器用：关掉同步、首次运行引导、账号推广、更新与后台驻留
        '--disable-features=' + DISABLED_FEATURES.join(','),
        '--disable-sync',
        '--disable-background-mode',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-search-engine-choice-screen',
        '--hide-crash-restore-bubble',
        '--no-service-autorun',
        '--overscroll-history-navigation=0',
        '--no-first-run',
        '--no-default-browser-check'
    ];
    if (saved && saved.x !== null && saved.y !== null) {
        args.push('--window-position=' + saved.x + ',' + saved.y);
    }
    spawn(browser, args, {detached: true, stdio: 'ignore'}).unref();
    startWindowWatcher(!saved);
}

/**
 * 弹出系统消息框提示致命错误，避免无控制台时静默失败
 * @param {string} text 提示内容
 */
function showFatal(text) {
    const safe = String(text).replace(/'/g, "''");
    const script =
        "Add-Type -AssemblyName System.Windows.Forms; " +
        "[System.Windows.Forms.MessageBox]::Show('" + safe + "', '文件夹联接器', 'OK', 'Error') | Out-Null";
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    try {
        spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
            windowsHide: true,
            detached: true,
            stdio: 'ignore'
        }).unref();
    } catch (err) {
        /* 弹窗失败时仅依赖日志文件 */
    }
}

/**
 * 关闭应用窗口
 * 窗口挂在共用浏览器进程上，按 PID 结束会误伤；直接给窗口句柄发 WM_CLOSE，不依赖焦点
 * @returns {Promise<void>} 关闭动作结束
 */
function closeAppWindow() {
    const script = [
        '$profileDir = ' + psString(BROWSER_PROFILE_DIR),
        '$target = $null',
        '$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {',
        "  ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -like ('*' + $profileDir + '*')",
        '}',
        'foreach ($item in $procs) {',
        '  $proc = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue',
        '  if ($proc -and $proc.MainWindowHandle -ne 0) {',
        '    $target = $proc',
        '    break',
        '  }',
        '}',
        'if (-not $target) {',
        "  Write-Output 'not-found'",
        '} else {',
        '  $closed = $target.CloseMainWindow()',
        "  Write-Output ('close=' + $closed)",
        '}'
    ].join('\r\n');
    const file = path.join(os.tmpdir(), 'folder-linker-close-' + process.pid + '.ps1');
    fs.writeFileSync(file, '\uFEFF' + script, 'utf8');

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
        const timer = setTimeout(() => {
            child.kill();
            resolve();
        }, 10000);
        child.on('close', () => {
            clearTimeout(timer);
            journal.log('关闭窗口：' + (out.trim() || '无输出') + (err.trim() ? ' | ' + err.trim().slice(0, 200) : ''));
            resolve();
        });
        child.on('error', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/**
 * 等待迁移任务结束（关窗时任务可能还在跑，直接退出会把迁移打断在半路）
 * @returns {Promise<void>} 任务结束或超时后 resolve
 */
function waitForIdle() {
    return new Promise((resolve) => {
        const deadline = Date.now() + 30 * 60 * 1000;
        const timer = setInterval(() => {
            if (!hasRunningJob() || Date.now() > deadline) {
                clearInterval(timer);
                resolve();
            }
        }, 1000);
        timer.unref();
    });
}

/**
 * 退出程序（幂等）
 */
async function shutdown() {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    try {
        if (server) {
            server.close();
        }
    } catch (err) {
        /* 关闭失败忽略 */
    }
    await closeAppWindow();
    stopWindowWatcher();
    process.exit(0);
}

/**
 * 程序入口
 */
async function main() {
    journal.ensureAppDir();

    if (!(await acquireInstanceLock())) {
        journal.log('已有实例在运行，激活它的窗口');
        await activateExistingWindow();
        process.exit(0);
    }

    setShutdownHandler(shutdown);

    server = await startServer({
        onReady: (port) => {
            journal.log('服务已启动，端口 ' + port);
            openWindow(port);
        }
    });

    process.on('uncaughtException', (err) => {
        journal.log('未捕获异常：' + (err.stack || err.message));
    });
    process.on('unhandledRejection', (err) => {
        journal.log('未处理的 Promise 拒绝：' + (err && err.message ? err.message : String(err)));
    });
}

main().catch((err) => {
    const message = err && err.message ? err.message : String(err);
    journal.log('启动失败：' + (err.stack || message));
    showFatal('程序启动失败：\n' + message + '\n\n日志：' + journal.LOG_DIR);
    process.exit(1);
});
