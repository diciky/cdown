#!/usr/bin/env python3
"""按 zip 中央目录里的 S_IFLNK 标记，精确重建 macOS .app bundle 内的符号链接。

背景：沙箱环境下 ditto/unzip 无法创建符号链接，会把链接目标写成普通文件内容，
导致 Electron.app 启动时 dyld 报 `Library not loaded: @rpath/Electron Framework.framework/...`。
本脚本只做「删掉占位文件 + 建回符号链接」，不碰其它内容。
"""
import os
import stat
import sys
import zipfile

ZIP = sys.argv[1]
DEST = sys.argv[2]


def main() -> int:
    zf = zipfile.ZipFile(ZIP)
    links = []
    for info in zf.infolist():
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            links.append((info.filename, zf.read(info).decode('utf-8')))

    if not links:
        print('zip 中没有符号链接条目')
        return 1

    fixed = 0
    failed = 0
    for name, target in links:
        path = os.path.join(DEST, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # 占位文件（ditto 写成的普通文件）先删掉
        if os.path.islink(path):
            os.remove(path)
        elif os.path.exists(path):
            os.remove(path)
        try:
            os.symlink(target, path)
            fixed += 1
        except OSError as e:
            print(f'  失败 {name}: {e}')
            failed += 1

    print(f'符号链接: 重建 {fixed} 个, 失败 {failed} 个 (共 {len(links)})')
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
