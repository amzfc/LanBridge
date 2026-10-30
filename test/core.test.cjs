'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { LanBridge, parseAddress, safeRel, validateManifest } = require('../src/core.cjs');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 6000) { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('等待超时'); await pause(50); } }
test('rejects unsafe addresses and portable filenames', () => {
  assert.deepEqual(parseAddress('192.168.1.2:53319'), { host: '192.168.1.2', port: 53319 });
  for (const bad of ['8.8.8.8', '192.168.1.999', 'example.com', '192.168.1.2:0']) assert.throws(() => parseAddress(bad));
  for (const bad of ['../oops', '/absolute', 'folder/CON', 'folder/bad:name', 'folder/trailing.']) assert.throws(() => safeRel(bad));
  assert.throws(() => validateManifest([{ path: 'A', type: 'file', size: 1 }, { path: 'a', type: 'file', size: 2 }]));
});
test('two devices pair, verify identity, and transfer a folder both ways', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lanbridge-test-'));
  const a = new LanBridge({ dataDir: path.join(root, 'a-data'), downloadDir: path.join(root, 'a-download'), name: 'Mac', port: 0 });
  const b = new LanBridge({ dataDir: path.join(root, 'b-data'), downloadDir: path.join(root, 'b-download'), name: 'Windows', port: 0 });
  try {
    await a.init(); await b.init();
    const addressB = `127.0.0.1:${b.port}`;
    await assert.rejects(a.pair(addressB, '000000'), /配对码错误/);
    const pairId = await a.pair(addressB, b.pairCode);
    const pending = b.incomingPairs.get(pairId);
    assert.equal(a.outgoingPairs.get(pairId).sas, pending.sas);
    await b.decidePair(pairId, true);
    await until(() => a.outgoingPairs.get(pairId).status === 'approved');
    await a.confirmPair(pairId);
    assert.equal(a.peers[0].id, b.fingerprint);
    assert.equal(b.peers[0].id, a.fingerprint);
    const source = path.join(root, 'project');
    await fs.mkdir(path.join(source, 'empty'), { recursive: true });
    await fs.mkdir(path.join(source, 'nested'), { recursive: true });
    await fs.writeFile(path.join(source, 'nested', 'hello.txt'), 'Hello over LAN 你好');
    const sending = a.sendFiles(b.fingerprint, [source]);
    await until(() => b.incoming.size > 0);
    const offerId = [...b.incoming.keys()][0];
    await b.decideOffer(offerId, true);
    await sending;
    const receipt = b.incoming.get(offerId);
    assert.equal(receipt.status, 'complete');
    assert.equal(await fs.readFile(path.join(receipt.destination, 'project', 'nested', 'hello.txt'), 'utf8'), 'Hello over LAN 你好');
    assert.deepEqual(await fs.readdir(path.join(receipt.destination, 'project', 'empty')), []);
    const reverse = b.sendFiles(a.fingerprint, [path.join(source, 'nested', 'hello.txt')]);
    await until(() => a.incoming.size > 0);
    await a.decideOffer([...a.incoming.keys()][0], true);
    await reverse;
    assert.equal([...a.incoming.values()][0].status, 'complete');
    await a.setPeerAddress(b.fingerprint, `127.0.0.1:${a.port}`);
    await assert.rejects(a.request(a.peers[0].address, 'POST', '/offer', { pin: b.fingerprint, data: { name: 'x', entries: [{ path: 'x', type: 'file', size: 1 }] } }), /身份与配对记录不一致/);
  } finally {
    await Promise.allSettled([a.server && a.close(), b.server && b.close()]);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('partial transfer survives both app restarts, checks the prefix and sends only missing bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lanbridge-resume-'));
  const options = side => ({ dataDir: path.join(root, `${side}-data`), downloadDir: path.join(root, `${side}-downloads`), port: 0 });
  let a = new LanBridge(options('a')); let b = new LanBridge(options('b'));
  try {
    await a.init(); await b.init();
    await a.remember({ id: b.fingerprint, name: 'B', address: `127.0.0.1:${b.port}` });
    await b.remember({ id: a.fingerprint, name: 'A', address: `127.0.0.1:${a.port}` });
    const source = path.join(root, 'folder'); await fs.mkdir(source);
    const bytes = require('node:crypto').randomBytes(16 * 1024 * 1024);
    await fs.writeFile(path.join(source, 'large.bin'), bytes);
    await fs.writeFile(path.join(source, 'empty.txt'), '');
    let interrupted = false;
    b.progress = t => {
      if (!interrupted && t.done >= 1024 * 1024) {
        interrupted = true; t.active.destroy(new Error('模拟网络中断'));
      }
    };
    const pending = a.sendFiles(b.fingerprint, [source]);
    await until(() => b.incoming.size > 0);
    const remoteId = [...b.incoming.keys()][0]; await b.decideOffer(remoteId, true);
    const id = await pending;
    await until(() => !b.incoming.get(remoteId).active);
    assert.equal(a.outgoing.get(id).status, 'paused');
    const temp = path.join(b.incoming.get(remoteId).temp, 'folder', 'large.bin');
    const offset = (await fs.stat(temp)).size;
    assert.ok(offset > 0 && offset < bytes.length, `partial size: ${offset}`);
    await a.close(); await b.close();
    a = new LanBridge(options('a')); b = new LanBridge(options('b'));
    await a.init(); await b.init();
    await a.setPeerAddress(b.fingerprint, `127.0.0.1:${b.port}`);
    assert.equal(a.outgoing.get(id).status, 'paused');
    assert.equal(b.incoming.get(remoteId).status, 'paused');
    // A damaged prefix must never be appended to or published as complete.
    const handle = await fs.open(temp, 'r+');
    await handle.write(Buffer.from([bytes[0] ^ 255]), 0, 1, 0); await handle.close();
    await a.resume(id);
    assert.match(a.outgoing.get(id).error, /已接收部分校验失败/);
    assert.equal((await fs.stat(temp)).size, offset);
    const repair = await fs.open(temp, 'r+'); await repair.write(bytes.subarray(0, 1), 0, 1, 0); await repair.close();
    let uploaded = 0;
    const request = a.request.bind(a);
    a.request = (address, method, url, opts) => {
      if (method === 'PUT') uploaded += opts.stream.size;
      return request(address, method, url, opts);
    };
    await a.resume(id);
    assert.equal(a.outgoing.get(id).status, 'complete');
    assert.equal(uploaded, bytes.length - offset);
    const result = b.incoming.get(remoteId);
    assert.deepEqual(await fs.readFile(path.join(result.destination, 'folder', 'large.bin')), bytes);
    assert.equal((await fs.stat(path.join(result.destination, 'folder', 'empty.txt'))).size, 0);
    assert.equal(result.done, result.total);
  } finally {
    await Promise.allSettled([a.server && a.close(), b.server && b.close()]);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('lost completion response is recoverable and cancelled partial transfers are cleaned up', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lanbridge-ack-'));
  const a = new LanBridge({ dataDir: path.join(root, 'a'), downloadDir: path.join(root, 'ad'), port: 0 });
  const b = new LanBridge({ dataDir: path.join(root, 'b'), downloadDir: path.join(root, 'bd'), port: 0 });
  try {
    await a.init(); await b.init();
    await a.remember({ id: b.fingerprint, name: 'B', address: `127.0.0.1:${b.port}` });
    await b.remember({ id: a.fingerprint, name: 'A', address: `127.0.0.1:${a.port}` });
    const file = path.join(root, 'data.txt'); await fs.writeFile(file, 'recover a lost acknowledgement');
    const request = a.request.bind(a);
    a.request = async (...args) => { const result = await request(...args); if (args[2].startsWith('/finish/')) throw new Error('模拟完成响应丢失'); return result; };
    const sending = a.sendFiles(b.fingerprint, [file]);
    await until(() => b.incoming.size === 1); const receipt = [...b.incoming.values()][0];
    await b.decideOffer(receipt.id, true); const id = await sending;
    assert.equal(a.outgoing.get(id).status, 'paused'); assert.equal(receipt.status, 'complete');
    a.request = request; await a.resume(id); assert.equal(a.outgoing.get(id).status, 'complete');
    // Pause while waiting, cancel afterwards, and remove its reserved staging directory.
    const next = a.sendFiles(b.fingerprint, [file]);
    await until(() => b.incoming.size === 2); const second = [...b.incoming.values()][1];
    a.pause([...a.outgoing.keys()][1]); const nextId = await next;
    await fs.writeFile(file, 'source changed after pause');
    await a.resume(nextId);
    assert.match(a.outgoing.get(nextId).error, /源文件已变化/);
    await b.decideOffer(second.id, true);
    await a.cancel(nextId);
    assert.equal(second.status, 'cancelled');
    await assert.rejects(fs.stat(second.temp), { code: 'ENOENT' });
  } finally {
    await Promise.allSettled([a.server && a.close(), b.server && b.close()]);
    await fs.rm(root, { recursive: true, force: true });
  }
});
