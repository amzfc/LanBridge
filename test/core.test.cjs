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
