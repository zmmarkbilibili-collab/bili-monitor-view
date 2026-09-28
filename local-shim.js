/* local-shim.js —— 前端数据访问 shim（四模：公网实时 / 本机全功能 / 在线可写 / 只读快照）
 *
 * 作用：把网页里 supabase-js 的链式调用（.from().select().eq().in().order()...）
 * 原样翻译到数据源。对外保持 window.supabase.createClient() 接口与 {data, error}
 * 返回形状不变，业务 JS 零改动。
 *
 * 四种模式，自动切换：
 *   live     —— 公网（GitHub Pages 等）且页面加载了真库 supabase-js.min.js
 *               → **原版行为**：直连 Supabase 读写，实时。真库一旦请求失败（网络被掐），
 *                 自动降级到 remote/snapshot 并在顶部提示，恢复后自动刷新回实时。
 *   local    —— 同源能访问 POST /api/db（本机 py 在跑 / 同网同事访问本机面板）
 *               → 全功能，读写本机 SQLite，立即生效。
 *   remote   —— 公网但拿不到真库（或真库已降级）且注入了 window.__BOARD_REMOTE__
 *               → 读：同域 data/db.json（本机定期推送的全量快照）
 *                 写：追加到 GitHub 仓库的 data/ops.json 队列，
 *                     本机监控每 2 分钟拉取并执行（含 BV 校验），再回写数据。
 *   snapshot —— 公网但没配 remote，或数据源都不可达
 *               → 只读，读页面内联的 window.__BOARD_DATA__。写操作明确报错，绝不静默失败。
 *
 * remote 模式写操作需要 GitHub token（该仓库 Contents 读写权限）：
 *   优先 localStorage['board_gh_token']（点左下角徽标粘贴，只存本机浏览器）
 *   其次 window.__BOARD_REMOTE__.token（由 export_board.py 注入，可留空）
 */
