'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const SCAN_TIMEOUT_MS = 30000;

/**
 * 生成 PowerShell 单引号字符串字面量
 * @param {string} text 原始文本
 * @returns {string} 可直接嵌入脚本的字面量
 */
function psString(text) {
    return "'" + String(text).replace(/'/g, "''") + "'";
}

/**
 * 构造句柄扫描脚本
 * 遍历系统句柄表，把名字落在目标路径下的文件句柄挑出来，反查是哪个进程
 * @param {string} target 目标路径
 * @returns {string} 脚本内容
 */
function buildScanScript(target) {
    return `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$target = ${psString(target)}

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class HandleScan {
  [StructLayout(LayoutKind.Sequential)]
  public struct UNICODE_STRING {
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
  }

  [DllImport("ntdll.dll")]
  static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
  [DllImport("ntdll.dll")]
  static extern int NtQueryObject(IntPtr h, int cls, IntPtr buf, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, out IntPtr dst, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern int QueryDosDevice(string name, StringBuilder target, int max);

  const int SystemExtendedHandleInformation = 64;
  const int ObjectNameInformation = 1;
  const int ObjectTypeInformation = 2;
  const uint PROCESS_DUP_HANDLE = 0x0040;
  const uint DUPLICATE_SAME_ACCESS = 0x0002;

  static string ReadUnicodeString(IntPtr buf) {
    ushort len = (ushort)Marshal.ReadInt16(buf, 0);
    IntPtr strBuf = Marshal.ReadIntPtr(buf, IntPtr.Size == 8 ? 8 : 4);
    if (strBuf == IntPtr.Zero || len == 0) {
      return string.Empty;
    }
    return Marshal.PtrToStringUni(strBuf, len / 2);
  }

  static string QueryName(IntPtr handle, int cls, int size) {
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      int ret;
      int status = NtQueryObject(handle, cls, buf, size, out ret);
      if (status != 0) {
        return string.Empty;
      }
      return ReadUnicodeString(buf);
    } finally {
      Marshal.FreeHGlobal(buf);
    }
  }

  // 带超时的名字查询：某些同步管道句柄会让 NtQueryObject 卡死
  static string QueryNameSafe(IntPtr handle) {
    string result = null;
    Thread t = new Thread(delegate() {
      result = QueryName(handle, ObjectNameInformation, 4096);
    });
    t.IsBackground = true;
    t.Start();
    if (!t.Join(40)) {
      return null;
    }
    return result;
  }

  public static List<string> Find(string target, out int scanned, out int fileHandles) {
    List<string> hits = new List<string>();
    scanned = 0;
    fileHandles = 0;
    string lowerTarget = target.TrimEnd('\\\\').ToLowerInvariant();

    Dictionary<string, string> devices = new Dictionary<string, string>();
    for (char c = 'A'; c <= 'Z'; c++) {
      StringBuilder sb = new StringBuilder(1024);
      if (QueryDosDevice(c + ":", sb, sb.Capacity) != 0) {
        devices[sb.ToString().ToLowerInvariant()] = c + ":";
      }
    }

    int len = 16 * 1024 * 1024;
    IntPtr buf = IntPtr.Zero;
    int ret;
    int status = 0;
    for (int attempt = 0; attempt < 4; attempt++) {
      buf = Marshal.AllocHGlobal(len);
      status = NtQuerySystemInformation(SystemExtendedHandleInformation, buf, len, out ret);
      if (status == 0) {
        break;
      }
      Marshal.FreeHGlobal(buf);
      buf = IntPtr.Zero;
      len = ret + (4 * 1024 * 1024);
    }
    if (buf == IntPtr.Zero) {
      return hits;
    }

    int selfPid = Process.GetCurrentProcess().Id;
    IntPtr self = GetCurrentProcess();
    try {
      long count = (long)Marshal.ReadIntPtr(buf, 0);
      int entrySize = 40;
      int baseOff = IntPtr.Size * 2;
      Dictionary<int, IntPtr> opened = new Dictionary<int, IntPtr>();

      for (long i = 0; i < count; i++) {
        int off = baseOff + (int)(i * entrySize);
        int pid = (int)(long)Marshal.ReadIntPtr(buf, off + 8);
        IntPtr handleValue = Marshal.ReadIntPtr(buf, off + 16);
        if (pid <= 4 || pid == selfPid) {
          continue;
        }
        scanned++;

        IntPtr srcProc;
        if (!opened.TryGetValue(pid, out srcProc)) {
          srcProc = OpenProcess(PROCESS_DUP_HANDLE, false, pid);
          opened[pid] = srcProc;
        }
        if (srcProc == IntPtr.Zero) {
          continue;
        }

        IntPtr dup;
        if (!DuplicateHandle(srcProc, handleValue, self, out dup, 0, false, DUPLICATE_SAME_ACCESS)) {
          continue;
        }
        try {
          string typeName = QueryName(dup, ObjectTypeInformation, 1024);
          if (typeName != "File") {
            continue;
          }
          fileHandles++;
          string name = QueryNameSafe(dup);
          if (name == null || name.Length == 0) {
            continue;
          }
          string lower = name.ToLowerInvariant();
          string display = name;
          foreach (KeyValuePair<string, string> kv in devices) {
            if (lower.StartsWith(kv.Key)) {
              display = kv.Value + name.Substring(kv.Key.Length);
              lower = kv.Value.ToLowerInvariant() + lower.Substring(kv.Key.Length);
              break;
            }
          }
          if (lower == lowerTarget || lower.StartsWith(lowerTarget + "\\\\")) {
            string procName = "";
            try { procName = Process.GetProcessById(pid).ProcessName; } catch { }
            hits.Add(pid + "|" + procName + "|" + display);
          }
        } finally {
          CloseHandle(dup);
        }
      }

      foreach (KeyValuePair<int, IntPtr> kv in opened) {
        if (kv.Value != IntPtr.Zero) {
          CloseHandle(kv.Value);
        }
      }
    } finally {
      Marshal.FreeHGlobal(buf);
    }
    return hits;
  }
}
"@

$scanned = 0
$fileHandles = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$hits = [HandleScan]::Find($target, [ref]$scanned, [ref]$fileHandles)
$sw.Stop()
Write-Output ('STATS|' + $scanned + '|' + $fileHandles + '|' + $sw.ElapsedMilliseconds)
foreach ($hit in $hits) {
  Write-Output ('HIT|' + $hit)
}
`;
}

/**
 * 查询占用指定路径（含子路径）的进程
 * @param {string} target 目录或文件路径
 * @returns {Promise<{holders:Array<{pid:number,name:string,path:string}>,scanned:number,fileHandles:number,elapsed:number}>} 查询结果
 */
function findHolders(target) {
    const resolved = path.resolve(target);
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(resolved)) {
            reject(new Error('路径不存在：' + resolved));
            return;
        }
        const file = path.join(os.tmpdir(), 'folder-linker-scan-' + process.pid + '.ps1');
        fs.writeFileSync(file, '\uFEFF' + buildScanScript(resolved), 'utf8');

        const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', file], {
            windowsHide: true
        });
        let out = '';
        let err = '';
        let settled = false;
        const timer = setTimeout(() => {
            child.kill();
        }, SCAN_TIMEOUT_MS);

        child.stdout.on('data', (chunk) => {
            out += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
            err += chunk.toString('utf8');
        });
        child.on('error', (spawnErr) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(new Error('句柄扫描进程启动失败：' + spawnErr.message));
        });
        child.on('close', () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            const result = {holders: [], scanned: 0, fileHandles: 0, elapsed: 0};
            for (const line of out.split(/\r?\n/)) {
                const text = line.trim();
                if (text.startsWith('STATS|')) {
                    const parts = text.split('|');
                    result.scanned = Number(parts[1]) || 0;
                    result.fileHandles = Number(parts[2]) || 0;
                    result.elapsed = Number(parts[3]) || 0;
                } else if (text.startsWith('HIT|')) {
                    const parts = text.split('|');
                    result.holders.push({
                        pid: Number(parts[1]) || 0,
                        name: parts[2] || '',
                        path: parts.slice(3).join('|')
                    });
                }
            }
            if (result.holders.length === 0 && !result.scanned && err.trim()) {
                reject(new Error('句柄扫描失败：' + err.trim().slice(0, 300)));
                return;
            }
            resolve(result);
        });
    });
}

module.exports = {findHolders};
