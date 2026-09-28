#!/usr/bin/env node
/**
 * probe-fields.mjs —— 字段/接口探测器（新增字段时的首选工具）
 *
 * 用途：老脚本只用了 sqxx / fyxx / 质押 / 许可 四个接口。本 skill 需要的
 *      「分案提交日」「发文信息（通知书）」在老 skill 里没有记录，
 *      一旦站点改版或字段缺失，用本脚本重新探测，不要靠猜。
 *
 * 用法:
 *   <node> probe-fields.mjs <申请号> [--out probe-out.json] [--deep]
 *   --deep  额外把 sqxx / fyxx 的**完整原文**落盘（默认只落 sqxx）
 *
 * 做三件事:
 *   A. 调 sqxx，递归列出 data 的键结构，并在原文里搜「分案 / 保全 / 手续合格 / 发文」
 *      等关键词 → 定位分案提交日的字段名；
 *   B. 依次试探候选的「发文信息」接口（路径 × nodeId 组合），把返回 200 且
 *      data 非空的组合打印出来 → 确定发文接口；
 *   C. 调一次 fyxx，确认年费/已缴费字段仍在（站点改版自检）。
 *
 * 依赖: CDP 代理 http://127.0.0.1:3456 已就绪，且 cpquery **列表页**标签已登录
 *      （只能在列表页发请求，详情页的 axios 会加一次性签名，裸 XHR 过不了）。
 */
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const B = 'http://127.0.0.1:3456';
const argv = process.argv.slice(2);
const APPNO = argv.find((a) => !a.startsWith('--')) || '';
const OUT = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : 'probe-out.json'; })();
const DEEP = argv.includes('--deep');
if (!APPNO) { console.error('用法: node probe-fields.mjs <申请号> [--out probe-out.json] [--deep]'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (id, js, timeout = 180000) => {
  const r = await fetch(B + '/eval?target=' + id, { method: 'POST', body: js, signal: AbortSignal.timeout(timeout) });
  const t = await r.text();
  let o; try { o = JSON.parse(t); } catch { return { __raw: String(t).slice(0, 500) }; }
  if (o && o.error) return { __error: String(o.error).split('\n')[0].slice(0, 300) };
  return o && o.value !== undefined ? o.value : o;
};

/** 页面内通用 POST（同步 XHR，带鉴权头） */
const CALL = `(function(path, body){
  var t=localStorage.getItem('ACCESS_TOKEN'), ut=localStorage.getItem('USER_TYPE');
  if(!t) return { __noToken:true };
  var x=new XMLHttpRequest(); x.open('POST', path, false);
  x.setRequestHeader('Content-Type','application/json;charset=utf-8');
  x.setRequestHeader('Authorization','Bearer '+t);
  if(ut) x.setRequestHeader('userType', ut);
  try{ x.send(JSON.stringify(body)); }catch(e){ return { __status:-1, __err:String(e.message) }; }
  if(x.status!==200) return { __status:x.status };
  try{ return { __status:200, body:JSON.parse(x.responseText) }; }
  catch(e){ return { __status:200, __parseErr:String(x.responseText||'').slice(0,200) }; }
})`;

(async () => {
  let h = null;
  for (let i = 0; i < 8; i++) {
    try { h = await (await fetch(B + '/health', { signal: AbortSignal.timeout(6000) })).json(); if (h && h.status === 'ok') break; } catch { /* retry */ }
    await sleep(1500);
  }
  if (!h) { console.error('[前置] 代理未就绪，请先跑 bsk-cdp-shim.mjs'); process.exit(2); }

  const tabs = await (await fetch(B + '/targets')).json();
  const tab = tabs.find((x) => x.url && x.url.includes('chinesepatent/index'));
  if (!tab) { console.error('[前置] 未找到 cpquery 列表页标签（chinesepatent/index），请先登录 CNIPA'); process.exit(2); }
  const id = tab.targetId;

  const tk = await evalJs(id, `({hasToken: !!localStorage.getItem('ACCESS_TOKEN'), userType: localStorage.getItem('USER_TYPE')})`);
  console.log('[令牌]', JSON.stringify(tk));
  if (!tk || !tk.hasToken) { console.error('[前置] 无 ACCESS_TOKEN，登录态失效'); process.exit(2); }

  const out = { appno: APPNO, at: new Date().toISOString() };

  // ── A. sqxx：键结构 + 关键词命中 ────────────────────────────────────
  console.log('\n=== A. sqxx 结构探测 ===');
  const sq = await evalJs(id, `${CALL}('/api/view/gn/sqxx', ${JSON.stringify({ zhuanlisqh: APPNO })})`);
  out.sqxxStatus = sq && sq.__status;
  if (sq && sq.__status === 200 && sq.body) {
    const raw = JSON.stringify(sq.body);
    out.sqxxRaw = raw;
    const keysJs = `(function(){
      function keysOf(v,d,m){
        if(d>m||v===null||typeof v!=='object') return typeof v;
        if(Array.isArray(v)){ if(!v.length) return '[]'; var r={}; r['[0]x'+v.length]=keysOf(v[0],d+1,m); return r; }
        var o={}; Object.keys(v).forEach(function(k){ o[k]=keysOf(v[k],d+1,m); }); return o;
      }
      return keysOf(${JSON.stringify(sq.body)}, 0, 4);
    })()`;
    out.sqxxKeys = await evalJs(id, keysJs);
    console.log('[sqxx] data 键结构（深度 4）:');
    console.log(JSON.stringify(out.sqxxKeys, null, 1).slice(0, 4000));

    const KW = ['分案', '保全', '手续合格', '发文', '通知书', '恢复', '终止', '质押', '许可'];
    console.log('\n[sqxx] 原文关键词命中（字段名或值里出现）:');
    const hits = {};
    // 在原文里按 "key":"value" 粒度找
    const re = /"([^"]{2,40})"\s*:\s*("([^"]{0,80})"|[^,}]{1,30})/g;
    let m;
    while ((m = re.exec(raw))) {
      const k = m[1], v = m[3] || m[2] || '';
      for (const w of KW) {
        if (k.includes(w) || String(v).includes(w)) {
          (hits[w] = hits[w] || []).push(`${k} = ${String(v).slice(0, 60)}`);
        }
      }
    }
    out.sqxxKeywordHits = hits;
    for (const w of KW) {
      const arr = [...new Set(hits[w] || [])];
      if (arr.length) { console.log(`  · ${w}: ${arr.length} 处`); arr.slice(0, 12).forEach((s) => console.log(`      ${s}`)); }
    }
  } else {
    console.log('[sqxx] 未拿到 200：', JSON.stringify(sq).slice(0, 300));
  }

  // ── B. 发文信息接口试探 ─────────────────────────────────────────────
  console.log('\n=== B. 发文/通知书接口试探 ===');
  const paths = [
    '/api/view/gn/fwxx',
    '/api/view/gn/get-fwxx-list',
    '/api/view/gn/get-fawenxx-list',
    '/api/view/gn/cxxx',
    '/api/view/gn/get-cxxx-list',
    '/api/view/gn/get-tzsxx-list',
    '/api/view/gn/get-tongzhishu-list',
    '/api/view/gn/tzsxx',
    '/api/view/gn/get-ajfwxx-list',
  ];
  const nodeIds = ['aj_gk_fwxx', 'aj_gk_fawen', 'aj_gk_tzs', 'aj_gk_cxxx', ''];
  const found = [];
  for (const p of paths) {
    for (const n of nodeIds) {
      const body = n ? { zhuanlisqh: APPNO, nodeId: n, anjianbh: '' } : { zhuanlisqh: APPNO };
      const r = await evalJs(id, `${CALL}(${JSON.stringify(p)}, ${JSON.stringify(body)})`);
      const st = r && r.__status;
      const d = r && r.body && r.body.data;
      const n2 = d == null ? -1 : (Array.isArray(d) ? d.length : Object.keys(d).length);
      if (st === 200 && n2 !== 0) {
        console.log(`  ✅ ${p}  nodeId=${n || '(无)'}  status=200 data量=${n2}`);
        console.log(`     ${JSON.stringify(d).slice(0, 400)}`);
        found.push({ path: p, nodeId: n, sample: d });
      }
      await sleep(400);   // 别打太猛，令牌桶会连坐
    }
  }
  out.fawenCandidates = found;
  if (!found.length) console.log('  ✗ 全部候选都无有效 data（可能路径不对，或该号确实无发文）');

  // ── B2. ★ 2026-10-07：把 fwxx 的**发文区全部节点**逐个打印 ──────────────
  //  为什么加这段：页面上「发文信息」下有多个折叠区块（通知书发文、**专利证书**…），
  //  「专利证书」是独立表格，**节点名/字段名未实测锁定**。detail.mjs 已改成全节点抓取，
  //  这里用来**核对**「专利证书」实际落在哪个节点、日期字段叫 fawenr 还是别的，
  //  以便把 report.mjs 的打分规则收紧（而不是长期靠兜底猜）。
  console.log('\n=== B2. fwxx 发文区全节点清单（核对「专利证书」用）===');
  const fwres = await evalJs(id, `${CALL}('/api/view/gn/fwxx', ${JSON.stringify({ zhuanlisqh: APPNO })})`);
  out.fwxxStatus = fwres && fwres.__status;
  if (fwres && fwres.__status === 200 && fwres.body) {
    const fd = fwres.body.data || {};
    console.log(`  data 顶层键: ${Object.keys(fd).join(', ')}`);
    out.fwxxTopKeys = Object.keys(fd);
    out.fwxxNodes = [];
    Object.keys(fd).forEach((fk) => {
      const fv = fd[fk];
      if (!fv || typeof fv !== 'object') return;
      let arr = null;
      if (Array.isArray(fv)) arr = fv;
      else { for (const k2 of Object.keys(fv)) { if (Array.isArray(fv[k2])) { arr = fv[k2]; break; } } }
      if (!arr || !arr.length) return;
      const keys = arr[0] && typeof arr[0] === 'object' ? Object.keys(arr[0]) : [];
      const isTZS = /tongzhismc|通知书名称/.test(keys.join(',')) || /tongzhishufw|tzs/i.test(fk);
      const isZS = /zhuanlizs|zlzs|cert/i.test(fk) || JSON.stringify(arr).includes('专利证书');
      console.log(`  · ${fk}  条数=${arr.length}  ${isZS ? '★疑为专利证书' : isTZS ? '(通知书)' : ''}`);
      console.log(`      字段: ${keys.join(', ') || '(非对象)'}`);
      arr.slice(0, 2).forEach((x) => console.log(`      样例: ${JSON.stringify(x).slice(0, 200)}`));
      out.fwxxNodes.push({ node: fk, n: arr.length, keys, sample: arr.slice(0, 2), guess: isZS ? 'zhuanlizs' : isTZS ? 'tongzhishu' : '' });
    });
    console.log('  → 若「专利证书」被标为★，说明 report 的打分能直接命中；若没标出，');
    console.log('    请把上面几行贴给开发者，可据此把节点名写死（比兜底猜更稳）。');
  } else {
    console.log('  fwxx 未拿到 200：', JSON.stringify(fwres).slice(0, 200));
  }

  // ── C. fyxx 自检 ────────────────────────────────────────────────────
  console.log('\n=== C. fyxx 自检（年费 / 已缴费）===');
  const fy = await evalJs(id, `${CALL}('/api/view/gn/fyxx', ${JSON.stringify({ zhuanlisqh: APPNO })})`);
  out.fyxxStatus = fy && fy.__status;
  if (fy && fy.__status === 200 && fy.body) {
    const d = fy.body.data || {};
    const yj = (d.yingjiaofei || {}).svYingjfList || [];
    const yij = (d.yijiaofei || {}).svYijfList || [];
    console.log(`  fyxx 顶层键: ${Object.keys(d).join(', ')}`);
    console.log(`  应缴 ${yj.length} 条 / 已缴 ${yij.length} 条`);
    if (yj[0]) console.log(`  应缴样例: ${JSON.stringify(yj[0])}`);
    if (yij[0]) console.log(`  已缴样例: ${JSON.stringify(yij[0])}`);
    out.fyxx = { topKeys: Object.keys(d), yingjiao: yj, yijiao: yij };
    if (DEEP) out.fyxxRaw = JSON.stringify(fy.body);
  } else {
    console.log('  fyxx 未拿到 200：', JSON.stringify(fy).slice(0, 200));
  }

  writeFileSync(resolve(process.cwd(), OUT), JSON.stringify(out, null, 1), 'utf8');
  console.log(`\n[已写入] ${resolve(process.cwd(), OUT)}`);
})().catch((e) => { console.error('[ERROR]', e?.message || e); process.exit(1); });
