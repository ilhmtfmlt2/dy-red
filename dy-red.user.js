// ==UserScript==
// @name         抖音评论红字（评论区变色）
// @namespace    https://github.com/ilhmtfmlt2/dy-red
// @version      4.0.0
// @description  抖音网页版评论区给评论加红色字体/位置/话题样式。text_extra 注入，别人也能看到颜色。含面板、持续模式、发送诊断与回读验证。
// @author       ilhmtfmlt2
// @match        https://www.douyin.com/*
// @match        https://*.douyin.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 基础环境
  // ---------------------------------------------------------------------------
  var WIN = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  var XHR = (WIN && WIN.XMLHttpRequest) || window.XMLHttpRequest;
  var PUBLISH_MARK = '/aweme/v1/web/comment/publish';
  var LIST_MARK = '/aweme/v1/web/comment/list';
  var TAG = '[DY-Style]';

  function log() {
    try {
      var args = Array.prototype.slice.call(arguments);
      console.log.apply(console, ['%c' + TAG, 'color:#e0245e;font-weight:bold'].concat(args));
    } catch (e) {}
  }
  function warn() {
    try {
      var args = Array.prototype.slice.call(arguments);
      console.warn.apply(console, [TAG].concat(args));
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 存储（GM 优先，失败则内存兜底）
  // ---------------------------------------------------------------------------
  var memStore = {};
  var store = {
    get: function (k, d) {
      try {
        if (typeof GM_getValue === 'function') {
          var v = GM_getValue(k, undefined);
          return v === undefined ? d : v;
        }
      } catch (e) {}
      return Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : d;
    },
    set: function (k, v) {
      memStore[k] = v;
      try { if (typeof GM_setValue === 'function') GM_setValue(k, v); } catch (e) {}
    }
  };

  // ---------------------------------------------------------------------------
  // 预设：type 枚举来源（2026-11 全部有实证）
  //   DouX APK 逆向（comment/t6.java）+ 线上评论 JSON 实测：
  //   21   = 搜索命中红字（新版评论区渲染为红/深色黄，iOS 也认）
  //          线上实测结构: {"start":0,"end":7,"user_id":"","type":21,"hashtag_name":"","hashtag_id":""}
  //   65282= web 端私有粉色（2023 知乎/吾爱实测，安卓 App 可见，web/iOS 不渲染）
  //   1    = 话题 hashtag 蓝字（旧版评论区可见）
  //   33   = POI 位置色（2026-11-23 实测 status_code=0 ✅）
  //   0    = @ 提及（需 user_id / sec_uid）
  //   5    = 搜索词高亮（读者侧自动生成，带 search_text，手动构造无意义）
  // ---------------------------------------------------------------------------
  // 2026-11-23 web 端实测定稿：
  //   21  红字  -> status_code=0 ✅（网页端也渲染红色）
  //   1   蓝字  -> status_code=0 ✅
  //   65282 粉  -> status_code=5, comment:null ❌ 服务端直接拒（type 白名单已不含 65282）
  var PRESETS = [
    { id: 'red',  type: 21,    label: '红字',    tone: 'red',  desc: '文字变红（深色模式显示为黄）。type 21' },
    { id: 'blue', type: 1,     label: '蓝字',    tone: 'blue', desc: '话题蓝：填话题名后正文会自动加 #话题名#，这是唯一人人可见的蓝色；不填话题名则裸发 type 1（多半被剥离）' },
    { id: 'alt',  type: 'alt',  label: '红蓝·连续', tone: 'alt',  desc: 'DouX 原版：每字一段，21(红)/1(蓝) 交替；蓝在 web 可能被服务端剥离' },
    { id: 'alt2', type: 'alt2', label: '红黄·隔字', tone: 'alt2', desc: '线上样本手法：全 type 21，隔字染色，客户端可能交替上色（红/黄）' },
    { id: 'loc',  type: 33,    label: '位置',    tone: 'loc',  desc: '位置样式：发送时自动在正文前加 [位置] 前缀（DouX 同款），配 poi_id 效果更好' },
    { id: 'at',   type: 0,     label: '@',       dead: 'web 端 @ 被服务端拒绝（status_code=5）；要 @ 请用输入框原生功能' },
    { id: 'pink', type: 65282, label: '粉色',    dead: '服务端已拒绝 65282（status_code=5）' }
  ];

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------
  var S = {
    enabled:   store.get('ds_enabled', true),
    presetId:  (function () { var lp = store.get('ds_lastPick', 'red'); return (lp === 'blue' || lp === 'alt' || lp === 'loc' || lp === 'custom') ? lp : 'red'; })(),
    customType: parseInt(store.get('ds_customType', 21), 10) || 21,
    rangeMode: store.get('ds_rangeMode', 'all'), // all | head | custom
    headN:     parseInt(store.get('ds_headN', 3), 10) || 3,
    startVal:  parseInt(store.get('ds_startVal', 0), 10) || 0,
    endVal:    parseInt(store.get('ds_endVal', 3), 10) || 0,
    persist:   !!store.get('ds_persist', false), // 持续模式：每条都带
    uid:       store.get('ds_uid', ''),
    secUid:    store.get('ds_secUid', ''),
    poiId:     store.get('ds_poiId', ''),
    hashtagName: store.get('ds_hashtagName', ''),
    hashtagId:   store.get('ds_hashtagId', '')
  };

  // 旧版本可能把 presetId 存成 custom；若其 type 与某个可用预设相同，归回该预设，避免刷新后误显示"自定义"
  (function normalizePreset() {
    // custom 且 type 与某预设相同 -> 归回该预设
    if (S.presetId === 'custom') {
      for (var i = 0; i < PRESETS.length; i++) {
        if (!PRESETS[i].dead && PRESETS[i].type === S.customType) {
          S.presetId = PRESETS[i].id;
          store.set('ds_lastPick', S.presetId);
          break;
        }
      }
    }
    // 旧版 range -> custom（v2.7 之前的三档命名）
    if (S.rangeMode === 'range') {
      S.rangeMode = 'custom';
      store.set('ds_rangeMode', 'custom');
    }
  })();

  var pending = null;          // {type,start,end} 待应用（一次性）
  var lastApplied = null;      // 最近一次实际注入
  var lastSentText = store.get('ds_lastText', '');
  var lastPublish = null;      // {path, fields:[], injected:bool, status, resp}
  var lastVerify = '';         // 回读验证结果文本
  var ui = null;               // 面板引用
  var panelOpen = false;       // 面板展开状态（跨 SPA 重建保持）
  var fabFlashing = false;     // 胶囊成功闪烁中
  var docListenersBound = false; // document 级监听只绑一次
  var inlineBtn = null;          // 评论输入框旁的入口按钮
  var lastInputRect = null;      // 输入框最近位置（面板定位用）
  var inlineRaf = 0;             // 滚动节流

  function saveState() {
    store.set('ds_enabled', S.enabled);
    store.set('ds_lastPick', S.presetId);
    store.set('ds_customType', S.customType);
    store.set('ds_rangeMode', S.rangeMode);
    store.set('ds_headN', S.headN);
    store.set('ds_startVal', S.startVal);
    store.set('ds_endVal', S.endVal);
    store.set('ds_persist', S.persist);
    store.set('ds_uid', S.uid);
    store.set('ds_secUid', S.secUid);
    store.set('ds_poiId', S.poiId);
    store.set('ds_hashtagName', S.hashtagName);
    store.set('ds_hashtagId', S.hashtagId);
  }

  function presetById(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return PRESETS[0];
  }

  function currentType() {
    if (S.presetId === 'custom') return S.customType | 0;
    return presetById(S.presetId).type;
  }

  function typeLabel(t) {
    if (t === 'alt') return '红蓝·连续';
    if (t === 'alt2') return '红黄·隔字';
    if (t === 21) return '红字 21';
    if (t === 1) return '蓝字 1';
    if (t === 33) return '位置 33';
    if (t === 0) return '@ 0';
    if (t === 65282) return '粉色 65282';
    return 'type ' + t;
  }

  // ---------------------------------------------------------------------------
  // 请求体工具
  // ---------------------------------------------------------------------------
  function upsertField(body, key, value) {
    var enc = encodeURIComponent(value);
    var re = new RegExp('(^|&)' + key + '=([^&]*)');
    if (re.test(body)) return body.replace(re, '$1' + key + '=' + enc);
    return body + (body.length && body.charAt(body.length - 1) !== '&' ? '&' : '') + key + '=' + enc;
  }

  function clampInt(v, min, max) {
    v = parseInt(v, 10);
    if (isNaN(v)) v = min;
    return Math.min(max, Math.max(min, v));
  }

  // 计算并构造样式段；返回 null 表示不注入
  // 字段结构对齐 2026-11 线上评论 JSON 实测：
  //   红字21: {"start":0,"end":7,"user_id":"","type":21,"hashtag_name":"","hashtag_id":""}
  //   @ 0  : {"start":0,"end":4,"user_id":"...","type":0,"hashtag_name":"","hashtag_id":"","sec_uid":"..."}
  function buildSegments(text, style) {
    var start = 0;
    var end = text.length;
    if (style && style.type === 33) {
      // 位置样式固定整段（部分染色对 POI 无意义）
      start = 0;
      end = text.length;
    } else if (style && style.mode === 'head') {
      start = 0;
      end = clampInt(style.headN, 1, text.length);
    } else if (style && (style.mode === 'range' || style.mode === 'custom')) {
      start = clampInt(style.start, 0, text.length);
      end = clampInt(style.end, 0, text.length);
      if (end <= start) { start = 0; end = text.length; }
    }
    if (end <= start) return null;

    // 交替彩字·DouX 原版（t6.java red_blue_alt）：
    //   每个非空白字符单独一段（连续覆盖），偶数段 type 21(红)，奇数段 type 1(蓝)
    if (style.type === 'alt') {
      var segs = [];
      var ord = 0;
      var i = start;
      while (i < end) {
        var cp = text.codePointAt(i);
        var len = (cp > 0xFFFF) ? 2 : 1;
        if (i + len > end) break;
        var ch = text.slice(i, i + len);
        if (!/\s/.test(ch)) {
          segs.push({
            start: i, end: i + len, user_id: '',
            type: (ord % 2 === 0) ? 21 : 1,
            hashtag_name: '', hashtag_id: ''
          });
          ord++;
        }
        i += len;
      }
      return segs.length ? segs : null;
    }

    // 交替彩字·线上样本手法：全 type 21，隔字一段（留空），
    //   线上实测 "是这个样子的么[捂脸]" -> 0-1,2-3,4-5,6-7,8-9,10-11 全 21
    if (style.type === 'alt2') {
      var segs2 = [];
      var ord2 = 0;
      var j = start;
      while (j < end) {
        var cp2 = text.codePointAt(j);
        var len2 = (cp2 > 0xFFFF) ? 2 : 1;
        if (j + len2 > end) break;
        var ch2 = text.slice(j, j + len2);
        if (!/\s/.test(ch2)) {
          if (ord2 % 2 === 0) {
            segs2.push({
              start: j, end: j + len2, user_id: '',
              type: 21,
              hashtag_name: '', hashtag_id: ''
            });
          }
          ord2++;
        }
        j += len2;
      }
      return segs2.length ? segs2 : null;
    }

    var seg = {
      start: start,
      end: end,
      user_id: '',
      type: style.type | 0,
      hashtag_name: '',
      hashtag_id: ''
    };
    if (seg.type === 0) {
      if (!S.uid || !S.secUid) return null; // @ 模式缺 uid 时不注入，避免脏数据
      seg.user_id = S.uid;
      seg.sec_uid = S.secUid;
    }
    // type 1 是话题样式：带 hashtag 字段才可能被服务端保留并全端渲染
    if (seg.type === 1 && S.hashtagName) {
      seg.hashtag_name = S.hashtagName;
      seg.hashtag_id = S.hashtagId || '0';
    }
    return [seg];
  }

  // 合并已有 text_extra（如页面自带的 @ 区间），支持多段
  function mergeExtra(raw, segs) {
    var base = [];
    if (raw) {
      try {
        var p = JSON.parse(raw);
        if (Array.isArray(p)) base = p.filter(function (x) { return x && typeof x === 'object'; });
      } catch (e) {}
    }
    var filtered = base.filter(function (x) {
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (Number(x.start) === s.start && Number(x.end) === s.end && Number(x.type) === s.type) return false;
      }
      return true;
    });
    var merged = filtered.concat(segs);
    merged.sort(function (a, b) { return (Number(a.start) || 0) - (Number(b.start) || 0); });
    return merged;
  }

  // 根据当前状态决定本次是否注入，返回 {body, segs, text} 或 null
  function prepareInjection(body) {
    if (!S.enabled) return null;
    if (typeof body !== 'string' || !body || body.charAt(0) === '{' || body.indexOf('=') < 0) return null;

    var params;
    try { params = new URLSearchParams(body); } catch (e) { return null; }

    var text = params.get('text');
    if (!text) return null; // 图片/表情评论没有 text，不消费 pending

    var style = null;
    if (pending) {
      // pending 只记 type，范围/模式发送时实时读取，改完立刻生效
      style = { type: pending.type, mode: S.rangeMode, start: S.startVal, end: S.endVal, headN: S.headN };
    } else if (S.persist) {
      style = { type: currentType(), mode: S.rangeMode, start: S.startVal, end: S.endVal, headN: S.headN };
    } else {
      return null;
    }

    // 位置样式：DouX 的做法是正文前加 [位置] 前缀，否则客户端不认
    var textOut = text;
    if (style.type === 33 && text.indexOf('[位置]') !== 0) {
      textOut = '[位置]' + text;
    }

    // 话题蓝：type 1 是话题样式，正文必须有 #话题名#，段指向话题名本身
    var tagSeg = null;
    if (style.type === 1 && S.hashtagName) {
      var tagName = S.hashtagName;
      if (text.indexOf('#' + tagName + '#') < 0 && text.indexOf('#' + tagName) < 0) {
        textOut = '#' + tagName + '# ' + text;
        tagSeg = {
          start: 1,
          end: 1 + tagName.length,
          user_id: '',
          type: 1,
          hashtag_name: tagName,
          hashtag_id: S.hashtagId || '0'
        };
      }
    }

    var segs = tagSeg ? [tagSeg] : buildSegments(textOut, style);
    if (!segs || !segs.length) return null;

    var extra = mergeExtra(params.get('text_extra'), segs);
    var newBody = upsertField(body, 'text_extra', JSON.stringify(extra));
    if (textOut !== text) {
      newBody = upsertField(newBody, 'text', textOut);
    }
    // 位置样式：有 poi_id 就一并提交（POI 数据 web 端无入口，需要自备）
    if (segs.length === 1 && segs[0].type === 33 && S.poiId) {
      newBody = upsertField(newBody, 'poi_id', S.poiId);
    }

    lastApplied = { seg: segs[0], count: segs.length, text: textOut, at: Date.now() };
    // 不在发送时消费 pending：等 status_code=0 再清空。
    // 否则预检/重试/失败会一次性吃掉样式，表现为"偶发不生效"。
    return { body: newBody, segs: segs, text: textOut, usedPending: !!pending };
  }

  // ---------------------------------------------------------------------------
  // XHR Hook
  // ---------------------------------------------------------------------------
  if (XHR && XHR.prototype) {
    var rawOpen = XHR.prototype.open;
    var rawSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try {
        var u = String(url || '');
        this.__dsUrl = u;
        // 复用同一个 XHR 对象时必须重置，否则普通请求会被误判为发布
        this.__dsIsPublish = u.indexOf(PUBLISH_MARK) >= 0;
        this.__dsIsList = u.indexOf(LIST_MARK) >= 0;
        this.__dsInjected = false;
      } catch (e) {}
      return rawOpen.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      var self = this;
      try {
        if (self.__dsIsPublish) {
          if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
            body = body.toString();
            arguments[0] = body;
          }
          var ctx = describeBody(body);
          var res = prepareInjection(body);
          if (res) {
            arguments[0] = res.body;
            self.__dsUsedPending = !!res.usedPending;
            if (res.segs.length > 1) {
              log('已注入多段样式', res.segs.length + ' 段（type ' + res.segs[0].type + '/' + res.segs[1].type + ' 交替）', '正文长度', res.text.length);
            } else {
              log('已注入样式段', res.segs[0], '正文长度', res.text.length);
            }
          }
          self.__dsInjected = !!res;
          // 结果诊断：只读不拦截（同一对象重复 send 时替换旧监听）
          try {
            if (self.__dsHandler) {
              try { self.removeEventListener('loadend', self.__dsHandler); } catch (e2) {}
            }
            self.__dsHandler = function () {
              try {
                var respText = (typeof self.responseText === 'string') ? self.responseText : '';
                var code = null;
                if (respText) {
                  try { var j = JSON.parse(respText); code = (j && j.status_code !== undefined) ? j.status_code : null; } catch (e) {}
                }
                lastPublish = {
                  path: cleanPath(self.__dsUrl || ''),
                  fields: ctx.fields,
                  injected: !!self.__dsInjected,
                  status: self.status,
                  code: code
                };
                if (self.__dsInjected) {
                  if (code === 0) {
                    log('服务端接受（status_code=0）');
                    if (self.__dsUsedPending) {
                      self.__dsUsedPending = false;
                      pending = null;
                      renderPanel();
                    }
                  } else {
                    warn('服务端返回异常', self.status, code, respText.slice(0, 200));
                    // 失败保留 pending，允许重发
                  }
                  if (lastApplied && lastApplied.text) {
                    lastSentText = lastApplied.text;
                    store.set('ds_lastText', lastSentText);
                  }
                  // 成功时胶囊短暂反馈
                  if (code === 0 && ui && ui.fab) {
                    fabFlashing = true;
                    ui.fab.textContent = '✓ 已发送';
                    ui.fab.classList.add('okflash');
                    setTimeout(function () {
                      fabFlashing = false;
                      try { if (ui && ui.fab) ui.fab.classList.remove('okflash'); } catch (e) {}
                      renderPanel();
                    }, 1600);
                  }
                }
                renderPanel();
              } catch (e) {}
            };
            self.addEventListener('loadend', self.__dsHandler);
          } catch (e) {}
        } else if (self.__dsIsList) {
          // 回读验证：评论列表返回后匹配自己刚发的评论（替换旧监听）
          try {
            if (self.__dsListHandler) {
              try { self.removeEventListener('loadend', self.__dsListHandler); } catch (e2) {}
            }
            self.__dsListHandler = function () {
              try {
                if (typeof self.responseText === 'string') verifyFromList(self.responseText);
              } catch (e) {}
            };
            self.addEventListener('loadend', self.__dsListHandler);
          } catch (e) {}
        }
      } catch (e) {
        warn('注入流程异常，已放行原请求', e);
      }
      return rawSend.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------------------------
  // fetch 发布路径同样注入 text_extra（抖音可能用 fetch 发评论）
  // ---------------------------------------------------------------------------
  try {
    var rawFetch = WIN.fetch;
    if (typeof rawFetch === 'function') {
      WIN.fetch = function (input, init) {
        var url = '';
        try { url = (typeof input === 'string') ? input : (input && input.url ? input.url : ''); } catch (e) {}
        if (!url || url.indexOf(PUBLISH_MARK) < 0) return rawFetch.apply(this, arguments);

        try {
          var opts = init || {};
          var body = opts.body;
          if (body && typeof body === 'object' && typeof body.toString === 'function' &&
              !(typeof FormData !== 'undefined' && body instanceof FormData)) {
            try { body = body.toString(); } catch (e2) {}
          }
          var res = prepareInjection(body);
          if (res) {
            var newInit = {};
            for (var k in opts) {
              if (Object.prototype.hasOwnProperty.call(opts, k)) newInit[k] = opts[k];
            }
            newInit.body = res.body;
            log('已注入样式（fetch 发布）',
              res.segs.length > 1 ? (res.segs.length + ' 段交替') : res.segs[0],
              '正文长度', res.text.length);
            var p = rawFetch.call(this, input, newInit);
            try {
              p.then(function (resp) {
                try {
                  resp.clone().json().then(function (j) {
                    var code = (j && j.status_code !== undefined) ? j.status_code : null;
                    lastPublish = { path: cleanPath(url), fields: ['(fetch)'], injected: true, status: resp.status, code: code };
                    if (code === 0) {
                      if (res.usedPending) { pending = null; }
                      if (lastApplied && lastApplied.text) {
                        lastSentText = lastApplied.text;
                        store.set('ds_lastText', lastSentText);
                      }
                    }
                    renderPanel();
                  }).catch(function () {});
                } catch (e3) {}
              }).catch(function () {});
            } catch (e4) {}
            return p;
          }
          lastPublish = { path: cleanPath(url), fields: ['(fetch)'], injected: false, status: 0, code: null };
          renderPanel();
        } catch (e5) {}
        return rawFetch.apply(this, arguments);
      };
    }
  } catch (e) {}

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------
  function cleanPath(url) {
    var q = url.indexOf('?');
    return q >= 0 ? url.slice(0, q) : url;
  }

  function describeBody(body) {
    var fields = [];
    if (typeof body === 'string' && body) {
      try {
        var p = new URLSearchParams(body);
        p.forEach(function (v, k) { fields.push(k); });
      } catch (e) {}
    } else if (body) {
      fields.push('(非字符串 body: ' + Object.prototype.toString.call(body) + ')');
    }
    return { fields: fields };
  }

  function verifyFromList(respText) {
    if (!lastSentText) return;
    var needle = lastSentText.slice(0, 24);
    if (!needle) return;
    if (respText.indexOf(needle.slice(0, 6)) < 0) return; // 粗筛，命中后再解析
    try {
      var j = JSON.parse(respText);
      var list = (j && j.comments) || [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || typeof c.text !== 'string') continue;
        if (c.text.indexOf(needle.slice(0, 8)) < 0) continue;
        var extra = c.text_extra;
        if (extra === undefined) continue;
        lastVerify = '找到自己的评论「' + c.text.slice(0, 20) + '」\ntext_extra = ' + JSON.stringify(extra);
        log('回读验证', extra);
        renderPanel();
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 面板 UI
  // ---------------------------------------------------------------------------
  var css = [
    /* ---------- 设计 token（定义在 :host，shadow 内所有元素可继承） ---------- */
    ':host{all:initial;--bg:#17171b;--bg-sunken:#0f0f13;--bg-raised:#26262e;--bg-hover:#30303a;',
    '--border:#2c2c35;--border-strong:#3e3e49;',
    '--text:#f0f0f4;--text-2:#b8b8c3;--text-3:#8b8b96;',
    '--accent:#e0245e;--accent-hover:#ee3568;--accent-soft:rgba(224,36,94,.16);--accent-text:#ff86a4;',
    '--ok:#5fd39a;--ok-soft:rgba(95,211,154,.13);--bad:#ff9090;--bad-soft:rgba(255,144,144,.12);',
    '--r-lg:14px;--r-md:8px;--r-sm:6px;--r-pill:999px;',
    '--sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;',
    '--dur:120ms;--ease:cubic-bezier(.2,.7,.3,1)}',

    /* ---------- 悬浮胶囊 ---------- */
    '.fab{position:fixed;right:16px;top:80px;min-width:84px;height:38px;padding:0 16px;',
    'display:flex;align-items:center;justify-content:center;gap:6px;',
    'border-radius:var(--r-pill);background:rgba(20,20,24,.94);color:#fff;',
    'border:1.5px solid var(--accent);',
    'font:600 12px/1 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;letter-spacing:.3px;white-space:nowrap;',
    'cursor:pointer;user-select:none;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);',
    'box-shadow:0 6px 24px rgba(0,0,0,.45);z-index:2147483000;',
    'transition:transform var(--dur) var(--ease),box-shadow var(--dur),background var(--dur),border-color var(--dur),color var(--dur)}',
    '.fab:hover{background:#1e1e24;box-shadow:0 8px 28px rgba(0,0,0,.55)}',
    '.fab:active{transform:translateY(1px) scale(.98)}',
    '.fab.off{border-color:var(--border-strong);color:var(--text-3)}',
    '.fab.okflash{border-color:var(--ok);color:var(--ok);box-shadow:0 0 0 3px rgba(95,211,154,.2),0 6px 24px rgba(0,0,0,.45)}',
    '.fab.ready{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-text);',
    'box-shadow:0 0 0 3px rgba(224,36,94,.18),0 6px 24px rgba(0,0,0,.45)}',

    /* ---------- 面板容器 ---------- */
    '.panel{position:fixed;right:16px;top:126px;width:min(320px,calc(100vw - 24px));max-height:min(600px,calc(100vh - 150px));',
    'overflow-y:auto;overscroll-behavior:contain;',
    'background:linear-gradient(180deg,#1a1a1f,#151519);',
    'border:1px solid var(--border);border-radius:var(--r-lg);',
    'box-shadow:0 24px 60px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.35);',
    'padding:var(--sp-3);color:var(--text);',
    'font:12px/1.55 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;',
    'display:none;z-index:2147483001}',
    '.panel.open{display:block;animation:panelIn 160ms var(--ease)}',
    '@keyframes panelIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}',
    '.panel::-webkit-scrollbar{width:6px}',
    '.panel::-webkit-scrollbar-thumb{background:#3a3a44;border-radius:3px}',
    '.panel::-webkit-scrollbar-track{background:transparent}',

    /* ---------- 头部 ---------- */
    '.hd{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-2);',
    'padding-bottom:var(--sp-2);border-bottom:1px solid var(--border);margin-bottom:var(--sp-3)}',
    '.hd .title{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;letter-spacing:.2px;color:var(--text)}',
    '.hd .dot{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px rgba(224,36,94,.6);flex:none}',
    '.x{width:24px;height:24px;display:flex;align-items:center;justify-content:center;',
    'border-radius:var(--r-sm);color:var(--text-3);cursor:pointer;font-size:15px;line-height:1;flex:none;',
    'transition:background var(--dur),color var(--dur),transform var(--dur)}',
    '.x:hover{background:var(--bg-raised);color:var(--text)}',
    '.x:active{transform:scale(.92)}',

    /* ---------- 区块与行 ---------- */
    '.sec{margin-bottom:var(--sp-3)}',
    '.sec:last-child{margin-bottom:0}',
    '.sec-t{font-size:11px;font-weight:500;color:var(--text-3);letter-spacing:.2px;margin-bottom:6px}',
    '.row{display:flex;align-items:center;gap:var(--sp-2);margin-bottom:var(--sp-2);flex-wrap:wrap}',
    '.row:last-child{margin-bottom:0}',
    '.row>label.lb{flex:none;color:var(--text-3);font-size:11.5px}',
    '.grow{flex:1;min-width:0}',

    /* ---------- chips（统一点击态） ---------- */
    '.chips{display:flex;flex-wrap:wrap;gap:6px}',
    '.chip{display:inline-flex;align-items:center;height:28px;padding:0 11px;',
    'border-radius:var(--r-pill);background:var(--bg-raised);border:1px solid transparent;',
    'color:var(--text-2);font-size:11.5px;font-weight:500;cursor:pointer;user-select:none;',
    'transition:background var(--dur) var(--ease),border-color var(--dur),color var(--dur),transform var(--dur)}',
    '.chip:hover{background:var(--bg-hover);color:var(--text)}',
    '.chip:active{transform:scale(.96)}',
    '.chip.on{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-text)}',
    '.chip.pre{background:rgba(224,36,94,.11);border-color:rgba(224,36,94,.5);border-style:dashed;color:var(--text)}',
    '.dot{width:7px;height:7px;border-radius:50%;flex:none;box-shadow:0 0 6px rgba(0,0,0,.4)}',
    '.dot.red{background:#ff5c7a}',
    '.dot.blue{background:#5ca8ff}',
    '.dot.alt{background:linear-gradient(135deg,#ff5c7a 0%,#ff5c7a 45%,#5ca8ff 55%,#5ca8ff 100%)}',
    '.dot.alt2{background:linear-gradient(135deg,#ff5c7a 0%,#ff5c7a 45%,#f5c542 55%,#f5c542 100%)}',
    '.dot.loc{background:#9a9aa4}',
    '.inline-entry{position:fixed;display:none;align-items:center;justify-content:center;gap:4px;height:24px;',
    'padding:0 9px;border-radius:12px;background:rgba(20,20,24,.94);color:#fff;',
    'border:1px solid rgba(224,36,94,.75);font:600 11px/1 system-ui,-apple-system,"PingFang SC",sans-serif;',
    'cursor:pointer;user-select:none;z-index:2147482999;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);',
    'box-shadow:0 2px 10px rgba(0,0,0,.45);white-space:nowrap;',
    'transition:transform 120ms,background 120ms}',
    '.inline-entry:hover{background:rgba(224,36,94,.95);border-color:#e0245e}',
    '.inline-entry:active{transform:scale(.94)}',
    '.chip.dead{opacity:.55;text-decoration:line-through;cursor:not-allowed}',
    '.chip.dead:hover{background:var(--bg-raised);color:var(--text-2)}',
    '.chip.dead:active{transform:none}',

    /* ---------- 按钮（统一四态） ---------- */
    '.btn{display:flex;align-items:center;justify-content:center;width:100%;height:32px;margin-top:6px;',
    'border:1px solid transparent;border-radius:var(--r-md);background:var(--accent);color:#fff;',
    'font:600 12px/1 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;cursor:pointer;',
    'transition:background var(--dur),border-color var(--dur),transform var(--dur),opacity var(--dur)}',
    '.btn:hover{background:var(--accent-hover)}',
    '.btn:active{transform:translateY(1px)}',
    '.btn.ghost{background:#26262e;color:var(--text-2);border-color:#3c3c47}',
    '.btn.ghost:hover{background:var(--bg-hover);color:var(--text)}',
    '.btn.mini{width:auto;height:24px;margin:0;padding:0 10px;font-size:10.5px;border-radius:var(--r-sm);',
    'background:transparent;border:1px solid currentColor;color:inherit;flex:none}',
    '.btn.mini:hover{background:rgba(255,255,255,.07)}',
    '.btn:disabled{opacity:.38;cursor:not-allowed;transform:none}',

    /* ---------- 输入框（统一 focus 态） ---------- */
    '.inp{height:28px;padding:0 9px;background:var(--bg-sunken);border:1px solid var(--border);',
    'border-radius:var(--r-md);color:var(--text);font-size:12px;outline:none;flex:1;min-width:0;',
    'transition:border-color var(--dur),box-shadow var(--dur)}',
    '.inp::placeholder{color:var(--text-3)}',
    '.inp:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(224,36,94,.15)}',
    '.inp:disabled{opacity:.38;cursor:not-allowed}',
    '.inp.n{flex:none;width:56px;text-align:center}',

    /* ---------- 折叠 ---------- */
    '.advtoggle{display:flex;align-items:center;justify-content:space-between;',
    'margin-top:var(--sp-2);padding-top:var(--sp-2);border-top:1px solid var(--border);',
    'color:var(--text-3);font-size:11.5px;cursor:pointer;user-select:none;',
    'transition:color var(--dur)}',
    '.advtoggle:hover{color:var(--text)}',
    '.advtoggle:active{opacity:.8}',
    '.advtoggle .arrow{font-size:10px;transition:transform var(--dur) var(--ease)}',
    '.advtoggle.open .arrow{transform:rotate(180deg)}',
    '.adv{display:none;margin-top:var(--sp-2)}',
    '.custombox{display:none;margin-top:6px}',
    '.custombox.show{display:block}',
    '.adv.open{display:block;animation:fadeIn 140ms var(--ease)}',
    '@keyframes fadeIn{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}',

    /* ---------- 提示条（待发/结果，统一语义色） ---------- */
    '.bar{display:none;align-items:center;justify-content:space-between;gap:var(--sp-2);',
    'margin:var(--sp-2) 0;padding:8px 10px;border-radius:var(--r-md);',
    'background:var(--bg-sunken);border:1px solid var(--border);',
    'font-size:11.5px;color:var(--text-2);white-space:pre-wrap;word-break:break-word}',
    '.bar.show{display:flex}',
    '.bar.pending{background:var(--accent-soft);border-color:rgba(224,36,94,.4);color:var(--accent-text)}',
    '.bar.ok{background:var(--ok-soft);border-color:rgba(95,211,154,.35);color:var(--ok)}',
    '.bar.bad{background:var(--bad-soft);border-color:rgba(255,144,144,.3);color:var(--bad)}',

    /* ---------- 状态槽 ---------- */
    '.status{margin-top:var(--sp-2);padding:8px 10px;border-radius:var(--r-md);',
    'background:var(--bg-sunken);border:1px solid var(--border);color:var(--text-3);font-size:11px;',
    'white-space:pre-wrap;word-break:break-word;transition:color var(--dur),border-color var(--dur),background var(--dur)}',
    '.status.ok{color:var(--ok);border-color:rgba(95,211,154,.3)}',
    '.status.bad{color:var(--bad);border-color:rgba(255,144,144,.3)}',

    /* ---------- 文本 ---------- */
    '.hint{font-size:10.5px;color:var(--text-3);line-height:1.6;margin-top:6px}',
    '.deadrow{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;opacity:.75}',
    '.hint code{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:var(--text-2)}'
  ].join('');

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'cls') n.className = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function mountUI() {
    try {
      // 顶层窗口才挂 UI；iframe 内只保留 XHR hook
      if (WIN.top !== WIN) return;
      mountUIInner();
    } catch (e) { warn('面板挂载失败', e); }
  }

  // 抖音评论输入框（按稳定性排序；data-e2e 锚点最稳，hash class 不写）
  var INPUT_SELECTORS = [
    '#comment-input-container',
    '.comment-input-inner-container',
    '[data-e2e="comment-input"]',
    '.public-DraftEditor-content',
    '[contenteditable="true"]'
  ];

  function findCommentInput() {
    for (var i = 0; i < INPUT_SELECTORS.length; i++) {
      var nodes = document.querySelectorAll(INPUT_SELECTORS[i]);
      for (var j = 0; j < nodes.length; j++) {
        var r = nodes[j].getBoundingClientRect();
        if (r.width > 120 && r.height > 14) return nodes[j];
      }
    }
    return null;
  }

  // 面板贴到输入框上方（空间不足则下方）
  function placePanelNear(rect) {
    try {
      if (!ui || !ui.panel) return;
      var panel = ui.panel;
      if (!rect) { panel.style.left = ''; panel.style.top = ''; panel.style.right = ''; return; }
      var w = 320;
      var h = panel.offsetHeight || 420;
      var left = Math.min(Math.max(8, rect.right - w), window.innerWidth - w - 8);
      var top = rect.top - h - 10;
      if (top < 8) top = Math.min(rect.bottom + 10, window.innerHeight - h - 8);
      panel.style.left = left + 'px';
      panel.style.top = Math.max(8, top) + 'px';
      panel.style.right = 'auto';
    } catch (e) {}
  }

  // 维护输入框旁的小入口（找不到输入框则隐藏，胶囊兜底）
  function updateInlineEntry() {
    try {
      if (!ui || !ui.host) return;
      var shadow = ui.host.shadowRoot;
      if (!shadow) return;
      if (!inlineBtn) {
        inlineBtn = el('div', { cls: 'inline-entry', text: '⚡ 样式', title: '给下一条评论加样式' });
        inlineBtn.addEventListener('click', function (e) {
          try {
            e.stopPropagation();
            panelOpen = true;
            ui.panel.classList.add('open');
            placePanelNear(lastInputRect);
            renderPanel();
          } catch (err) {}
        });
        shadow.appendChild(inlineBtn);
      }
      var input = findCommentInput();
      if (!input) { inlineBtn.style.display = 'none'; return; }
      var r = input.getBoundingClientRect();
      if (r.width < 80 || r.bottom < 0 || r.top > window.innerHeight) {
        inlineBtn.style.display = 'none';
        return;
      }
      lastInputRect = { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
      inlineBtn.style.display = 'flex';
      inlineBtn.style.top = Math.max(4, r.top - 28) + 'px';
      inlineBtn.style.left = Math.max(4, Math.min(r.right - 62, window.innerWidth - 80)) + 'px';
    } catch (e) {}
  }

  function mountUIInner() {
    if (ui || !document.body) return;
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;z-index:2147483000;';
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);

    var panel = el('div', { cls: 'panel' });
    var fab = el('div', { cls: 'fab', text: 'DY样式', title: '抖音评论样式设置', onclick: function () {
      panelOpen = !panelOpen;
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
      panel.classList.toggle('open', panelOpen);
      renderPanel();
    }});

    // ---------- 头部 ----------
    panel.appendChild(el('div', { cls: 'hd' }, [
      el('div', { cls: 'title' }, [el('span', { cls: 'dot' }), el('span', { text: '抖音评论样式' })]),
      el('div', { cls: 'x', text: '×', title: '关闭', onclick: function () { panelOpen = false; panel.classList.remove('open'); } })
    ]));

    // ---------- 样式 ----------
    var secStyle = el('div', { cls: 'sec' });
    var lastPickHint = el('div', { cls: 'hint' });
    secStyle.appendChild(el('div', { cls: 'sec-t', text: '点一个样式，然后正常发评论' }));
    secStyle.appendChild(lastPickHint);
    var chips = el('div', { cls: 'chips' });
    PRESETS.forEach(function (p) {
      if (p.dead) return; // 失效样式移到高级区
      var chip = el('div', { cls: 'chip' });
      if (p.tone) {
        var dot = document.createElement('span');
        dot.className = 'dot ' + p.tone;
        chip.appendChild(dot);
      }
      chip.appendChild(document.createTextNode(p.label));
      chip.setAttribute('role', 'button');
      chip.setAttribute('data-preset', p.id);
      if (p.desc) chip.setAttribute('title', p.desc);
      chip.addEventListener('click', function () {
        if (!S.enabled) { S.enabled = true; } // 关着的时候点样式，自动开启
        S.presetId = p.id; saveState();
        pending = { type: p.type };
        lastVerify = '';
        log('已选中：' + p.label + ' · 下一条评论生效');
        renderPanel();
      });
      chips.appendChild(chip);
    });
    var customChip = el('div', { cls: 'chip', text: '自定义…', role: 'button' });
    customChip.setAttribute('data-preset', 'custom');
    customChip.addEventListener('click', function () {
      S.presetId = 'custom'; saveState();
      pending = { type: currentType(), custom: true };
      lastVerify = '';
      renderPanel();
      setTimeout(function () { try { typeInput.focus(); typeInput.select(); } catch (e) {} }, 50);
    });
    chips.appendChild(customChip);
    secStyle.appendChild(chips);
    panel.appendChild(secStyle);

    // ---------- 模式 ----------
    var secMode = el('div', { cls: 'sec' });
    secMode.appendChild(el('div', { cls: 'sec-t', text: '模式' }));
    var persistChip = el('div', { cls: 'chip', text: '持续模式', role: 'button' });
    persistChip.addEventListener('click', function () {
      S.persist = !S.persist; saveState(); renderPanel();
    });
    secMode.appendChild(el('div', { cls: 'row' }, [
      persistChip,
      el('span', { cls: 'hint', text: '开启后每条评论自动带样式' })
    ]));
    panel.appendChild(secMode);

    // ---------- 待发条 ----------
    var pendingText = el('span', { cls: 'grow', text: '' });
    var cancelBtn = el('button', { cls: 'btn mini', text: '取消' });
    cancelBtn.addEventListener('click', function () { pending = null; renderPanel(); });
    var pendingBar = el('div', { cls: 'bar pending' }, [pendingText, cancelBtn]);
    panel.appendChild(pendingBar);

    // ---------- 高级折叠 ----------
    var advToggle = el('div', { cls: 'advtoggle' }, [
      el('span', { text: '高级设置' }),
      el('span', { cls: 'arrow', text: '▾' })
    ]);
    var adv = el('div', { cls: 'adv' });
    advToggle.addEventListener('click', function () {
      var open = adv.classList.toggle('open');
      advToggle.classList.toggle('open', open);
    });
    panel.appendChild(advToggle);

    // 自定义 type（点「自定义…」后才出现）
    var customBox = el('div', { cls: 'custombox' });
    var typeInput = el('input', { cls: 'inp n', type: 'number', min: '0', step: '1' });
    typeInput.addEventListener('change', function () {
      S.customType = parseInt(typeInput.value, 10) || 21;
      S.presetId = 'custom'; saveState();
      pending = { type: S.customType, custom: true };
      lastVerify = '';
      renderPanel();
    });
    customBox.appendChild(el('div', { cls: 'row' }, [
      el('label', { cls: 'lb', text: 'type' }), typeInput,
      el('span', { cls: 'hint', text: '21 红 / 1 蓝 / 33 位置' })
    ]));
    secStyle.appendChild(customBox);

    // 话题蓝参数（选中「蓝字」时就近出现）
    var tagBox = el('div', { cls: 'custombox' });
    var tagNameInput = el('input', { cls: 'inp', type: 'text', placeholder: '话题名（蓝字需要，如 美食）' });
    var tagIdInput = el('input', { cls: 'inp n', type: 'text', placeholder: 'ID' });
    tagNameInput.addEventListener('change', function () { S.hashtagName = tagNameInput.value.trim(); saveState(); renderPanel(); });
    tagIdInput.addEventListener('change', function () { S.hashtagId = tagIdInput.value.trim(); saveState(); renderPanel(); });
    tagBox.appendChild(el('div', { cls: 'row' }, [
      el('label', { cls: 'lb', text: '话题' }), tagNameInput, tagIdInput
    ]));
    tagBox.appendChild(el('div', { cls: 'hint', text: '填话题名后正文会自动加 #话题名#（会多出前后缀），这是人人可见的蓝色；不填则裸发，多半被剥离' }));
    secStyle.appendChild(tagBox);

    // 位置样式参数（选中「位置 33」时就近出现）
    var locBox = el('div', { cls: 'custombox' });
    var poiInput = el('input', { cls: 'inp', type: 'text', placeholder: 'poi_id（位置样式可选）' });
    poiInput.addEventListener('change', function () { S.poiId = poiInput.value.trim(); saveState(); renderPanel(); });
    locBox.appendChild(el('div', { cls: 'row' }, [
      el('label', { cls: 'lb', text: 'POI' }), poiInput,
      el('span', { cls: 'hint', text: '不填只有 type，无位置图标' })
    ]));
    secStyle.appendChild(locBox);

    // 范围（作用于文字样式）
    var allChip = el('div', { cls: 'chip', text: '全文', role: 'button' });
    var headChip = el('div', { cls: 'chip', text: '前 N 字', role: 'button' });
    var rangeChip = el('div', { cls: 'chip', text: '自定义', role: 'button' });
    var headInput = el('input', { cls: 'inp n', type: 'number', min: '1', step: '1' });
    var startInput = el('input', { cls: 'inp n', type: 'number', min: '0', step: '1' });
    var endInput = el('input', { cls: 'inp n', type: 'number', min: '0', step: '1' });
    allChip.addEventListener('click', function () { S.rangeMode = 'all'; saveState(); renderPanel(); });
    headChip.addEventListener('click', function () { S.rangeMode = 'head'; saveState(); renderPanel(); });
    rangeChip.addEventListener('click', function () { S.rangeMode = 'custom'; saveState(); renderPanel(); });
    headInput.addEventListener('change', function () { S.headN = parseInt(headInput.value, 10) || 3; saveState(); renderPanel(); });
    startInput.addEventListener('change', function () { S.startVal = parseInt(startInput.value, 10) || 0; saveState(); renderPanel(); });
    endInput.addEventListener('change', function () { S.endVal = parseInt(endInput.value, 10) || 0; saveState(); renderPanel(); });

    var rangeBox = el('div', { cls: 'rangebox' });
    var rangeTitle = el('div', { cls: 'sec-t', text: '范围（作用于文字样式）' });
    rangeBox.appendChild(rangeTitle);
    var rangeRow = el('div', { cls: 'row' }, [allChip, headChip, rangeChip]);
    rangeBox.appendChild(rangeRow);
    var headRow = el('div', { cls: 'row' }, [
      el('label', { cls: 'lb', text: '前' }), headInput, el('span', { cls: 'hint', text: '个字变样式' })
    ]);
    rangeBox.appendChild(headRow);
    var customRow = el('div', { cls: 'row' }, [
      el('label', { cls: 'lb', text: '从' }), startInput,
      el('span', { cls: 'hint', text: '到' }), endInput,
      el('span', { cls: 'hint', text: '（0 起算）' })
    ]);
    rangeBox.appendChild(customRow);
    adv.appendChild(rangeBox);





    // 实验样式（开发者选项，服务端已拒绝）
    adv.appendChild(el('div', { cls: 'sec-t', text: '实验样式（已停用）' }));
    var deadChips = el('div', { cls: 'deadrow' });
    PRESETS.forEach(function (p) {
      if (!p.dead) return;
      var chip = el('div', { cls: 'chip dead', text: p.label });
      chip.setAttribute('aria-disabled', 'true');
      chip.addEventListener('click', function () { lastVerify = '✗ ' + p.dead; renderPanel(); });
      deadChips.appendChild(chip);
    });
    adv.appendChild(deadChips);

    // 诊断：最近发布请求
    var diagBtn = el('button', { cls: 'btn ghost', text: '查看最近一次发布请求' });
    diagBtn.addEventListener('click', function () {
      if (!lastPublish) { lastVerify = '还没捕获到发布请求。先发一条普通评论试试。'; }
      else {
        lastVerify = '路径: ' + lastPublish.path +
          '\n注入: ' + (lastPublish.injected ? '是' : '否') +
          '\nHTTP: ' + lastPublish.status + '   status_code: ' + lastPublish.code +
          '\nbody 字段: ' + lastPublish.fields.join(', ');
      }
      renderPanel();
    });
    adv.appendChild(diagBtn);

    // 诊断：回读验证
    var verifyBtn = el('button', { cls: 'btn ghost', text: '回读验证（滑评论区触发）' });
    verifyBtn.addEventListener('click', function () {
      if (!lastSentText) { lastVerify = '还没有发送记录。先发一条带样式的评论。'; renderPanel(); return; }
      lastVerify = '正在等待评论列表接口…滑动评论区触发加载';
      renderPanel();
    });
    adv.appendChild(verifyBtn);

    adv.appendChild(el('div', { cls: 'hint', text: '红字 / 蓝字 / 交替可用 · 位置需要 POI · 小号测试更稳' }));
    panel.appendChild(adv);

    // ---------- 状态槽 ----------
    var stateBox = el('div', { cls: 'status', text: '空闲' });
    panel.appendChild(stateBox);

    shadow.appendChild(fab);
    shadow.appendChild(panel);
    document.body.appendChild(host);
    if (panelOpen) panel.classList.add('open'); // 重建后保持展开状态

    ui = { host: host, fab: fab, panel: panel, stateBox: stateBox,
      chips: chips, typeInput: typeInput, allChip: allChip, rangeChip: rangeChip,
      startInput: startInput, endInput: endInput, persistChip: persistChip,
      headChip: headChip, headInput: headInput, headRow: headRow, customRow: customRow,
      rangeTitle: rangeTitle, rangeRow: rangeRow, rangeBox: rangeBox,
      adv: adv, advToggle: advToggle, customBox: customBox, locBox: locBox, tagBox: tagBox,
      tagNameInput: tagNameInput, tagIdInput: tagIdInput,
      pendingBar: pendingBar, pendingText: pendingText, lastPickHint: lastPickHint };

    tagNameInput.value = S.hashtagName || '';
    tagIdInput.value = S.hashtagId || '';
    renderPanel();
    updateInlineEntry();

    // 启动提示（每会话只弹一次）
    try {
      var toastKey = 'ds_toast_shown';
      var toastShown = false;
      try { toastShown = sessionStorage.getItem(toastKey) === '1'; } catch (e) {}
      if (!toastShown) {
        try { sessionStorage.setItem(toastKey, '1'); } catch (e) {}
        var toast = document.createElement('div');
        toast.textContent = '抖音评论样式已启动 · 点右上角「DY样式」';
        toast.style.cssText = 'position:fixed;right:16px;top:34px;z-index:2147483002;background:#17171b;color:#ececf0;' +
          'border:1px solid rgba(224,36,94,.5);border-radius:10px;padding:8px 14px;' +
          'font:12px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;' +
          'box-shadow:0 8px 24px rgba(0,0,0,.45);pointer-events:none;';
        document.body.appendChild(toast);
        setTimeout(function () { try { toast.remove(); } catch (e) {} }, 4000);
      }
    } catch (e) {}

    // document 级监听只绑一次（SPA 重建不重复累积）
    if (!docListenersBound) {
      docListenersBound = true;
      try {
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && ui && ui.panel.classList.contains('open')) {
            panelOpen = false;
            ui.panel.classList.remove('open');
          }
        });
        var onScrollResize = function () {
          if (inlineRaf) return;
          inlineRaf = requestAnimationFrame(function () { inlineRaf = 0; updateInlineEntry(); });
        };
        try {
          window.addEventListener('scroll', onScrollResize, { passive: true, capture: true });
          window.addEventListener('resize', onScrollResize);
        } catch (e2) {}
        document.addEventListener('mousedown', function (e) {
          try {
            if (!ui || !ui.panel.classList.contains('open')) return;
            if (e.target === ui.host) return; // shadow 内部点击会 retarget 到 host
            panelOpen = false;
            ui.panel.classList.remove('open');
          } catch (err) {}
        }, true);
      } catch (e) {}
    }

    // Console 调试入口
    try {
      WIN.__DYStyle = {
        version: '4.0.0',
        state: S,
        lastPublish: function () { return lastPublish; },
        lastVerify: function () { return lastVerify; }
      };
    } catch (e) {}
  }

  function renderPanel() {
    if (!ui) return;

    // 胶囊：待发 / 常开 / 默认 / 关闭
    ui.fab.classList.toggle('off', !S.enabled);
    ui.fab.classList.toggle('ready', !!pending && S.enabled);
    var pendingLabel = pending ? (pending.custom ? ('自定义 ' + pending.type) : typeLabel(pending.type)) : '';
    if (!fabFlashing) {
      if (!S.enabled) ui.fab.textContent = '已关闭';
      else if (S.persist) ui.fab.textContent = typeLabel(currentType()) + ' ▸ 常开';
      else if (pending) ui.fab.textContent = pendingLabel + ' ▸ 待发';
      else ui.fab.textContent = 'DY样式';
    }

    // 样式选中态 = 当前真正生效的样式（待发或持续模式），取消待发后全部回到中性
    var activeId = null;
    var activeType = pending ? pending.type : (S.persist ? currentType() : null);
    // 只有本次主动点了「自定义…」才算自定义；刷新后按 type 匹配回对应预设
    var isCustomPick = !!(pending && pending.custom);
    if (activeType !== null) {
      if (isCustomPick) activeId = 'custom';
      else if (activeType === 'alt') activeId = 'alt';
      else if (activeType === 'alt2') activeId = 'alt2';
      else {
        for (var pi = 0; pi < PRESETS.length; pi++) {
          if (!PRESETS[pi].dead && PRESETS[pi].type === activeType) { activeId = PRESETS[pi].id; break; }
        }
        if (!activeId) activeId = 'custom';
      }
    }
    // 没有待发/常开时，用淡色标记"上次使用"的样式，点一下即可复用
    var preId = (!activeId && S.presetId) ? S.presetId : null;
    var chips = ui.chips.children;
    for (var i = 0; i < chips.length; i++) {
      var pid = chips[i].getAttribute('data-preset');
      var on = !!pid && pid === activeId;
      chips[i].classList.toggle('on', on);
      chips[i].classList.toggle('pre', !on && !!pid && pid === preId);
      chips[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    // 高级区控件
    if (!ui.typeInput.matches(':focus')) ui.typeInput.value = S.customType;
    ui.allChip.classList.toggle('on', S.rangeMode === 'all');
    ui.headChip.classList.toggle('on', S.rangeMode === 'head');
    ui.rangeChip.classList.toggle('on', S.rangeMode === 'custom');
    if (!ui.headInput.matches(':focus')) ui.headInput.value = S.headN;
    if (!ui.startInput.matches(':focus')) ui.startInput.value = S.startVal;
    if (!ui.endInput.matches(':focus')) ui.endInput.value = S.endVal;
    ui.headRow.style.display = (S.rangeMode === 'head') ? 'flex' : 'none';
    ui.customRow.style.display = (S.rangeMode === 'custom') ? 'flex' : 'none';
    // 位置样式不支持范围 -> 整块隐藏（待发或持续模式都算）
    var isLoc = !!(pending && pending.type === 33) || (!pending && S.persist && currentType() === 33);
    ui.rangeBox.style.display = isLoc ? 'none' : 'block';
    ui.persistChip.classList.toggle('on', S.persist);

    // 上次选择（启动时从存储读取，位置/自定义不参与）
    try {
      var lp = store.get('ds_lastPick', '');
      var lpLabel = lp === 'red' ? '红字' : lp === 'blue' ? '蓝字' : lp === 'alt' ? '红蓝交替'
        : lp === 'loc' ? '位置' : lp === 'custom' ? ('自定义 ' + S.customType) : '';
      ui.lastPickHint.textContent = lpLabel ? ('上次选择：' + lpLabel) : '';
    } catch (e) {}

    // 待发条
    if (pending && S.enabled) {
      ui.pendingBar.classList.add('show');
      var rngText = (pending.type === 33) ? '整段'
        : (S.rangeMode === 'all' ? '全文'
        : (S.rangeMode === 'head' ? ('前 ' + S.headN + ' 字')
        : ('范围 ' + S.startVal + '-' + S.endVal)));
      var warn33 = (pending.type === 33) ? (' · 自动加[位置]前置' + (S.poiId ? ' + POI' : '')) : '';
      ui.pendingText.textContent = '✓ ' + pendingLabel + ' 已就绪 · ' + rngText + warn33;
    } else {
      ui.pendingBar.classList.remove('show');
    }

    // 自定义输入框只在选中「自定义…」时出现；位置参数只在选中位置时出现
    var showCustom = !!(pending && pending.custom) || (!pending && S.persist && S.presetId === 'custom');
    var showLoc = !!(pending && pending.type === 33) || (!pending && S.persist && currentType() === 33);
    var showTag = !!(pending && pending.type === 1) || (!pending && S.persist && currentType() === 1);
    ui.customBox.classList.toggle('show', showCustom);
    ui.locBox.classList.toggle('show', showLoc);
    ui.tagBox.classList.toggle('show', showTag);

    // 状态槽
    var lines = [];
    if (!S.enabled) lines.push('已关闭：不会改动任何请求');
    else if (S.persist) lines.push('持续模式：' + typeLabel(currentType()));
    if (S.persist && currentType() === 33 && !S.poiId) {
      lines.push('⚠ 位置样式需要 POI，当前持续模式大概率无效');
    }
    if (lastPublish) {
      if (lastPublish.injected && lastPublish.code === 0) {
        lines.push('上次发送：成功（已带样式）');
      } else if (lastPublish.injected && lastPublish.code !== null && lastPublish.code !== 0) {
        lines.push('上次发送：失败（服务端 ' + lastPublish.code + '）— 换「红字」再试');
      } else if (lastPublish.injected) {
        lines.push('上次发送：已提交，未拿到服务端结果');
      } else {
        lines.push('上次发送：未注入样式');
      }
    }
    if (lastVerify) lines.push(lastVerify);
    ui.stateBox.textContent = lines.length ? lines.join('\n') : '空闲';
    ui.stateBox.classList.remove('ok', 'bad');
    if (lastPublish && lastPublish.injected && lastPublish.code === 0) ui.stateBox.classList.add('ok');
    if (lastPublish && lastPublish.injected && lastPublish.code !== null && lastPublish.code !== 0) ui.stateBox.classList.add('bad');
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------
  if (document.body) mountUI();
  else document.addEventListener('DOMContentLoaded', mountUI, { once: true });

  // SPA 导航 / 抖音重渲染后自动恢复面板（常驻，不设上限）
  setInterval(function () {
    try {
      if (ui && ui.host && document.documentElement.contains(ui.host)) { updateInlineEntry(); return; }
      if (ui && !(ui.host && document.documentElement.contains(ui.host))) ui = null;
      if (document.body) mountUI();
    } catch (e) {}
  }, 2000);

  log('已加载 v4.0.0；当前开关:', S.enabled ? '开' : '关');
})();
