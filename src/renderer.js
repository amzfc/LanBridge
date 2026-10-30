'use strict';
let state = null;
let selectedPeer = null;
let toastTimer;
const $ = selector => document.querySelector(selector);
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 5000); }
async function action(fn) { try { return await fn(); } catch (e) { toast(e.message || String(e)); return null; } }
function button(text, cls, fn) { const b = node('button', cls, text); b.onclick = () => action(fn); return b; }
function item(title, subtitle) { const box = node('div', 'item'); const main = node('div', 'item-main'); main.append(node('strong', '', title), node('small', '', subtitle)); const actions = node('div', 'item-actions'); box.append(main, actions); return { box, main, actions }; }
function fill(element, nodes, empty) { element.replaceChildren(...nodes); element.classList.toggle('empty', nodes.length === 0); if (!nodes.length) element.textContent = empty; }
function prettyBytes(n) { if (!n) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024))); return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`; }
const labels = { waiting: '等待确认', approved: '已获对方确认', rejected: '已拒绝', expired: '已过期', offering: '发送请求中', receiving: '接收中', sending: '发送中', complete: '已完成', failed: '失败', paused: '已暂停，可继续', cancelled: '已取消' };
function render(s) {
  state = s;
  $('#pair-code').textContent = s.pairCode;
  $('#download-dir').textContent = s.downloadDir;
  fill($('#ip-list'), s.ips.map(ip => node('span', 'ip', `${ip}:${s.port}`)), '暂无可用 IPv4 地址，请连接局域网');
  const pairs = [];
  for (const p of s.incomingPairs) {
    const row = item(`${p.name} 请求信任这台电脑`, `双方核对校验码：${p.sas}`);
    row.main.querySelector('small').classList.add('sas');
    if (p.status === 'waiting') {
      row.actions.append(button('确认匹配，信任', 'primary', () => window.lan.decidePair(p.id, true)), button('拒绝', 'secondary danger', () => window.lan.decidePair(p.id, false)));
    } else row.actions.append(node('span', `pill ${p.status === 'approved' ? 'ok' : 'bad'}`, labels[p.status] || p.status));
    pairs.push(row.box);
  }
  for (const p of s.outgoingPairs) {
    const row = item(`正在与 ${p.name} 配对`, `双方核对校验码：${p.sas}`);
    row.main.querySelector('small').classList.add('sas');
    if (p.status === 'approved') row.actions.append(button('校验码一致，完成配对', 'primary', () => window.lan.confirmPair(p.id)));
    else row.actions.append(node('span', `pill ${p.status === 'waiting' ? '' : 'bad'}`, labels[p.status] || p.status));
    pairs.push(row.box);
  }
  fill($('#pair-requests'), pairs, '目前没有配对请求');
  if (selectedPeer && !s.peers.some(p => p.id === selectedPeer)) selectedPeer = null;
  if (!selectedPeer && s.peers.length) selectedPeer = s.peers[0].id;
  const peers = s.peers.map(p => {
    const row = item(p.name, `上次地址：${p.address} · 身份 ${p.id.slice(0, 12)}`);
    const radio = node('input', 'peer-radio'); radio.type = 'radio'; radio.name = 'peer'; radio.checked = selectedPeer === p.id; radio.setAttribute('aria-label', `选择 ${p.name}`); radio.onchange = () => { selectedPeer = p.id; render(state); };
    row.box.prepend(radio);
    row.actions.append(button('更新 IP', 'text-button', async () => { const input = prompt('输入这台设备当前的局域网 IP：', p.address); if (input) await window.lan.setPeerAddress(p.id, input); }));
    row.actions.append(button('取消信任', 'text-button danger', async () => { if (confirm(`取消信任 ${p.name}？之后需要重新配对。`)) await window.lan.forget(p.id); }));
    return row.box;
  });
  fill($('#peers'), peers, '尚未配对设备');
  const transfers = s.transfers.slice().reverse().map(t => {
    const subtitle = `${t.direction === 'in' ? '来自' : '发送至'} ${t.peerName} · ${prettyBytes(t.done)} / ${prettyBytes(t.total)}` + (t.error ? ` · ${t.error}` : '') + (t.destination ? ` · ${t.destination}` : '');
    const row = item(t.name, subtitle);
    if (t.direction === 'in' && t.status === 'waiting') row.actions.append(button('接收', 'primary', () => window.lan.decideOffer(t.id, true)), button('拒绝', 'secondary danger', () => window.lan.decideOffer(t.id, false)));
    else {
      if (t.status === 'sending' || t.status === 'receiving') { const bar = node('div', 'progress'); const fill = node('i'); fill.style.width = `${t.total ? Math.min(100, Math.round(t.done / t.total * 100)) : 100}%`; bar.append(fill); row.actions.append(bar); }
      row.actions.append(node('span', `pill ${t.status === 'complete' ? 'ok' : t.status === 'failed' || t.status === 'cancelled' ? 'bad' : ''}`, labels[t.status] || t.status));
      if (t.direction === 'out') {
        if (['offering', 'waiting', 'sending'].includes(t.status)) row.actions.append(button('暂停', 'text-button', () => window.lan.pause(t.id)));
        if (t.status === 'paused') row.actions.append(button('继续', 'primary', () => window.lan.resume(t.id)));
        if (['offering', 'waiting', 'sending', 'paused'].includes(t.status)) row.actions.append(button('取消', 'text-button danger', () => window.lan.cancel(t.id)));
      }
    }
    return row.box;
  });
  fill($('#transfers'), transfers, '目前没有传输任务');
}
async function send(paths) {
  if (!paths?.length) return;
  if (!selectedPeer) { toast('请先配对并选择一台电脑'); return; }
  await action(() => window.lan.sendFiles(selectedPeer, paths));
}
$('#refresh-code').onclick = () => action(() => window.lan.refreshCode());
$('#pair-button').onclick = async () => { const address = $('#address').value.trim(); const code = $('#code').value.trim(); const id = await action(() => window.lan.pair(address, code)); if (id) toast('配对请求已发送。请在两台电脑上核对校验码。'); };
$('#choose-files').onclick = async () => send(await action(() => window.lan.chooseFiles()));
$('#choose-folder').onclick = async () => send(await action(() => window.lan.chooseFolder()));
$('#choose-download').onclick = () => action(() => window.lan.chooseDownloadDir());
$('#open-download').onclick = () => action(() => window.lan.openDownloadDir());
const zone = $('#drop-zone');
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag'); send(window.lan.pathsForFiles(e.dataTransfer.files)); });
window.lan.onState(render);
window.lan.state().then(render).catch(e => toast(e.message));
