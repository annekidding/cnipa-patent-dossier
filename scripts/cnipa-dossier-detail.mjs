#!/usr/bin/env node
/**
 * 第 2 步：逐号采集 12 项信息（详情数据抓取）
 *
 * 用法:
 *   <node> cnipa-dossier-detail.mjs [rows.json] [--out detail.json]
 *        [--gap MS=2000] [--batch N=4] [--batch-gap MS=1500]
 *        [--cooldown SEC=60] [--short-rounds N=2] [--ban-wait SEC=300]
 *        [--max-waits N=4] [--max-min M=120] [--limit M] [--fresh] [--retry N=2]
 *        [--no-fee] [--force-fee] [--no-rights] [--no-fawen]
 *
 * ★ 节奏默认值（2026-09-16 改，源于创导/同邦达实测）:
 *   默认 gap 2000 / batch 4 / batch-gap 1500 ≈「中节奏」
 *   30-300 件大批量稳态可用；要更快传 --gap 1500 --batch 5 --batch-gap 1000；
 *   撞过限流传 --gap 3000 --batch 3 --batch-gap 2500 --cooldown 90。
 *
 * ★★ 请求内即时重发（2026-09-16 加，--retry N=2）★★
 *   现象：40 件里约 10 件「首轮失败」，每批稳定 3/4；且失败很规律 —— 更像
 *   「刚开的新标签页头几次请求偶发 nginx 404」而非真限流（坑位清单第 9 条）。
 *   旧实现只在**批级**兜底（整批停 + 60/120s 冷却）→ 白等 3 分钟。
 *   现在：每个接口请求失败后**当场再发一次**（最多 --retry 次）。
 *   ⚠️ 只对「瞬时可恢复」的失败重发（HTTP 0 / -1 请求层坏 / 404 / 5xx）；
 *      **400（限流）与 401（令牌失效）绝不重发** —— 越重发越糟，交给外层批级逻辑处理。
 *   重发次数会在批次日志里以「重发 N 次」显示，便于判断是哪一类失败。
 *
 * ★★ 整批失败按状态码定性（2026-09-16 加，观察 1 的配套修正）★★
 *   整批 sqxx 全挂时**不再一律当「限流」**，按实际状态码分流：
 *     401          → 令牌失效，立即收工并提示重新登录（等下去没用）
 *     400 / 429    → 真限流，走 MAX_WAITS×BAN_WAIT 长冷却
 *     其它(404/5xx/-1) → 非限流，转短冷却软重试，**不白等十几分钟长冷却**
 *   收尾的 `[完整度]` 行会带出 `[HTTP <状态码>]` 与对应处置建议。
 *
 * 每个申请号发这些请求（默认全开）：
 *   1. POST /api/view/gn/sqxx                          → 分案提交日 fenantjr、案件状态 anjianywzt、法律状态 falvzt
 *   2. POST /api/view/gn/fwxx                          → 发文信息 data.tongzhishufw.tongzhishufwList[]
 *                                                        （tongzhismc 通知书名称 / fawenr 发文日）
 *                                                        ★ 2026-10-07：同时把 data 下**每个**含数组的
 *                                                        节点抓进 fwNodes[]（{node, list}）——
 *                                                        页面「发文信息」下「专利证书」是**独立折叠区块**，
 *                                                        节点名未实测锁定，故一律不写死、全抓。
 *                                                        新增列「专利证书发文日」由此而来。
 *   3. POST /api/view/gn/get-zlqzydjh-list  nodeId=aj_gk_zlqzy  → 专利权质押登记
 *   4. POST /api/view/gn/get-ssxkbah-list   nodeId=aj_gk_ssxkba → 专利实施许可备案
 *   5. POST /api/view/gn/fyxx                          → 年费（应缴/已缴）+ 应缴滞纳金明细
 *                                                        zhinajin.svZnjList[]{zhinajdqnfje 当期年费,
 *                                                        zhinajjfsj 缴费时间段, zhinajyjznje 应缴滞纳金,
 *                                                        zhinajzj 总计}
 *   6. POST /api/view/gn/zlqzyxx  {zhuanlisqh, zhiyadjh}  → 质押登记详情（**仅在有质押时发**）
 *                                                        判「已注销」：zhuanliqzyzx.zhuanliqzyzxList 非空
 *
 * ★★ 年费的差异化规则（用户 2026-09-15 原话 + 同日澄清）★★
 *   - 实用新型 + 案件状态「未缴年费专利权终止，等恢复」→ **只省「年费」这一列的呈现**，
 *     写「等恢复·按口径未取年费」；★ 但 fyxx 请求照发 —— 因为「一年内是否交过变更费」
 *     共用同一接口，**变更费照查**（用户 2026-09-15 明确：「变更费照查、只省年费」）。
 *   - 发明 + 同样状态 → 年费照取。
 *   - 其余组合一律取年费。
 *   - `--force-fee` 可强制对上述实用新型也取年费；`--no-fee` 则全局都不发 fyxx
 *     （此时年费与变更费两列都只能是「数据缺口」）。
 *
 * 输出 detail.json：{ "<申请号>": { sqStatus, fwStatus, zyStatus, xkStatus, fyStatus, zyDetailStatus,
 *   fenantjr, anjianywzt, falvzt, zhuanlimc, shenqingr,
 *   fwList:[{mc,rq,fs}], fwVer:2, fwNodes:[{node,list:[{k:v}]}], zyList, xkList,
 *   zyDetail:[{bh,zhiyabh,chuzhir,zhiquanr,dengjisxr,gonggaorq,cancelled,zhuxiaosxr,zxN,bgN}],
 *   yingjiao:[{zl,je,jzr,zt}], yijiao:[{zl,je,rq}], zhinajin:[{nf,sj,zn,zj}],
 *   skippedFee:true? } }
 * ★ 可续抓：每批成功即落盘，重跑自动跳过已成功项（--fresh 强制重抓）。
 *
 * 依赖: CDP 代理 http://127.0.0.1:3456 已就绪，且**列表页**标签（chinesepatent/index）已登录。
 *       ⚠️ 只能在列表页发这些请求 —— 详情页的 axios 会在 URL 上加一次性签名，裸 XHR 过不了。
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { evalJs, probeJs, findOrOpenTab } from './cnipa-dossier-cdp.mjs';

const B = 'http://127.0.0.1:3456';
const argv = process.argv.slice(2);
const VALUED = ['--gap', '--batch', '--batch-gap', '--cooldown', '--short-rounds', '--ban-wait',
  '--max-waits', '--max-min', '--limit', '--out', '--retry'];
const opt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const IN = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && VALUED.includes(argv[i - 1]))) || 'rows.json';
const GAP = Math.max(0, parseInt(opt('gap', '2000'), 10));
const BATCH = Math.max(1, parseInt(opt('batch', '4'), 10));
const BATCH_GAP = Math.max(0, parseInt(opt('batch-gap', '1500'), 10));
const COOLDOWN = Math.max(0, parseInt(opt('cooldown', '60'), 10));
const SHORT_ROUNDS = Math.max(0, parseInt(opt('short-rounds', '2'), 10));
const BAN_WAIT = Math.max(5, parseInt(opt('ban-wait', '300'), 10));
const MAX_WAITS = Math.max(0, parseInt(opt('max-waits', '4'), 10));
const MAX_MIN = Math.max(1, parseInt(opt('max-min', '120'), 10));
const LIMIT = parseInt(opt('limit', '0'), 10);
const RETRY = Math.max(1, parseInt(opt('retry', '2'), 10));   // 每个请求最多发几次（1 = 不重发）
const OUT = opt('out', 'detail.json');
const FRESH = argv.includes('--fresh');
const NO_FEE = argv.includes('--no-fee');
const FORCE_FEE = argv.includes('--force-fee');
const NO_RIGHTS = argv.includes('--no-rights');
const NO_FAWEN = argv.includes('--no-fawen');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面内取数：按 items([{a,f,r,w}]) 顺序，请求间 gap 忙等限速
 *  retry = 每个请求最多发几次（默认 2 = 失败当场再发一次，见文件头「请求内即时重发」） */
