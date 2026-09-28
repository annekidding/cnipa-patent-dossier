#!/usr/bin/env node
/**
 * 第 1 步：按条件检索，产出待采集清单 rows.json
 *
 * 用法:
 *   <node> cnipa-dossier-search.mjs --name "<精确专利名称>"
 *   <node> cnipa-dossier-search.mjs --name-file 名称.txt        # 一行一个，支持 # 注释
 *   <node> cnipa-dossier-search.mjs --applicant "<精确申请人>"
 *   <node> cnipa-dossier-search.mjs --appno 2024108086589,2025203084591
 *   <node> cnipa-dossier-search.mjs --appno-file 号码.txt        # 一行一个，支持 # 注释
 *                                  [--types 1,2,3] [--size 5000] [--out rows.json]
 *                                  [--applicant-mode part|full] [--name-mode exact|contains]
 *
 * 三种输入（★ 用户 2026-09-15 定的口径）：
 *   --name        **精确专利名称**：先用 zhuanlimc 检索，再按「完全相等」过滤
 *   --name-file   **名称清单**（★ 2026-09-18 加）：一行一个，逐名称检索 + 精确过滤，
 *                 最后按**清单原序**出表（每个名称内部命中多条时，按申请日新→旧、同日号大→小）。
 *                 给一串名称时用它，等价于把 --name 跑 N 遍但只发一轮、行序可控。
 *                 检索不到的名称**照样占一行**（merged/yearfee 第 4 列起写「未查到」），便于对账。
 *   --applicant   **精确申请人**：先用 shenqingrxm 检索，再按精确匹配过滤
 *                 默认 part = 申请人字段按 , ，; ； 切分后**任一段完全相等**即命中
 *                 （共同申请人场景：”A大学,B公司” 查 “B公司” 也命中）；--applicant-mode full 则要求整字段完全相等
 *   --appno       单个专利号（如 2024108086589）。★ cpquery 不支持批量检索，
 *                 含逗号/分号/空格/换行会被**整体拒绝**，请改用 --appno-file 一行一个。
 *   --appno-file  文本文件（每行一个号，# 开头为注释）。多号批量的标准入口。
 *
 * 为什么给号也要检索：申请日（shenqingr）不在 sqxx 里，只在**检索结果行**上有。
 * 不检索就拿不到申请日，而它是交付表的必需列。
 *
 * 输出 rows.json：[{ appno, name, applicant, date, status, lawStatus, type, found }]
 *   found=false 的行 = 检索不到（号错/未公开），仍保留，交付表里标「未查到」，**不静默丢行**。
 *
 * ★ 行序（2026-09-16 加）：按名称/申请人检索时，输出前做**确定性排序**
 *   （申请日 新→旧，同日按申请号 大→小），因为 cpquery 对同一申请日的多件返回顺序不稳定，
 *   跨天重跑会互换（实测创导 2023-05-08 那组 6/7、11/12 位两次跑法不同）。
 *   ★ 按号检索（--appno / --appno-file）**不排序**，保留用户给的顺序。
 *
 * 依赖: CDP 代理 http://127.0.0.1:3456 已就绪，cpquery 列表页标签已登录。
 *       用 scripts/cnipa-dossier-cdp.mjs 做标签自愈与探针。
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { evalJs, smokeJs, findOrOpenTab } from './cnipa-dossier-cdp.mjs';

const B = 'http://127.0.0.1:3456';
const argv = process.argv.slice(2);
const VALUED = ['--appno', '--appno-file', '--name', '--name-file', '--applicant', '--types', '--size', '--out',
  '--applicant-mode', '--name-mode'];
const opt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const NAME = opt('name', '');
const NAME_FILE = opt('name-file', '');
const APPLICANT = opt('applicant', '');
const APPNO = opt('appno', '');
const APPNO_FILE = opt('appno-file', '');
const TYPES = opt('types', '1,2,3');
// 默认 500：实测 size 开到 5000 时偶发「组件还在渲染、dataList 迟迟不刷新」导致读到 0 条
// （2026-09-15 实测：同一关键词 size=5000 首查 total=0，size=50/500 正常）。
// 小分页 + 翻页更稳；确实要一次拉更多再显式 --size。
const SIZE = parseInt(opt('size', '500'), 10);
const OUT = opt('out', 'rows.json');
const APPL_MODE = opt('applicant-mode', 'part');
const NAME_MODE = opt('name-mode', 'exact');

const TYPE_NAME = { 1: '发明', 2: '实用新型', 3: '外观设计' };
const SE = `document.querySelector('.q-pagination').__vue__.$parent.$parent`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 归一化：去空白 + 全角括号/逗号，用于「精确」比较 */
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').replace(/[（）]/g, (m) => (m === '（' ? '(' : ')'));

