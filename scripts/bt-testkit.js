// CDown - BitTorrent 本地测试套件
// 用途：在不依赖公网的前提下，用 aria2c 自己搭「做种端 + 下载端」，验证 BT 下载链路。
//   - 生成确定性测试文件
//   - 手工构造 .torrent（bencode，单文件模式）
//   - 起一个最小 HTTP tracker（BEP-3 announce，compact 响应）
//   - 一个 aria2c 做种，另一个 aria2c 下载
// 这样整条链路（元数据解析 / 分片校验 / peer 交换 / 落盘）都是真实跑通的。
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// ---------- bencode ----------
function bencode(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  if (typeof v === 'string') return bencode(Buffer.from(v, 'utf8'));
  if (typeof v === 'number') return Buffer.from(`i${v}e`);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')]);
  const keys = Object.keys(v).sort();
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap(k => [bencode(k), bencode(v[k])]), Buffer.from('e')]);
}
function bdecode(buf, pos = 0) {
  const c = String.fromCharCode(buf[pos]);
  if (c === 'i') { const e = buf.indexOf(0x65, pos); return [Number(buf.slice(pos + 1, e).toString()), e + 1]; }
  if (c === 'l') {
    const out = []; let p = pos + 1;
    while (buf[p] !== 0x65) { const [v, np] = bdecode(buf, p); out.push(v); p = np; }
    return [out, p + 1];
  }
  if (c === 'd') {
    const out = {}; let p = pos + 1;
    while (buf[p] !== 0x65) {
      const [k, np1] = bdecode(buf, p);
      const [v, np2] = bdecode(buf, np1);
      out[Buffer.isBuffer(k) ? k.toString('utf8') : k] = v; p = np2;
    }
    return [out, p + 1];
  }
  const colon = buf.indexOf(0x3a, pos);
  const len = Number(buf.slice(pos, colon).toString());
  return [buf.slice(colon + 1, colon + 1 + len), colon + 1 + len];
}

// ---------- 生成测试文件 ----------
function makePayload(file, size) {
  if (fs.existsSync(file) && fs.statSync(file).size === size) return;
  const fd = fs.openSync(file, 'w');
  const chunk = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 17 + 29) & 0xff;
  for (let off = 0; off < size; off += chunk.length) fs.writeSync(fd, chunk, 0, Math.min(chunk.length, size - off), off);
  fs.closeSync(fd);
}

// ---------- 构造单文件 torrent ----------
function makeTorrent({ file, name, announce, pieceLength = 256 * 1024 }) {
  const size = fs.statSync(file).size;
  const pieces = [];
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(pieceLength);
  for (let off = 0; off < size; off += pieceLength) {
    const n = fs.readSync(fd, buf, 0, Math.min(pieceLength, size - off), off);
    pieces.push(crypto.createHash('sha1').update(buf.slice(0, n)).digest());
  }
  fs.closeSync(fd);
  const info = { length: size, name, 'piece length': pieceLength, pieces: Buffer.concat(pieces) };
  const raw = bencode({ announce, 'created by': 'cdown-bt-testkit', info });
  return { raw, info, infoHash: crypto.createHash('sha1').update(bencode(info)).digest() };
}

// 申请一个真正空闲的 TCP 端口。
// 重要：不能硬编码端口。本沙箱对某些端口（实测 55555）恒返回 EADDRINUSE，
// 即使没有任何进程占用，且 lsof 也查不到。硬编码端口会得到极难定位的
// "failed to bind TCP port" + "Download not complete" 假故障。
function freePort() {
  return new Promise((resolve, reject) => {
    const s = require('net').createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// ---------- 最小 HTTP tracker ----------
// 只做 BEP-3 的 announce：记录 peer，返回 compact 格式的 peer 列表。
// 默认广播 127.0.0.1：aria2 并不过滤回环 peer
// （日志里的 "Not considered: 127.0.0.1" 是 DHT 对本机地址的自过滤，与 peer 无关）。
function lanIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

function startTracker(onAnnounce, peerIP = '127.0.0.1') {
  const swarms = new Map(); // infoHash hex -> Map(peerKey -> {ip, port})
  let logged = 0;
  const server = http.createServer((req, res) => {
    const qs = (req.url || '').split('?')[1] || '';
    const q = {};
    for (const kv of qs.split('&')) {
      const i = kv.indexOf('=');
      if (i < 0) continue;
      const k = decodeURIComponent(kv.slice(0, i));
      // info_hash / peer_id 是二进制，必须按字节解析而不是当 UTF-8 字符串。
      // 注意 charCodeAt(j) —— 写成 charCodeAt(0) 会让每个字节都变成首字符，
      // 例如 port=51413 会被解析成 55555，进而去连一个根本不存在的端口。
      const raw = [];
      const v = kv.slice(i + 1);
      for (let j = 0; j < v.length; j++) {
        if (v[j] === '%') { raw.push(parseInt(v.substr(j + 1, 2), 16)); j += 2; }
        else if (v[j] === '+') raw.push(32);
        else raw.push(v.charCodeAt(j));
      }
      q[k] = Buffer.from(raw);
    }
    if (!q.info_hash) { res.writeHead(400); return res.end('bad request'); }
    const ih = q.info_hash.toString('hex');
    const port = Number(q.port.toString());
    const ip = peerIP;
    const event = q.event ? q.event.toString('latin1') : '';
    if (!swarms.has(ih)) swarms.set(ih, new Map());
    const swarm = swarms.get(ih);
    if (event === 'stopped') swarm.delete(`${ip}:${port}`);
    else swarm.set(`${ip}:${port}`, { ip, port });
    if (logged < 3) {
      logged++;
      console.log(`  [tracker] raw=${qs.slice(0, 150)}`);
      console.log(`  [tracker] infoHash=${ih.slice(0, 12)}… peer=${ip}:${port} event=${event || '-'} swarm=${swarm.size}`);
    }
    // compact：每个 peer 6 字节（4 字节 IP + 2 字节端口，大端）
    const peers = [];
    for (const p of swarm.values()) {
      peers.push(Buffer.from([...p.ip.split('.').map(Number), (p.port >> 8) & 0xff, p.port & 0xff]));
    }
    if (onAnnounce) onAnnounce({ infoHash: ih, port, event, peers: swarm.size });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(bencode({ interval: 2, 'min interval': 1, complete: swarm.size, incomplete: 0, peers: Buffer.concat(peers) }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, peerIP })));
}

module.exports = { bencode, bdecode, makePayload, makeTorrent, startTracker, freePort };
