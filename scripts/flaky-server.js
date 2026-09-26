// 测试用：不稳定网络模拟器
// 用法: node scripts/flaky-server.js [dropRate%] [failAboveByte]
// dropRate: 每个请求随机断流的概率（默认 0）
// failAboveByte: 起始位置大于该值的 Range 请求一律断流（模拟持续故障）
const http = require('http');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'testfile.bin');
const SIZE = 20 * 1024 * 1024;
const PORT = 18766;
const dropRate = Number(process.argv[2] || 0) / 100;
const failAbove = Number(process.argv[3] || Infinity);

if (!fs.existsSync(FILE)) {
  const fd = fs.openSync(FILE, 'w');
  const buf = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 7 + 13) & 0xff;
  for (let off = 0; off < SIZE; off += buf.length) fs.writeSync(fd, buf, 0, buf.length, off);
  fs.closeSync(fd);
}

let drops = 0, ok = 0;
http.createServer((req, res) => {
  const range = req.headers.range || '';
  const start = Number((range.match(/bytes=(\d+)/) || [])[1] || 0);
  const stat = fs.statSync(FILE);

  // 持续故障区间
  if (start > failAbove) {
    drops++;
    res.destroy();
    return;
  }
  // 随机断流
  if (dropRate > 0 && Math.random() < dropRate) {
    drops++;
    res.destroy();
    return;
  }
  ok++;
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    const s = Number(m[1]);
    const e = m[2] ? Number(m[2]) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${s}-${e}/${stat.size}`,
      'Content-Length': e - s + 1,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(FILE, { start: s, end: e }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(FILE).pipe(res);
  }
}).listen(PORT, () => console.log(`flaky 服务器: http://127.0.0.1:${PORT}/testfile.bin (dropRate=${dropRate * 100}%, failAbove=${failAbove})`));