const batchJs = (items, gapMs, retry) => `(function(items, gap, TRIES){
  var t=localStorage.getItem('ACCESS_TOKEN'), ut=localStorage.getItem('USER_TYPE');
  if(!t) return { __noToken:true };
  function wait(g){ if(g>0){ var e=Date.now()+g; while(Date.now()<e){} } }
  /** 取对象里的第一个数组（字段结构可能因类型而异，不写死键名） */
  function firstList(o){
    if(!o||typeof o!=='object') return [];
    if(Array.isArray(o)) return o;
    for(var k in o){ if(Array.isArray(o[k])) return o[k]; }
    return [];
  }
  function call(path, body){
    var x=new XMLHttpRequest(); x.open('POST', path, false);

    x.setRequestHeader('Content-Type','application/json;charset=utf-8');
    x.setRequestHeader('Authorization','Bearer '+t);
    if(ut) x.setRequestHeader('userType', ut);
    try{ x.send(JSON.stringify(body)); }catch(e){ return { __status:-1, __err:String(e.message) }; }
    if(x.status!==200) return { __status:x.status };
    try{ return { __status:200, body:JSON.parse(x.responseText) }; }
    catch(e){ return { __status:200, __parseErr:String(x.responseText||'').slice(0,200) }; }
  }
  /** ★ 2026-09-16（观察1）：请求内即时重发。
   *  只对「瞬时可恢复」的失败重发：0 网络断 / -1 请求层坏 / 404 nginx 抽风 / 5xx。
   *  ⚠️ 400（限流）与 401（令牌失效）**绝不重发** —— 越重发越糟，交外层批级逻辑。
   *  重发次数累计到 retryN，随批次一起回报，便于判断失败类型。 */
  var retryN=0;
  function isTransient(st){ return st===0 || st===-1 || st===404 || (st>=500 && st<=599); }
  function callR(path, body){
    var r=call(path, body), n=0;
    while(n < TRIES-1 && isTransient(r.__status)){ retryN++; n++; wait(gap); r=call(path, body); }
    if(n) r.__retry=n;
    return r;
  }
  var out={};
  items.forEach(function(it){
    var a=it.a, rec={};
    // 1) 申请信息 → 分案提交日 / 案件状态 / 法律状态
    var sq=callR('/api/view/gn/sqxx',{zhuanlisqh:a}); wait(gap);
    rec.sqStatus=sq.__status;
    // ★ 业务码 ≠ HTTP 码：HTTP 200 但 body.code=20101 → 「著录项目信息不存在」（号不在公开库）
    try{ var bc=(sq.body||{}).code; if(bc && bc!==200){ rec.sqBizCode=bc; rec.sqBizMsg=(sq.body||{}).msg||''; } }catch(e){}
    try{
      var zl=(((sq||{}).body||{}).data||{}).zhuluxmxx||{};
      zl=zl.zhuluxmxx||{};
      rec.fenantjr=zl.fenantjr||''; rec.anjianywzt=zl.anjianywzt||''; rec.falvzt=zl.falvzt||'';
      rec.zhuanlimc=zl.zhuanlimc||'';
      // ⚠️ sqxx 里的 shenqingr 是**申请日**不是申请人（2026-09-15 实测：值 = 2025-02-25）。
      //   申请人要看 shenqingren[].shenqingrxm（与检索行的 shenqingrxm 同一语义）。
      rec.shenqingr=zl.shenqingr||'';                 // = 申请日
      var srl=((((sq||{}).body||{}).data||{}).shenqingren||{}).shenqingrenList||[];
      rec.shenqingren=srl.map(function(x){ return { xm:x.shenqingrxm, gb:x.shenqingrgb }; });
      rec.shenqingrxm=srl.map(function(x){ return x.shenqingrxm||''; }).filter(Boolean).join(',');   // 申请人
      if(sq.__err) rec.sqErr=sq.__err;
    }catch(e){ rec.sqErr=String(e.message); }
    // 2) 发文信息 → 通知书列表 + ★ 专利证书发文日（2026-10-07 新增两列的采集侧）
    if(it.w){
      var fw=callR('/api/view/gn/fwxx',{zhuanlisqh:a}); wait(gap);
      rec.fwStatus=fw.__status;
      rec.fwVer=2;                    // ★ 版本号：报告层据此判定是否含新字段（旧的 detail.json 会自动重抓）
      try{
        var fwd=(((fw||{}).body||{}).data||{});
        // 2.1) 通知书发文（原有，保持键名不变 → 老报告脚本仍可读）
        var l=(fwd.tongzhishufw||{}).tongzhishufwList||[];
        rec.fwList=l.map(function(x){ return { mc:x.tongzhismc||'', rq:x.fawenr||'', fs:x.fawenfs||'' }; });
        // 2.2) ★★ 发文区**全节点**扫描（2026-10-07）
        //   页面「发文信息」下有多个折叠区块：通知书发文、**专利证书**、失效通知书…
        //   专利证书区块的节点名/字段名未实测锁定（bsk 未运行无法在线探），所以**不写死**：
        //   把 data 下每个「对象里含数组」的节点都抓一遍，按节点名 + 各自字段原样保留。
        //   报告层再按「节点名或条目里出现『专利证书』」+ 任一形如日期的字段来取值。
        //   代价：detail.json 略大一点；收益：站点改版/节点名不同也照样能出值。
        rec.fwNodes=[];
        // ★ 递归下探（最多 3 层）：数组直接收；对象里若含数组则以「父键.子键」命名继续。
        //   这样 data / data.x / data.x.list 三种形状都能抓到，不因站点层级变化而漏。
        function scanFwNode(prefix, val, depth){
          if(!val || typeof val!=='object' || depth>3) return;
          if(Array.isArray(val)){
            if(!val.length) return;
            rec.fwNodes.push({ node:prefix||'(root)', list:val.map(function(x){
              var o={};
              if(x && typeof x==='object'){
                for(var q in x){ var v=x[q]; if(v===null||v===undefined) continue;
                  o[q] = (typeof v==='object') ? JSON.stringify(v).slice(0,200) : String(v).slice(0,120); }
              } else { o.value=String(x).slice(0,120); }
              return o;
            })});
            return;
          }
          for(var kk in val){
            var vv=val[kk];
            if(vv && typeof vv==='object') scanFwNode(prefix? prefix+'.'+kk : kk, vv, depth+1);
          }
        }
        for(var fk in fwd){ scanFwNode(fk, fwd[fk], 1); }
      }catch(e){ rec.fwErr=String(e.message); }
    }
    // 3) 质押 / 4) 许可
    if(it.r){
      var zr=callR('/api/view/gn/get-zlqzydjh-list',{zhuanlisqh:a,nodeId:'aj_gk_zlqzy',anjianbh:''}); wait(gap);
      var xr=callR('/api/view/gn/get-ssxkbah-list',{zhuanlisqh:a,nodeId:'aj_gk_ssxkba',anjianbh:''}); wait(gap);
      rec.zyStatus=zr.__status; rec.xkStatus=xr.__status;
      var zd=((zr||{}).body||{}).data, xd=((xr||{}).body||{}).data;
      rec.zyList=Array.isArray(zd)?zd:null;
      rec.xkList=Array.isArray(xd)?xd:null;
    }
    // 3.5) 质押登记详情 → 「注销」状态（★ 2026-09-16 新增，用户给的标准答案表要求区分）
    //   接口 url 就写在 zyList[i].url（/api/view/gn/zlqzyxx），
    //   ⚠️ body **必须带 zhiyadjh = 质押登记号**（就是 nodeId），否则
    //      报 code=990101「参数：【zhiyadjh】不能为空」——注意它 HTTP 仍是 200，别被糊过去。
    //   返回 data：
    //     zhuanliqzyjb.zhuanliqzyjb = {chuzhir 出质人, zhiquanr 质权人, zhiyabh 质押备案号,
    //                                  dengjisxr 登记生效日, gonggaorq 公告日}
    //     zhuanliqzyzx.zhuanliqzyzxList[] = 注销记录（非空 = 已注销，含 zhuxiaosxr 注销生效日）
    //     zhuanliqzybg.zhuanliqzybgList[] = 变更记录
    if(it.r && Array.isArray(rec.zyList) && rec.zyList.length){
      rec.zyDetail=[]; var zyDSt=200;
      rec.zyList.forEach(function(n){
        if(!n || !n.url) return;
        // 失败重发交给 callR（只补瞬时失败，见 isTransient）
        var dr=callR(n.url, {zhuanlisqh:a, zhiyadjh:n.nodeId}); wait(gap);
        if(dr.__status!==200){ zyDSt=dr.__status; return; }
        var dd=((dr||{}).body||{}).data||{};
        var jb=(dd.zhuanliqzyjb||{}).zhuanliqzyjb||{};
        var zxl=(dd.zhuanliqzyzx||{}).zhuanliqzyzxList||[];
        var bgl=(dd.zhuanliqzybg||{}).zhuanliqzybgList||[];
        rec.zyDetail.push({
          bh:n.nodeId,
          zhiyabh: jb.zhiyabh||n.nodeId||'',
          chuzhir: jb.chuzhir||'', zhiquanr: jb.zhiquanr||'',
          dengjisxr: jb.dengjisxr||'', gonggaorq: jb.gonggaorq||'',
          cancelled: zxl.length>0,
          zhuxiaosxr: zxl.length? (zxl[zxl.length-1].zhuxiaosxr||'') : '',
          zxN: zxl.length, bgN: bgl.length
        });
      });
      rec.zyDetailStatus=zyDSt;
    }
    // 5) 费用信息
    if(it.f){
      var fy=callR('/api/view/gn/fyxx',{zhuanlisqh:a}); wait(gap);
      rec.fyStatus=fy.__status;
      try{
        var d=((fy||{}).body||{}).data||{};
        var yj=(d.yingjiaofei||{}).svYingjfList||[];
        rec.yingjiao=yj.map(function(x){ return { zl:x.yingjiaoffyzlmc||'', je:x.yingjiaoje||'', jzr:x.jiaofeijzr||'', zt:x.yingjiaoffyzt||'' }; });
        var yjl=(d.yijiaofei||{}).svYijfList||[];
        rec.yijiao=yjl.map(function(x){ return { zl:x.yijiaofjfzlmc||'', je:x.yijiaofjfje||'', rq:x.yijiaofjfrq||'' }; });
        // ★ 应缴滞纳金明细（2026-09-15 实测字段）：
        //   zhinajdqnfje=当期年费 / zhinajjfsj=缴费时间段("2026年08月06日到2026年09月07日")
        //   zhinajyjznje=应缴滞纳金 / zhinajzj=总计（年费+滞纳金）
        var znObj=d.zhinajin||{};
        var znl=Array.isArray(znObj.svZnjList)?znObj.svZnjList:(Array.isArray(znObj)?znObj:firstList(znObj));
        rec.zhinajin=znl.map(function(x){ return {
          nf:x.zhinajdqnfje||'', sj:x.zhinajjfsj||'', zn:x.zhinajyjznje||'', zj:x.zhinajzj||'' }; });
        rec.zhinajinN=znl.length;      // >0 即已产生滞纳金
        rec.fyTopKeys=Object.keys(d);
      }catch(e){ rec.fyErr=String(e.message); }
      if(fy.__status!==200) rec.fyErr=rec.fyErr||('HTTP '+fy.__status);
    }
    out[a]=rec;
  });
  out.__retries=retryN;     // 本批「请求内即时重发」总次数（仅瞬时失败会触发）
  return out;
})(${JSON.stringify(items)}, ${gapMs}, ${retry})`;

