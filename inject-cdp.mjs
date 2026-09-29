#!/usr/bin/env node
/**
 * inject-cdp.mjs —— 通过 Chrome DevTools Protocol 在运行时把脚本注入 Electron 应用。
 *
 * 特点：完全不修改应用文件，所以应用升级不会被覆盖；进程只在注入时存在，不常驻后台。
 *
 * 用法:
 *   node inject-cdp.mjs --source tokps-overlay.js [--port 9223] [--wait 15] [--reload] [--match 127.0.0.1]
 *   node inject-cdp.mjs --source test.js --self-test      # 注入后校验并（可选）移除
 */
import fs from 'node:fs';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const port = Number(args.port || 9223);
const waitSec = Number(args.wait || 15);
const wantReload = args.reload !== undefined || args['self-test'] !== undefined;
const match = typeof args.match === 'string' ? args.match : '';
const source = args.source ? fs.readFileSync(args.source, 'utf8') : '';
const scriptTag = (args.tag && typeof args.tag === 'string') ? args.tag : '__tokpsLoaded';

if (!source) { console.error('缺少 --source <文件>'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort() {
  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch (e) { /* 还没起来 */ }
    await sleep(400);
  }
  return null;
}

async function pickTarget() {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = await r.json();
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) return null;
  if (match) {
    const hit = pages.find((t) => (t.url || '').includes(match));
    if (hit) return hit;
  }
  return pages[0];
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (e) {} },
    }));
    ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败: ' + (e.message || e.type))));
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  });
}

const version = await waitForPort();
if (!version) {
  console.error(`端口 ${port} 在 ${waitSec}s 内没有打开（应用可能禁用了 remote debugging）`);
  process.exit(3);
}
console.log('已连接:', version.Browser, version['Protocol-Version'] ? 'CDP ' + version['Protocol-Version'] : '');

const target = await pickTarget();
if (!target) { console.error('没有找到可注入的页面 target'); process.exit(4); }
console.log('目标页面:', target.title || '(无标题)', target.url);

const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send('Page.enable');
const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
console.log('已注册常驻脚本 identifier =', added.identifier);

if (wantReload) {
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(2500);
  const check = await cdp.send('Runtime.evaluate', { expression: `String(window.${scriptTag})`, returnByValue: true });
  console.log(`重载后校验 window.${scriptTag} =`, check && check.result ? check.result.value : check);
}

if (args['self-test'] && added.identifier) {
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier });
  await cdp.send('Page.reload', {});
  await sleep(1500);
  const check2 = await cdp.send('Runtime.evaluate', { expression: `String(window.${scriptTag})`, returnByValue: true });
  console.log(`移除后再校验 window.${scriptTag} =`, check2 && check2.result ? check2.result.value : check2, '(应为 undefined)');
}
cdp.close();
process.exit(0);
