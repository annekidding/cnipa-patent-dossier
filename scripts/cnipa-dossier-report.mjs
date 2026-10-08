#!/usr/bin/env node
/**
 * 第 3 步：合成交付用 CSV（按 --template 选「专利档案」或「年费查询」）
 *
 * 用法:
 *   <node> cnipa-dossier-report.mjs [--rows rows.json] [--detail detail.json]
 *                                   [--template merged|dossier|yearfee] [--out 专利年费查询.csv]
 *                                   [--show N] [--no-bom] [--zhulu-days 365]
 *
 * 模板（★ 用户 2026-09-18：新增 merged 并设为默认；销售清单模板已于 09-16 移除）：
 *   - merged（默认）= **19 列合并表**（原 17 列 + 2026-10-07 追加的两列发文日）
 *                     把原来的「专利档案」与「年费查询」两张表**合并成一张交付表**
 *   - dossier        = 16 列 CNIPA 专利档案（原 14 列 + 两列发文日）
 *   - yearfee        = 6 列年费查询表（用户 2026-09-15 给的标准答案表结构，不含发文日）
 *
 * ★ 2026-10-07 追加两列（用户截图「发文信息」区）：
 *   1. 办理登记手续通知书发文日 ← fwList 里名称匹配「办理登记手续」的那一行的发文日
 *   2. 专利证书发文日            ← 发文区**全节点**扫描（fwNodes），定位「专利证书」区块
 *   两列只写日期本身；没有该文书写「无」；接口失败写「数据缺口」。
 *
 * merged 列（用户模板 A1:P1 的 16 列，顺序不动 + 追加第 17 列）：
 *   序号 / 专利号 / 专利名称 / 年费 / 年费截止日 / 分案-质押-许可 / 有无手续合格通知书 /
 *   有无保全程序开始通知书 / 是否有专利质押 / 是否有许可 / 申请人 / 申请日 / 案件状态 /
 *   专利类型 / 分案提交日 / 年费信息 / 一年内是否交过变更费
 *   ★ 用户 2026-09-18：模板里没有「一年内是否交过变更费」但**要保留** → 追加为第 17 列。
 *   ★ 用户 2026-09-18：「年费截止日」写法对齐模板 `2027/9/2`（斜杠 + 去前导零，见 fmtSlash）。
 *
 * dossier 列（★ 唯一定义处，改列只改下面的 COLUMNS_DOSSIER / COLUMNS_YEARFEE）：
 *   序号 / 专利号 / 专利名称 / 申请人 / 申请日 / 案件状态 / 专利类型 / 分案提交日 /
 *   年费信息 / 有无手续合格通知书 / 有无保全程序开始通知书 / 是否有专利质押 /
 *   是否有许可 / 一年内是否交过变更费
 *
 * 取值与缺失值口径（★ 用户 2026-09-15 确认的默认口径）：
 *   - 分案提交日：空 → 「(无)」；接口失败 → 「数据缺口」
 *   - 年费信息（★ 按案件状态分三档，2026-09-15 追加；★ 2026-09-16 修正取段口径）：
 *       ① 等年费滞纳金 → **缴费时段包含今天**那一段的「年费 + 应缴滞纳金 + 总计」
 *       ② 专利权维持   → 最近的年费应缴费信息（未缴年费中截止日最早的一条）
 *       ③ 其余状态     → 同 ②，有滞纳金时追加「；滞纳金 N 条」
 *       另：实用新型 + 「未缴年费专利权终止，等恢复」→ 年费列写「等恢复·按口径未取年费」，
 *           但 fyxx 请求照发，**变更费列照常出值**（只省年费，不省变更费）
 *   - 通知书两列：有 → 「有(YYYY-MM-DD)」取最近一次；无 → 「无」；接口失败 → 「数据缺口」
 *   - 质押：否 / 是(N) / 是(N，已注销 2025-08-18)；许可：是/否；接口失败 → 「数据缺口」
 *           （质押的注销状态来自 zlqzyxx 详情，见 zyState / rightsPlain）
 *   - 一年内变更费：已缴费里含「著录事项变更」且缴费日在最近 365 天（基准=今天）→ 是/否/数据缺口
 * ★ 「查不到数据」与「确实没有」严格分开：前者一律标「数据缺口」，绝不静默当「无」。
 * ★ 检索不到的专利号（found=false）照样占一行，各项标「未查到」——保证给进去多少号、出来多少行。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

const argv = process.argv.slice(2);
const VALUED = ['--rows', '--detail', '--out', '--show', '--zhulu-days', '--template', '--status-filter', '--as-of'];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  if (VALUED.includes(a) && (i + 1 >= argv.length || argv[i + 1].startsWith('--'))) {
    console.error(`✗ 参数 ${a} 缺值`); process.exit(2);
  }
  // ★ 2026-10-07：--all-rows 是合法开关（run.mjs 会透传），此前漏进白名单会被判「未知参数」直接退出 2
  if (!VALUED.includes(a) && a !== '--no-bom' && a !== '--all-rows') { console.error(`✗ 未知参数 ${a}`); process.exit(2); }
}
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const ROWS = resolve(opt('rows', 'rows.json'));
const DETAIL = resolve(opt('detail', 'detail.json'));
const SHOW = Number(opt('show', '30'));
const ZHULU_DAYS = Number(opt('zhulu-days', '365'));
const TEMPLATE = opt('template', 'merged');       // merged=17 列合并表(默认) / dossier=14 列档案 / yearfee=6 列年费表
const BOM = !argv.includes('--no-bom');

/** ★ 「今天」基准日（2026-09-16 加）：滞纳金取「包含今天的时段」，跨天后结果会自然下移一段。
 *  `--as-of 2026-09-15` 可锁定基准日复现某天的表。接受 `YYYY-MM-DD` / `YYYYMMDD`，缺省=系统当天。 */