/** 是否算取到：sqxx 必 200；开了 w/r/f 的对应接口也要 200。
 *  ★ 取了费用的还必须有 zhinajin 数组（2026-09-15 新增滞纳金明细后，旧格式 detail.json 会自动重抓）。
 *  ★ 有质押的还必须有 zyDetail（2026-09-16 新增「注销」状态后，旧格式同样自动重抓）。 */
const isOk = (rec, need) => !!rec && rec.sqStatus === 200
  && (!need.w || (rec.fwStatus === 200 && rec.fwVer >= 2))
  && (!need.r || (rec.zyStatus === 200 && rec.xkStatus === 200))
  && (!need.r || !Array.isArray(rec.zyList) || !rec.zyList.length || Array.isArray(rec.zyDetail))
  && (!need.f || (rec.fyStatus === 200 && Array.isArray(rec.zhinajin)));

/** 「未缴年费专利权终止，等恢复」判定 */
const isRecovery = (status, typeName) => /未缴年费专利权终止/.test(String(status || ''))
  && /等恢复/.test(String(status || ''));

(async () => {
  const inPath = resolve(process.cwd(), IN);
  const outPath = resolve(process.cwd(), OUT);
  if (!existsSync(inPath)) { console.error(`[输入] 找不到 ${inPath}（请先跑第 1 步）`); process.exit(1); }
  let rows = JSON.parse(readFileSync(inPath, 'utf8'));
  if (LIMIT > 0) rows = rows.slice(0, LIMIT);

  // ★ fyxx 一律照发（变更费要用）；只有「年费这一列」按口径省掉渲染
  const items = rows.filter((r) => r && r.appno).map((r) => {
    const typeName = r.typeName || (String(r.type) === '1' ? '发明' : String(r.type) === '2' ? '实用新型' : String(r.type) === '3' ? '外观设计' : '');
    const rec = isRecovery(r.status, typeName);
    const f = !NO_FEE;                                    // --no-fee 才真的不发
    const skipAnnual = f && /实用新型/.test(typeName) && rec && !FORCE_FEE;   // 只省年费列
    return { a: r.appno, f: f ? 1 : 0, r: NO_RIGHTS ? 0 : 1, w: NO_FAWEN ? 0 : 1,
      _type: typeName, _rec: rec, _skipFee: !f, _skipAnnual: skipAnnual };
  });
  const needOf = {};
  items.forEach((x) => { needOf[x.a] = { f: !!x.f, r: !!x.r, w: !!x.w }; });
  const appnos = items.map((x) => x.a);
  const feeN = items.filter((x) => x.f).length;
  const annualN = items.filter((x) => x._skipAnnual).length;

  console.log(`[输入] ${IN} 共 ${appnos.length} 个申请号`);
  console.log(`[费用] fyxx 发 ${feeN} 个${annualN ? ` / 其中 ${annualN} 个（实用新型＋「未缴年费专利权终止，等恢复」）年费列按口径留空、变更费照查` : ''}`);
  console.log(`[预计请求] 每号 ${1 + (NO_FAWEN ? 0 : 1) + (NO_RIGHTS ? 0 : 2)} 次基础 + 年费，合计约 ${appnos.length * (1 + (NO_FAWEN ? 0 : 1) + (NO_RIGHTS ? 0 : 2)) + feeN} 次`
    + `${NO_RIGHTS ? '' : '（有质押登记的号每个登记再 +1 次，用于判定是否已注销）'}`);
  console.log(`[节奏] 间隔 ${GAP}ms，批大小 ${BATCH}，批间隔 ${BATCH_GAP}ms`);
  console.log(`[重发] 接口失败当场重发，最多 ${RETRY} 次（只对 404/5xx/-1 等瞬时失败；限流 400 与 401 不重发）`);
  if (!appnos.length) { writeFileSync(outPath, '{}', 'utf8'); console.log('[输出] 空清单'); return; }

  let h = null;
  for (let i = 0; i < 5; i++) {
    try { h = await (await fetch(B + '/health', { signal: AbortSignal.timeout(6000) })).json(); if (h && h.status === 'ok') break; } catch { /* retry */ }
    await sleep(1500);
  }
  if (!h) { console.error('[前置] 代理未就绪，请先跑 bsk-cdp-shim.mjs --keep-session'); process.exit(2); }

  // ★ 选标签页 + 探针，带自愈：标签页的请求层会整体坏掉（所有 XHR 被加 ?hHp4Kgam= 签名后
  //   Failed to load，status=-1），**重载无效、等待无效，开新标签页立刻好**（登录态共享）。
  // ★ P1-5（2026-09-16）：抽到 scripts/cnipa-dossier-cdp.mjs，detail 与 search 共用。
  const smokeBody = { zhuanlisqh: String(appnos[0] || '').replace(/[^0-9A-Za-z.]/g, '') };
  const got = await findOrOpenTab(B, smokeBody, 'detail');
  if (!got) { console.error('[前置] 找不到可用的 cpquery 列表页标签'); process.exit(2); }
  const id = got.targetId;
  let probe = got.probe;
  // 限流探针：3 连发看是否稳态
  for (let i = 0; i < 3; i++) {
    probe = await evalJs(B, id, probeJs(smokeBody.zhuanlisqh));
    console.log(`[探针 ${i + 1}/3]`, JSON.stringify(probe));
    if (probe && (probe.status === 200 || probe.status === -1)) break;
    await sleep(2500);
  }

  let detail = {};
  if (!FRESH && existsSync(outPath)) {
    try { const old = JSON.parse(readFileSync(outPath, 'utf8')); if (old && typeof old === 'object' && !Array.isArray(old)) detail = old; } catch { /* ignore */ }
  }

  // ★ 2026-09-18：detail.json 的续抓是「按号复用」的，**不认批次**。若里面含本批以外的号
  //   （最常见：在同一个工作目录里跑了另一批），会造成两件坏事：
  //     ① 进度计数虚高（实测显示「累计成功 60/20」）；
  //     ② 文件被越滚越大、下一批也跟着脏。
  //   处理：**备份**为 <name>.bak.json 后本批从空开始 —— 不删数据、也不静默混用。
  if (Object.keys(detail).length) {
    const cur = new Set(appnos);
    const foreign = Object.keys(detail).filter((k) => !cur.has(k));
    if (foreign.length) {
      const bak = outPath.replace(/\.json$/i, '') + '.bak.json';
      let saved = false;
      try { writeFileSync(bak, JSON.stringify(detail, null, 1), 'utf8'); saved = true; } catch { /* 备份失败也不能丢原文件 */ }
      console.warn(`[续抓] ⚠️ ${OUT} 里有 ${foreign.length} 个不属于本批的号（多为在同一目录跑过别的批次）`);
      console.warn(`       ${saved ? `已备份为 ${bak}` : '备份失败'}，本批从空白开始，避免计数虚高与数据混用`);
      detail = {};
    }
  }

  const pending0 = appnos.filter((a) => !isOk(detail[a], needOf[a]));
  if (appnos.length - pending0.length) console.log(`[续抓] 复用已成功的 ${appnos.length - pending0.length} 个，待抓 ${pending0.length} 个`);

  // 探针结果定性：400 = 限流中；401 = 令牌失效；-1 = 请求层坏了（已自动换过标签页仍失败）
  if (!probe || probe.status !== 200) {
    const why = probe && probe.status === 400 ? '400 = 接口限流冷却中（响应体只有空行），等 3~5 分钟重跑即可，令牌与登录态通常仍是好的'
      : probe && probe.status === 401 ? '401 = 令牌过期，请重新登录 CNIPA'
        : probe && probe.status === -1 ? '-1 = 该标签页请求层已坏且换新标签也没恢复（站点侧风控升级），等几分钟再试'
          : `连续多次未 200（最后 ${probe && probe.status}）`;
    console.error('[前置] 试探请求未通过：' + why);
    process.exit(2);
  }

  const t0 = Date.now();
  let banWaits = 0, softRounds = 0, reqs = 0, retriesAll = 0, fatal = false;
  let pending = pending0.slice();

  while (pending.length) {
    if ((Date.now() - t0) / 60000 > MAX_MIN) {
      console.log(`[停] 已运行超过 ${MAX_MIN} 分钟，主动收工。已抓的已写入 ${OUT}，重跑自动续抓。`);
      break;
    }
    const todo = pending.slice();
    let banned = false;
    for (let i = 0; i < todo.length; i += BATCH) {
      const slice = todo.slice(i, i + BATCH);
      const itemsSlice = slice.map((a) => ({ a, f: needOf[a].f ? 1 : 0, r: needOf[a].r ? 1 : 0, w: needOf[a].w ? 1 : 0 }));
      const r = await evalJs(B, id, batchJs(itemsSlice, GAP, RETRY));
      if (!r || r.__error) { console.error(`  [eval 失败] ${JSON.stringify(r).slice(0, 160)} → 本批留待下轮`); break; }
      if (r.__noToken) { console.error('[中断] 页面令牌消失，登录态可能失效'); process.exit(2); }

      reqs += slice.reduce((n, a) => n + 1 + (needOf[a].f ? 1 : 0) + (needOf[a].r ? 2 : 0) + (needOf[a].w ? 1 : 0), 0);
      let okInBatch = 0;
      for (const a of slice) {
        const rec = r[a];
        if (isOk(rec, needOf[a])) { detail[a] = rec; okInBatch++; }
        else if (!isOk(detail[a], needOf[a])) detail[a] = rec || { sqStatus: null };
      }
      writeFileSync(outPath, JSON.stringify(detail, null, 1), 'utf8');

      const done = Math.min(i + BATCH, todo.length);
      // ★ 2026-09-18：只统计**本批**的号（此前遍历 detail 全部键，遇到残留的异批数据会显示成 60/20）
      const okTotal = appnos.filter((a) => isOk(detail[a], needOf[a] || { f: false, r: false, w: false })).length;
      const rt = r.__retries || 0;
      if (rt) retriesAll += rt;
      console.log(`[${done}/${todo.length}] 累计成功 ${okTotal}/${appnos.length} | 本批 ${okInBatch}/${slice.length}`
        + `${rt ? `（请求内重发 ${rt} 次）` : ''}`);

      const sqSt = slice.map((a) => (detail[a] || {}).sqStatus);
      const sqOk = sqSt.filter((s) => s === 200).length;
      if (sqOk === 0 && slice.length) {
        // ★ 2026-09-16（观察 1 附带修正）：不再一律判「限流」，按实际状态码定性。
        //   否则 404/401 这类非限流故障也会走 MAX_WAITS×BAN_WAIT 的长冷却，白等十几分钟。
        const uniq = [...new Set(sqSt)].join('/');
        if (sqSt.some((s) => s === 401)) {
          console.log(`  ⛔ 本批 sqxx 全部失败（状态 ${uniq}）—— 令牌已失效，立即中止；请重新登录 CNIPA 后重跑`);
          fatal = true;
          break;
        }
        if (sqSt.some((s) => s === 400 || s === 429)) {
          banned = true;
          console.log(`  ⚠️ 本批 sqxx 全部失败（状态 ${uniq}）—— 限流特征，立即中止本轮，不再发任何请求`);
          break;
        }
        console.log(`  ⚠️ 本批 sqxx 全部失败（状态 ${uniq}）—— 非限流（瞬时故障或号本身问题），本轮结束，转短冷却软重试`);
        break;
      }
      if (i + BATCH < todo.length && BATCH_GAP) await sleep(BATCH_GAP);
    }

    pending = todo.filter((a) => !isOk(detail[a], needOf[a]));
    if (!pending.length) break;
    if (fatal) break;   // 401 令牌失效：等下去也没用，直接收工

    if (banned) {
      banWaits++;
      if (banWaits > MAX_WAITS) { console.log(`[停] 已用满 ${MAX_WAITS} 次长冷却仍被限流，先收工；重跑同一条命令自动续抓。`); break; }
      const wait = BAN_WAIT * banWaits;
      console.log(`[限流冷却 ${banWaits}/${MAX_WAITS}] 静默等 ${wait}s 后单发探针…`);
      await sleep(wait * 1000);
      const p = await evalJs(B, id, probeJs(pending[0]));
      console.log('  [探针]', JSON.stringify(p));
      if (p && p.status === 200) console.log('  ✅ 限流已解除，继续'); else console.log('  ✗ 仍在限流，下轮加长冷却');
    } else {
      softRounds++;
      if (softRounds > SHORT_ROUNDS) { console.log(`[停] 软重试 ${SHORT_ROUNDS} 轮后仍有 ${pending.length} 个未成功，已写入 ${OUT}`); break; }
      const wait = COOLDOWN * softRounds;
      console.log(`[软重试 ${softRounds}/${SHORT_ROUNDS}] 待补 ${pending.length} 个，冷却 ${wait}s…`);
      await sleep(wait * 1000);
    }
  }

  // 回写类型/状态/跳过标记，供报告脚本识别
  //   _skipFee    = 压根没发 fyxx（--no-fee 或接口失败）→ 年费与变更费两列都数据缺口
  //   _skipAnnual = 发了 fyxx，但年费列按口径留空 → 变更费照常出值
  items.forEach((x) => {
    if (detail[x.a]) {
      detail[x.a]._type = x._type; detail[x.a]._recovery = x._rec;
      detail[x.a]._skipFee = x._skipFee; detail[x.a]._skipAnnual = x._skipAnnual;
    }
  });

  writeFileSync(outPath, JSON.stringify(detail, null, 1), 'utf8');
  const okList = appnos.filter((a) => isOk(detail[a], needOf[a]));
  const bad = appnos.filter((a) => !isOk(detail[a], needOf[a]));
  // ★ P1-6（2026-09-16）：缺口分类自检 —— 让用户一眼看出「是续抓能补」还是「限流/令牌升级」
  const badCat = { sqDown: [], partMiss: [] };
  for (const a of bad) {
    const d = detail[a] || {};
    if (d.sqStatus !== 200) badCat.sqDown.push({ a, st: d.sqStatus });   // sqxx 自己就挂了
    else badCat.partMiss.push(a);                                        // sqxx 200 但 fw/zy/xk/fy 某个失败
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[完成] 成功 ${okList.length} / 未完成 ${bad.length}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，约 ${reqs} 次请求`
    + `${retriesAll ? ` + 请求内重发 ${retriesAll} 次` : ''}`);
  console.log(`[完整度] ${appnos.length} 件：${okList.length} 完整  ${bad.length ? '/ ' + bad.length + ' 缺口（sqxx失败 ' + badCat.sqDown.length + ' · 子接口部分缺失 ' + badCat.partMiss.length + '）' : '✅ 0 数据缺口'}`);
  if (badCat.partMiss.length) console.log(`  ↳ 续抓可补（重跑同一条命令，未落盘的接口会自动补）: ${badCat.partMiss.join(' ')}`);
  if (badCat.sqDown.length) {
    const sts = [...new Set(badCat.sqDown.map((x) => x.st))].map((s) => (s == null ? '?' : s)).join('/');
    const hint = sts.includes('401') ? '令牌失效，重新登录 CNIPA 后重跑'
      : sts.includes('400') ? '接口限流，等 3~5 分钟重跑即可'
        : '瞬时故障或号本身问题，等几分钟重跑';
    console.log(`  ↳ sqxx 失败 [HTTP ${sts}]（${hint}）: ${badCat.sqDown.map((x) => x.a).join(' ')}`);
  }
  if (bad.length) console.log('[未完成申请号]', bad.join(' '));
  console.log('[已写入]', outPath);
  console.log('\n下一步：<node> cnipa-dossier-report.mjs --rows rows.json --detail detail.json --out 专利档案.csv');

  // 抽样预览
  console.log('\n[抽样]');
  okList.slice(0, 8).forEach((a) => {
    const d = detail[a];
    console.log(`  ${a} | 分案提交日 ${d.fenantjr || '(空)'} | 发文 ${(d.fwList || []).length} 条 | 质押 ${(d.zyList || []).length} | 许可 ${(d.xkList || []).length} | 年费 ${d._skipFee ? '(未取费用)' : d._skipAnnual ? '(年费列留空)' : (d.yingjiao || []).length + '条应缴'} | 变更费 ${(d.yijiao || []).length}条记录`);
  });
})().catch((e) => { console.error('[ERROR]', e?.message || e); process.exit(1); });
