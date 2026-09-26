#!/usr/bin/env bash
# CI 用：按平台下载静态 ffmpeg 到 bin/（HLS 合并用）
set -e
mkdir -p bin
case "$RUNNER_OS" in
  Windows)
    echo "下载 Windows ffmpeg (BtbN GPL build)..."
    curl -sL -o /tmp/ffmpeg.zip https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip
    unzip -j -o /tmp/ffmpeg.zip "*/bin/ffmpeg.exe" -d bin
    ;;
  Linux)
    echo "下载 Linux ffmpeg (johnvansickle static)..."
    curl -sL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar -xJ -C /tmp
    find /tmp -name ffmpeg -type f -exec cp {} bin/ffmpeg \;
    chmod +x bin/ffmpeg
    ;;
  macOS)
    echo "下载 macOS ffmpeg (evermeet static)..."
    curl -sL -o /tmp/ffmpeg.zip https://evermeet.cx/ffmpeg/getrelease/zip
    unzip -o /tmp/ffmpeg.zip -d bin
    ;;
  *)
    echo "未知平台 $RUNNER_OS，跳过 ffmpeg"
    ;;
esac
ls -la bin/