const AS_OF = String(opt('as-of', '')).trim();
const TODAY = (() => {
  if (/^\d{8}$/.test(AS_OF)) return `${AS_OF.slice(0, 4)}-${AS_OF.slice(4, 6)}-${AS_OF.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(AS_OF)) return AS_OF;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();
const VALID_TEMPLATES = ['merged', 'dossier', 'yearfee'];
if (!VALID_TEMPLATES.includes(TEMPLATE)) { console.error(`✗ --template 只接受 ${VALID_TEMPLATES.join('|')}，当前 ${TEMPLATE}`); process.exit(2); }
// ★ merged 与 yearfee 同为「年费查询」类交付物（用户模板文件名即 `…-专利年费查询.xlsx`）
const OUT_NAME = TEMPLATE === 'dossier' ? '专利档案.csv' : '专利年费查询.csv';
const OUT = resolve(opt('out', '') || OUT_NAME);    // 用户不传 --out 时按模板默认

/** yyyymmdd → YYYY-MM-DD（非 8 位原样返回） */
const fmtDate = (s) => {
  const v = String(s || '').trim();
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
};
/** ★ 用户 2026-09-18：日期写法对齐用户模板 `广西维智网-专利年费查询.xlsx` ——
 *  斜杠 + 去前导零（模板 E 列是 Excel 日期值 46632，按 `yyyy/m/d` 显示为 `2027/9/2`）。
 *  **只作用于「年费截止日」列**，输入两种：
 *    - 维持型        `2027-12-22`                    → `2027/12/22`
 *    - 滞纳金时段原文 `2026年09月16日到2026年10月15日` → `2026/9/16到2026/10/15`
 *      （只换日期写法，「到」与时段语义保留）
 *  其它模板的日期列（通知书 / 质押注销 / 变更费 / 申请日）维持 `YYYY-MM-DD` 口径不动。 */
const fmtSlash = (s) => {
  const v = String(s == null ? '' : s).trim();
  if (!v) return '';
  return v
    .replace(/(\d{4})年(\d{2})月(\d{2})日/g, (_m, y, m, d) => `${y}/${Number(m)}/${Number(d)}`)
    .replace(/(\d{4})-(\d{2})-(\d{2})/g, (_m, y, m, d) => `${y}/${Number(m)}/${Number(d)}`);
};

const GAP = '数据缺口';

/** 通知书匹配（用户口径：手续合格通知书 / 保全程序开始通知书（开始保全-公告）） */
const RE_SHOUXU = /手续合格/;
const RE_BAOQUAN = /保全程序开始|开始保全/;

function noticeCell(fwList, re) {
  if (!Array.isArray(fwList)) return GAP;
  const hit = fwList.filter((x) => re.test(String(x.mc || '')));
  if (!hit.length) return '无';
  const latest = hit.map((x) => String(x.rq || '')).sort().pop();
  return `有(${fmtDate(latest)})`;
}

/** 案件状态判定（用户 2026-09-15 追加口径） */
const RE_ZNJ = /等年费滞纳金/;        // 等年费滞纳金 → 取最近时间段的年费/滞纳金/总计
const RE_WEICHI = /专利权维持/;       // 专利权维持   → 取最近的年费应缴费信息

/** ★ 2026-10-07 新增：办理登记手续通知书的发文日
 *  页面位置 =「发文信息 → 通知书发文」表格里的一行（通知书名称 = 办理登记手续通知书）。
 *  该行已在 fwList 里（就是 fwxx 的 tongzhishufwList），所以**复用同一份数据**，不额外发请求。
 *  口径与用户图一致：只写日期本身（不带「有(...)」前缀，因为列名已经说明了是什么）。
 *    命中多条 → 取最近一次（同 noticeCell 的做法）
 *    没有该通知书 → 「无」；接口失败/未采集 → 「数据缺口」 */
const RE_DENGJI = /办理登记手续/;
function dengjiCell(d) {
  if (!d || d.fwStatus !== 200) return GAP;
  if (!Array.isArray(d.fwList)) return GAP;
  const hit = d.fwList.filter((x) => RE_DENGJI.test(String(x.mc || '')));
  if (!hit.length) return '无';
  const latest = hit.map((x) => fmtDate(x.rq)).filter(Boolean).sort().pop();
  return latest || '无';
}

/** ★ 2026-10-07 新增：专利证书的发文日
 *  页面位置 =「发文信息 → **专利证书**」折叠区块（与「通知书发文」是**两个独立表格**，
 *  证书表表头 = 发文日 / 收件人姓名 / 收件人邮编；通知书表还多「通知书名称/下述时间/下述IP地址/发文方式」）
 *  —— 所以**不在** tongzhishufwList 里。
 *  ★ 2026-10-07 **已实测确认**（probe-fields.mjs + 真实跑通 2024208094504）：
 *     专利证书区块节点 = `zhuanlizsfw`，数组键 `zhuanlizsfwList`，日期字段 `fawenr`
 *     （实测值 20241220，与用户截图一致）。它与 `tongzhishufw` 在 fwxx 的 data 下**并列**。
 *     下面仍保留多信号打分（而非纯写死），以便站点改版/字段漂移时不至于直接失效。
 *     采集侧（detail.mjs）把 fwxx 的 data 下**每个**含数组的节点都抓进 fwNodes[]。
 *  打分规则（见 nodesScore）：
 *      +5 节点名 = `zhuanlizsfw`（★ 实测确认，最高优先）
 *      +3 节点名含「专利证书/证书」中文或拼音 zhuanlizs / zlzs / cert
 *      +2 节点名含 zs；或条目里出现「专利证书/证书」中文
 *      +1 条目有收件人邮编类字段（sqr / youjianyb / zb / postcode）—— 证书表有、多数其他区块没有
 *      -2 条目有「通知书名称」类字段（tongzhismc / tzs）—— 那是通知书表，不是证书表
 *    取分数最高的节点；都为 0 时按「唯一带发文日期的、且不像通知书的节点」兜底。
 *  取值：从命中节点的条目里挑日期形态字段（fawenr / fwrq / rq…），多行取最近一次。
 *  没有 → 「无」；接口失败 → 「数据缺口」。 */
const RE_ZLZS_CN = /专利证书|证书/;
const RE_ZLZS_PY = /zhuanlizs|zlzs|cert/i;
const RE_ZLZS_ZS = /zs/i;
const RE_TZS = /tongzhismc|通知书名称|tzs/i;
const RE_YB = /sqr|youjianyb|youjiandz|postcode|^zb$|zips/i;
const DATE_RE = /^(\d{8}|\d{4}-\d{2}-\d{2})$/;

/** 从一个条目里取发文日期（多行取最近一次） */
function pickDate(list) {
  const dates = [];
  (list || []).forEach((item) => {
    Object.entries(item || {}).forEach(([k, v]) => {
      if (!/fawen|fwrq|rq|date|riqi|ri$/i.test(k)) return;
      const s = String(v == null ? '' : v).trim();
      if (DATE_RE.test(s)) dates.push(fmtDate(s));
    });
  });
  return dates.length ? dates.sort().pop() : '';
}
function zhuanlizsCell(d) {
  if (!d || d.fwStatus !== 200) return GAP;
  const nodes = Array.isArray(d.fwNodes) ? d.fwNodes : null;
  if (!nodes) return `${GAP}(旧版采集数据，需重跑第2步)`;   // 旧 detail.json 没 fwNodes → 说清原因
  let best = null, bestScore = 0;
  const withDate = [];
  nodes.forEach((n) => {
    const list = n.list || [];
    if (!list.length) return;
    const score = nodesScore(String(n.node || ''), list);
    if (score > bestScore) { bestScore = score; best = list; }
    //兜底候选：必须「有发文日期」且**不像通知书表**（有通知书名称字段的排除）
    if (score >= 0 && pickDate(list)) withDate.push(list);
  });
  // 兜底：分数全为 0（节点名纯拼音且表头无特征字段）→ 若只剩一个带发文日期、且不像通知书的节点，就当它
  let target = bestScore > 0 ? best : (withDate.length === 1 ? withDate[0] : null);
  if (!target) return '无';
  const day = pickDate(target);
  return day || '无(有记录但无发文日)';
}
/** 节点打分：>0 判定为「证书区块」，越大越像。
 *  ★ 2026-10-07 已**实测确认**（probe-fields.mjs on 2024208094504）：
 *    真实节点名 = `zhuanlizsfw`，其数组键 = `zhuanlizsfwList`，条目字段 = `fawenr` / `shoujianrxm` / `shoujianryb`
 *    （无「专利证书」中文字样，只有拼音）—— 与通知书表 `tongzhishufw.tongzhishufwList` 并列。
 *    所以打分规则按实测校准：`zhuanlizsfw` 直接 +3 且**排除**通知书表。 */
const NODE_ZS_EXACT = /zhuanlizsfw/i;          // ★ 实测确认的证书节点名
function nodesScore(node, list) {
  let s = 0;
  if (NODE_ZS_EXACT.test(node)) s += 5;        // 实测命中：最高优先
  if (RE_ZLZS_CN.test(node) || RE_ZLZS_PY.test(node)) s += 3;
  else if (RE_ZLZS_ZS.test(node)) s += 2;
  const txt = list.map((x) => Object.values(x || {}).join(' ')).join(' ');
  if (RE_ZLZS_CN.test(txt)) s += 2;
  if (list.some((x) => Object.keys(x || {}).some((k) => RE_YB.test(k)))) s += 1;
  if (list.some((x) => Object.keys(x || {}).some((k) => RE_TZS.test(k)))) s -= 2;
  return s;
}

/** 解析滞纳金缴费时段 "2026年08月06日到2026年09月07日" → {s:'2026-08-06', e:'2026-09-07', raw} */
function parseSpan(s) {
  const raw = String(s || '').trim();
  const m = raw.match(/\d{4}年\d{2}月\d{2}日/g) || [];
  const f = (x) => x.replace(/(\d{4})年(\d{2})月(\d{2})日/, '$1-$2-$3');
  return { s: m[0] ? f(m[0]) : '', e: m.length ? f(m[m.length - 1]) : '', raw };
}

/** ★ 用户 2026-09-15 23:59 定：滞纳金的「当期」= **缴费时段包含今天的那一段**，
 *  不是「时间段最晚的那一段」。成因：CNIPA 从宽限期末排到缴费截止日，逐月递增；
 *  用户表（标准答案）取的正是「今天落在哪一段」。
 *  实测 2023211657312：5 段 180/225/270/315/360（结束日 07-15/08-17/09-15/10-15/11-16），
 *  今天 2026-09-15 落在第 3 段 → 270 ✓（旧逻辑取最晚段得 360 ✗）。
 *  兜底：没有任何一段包含今天（已过最晚段 / 全是未来段）→ 退回最晚段（不静默出空值）。
 *  `today` 缺省 = 文件级 TODAY（系统当天，或 --as-of 指定）。 */
function pickZnj(zn, today = TODAY) {
  const list = (Array.isArray(zn) ? zn : [])
    .map((x) => ({ ...x, _sp: parseSpan(x.sj) }))
    .filter((x) => x._sp.s || x._sp.e);
  if (!list.length) return null;
  const t = today;
  const byEnd = list.slice().sort((a, b) => a._sp.e.localeCompare(b._sp.e));
  const inToday = byEnd.filter((x) => x._sp.s <= t && t <= x._sp.e);
  if (inToday.length) return inToday[inToday.length - 1];
  const late = byEnd.filter((x) => x._sp.e < t);         // 全过期 → 最晚那条
  if (late.length) return late[late.length - 1];
  return byEnd[0];                                        // 全未来 → 最早那条
}

/** 年费信息：按案件状态分档（★ 用户 2026-09-15 追加两条规则） */
function feeCell(r, d) {
  if (!d) return GAP;
  // _skipFee = 压根没取费用；_skipAnnual = 取了，但年费列按口径留空（变更费仍照常出值）
  if (d._skipFee) return `${GAP}(按口径未取费用)`;
  if (d.fyStatus !== 200) return `${GAP}(费用接口 ${d.fyStatus || '失败'})`;
  if (d._skipAnnual) return '等恢复·按口径未取年费';

  const status = String((d && d.anjianywzt) || (r && r.status) || '');
  const yj = (d.yingjiao || []).filter((x) => /年费/.test(String(x.zl || '')) && /未缴/.test(String(x.zt || '')));
  const zn = Array.isArray(d.zhinajin) ? d.zhinajin : [];

  // ① 等年费滞纳金 → 今天所在时间段的「年费 + 应缴滞纳金 + 总计」
  if (RE_ZNJ.test(status)) {
    if (!zn.length) return `${GAP}(状态=等年费滞纳金，但接口无滞纳金明细)`;
    const last = pickZnj(zn, TODAY);
    if (!last) return `${GAP}(状态=等年费滞纳金，滞纳金时段无法解析)`;
    const sp = last._sp;
    // 年度名称：优先按「时段结束日 = 应缴截止日 且 金额相同」匹配，其次只按金额匹配
    const byBoth = yj.find((x) => fmtDate(x.jzr) === sp.e && String(x.je) === String(last.nf));
    const byAmt = yj.find((x) => String(x.je) === String(last.nf));
    const nm = byBoth ? byBoth.zl : (byAmt ? byAmt.zl : '');   // 如「实用新型专利第6年年费」
    return (nm ? `${nm} ` : '') + `${last.nf}元 + 滞纳金${last.zn}元 = 总计${last.zj}元`
      + (sp.e ? `（时段 ${sp.s}~${sp.e}）` : '');
  }

  // ② 专利权维持 → 最近的年费应缴费信息（未缴年费中截止日最早的一条）
  if (RE_WEICHI.test(status)) {
    if (!yj.length) return '无未缴年费';
    const cur = yj.slice().sort((a, b) => String(a.jzr || '').localeCompare(String(b.jzr || '')))[0];
    return `${cur.zl} ${cur.je}元 截止${fmtDate(cur.jzr)} 未缴`;
  }

  // ③ 其余状态：最近的未缴年费 + 滞纳金条数
  let s;
  if (!yj.length) s = '无未缴年费';
  else {
    const cur = yj.slice().sort((a, b) => String(a.jzr || '').localeCompare(String(b.jzr || '')))[0];
    s = `${cur.zl} ${cur.je}元 截止${fmtDate(cur.jzr)} 未缴`;
  }
  const n = zn.length || d.zhinajinN || 0;
  if (n > 0) s += `；滞纳金 ${n} 条`;
  return s;
}

/** 一年内是否交过变更费（著录事项变更费） */
function zhuluCell(d) {
  if (!d) return GAP;
  // ★ 只省年费、变更费照查（用户 2026-09-15 澄清）：_skipAnnual 不影响本列
  if (d._skipFee) return GAP;                 // 压根没取费用才缺口
  if (d.fyStatus !== 200) return `${GAP}(费用接口 ${d.fyStatus || '失败'})`;
  if (!Array.isArray(d.yijiao)) return GAP;
  const cut = Date.parse(TODAY) - ZHULU_DAYS * 86400000;   // 基准日 = TODAY（--as-of 可锁定）
  const hit = d.yijiao.filter((x) => /著录事项变更/.test(String(x.zl || '')) && (() => {
    const t = Date.parse(fmtDate(x.rq)); return !isNaN(t) && t >= cut;
  })());
  return hit.length ? `是(${hit.map((x) => fmtDate(x.rq)).sort().pop()})` : '否';
}

const rightsCell = (list, st) => {
  if (st !== 200) return `${GAP}(${st || '失败'})`;
  if (!Array.isArray(list)) return GAP;
  return list.length ? `是(${list.length})` : '否';
};

/** 档案模板的质押列（★ 2026-09-16：带注销状态）
 *  否 / 是(N) / 是(N，已注销 2025-08-18) / 是(N，其中1笔已注销) */
function zyCell(d) {
  if (!d) return GAP;
  if (d.zyStatus !== 200) return `${GAP}(${d.zyStatus || '失败'})`;
  if (!Array.isArray(d.zyList)) return GAP;
  if (!d.zyList.length) return '否';
  const zs = zyState(d);
  if (zs.code === 'gap') return `是(${d.zyList.length})·注销状态${GAP}`;
  const dt = (d.zyDetail || []).map((x) => x.zhuxiaosxr).filter(Boolean).sort();
  if (zs.code === 'cancelled') return `是(${zs.n}，已注销${dt.length ? ` ${dt[dt.length - 1]}` : ''})`;
  if (zs.code === 'mixed') return `是(${zs.n}，其中${zs.zx}笔已注销)`;
  return `是(${zs.n})`;
}

/** 当期年费金额 + 当期截止日 + 时段原文（年费查询模板用）。
 *  按 feeCell 的判定逻辑提取，避免再渲染长文本。
 *  ★ 用户 2026-09-15 23:46：年费查询的「年费」列要 **年费 + 滞纳金 的总和**
 *    （等年费滞纳金状态取滞纳金明细里 `zj`）。
 *  ★ 用户 2026-09-15 23:59（对齐标准答案表）：
 *    - 取「缴费时段包含今天」的那一段（`pickZnj`），不再取最晚段；
 *    - 返回值多带 `span`（时段原文，如 `2026年08月18日到2026年09月15日`），
 *      `due` 保持 `YYYY-MM-DD`（该段结束日），供不同模板各取所需。 */
const numSum = (...vs) => {
  const nums = vs.map((v) => Number(String(v == null ? '' : v).replace(/[^\d.]/g, '')))
    .filter((n) => Number.isFinite(n));
  return nums.length ? String(nums.reduce((a, b) => a + b, 0)) : '';
};
function feeForYearfee(r, d) {
  if (!d) return { fee: '', due: '', span: '' };
  if (d._skipFee || d._skipAnnual) return { fee: '', due: '', span: '' };
  if (d.fyStatus !== 200) return { fee: '', due: '', span: '' };
  const status = String(d.anjianywzt || r.status || '');
  if (RE_ZNJ.test(status)) {
    const zn = Array.isArray(d.zhinajin) ? d.zhinajin : [];
    const cur = pickZnj(zn, TODAY);
    if (!cur) return { fee: '', due: '', span: '' };
    const total = String(cur.zj || '').trim() || numSum(cur.nf, cur.zn);
    return { fee: total, due: cur._sp.e || '', span: cur._sp.raw || '' };
  }
  const yj = (d.yingjiao || []).filter((x) => /年费/.test(String(x.zl || '')) && /未缴/.test(String(x.zt || '')));
  if (!yj.length) return { fee: '', due: '', span: '' };
  const cur = yj.slice().sort((a, b) => String(a.jzr || '').localeCompare(String(b.jzr || '')))[0];
  return { fee: cur.je || '', due: fmtDate(cur.jzr), span: '' };
}

/** 质押状态（★ 2026-09-16 新增「注销」判定）
 *  返回 { code:'none'|'active'|'cancelled'|'mixed'|'gap', n } 
 *  'gap' = 有质押登记但详情没抓到 —— 区别于「没有」 */
function zyState(d) {
  if (!d) return { code: 'gap' };
  if (!Array.isArray(d.zyList)) return { code: 'gap' };
  if (!d.zyList.length) return { code: 'none' };
  if (!Array.isArray(d.zyDetail) || !d.zyDetail.length) return { code: 'gap' };
  const n = d.zyDetail.length;
  const zx = d.zyDetail.filter((x) => x.cancelled).length;
  if (zx === n) return { code: 'cancelled', n, zx };
  return { code: zx ? 'mixed' : 'active', n, zx };
}

/** 分案-质押-许可（★ 年费查询模板口径：用户 2026-09-15 标准答案表原话）
 *  「没有」/「有质押，但已注销」 */
function rightsPlain(r, d) {
  if (!d) return GAP;
  if (r && r.found === false) return '未查到';
  const sqOk = d.sqStatus === 200, zyOk = d.zyStatus === 200, xkOk = d.xkStatus === 200;
  if (!sqOk || !zyOk || !xkOk) return GAP;
  const zs = zyState(d);
  if (zs.code === 'gap') return `${GAP}(质押详情未取到)`;
  const parts = [];
  if (d.fenantjr) parts.push('有分案');
  if (zs.code === 'active') parts.push('有质押');
  if (zs.code === 'mixed') parts.push(`有质押（其中${zs.zx}笔已注销）`);
  if (zs.code === 'cancelled') parts.push('有质押，但已注销');
  if (Array.isArray(d.xkList) && d.xkList.length) parts.push('有许可');
  return parts.length ? parts.join('，') : '没有';
}

// ── 列定义（★ 唯一来源，按 TEMPLATE 二选一） ──────────────────────────
const COLUMNS_DOSSIER = [
  ['序号', (_r, _d, i) => i + 1],
  ['专利号', (r) => r.appno],
  ['专利名称', (r, d) => (d && d.zhuanlimc) || r.name || ''],
  ['申请人', (r, d) => r.applicant || (d && d.shenqingrxm) || ''],
  ['申请日', (r, d) => fmtDate(r.date || (d && d.shenqingr) || '')],
  ['案件状态', (r, d) => (d && d.anjianywzt) || r.status || ''],
  ['专利类型', (r) => r.typeName || ''],
  ['分案提交日', (r, d) => (!d || d.sqStatus !== 200 ? GAP : (d.fenantjr ? fmtDate(d.fenantjr) : '(无)'))],
  ['年费信息', (r, d) => feeCell(r, d)],
  ['有无手续合格通知书', (r, d) => (!d || d.fwStatus !== 200 ? GAP : noticeCell(d.fwList, RE_SHOUXU))],
  ['有无保全程序开始通知书', (r, d) => (!d || d.fwStatus !== 200 ? GAP : noticeCell(d.fwList, RE_BAOQUAN))],
  ['是否有专利质押', (r, d) => zyCell(d)],
  ['是否有许可', (r, d) => (!d ? GAP : rightsCell(d.xkList, d.xkStatus))],
  ['一年内是否交过变更费', (r, d) => zhuluCell(d)],
  // ★ 2026-10-07 新增两列（用户截图「发文信息」区：通知书发文行 + 专利证书区块）
  ['办理登记手续通知书发文日', (r, d) => dengjiCell(d)],
  ['专利证书发文日', (r, d) => zhuanlizsCell(d)],
];

/** ★ 年费查询 6 列（★ 用户 2026-09-15 给的标准答案表 `江西创导…-年费查询.xlsx` 的结构）：
 *  序号 / 专利号 / 专利名称 / 年费 / 年费截止日 / 分案-质押-许可
 *  - **专利号**：13 位无 `CN` 前缀（库里的原生写法），不带校验位点
 *  - **年费**：等年费滞纳金 → 今天所在时段的总计（年费+滞纳金）；专利权维持 → 当期应缴年费
 *  - **年费截止日**：等年费滞纳金 → 该时段（`2026/8/18到2026/9/15`）；
 *                   专利权维持 → `2027/12/22`
 *                   ★ 2026-09-18 起统一为模板写法 `YYYY/M/D`（斜杠 + 去前导零）
 *  - **分案-质押-许可**：`没有` / `有质押，但已注销` */
const COLUMNS_YEARFEE = [
  ['序号', (_r, _d, i) => i + 1],
  ['专利号', (r) => r.appno],
  ['专利名称', (r, d) => (d && d.zhuanlimc) || r.name || ''],
  ['年费', (r, d) => (() => { const x = feeForYearfee(r, d); return x.fee; })()],
  ['年费截止日', (r, d) => (() => { const x = feeForYearfee(r, d); return fmtSlash(x.span || x.due); })()],
  ['分案-质押-许可', (r, d) => rightsPlain(r, d)],
];

/** ★ merged 17 列（★ 用户 2026-09-18 给的模板 `广西维智网-专利年费查询.xlsx` A1:P1 顺序）：
 *  年费查询 6 列 + 档案的「通知书×2 / 质押 / 许可」4 列 + 「申请人/申请日/案件状态/专利类型/
 *  分案提交日/年费信息」6 列 —— 把原来两张表合并成一张交付表。
 *  取值函数直接**复用**上面两个模板（不复制逻辑），改一处两边同步。
 *  ★ 用户 2026-09-18 追加：第 17 列「一年内是否交过变更费」（模板里没有，但用户要求保留）。 */
const COLUMNS_MERGED = [
  ...COLUMNS_YEARFEE,
  ['有无手续合格通知书', COLUMNS_DOSSIER[9][1]],
  ['有无保全程序开始通知书', COLUMNS_DOSSIER[10][1]],
  ['是否有专利质押', COLUMNS_DOSSIER[11][1]],
  ['是否有许可', COLUMNS_DOSSIER[12][1]],
  ['申请人', COLUMNS_DOSSIER[3][1]],
  ['申请日', COLUMNS_DOSSIER[4][1]],
  ['案件状态', COLUMNS_DOSSIER[5][1]],
  ['专利类型', COLUMNS_DOSSIER[6][1]],
  ['分案提交日', COLUMNS_DOSSIER[7][1]],
  ['年费信息', COLUMNS_DOSSIER[8][1]],
  ['一年内是否交过变更费', COLUMNS_DOSSIER[13][1]],   // ★ 用户 2026-09-18：保留（第 17 列，模板里没有）
  // ★ 2026-10-07：追加两列 → merged 由 17 列变 19 列
  ['办理登记手续通知书发文日', COLUMNS_DOSSIER[14][1]],
  ['专利证书发文日', COLUMNS_DOSSIER[15][1]],
];

const COLUMNS = { merged: COLUMNS_MERGED, dossier: COLUMNS_DOSSIER, yearfee: COLUMNS_YEARFEE }[TEMPLATE];

/** 分布统计只挑「有汇总价值」的列（列下标），避免合并表 17 列全打印刷屏 */
const STAT_IDX = {
  merged: [3, 5, 6, 7, 8, 9, 12, 13, 16, 17, 18],   // 年费 / 分案-质押-许可 / 通知书×2 / 质押 / 许可 / 案件状态 / 专利类型 / 一年内变更费 / ★两列发文日
  dossier: [8, 9, 10, 11, 12, 13, 14, 15],      // 年费信息 / 通知书×2 / 质押 / 许可 / 一年内变更费 / ★两列发文日
  yearfee: [3, 4, 5],                   // 年费 / 年费截止日 / 分案-质押-许可
}[TEMPLATE];

const cell = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

if (!existsSync(ROWS)) { console.error(`✗ 找不到 ${ROWS}`); process.exit(3); }
const rows0 = JSON.parse(readFileSync(ROWS, 'utf8'));
const detail = existsSync(DETAIL) ? JSON.parse(readFileSync(DETAIL, 'utf8')) : {};
if (!existsSync(DETAIL)) console.warn(`⚠️ 未找到 ${DETAIL}，本次只导出检索到的基础信息（其余列标数据缺口）`);

// ── 输出过滤（★ 用户 2026-09-15 23:35 更新：法律状态授权与否无所谓，按「案件状态」过滤）──
// 默认只输出案件状态为「专利权维持」或「等年费滞纳金」的行；
// --all-rows 解锁全量；--status-filter "专利权维持,等年费滞纳金" 自定义关键词（逗号分隔、包含匹配）
const STATUS_FILTER = argv.includes('--all-rows') ? null : opt('status-filter', '专利权维持,等年费滞纳金');
let rows = rows0;
if (STATUS_FILTER) {
  const kws = STATUS_FILTER.split(',').map((s) => s.trim()).filter(Boolean);
  const statusOf = (r) => {
    if (r.found === false) return '';
    const d = detail[String(r.appno)];
    if (d && d.sqBizCode) return '';
    return String((d && d.anjianywzt) || r.status || '');
  };
  const kept = rows0.filter((r) => kws.some((k) => statusOf(r).includes(k)));
  const byKw = kws.map((k) => `${k}=${rows0.filter((r) => statusOf(r).includes(k)).length}`).join(' / ');
  console.log(`[过滤] 案件状态含 [${kws.join('/')}]：${rows0.length} 行 → 保留 ${kept.length} 行（${byKw}）`
    + `\n       --all-rows 可输出全量；--status-filter "关键词1,关键词2" 可改过滤关键词`);
  rows = kept;
}

const lines = [COLUMNS.map(([h]) => h).map(cell).join(',')];
// 检索不到的号：从第几列开始标「未查到」（基础信息列数：dossier 前 6 列 / merged·yearfee 前 3 列）
const UNKNOWN_FROM = TEMPLATE === 'dossier' ? 7 : 3;
rows.forEach((r, i) => {
  let d = r.found === false ? null : detail[String(r.appno)];
  // 库中无此号（sqxx 业务码 20101「著录项目信息不存在」）→ 按「未查到」处理，不当时有数据
  if (d && d.sqBizCode) d = null;
  const vals = COLUMNS.map(([, get], j) => {
    if ((r.found === false || (detail[String(r.appno)] || {}).sqBizCode) && j >= UNKNOWN_FROM) return '未查到';
    return get(r, d, i);
  });
  lines.push(vals.map(cell).join(','));
});

mkdirSync(dirname(OUT), { recursive: true });
const payload = (BOM ? '\ufeff' : '') + lines.join('\r\n') + '\r\n';
// ★ 写入兜底（2026-09-15 实测）：CSV 若被 Excel / 预览面板打开会 EBUSY 写不进去。
//   先重试几次，仍失败就落到「同名-new.csv」并在汇报里说明，绝不静默丢失结果。
let REAL_OUT = OUT;
let wrote = false;
for (let i = 0; i < 5 && !wrote; i++) {
  try { writeFileSync(OUT, payload, 'utf8'); wrote = true; }
  catch (e) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!wrote) {
  REAL_OUT = OUT.replace(/\.csv$/i, '') + '-new.csv';
  writeFileSync(REAL_OUT, payload, 'utf8');
  console.warn(`⚠️ ${OUT} 被占用（EBUSY，通常是该 CSV 正被 Excel/预览打开），已改写到 ${REAL_OUT}`);
}

// ── 汇报 ──────────────────────────────────────────────────────────────
const notFound = rows.filter((r) => r.found === false).length;
const gapRows = rows.filter((r) => r.found !== false && !detail[String(r.appno)]);
const stat = {};
rows.forEach((r, i) => {
  const d = r.found === false ? null : detail[String(r.appno)];
  STAT_IDX.forEach((j) => {
    const [h, get] = COLUMNS[j];
    let v = get(r, d, i);
    v = String(v).replace(/\(.*$/, '');      // 「有(日期)」→「有」
    stat[`${h}=${v}`] = (stat[`${h}=${v}`] || 0) + 1;
  });
});

const TPL_DESC = { merged: '合并表 19 列（年费查询 + 专利档案 + 一年内变更费 + 两列发文日）', dossier: '专利档案 16 列', yearfee: '年费查询 6 列' };
console.log(`[模板] ${TEMPLATE}（${TPL_DESC[TEMPLATE]}）`);
console.log(`[基准日] ${TODAY}${AS_OF ? '（--as-of 指定）' : '（系统当天；滞纳金按此日取「包含该日的时段」，--as-of YYYY-MM-DD 可锁定）'}`);
console.log(`[列] ${COLUMNS.length} 列：${COLUMNS.map(([h]) => h).join(' / ')}`);
console.log(`[输出] ${REAL_OUT}`);
console.log(`[结果] 共 ${rows.length} 行${notFound ? `（检索不到 ${notFound} 条，各项标「未查到」）` : ''}`
  + `${gapRows.length ? `；无详情数据 ${gapRows.length} 条（标「数据缺口」）` : ''}`);
console.log('[分布]');
Object.entries(stat).forEach(([k, v]) => console.log(`   ${k} → ${v}`));

if (SHOW > 0) {
  // 按当前模板动态出预览表头
  console.log('\n' + COLUMNS.map(([h]) => h).join(' | '));
  rows.slice(0, SHOW).forEach((r, i) => {
    const d = r.found === false ? null : detail[String(r.appno)];
    console.log(COLUMNS.map(([, get], j) => {
      const v = (r.found === false && j >= UNKNOWN_FROM) ? '未查到' : get(r, d, i);
      return String(v).slice(0, 24);   // 截断避免破坏对齐
    }).join(' | '));
  });
  if (rows.length > SHOW) console.log(`… 另有 ${rows.length - SHOW} 条，完整内容见 CSV`);
}
