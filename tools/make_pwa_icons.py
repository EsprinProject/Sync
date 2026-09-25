"""从仓库根目录的 favicon.png 生成 PWA 图标。

产物（都落在仓库根目录）：
  icon-192.png            Android / 桌面安装提示用的 192px 图标
  icon-512.png            512px 图标（应用列表、启动画面）
  icon-512-maskable.png   512px 自适应图标：按源图边框色铺满画布，图形缩到 66% 居中
  icon-180.png            iOS 的 apple-touch-icon

源图是 1024×1024 的 RGBA 图像、四角透明，因此只做面积平均缩放即可，
不依赖 Pillow（纯 zlib + struct 解码 / 编码）。

用法：python tools/make_pwa_icons.py
"""

import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "favicon.png")
MASKABLE_SCALE = 0.66


def read_png(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} 不是 PNG 文件")

    pos, idat = 8, b""
    width = height = 0
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, depth, color, _comp, _filt, interlace = struct.unpack(">IIBBBBB", chunk)
            if (depth, color, interlace) != (8, 6, 0):
                raise ValueError(f"只支持非隔行的 8 位 RGBA：depth={depth} color={color} interlace={interlace}")
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break

    return width, height, unfilter(zlib.decompress(idat), width, height)


def unfilter(raw, width, height):
    stride = width * 4
    rows, prev, offset = [], bytearray(stride), 0
    for _ in range(height):
        filter_type = raw[offset]
        offset += 1
        line = bytearray(raw[offset:offset + stride])
        offset += stride
        if filter_type == 1:
            for i in range(4, stride):
                line[i] = (line[i] + line[i - 4]) & 0xFF
        elif filter_type == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif filter_type == 3:
            for i in range(stride):
                left = line[i - 4] if i >= 4 else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif filter_type == 4:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                b = prev[i]
                c = prev[i - 4] if i >= 4 else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        rows.append(line)
        prev = line
    return rows


def write_png(path, width, height, rows):
    raw = bytearray()
    for line in rows:
        raw.append(0)
        raw.extend(line)

    def chunk(ctype, payload):
        crc = zlib.crc32(ctype + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + ctype + payload + struct.pack(">I", crc)

    body = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))
    with open(path, "wb") as handle:
        handle.write(body)


def resize_area(source_width, source_height, rows, width, height):
    """面积平均缩小：RGBA 先在预乘空间里平均，透明边角不会把颜色拖黑"""
    result = []
    x_ratio = source_width / width
    y_ratio = source_height / height
    for dy in range(height):
        top, bottom = dy * y_ratio, (dy + 1) * y_ratio
        first_y, last_y = max(0, int(top)), min(source_height - 1, int(bottom - 1e-9))
        line = bytearray()
        for dx in range(width):
            left, right = dx * x_ratio, (dx + 1) * x_ratio
            first_x, last_x = max(0, int(left)), min(source_width - 1, int(right - 1e-9))
            r = g = b = a = total = 0.0
            for sy in range(first_y, last_y + 1):
                weight_y = min(sy + 1, bottom) - max(sy, top)
                if weight_y <= 0:
                    continue
                row = rows[sy]
                for sx in range(first_x, last_x + 1):
                    weight_x = min(sx + 1, right) - max(sx, left)
                    if weight_x <= 0:
                        continue
                    weight = weight_x * weight_y
                    i = sx * 4
                    alpha = row[i + 3]
                    r += row[i] * alpha * weight
                    g += row[i + 1] * alpha * weight
                    b += row[i + 2] * alpha * weight
                    a += alpha * weight
                    total += weight
            if a > 0:
                line += bytes((round(r / a), round(g / a), round(b / a), round(a / total)))
            else:
                line += b"\x00\x00\x00\x00"
        result.append(line)
    return result


def make_maskable(source_width, source_height, rows, background, size=512, scale=MASKABLE_SCALE):
    """自适应图标：整块画布铺源图边框色，图形缩到 scale 居中 —— 被系统裁成圆形也不伤到图形"""
    inner = round(size * scale)
    art = resize_area(source_width, source_height, rows, inner, inner)
    offset = (size - inner) // 2
    blank = bytearray(background * size)
    canvas = [bytearray(blank) for _ in range(size)]
    for y in range(inner):
        target = canvas[y + offset]
        source_line = art[y]
        for x in range(inner):
            i = x * 4
            alpha = source_line[i + 3]
            if alpha == 0:
                continue
            j = (x + offset) * 4
            if alpha == 255:
                target[j:j + 4] = source_line[i:i + 4]
                continue
            for k in range(3):
                target[j + k] = (source_line[i + k] * alpha + target[j + k] * (255 - alpha)) // 255
            target[j + 3] = max(target[j + 3], alpha)
    return canvas


def main():
    width, height, rows = read_png(SOURCE)
    print(f"[INFO] [Icons] Source: {os.path.basename(SOURCE)} {width}x{height}")

    # 源图四边透明、圆角以内是纯色底：取上边框中央那一像素当自适应图标的底色
    border = bytes(rows[4][width // 2 * 4:width // 2 * 4 + 4])

    for size in (192, 512, 180):
        name = f"icon-{size}.png"
        write_png(os.path.join(ROOT, name), size, size, resize_area(width, height, rows, size, size))
        print(f"[INFO] [Icons] Written: {name} ({size}x{size})")

    name = "icon-512-maskable.png"
    write_png(os.path.join(ROOT, name), 512, 512, make_maskable(width, height, rows, border))
    print(f"[INFO] [Icons] Written: {name} (512x512, maskable, scale={MASKABLE_SCALE})")


if __name__ == "__main__":
    main()
