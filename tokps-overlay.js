/*! tokps-overlay.js  v3.3.1  (studio-tokps)
 *  Ekko Studio 本地补丁：把事件流里的运行信息全部摊开显示
 *   - 实时：输出速度(tok/s)、首 token、状态(思考/生成/调用工具/授权/压缩/子代理/完成)、当前工具与已耗时
 *   - 本轮：模型用时、工具用时、API 调用次数、输出 token、速率曲线(最近 60s)
 *   - 每次模型调用：首字 / 输出 / 速度 明细
 *   - Token 全景：输入、输出、缓存读、缓存写、推理、上下文占用(带 %)、缓存命中率
 *   - 会话累计：轮数、工具步数(含失败)、子代理、累计输出、平均/最快/最慢速度、最近 5 轮
 *   - 复制统计 / 重置 / 拖动 / 双击隐藏
 *  数据来源：socket.io 事件流(只读) + /api/studio/sessions/:id/usage 与 /context 只读接口。
 *  卸载：删除本文件 + 还原 index.html.tokps.bak
 */
(function () {
  if (window.__tokpsLoaded) return;
  window.__tokpsLoaded = true;

  var DEBUG = false;
  function log() { if (DEBUG) try { console.log.apply(console, ['[tokps]'].concat([].slice.call(arguments))); } catch (e) {} }

  /* ============================ 状态 ============================ */
  var sessions = Object.create(null);
  var lastId = 'default';
  var stats = { frames: 0, events: 0 };

  function sess(id) {
    id = id || lastId || 'default';
    var s = sessions[id];
    if (!s) {
      s = sessions[id] = {
        id: id, cum: 0, cumIn: 0, cumOut: 0, cumCacheRead: 0, cumCacheWrite: 0, cumReasoning: 0,
        apiCalls: 0, ctxTokens: 0, ctxLimit: 0, ctxAsked: false, usageAsked: false,
        turns: 0, steps: 0, stepFails: 0, toolCounts: {}, toolMs: 0,
        curTool: null, curToolStart: null, subActive: 0, subDone: [], subTokens: 0,
        status: 'idle', statusAt: Date.now(), turn: null, history: [], samples: []
      };
    }
    lastId = id;
    return s;
  }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function newTurn(at, base) {
    return { idx: 0, t0: at, base: base, out: 0, modelMs: 0, toolMs: 0, modelStart: null, toolStart: null,
             ttft: null, calls: [], apiCalls: 0, done: false, totalMs: null, startedAt: Date.now(),
             tools: [], boundary: at, lastCum: base, estTotal: 0, estWindowStart: at, lastChunkAt: 0, calib: 1 };
  }
  function active(s) { return (s.turn && !s.turn.done) ? s.turn : null; }
  function setStatus(s, st) { if (s.status !== st) { s.status = st; s.statusAt = Date.now(); } }

  /* ---------- 会话级只读补数（在应用内发请求，带应用自身凭据） ---------- */
  function hydrate(s) {
    if (!window.fetch || s.id === 'default') return;
    if (!s.usageAsked) {
      s.usageAsked = true;
      try {
        fetch('/api/studio/sessions/' + encodeURIComponent(s.id) + '/usage').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
          var u = d && (d.usage || d);
          if (!u) return;
          if (u.input_tokens || u.output_tokens) {
            s.cumIn = Math.max(s.cumIn, Number(u.input_tokens || 0));
            s.cumOut = Math.max(s.cumOut, Number(u.output_tokens || 0));
            s.cum = Math.max(s.cum, Number(u.output_tokens || 0));
            s.cumCacheRead = Math.max(s.cumCacheRead, Number(u.cache_read_tokens || 0));
            s.cumCacheWrite = Math.max(s.cumCacheWrite, Number(u.cache_write_tokens || 0));
            s.cumReasoning = Math.max(s.cumReasoning, Number(u.reasoning_tokens || 0));
            s.apiCalls = Math.max(s.apiCalls, Number(u.api_calls || 0));
            log('hydrated usage', u);
          }
        }, function () {});
      } catch (e) {}
    }
    if (!s.ctxAsked) {
      s.ctxAsked = true;
      try {
        fetch('/api/studio/sessions/' + encodeURIComponent(s.id) + '/context').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
          var n = Number(d && (d.context_length || d.contextLength || (d.context && d.context.length)));
          if (isFinite(n) && n > 0) { s.ctxLimit = n; log('context_length', n); return; }
          fetch('/api/studio/sessions/context-length').then(function (r2) { return r2.ok ? r2.json() : null; }).then(function (d2) {
            var n2 = Number(d2 && (d2.context_length || d2.contextLength));
            if (isFinite(n2) && n2 > 0) s.ctxLimit = n2;
          }, function () {});
        }, function () {});
      } catch (e) {}
    }
  }

  /* ============================ 负载归一化与诊断 ============================ */
  var DIAG = [];
  /* 兼容多种投递形态：直接事件对象、{event,payload} 封装、{data}/{body}/{detail} 包装 */
  function normPayload(p) {
    if (!p || typeof p !== 'object') return {};
    var inner = p.payload || p.data || p.body || p.detail;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      var out = {};
      for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k];
      for (var k2 in inner) if (Object.prototype.hasOwnProperty.call(inner, k2)) out[k2] = inner[k2];
      return out;
    }
    return p;
  }
  var TEXT_KEYS = ['delta', 'text', 'content', 'chunk', 'fragment', 'token', 'output', 'message', 'part', 'value'];
  var META_KEYS = /^(event|type|kind|session_id|sessionId|run_id|runId|id|model|tool|name|status|profile|agent|purpose|reason|error|callId|call_id|index)$/;
  /* 取流式文本：先常见字段，再退化为「负载里最长的非元数据字符串」（字段名没见过时兜底） */
  function pickText(p) {
    for (var i = 0; i < TEXT_KEYS.length; i++) {
      var v = p[TEXT_KEYS[i]];
      if (typeof v === 'string' && v) return v;
      if (v && typeof v === 'object') {
        var inner = v.text || v.delta || v.content;
        if (typeof inner === 'string' && inner) return inner;
      }
    }
    var best = '';
    for (var k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k) || META_KEYS.test(k)) continue;
      var val = p[k];
      if (typeof val === 'string' && val.length > best.length) best = val;
    }
    return best;
  }
  /* 数字字段：在负载本体、usage、payload、tokens 等子对象里找 camelCase / snake_case 两种写法 */
  function pickNum(p, names) {
    var pools = [p, p.usage, p.payload, p.data, p.tokens, p.counts, p.stats];
    for (var i = 0; i < pools.length; i++) {
      var o = pools[i];
      if (!o || typeof o !== 'object') continue;
      for (var j = 0; j < names.length; j++) {
        var v = o[names[j]];
        if (v !== undefined && v !== null && isFinite(Number(v))) return Number(v);
      }
    }
    return NaN;
  }
  /* 事件名别名：运行时的内部命名（bridge 里记录的是 stream.delta 之类）也要认 */
  var ALIAS = {
    'stream.delta': 'message.delta', 'stream.text': 'message.delta', 'assistant.delta': 'message.delta',
    'message_delta': 'message.delta', 'assistant_delta': 'message.delta', 'text.delta': 'message.delta',
    'stream.interim': 'message.interim', 'assistant.interim': 'message.interim',
    'stream.reasoning': 'reasoning.delta', 'reasoning_delta': 'reasoning.delta', 'thinking_delta': 'thinking.delta',
    'usage': 'usage.updated', 'usage.update': 'usage.updated', 'token.usage': 'usage.updated', 'tokens.updated': 'usage.updated',
    'run.start': 'run.started', 'turn.start': 'run.started', 'run.begin': 'run.started',
    'run.end': 'run.completed', 'run.finish': 'run.completed', 'turn.end': 'run.completed',
    'tool.start': 'tool.started', 'tool.begin': 'tool.started', 'tool.end': 'tool.completed', 'tool_result': 'tool.completed'
  };
  var KNOWN = ['run.started','run.queued','message.delta','message.interim','reasoning.delta','thinking.delta',
    'reasoning.available','tool.started','tool.completed','tool.failed','usage.updated','run.completed','run.failed',
    'compression.started','compression.completed','approval.requested','approval.resolved','clarify.requested',
    'clarify.resolved','subagent.start','subagent.complete','subagent.tool','subagent.text','subagent.thinking',
    'subagent.progress'];
  function canonical(name, p) {
    /* agent.event / subagent.event 这类外层壳：看内层名字 */
    if ((name === 'agent.event' || name === 'subagent.event' || name === 'socket.event') && p) {
      var inner = p.event || p.type || p.kind;
      if (typeof inner === 'string' && inner && inner !== name) name = inner;
    }
    if (ALIAS[name]) return ALIAS[name];
    if (KNOWN.indexOf(name) >= 0) return name;
    var low = String(name).toLowerCase();
    if (ALIAS[low]) return ALIAS[low];
    if (low.indexOf('delta') >= 0 && (low.indexOf('reason') >= 0 || low.indexOf('think') >= 0)) return 'reasoning.delta';
    if (low.indexOf('delta') >= 0) return 'message.delta';
    if (low.indexOf('interim') >= 0) return 'message.interim';
    if (low.indexOf('usage') >= 0) return 'usage.updated';
    if (low.indexOf('tool') >= 0) return (low.indexOf('start') >= 0 || low.indexOf('begin') >= 0) ? 'tool.started' : 'tool.completed';
    return name;
  }

  function recordDiag(name, p) {
    try {
      var keys = [];
      for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) keys.push(k);
      DIAG.push({ t: Date.now(), name: name, keys: keys.slice(0, 16) });
      if (DIAG.length > 40) DIAG.shift();
      stats.lastEvent = name;
      stats.lastKeys = keys.slice(0, 16);
    } catch (e) {}
  }

  /* ============================ 事件处理 ============================ */
  function handle(name, p) {
    if (typeof name !== 'string') return;
    p = normPayload(p || {});
    if (typeof p.event === 'string' && p.event) name = p.event;
    else if (typeof p.type === 'string' && /^[a-z]+\.[a-z_]+$/i.test(p.type)) name = p.type;
    var rawName = name;
    name = canonical(name, p);
    recordDiag(name, p);
    void rawName;
    var s = sess(p.session_id || p.sessionId || p.session);
    var t = now();
    stats.events++;
    hydrate(s);

    var important = (name !== 'message.delta' && name !== 'thinking.delta' && name !== 'reasoning.delta' &&
                     name !== 'message.interim' && name !== 'reasoning.available' && name !== 'subagent.text' &&
                     name !== 'subagent.thinking' && name !== 'subagent.progress');

    switch (name) {
      case 'run.started':
      case 'run.queued':
        s.turns++;
        s.samples = [];
        s.turn = newTurn(t, s.cum);
        s.turn.idx = s.turns;
        setStatus(s, 'thinking');
        break;

      case 'message.delta':
      case 'thinking.delta':
      case 'reasoning.delta':
      case 'message.interim':
      case 'reasoning.available': {
        var tt = active(s) || (s.turn = newTurn(t, s.cum));
        if (tt.ttft === null) tt.ttft = t - tt.t0;
        if (tt.modelStart === null) {
          if (tt.toolStart !== null) { tt.toolMs += t - tt.toolStart; tt.toolStart = null; }
          tt.modelStart = t;
          tt.curCall = { waitMs: tt.boundary !== null ? t - tt.boundary : null, start: t, out: 0, ms: 0,
                         speed: null, est: 0, estStart: t, lastChunkAt: 0 };
          tt.calls.push(tt.curCall);
          tt.estWindowStart = t;                 /* 实时窗口按“单次模型调用”重置 */
          tt.lastChunkAt = 0;
        }
        var txt = pickText(p);
        var est = estimateTokens(txt);
        if (est > 0) {
          tt.estTotal += est;
          tt.lastChunkAt = t;
          if (tt.curCall) { tt.curCall.est += est; tt.curCall.lastChunkAt = t; }
        }
        if (s.status !== 'writing') { setStatus(s, 'writing'); paintNow(true); }
        break;
      }

      case 'tool.started': {
        var ta = active(s); if (!ta) break;
        var nm = (typeof p.tool === 'string' && p.tool) || (typeof p.name === 'string' && p.name) || 'tool';
        if (ta.modelStart !== null) { ta.modelMs += t - ta.modelStart; ta.modelStart = null; }
        ta.toolStart = t;
        ta.tools.push(nm);
        s.steps++;
        s.toolCounts[nm] = (s.toolCounts[nm] || 0) + 1;
        s.curTool = nm; s.curToolStart = t;
        setStatus(s, 'tool');
        break;
      }

      case 'tool.completed':
      case 'tool.failed': {
        var tb = active(s); if (!tb) break;
        var nm2 = (typeof p.tool === 'string' && p.tool) || (typeof p.name === 'string' && p.name) || s.curTool;
        if (tb.toolStart !== null) { tb.toolMs += t - tb.toolStart; tb.toolStart = null; }
        tb.boundary = t;
        s.toolMs += (s.curToolStart !== null ? t - s.curToolStart : 0);
        if (name === 'tool.failed') s.stepFails++;
        s.curTool = null; s.curToolStart = null;
        setStatus(s, 'thinking');
        void nm2;
        break;
      }

      case 'approval.requested': setStatus(s, 'approval'); break;
      case 'approval.resolved': setStatus(s, 'thinking'); break;
      case 'clarify.requested': setStatus(s, 'clarify'); break;
      case 'clarify.resolved': setStatus(s, 'thinking'); break;
      case 'compression.started': setStatus(s, 'compacting'); break;
      case 'compression.completed': setStatus(s, 'thinking'); break;

      case 'subagent.start':
      case 'subagent.tool':
      case 'subagent.progress':
      case 'subagent.text':
      case 'subagent.thinking':
        s.subActive = Math.max(s.subActive, 1);
        setStatus(s, 'subagent');
        break;
      case 'subagent.complete': {
        s.subActive = Math.max(0, s.subActive - 1);
        var dur = Number(p.duration_seconds != null ? p.duration_seconds : p.duration);
        var so = Number(p.output_tokens || 0);
        s.subTokens += so;
        s.subDone.push({ tokens: so, ms: isFinite(dur) ? dur * 1000 : null, calls: Number(p.api_calls || 0) });
        if (s.subDone.length > 20) s.subDone.shift();
        break;
      }

      case 'usage.updated':
      case 'run.completed': {
        var cum = pickNum(p, ['outputTokens', 'output_tokens', 'completion_tokens', 'outputTokensTotal']);
        var cin = pickNum(p, ['inputTokens', 'input_tokens', 'prompt_tokens']);
        var cr = pickNum(p, ['cacheReadTokens', 'cache_read_tokens', 'cached_tokens']);
        var cw = pickNum(p, ['cacheWriteTokens', 'cache_write_tokens']);
        var rz = pickNum(p, ['reasoningTokens', 'reasoning_tokens']);
        var cx = pickNum(p, ['contextTokens', 'context_tokens']);
        var ac = pickNum(p, ['api_calls', 'apiCalls']);
        if (!isFinite(cum)) {                                  /* 只有总量时反推输出 */
          var tot = pickNum(p, ['total_tokens', 'totalTokens']);
          if (isFinite(tot)) cum = tot - (isFinite(cin) ? cin : 0);
        }
        if (isFinite(cin) && cin > 0) s.cumIn = Math.max(s.cumIn, cin);
        if (isFinite(cr) && cr > 0) s.cumCacheRead = Math.max(s.cumCacheRead, cr);
        if (isFinite(cw) && cw > 0) s.cumCacheWrite = Math.max(s.cumCacheWrite, cw);
        if (isFinite(rz) && rz > 0) s.cumReasoning = Math.max(s.cumReasoning, rz);
        if (isFinite(cx) && cx > 0) s.ctxTokens = Math.max(s.ctxTokens, cx);
        if (isFinite(ac) && ac > 0) s.apiCalls = Math.max(s.apiCalls, ac);

        var tc = active(s);
        if (tc && isFinite(cum)) {
          if (tc.modelStart !== null) { tc.modelMs += t - tc.modelStart; tc.modelStart = null; }
          tc.apiCalls++;
          var last = tc.calls[tc.calls.length - 1];
          if (last && last.out === 0) {
            last.out = Math.max(0, cum - tc.lastCum);          /* 本次调用新增输出 */
            last.ms = t - last.start;
            if (last.ms > 0 && last.out > 0) last.speed = last.out / (last.ms / 1000);
          }
          tc.out = Math.max(0, cum - tc.base);
          tc.lastCum = Math.max(tc.lastCum, cum);
          tc.boundary = t;
          if (tc.estTotal > 0 && tc.out > 0) {                 /* 用实测校准估算比例 */
            var ratio = tc.out / tc.estTotal;
            if (ratio > 0.2 && ratio < 5) tc.calib = tc.calib ? (tc.calib * 0.5 + ratio * 0.5) : ratio;
          }
        }
        if (isFinite(cum)) { s.cum = Math.max(s.cum, cum); s.cumOut = Math.max(s.cumOut, cum); }
        if (name === 'run.completed') finish(s, t);
        break;
      }
    }
    if (important) paintNow(name === 'run.completed' || name === 'run.started');
    schedule();
  }

  function finish(s, t) {
    var tt = active(s);
    if (!tt) return;
    if (tt.modelStart !== null) { tt.modelMs += t - tt.modelStart; tt.modelStart = null; }
    if (tt.toolStart !== null) { tt.toolMs += t - tt.toolStart; tt.toolStart = null; }
    tt.done = true;
    tt.totalMs = t - tt.t0;
    tt.speed = speedOf(tt);
    s.history.push(tt);
    if (s.history.length > 20) s.history.shift();
    s.turn = tt;
    setStatus(s, 'done');
  }

  /* —— 流式实时估算（口径照 dsh-working-activity：CJK ×1.5、其他 ÷4，3.5s 窗口） —— */
  var TPS_STALE_MS = 3500;          /* 最后一个 chunk 之后这么久没动静就不再显示实时值 */
  var TPS_MIN_WINDOW_MS = 1000;     /* 分母下限，避免刚开头几毫秒出现爆表数字 */
  function estimateTokens(text) {
    if (typeof text !== 'string' || !text) return 0;
    var compact = text.replace(/\s/g, '');
    if (!compact.length) return 0;
    var m = compact.match(/[\u3400-\u9fff]/g);
    var cjk = m ? m.length : 0;
    return Math.max(1, Math.ceil(cjk * 1.5 + (compact.length - cjk) / 4));
  }
  /* 结算速度兜底：本轮没有 usage 数据时，用估算 token ÷ 模型用时顶上 */
  function estSpeed(tt, at) {
    if (!tt || !(tt.estTotal > 0)) return null;
    /* 用真实流式窗口（首个 chunk → 最后一个 chunk）算，停笔后数值保持稳定，不随时间衰减 */
    var win = (tt.lastChunkAt && tt.estWindowStart) ? (tt.lastChunkAt - tt.estWindowStart) : 0;
    if (!(win > 0)) win = tt.modelMs || tt.totalMs || ((at || now()) - tt.t0);
    if (!(win > 0)) return null;
    var sec = Math.max(TPS_MIN_WINDOW_MS, win) / 1000;
    return tt.estTotal / sec * (tt.calib || 1);
  }

  /* 实时速度：窗口 = 当前这次模型调用；最后一个 chunk 距今 >3.5s 视为停笔 */
  function liveSpeed(tt, at) {
    if (!tt) return null;
    at = at || now();
    if (!tt.lastChunkAt || (at - tt.lastChunkAt) > TPS_STALE_MS) return null;
    var est = tt.estTotal || 0;
    if (est <= 0) return null;
    var win = Math.max(TPS_MIN_WINDOW_MS, at - (tt.estWindowStart || tt.t0));
    var tps = (est / (win / 1000)) * (tt.calib || 1);
    return { tps: tps, tokens: est, winMs: win };
  }

  function speedOf(tt, at) {
    if (!tt || !(tt.out > 0)) return null;
    var model = tt.modelMs + (tt.modelStart !== null ? (at || now()) - tt.modelStart : 0);
    if (!(model > 0)) return null;
    return tt.out / (model / 1000);
  }

  /* 速率采样（曲线） */
  setInterval(function () {
    var s = sessions[lastId];
    if (!s || !s.turn || s.turn.done) return;
    var lv = liveSpeed(s.turn);
    var v = lv ? lv.tps : speedOf(s.turn);
    s.samples.push({ t: now(), v: v });
    if (s.samples.length > 120) s.samples.shift();
    schedule();
  }, 1000);

  /* ============================ 格式化 ============================ */
  function fmtTok(n) {
    if (!isFinite(n) || n <= 0) return '0';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function fmtSec(ms) {
    if (ms === null || ms === undefined || !isFinite(ms)) return '—';
    var x = ms / 1000;
    if (x < 60) return x.toFixed(1) + '秒';
    var m = Math.floor(x / 60), sec = Math.round(x % 60);
    return m + '分' + sec + '秒';
  }
  function fmtSpeed(v) { return (v === null || v === undefined || !isFinite(v)) ? '—' : (v >= 100 ? v.toFixed(0) : v.toFixed(1)); }
  function hitRate(s) { return (s.cumCacheRead > 0 && s.cumIn > 0) ? (s.cumCacheRead / (s.cumIn + s.cumCacheRead) * 100) : null; }
  function statusText(s) {
    switch (s.status) {
      case 'thinking': return '思考中';
      case 'writing': return '生成中';
      case 'tool': return '调用工具';
      case 'approval': return '等待授权';
      case 'clarify': return '等待确认';
      case 'compacting': return '压缩上下文';
      case 'subagent': return '子代理运行中';
      case 'done': return '完成';
      default: return '空闲';
    }
  }
  function statusColor(s) {
    switch (s.status) {
      case 'writing': return '#12b76a';
      case 'thinking': return '#f79009';
      case 'approval': case 'clarify': return '#f04438';
      case 'compacting': return '#7a5af8';
      case 'subagent': return '#0ba5ec';
      case 'done': return '#98a2b3';
      default: return '#c0c6cf';
    }
  }

  /* ============================ 渲染 ============================ */
  var pill = null, panel = null, liveEl = null, canvas = null, raf = 0, shown = false;
  var suppressClick = false, dragInfo = null;
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  function ensureUI() {
    if (pill && document.body && document.body.contains(pill)) return true;
    if (!document.body) return false;
    var st = document.createElement('style');
    st.textContent = [
      '#tokps-pill{position:fixed;right:14px;bottom:96px;z-index:2147483000;display:flex;gap:8px;align-items:center;',
      'padding:5px 11px;border-radius:999px;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
      'background:rgba(255,255,255,.93);color:#333;border:1px solid rgba(0,0,0,.10);box-shadow:0 2px 10px rgba(0,0,0,.10);',
      'cursor:grab;user-select:none;backdrop-filter:blur(6px);white-space:nowrap}',
      '#tokps-pill:hover{border-color:rgba(0,0,0,.22)}',
      '#tokps-pill b{font-weight:600;color:#0b6cff}',
      '#tokps-pill .tokps-dim{color:#8a8a8a}',
      '#tokps-pill .tokps-dot{width:7px;height:7px;border-radius:50%;background:#c0c6cf;display:inline-block}',
      '#tokps-panel{position:fixed;right:14px;bottom:136px;z-index:2147483000;display:none;width:300px;max-height:70vh;overflow:auto;',
      'padding:11px 13px;border-radius:12px;font:12px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
      'background:rgba(255,255,255,.975);color:#333;border:1px solid rgba(0,0,0,.10);box-shadow:0 8px 28px rgba(0,0,0,.16)}',
      '#tokps-panel h4{margin:2px 0 5px;font-size:11.5px;font-weight:600;color:#6b7280;letter-spacing:.02em}',
      '#tokps-panel .tokps-row{display:flex;justify-content:space-between;gap:14px}',
      '#tokps-panel .tokps-row span:last-child{font-weight:600;font-variant-numeric:tabular-nums}',
      '#tokps-panel .tokps-sub{color:#8a8a8a}',
      '#tokps-panel hr{border:0;border-top:1px solid rgba(0,0,0,.08);margin:8px 0}',
      '#tokps-panel .tokps-btns{display:flex;gap:8px;margin-top:8px}',
      '#tokps-panel button{flex:1;padding:4px 6px;border-radius:7px;border:1px solid rgba(0,0,0,.14);background:transparent;',
      'color:inherit;font:inherit;font-size:11.5px;cursor:pointer}',
      '#tokps-panel button:hover{background:rgba(0,0,0,.05)}',
      'html.dark #tokps-pill{background:rgba(32,32,32,.93);color:#e6e6e6;border-color:rgba(255,255,255,.14)}',
      'html.dark #tokps-pill b{color:#6cb0ff}',
      'html.dark #tokps-pill .tokps-dim{color:#9a9a9a}',
      'html.dark #tokps-panel{background:rgba(30,30,30,.975);color:#e6e6e6;border-color:rgba(255,255,255,.14)}',
      'html.dark #tokps-panel h4{color:#9ca3af}',
      'html.dark #tokps-panel hr{border-top-color:rgba(255,255,255,.12)}',
      'html.dark #tokps-panel .tokps-sub{color:#9a9a9a}',
      'html.dark #tokps-panel button{border-color:rgba(255,255,255,.18)}',
      'html.dark #tokps-panel button:hover{background:rgba(255,255,255,.07)}'
    ].join('');
    document.head.appendChild(st);

    pill = document.createElement('div');
    pill.id = 'tokps-pill';
    pill.title = '单击展开明细；拖动移动；双击隐藏\n（诊断：见展开面板底部）';
    liveEl = document.createElement('span');
    pill.appendChild(liveEl);
    pill.addEventListener('click', function (e) {
      e.stopPropagation();
      if (suppressClick) { suppressClick = false; return; }
      toggle(true);
    });
    pill.addEventListener('dblclick', function (e) { e.stopPropagation(); ls('tokps.hidden', '1'); pill.style.display = 'none'; toggle(false); });
    document.body.appendChild(pill);

    pill.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var r = pill.getBoundingClientRect();
      dragInfo = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragInfo) return;
      dragInfo.moved = true;
      pill.style.left = (e.clientX - dragInfo.dx) + 'px';
      pill.style.top = (e.clientY - dragInfo.dy) + 'px';
      pill.style.right = 'auto';
      pill.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', function () {
      if (!dragInfo) return;
      var moved = dragInfo.moved;
      dragInfo = null;
      if (moved) { suppressClick = true; ls('tokps.pos', JSON.stringify({ left: pill.style.left, top: pill.style.top })); }
    });

    panel = document.createElement('div');
    panel.id = 'tokps-panel';
    document.body.appendChild(panel);
    try {
      var pos = JSON.parse(ls('tokps.pos') || 'null');
      if (pos && pos.left && pos.top) {
        pill.style.left = pos.left; pill.style.top = pos.top;
        pill.style.right = 'auto'; pill.style.bottom = 'auto';
      }
    } catch (e) {}
    document.addEventListener('click', function () { toggle(false); });
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    if (ls('tokps.hidden') === '1') pill.style.display = 'none';
    toggle(false);
    return true;
  }

  function toggle(force) {
    if (!panel || !pill || pill.style.display === 'none') return;
    shown = (force === undefined) ? !shown : force;
    panel.style.display = shown ? 'block' : 'none';
    if (shown) paint();
  }

  var lastPaint = 0;
  function paintNow(force) {
    var t = Date.now();
    if (force || t - lastPaint > 80) { lastPaint = t; try { paint(); } catch (e) { log('paintNow', e); } }
  }

  function schedule() {
    if (raf) return;
    var run = function () { raf = 0; try { paint(); } catch (e) { log('paint', e); } };
    if (document.hidden) { raf = setTimeout(run, 150); return; }   /* 后台/最小化时 rAF 不触发 */
    try { raf = requestAnimationFrame(run); }
    catch (e) { raf = setTimeout(run, 150); }
  }

  function row(a, b, cls) {
    return '<div class="tokps-row' + (cls ? ' ' + cls : '') + '"><span>' + a + '</span><span>' + b + '</span></div>';
  }

  function paint() {
    if (!ensureUI()) return;
    var s = sessions[lastId] || sess(lastId);
    var tt = active(s) || s.turn || s.history[s.history.length - 1] || null;
    var live = !!(s.turn && !s.turn.done);
    var sp = tt ? speedOf(tt) : null;
    var live = (tt && !tt.done) ? liveSpeed(tt) : null;      /* 流式实时估算（照 dsh 口径） */
    var ctxPct = (s.ctxLimit > 0 && s.ctxTokens > 0) ? (s.ctxTokens / s.ctxLimit * 100) : null;

    /* ---- 浮标 ---- */
    var liveParts = [];
    var streaming = !!(s.turn && !s.turn.done);
    var estFallback = (sp === null && !live && tt) ? estSpeed(tt) : null;
    if (live) liveParts.push('<b>~' + fmtSpeed(live.tps) + '</b> tok/s');
    else if (sp !== null) liveParts.push('<b>' + fmtSpeed(sp) + '</b> tok/s');
    else if (estFallback !== null) liveParts.push('<b>~' + fmtSpeed(estFallback) + '</b> tok/s');
    else liveParts.push(streaming ? '计速中…' : '<b>—</b> tok/s');
    if (tt && tt.ttft !== null) liveParts.push('首字 ' + fmtSec(tt.ttft));
    liveParts.push('轮 ' + s.turns + ' · 步 ' + s.steps);
    if (ctxPct !== null) liveParts.push('上下文 ' + ctxPct.toFixed(ctxPct < 10 ? 1 : 0) + '%');
    var stTxt = statusText(s) + (s.status === 'tool' && s.curTool ? ': ' + s.curTool : '');
    liveEl.innerHTML = '<span class="tokps-dot" style="background:' + statusColor(s) + '"></span>' +
      stTxt + '<span class="tokps-dim"> · ' + liveParts.join(' · ') + '</span>';

    /* ---- 面板 ---- */
    var h = [];
    var cur = (s.turn && !s.turn.done) ? s.turn : null;
    var last = (s.history.length ? s.history[s.history.length - 1] : null);

    var head = cur || last;
    if (head) {
      var liveTurn = !!cur;
      var title = liveTurn
        ? '会话 ' + String(s.id).slice(0, 8) + ' · 本轮 #' + head.idx + ' · ' + statusText(s) +
          (s.status === 'tool' && s.curTool ? ' ' + s.curTool + ' ' + fmtSec(s.curToolStart !== null ? Date.now() - s.curToolStart : null) : '')
        : '会话 ' + String(s.id).slice(0, 8) + ' · 上一轮 #' + head.idx;
      h.push('<h4>' + title + '</h4>');
      h.push(row('已用时', fmtSec(liveTurn ? now() - head.t0 : head.totalMs)));
      h.push(row('模型用时', fmtSec(head.modelMs + (liveTurn && head.modelStart !== null ? now() - head.modelStart : 0))));
      h.push(row('工具调用用时', fmtSec(head.toolMs + (liveTurn && head.toolStart !== null ? now() - head.toolStart : 0))));
      h.push(row('首 token 延迟', fmtSec(head.ttft)));
      var measured = speedOf(head, liveTurn ? now() : undefined);
      var estv = estSpeed(head, liveTurn ? now() : undefined);
      h.push(row('实测速度', (measured === null ? '—' : fmtSpeed(measured) + ' tok/s') +
        (measured === null && estv !== null ? '（无 usage 数据，见估算）' : '')));
      if (measured === null && estv !== null) h.push(row('估算速度', '~' + fmtSpeed(estv) + ' tok/s · 估算 ' + fmtTok(head.estTotal) + ' tok'));
      if (liveTurn && live) {
        h.push(row('实时估算', '~' + fmtSpeed(live.tps) + ' tok/s · ' + fmtTok(live.tokens) + ' tok / ' + (live.winMs / 1000).toFixed(1) + '秒窗口'));
        if (head.calib && Math.abs(head.calib - 1) > 0.02) h.push(row('估算校准', '×' + head.calib.toFixed(2) + '（实测 / 估算）'));
      }
      h.push(row('输出 / API 调用', fmtTok(head.out) + ' tok / ' + head.apiCalls + ' 次'));
    }
    h.push('<canvas id="tokps-spark" width="272" height="46" style="margin-top:8px;width:272px;height:46px"></canvas>');

    if (head && head.calls.length) {
      h.push('<hr><h4>每次模型调用</h4>');
      var show = head.calls.slice(-6);
      for (var i = 0; i < show.length; i++) {
        var c = show[i];
        var idx = head.calls.length - show.length + i + 1;
        var estTps = (c.est > 0 && c.lastChunkAt > c.estStart)
          ? '~' + fmtSpeed(c.est / Math.max(TPS_MIN_WINDOW_MS, c.lastChunkAt - c.estStart) * 1000) + ' tok/s'
          : null;
        h.push(row('#' + idx + ' 等待 ' + fmtSec(c.waitMs),
          (c.out > 0 ? fmtTok(c.out) + ' tok · ' : '') + (c.speed ? fmtSpeed(c.speed) + ' tok/s' : (estTps || '—')) +
          (c.est > 0 ? '（估算 ' + fmtTok(c.est) + '）' : '')));
      }
    }

    h.push('<hr><h4>Token 明细（会话累计）</h4>');
    h.push(row('输入 / 输出', fmtTok(s.cumIn) + ' / ' + fmtTok(s.cumOut)));
    h.push(row('缓存读 / 缓存写', fmtTok(s.cumCacheRead) + ' / ' + fmtTok(s.cumCacheWrite)));
    h.push(row('推理 token', fmtTok(s.cumReasoning)));
    var hit = hitRate(s);
    h.push(row('缓存命中率', hit === null ? '—' : hit.toFixed(0) + '%'));
    h.push(row('上下文占用', s.ctxTokens > 0
      ? fmtTok(s.ctxTokens) + (s.ctxLimit > 0 ? ' / ' + fmtTok(s.ctxLimit) + ' (' + ctxPct.toFixed(ctxPct < 10 ? 1 : 0) + '%)' : '')
      : '—'));
    h.push(row('API 调用', s.apiCalls + ' 次'));

    h.push('<hr><h4>会话进度</h4>');
    h.push(row('轮数 / 工具步数', s.turns + ' / ' + s.steps + (s.stepFails ? '（失败 ' + s.stepFails + '）' : '')));
    h.push(row('工具总用时', fmtSec(s.toolMs)));
    h.push(row('子代理', '运行中 ' + s.subActive + (s.subDone.length ? ' · 已完成 ' + s.subDone.length : '')));
    var topTools = Object.keys(s.toolCounts).sort(function (a, b) { return s.toolCounts[b] - s.toolCounts[a]; }).slice(0, 4);
    if (topTools.length) h.push(row('常用工具', topTools.map(function (k) { return k + '×' + s.toolCounts[k]; }).join(' · ')));

    if (s.history.length) {
      var hs = s.history.slice(-5).reverse();
      var spd = hs.map(function (x) { return x.speed; }).filter(function (v) { return v !== null && isFinite(v); });
      h.push('<hr><h4>最近轮次</h4>');
      for (var j = 0; j < hs.length; j++) {
        var x = hs[j];
        h.push(row('#' + x.idx + ' ' + fmtSec(x.totalMs) + ' · ' + fmtTok(x.out) + ' tok', fmtSpeed(x.speed) + ' tok/s'));
      }
      if (spd.length) {
        var avg = spd.reduce(function (a, b) { return a + b; }, 0) / spd.length;
        h.push(row('平均 / 最快 / 最慢', fmtSpeed(avg) + ' / ' + fmtSpeed(Math.max.apply(null, spd)) + ' / ' + fmtSpeed(Math.min.apply(null, spd)) + ' tok/s'));
      }
    } else if (!cur) {
      h.push('<hr><h4>等待第一条消息…</h4>');
    }

    h.push('<hr><h4>诊断</h4>');
    h.push(row('已捕获', stats.frames + ' 帧 · ' + stats.events + ' 事件'));
    h.push(row('最近事件', (stats.lastEvent || '—') + (stats.lastKeys && stats.lastKeys.length ? ' · ' + stats.lastKeys.slice(0, 6).join(', ') : '')));

    h.push('<div class="tokps-btns"><button id="tokps-copy">复制统计</button><button id="tokps-reset">重置</button></div>');
    h.push('<div class="tokps-sub" style="margin-top:6px">速度按模型用时折算 · 数值为事件流推算（估算）</div>');
    panel.innerHTML = h.join('');

    var cb = panel.querySelector('#tokps-copy');
    if (cb) cb.addEventListener('click', function (e) { e.stopPropagation(); copyStats(s); });
    var rb = panel.querySelector('#tokps-reset');
    if (rb) rb.addEventListener('click', function (e) { e.stopPropagation(); resetSession(s); });

    drawSpark(s);
  }

  function drawSpark(s) {
    var cv = document.getElementById('tokps-spark');
    if (!cv || !cv.getContext) return;
    var g = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    var pts = s.samples.filter(function (p) { return p.v !== null && isFinite(p.v); });
    var dark = document.documentElement.classList.contains('dark');
    g.strokeStyle = dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.10)';
    g.beginPath(); g.moveTo(0, H - 1); g.lineTo(W, H - 1); g.stroke();
    if (pts.length < 2) {
      g.fillStyle = dark ? '#8a8a8a' : '#9a9a9a';
      g.font = '10px sans-serif';
      g.fillText(pts.length ? '采样中…' : '生成中才有曲线', 4, 13);
      return;
    }
    var vs = pts.map(function (p) { return p.v; });
    var mx = Math.max.apply(null, vs) * 1.15 || 1;
    var step = W / Math.max(1, pts.length - 1);
    g.beginPath();
    for (var i = 0; i < pts.length; i++) {
      var x = i * step, y = H - 3 - (pts[i].v / mx) * (H - 8);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokeStyle = '#0b6cff'; g.lineWidth = 1.6; g.stroke();
    g.fillStyle = dark ? '#9ca3af' : '#8a8a8a';
    g.font = '10px sans-serif';
    g.fillText(fmtSpeed(vs[vs.length - 1]) + ' tok/s', 3, 11);
    g.fillText('峰值 ' + fmtSpeed(mx / 1.15), W - 62, 11);
  }

  function copyStats(s) {
    function t2(l, v) { return l + ': ' + v; }
    var lines = ['【Ekko Studio 运行统计】' + new Date().toLocaleString()];
    lines.push(t2('状态', statusText(s)) + ' · ' + t2('轮/步', s.turns + '/' + s.steps + (s.stepFails ? '(失败' + s.stepFails + ')' : '')));
    var cur = active(s) || s.turn;
    if (cur) {
      lines.push(t2('本轮用时', fmtSec(cur.done ? cur.totalMs : now() - cur.t0)) + ' · ' + t2('模型用时', fmtSec(cur.modelMs)) + ' · ' + t2('工具用时', fmtSec(cur.toolMs)));
      lines.push(t2('首 token', fmtSec(cur.ttft)) + ' · ' + t2('实测速度', fmtSpeed(speedOf(cur)) + ' tok/s') + ' · ' + t2('输出', fmtTok(cur.out) + ' tok'));
    var lv2 = (cur && !cur.done) ? liveSpeed(cur) : null;
    if (lv2) lines.push(t2('实时估算', '~' + fmtSpeed(lv2.tps) + ' tok/s') + ' · ' + t2('估算 token', fmtTok(lv2.tokens)) + (cur.calib && Math.abs(cur.calib-1) > 0.02 ? ' · ' + t2('校准', '×' + cur.calib.toFixed(2)) : ''));
    }
    lines.push(t2('输入/输出', fmtTok(s.cumIn) + '/' + fmtTok(s.cumOut)) + ' · ' + t2('缓存读/写', fmtTok(s.cumCacheRead) + '/' + fmtTok(s.cumCacheWrite)));
    lines.push(t2('缓存命中率', (hitRate(s) === null ? '—' : hitRate(s).toFixed(0) + '%')) + ' · ' + t2('推理', fmtTok(s.cumReasoning)));
    if (cur && !isFinite(speedOf(cur)) && estSpeed(cur)) lines.push(t2('估算速度', '~' + fmtSpeed(estSpeed(cur)) + ' tok/s'));
    lines.push(t2('上下文', fmtTok(s.ctxTokens) + (s.ctxLimit ? ' / ' + fmtTok(s.ctxLimit) : '')) + ' · ' + t2('API 调用', s.apiCalls));
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(lines.join('\n'));
      else { var ta = document.createElement('textarea'); ta.value = lines.join('\n'); document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
      log('copied');
    } catch (e) { log('copy failed', e); }
  }

  function resetSession(s) {
    s.turns = 0; s.steps = 0; s.stepFails = 0; s.toolCounts = {}; s.toolMs = 0;
    s.subActive = 0; s.subDone = []; s.subTokens = 0;
    s.turn = null; s.history = []; s.samples = [];
    s.usageAsked = false; s.ctxAsked = false;
    schedule();
  }

  /* ============================ 传输层嗅探 ============================ */
  function parseSocketFrame(part) {
    if (!part || part.charCodeAt(0) !== 52) return false;      /* engine.io '4' = message */
    var j = part.indexOf('[');
    if (j < 0) return false;
    var arr;
    try { arr = JSON.parse(part.slice(j)); } catch (e) { return false; }
    if (!arr || typeof arr[0] !== 'string' || !arr[1] || typeof arr[1] !== 'object') return false;
    try { handle(arr[0], arr[1]); } catch (e) { log('handle', e); }
    return true;
  }
  function parseRawJson(text) {
    var s = String(text).trim();
    if (!s) return false;
    if (s.charAt(0) !== '{' && s.charAt(0) !== '[') return false;
    var obj;
    try { obj = JSON.parse(s); } catch (e) { return false; }
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) { try { parseRawJson(JSON.stringify(obj[i])); } catch (e) {} }
      return true;
    }
    if (!obj || typeof obj !== 'object') return false;
    var nm = obj.event || obj.type || obj.kind;
    if (typeof nm === 'string' && nm) { try { handle(nm, obj); } catch (e) { log('handle', e); } return true; }
    if (obj.payload && typeof obj.payload === 'object') {
      var nm2 = obj.payload.event || obj.payload.type;
      if (typeof nm2 === 'string' && nm2) { try { handle(nm2, obj.payload); } catch (e) {} return true; }
    }
    return false;
  }
  /* 统一的入口：socket.io 帧、NDJSON/SSE 行、裸 WebSocket JSON 都能吃 */
  function feedSocketText(text) {
    if (typeof text !== 'string' || !text) return;
    stats.frames++;
    var parts = text.split('\u001e');
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part) continue;
      var done = false;
      try { done = parseSocketFrame(part); } catch (e) { log('sock frame', e); }
      if (done) continue;
      var lines = part.split('\n');
      for (var L = 0; L < lines.length; L++) {
        var ln = lines[L].trim();
        if (!ln) continue;
        if (ln.indexOf('data:') === 0) ln = ln.slice(5).trim();     /* SSE 前缀 */
        if (ln === '[DONE]' || !ln) continue;
        try { parseRawJson(ln); } catch (e) { log('raw json', e); }
      }
    }
  }
  try {
    var OrigWS = window.WebSocket;
    if (OrigWS) {
      var Wrapped = function (url, protocols) {
        var ws = (protocols === undefined) ? new OrigWS(url) : new OrigWS(url, protocols);
        try {
          ws.addEventListener('message', function (ev) {
            try {
              var d = ev.data;
              if (typeof d === 'string') feedSocketText(d);
              else if (d instanceof ArrayBuffer) feedSocketText(new TextDecoder().decode(d));
            } catch (e) { log('ws parse', e); }
          });
        } catch (e) { log('ws hook', e); }
        return ws;
      };
      Wrapped.prototype = OrigWS.prototype;
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { try { Wrapped[k] = OrigWS[k]; } catch (e) {} });
      window.WebSocket = Wrapped;
    }

    var origFetch = window.fetch;
    if (origFetch) {
      var drain = function (res) {
        try {
          var rdr = (res.body && res.body.getReader) ? res.body.getReader() : null;
          if (!rdr) { res.text().then(feedSocketText, function () {}); return; }
          var dec = new TextDecoder();
          (function pump() {
            rdr.read().then(function (r) {
              if (r.done) return;
              try { feedSocketText(dec.decode(r.value, { stream: true })); } catch (e) {}
              pump();
            }, function () {});
          })();
        } catch (e) { log('drain', e); }
      };
      window.fetch = function (input, init) {
        var pr = origFetch.apply(this, arguments);
        try {
          var url = (typeof input === 'string') ? input : ((input && input.url) || '');
          var sniff = (url.indexOf('/socket.io/') !== -1) || (url.indexOf('/chat-run') !== -1) || (url.indexOf('/events') !== -1);
          pr.then(function (res) {
            try {
              var ct = (res.headers && res.headers.get) ? (res.headers.get('content-type') || '') : '';
              if (sniff || /ndjson|event-stream/i.test(ct)) {
                var clone = res.clone ? res.clone() : null;
                if (clone) drain(clone);
              }
            } catch (e) {}
          }, function () {});
        } catch (e) {}
        return pr;
      };
    }

    var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__tokpsUrl = String(url); } catch (e) {}
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        var self = this;
        var u = self.__tokpsUrl || '';
        if (u.indexOf('/socket.io/') !== -1 || u.indexOf('/chat-run') !== -1 || u.indexOf('/events') !== -1) {
          self.addEventListener('readystatechange', function () {
            try {
              if (self.readyState !== 3 || self.responseType === 'blob') return;
              var t = self.responseText || '';
              var seen = self.__tokpsSeen || 0;
              if (t.length > seen) { feedSocketText(t.slice(seen)); self.__tokpsSeen = t.length; }
            } catch (e) {}
          });
          self.addEventListener('load', function () {
            try {
              if (self.responseType === 'blob') return;
              var t = self.responseText || '';
              var seen = self.__tokpsSeen || 0;
              if (t.length > seen) { feedSocketText(t.slice(seen)); self.__tokpsSeen = t.length; }
            } catch (e) {}
          });
        }
      } catch (e) {}
      return XS.apply(this, arguments);
    };
  } catch (e) { log('transport hook failed', e); }

  window.__tokps = { handle: handle, feed: feedSocketText, paint: paint, state: sessions, stats: stats,
    debug: function () { return { stats: stats, diag: DIAG, sessions: Object.keys(sessions) }; }, version: '3.3.1' };

  /* 挂载兜底：脚本在 head 里执行时 body 还没出来，等 body 可用了再挂浮标 */
  var bootTimer = setInterval(function () {
    if (!pill || !document.body || !document.body.contains(pill)) {
      if (ensureUI()) { paint(); clearInterval(bootTimer); }
    } else { clearInterval(bootTimer); }
  }, 400);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { try { if (ensureUI()) paint(); } catch (e) {} });
  schedule();
})();
