/**
 * 解析与计算自检：在 Node 内置 vm 里加载 tokps-overlay.js（最小 DOM 桩 + 可控时钟），
 * 校验：投递形态兼容 / 事件名别名 / 估算算法 / 实测速度算式 / usage 多命名 / 无 usage 兜底。
 * 运行：node test/parser.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'tokps-overlay.js'), 'utf8');

let FAILED = 0, TOTAL = 0;
function check(name, actual, expected) {
  TOTAL++;
  const ok = (typeof expected === 'function') ? expected(actual) : Object.is(actual, expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (实际 ${JSON.stringify(actual)} / 期望 ${typeof expected === 'function' ? expected.toString() : JSON.stringify(expected)})`}`);
  if (!ok) FAILED++;
}

function makeEnv() {
  const mkEl = () => ({
    style: {}, id: '', title: '', innerHTML: '', textContent: '',
    appendChild() {}, addEventListener() {}, removeEventListener() {}, remove() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    classList: { contains: () => false },
    querySelector: () => null,
    getContext: () => ({ clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}, getImageData: () => ({ data: [] }) }),
  });
  const document = {
    body: mkEl(), head: mkEl(), documentElement: mkEl(), hidden: false, readyState: 'complete',
    createElement: mkEl, getElementById: () => null, querySelector: () => null, addEventListener() {},
  };
  const clock = { t: 0 };
  const win = {
    document,
    performance: { now: () => clock.t },
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 0,            /* paint 由事件同步触发，测试里不需要逐帧 */
    setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {},  /* 采样定时器不需要，也不能拖住进程 */
    TextDecoder, console, navigator: {},
  };
  win.window = win;
  return { win, clock };
}

const { win, clock } = makeEnv();
vm.runInContext(SRC, vm.createContext(win), { filename: 'tokps-overlay.js' });
const api = win.__tokps;

check('overlay 载入并暴露 __tokps', typeof api === 'object' && api !== null, true);
check('版本号存在', typeof api.version, 'string');

const CJK = '中文输出内容测试一二三四五六';                     /* 14 个汉字 */
const CJK_N = [...CJK].length;
const est = (deltas) => Math.ceil(CJK_N * 1.5) * deltas;       /* CJK ×1.5 后向上取整 */
const sock = (name, payload) => api.feed('42' + JSON.stringify([name, payload]));

/* ---------- 1) 基本流式：TTFT / 估算 / 实测速度 / 缓存命中率 ---------- */
const S = { session_id: 'basic' };
clock.t = 0;    api.handle('run.started', S);
clock.t = 500;  api.handle('message.delta', { ...S, delta: CJK });
clock.t = 1000; api.handle('message.delta', { ...S, delta: CJK });
let t1 = api.state['basic'].turn;
check('首 token 延迟 = 500ms', Math.round(t1.ttft), 500);
check('两次 delta 累计估算 token', t1.estTotal, est(2));
check('流式窗口可用于实时估算', t1.lastChunkAt - t1.estWindowStart, (v) => v > 0);
clock.t = 1500; api.handle('usage.updated', { ...S, output_tokens: 200, input_tokens: 1000, cache_read_tokens: 3000 });
t1 = api.state['basic'].turn;
check('usage 实测输出 token', t1.out, 200);
check('实测速度 = 200 tok ÷ 1.0s', t1.calls.at(-1).speed, (v) => Math.abs(v - 200) < 0.001);
check('模型用时累计 1000ms', Math.round(t1.modelMs), 1000);
check('缓存命中率 = 3000/(1000+3000)', api.state['basic'].cumCacheRead / (api.state['basic'].cumIn + api.state['basic'].cumCacheRead), 0.75);
clock.t = 2000; api.handle('run.completed', { ...S, output_tokens: 200 });
check('结算后 done = true', api.state['basic'].turn.done, true);

