// 测试用：支持 Range 请求的静态文件服务器（验证引擎分段下载逻辑）
const http = require('http');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'testfile.bin');
const SIZE = 20 * 1024 * 1024; // 20MB
const PORT = 18765;

if (!fs.existsSync(FILE)) {
  const fd = fs.openSync(FILE, 'w');
  const buf = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 7 + 13) & 0xff;
  for (let off = 0; off < SIZE; off += buf.length) fs.writeSync(fd, buf, 0, buf.length, off);
  fs.closeSync(fd);
  console.log('已生成测试文件', FILE);
}

http.createServer((req, res) => {
  // 任意路径都返回同一文件（用于测试中文 URL 的标题提取）
  const range = req.headers.range;
  const stat = fs.statSync(FILE);
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(FILE, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(FILE).pipe(res);
  }
}).listen(PORT, () => console.log(`测试服务器: http://127.0.0.1:${PORT}/testfile.bin`));
