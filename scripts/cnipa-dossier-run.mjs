#!/usr/bin/env node
/**
 * 一键跑完：代理自检 → 第1步检索 → 第2步采集 → 第3步出 CSV
 *
 * 用法（参数自动分流给对应步骤）:
 *   <node> cnipa-dossier-run.mjs --name "<精确名称>"
 *   <node> cnipa-dossier-run.mjs --applicant "<精确申请人>"
 *   <node> cnipa-dossier-run.mjs --appno-file 号码.txt
 *
 *   ★ 默认只出**一张合并表**：专利年费查询.csv（17 列 = 年费查询 + 专利档案 + 一年内变更费，2026-09-18 起）。
 *     要拆开或换格式：--template merged|dossier|yearfee（单模板时才会用 --out）。
 *
 *   检索参数: --name / --applicant / --appno / --appno-file / --types / --size
 *             --applicant-mode part|full / --name-mode exact|contains
 *   采集参数: --gap --batch --batch-gap --cooldown --short-rounds --ban-wait
 *             --max-waits --max-min --limit --retry --no-fee --force-fee --no-rights --no-fawen --fresh
 *   出表参数: --zhulu-days --show --no-bom --template --out --as-of --status-filter
 *
 * 中间产物固定写在工作目录：rows.json / detail.json，最终 CSV 按 --template 定名（或 --out 指定）。
 * 中断了直接重跑同一条命令：第 2 步自动续抓（已有详情不重抓）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLiveSession } from './cnipa-dossier-cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const NODE = process.execPath;

const VALUED = {
  search: ['--name', '--name-file', '--applicant', '--appno', '--appno-file', '--types', '--size', '--applicant-mode', '--name-mode'],
  detail: ['--gap', '--batch', '--batch-gap', '--cooldown', '--short-rounds', '--ban-wait', '--max-waits', '--max-min', '--limit', '--retry'],
  report: ['--zhulu-days', '--show', '--template', '--status-filter', '--as-of'],
};
const FLAGS = {
  detail: ['--no-fee', '--force-fee', '--no-rights', '--no-fawen', '--fresh'],
  report: ['--no-bom', '--all-rows'],
};

/** 把命令行参数按归属分装成三组（带值的参数连它的值一起搬） */
function split(argv) {
  const out = { search: [], detail: [], report: [] };
  let outPath = '';                              // 空：让 report 脚本按 --template 默认
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { outPath = argv[i + 1] || ''; i++; continue; }
    let placed = false;
    for (const grp of ['search', 'detail', 'report']) {
      if ((VALUED[grp] || []).includes(a)) { out[grp].push(a, argv[i + 1]); i++; placed = true; break; }
      if ((FLAGS[grp] || []).includes(a)) { out[grp].push(a); placed = true; break; }
    }
    if (!placed) console.warn(`[提示] 未识别参数 ${a} 已忽略`);
  }
  return { ...out, outPath };
}

const run = (script, args) => spawnSync(NODE, [resolve(HERE, script), ...args], { stdio: 'inherit' }).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const healthOk = async () => {
  try {
    const h = await (await fetch('http://127.0.0.1:3456/health', { signal: AbortSignal.timeout(4000) })).json();
    return !!(h && h.status === 'ok');
  } catch { return false; }
};

async function ensureProxy() {
  let up = false;
  for (let i = 0; i < 3 && !up; i++) up = await healthOk();

  if (!up) {
    console.log('[0/3] 代理未就绪 → 后台启动 bsk-cdp-shim.mjs --keep-session…');
    const child = spawn(NODE, [resolve(HERE, 'bsk-cdp-shim.mjs'), '--keep-session'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    for (let k = 0; k < 60 && !up; k++) { await sleep(2000); up = await healthOk(); }
  }
  if (!up) {
    console.error('[0/3] ✗ 代理启动失败，请手动另开一个终端跑：node bsk-cdp-shim.mjs --keep-session');
    return false;
  }

  // ★ 2026-09-18：/health ok 只说明「进程活着」，**不代表会话还在**。
  //   daemon 重启 / Agent Window 被回收后 shim 会「假健康」（/targets 恒为 []），
  //   表现为「找不到可用的 cpquery 列表页标签」。这里一并修掉。
  if (!(await ensureLiveSession('http://127.0.0.1:3456', 'run'))) {
    console.error('[0/3] ✗ 代理会话不可用。手动排查：bsk session list / bsk status，');
    console.error('      或另开终端跑：node bsk-cdp-shim.mjs --keep-session');
    return false;
  }
  console.log('[0/3] 代理就绪（会话活性已确认）');
  return true;
}

(async () => {
  const g = split(argv);
  if (!g.search.some((a) => ['--name', '--name-file', '--applicant', '--appno', '--appno-file'].includes(a))) {
    console.error('用法：必须给 --name / --name-file / --applicant / --appno / --appno-file 之一');
    process.exit(1);
  }
  if (!(await ensureProxy())) process.exit(2);

  console.log('\n[1/3] 检索…');
  if (!run('cnipa-dossier-search.mjs', [...g.search, '--out', 'rows.json'])) process.exit(3);

  console.log('\n[2/3] 采集详情（可中断，重跑自动续抓）…');
  const ok = run('cnipa-dossier-detail.mjs', ['rows.json', '--out', 'detail.json', ...g.detail]);
  if (!ok) console.warn('[2/3] ⚠️ 采集未全部完成（多为接口限流），仍继续出表；未取到的项标「数据缺口」');

  console.log('\n[3/3] 出交付表…');
  // ★ 未显式给 --template 时，只出**一张合并表**（2026-09-18 用户要求：两个输出合并成一个）
  const TEMPLATES = g.report.includes('--template') ? [null] : ['merged'];
  if (TEMPLATES.length > 1 && g.outPath) {
    console.warn('[提示] 一次出多张表时 --out 不可用（会互相覆盖），已改用各模板的默认文件名；只想要一张请加 --template');
  }
  const single = TEMPLATES.length === 1;
  const made = [];
  for (const tpl of TEMPLATES) {
    const reportArgs = ['--rows', 'rows.json', '--detail', 'detail.json', ...g.report];
    if (tpl) reportArgs.push('--template', tpl);
    if (single && g.outPath) reportArgs.push('--out', g.outPath);
    if (!run('cnipa-dossier-report.mjs', reportArgs)) process.exit(4);
    made.push(resolve(process.cwd(), (single && g.outPath) || (tpl === 'dossier' ? '专利档案.csv' : '专利年费查询.csv')));
  }

  console.log(`\n✅ 完成：\n${made.map((f) => '   ' + f).join('\n')}`);
})().catch((e) => { console.error('[ERROR]', e?.message || e); process.exit(1); });
