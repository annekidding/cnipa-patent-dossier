# cnipa-patent-dossier

> 专利年费**详细版** —— 给「专利号 / 专利名称 / 申请人」，查出档案级信息并导出交付 CSV

基于 [CNIPA 中国及多国专利审查信息查询](https://cpquery.cponline.cnipa.gov.cn)（cpquery）的 WorkBuddy 技能。
与精简版 [`cnipa-patent-quick`](https://github.com/annekidding/cnipa-patent-quick) **同源同链路**，是它的**上游完整档**。

---

## 定位：两档选哪个

| | **cnipa-patent-quick**（速查版） | **cnipa-patent-dossier**（本仓库，详细版） |
|---|---|---|
| 每号请求 | **2 次**（sqxx + fyxx） | 5~6 次（含分案/发文/质押/许可/费用） |
| 输出 | 固定 **4 列** | **19 列**合并交付表（另有 16 / 6 列模板） |
| 默认过滤 | 不过滤 | 只出「专利权维持/ 等年费滞纳金」两类 |
| 适用 | 「这批号现在该交多少钱、什么时候到期」 | 「查一下这些专利的档案 / 尽调信息」 |

**选速查版**：只要年费和截止日，且批量大。
**选详细版**：要质押、许可、分案、通知书、变更费、发文日等档案级信息。

---

## 核心特性

### 三种输入，一个链路

```
输入（专利号 / 名称 / 申请人）
  → ① 检索（完全相等过滤）
  → ② 逐号采集（分案/发文/质押/许可/费用）
  → ③ 合成出表（19 列 CSV，带 BOM）
```

**不做筛选** —— 命中的专利全部输出，便于对账。**不取手机号**，因此只需 cpquery 一套登录态。

### 三种输出模板

`--template merged|dossier|yearfee`，**默认 `merged`**（只出一张表）：

| 模板 | 列数 | 适用 |
|---|---|---|
| `merged` ★默认 | **19** | 合并交付表（年费 6 列 + 档案 10 列 + 变更费 1 列 + **发文日 2 列**） |
| `dossier` | 16 | CNIPA 专利档案 |
| `yearfee` | 6 | 纯年费查询表（不含发文日） |

### ★ 2026-10-07 新增：两列发文日

| 列 | 来源 |
|---|---|
| **办理登记手续通知书发文日** | 发文信息区 `fwList` 中名称匹配「办理登记手续」那一行的 `fawenr` |
| **专利证书发文日** | 发文信息区**全节点**扫描（`fwNodes`）定位「专利证书」区块，取分数最高的节点 |

- 采集侧：发文区**全节点递归抓取**，不只取通知书表
- 报告侧：**打分定位**，都为 0 时按「唯一带发文日期、且不像通知书的节点」兜底
- 专利证书节点已实测确认：来自 `fwxx` 的 `zhuanlizsfw`，与通知书 `tongzhishufw` 并列

---

## 快速开始

```bash
# <node>  = Node.js ≥22 可执行文件的绝对路径（自查：where node && node -v）
# <skill> = 本技能目录

# 一键：出合并交付表（19 列）
<node> <skill>/scripts/cnipa-dossier-run.mjs --input "CN202422940446.4"

# 按名称 / 申请人
<node> <skill>/scripts/cnipa-dossier-run.mjs --input "一种分切机"
<node> <skill>/scripts/cnipa-dossier-run.mjs --input "某某机械厂"

# 换模板（单模板时 --out 才生效）
<node> <skill>/scripts/cnipa-dossier-run.mjs --input-file 清单.txt --template dossier --out 档案.csv

# 锁基准日（复现某天的表）
<node> <skill>/scripts/cnipa-dossier-run.mjs --input-file 清单.txt --as-of 2026-09-15
```

产物：`专利年费查询.csv`（**带 BOM**，Excel 双击不乱码）+ 中间文件 `rows.json` / `detail.json`。
**中断了直接重跑同一条命令**：采集自动续抓，已成功的号不重抓。

## 分步执行

```bash
# 0) 起 CDP 代理（另开终端常驻；一键脚本会自动后台拉起）
<node> <skill>/scripts/bsk-cdp-shim.mjs --keep-session

# 1) 检索 → rows.json
<node> <skill>/scripts/cnipa-dossier-search.mjs --input "一种分切机"

# 2) 采集 → detail.json（可中断，重跑自动续抓）
<node> <skill>/scripts/cnipa-dossier-detail.mjs rows.json

# 3) 出表
<node> <skill>/scripts/cnipa-dossier-report.mjs --rows rows.json --detail detail.json --template merged --out 专利年费查询.csv
```

## 脚本清单

| 脚本 | 作用 |
|---|---|
| `cnipa-dossier-run.mjs` | 一键：代理自检 → 检索 → 采集 → 出表 |
| `cnipa-dossier-cdp.mjs` | 公用通信层：`evalJs` / `probeJs` / `findOrOpenTab` / `ensureLiveSession` |
| `cnipa-dossier-search.mjs` | 第 1 步：三种输入检索 + 精确过滤 + 行序确定化 → `rows.json` |
| `cnipa-dossier-detail.mjs` | 第 2 步：逐号采集（含发文/分案/质押/许可/费用）→ `detail.json` |
| `cnipa-dossier-report.mjs` | 第 3 步：合成 CSV（**列定义唯一来源**） |
| `bsk-cdp-shim.mjs` | 把 bsk 包装成 CDP 兼容代理（127.0.0.1:3456），与速查版同源可直接复用 |
| `probe-fields.mjs` | **字段/接口探测器** —— 站点改版或字段缺失时用它重新探测，不要靠猜 |
| `probe-search.mjs` | 检索接口探测器：劫持 XHR 抓真实请求体 + 打印 `se.params` 全键 |

> `probe-*.mjs` 是排查工具，不是主流程的一部分。**发文接口和分案字段当初就是靠 `probe-fields.mjs` 找出来的** —— 站点改版时先跑它。

## 前置条件

1. **browser-skill（bsk）可用** —— CLI 在 `~/.local/bin/bsk.exe`，daemon 运行中且扩展已连接浏览器。自检 `bsk doctor` 全 `ok`。
2. **Node.js ≥ 22** —— 用到内置 `fetch` / `AbortSignal.timeout`。
3. **cpquery 登录态** —— 判据为列表页 `localStorage.ACCESS_TOKEN` 存在且未过期。token 约 **8~10 小时**过期，
   过期需**重新登录**，且要登在 **bsk 的 Agent Window** 里。**只需 cpquery 这一套登录态**。

---

## 关键口径

### 滞纳金取段

CNIPA 从宽限期末一路排到缴费截止日，滞纳金逐月递增（每月 +5%），
取「**缴费时段包含今天**」那一段的**总计**（当期年费 + 滞纳金），截止日写该时段原文。
`--as-of YYYY-MM-DD` 可锁基准日复现某天的表。

### 质押注销判据

判「已注销」**必须再查质押登记详情**，不能只看主表状态位。

### 「查不到」与「确实没有」严格分开

取不到接口一律写 `数据缺口`，**绝不静默当0**。

---

## 安全与合规说明

- 脚本**不做任何认证绕过**：所有请求带 `Authorization: Bearer <localStorage.ACCESS_TOKEN>`，即用户**本人合法登录的会话**
- `ACCESS_TOKEN` **只在浏览器上下文内使用**，不外传、不落盘、不写入任何输出文件
- 无 `eval`、无文件删除、无第三方外网请求；命令执行**一律不经 shell**（无命令注入面）
- 唯一的环境变量读取是 `process.env.BSK_BIN`，仅用于定位 bsk 可执行文件
- 仅访问 CNIPA **公开查询系统** `cpquery.cponline.cnipa.gov.cn`，不触碰专利业务办理系统 / 票据系统
- 探针脚本（`probe-*.mjs`）仅在你主动调用时才会对站点发请求

**请遵守 CNIPA 站点的使用条款，仅将本技能用于你有合法访问权限的查询场景。**

## License

[MIT](LICENSE) © 2026 annekidding
