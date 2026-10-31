'use strict';

const zlib = require('zlib');

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

/**
 * 计算 CRC32
 * @param {Buffer} buf 数据
 * @returns {number} 校验值
 */
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

/**
 * Paeth 预测器
 * @param {number} a 左
 * @param {number} b 上
 * @param {number} c 左上
 * @returns {number} 预测值
 */
function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) {
        return a;
    }
    if (pb <= pc) {
        return b;
    }
    return c;
}

/**
 * 解码 8 位 RGB/RGBA 的 PNG
 * @param {Buffer} buf PNG 内容
 * @returns {{width:number,height:number,data:Buffer}} RGBA 像素
 */
function decodePng(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) {
        throw new Error('不是有效的 PNG');
    }
    let offset = 8;
    let width = 0;
    let height = 0;
    let colorType = 0;
    let bitDepth = 0;
    const idat = [];

    while (offset < buf.length) {
        const length = buf.readUInt32BE(offset);
        const type = buf.toString('ascii', offset + 4, offset + 8);
        const data = buf.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data.readUInt8(8);
            colorType = data.readUInt8(9);
            if (data.readUInt8(12) !== 0) {
                throw new Error('暂不支持隔行扫描的 PNG');
            }
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset += length + 12;
    }

    if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
        throw new Error('暂只支持 8 位 RGB/RGBA 的 PNG');
    }

    const channels = colorType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const pixels = Buffer.alloc(height * stride);

    let pos = 0;
    for (let y = 0; y < height; y += 1) {
        const filter = raw[pos];
        pos += 1;
        const rowStart = y * stride;
        const prevStart = (y - 1) * stride;
        for (let x = 0; x < stride; x += 1) {
            const value = raw[pos + x];
            const left = x >= channels ? pixels[rowStart + x - channels] : 0;
            const up = y > 0 ? pixels[prevStart + x] : 0;
            const upLeft = y > 0 && x >= channels ? pixels[prevStart + x - channels] : 0;
            let result;
            if (filter === 0) {
                result = value;
            } else if (filter === 1) {
                result = value + left;
            } else if (filter === 2) {
                result = value + up;
            } else if (filter === 3) {
                result = value + ((left + up) >> 1);
            } else if (filter === 4) {
                result = value + paeth(left, up, upLeft);
            } else {
                throw new Error('未知的行过滤类型：' + filter);
            }
            pixels[rowStart + x] = result & 0xff;
        }
        pos += stride;
    }

    if (channels === 4) {
        return {width, height, data: pixels};
    }

    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
        rgba[i * 4] = pixels[i * 3];
        rgba[i * 4 + 1] = pixels[i * 3 + 1];
        rgba[i * 4 + 2] = pixels[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
    }
    return {width, height, data: rgba};
}

/**
 * 生成 PNG 数据块
 * @param {string} type 块类型
 * @param {Buffer} data 块内容
 * @returns {Buffer} 完整块
 */
function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/**
 * 编码 RGBA 像素为 PNG
 * @param {number} width 宽
 * @param {number} height 高
 * @param {Buffer} rgba 像素数据
 * @returns {Buffer} PNG 内容
 */
function encodePng(width, height, rgba) {
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * (stride + 1)] = 0;
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.writeUInt8(8, 8);
    ihdr.writeUInt8(6, 9);
    ihdr.writeUInt8(0, 10);
    ihdr.writeUInt8(0, 11);
    ihdr.writeUInt8(0, 12);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, {level: 9})),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

/**
 * 按面积平均缩放 RGBA 图像，保留透明边缘质量
 * @param {{width:number,height:number,data:Buffer}} src 源图
 * @param {number} dw 目标宽
 * @param {number} dh 目标高
 * @returns {Buffer} 目标 RGBA
 */
function resizeArea(src, dw, dh) {
    const sw = src.width;
    const sh = src.height;
    const data = src.data;
    const out = Buffer.alloc(dw * dh * 4);
    const xRatio = sw / dw;
    const yRatio = sh / dh;

    for (let y = 0; y < dh; y += 1) {
        const sy0 = y * yRatio;
        const sy1 = Math.min(sh, (y + 1) * yRatio);
        for (let x = 0; x < dw; x += 1) {
            const sx0 = x * xRatio;
            const sx1 = Math.min(sw, (x + 1) * xRatio);
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let weightSum = 0;
            for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy += 1) {
                const wy = Math.min(sy1, sy + 1) - Math.max(sy0, sy);
                if (wy <= 0) {
                    continue;
                }
                for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx += 1) {
                    const wx = Math.min(sx1, sx + 1) - Math.max(sx0, sx);
                    if (wx <= 0) {
                        continue;
                    }
                    const weight = wx * wy;
                    const index = (sy * sw + sx) * 4;
                    const alpha = data[index + 3] / 255;
                    r += data[index] * alpha * weight;
                    g += data[index + 1] * alpha * weight;
                    b += data[index + 2] * alpha * weight;
                    a += alpha * weight;
                    weightSum += weight;
                }
            }
            const target = (y * dw + x) * 4;
            if (a > 0) {
                out[target] = Math.round(r / a);
                out[target + 1] = Math.round(g / a);
                out[target + 2] = Math.round(b / a);
            }
            out[target + 3] = Math.round((a / weightSum) * 255);
        }
    }
    return out;
}

module.exports = {decodePng, encodePng, resizeArea};