/** ★ 申请号归一化：去 CN 前缀 + 空白（用户可能给 CN202422940446.4 / 202422940446.4 / 202422940446）。
 *   检索接口不认 CN 前缀；校验位保留（接口按完整号匹配）。 */
const normNo = (s) => String(s == null ? '' : s).trim().toUpperCase().replace(/^CN/, '').replace(/\s+/g, '').replace(/\./g, '');

const appnos = [];
if (APPNO) {
  // ★ 2026-09-16 P0-4：--appno 只接单号；含分隔符则直接拒绝 + 引导用 --appno-file。
  //   cpquery 后端 zhuanlisqh 接口**没有**多号批量支持，每次只能查一个。
  //   早期版本"好心"自动拆号逐个查，体验上很慢但能跑通；现在改为用户错误而非静默行为。
  if (/[,，\s;；]/.test(APPNO)) {
    console.error('✗ --appno 不接受逗号/分号/空格/换行分隔的多号（cpquery 不支持批量）。');
    console.error('  请把多号写到一个文本文件（每行一个），改用 --appno-file 号码.txt');
    console.error('  示例：');
    console.error('    号码.txt 内容：');
    console.error('      2024108086589');
    console.error('      2025203084591');
    console.error('    命令行：<node> cnipa-dossier-search.mjs --appno-file 号码.txt');
    process.exit(2);
  }
  appnos.push(APPNO.trim());
}
if (APPNO_FILE) {
  if (!existsSync(resolve(process.cwd(), APPNO_FILE))) { console.error(`[输入] 找不到 ${APPNO_FILE}`); process.exit(1); }
  readFileSync(resolve(process.cwd(), APPNO_FILE), 'utf8').split(/\r?\n/).forEach((l) => {
    const s = l.replace(/#.*$/, '').trim();
    if (s) appnos.push(s);
  });
}

// ★ 2026-09-18：--name-file 名称清单（一行一个，# 注释）。去重后保持清单原序。
const names = [];
if (NAME_FILE) {
  if (!existsSync(resolve(process.cwd(), NAME_FILE))) { console.error(`[输入] 找不到 ${NAME_FILE}`); process.exit(1); }
  readFileSync(resolve(process.cwd(), NAME_FILE), 'utf8').split(/\r?\n/).forEach((l) => {
    const s = l.replace(/#.*$/, '').trim();
    if (s && !names.includes(s)) names.push(s);
  });
  if (!names.length) { console.error(`[输入] ${NAME_FILE} 里没有有效名称`); process.exit(1); }
}

if (!NAME && !names.length && !APPLICANT && !appnos.length) {
  console.error('用法：必须给 --name / --name-file / --applicant / --appno / --appno-file 之一');
  process.exit(1);
}

(async () => {
  let h = null;
  for (let i = 0; i < 8; i++) {
    try { h = await (await fetch(B + '/health', { signal: AbortSignal.timeout(6000) })).json(); if (h && h.status === 'ok') break; } catch { /* retry */ }
    await sleep(1500);
  }
  if (!h) { console.error('[前置] 代理未就绪，请先跑 bsk-cdp-shim.mjs --keep-session'); process.exit(2); }

  const smokeBody = appnos.length ? { page: 1, size: 1, zhuanlisqh: normNo(appnos[0]) }
    : (NAME || names.length) ? { page: 1, size: 1, zhuanlimc: NAME || names[0] }
      : { page: 1, size: 1, shenqingrxm: APPLICANT };
  const got = await findOrOpenTab(B, smokeBody, 'search');
  if (!got) {
    console.error('[前置] 找不到可用的 cpquery 列表页标签（chinesepatent/index），请确认已登录 CNIPA');
    console.error('       若刚跑过大批量，可能是站点侧限流升级 —— 等几分钟再试。');
    process.exit(2);
  }
  const id = got.targetId;

  // 等查询组件就绪（页面 bootstrap 未完成就设 params 会被覆盖 → 恒 0 条）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const ok = await evalJs(B, id, `(() => { try { const se=${SE}; return typeof se.getList === 'function' && !!se.params; } catch(e){ return false; } })()`).catch(() => false);
    if (ok) { ready = true; break; }
    await sleep(1000);
  }
  if (!ready) console.log('[初始化] ⚠️ 60s 内未等到查询组件就绪，仍尝试驱动');

  /** 发起查询：清空残留条件 → 设本次条件 → getList */
  const doQuery = (extra, page = 1) => evalJs(B, id, `(() => { const se=${SE};
    se.dataList=[]; se.total=0;
    const keep=['zhuanlilx','page','size','sortDataName','sortType'];
    const skipped=[];
    Object.keys(se.params).forEach(k=>{ if(keep.includes(k)) return;
      const v=se.params[k];
      if(typeof v==='string') se.params[k]='';
      else if(Array.isArray(v)) se.params[k]=[];
      else if(v!==undefined&&v!==null&&v!=='') skipped.push(k);
    });
    Object.assign(se.params, ${JSON.stringify(extra)});
    se.params.page=${page}; se.params.size=${SIZE};
    se.sortDataName && (se.params.sortDataName='');
    se.getList();
    return { params: JSON.parse(JSON.stringify(se.params)), skipped }; })()`);

  const readRows = () => evalJs(B, id, `(() => { const se=${SE}; const d=se.dataList||[];
    return { total: se.total, maxPage: se.maxPage, len: d.length,
      first: d[0]?d[0].zhuanlisqh:'',
      rows: d.map(r=>({ appno:r.zhuanlisqh, name:r.zhuanlimc, applicant:r.shenqingrxm,
                        date:r.shenqingr, status:r.anjianywzt, lawStatus:r.falvzt,
                        type:r.zhuanlilx })) }; })()`);

  /** 轮询等数据到位（首行出现即算）。组件偶发慢启动，给到 20s。 */
  const waitRows = async (wantAppno) => {
    for (let i = 0; i < 50; i++) {
      const r = await evalJs(B, id, `(() => { const se=${SE}; const d=se.dataList||[];
        return { len:d.length, first:d[0]?d[0].zhuanlisqh:'' }; })()`).catch(() => null);
      if (r && r.len > 0) return true;               // 有数据就算完成（不匹配=查无此号）
      await sleep(400);
    }
    return false;
  };

  /** 0 条重试：首查偶发 total=0（组件 bootstrap 竞态），重发一次通常就好 */
  const queryWithRetry = async (extra, wantAppno) => {
    for (let round = 1; round <= 3; round++) {
      await doQuery(extra, 1);
      await waitRows(wantAppno);
      const r = await readRows();
      if ((r && r.total) || round === 3) return r;
      console.log(`  [重试 ${round}] 首查 0 条，重发查询…`);
      await sleep(1500);
    }
    return null;
  };

  const rows = [];
  const wantedTypes = TYPES ? String(TYPES).split(',').map((s) => s.trim()) : null;
  const keepType = (t) => !wantedTypes || wantedTypes.length === 0 || wantedTypes.includes(String(t));

  /** 按关键词检索并取回**全部分页**（模式 B/C/D 共用）。返回检索原始行数组 */
  const fetchAllPages = async (kw, paramKey) => {
    const init = await doQuery({ [paramKey]: kw, zhuanlilx: '' }, 1);
    if (init && init.skipped && init.skipped.length) console.log(`  ⚠️ 残留条件未能清空: ${init.skipped.join(',')}`);
    await waitRows();
    let meta = await readRows();
    if (!meta || !meta.total) {                   // 首查 0 条 → 重发一次（组件 bootstrap 竞态）
      console.log('  [重试] 首查 0 条，重发查询…');
      await doQuery({ [paramKey]: kw, zhuanlilx: '' }, 1);
      await waitRows();
      meta = await readRows();
    }
    const maxPage = (meta && meta.maxPage) || 1;
    console.log(`[元信息] total=${(meta && meta.total) || 0} maxPage=${maxPage} 本页 ${(meta && meta.len) || 0}`);

    const all = [];
    const collect = (r) => (r && r.rows || []).forEach((x) => all.push(x));
    collect(meta);
    for (let p = 2; p <= maxPage; p++) {
      await evalJs(B, id, `(() => { const se=${SE}; se.__wbPrev=(se.dataList&&se.dataList[0])?se.dataList[0].zhuanlisqh:'';
        se.params.page=${p}; se.params.size=${SIZE}; se.getList(); return 1; })()`);
      let changed = false;
      for (let w = 0; w < 25; w++) {
        const cur = await evalJs(B, id, `(() => { const se=${SE}; const d=se.dataList||[];
          return { first:d[0]?d[0].zhuanlisqh:'', prev:se.__wbPrev||'' }; })()`).catch(() => null);
        if (cur && cur.first && cur.first !== cur.prev) { changed = true; break; }
        await sleep(400);
      }
      if (!changed) console.log(`  ⚠️ 第${p}页 首行未变化，仍尝试读取`);
      collect(await readRows());
      console.log(`  [第${p}/${maxPage}页] 累计 ${all.length}`);
    }
    return all;
  };

  /** 精确过滤（模式 B/C/D 共用）：名称=完全相等（或 contains）；申请人=段相等（或整字段相等） */
  const filterHits = (all, isName, kw) => {
    const nkw = norm(kw);
    let dropped = 0;
    const out = [];
    for (const x of all) {
      if (!keepType(x.type)) { dropped++; continue; }
      let hit = false;
      if (isName) {
        hit = NAME_MODE === 'contains' ? norm(x.name).includes(nkw) : norm(x.name) === nkw;
      } else {
        const parts = String(x.applicant || '').split(/[,，;；]/).map(norm).filter(Boolean);
        hit = APPL_MODE === 'full' ? norm(x.applicant) === nkw : parts.includes(nkw);
      }
      if (hit) out.push({ ...x, found: true }); else dropped++;
    }
    console.log(`[精确过滤] 检索命中 ${all.length} 行 → 精确匹配 ${out.length} 条（剔除 ${dropped} 条）`);
    if (dropped) console.log(`   （剔除原因：类型不符 或 ${isName ? '名称' : '申请人'}不是完全相等）`);
    return out;
  };

  /** 行序确定化：申请日 新→旧，同日按申请号 大→小（就地排序并返回） */
  const stableSort = (arr) => arr.sort((x, y) => {
    const dx = String(x.date || ''), dy = String(y.date || '');
    if (dx !== dy) return dy.localeCompare(dx);
    return String(y.appno || '').localeCompare(String(x.appno || ''));
  });

  // ── 模式 A：按专利号逐号检索 ────────────────────────────────────────
  // ★ 号码归一化用外层 normNo：查询词去 CN 前缀 + 去「.」校验位分隔点
  //   （库里的号是 13 位不带点，如 2024229404464；用户习惯写 CN202422940446.4）；
  //   命中比较双方归一；命中后 rows 的 appno 用**检索行原生值**（detail 的 sqxx 只认这个格式）。
  if (appnos.length) {
    console.log(`[模式] 按专利号检索 ${appnos.length} 个（逐号查询，多号无法批量）`);
    for (let i = 0; i < appnos.length; i++) {
      const a = appnos[i];
      const q = normNo(a);
      const init = await doQuery({ zhuanlisqh: q, zhuanlilx: '' }, 1);
      if (init && init.skipped && init.skipped.length) {
        console.log(`  ⚠️ 残留条件未能清空: ${init.skipped.join(',')} —— 请在页面上手动清空后重跑`);
      }
      await waitRows(q);
      let r = await readRows();
      if (!r || !r.total) {                       // 首查 0 条 → 重发一次（组件 bootstrap 竞态）
        console.log(`  [重试] ${a} 首查 0 条，重发查询…`);
        await doQuery({ zhuanlisqh: q, zhuanlilx: '' }, 1);
        await waitRows(q);
        r = await readRows();
      }
      const hit = (r && r.rows || []).find((x) => x.appno === q || normNo(x.appno) === q);
      if (hit) { rows.push({ ...hit, found: true }); console.log(`  [${i + 1}/${appnos.length}] ${a} ✅ ${hit.status} | ${hit.name}`); }
      else { rows.push({ appno: a, name: '', applicant: '', date: '', status: '未查到', lawStatus: '', type: '', found: false }); console.log(`  [${i + 1}/${appnos.length}] ${a} ✗ 检索无此号`); }
    }
  } else if (names.length) {
    // ── 模式 D：名称清单（★ 2026-09-18 加）──────────────────────────────
    //   --name-file 一行一个名称：逐个检索 + 精确过滤，**保持清单原序**出表
    //   （单个名称内部若命中多条，按申请日新→旧、同日号大→小，保证可复现）。
    //   检索不到的名称**仍占一行**（appno 空、found=false）→ 交付表标「未查到」，便于对账。
    console.log(`[模式] 按名称清单检索 ${names.length} 个（逐名称查询 + 精确过滤，行序按清单原序）`);
    for (let i = 0; i < names.length; i++) {
      const kw = names[i];
      const all = await fetchAllPages(kw, 'zhuanlimc');
      const hits = stableSort(filterHits(all, true, kw));
      if (hits.length) {
        hits.forEach((h) => rows.push(h));
        console.log(`  [${i + 1}/${names.length}] ✅ ${hits.length} 条 | ${kw}`);
      } else {
        rows.push({ appno: '', name: kw, applicant: '', date: '', status: '未查到', lawStatus: '', type: '', found: false });
        console.log(`  [${i + 1}/${names.length}] ✗ 检索不到 | ${kw}`);
      }
    }
  } else {
    // ── 模式 B/C：按名称 或 按申请人（单关键词：检索 + 翻页 + 精确过滤）────
    const isName = !!NAME;
    const kw = isName ? NAME : APPLICANT;
    const paramKey = isName ? 'zhuanlimc' : 'shenqingrxm';
    console.log(`[模式] 按${isName ? '专利名称' : '申请人'}检索：${kw}（检索后用「精确相等」过滤）`);

    const all = await fetchAllPages(kw, paramKey);
    filterHits(all, !!NAME, kw).forEach((h) => rows.push(h));
    if (!rows.length) console.log('   ⚠️ 无精确匹配（按名称可试 --name-mode contains 放宽）');

    // ★ 2026-09-16（观察2）：行序稳定化。
    //   cpquery 对**同一申请日**的多件，返回顺序不稳定 —— 跨天重跑会互换
    //   （实测创导 2023-05-08 那组：6/7 位、11/12 位两次跑法不同）。
    //   这里加确定性排序：申请日 **新→旧**，同日按申请号 **大→小** → rows.json 可复现。
    //   ⚠️ 只在「按名称/申请人」模式做；按号（--appno / --appno-file）与名称清单
    //      （--name-file）**保留用户给的顺序**（清单模式下只是每个名称内部稳定排序）。
    stableSort(rows);
    console.log('[排序] 申请日 新→旧，同日按申请号 大→小（保证跨天重跑行序一致）');
  }

  // 类型代码 → 中文
  rows.forEach((r) => { r.typeName = TYPE_NAME[String(r.type)] || (r.type ? `类型${r.type}` : ''); if (r.found === undefined) r.found = true; });

  const byType = {};
  rows.forEach((r) => { const k = r.typeName || '(未知)'; byType[k] = (byType[k] || 0) + 1; });
  const notFound = rows.filter((r) => !r.found).length;

  writeFileSync(resolve(process.cwd(), OUT), JSON.stringify(rows, null, 1), 'utf8');
  console.log(`\n[完成] ${rows.length} 条${notFound ? `（其中检索不到 ${notFound} 条，交付表标「未查到」）` : ''}`);
  console.log('[类型分布]', JSON.stringify(byType));
  console.log('[已写入]', resolve(process.cwd(), OUT));
  console.log('\n下一步：<node> cnipa-dossier-detail.mjs rows.json');
})().catch((e) => { console.error('[ERROR]', e?.message || e); process.exit(1); });