(function () {
  'use strict';

  var SNAP = (typeof window !== 'undefined' && window.__BOARD_DATA__) || null;
  var CFG = (typeof window !== 'undefined' && window.__BOARD_REMOTE__) || null;
  var MODE = 'local';          // 'live' | 'local' | 'remote' | 'snapshot'

  /* 真库：页面若按 <script src="supabase-js.min.js"> 加载过，这里就拿得到。
     公网优先用它直连数据库（原版实时行为），拿不到才退到快照。 */
  var REAL_LIB = null;
  try {
    if (typeof window !== 'undefined' && window.supabase &&
        typeof window.supabase.createClient === 'function') REAL_LIB = window.supabase;
  } catch (e) { REAL_LIB = null; }
  var RO_TAG_ID = '__board_ro_tag';
  var BANNER_ID = '__board_banner';
  var TOKEN_KEY = 'board_gh_token';
  var WROTE_HINT = false;      // 提交过操作后刷新页面不必再提示
  var FELL_BACK = false;       // 本机数据源连不上而降级（区别于"本来就在公网"）

  function tables() { return (SNAP && SNAP.tables) || {}; }
  function remoteReady() { return !!(CFG && CFG.repo); }

  /* ================= 内存查询引擎（snapshot / remote 读共用） ================= */
  function str(v) { return (v === null || v === undefined) ? '' : String(v); }

  function looseEq(a, b) {
    if (a === b) return true;
    if (a === null || a === undefined || b === null || b === undefined) {
      return (a === null || a === undefined) && (b === null || b === undefined);
    }
    var na = Number(a), nb = Number(b);
    if (a !== '' && b !== '' && !isNaN(na) && !isNaN(nb)) return na === nb;
    if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
    return str(a) === str(b);
  }

  function cmpVal(a, b) {
    var na = Number(a), nb = Number(b);
    if (a !== null && a !== undefined && b !== null && b !== undefined &&
        a !== '' && b !== '' && !isNaN(na) && !isNaN(nb)) {
      return na - nb;
    }
    var sa = str(a), sb = str(b);
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  }

  function matchOne(rv, v) {
    if (v === null) return rv === null || rv === undefined;
    if (typeof v === 'object' && !Array.isArray(v)) {
      if ('$ne' in v) return !looseEq(rv, v.$ne);
      if ('$gt' in v) return cmpVal(rv, v.$gt) > 0;
      if ('$gte' in v) return cmpVal(rv, v.$gte) >= 0;
      if ('$lt' in v) return cmpVal(rv, v.$lt) < 0;
      if ('$lte' in v) return cmpVal(rv, v.$lte) <= 0;
      if ('$in' in v) return (v.$in || []).some(function (x) { return looseEq(rv, x); });
      return false;
    }
    return looseEq(rv, v);
  }

  function applyWhere(rows, where) {
    if (!where) return rows;
    var keys = Object.keys(where);
    if (!keys.length) return rows;
    return rows.filter(function (r) {
      return keys.every(function (k) { return matchOne(r[k], where[k]); });
    });
  }

  function applyOrder(rows, order) {
    if (!order) return rows;
    var specs = [];
    String(order).split(',').forEach(function (seg) {
      seg = seg.trim();
      if (!seg) return;
      var desc = false, col = seg;
      if (seg.slice(-5) === '.desc') { col = seg.slice(0, -5); desc = true; }
      else if (seg.slice(-4) === '.asc') { col = seg.slice(0, -4); }
      else if (seg.charAt(0) === '-') { col = seg.slice(1); desc = true; }
      specs.push({ col: col, desc: desc });
    });
    if (!specs.length) return rows;
    return rows.slice().sort(function (a, b) {
      for (var i = 0; i < specs.length; i++) {
        var s = specs[i], c = cmpVal(a[s.col], b[s.col]);
        if (c !== 0) return s.desc ? -c : c;
      }
      return 0;
    });
  }

  function project(rows, keys) {
    if (!keys) return rows;
    var cols = String(keys).split(',').map(function (c) { return c.trim(); }).filter(Boolean);
    if (!cols.length) return rows;
    return rows.map(function (r) {
      var o = {};
      cols.forEach(function (c) { if (Object.prototype.hasOwnProperty.call(r, c)) o[c] = r[c]; });
      return o;
    });
  }

  function selectInMemory(p) {
    var rows = (tables()[p.table] || []).slice();
    rows = applyOrder(applyWhere(rows, p.where), p.order);
    if (p.skip) rows = rows.slice(p.skip);
    if (p.limit !== null && p.limit !== undefined) rows = rows.slice(0, p.limit);
    rows = project(rows, p.keys);
    if (p.single) {
      if (rows.length) return { data: rows[0], error: null };
      if (p.maybe) return { data: null, error: null };
      return { data: null, error: { message: 'No rows found', code: 'PGRST116' } };
    }
    return { data: rows, error: null };
  }

  function roError(msg) {
    return { data: null, error: {
      message: msg || ('当前是' + (MODE === 'remote' ? '在线看板（写通道未配置）' : '只读快照页') +
                       '。增删改请到本机监控面板或企微智能表格操作。'),
      code: 'READONLY'
    } };
  }

  /* ================= 状态徽标（右下角） ================= */
  function token() {
    var t = '';
    try { t = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { t = ''; }
    return String(t || (CFG && CFG.token) || '').trim();
  }

  function ageText(ts) {
    if (!ts) return null;
    var t = new Date(String(ts).replace(/-/g, '/'));
    if (isNaN(t.getTime())) return null;
    var mins = Math.floor((Date.now() - t.getTime()) / 60000);
    if (mins < 0) return null;
    return { mins: mins, text: mins < 60 ? (mins + ' 分钟前') : (Math.floor(mins / 60) + ' 小时前') };
  }

  function markStatus() {
    try {
      if (typeof document === 'undefined') return;
      var el = document.getElementById(RO_TAG_ID);
      var age = SNAP && ageText(SNAP.generated_at);
      var label, bg = 'rgba(0,0,0,.5)', op = '.75', clickable = false;

      if (MODE === 'live' && !FELL_BACK) {
        // 直连数据库正常 —— 页面保持干净，不挂任何角标（用户口径：不该一直弹东西）
        if (el) { try { el.remove(); } catch (e) {} }
        markBanner();
        return;
      }
      if (MODE === 'live') {
        label = '⚠ 离线 · 已切表格版';
        bg = 'rgba(190,30,30,.88)'; op = '1';
      } else if (MODE === 'local') {
        label = '本机直连 · 数据实时';
        bg = 'rgba(20,110,60,.85)'; op = '1';
      } else if (MODE === 'remote') {
        if (token()) {
          label = '在线可操作' + (age ? ' · 数据 ' + age.text + '更新' : '');
        } else {
          label = '在线只读 · 点此配置写入凭据' + (age ? '（数据 ' + age.text + '更新）' : '');
          clickable = true;
        }
      } else {
        label = '只读快照' + (age ? ' · 数据 ' + age.text + '更新' : '');
      }

      // 数据陈旧告警：≥30 分钟转橙、≥2 小时转红（说明监控可能停了）
      // live/local 是直连实时，不看快照年龄
      if (age && MODE !== 'local' && MODE !== 'live') {
        if (age.mins >= 120) {
          label = '数据 ' + age.text + '更新 · 监控可能已停止';
          bg = 'rgba(190,30,30,.88)'; op = '1';
        } else if (age.mins >= 30) {
          bg = 'rgba(190,120,10,.88)'; op = '1';
        }
      }
      if (SNAP && SNAP.pending) {
        label += ' · 有操作待本机处理';
        bg = 'rgba(20,90,180,.9)';
      }

      if (!el) {
        el = document.createElement('div');
        el.id = RO_TAG_ID;
        el.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99999;' +
          'color:#fff;font:12px/1.7 Arial,sans-serif;padding:1px 10px;border-radius:10px';
        (document.body || document.documentElement).appendChild(el);
      }
      el.textContent = label;
      el.style.background = bg;
      el.style.opacity = op;
      el.style.pointerEvents = clickable ? 'auto' : 'none';
      el.style.cursor = clickable ? 'pointer' : 'default';
      el.title = clickable
        ? '点一次粘贴 GitHub token（只存在本机浏览器，不会上传）；配好后即可在网页上增删改'
        : '';
      el.onclick = clickable ? setTokenByPrompt : null;
    } catch (e) { /* 提示失败不影响功能 */ }
    markBanner();
  }

  /* ================= 顶部提示条：网断 → 提示 + 跳到智能表格 =================
   * 口径（2026-09-28 用户确认）：
   *   网通 → 网页直连数据库 = 原版实时，页面**完全干净**（不挂角标、不挂提示条）
   *   网断 → 顶部红条提示"已切表格版"，8 秒倒计时后自动跳到智能表格，
   *          点「留在本页」可取消（本页仍能看最后一次快照）
   *   恢复 → 自动整页刷新回实时
   */
  function sheetUrl() {
    return (CFG && (CFG.sheetUrl || CFG.sheet)) || '';
  }

  var JUMP_DELAY = 8;                 // 自动跳表格倒计时（秒）
  var jumpTimer = null, jumpLeft = 0, jumpCancelled = false;
  var bannerKey = '';                 // 当前横幅状态；状态没变就不重建 DOM（否则倒计时被重置）

  function clearJump() {
    if (jumpTimer) { clearInterval(jumpTimer); jumpTimer = null; }
  }

  function jumpToSheet() {
    var u = sheetUrl();
    if (!u) return false;
    try { location.href = u; } catch (e) { try { window.open(u, '_blank'); } catch (x) {} }
    return true;
  }

  function startJump() {
    if (jumpTimer || jumpCancelled || !sheetUrl()) return;
    jumpLeft = JUMP_DELAY;
    jumpTimer = setInterval(function () {
      jumpLeft--;
      var n = document.getElementById('__board_jump_left');
      if (n) n.textContent = String(Math.max(jumpLeft, 0));
      if (jumpLeft <= 0) { clearJump(); jumpToSheet(); }
    }, 1000);
  }

  function markBanner() {
    try {
      if (typeof document === 'undefined') return;
      var el = document.getElementById(BANNER_ID);
      var age = SNAP && ageText(SNAP.generated_at);
      var ago = age ? String(age.text).replace(/前$/, '') : '';   // 去掉"前"，便于自行拼"前"字
      var key = '', bg = '', text = '';

      if (MODE === 'live' && !FELL_BACK) {
        key = 'ok';                                  // 直连数据库正常：不留任何提示
      } else if (FELL_BACK) {
        key = 'down';
        bg = 'rgba(190,30,30,.95)';
        text = '⚠ 数据库连不上，已切到智能表格版' + (ago ? '（数据截至 ' + ago + '前）' : '');
      } else if (MODE === 'snapshot') {
        key = 'ro';
        bg = 'rgba(190,30,30,.95)';
        text = '未配置在线数据源，当前显示内置快照' + (ago ? '（数据 ' + ago + '前）' : '');
      } else if (age && age.mins >= 120) {
        key = 'stale2h';
        bg = 'rgba(190,30,30,.95)';
        text = '数据已 ' + ago + '未更新，请以智能表格为准（本机监控可能已停止）';
      } else if (age && age.mins >= 30) {
        key = 'stale30';
        bg = 'rgba(190,120,10,.95)';
        text = '数据已 ' + ago + '未更新，当前为表格版';
      } else {
        key = 'ok';
      }

      if (key === bannerKey) return;     // 状态没变 → 不碰 DOM（保住倒计时进度）
      bannerKey = key;

      if (key === 'ok') {
        if (el) { try { el.remove(); } catch (e) {} }
        clearJump();
        return;
      }
      if (!el) {
        el = document.createElement('div');
        el.id = BANNER_ID;
        el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;' +
          'color:#fff;font:12px/2 Arial,sans-serif;padding:0 12px;text-align:center';
        (document.body || document.documentElement).appendChild(el);
      }
      el.style.background = bg;
      el.textContent = '';

      var span = document.createElement('span');
      span.textContent = text;
      el.appendChild(span);

      var u = sheetUrl();
      if (u) {
        var a = document.createElement('a');
        a.href = u;
        a.textContent = '打开智能表格 →';
        a.style.cssText = 'color:#fff;text-decoration:underline;margin-left:10px';
        el.appendChild(document.createTextNode('　'));
        el.appendChild(a);

        // 真断线才自动跳；只是数据旧（stale30）就给个链接，不打扰
        if (key === 'down' || key === 'ro' || key === 'stale2h') {
          el.appendChild(document.createTextNode('　'));
          var n = document.createElement('span');
          n.id = '__board_jump_left';
          n.textContent = String(JUMP_DELAY);
          el.appendChild(n);
          el.appendChild(document.createTextNode(' 秒后自动前往'));

          var stay = document.createElement('a');
          stay.href = 'javascript:void(0)';
          stay.textContent = '留在本页';
          stay.style.cssText = 'color:#fff;text-decoration:underline;margin-left:12px';
          stay.onclick = function (ev) {
            if (ev && ev.preventDefault) ev.preventDefault();
            if (ev && ev.stopPropagation) ev.stopPropagation();
            jumpCancelled = true;
            clearJump();
            try {
              var x = document.getElementById('__board_jump_left');
              if (x) x.textContent = '自动跳转已取消';
            } catch (e) {}
            return false;
          };
          el.appendChild(stay);
          startJump();
        }
      }
    } catch (e) { /* 提示失败不影响功能 */ }
  }

  function setTokenByPrompt() {
    var cur = '';
    try { cur = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
    var t = window.prompt('粘贴 GitHub token（fine-grained，该仓库 Contents = Read and write）。\n' +
                          '只保存在本机浏览器，不会写进任何文件。', cur || '');
    if (t === null) return;
    try { localStorage.setItem(TOKEN_KEY, String(t).trim()); } catch (e) {}
    markStatus();
    toast('写入凭据已保存');
  }

  function toast(msg) {
    try {
      if (typeof document === 'undefined') return;
      var d = document.createElement('div');
      d.textContent = msg;
      d.style.cssText = 'position:fixed;left:50%;bottom:56px;transform:translateX(-50%);z-index:99999;' +
        'background:rgba(20,20,20,.88);color:#fff;font:13px/1.6 Arial,sans-serif;' +
        'padding:8px 16px;border-radius:8px;max-width:80vw;text-align:center';
      (document.body || document.documentElement).appendChild(d);
      setTimeout(function () { try { d.remove(); } catch (e) {} }, 4000);
    } catch (e) {}
  }

  /* ================= remote：GitHub 仓库当共享库 ================= */
  function apiUrl(path) {
    return 'https://api.github.com/repos/' + CFG.repo + '/contents/' + path;
  }

  /* UTF-8 与 base64 互转：用 escape/unescape 技巧，不依赖 TextEncoder（兼容性更好） */
  function b64Decode(b64) {
    return decodeURIComponent(escape(atob(String(b64).replace(/\s/g, ''))));
  }

  function b64Encode(s) {
    return btoa(unescape(encodeURIComponent(String(s))));
  }

  function ghHeaders() {
    return {
      Authorization: 'Bearer ' + token(),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  /** 读仓库里的 json 文件。返回 {sha, json}；文件不存在 → {sha:null, json:null} */
  function ghGet(path) {
    return fetch(apiUrl(path) + '?ref=' + encodeURIComponent(CFG.branch || 'main') + '&t=' + Date.now(), {
      cache: 'no-store', headers: ghHeaders()
    }).then(function (r) {
      if (r.status === 404) return { sha: null, json: null };
      if (!r.ok) { var e = new Error('GitHub ' + r.status); e.status = r.status; throw e; }
      return r.json().then(function (j) {
        return { sha: j.sha, json: JSON.parse(b64Decode(j.content)) };
      });
    });
  }

  function ghPut(path, obj, sha, message) {
    var body = {
      message: message, content: b64Encode(JSON.stringify(obj)),
      branch: CFG.branch || 'main'
    };
    if (sha) body.sha = sha;
    return fetch(apiUrl(path), {
      method: 'PUT',
      headers: (function () { var h = ghHeaders(); h['Content-Type'] = 'application/json'; return h; })(),
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          var e = new Error((j && j.message) || ('GitHub ' + r.status));
          e.status = r.status;
          throw e;
        }
        return j;
      });
    });
  }

  /** 把一次写操作追加进远端 ops 队列（读-改-写，冲突自动重试） */
  function submitOp(payload) {
    if (!remoteReady()) return Promise.resolve(roError('在线看板未配置仓库地址，无法提交。'));
    if (!token()) {
      var m = '未配置写入凭据：点左下角徽标粘贴一次 GitHub token（只存本机浏览器）。';
      markStatus();
      toast(m);
      return Promise.resolve({ data: null, error: { message: m, code: 'NO_TOKEN' } });
    }
    var path = CFG.opsPath || 'data/ops.json';
    var tries = 0;
    function attempt() {
      return ghGet(path).then(function (g) {
        var doc = (g.json && typeof g.json === 'object') ? g.json : {};
        if (!Array.isArray(doc.ops)) doc.ops = [];
        doc.ops.push({
          id: 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          ts: new Date().toISOString(),
          from: (CFG.machine || ''),
          payload: payload
        });
        // 队列过长时只保留最近 200 条，避免文件无限膨胀
        if (doc.ops.length > 200) doc.ops = doc.ops.slice(-200);
        return ghPut(path, doc, g.sha, 'board: ' + (payload.op || '') + ' ' + (payload.table || ''));
      }).catch(function (e) {
        tries += 1;
        var st = e && e.status;
        if (tries < 3 && (st === 409 || st === 0 || st === undefined)) {
          return new Promise(function (res) { setTimeout(res, 500 * tries); }).then(attempt);
        }
        throw e;
      });
    }
    return attempt().then(function () {
      WROTE_HINT = true;
      try { sessionStorage.setItem('board_wrote', '1'); } catch (e) {}
      toast('已提交 ✓ 本机监控运行中时约 2 分钟内处理，之后刷新看板可见');
      return { data: null, error: null };
    }, function (e) {
      var m = String((e && e.message) || e);
      if (/401|403/.test(m)) m += '（token 无效或权限不足，需该仓库 Contents: Read and write）';
      else if (/404/.test(m)) m += '（仓库或分支不存在，或 token 未勾选该仓库）';
      toast('提交失败：' + m);
      return { data: null, error: { message: '提交失败：' + m, code: 'GH' } };
    });
  }

  function remoteExec(p) {
    if (p.op === 'select') return selectInMemory(p);
    return submitOp(p);
  }

  /** 调页面刷新钩子；钩子可能还没定义（页面脚本尚未跑完），最多重试 3 次 */
  function fireRefresh(tryNo) {
    if (typeof window.__BOARD_REFRESH__ === 'function') {
      try { window.__BOARD_REFRESH__(); } catch (e) {}
      return;
    }
    if (tryNo < 3) setTimeout(function () { fireRefresh(tryNo + 1); }, 300);
  }

  /** 拉取同域 data/db.json（本机定期推送的全量快照），到达后刷新页面数据 */
  function loadRemote() {
    var path = CFG.dbPath || 'data/db.json';
    return fetch(path + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.tables) return false;
        if (!SNAP) SNAP = {};
        SNAP.tables = j.tables;
        SNAP.generated_at = j.generated_at || SNAP.generated_at;
        SNAP.machine = j.machine || SNAP.machine;
        SNAP.pending = !!j.pending;
        window.__BOARD_DATA__ = SNAP;      // 同步回全局，便于页面/调试直接读
        // 通知页面把数据重读一遍（board.html 里由 export_board.py 注入的钩子）
        fireRefresh(0);
        markStatus();
        return true;
      })
      .catch(function () { return false; });
  }

  /* ================= local：POST /api/db ================= */
  function once(payload) {
    return fetch('/api/db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { throw new Error('本地服务返回异常（py 是否在跑？）'); });
    });
  }

  function req(payload) {
    if (MODE === 'snapshot') return Promise.resolve(selectOnly(payload));
    if (MODE === 'remote') return Promise.resolve(remoteExec(payload));
    var tries = 0;
    function attempt() {
      return once(payload).catch(function (e) {
        tries += 1;
        if (tries < 2) {
          return new Promise(function (res) { setTimeout(res, 300 * tries); }).then(attempt);
        }
        // 本机数据源拿不到：公网看板 → 有 remote 配置走在线可写，否则退回只读快照
        MODE = remoteReady() ? 'remote' : 'snapshot';
        FELL_BACK = true;
        markStatus();
        if (MODE === 'remote') {
          if (!loadRemoteStarted) { loadRemoteStarted = true; loadRemote(); }
          return remoteExec(payload);
        }
        return selectOnly(payload);
      });
    }
    return attempt();
  }

  /** 只读模式：select 走内存，写操作明确报错 */
  function selectOnly(p) {
    if (p.op === 'select') return selectInMemory(p);
    return roError();
  }

  var loadRemoteStarted = false;

  /* ================= supabase-js 链式 API（对外形状不变） ================= */
  function QB(table) {
    this.table = table;
    this._where = {};      // {col: value | null | {$ne/$gt/$gte/$lt/$lte/$in}}
    this._keys = null;
    this._order = [];
    this._limit = null;
    this._skip = null;
    this._single = false;
    this._maybe = false;
    this._op = 'select';
    this._payload = null;
    this._onConflict = null;
    this._selectAfterWrite = false;
  }
  QB.prototype.select = function (cols) {
    if (cols && cols !== '*') this._keys = cols;
    if (this._op !== 'select') this._selectAfterWrite = true;
    return this;
  };
  QB.prototype.eq = function (c, v) { this._where[c] = (v === null || v === undefined) ? null : v; return this; };
  QB.prototype.neq = function (c, v) { this._where[c] = { $ne: v }; return this; };
  QB.prototype.is = function (c, v) { this._where[c] = (v === null) ? null : v; return this; };
  QB.prototype.not = function (c, op, v) {
    var map = { eq: '$ne', gt: '$lt', gte: '$lte', lt: '$gt', lte: '$gte' };
    var mk = map[op] ? Object.defineProperty({}, map[op], { value: v, enumerable: true }) : null;
    this._where[c] = mk || v;
    return this;
  };
  QB.prototype.in = function (c, arr) { this._where[c] = { $in: arr }; return this; };
  QB.prototype.gt = function (c, v) { this._where[c] = { $gt: v }; return this; };
  QB.prototype.gte = function (c, v) { this._where[c] = { $gte: v }; return this; };
  QB.prototype.lt = function (c, v) { this._where[c] = { $lt: v }; return this; };
  QB.prototype.lte = function (c, v) { this._where[c] = { $lte: v }; return this; };
  QB.prototype.order = function (col, opts) {
    this._order.push((opts && opts.ascending === false ? '-' : '') + col);
    return this;
  };
  QB.prototype.limit = function (n) { this._limit = n; return this; };
  QB.prototype.range = function (a, b) { this._skip = a; this._limit = b - a + 1; return this; };
  QB.prototype.single = function () { this._single = true; return this; };
  QB.prototype.maybeSingle = function () { this._single = true; this._maybe = true; return this; };
  QB.prototype.insert = function (payload) { this._op = 'insert'; this._payload = payload; return this; };
  QB.prototype.update = function (payload) { this._op = 'update'; this._payload = payload; return this; };
  QB.prototype.delete = function () { this._op = 'delete'; return this; };
  QB.prototype.upsert = function (payload, opts) {
    this._op = 'upsert'; this._payload = payload;
    if (opts && opts.onConflict) this._onConflict = opts.onConflict;
    return this;
  };
  QB.prototype._exec = function () {
    var self = this;
    var payload = {
      op: self._op, table: self.table,
      where: Object.keys(self._where).length ? self._where : null,
      keys: self._keys,
      order: self._order.join(',') || null,
      limit: self._limit, skip: self._skip,
      single: self._single && self._op === 'select',
      maybe: self._maybe,
      payload: self._payload,
      onConflict: self._onConflict
    };
    return req(payload).then(function (res) {
      var data = (res && Object.prototype.hasOwnProperty.call(res, 'data')) ? res.data : res;
      var error = (res && res.error) ? res.error : null;
      if (!error && self._op !== 'select' && self._op !== 'delete' &&
          !self._selectAfterWrite && self._single !== true) {
        // supabase-js 写操作不带 .select() 时 data 为 null，保持形状一致
        return { data: null, error: null };
      }
      return { data: data, error: error };
    }, function (e) {
      return { data: null, error: { message: e.message, code: 'LOCAL_NET' } };
    });
  };
  // supabase-js 的 thenable：QB 可直接被 await
  QB.prototype.then = function (onF, onR) { return this._exec().then(onF, onR); };
  QB.prototype.catch = function (onR) { return this._exec().catch(onR); };
  QB.prototype.finally = function (fn) { return this._exec().finally(fn); };

  /** 纯 shim 客户端：local / remote / snapshot 三模都用它 */
  function shimClient() {
    return {
      from: function (table) { return new QB(table); },
      // 常用辅助（网页里用到的极少，兜底空实现）
      channel: function () {
        var c = { on: function () { return c; }, subscribe: function () { return c; } };
        return c;
      },
      removeChannel: function () {}
    };
  }

  var SHIM_LIB = { createClient: function () { return shimClient(); } };

  /* ================= live：真库直连，失败自动降级 =================
   * 语义：网通 → 完全走真库（与原版 index.html 行为一致，实时读写）；
   *       真库请求失败（网络被掐/TLS 失败/超时）→ 就地降级到
   *       remote（快照读 + ops 队列写）或 snapshot（只读），顶部挂提示条，
   *       并每 60 秒探测一次，恢复后自动刷新回实时。
   */
  var CHAIN_METHODS = ['select', 'eq', 'neq', 'is', 'not', 'in', 'gt', 'gte', 'lt', 'lte',
                       'order', 'limit', 'range', 'single', 'maybeSingle',
                       'insert', 'update', 'delete', 'upsert'];
  var SUPA_URL = '';
  var recoveryTimer = null;

  /** 判断是不是"连不上"类错误（区别于正常的业务错误，如唯一键冲突） */
  function isNetErr(e) {
    if (!e) return false;
    var name = '';
    try { name = String(e.name || ''); } catch (x) {}
    var m = '';
    try { m = String(e.message || e.error_description || e.details || e || ''); } catch (x) {}
    if (typeof e === 'string') m = e;
    m = m.toLowerCase();
    if (/failed to fetch|networkerror|network error|fetch failed|load failed|timeout|timed out|etimedout|econnrefused|econnreset|unexpected eof|aborted|net::|tls|ssl/.test(m)) return true;
    return !m && (name === 'TypeError' || name === 'AbortError');
  }

  /** 降级：真库不可用 → 切快照读 + 队列写 */
  function degrade(reason) {
    if (MODE !== 'live') return;
    MODE = remoteReady() ? 'remote' : 'snapshot';
    FELL_BACK = true;
    jumpCancelled = false; bannerKey = '';   // 让顶部提示条重建（重新开始倒计时）
    if (!loadRemoteStarted) { loadRemoteStarted = true; loadRemote(); }
    try { markStatus(); markBanner(); } catch (e) {}
    startRecovery();
  }

  /** 每 60 秒探一次真库，能通了就整页刷新，自动回到实时模式 */
  function startRecovery() {
    if (recoveryTimer || !SUPA_URL) return;
    recoveryTimer = setInterval(function () {
      fetch(SUPA_URL + '/auth/v1/health', { cache: 'no-store' })
        .then(function (r) { if (r && r.status < 500) location.reload(); })
        .catch(function () {});
    }, 60000);
  }

  /** 包裹真库的查询构造器：记录整条链，真库失败时在 shim 上原样重放 */
  function hybridFrom(live, table) {
    var st = { _table: table, _chain: [], _real: null };
    try { st._real = live.from(table); } catch (e) { st._real = null; }

    CHAIN_METHODS.forEach(function (m) {
      st[m] = function () {
        var args = Array.prototype.slice.call(arguments);
        st._chain.push([m, args]);
        if (st._real) {
          try { st._real[m].apply(st._real, args); } catch (e) { st._real = null; }
        }
        return st;
      };
    });

    function replayOnShim() {
      var qb = new QB(st._table);
      st._chain.forEach(function (c) {
        try { qb[c[0]].apply(qb, c[1]); } catch (e) {}
      });
      return Promise.resolve(qb);   // QB 是 thenable，这里会拿到 {data, error}
    }

    st._exec = function () {
      if (MODE === 'live' && st._real) {
        return Promise.resolve(st._real).then(function (res) {
          if (res && res.error && isNetErr(res.error)) { degrade(res.error); return replayOnShim(); }
          return res;
        }, function (e) {
          if (isNetErr(e)) { degrade(e); return replayOnShim(); }
          return { data: null, error: { message: String((e && e.message) || e), code: 'LIVE' } };
        });
      }
      return replayOnShim();
    };
    st.then = function (f, r) { return st._exec().then(f, r); };
    st.catch = function (r) { return st._exec().catch(r); };
    st.finally = function (f) { return st._exec().finally(f); };
    return st;
  }

  function hybridLib() {
    return {
      createClient: function (url, key) {
        SUPA_URL = String(url || '').replace(/\/+$/, '');
        var live = REAL_LIB.createClient(url, key);
        return {
          from: function (t) { return hybridFrom(live, t); },
          channel: function () {
            try { return live.channel.apply(live, arguments); }
            catch (e) { var c = { on: function () { return c; }, subscribe: function () { return c; } }; return c; }
          },
          removeChannel: function () { try { return live.removeChannel.apply(live, arguments); } catch (e) {} },
          auth: live && live.auth ? live.auth : undefined
        };
      }
    };
  }

  /* ================= 启动：判定模式 ================= */
  function isIntranet(host) {
    return /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/i
      .test(String(host || ''));
  }

  /** 轻量探测本机面板是否可达（同源才有 /api/db）。
   *  用途：看板挂在自定义域名/VPN 域名下指向本机时，hostname 判不出内网，
   *  靠这次探测把模式纠正回 local，保证拿到的是"即时生效"的全功能。 */
  function probeLocal() {
    return fetch('/api/db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'select', table: '__probe__', where: null, limit: 1 })
    }).then(function (r) { return !!r.ok; })
      .catch(function () { return false; });
  }

  (function boot() {
    if (typeof window === 'undefined') return;
    var host = '';
    var proto = '';
    try { host = window.location.hostname; proto = window.location.protocol; } catch (e) {}
    var intranet = isIntranet(host);

    if (proto === 'file:') {
      MODE = 'snapshot';
      window.supabase = SHIM_LIB;

    } else if (!intranet && REAL_LIB) {
      // 公网 + 页面加载了真库 → 原版行为：直连数据库，实时读写
      MODE = 'live';
      window.supabase = hybridLib();
      // 后台顺手把仓库快照拉下来：真库一旦被掐，降级能立刻有数据
      if (remoteReady()) { loadRemoteStarted = true; loadRemote(); }
      // 万一同源其实可达（自定义域名指向本机面板）→ 纠正为 local，享受即时读写
      probeLocal().then(function (yes) {
        if (!yes || MODE !== 'live') return;
        MODE = 'local';
        window.supabase = SHIM_LIB;
        markStatus(); markBanner(); fireRefresh(0);
      });

    } else if (!intranet && remoteReady()) {
      // 公网但没真库（board.html 那种自包含页）：退到在线可写（快照读 + 队列写）
      MODE = 'remote';
      window.supabase = SHIM_LIB;
      loadRemoteStarted = true;
      loadRemote();
      probeLocal().then(function (yes) {
        if (!yes || MODE !== 'remote') return;
        MODE = 'local';
        window.supabase = SHIM_LIB;
        markStatus(); markBanner(); fireRefresh(0);
      });

    } else {
      MODE = 'local';
      window.supabase = SHIM_LIB;
    }
    markStatus();
    markBanner();

    // 断网/恢复（浏览器级）：断网立刻提示 + 准备跳智能表格；网络回来刷新回实时
    try {
      window.addEventListener('offline', function () {
        FELL_BACK = true; jumpCancelled = false; bannerKey = '';
        try { markStatus(); markBanner(); } catch (e) {}
      });
      window.addEventListener('online', function () {
        if (MODE === 'live') { try { location.reload(); } catch (e) {} }
      });
    } catch (e) {}
  })();

  // 供调试/自检：当前处在哪一档
  Object.defineProperty(window, '__BOARD_MODE__', {
    get: function () { return MODE; }, configurable: true
  });
  window.__BOARD_RELOAD_REMOTE__ = loadRemote;
})();
