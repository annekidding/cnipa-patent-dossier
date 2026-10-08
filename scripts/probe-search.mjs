#!/usr/bin/env node
/**
 * probe-search.mjs —— 检索接口探测器
 *
 * 目的：老 skill 只会按「发明名称关键词」检索（zhuanlimc）。本 skill 还要支持
 *      **按申请号**、**按申请人**检索，且要求**精确匹配**。靠猜参数名不可靠
 *      （踩过：残留 zhuanlisqh 会让查询恒为 0 条），所以要先把真实请求抓下来看。
 *
 * 做法：在页面里临时劫持 XMLHttpRequest，记下 se.getList() 实际发出的
 *      URL 与请求体，再打印 `se.params` 的全部键 —— 一眼看清「哪个键对应哪个输入框」。
 *
 * 用法:
 *   <node> probe-search.mjs [试查关键词] [--out probe-search.json]
 *
 * 依赖: CDP 代理 http://127.0.0.1:3456 已就绪，cpquery 列表页标签已登录。
 */
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const B = 'http://127.0.0.1:3456';
const argv = process.argv.slice(2);
const KW = argv.find((a) => !a.startsWith('--')) || '无人机';
const OUT = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : 'probe-search.json'; })();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (id, js, timeout = 180000) => {
  const r = await fetch(B + '/eval?target=' + id, { method: 'POST', body: js, signal: AbortSignal.timeout(timeout) });
  const t = await r.text();
  let o; try { o = JSON.parse(t); } catch { return { __raw: String(t).slice(0, 800) }; }
  if (o && o.error) return { __error: String(o.error).split('\n')[0].slice(0, 300) };
  return o && o.value !== undefined ? o.value : o;
};
const SE = `document.querySelector('.q-pagination').__vue__.$parent.$parent`;

(async () => {
  for (let i = 0; i < 8; i++) {
    try { const h = await (await fetch(B + '/health', { signal: AbortSignal.timeout(6000) })).json(); if (h && h.status === 'ok') break; } catch { /* retry */ }
    await sleep(1500);
  }
  const tabs = await (await fetch(B + '/targets')).json();
  const tab = tabs.find((x) => x.url && x.url.includes('chinesepatent/index'));
  if (!tab) { console.error('[前置] 未找到 cpquery 列表页标签'); process.exit(2); }
  const id = tab.targetId;

  // 1) se.params 全键
  const params = await evalJs(id, `(() => { try { const se=${SE};
    const keys = Object.keys(se.params||{});
    const sample = {}; keys.forEach(k => { const v = se.params[k]; sample[k] = (typeof v === 'object' ? JSON.stringify(v) : String(v)); });
    return { keys, sample, hasGetList: typeof se.getList === 'function' }; } catch(e){ return { err:String(e.message) }; } })()`);
  console.log('=== se.params 键（= 页面上的检索条件）===');
  console.log(JSON.stringify(params, null, 1));

  // 2) 劫持 XHR，抓真实检索请求
  const cap = await evalJs(id, `(() => {
    try{
      const se=${SE};
      window.__cap=[];
      if(!window.__origOpen){ window.__origOpen = XMLHttpRequest.prototype.open; window.__origSend = XMLHttpRequest.prototype.send; }
      XMLHttpRequest.prototype.open = function(m,u){ this.__u=u; this.__m=m; return window.__origOpen.apply(this,arguments); };
      XMLHttpRequest.prototype.send = function(b){ try{ window.__cap.push({m:this.__m,u:this.__u,b:String(b||'').slice(0,1200)}); }catch(e){} return window.__origSend.apply(this,arguments); };
      // 清掉残留条件，只留关键词
      const keep=['zhuanlilx','page','size','zhuanlimc','sortDataName','sortType'];
      Object.keys(se.params).forEach(k=>{ if(keep.includes(k)) return;
        const v=se.params[k]; if(typeof v==='string') se.params[k]=''; else if(Array.isArray(v)) se.params[k]=[]; });
      se.dataList=[]; se.total=0;
      se.params.zhuanlimc=${JSON.stringify(KW)}; se.params.zhuanlilx='1'; se.params.page=1; se.params.size=20;
      se.getList();
      return 'sent';
    }catch(e){ return 'ERR '+e.message; }
  })()`);
  console.log('\n[发起查询]', JSON.stringify(cap));

  await sleep(6000);

  const got = await evalJs(id, `(() => {
    const c = window.__cap||[];
    try{ XMLHttpRequest.prototype.open = window.__origOpen; XMLHttpRequest.prototype.send = window.__origSend; }catch(e){}
    const se=${SE};
    const d = se.dataList||[];
    return { cap: c, total: se.total, len: d.length,
             row0: d[0] ? JSON.parse(JSON.stringify(d[0])) : null };
  })()`);

  console.log('\n=== 抓到的请求 ===');
  (got && got.cap || []).forEach((c) => console.log(`  ${c.m} ${c.u}\n    body: ${c.b}`));
  console.log(`\n[结果] total=${got && got.total} 本页 ${got && got.len} 条`);
  if (got && got.row0) {
    console.log('\n=== 行字段（检索结果一行长什么样）===');
    console.log(JSON.stringify(got.row0, null, 1));
  }

  writeFileSync(resolve(process.cwd(), OUT), JSON.stringify({ params, cap: got }, null, 1), 'utf8');
  console.log(`\n[已写入] ${resolve(process.cwd(), OUT)}`);
})().catch((e) => { console.error('[ERROR]', e?.message || e); process.exit(1); });
