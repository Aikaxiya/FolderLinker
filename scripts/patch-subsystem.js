'use strict';

const fs = require('fs');
const path = require('path');

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;
const SUBSYSTEM_NAMES = {
    1: 'NATIVE',
    2: 'WINDOWS_GUI',
    3: 'WINDOWS_CUI (控制台，会弹黑窗)',
    5: 'OS2_CUI',
    7: 'POSIX_CUI',
    9: 'WINDOWS_CE_GUI',
    10: 'EFI_APPLICATION',
    16: 'WINDOWS_BOOT_APPLICATION'
};

/**
 * 读取 PE 头中的子系统字段
 * @param {Buffer} buf 文件内容
 * @returns {{offset:number,value:number,magic:number}} 字段位置与当前值
 */
function readSubsystem(buf) {
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
        throw new Error('不是有效的 PE 文件：缺少 MZ 头');
    }
    const peOffset = buf.readUInt32LE(0x3c);
    if (peOffset + 0x60 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
        throw new Error('不是有效的 PE 文件：缺少 PE 签名');
    }
    const optionalHeader = peOffset + 24;
    const magic = buf.readUInt16LE(optionalHeader);
    if (magic !== 0x10b && magic !== 0x20b) {
        throw new Error('未知的可选头格式：0x' + magic.toString(16));
    }
    const offset = optionalHeader + 68;
    return {offset, value: buf.readUInt16LE(offset), magic};
}

/**
 * 将可执行文件标记为 GUI 子系统，运行时不弹控制台窗口
 * @param {string} file 可执行文件路径
 * @returns {{changed:boolean,before:number,after:number}} 处理结果
 */
function patchToGui(file) {
    const buf = fs.readFileSync(file);
    const info = readSubsystem(buf);
    if (info.value === IMAGE_SUBSYSTEM_WINDOWS_GUI) {
        return {changed: false, before: info.value, after: info.value};
    }
    if (info.value !== IMAGE_SUBSYSTEM_WINDOWS_CUI) {
        throw new Error('子系统为 ' + info.value + '，不在预期范围内，已中止');
    }
    buf.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, info.offset);
    fs.writeFileSync(file, buf);
    return {changed: true, before: info.value, after: IMAGE_SUBSYSTEM_WINDOWS_GUI};
}

const target = process.argv[2] || path.join(__dirname, '..', 'dist', 'FolderLinker.exe');

if (!fs.existsSync(target)) {
    console.error('找不到文件：' + target);
    process.exit(1);
}

try {
    const result = patchToGui(target);
    const label = (code) => code + ' ' + (SUBSYSTEM_NAMES[code] || '未知');
    if (result.changed) {
        console.log('子系统已修改：' + label(result.before) + '  ->  ' + label(result.after));
    } else {
        console.log('子系统已是 GUI，无需修改：' + label(result.after));
    }
    console.log('文件：' + target);
} catch (err) {
    console.error('处理失败：' + err.message);
    process.exit(1);
}