/* ---------- 2) 投递形态 / 事件名别名 / 文本字段兜底 ---------- */
const shapes = {
  'A 扁平 socket.io':        (sid) => sock('message.delta', { session_id: sid, delta: CJK }),
  'B payload 封装':          (sid) => sock('socket.event', { event: 'message.delta', payload: { session_id: sid, delta: CJK } }),
  'C 裸 JSON 帧':            (sid) => api.feed(JSON.stringify({ event: 'message.delta', session_id: sid, text: CJK })),
  'D SSE 行':                (sid) => api.feed('data: ' + JSON.stringify({ type: 'message.delta', session_id: sid, delta: CJK })),
  'E 未知字段名兜底':         (sid) => sock('message.delta', { session_id: sid, snippet: CJK }),
  'F 别名 stream.delta':     (sid) => sock('stream.delta', { session_id: sid, delta: CJK }),
  'G agent.event 壳':        (sid) => sock('agent.event', { session_id: sid, event: 'assistant_delta', text: CJK }),
  'H 大写事件名':            (sid) => sock('MESSAGE_DELTA', { session_id: sid, content: CJK }),
  'I 嵌套 {text}':           (sid) => sock('message.delta', { session_id: sid, delta: { type: 'text', text: CJK } }),
};
let si = 0;
for (const [label, emit] of Object.entries(shapes)) {
  const sid = 'shape' + (++si);
  api.handle('run.started', { session_id: sid });
  emit(sid); emit(sid);
  check(`${label} → 估算 token`, api.state[sid].turn.estTotal, est(2));
}

/* ---------- 3) usage 的多种命名 ---------- */
const usageCases = [
  ['camelCase outputTokens', { outputTokens: 111 }, 111],
  ['snake_case output_tokens', { output_tokens: 222 }, 222],
  ['嵌套 usage.output_tokens', { usage: { output_tokens: 333 } }, 333],
  ['只有 total_tokens 反推', { total_tokens: 500, input_tokens: 100 }, 400],
  ['reasoningTokens / contextTokens', { outputTokens: 10, reasoning_tokens: 7, contextTokens: 1234 }, 10],
];
let ui = 0;
for (const [label, payload, want] of usageCases) {
  const sid = 'usage' + (++ui);
  api.handle('run.started', { session_id: sid });
  api.handle('usage.updated', { session_id: sid, ...payload });
  check(`${label} → 输出 token`, api.state[sid].cum, want);
  if (payload.reasoning_tokens) check(`${label} → 推理 token`, api.state[sid].cumReasoning, payload.reasoning_tokens);
  if (payload.contextTokens) check(`${label} → 上下文 token`, api.state[sid].ctxTokens, payload.contextTokens);
}

/* ---------- 4) 完全没有 usage 时也要有数（估算兜底） ---------- */
const sidE = 'estOnly';
clock.t = 20000; api.handle('run.started', { session_id: sidE });
clock.t = 20500; api.handle('message.delta', { session_id: sidE, delta: CJK });
clock.t = 21000; api.handle('message.delta', { session_id: sidE, delta: CJK });
clock.t = 21500; api.handle('run.completed', { session_id: sidE });
const tE = api.state[sidE].turn;
check('无 usage 时保留估算 token 数', tE.estTotal, est(2));
check('无 usage 时模型用时非零', tE.modelMs, (v) => v > 0);

/* ---------- 5) 工具事件与步数 ---------- */
const sidT = 'tools';
api.handle('run.started', { session_id: sidT });
clock.t = 30000; api.handle('tool.started', { session_id: sidT, tool: 'bash' });
clock.t = 30400; api.handle('tool.completed', { session_id: sidT, tool: 'bash' });
clock.t = 30500; api.handle('tool.started', { session_id: sidT, tool: 'read_file' });
clock.t = 30600; api.handle('tool.failed', { session_id: sidT, tool: 'read_file' });
const st = api.state['tools'];
check('步数 = 2', st.steps, 2);
check('失败数 = 1', st.stepFails, 1);
check('工具用时 ≈ 500ms', Math.round(st.toolMs), 500);
check('常用工具统计', st.toolCounts.bash, 1);

console.log(`\n${TOTAL - FAILED}/${TOTAL} 通过` + (FAILED ? `，${FAILED} 项失败` : '，全部通过'));
process.exit(FAILED ? 1 : 0);
