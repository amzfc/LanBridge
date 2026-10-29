'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const selfsigned = require('selfsigned');

const PORT = 53319;
const MAX_FILES = 10000;
const MAX_BYTES = 10 * 1024 ** 4;
const MAX_JSON = 1024 * 1024;
const MAX_FILE = 10 * 1024 ** 4;
const PAIR_TTL = 120000;
const OFFER_TTL = 10 * 60000;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const shortId = data => hash(Buffer.from(data)).slice(0, 16).toUpperCase().match(/.{1,4}/g).join('-');
const safeName = s => typeof s === 'string' && s.length > 0 && Buffer.byteLength(s) <= 200 && s !== '.' && s !== '..' && !/[<>:"/\\|?*\u0000-\u001f]/.test(s) && !/[. ]$/.test(s) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(s);
function safeRel(p) {
  assert(typeof p === 'string' && p.length <= 1500, '文件路径不合法');
  const parts = p.split('/');
  assert(parts.length <= 64 && parts.every(safeName), '文件名不适合在 Mac 和 Windows 间传输');
  return parts;
}
function parseAddress(value) {
  assert(typeof value === 'string', '请输入 IP 地址');
  const match = value.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?$/);
  assert(match, '请输入局域网 IPv4 地址，例如 192.168.1.23');
  const n = match.slice(1, 5).map(Number);
  assert(n.every(v => v <= 255), 'IP 地址不合法');
  assert(n[0] === 10 || n[0] === 127 || n[0] === 192 && n[1] === 168 || n[0] === 172 && n[1] >= 16 && n[1] <= 31 || n[0] === 169 && n[1] === 254, '仅支持同一局域网的私有 IP');
  const port = match[5] ? Number(match[5]) : PORT;
  assert(port > 0 && port < 65536, '端口不合法');
  return { host: n.join('.'), port };
}
function deviceIps() {
  return Object.values(os.networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal).map(x => x.address);
}
function peerFingerprint(socket) {
  const cert = socket.getPeerCertificate(true);
  return cert?.raw ? hash(cert.raw) : null;
}
function pairingSas(a, b) {
  return shortId([a, b].sort().join(':'));
}
function body(req, max = MAX_JSON) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > max) { reject(new Error('请求过大')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('请求格式错误')); } });
    req.on('error', reject);
  });
}
function send(res, status, data) {
  if (res.destroyed || res.headersSent) return;
  const json = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json), 'Cache-Control': 'no-store' });
  res.end(json);
}
function uniquePath(folder, name) {
  const parsed = path.parse(name);
  let out = path.join(folder, name); let index = 2;
  while (fs.existsSync(out)) out = path.join(folder, `${parsed.name} (${index++})${parsed.ext}`);
  return out;
}
async function listItems(selected) {
  assert(Array.isArray(selected) && selected.length > 0 && selected.length <= 100, '请先选择文件或文件夹');
  const entries = []; const used = new Set(); let total = 0;
  async function walk(full, rel, depth) {
    assert(depth <= 64, '文件夹层级过深');
    const st = await fsp.lstat(full);
    assert(!st.isSymbolicLink(), '暂不支持符号链接');
    if (st.isDirectory()) {
      entries.push({ path: rel, type: 'directory', size: 0 });
      for (const child of await fsp.readdir(full)) {
        safeRel(`${rel}/${child}`);
        await walk(path.join(full, child), `${rel}/${child}`, depth + 1);
      }
    } else {
      assert(st.isFile(), '只能发送普通文件和文件夹');
      total += st.size;
      assert(st.size <= MAX_FILE && total <= MAX_BYTES, '单次传输最多 10 TB');
      entries.push({ path: rel, type: 'file', size: st.size, source: full, mtimeMs: st.mtimeMs });
    }
    assert(entries.length <= MAX_FILES, '单次传输最多 10000 个项目');
  }
  for (const full of selected) {
    const base = path.basename(full);
    safeRel(base);
    const folded = base.normalize('NFC').toLowerCase();
    assert(!used.has(folded), '所选文件存在同名项目'); used.add(folded);
    await walk(full, base, 0);
  }
  return { entries, total };
}
function validateManifest(entries) {
  assert(Array.isArray(entries) && entries.length > 0 && entries.length <= MAX_FILES, '文件清单不合法');
  const used = new Set(); let total = 0;
  for (const entry of entries) {
    assert(entry && (entry.type === 'file' || entry.type === 'directory'), '文件清单不合法');
    safeRel(entry.path);
    const folded = entry.path.normalize('NFC').toLowerCase();
    assert(!used.has(folded), '文件清单有同名项目'); used.add(folded);
    assert(Number.isSafeInteger(entry.size) && entry.size >= 0 && (entry.type === 'file' || entry.size === 0), '文件大小不合法');
    total += entry.size;
    assert(total <= MAX_BYTES, '单次传输最多 10 TB');
  }
  return total;
}
class LanBridge {
  constructor({ dataDir, downloadDir, name = os.hostname(), onChange = () => {}, port = PORT }) {
    this.dataDir = dataDir; this.downloadDir = downloadDir; this.name = String(name).slice(0, 60); this.onChange = onChange; this.port = port;
    this.peers = []; this.incomingPairs = new Map(); this.outgoingPairs = new Map();
    this.incoming = new Map(); this.outgoing = new Map(); this.attempts = new Map(); this.events = [];
    this.pairCode = String(crypto.randomInt(100000, 1000000)); this.pairExpires = Date.now() + 10 * 60000;
  }
  emit() { this.onChange(this.snapshot()); }
  progress(t) { if (!t.lastEmit || Date.now() - t.lastEmit >= 120) { t.lastEmit = Date.now(); this.emit(); } }
  snapshot() {
    return { name: this.name, ips: deviceIps(), port: this.port, pairCode: this.pairCode, pairExpires: this.pairExpires,
      fingerprint: this.fingerprint, downloadDir: this.downloadDir,
      peers: this.peers.map(({ id, name, address }) => ({ id, name, address })),
      incomingPairs: [...this.incomingPairs.values()].map(({ id, name, sas, created, status }) => ({ id, name, sas, created, status })),
      outgoingPairs: [...this.outgoingPairs.values()].map(({ id, name, sas, status, address }) => ({ id, name, sas, status, address })),
      transfers: [...this.incoming.values(), ...this.outgoing.values()].map(({ id, name, direction, status, total, done, peerName, error, destination }) => ({ id, name, direction, status, total, done, peerName, error, destination })),
      events: this.events.slice(-30) };
  }
  event(text) { this.events.push({ at: Date.now(), text }); if (this.events.length > 30) this.events.shift(); this.emit(); }
  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(this.downloadDir, { recursive: true });
    const identityPath = path.join(this.dataDir, 'identity.json');
    let identity;
    try { identity = JSON.parse(await fsp.readFile(identityPath, 'utf8')); }
    catch {
      const generated = await selfsigned.generate([{ name: 'commonName', value: 'LanBridge Device' }], { keySize: 2048, days: 3650, algorithm: 'sha256' });
      identity = { cert: generated.cert, key: generated.private };
      await fsp.writeFile(identityPath, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
    }
    this.cert = identity.cert; this.key = identity.key;
    this.fingerprint = hash(new crypto.X509Certificate(this.cert).raw);
    try { this.peers = JSON.parse(await fsp.readFile(path.join(this.dataDir, 'peers.json'), 'utf8')); }
    catch { this.peers = []; }
    this.server = https.createServer({ key: this.key, cert: this.cert, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.2' }, (req, res) => this.route(req, res).catch(err => send(res, 400, { error: err.message })));
    this.server.requestTimeout = 0; this.server.headersTimeout = 60000;
    await new Promise((resolve, reject) => this.server.once('error', reject).listen(this.port, '0.0.0.0', resolve));
    this.port = this.server.address().port;
    this.emit();
  }
  async close() { for (const t of this.outgoing.values()) t.abort?.abort(); await new Promise(resolve => this.server.close(resolve)); }
  async savePeers() { await fsp.writeFile(path.join(this.dataDir, 'peers.json'), JSON.stringify(this.peers), { mode: 0o600 }); this.emit(); }
  remember(peer) {
    assert(peer && /^[0-9a-f]{64}$/.test(peer.id), '设备身份不合法');
    const existing = this.peers.find(x => x.id === peer.id);
    if (existing) Object.assign(existing, peer); else this.peers.push(peer);
    return this.savePeers();
  }
  regenerateCode() { this.pairCode = String(crypto.randomInt(100000, 1000000)); this.pairExpires = Date.now() + 10 * 60000; this.emit(); return this.pairCode; }
  async request(address, method, url, { data, stream, pin, onProgress, timeout = 15000, signal } = {}) {
    const { host, port } = parseAddress(address);
    return new Promise((resolve, reject) => {
      let done = false; let buffers = []; let length = 0;
      const req = https.request({ host, port, method, path: url, key: this.key, cert: this.cert, rejectUnauthorized: false, minVersion: 'TLSv1.2', agent: false, timeout,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(data)) } : stream ? { 'Content-Type': 'application/octet-stream', 'Content-Length': stream.size } : {} }, res => {
        res.on('data', b => { length += b.length; if (length > MAX_JSON) req.destroy(new Error('响应过大')); else buffers.push(b); });
        res.on('end', () => { if (done) return; done = true; try { const obj = JSON.parse(Buffer.concat(buffers).toString() || '{}'); if (res.statusCode >= 400) reject(new Error(obj.error || `HTTP ${res.statusCode}`)); else resolve(obj); } catch { reject(new Error('响应格式错误')); } });
      });
      req.on('socket', socket => socket.on('secureConnect', () => {
        const found = peerFingerprint(socket);
        if (!found || pin && found !== pin) req.destroy(new Error('对方设备身份与配对记录不一致'));
      }));
      req.on('timeout', () => req.destroy(new Error('连接超时')));
      req.on('error', e => { if (!done) { done = true; reject(e); } });
      if (signal) {
        if (signal.aborted) req.destroy(new Error('已取消'));
        else signal.addEventListener('abort', () => req.destroy(new Error('已取消')), { once: true });
      }
      if (data) req.end(JSON.stringify(data));
      else if (stream) {
        const source = fs.createReadStream(stream.source);
        source.on('data', b => onProgress?.(b.length));
        source.on('error', e => req.destroy(e));
        source.pipe(req);
      } else req.end();
    });
  }
  async pair(address, code) {
    assert(/^\d{6}$/.test(code), '请输入六位配对码');
    const { host, port } = parseAddress(address);
    const target = `${host}:${port}`;
    const result = await this.request(target, 'POST', '/pair', { data: { code, name: this.name, port: this.port } });
    assert(result.fingerprint && /^[0-9a-f]{64}$/.test(result.fingerprint), '对方身份不合法');
    const pair = { id: result.id, name: result.name, sas: pairingSas(this.fingerprint, result.fingerprint), fingerprint: result.fingerprint, status: 'waiting', address: target, created: Date.now() };
    assert(pair.sas === result.sas, '配对校验码不一致');
    this.outgoingPairs.set(pair.id, pair); this.emit();
    this.pollPair(pair); return pair.id;
  }
  async pollPair(pair) {
    while (pair.status === 'waiting' && Date.now() - pair.created < PAIR_TTL) {
      await new Promise(r => setTimeout(r, 1200));
      try {
        const answer = await this.request(pair.address, 'GET', `/pair/${pair.id}`, { pin: pair.fingerprint });
        if (answer.status !== 'waiting') { pair.status = answer.status; this.emit(); break; }
      } catch (e) { pair.error = e.message; this.emit(); }
    }
    if (pair.status === 'waiting') { pair.status = 'expired'; this.emit(); }
  }
  async confirmPair(id) {
    const pair = this.outgoingPairs.get(id);
    assert(pair && pair.status === 'approved', '请等待对方确认配对');
    await this.remember({ id: pair.fingerprint, name: pair.name, address: pair.address });
    this.outgoingPairs.delete(id); this.event(`已与 ${pair.name} 配对`);
  }
  async decidePair(id, approve) {
    const pair = this.incomingPairs.get(id);
    assert(pair && pair.status === 'waiting' && Date.now() - pair.created < PAIR_TTL, '配对请求已过期');
    pair.status = approve ? 'approved' : 'rejected';
    if (approve) await this.remember({ id: pair.fingerprint, name: pair.name, address: pair.address });
    this.event(approve ? `已信任 ${pair.name}` : `已拒绝 ${pair.name} 的配对`);
  }
  async forget(id) { this.peers = this.peers.filter(p => p.id !== id); await this.savePeers(); }
  async route(req, res) {
    const url = new URL(req.url, 'https://local');
    const fp = peerFingerprint(req.socket);
    const isPaired = !!fp && this.peers.some(x => x.id === fp);
    if (req.method === 'POST' && url.pathname === '/pair') {
      const data = await body(req, 2048);
      const ip = req.socket.remoteAddress;
      const recent = (this.attempts.get(ip) || []).filter(t => t > Date.now() - 60000);
      recent.push(Date.now()); this.attempts.set(ip, recent);
      assert(recent.length <= 5, '配对尝试太频繁，请稍后重试');
      assert(fp && data.code === this.pairCode && Date.now() < this.pairExpires, '配对码错误或已过期');
      assert(typeof data.name === 'string' && data.name.length <= 60, '设备名称不合法');
      assert(Number.isSafeInteger(data.port) && data.port > 0 && data.port < 65536, '设备端口不合法');
      const remoteIp = req.socket.remoteAddress.replace(/^::ffff:/, '');
      parseAddress(`${remoteIp}:${data.port}`);
      const id = crypto.randomUUID();
      const pair = { id, fingerprint: fp, name: data.name, sas: pairingSas(fp, this.fingerprint), created: Date.now(), status: 'waiting', address: `${remoteIp}:${data.port}` };
      this.incomingPairs.set(id, pair); this.event(`${pair.name} 请求配对，请核对校验码`);
      return send(res, 200, { id, name: this.name, fingerprint: this.fingerprint, sas: pair.sas });
    }
    const statusMatch = url.pathname.match(/^\/pair\/([a-f0-9-]{36})$/);
    if (req.method === 'GET' && statusMatch) {
      const pair = this.incomingPairs.get(statusMatch[1]);
      assert(pair && pair.fingerprint === fp, '配对请求不存在');
      return send(res, 200, { status: Date.now() - pair.created > PAIR_TTL ? 'expired' : pair.status });
    }
    assert(isPaired, '这台设备尚未配对');
    if (req.method === 'POST' && url.pathname === '/offer') {
      const data = await body(req);
      const total = validateManifest(data.entries);
      assert(typeof data.name === 'string' && data.name.length <= 160, '传输名称不合法');
      const id = crypto.randomUUID();
      const peer = this.peers.find(x => x.id === fp);
      const transfer = { id, name: data.name, peerName: peer.name, direction: 'in', status: 'waiting', total, done: 0, entries: data.entries, fingerprint: fp, created: Date.now(), received: new Set() };
      this.incoming.set(id, transfer); this.event(`${peer.name} 想发送 ${data.name}`);
      return send(res, 200, { id });
    }
    const offerMatch = url.pathname.match(/^\/offer\/([a-f0-9-]{36})$/);
    if (req.method === 'GET' && offerMatch) {
      const t = this.incoming.get(offerMatch[1]); assert(t && t.fingerprint === fp, '传输不存在');
      return send(res, 200, { status: t.status, error: t.error });
    }
    const fileMatch = url.pathname.match(/^\/file\/([a-f0-9-]{36})\/(\d+)$/);
    if (req.method === 'PUT' && fileMatch) {
      const t = this.incoming.get(fileMatch[1]);
      assert(t && t.fingerprint === fp && t.status === 'receiving', '传输尚未获准');
      const i = Number(fileMatch[2]); const entry = t.entries[i];
      assert(entry && entry.type === 'file' && !t.received.has(i), '文件不在传输清单中');
      assert(Number(req.headers['content-length']) === entry.size, '文件大小与清单不符');
      const filePath = path.join(t.temp, ...safeRel(entry.path));
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      let count = 0; const h = crypto.createHash('sha256');
      const meter = new Transform({ transform(chunk, _, cb) { count += chunk.length; h.update(chunk); t.done += chunk.length; this.owner.progress(t); cb(null, chunk); } });
      meter.owner = this;
      try {
        await pipeline(req, meter, fs.createWriteStream(filePath, { flags: 'wx' }));
        assert(count === entry.size, '文件接收不完整');
        t.received.add(i); this.emit();
        return send(res, 200, { hash: h.digest('hex') });
      } catch (e) { t.status = 'failed'; t.error = e.message; this.emit(); throw e; }
    }
    const finishMatch = url.pathname.match(/^\/finish\/([a-f0-9-]{36})$/);
    if (req.method === 'POST' && finishMatch) {
      const t = this.incoming.get(finishMatch[1]);
      assert(t && t.fingerprint === fp && t.status === 'receiving', '传输状态不正确');
      assert(t.entries.filter(x => x.type === 'file').length === t.received.size, '仍有文件未收到');
      const final = uniquePath(this.downloadDir, `邻传 ${new Date().toISOString().replace(/[:.]/g, '-')} ${t.id.slice(0, 8)}`);
      await fsp.rename(t.temp, final);
      t.destination = final; t.status = 'complete'; this.event(`已接收 ${t.name}`);
      return send(res, 200, { ok: true });
    }
    const cancelMatch = url.pathname.match(/^\/cancel\/([a-f0-9-]{36})$/);
    if (req.method === 'POST' && cancelMatch) {
      const t = this.incoming.get(cancelMatch[1]); assert(t && t.fingerprint === fp, '传输不存在');
      t.status = 'cancelled'; if (t.temp) await fsp.rm(t.temp, { recursive: true, force: true }); this.emit(); return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: '没有这个请求' });
  }
  async decideOffer(id, approve) {
    const t = this.incoming.get(id);
    assert(t && t.status === 'waiting' && Date.now() - t.created < OFFER_TTL, '请求已过期');
    if (approve) {
      t.temp = await fsp.mkdtemp(path.join(this.downloadDir, '.lanbridge-'));
      for (const entry of t.entries.filter(x => x.type === 'directory')) await fsp.mkdir(path.join(t.temp, ...safeRel(entry.path)), { recursive: true });
      t.status = 'receiving';
    } else t.status = 'rejected';
    this.emit();
  }
  async sendFiles(peerId, selected) {
    const peer = this.peers.find(x => x.id === peerId);
    assert(peer, '请先配对设备');
    const { entries, total } = await listItems(selected);
    const label = entries.filter(x => !x.path.includes('/')).map(x => x.path).join('、').slice(0, 160);
    const t = { id: crypto.randomUUID(), name: label, direction: 'out', peerName: peer.name, status: 'offering', total, done: 0, abort: new AbortController() };
    this.outgoing.set(t.id, t); this.emit();
    let remoteId;
    try {
      const offer = await this.request(peer.address, 'POST', '/offer', { pin: peer.id, data: { name: label, entries: entries.map(({ path, type, size }) => ({ path, type, size })) } });
      remoteId = offer.id; t.status = 'waiting'; this.emit();
      for (;;) {
        if (t.abort.signal.aborted) throw new Error('已取消');
        await new Promise(r => setTimeout(r, 1200));
        const state = await this.request(peer.address, 'GET', `/offer/${remoteId}`, { pin: peer.id });
        if (state.status === 'receiving') break;
        if (state.status !== 'waiting') throw new Error(state.error || '对方拒绝了传输');
      }
      t.status = 'sending'; this.emit();
      for (const [i, entry] of entries.entries()) {
        if (entry.type !== 'file') continue;
        if (t.abort.signal.aborted) throw new Error('已取消');
        const now = await fsp.stat(entry.source);
        assert(now.size === entry.size && now.mtimeMs === entry.mtimeMs, `发送期间文件发生变化：${entry.path}`);
        const h = crypto.createHash('sha256');
        const result = await this.request(peer.address, 'PUT', `/file/${remoteId}/${i}`, { pin: peer.id, timeout: 0, signal: t.abort.signal,
          stream: { source: entry.source, size: entry.size }, onProgress: n => { t.done += n; this.progress(t); } });
        const verify = await new Promise((resolve, reject) => {
          const s = fs.createReadStream(entry.source);
          s.on('data', b => h.update(b)); s.on('end', () => resolve(h.digest('hex'))); s.on('error', reject);
        });
        assert(verify === result.hash, `文件校验失败：${entry.path}`);
      }
      await this.request(peer.address, 'POST', `/finish/${remoteId}`, { pin: peer.id, data: {}, timeout: 30000 });
      t.status = 'complete'; this.event(`已发送 ${label}`);
    } catch (e) {
      if (remoteId) this.request(peer.address, 'POST', `/cancel/${remoteId}`, { pin: peer.id, data: {} }).catch(() => {});
      t.status = e.message === '已取消' ? 'cancelled' : 'failed'; t.error = e.message; this.emit();
    }
    return t.id;
  }
  cancel(id) { const t = this.outgoing.get(id); if (t) t.abort.abort(); }
  async setPeerAddress(id, address) {
    const peer = this.peers.find(x => x.id === id);
    assert(peer, '找不到该设备');
    const { host, port } = parseAddress(address);
    peer.address = `${host}:${port}`;
    await this.savePeers();
  }
}
module.exports = { LanBridge, parseAddress, safeRel, validateManifest, listItems, pairingSas, PORT };
