# 「B站每日必看」浏览器扩展 · 独立 QA 验收报告（v0.2.0 · 最终验收 v3.2）

- **报告日期**：2026-10-21 02:34（Asia/Shanghai）；本文件为 **v3.2（v0.2.0 + 全部 7 项 P3 修复闭环）**，历史版本见 §9
- **工作目录**：`<workspace>`（Windows / PowerShell 5.1，Node v24.14.0，npm 11.9.0）
- **审核人**：QA（独立于实现方；只读代码审查 + 命令验证 + 截图审查；未修改 `src/**`、`tests/**`、`README.md`、配置，未执行 build / 未启动浏览器）
- **验收基线**：v0.2.0 修复后最终工作树（`package.json` / `manifest.json` version = **0.2.0**；HEAD = `e9b086a` v0.1.1 + v0.2.0 未提交改动，共 60 项工作树变更，含 4 张新截图与 `artifacts/live-acceptance-v0.2.0.json`）；`dist/` 由 Lead 于 02:28:47 重建（晚于全部源码最后改动 02:28:36），e2e 于 **02:31:47** 重跑、截图刷新（02:31:14–02:31:40）均针对该最终产物
- **本轮范围**：v0.2.0 四项新能力（账号卡 / 只读兴趣信号 / 周报 / 数据备份）+ 既有功能回归 + 隐私/域名 + README；以及 D-01~D-07 七项 P3 的最终修复复核
- **结论速览**：**PASS（通过验收，0 FAIL）**。自动化全绿（typecheck 0 错误、**17 文件 / 206 单测**、probe **10/10**、validate-dist **6/6**、e2e **56/56**、SW 直连 code=0）。**D-01~D-07 七项 P3 已全部修复并经 QA 复核闭环**（D-01 生成式总结文案本轮补齐，周报截图已刷新为「该周」）；**无残留 P3、无 P0/P1/P2、无新缺陷**。真实登录态能力需用户在本机验证（§6），其余为 §7 观察/建议项。

---

## 1. 环境与命令执行结果（QA 实跑；未 build、未跑浏览器）

| # | 命令 | 结果 | 关键数据 |
|---|---|---|---|
| 1 | `npm run typecheck` | ✅ PASS（exit 0） | `tsc -p tsconfig.json --noEmit` 无错误 |
| 2 | `npm test` | ✅ PASS（exit 0） | **17 个文件 / 206 个用例全部通过**（1.18s）；含 D-02/D-06 两个备份安全/截断用例；`weekly.test.ts` 断言已同步「该周观看 6 个视频」并通过 |
| 3 | `npm run build` | ⏸ 按 Lead 要求未由 QA 执行 | 以 Lead 最终构建为准：`dist/` 02:28:47 重建（晚于源码最后改动 02:28:36）；`dashboard-dvDVDIr_.js 307,386 B`（≈307KB）、`mock-ChBNL9k6.js 335,277 B`（≈335KB）、`dashboard-By0eHghW.css 43,688 B`（≈43.68KB）、`background.js 184,870 B` |
| 4 | `npm run probe` | ✅ PASS（exit 0） | 匿名契约 **10/10 通过**（5.19s，共 18 次请求）：nav（loggedIn=false/hasWbi=true）、热门 20、全站榜 100、每周必看第 395 期 50 条、相关推荐 40 / 标签 10、匿名历史 -101；**「收藏/关注/稍后再看端点可达且未登录安全」**（favFolders/favResources ok(null)，followings/watchLater -101） |
| 5 | `node artifacts/validate-dist.mjs` | ✅ PASS（exit 0） | `dist/manifest.json` 合法 MV3、version=**0.2.0**；资源 `dashboard-dvDVDIr_.js` / `dashboard-By0eHghW.css` 齐全；**65 个 data-testid**（产物出现 79 次）；**17 个 background 关键标记**；content 7 个标记 |
| 6 | `npm run e2e` | ⏸ 未由 QA 重跑（沙箱无法启动浏览器） | 采信 Lead 最终重跑的 `artifacts/e2e-summary.json`：**56/56 PASS、0 fail、0 skip**（`at=2026-10-21T02:31:47+08:00`）；10 张截图路径全部存在且已刷新（02:31:14–02:31:40）；`swDirectFetch {ok:true, status:200, code:0}` |
| 7 | 截图人工审查（`read_image`） | ✅ 完成 | dashboard-weekly（**该周共观看/该周活跃**已确认）、dashboard-tags-signals（收藏/关注面板）、dashboard-settings-backup、live-today、live-weekly-empty（§5） |

### 1.1 e2e 覆盖核对（56 项，与验收条目对应）

- **账号卡**：已登录态（`data-testid=account-card` / `account-status=已登录` / Hero 昵称「星海旅人」）；「刷新登录状态」生效（`data-checked-at` 1792519868256 → 1792520169795）；mock loggedout 场景「登录已失效（含上次登录）」且 Hero 刷新仍保持未登录。
- **兴趣信号**：标签页信号面板（`signal-stat=3`、`favorite-up=10`、`followed-up=10`、`watchlater-tag=8`）；收藏兼容模式（`?mock=fallback=1` → 「兼容模式：前 3 个收藏夹」）。
- **周报**：页面渲染（概览 4 项、7 日趋势、标签 12 个、上升/下降各 5、`weekKey=2026-10-12` / label「2026 年 10 月 12 日 – 10 月 18 日」）；周切换（10-12 → 10-05 且 label 同步变化）；mock empty 空态。
- **备份**：导出触发下载且 schema 合法（`bili-daily-picks-backup-20261021-0216.json`，200,968 B）；导入二次确认→摘要（历史 1 / 快照 0 / 推荐 1 天 / 周报 0 / 拉黑 1 / 画像无）；导入后设置回读（perSection=4、regionSections=4、updateHour=5、theme=浅色）；**非法内容失败且不覆盖已有数据**；**>20MB 超限备份被拒绝**；导入后再导出往返一致；**清空数据会暂停自动更新并移除每日闹钟**；清空后导出为空备份。
- **扩展真机**：Service Worker 启动、全部消息路由（新增 `GET_DASHBOARD_DATA.account`、`REFRESH_ACCOUNT`、`GET_WEEKLY_REPORT`、`EXPORT_BACKUP`、`IMPORT_BACKUP`）、`SET_SETTINGS` 回读、`chrome.tabs.query(url)` 可用、闹钟注册（`pipeline-tick` 每分钟 + `daily-update` 05:00）、SW 直连 api.bilibili.com `code=0`。
- **内容脚本（真实 bilibili.com）**：悬浮入口、点击打开仪表盘、关闭记忆、外部域名 `API_FETCH` 被拒。
- **既有回归**：mock 五页（今日必看 16 卡 / 增长角标 16 / 分区 5×3 / 标签 25）、三态、立即更新进度+toast、0 条 JS console error。

### 1.2 真实公开模式流水线（v0.2.0）

- **已落盘证据**（`artifacts/live-acceptance-v0.2.0.json`，新增于 02:24:27，QA 已读取核对）：`mode=public`、`account.loggedIn=false`、**`candidates=163`**、**`requests=84`**、**`durationMs=58957`（≈58.957 秒）**；sections = 今日必看 6 + 游戏 2 + 知识 3 + 生活 2 + 音乐 2 + 增长榜 6 = **21 条推荐 / 4 个分区板块**（与 `live-today` 截图「4 个分区 · 21 条推荐」完全一致）；`weeklyReport=null`、`weeklyReports=0`、`signalsSkipped=true`；`degraded=「分区排行榜触发风控，已跳过；每周必看触发风控，已跳过」`。README 已链接该文件。
- 截图可交叉验证：`live-today-1440x900.png` 与 `live-weekly-empty-1440x900.png` 均显示「**4 个分区 · 21 条推荐**」，降级提示两条，周报页为空态（未登录不生成周报），标签/信号不可用，Hero 显示「公开模式」与「已登录？刷新 / 去登录」。
- ✅ 上一轮 D-04 的「可复核性缺口」已由该 JSON 工件闭环（README 数字与工件一致）。

### 1.3 回归结论（v0.1.0 已关闭缺陷）

v0.1.0 的 D-01（分区板块同 UP 去重）、D-02（设置页板块上限 2–5）、D-03（「保存后下次生成生效」文案）修复在本轮全部保留：`sections.test.ts` 15 个用例（含 3 个同 UP 回归）全绿；`settings.ts` clamp 仍 2..5；SettingsPage 文案/上限未回归。v0.1.0 报告的 135 单测 → v0.2.0 204 → 修复后 **206**（只增不减，且本轮 206 全绿）。

---

## 2. v0.2.0 逐条验收结论

| # | 验收条目 | 结论 | 证据 |
|---|---|---|---|
| 1 | **账号卡（三种状态 / 刷新 / Hero 昵称）** | ✅ **PASS（真实登录态需用户验证）** | `AccountCard` 状态机 `account-state` = `logged-in` / `expired`（有最近登录记录）/ `logged-out`（无任何记录），三种标签分别为「已登录 / 登录已失效 / 未登录」（`AccountCard.tsx`）；展示 UID、最近检测、上次登录、检测异常；「打开 B站登录」指向 `passport.bilibili.com`（用户点击才跳转）；「刷新登录状态」→ `REFRESH_ACCOUNT`（force 绕过 nav 60s 缓存，单测覆盖）；e2e 显式覆盖已登录与登录已失效两态 + 刷新时间戳变化；全新未登录态（无 last）由首装 `GET_DASHBOARD_DATA` 场景隐含覆盖（见 O-03） |
| 2 | **收藏信号（全部收藏夹 type=1 三页×20 → 时间倒序去重 60；-400/空回退前 3 夹兼容模式）** | ✅ **PASS（真实账号需用户验证）** | `signals.ts`：`favoritePages=3 × favoritePageSize=20`、`favoriteMaxItems=60`、`fallbackFolders=3`（`constants.ts SIGNAL_CONFIG`）；`fetchFavoritePages(..., type=1, order=mtime)`；`pickFavoriteSamples` 按 `fav_time ?? mtime ?? pubtime` 倒序 + bvid 去重 + 截断；`type=1` 返回 -400 或首页空 → 逐前 3 个收藏夹各取首页并标记 `favoriteFallback`，UI 显示「兼容模式：前 3 个收藏夹」；单测 7 项覆盖（三页合并/跨页去重/无 fid=0/回退/空收藏夹/无收藏夹）；e2e mock 兼容模式通过；匿名探针端点安全 |
| 3 | **关注 / 稍后再看信号** | ✅ **PASS（真实账号需用户验证）** | 关注 2 页 × 50、按 mid 去重、最多 100 人（单测覆盖首页不满不翻页）；稍后再看 1 页 × 20，聚合分区（经 region-seed 映射一级分区）与标题标签；`-101` 静默、风控/网络失败降级或复用旧缓存（12h）；e2e mock `favorite-up=10 / followed-up=10 / watchlater-tag=8` |
| 4 | **周报（周一生成 / 幂等 / 周键与跨年 / 页面数据）** | ✅ **PASS（真实生成需用户验证）** | `weekly.ts`：本地自然周（周一 00:00），`weekKey`=周一日期，`previousCompletedWeek` 取最近已完整结束周；周一 04:00 每日更新后生成，`weekKey` 已存在则跳过（幂等），保留最近 12 份；跨年 label 两端带年份；空周报为空数组 + 空态文案。单测 16 项覆盖周窗口/跨年/统计/涨跌阈值（tagDelta 0.15、regionDelta 0.10）/上升下降各 ≤5/幂等/12 份保留/时间窗口；e2e 页面数据与周切换通过；`live-weekly-empty` 公开模式空态正确 |
| 5 | **数据备份（schema / 上限 / 坏行 dropped / 导入不覆盖非法文件）** | ✅ **PASS** | `backup.ts`：`app='bili-daily-picks'` + `schemaVersion=1` 强校验、JSON ≤20MB、history 5000 / snapshots 300000 / daily 120 / dismissed 5000 / weekly 12 上限、字段白名单+逐项清洗、坏行计入 `dropped`、不执行文件内代码/URL、不访问网络；`background.importBackup` 先按字节数检查 → parseBackup 校验 → 才 `importData`；单测 6 项（往返/旧备份缺 weeklyReports/坏行 dropped/拒绝非本扩展与版本不符与坏 JSON/越界值夹紧/文件名）；e2e 覆盖导出 schema、导入摘要、非法与超限拒绝且不覆盖、往返一致、清空后空备份；UI 明示「备份文件包含完整观看历史，且未加密；请妥善保管」 |
| 6 | **既有功能回归（推荐/标签/增长/清空/闹钟/悬浮入口/公开模式）** | ✅ **PASS** | e2e 56 项全绿（mock 五页、三态、立即更新、扩展真机消息/闹钟、内容脚本、清空暂停自动更新）；单测 **206** 全过（含 v0.1.0 全部用例）；公开模式跳过 signals 与周报有单测（「公开模式跳过 signals 阶段，不发收藏/关注/稍后再看请求」「公开模式（无历史）不生成周报」）与真实截图/工件佐证 |
| 7 | **只读 / 隐私 / 域名** | ✅ **PASS** | 全仓 grep 无 `document.cookie` / `chrome.cookies` / `localStorage` / `sessionStorage`；全部网络请求仅两处 `fetch(..., method:'GET')`（`http.ts`、`content.ts`），无 POST/PUT/DELETE/PATCH；新端点均挂在唯一 `BILI_ORIGIN=https://api.bilibili.com`；`dist/background.js`、`dist/content.js` 域名仅 `api.bilibili.com` / `www.bilibili.com`，`dist/dashboard-*.js` 新增 `passport.bilibili.com`（只是用户点击的登录页链接）；manifest 权限仍仅 `storage/alarms`、host 仅 B站两域；备份未加密提示在 UI 与 README 双处；无远程代码/统计上报。v3.1 起备份图片 URL 已白名单化（D-02 复核通过），隐私面进一步收紧 |
| 8 | **README 与实现一致（v0.2.0）** | ✅ **PASS** | 验收数字 **206 / 56 / 10**、65 testid、构建体积（307KB / 335KB / 43.68KB）、用例数演进 135→138→204→206、账号/收藏/关注/稍后再看/周报/备份/隐私/已知限制/更新记录均与代码核对一致；上一轮两条建议均已落实：**signals 12h 缓存已写入隐私说明**（`README.md:96`）、**v0.2.0 真机记录已新增并链接**（`README.md:70-72` → `artifacts/live-acceptance-v0.2.0.json`）；旧口径（「每 6 小时」「每 UP ≤1」「同 UP 刷屏」）未回归 |
| 9 | **构建与产物（v0.2.0）** | ✅ **PASS** | `dist/` 02:15:08（晚于源码最后改动 02:15:02）；validate-dist 6/6 且 manifest version=0.2.0；e2e 针对该 dist 全绿；QA 未写 dist |
| 10 | **真实登录态链路** | ⚠ **需用户验证** | 本环境无 B站账号会话：收藏需真实 `type=1` 分页/兼容模式触发、关注/稍后再看真实数据、登录后 signals 并入画像与推荐理由（「你关注的 UP 主」/「关注 UP」角标）、周报真实生成（周一或补生成）、账号刷新/切换、实测增长。详见 §6 |

> **没有 FAIL 项。** 所有可在自动化环境验证的验收条目均通过；真实登录态能力按约定列为「需用户验证」。

---

## 3. 缺陷清单（v3 提出 7 项 P3；v3.2 复核：**7 项全部已修复闭环**）

> 严重度：P0 阻断 / P1 严重 / P2 一般 / P3 轻微。QA 作用域仅 `artifacts/qa-report.md`，未改其它文件。最终复核时间 2026-10-21 02:30–02:34。

### D-01【P3 轻微｜UI 文案｜✅ **已修复**】周报页「本周」措辞与「上一自然周」口径不一致

- **复核结论（2026-10-21 02:33，最终）：已修复，QA 复核通过（源码 + 单测 + 重建产物 + 刷新截图四重核对）。**
- **修复内容（补齐轮）**：
  - `src/core/report/weekly.ts` 生成式总结：空态 `'该周没有观看记录，下周再开始吧'`（`:387`）、总结 `'该周观看 X 个视频，累计…'`（`:390`）——已由「本周」改为「该周」；
  - `src/ui/lib/mock.ts` 三处 mock 总结：`'该周共观看…'` / `'…是该周新出现的兴趣'` / `'该周活跃…'`（`:1294/1297/1300`）；
  - `tests/unit/core/weekly.test.ts:173/176` 断言同步为「该周观看 6 个视频」，**206 用例全绿**；
  - 上一轮已修复的 `WeeklyPage.tsx` 静态文案保持不变（该周观看/该周总结/空态/趋势 aria/常看 UP）。
- **复核证据**：
  1. **源码 grep**：weekly.ts / mock.ts / weekly.test.ts 的**用户文案**已无「本周」；剩余「本周」仅 3 处**代码注释**（`weekly.ts:56`、`mock.ts:1219`、`weekly.test.ts:154`，非用户可见）；`sections.ts:196` 的「本周值得一看」是分区板块副标题，与周报无关（按 Lead 说明保留）。
  2. **构建产物**：最终重建的 `dist/`（02:28:47）解码后，`background.js` 内含「该周观看」「该周没有观看记录」，无「本周观看」→ 说明修复已进入最终产物。
  3. **单测**：`npm test` 17 文件 / 206 用例全绿（weekly 16 个用例，断言已同步「该周」）。
  4. **刷新截图**：最终 e2e 重跑（02:31:47）后 `dashboard-weekly-1440x900.png`（02:31:21）已刷新，「该周总结」卡片内显示「**该周共观看 23 个视频…上一周是 17 个**」「**该周活跃 7 天**」，与日期范围（10.12–10.18）口径一致。
- **严重度理由（原）**：仅文案歧义，不影响数据计算；本轮已彻底闭环。

### D-02【P3 轻微｜安全加固｜✅ **已修复**】备份导入未校验封面/头像 URL 域名，恶意备份可让仪表盘加载任意 HTTPS 图片

- **复核结论**：**已修复，QA 复核通过。**
- **修复内容**：`src/core/store/backup.ts` 新增 `safeImageUrl`（`:72-92`）：仅接受 **https**，且 hostname 必须等于或为 `hdslb.com` / `bilibili.com` / `bilivideo.com` 的子域（`host === suffix || host.endsWith('.'+suffix)`，可拦截 `evil.com`、`hdslb.com.evil.com`、`evil-hdslb.com` 等变体）；已应用于 `owner.face`（`:192`）、`recommendation.cover`（`:231`）、`profile.avatar`（`:428`），非白名单返回空串（UI 走占位/首字母头像）。
- **回归测试**：`backup.test.ts` 新增「备份里的图片地址只允许 B站 CDN（https）」用例（evil 域被清空、合法 CDN 保留），备份测试 6→8 个，全绿。
- **残留（低）**：`sanitizeHistory.cover` 仍为 `optStr`（`:154`），但全 UI 仅 `VideoCard` 渲染 `Recommendation.cover`，历史封面从不渲染 → 当前无任何图片请求风险；建议后续顺手统一为 `safeImageUrl`（防御纵深）。
- **严重度理由（原）**：需用户主动导入恶意备份，仅图片请求元数据，无数据泄露/代码执行。

### D-03【P3 轻微｜验收工件｜✅ **已修复**】新增截图 `dashboard-tags-signals` 与 `dashboard-tags` 完全同帧

- **复核结论**：**已修复，QA 复核通过。**
- **修复内容**：`tests/e2e/run-e2e.mjs:529-535` 在截图前 `scrollIntoViewIfNeeded()` 到 `signal-favorites` 并 `window.scrollBy(0,-120)`，再截 `dashboard-tags-signals-1440x900.png`；e2e 重跑后截图已刷新。
- **复核证据（哈希已不同）**：`dashboard-tags-1440x900.png` = `8E93F475…503092`（269,620 B）；`dashboard-tags-signals-1440x900.png` = `A9C93E08…96833748`（160,683 B）；新截图可见「收藏与关注」面板（收藏/关注 UP Top10、收藏标签）及下方「稍后再看」面板标题，独立证据成立。

### D-04【P3 轻微｜可复核性｜✅ **已修复**】v0.2.0 真实公开模式流水线计数未落盘

- **复核结论**：**已修复，QA 已读取新工件核对。**
- **修复内容**：新增 `artifacts/live-acceptance-v0.2.0.json`（02:24:27）：`mode=public`、`account.loggedIn=false`、`candidates=163`、`requests=84`、`durationMs=58957`、sections=今日必看 6 + 游戏 2 + 知识 3 + 生活 2 + 音乐 2 + 增长榜 6（4 个分区板块/21 条）、`weeklyReport=null`/`weeklyReports=0`、`signalsSkipped=true`、`degraded` 两条风控说明；README 验收结果已链接该文件（`README.md:70-72`）。
- **复核证据**：README 数字（163/84/59 秒/4 分区）与工件完全一致；`live-today`/`live-weekly-empty` 截图「4 个分区 · 21 条推荐」与工件 sections 一致。旧 `artifacts/live-acceptance.json`（v0.1.0）保留但已被新工件取代。

### D-05【P3 轻微｜数据一致性｜✅ **已修复**】导入备份保留旧运行时 KV，UI「最近一次更新」等可能沿用导入前状态

- **复核结论**：**已修复，QA 复核通过。**
- **修复内容**：`pipeline.ts` 新增 `BUSINESS_KV_KEYS = [engine:requestsBase, engine:degraded, engine:weeklyIssues, engine:lastRunAt, engine:shown]`（`:63-69`）；`importAllData` 在写入导入数据前逐项 `deleteKv`（`:765-769`，注释明确「避免沿用导入前的最近更新/降级/已展示状态」），随后写设置并清 pipeline 状态。
- **说明**：`account:last`（最近成功登录账号）**有意保留**，属登录记忆而非导入业务数据，合理。
- **复核证据**：代码路径核对通过；`npm test` 中「导入空备份会清空业务数据与未完成的流水线状态」等 pipeline 用例全绿。

### D-06【P3 轻微｜数据完整性｜✅ **已修复**】备份字段超上限时静默截断，未计入 `dropped` 也未提示

- **复核结论**：**已修复，QA 复核通过（单测复现验证）。**
- **修复内容**：`backup.ts` 新增 `overflowCount(value, limit)`（`:98-101`），`parseBackup` 汇总 dropped 时加入 history/snapshots/daily/dismissed/weeklyReports 五类数组的超限截断数（`:638-642`），与坏行一起通过 `ImportSummary.dropped` 返回并在 UI 摘要提示「已忽略 N 条无效记录」。
- **回归测试**：`backup.test.ts` 新增「数组超过上限时截断数量计入 dropped」——6000 条合法 history → 导入 5000、`dropped ≥ 1000`，通过。
- **复核证据**：`npm test` 206 全绿（backup 8 个用例）；UI 摘要已含 dropped 提示逻辑（`SettingsPage.tsx` 导入摘要）。

### D-07【P3 轻微｜健壮性/文案｜✅ **已修复**】账号检测异常（网络/nav 失败）时 Hero 可能误显示「公开模式」

- **复核结论**：**已修复，QA 代码复核通过。**
- **修复内容**：`Hero.tsx:38-41` 新增 `accountError = Boolean(account.error)`，`loggedOut = !account.loggedIn && !accountError`；`publicMode` 不再把检测异常当作未登录；`:153-171` 新增独立告警「**登录状态检测失败**」+「重试」按钮（仅 `accountError` 时显示），未登录提示仅在 `loggedOut`（真正未登录）时显示。
- **复核证据**：代码路径核对通过；e2e 未模拟 nav 失败分支（需网络/风控注入），属低风险 UI 细化，建议后续补 mock 场景。

---

## 3.1 v3.2 最终复核结论汇总

| 缺陷 | 状态 | 复核证据 |
|---|---|---|
| D-01 周报「本周」文案 | ✅ **已修复（闭环）** | `weekly.ts`/`mock.ts` 生成文案改「该周」、`weekly.test.ts` 断言同步；206 用例全绿；重建 dist 含「该周观看」；刷新截图「该周共观看/该周活跃」已确认 |
| D-02 备份图片 URL 白名单 | ✅ 已修复 | `safeImageUrl` https + B站 CDN 后缀白名单；cover/face/avatar 接入；新增单测 |
| D-03 信号截图同帧 | ✅ 已修复 | e2e 滚动后截图；两图 SHA-256 不同（见上） |
| D-04 真实流水线工件 | ✅ 已修复 | `live-acceptance-v0.2.0.json` 163/84/58.957s/4 分区/21 条；README 已链接 |
| D-05 导入保留旧 KV | ✅ 已修复 | `importAllData` 清理 5 个业务 KV |
| D-06 备份静默截断 | ✅ 已修复 | `overflowCount` 并入 dropped；6000→5000 单测通过 |
| D-07 账号检测异常文案 | ✅ 已修复 | Hero 区分 error 与未登录，独立告警+重试 |

> **7 项 P3 全部修复闭环，无残留、未发现新回归或新缺陷。** 剩余仅为 §7 的非阻断观察/建议项（注释中「本周」字样、`history.cover` 防御纵深、e2e 未注入 nav 失败分支等）。

---

## 4. 隐私与边界专项核查（v0.2.0 新增面）

| 检查点 | 结论 | 证据 |
|---|---|---|
| cookie 读取/写入/存储 | ✅ 无 | 全仓无 `document.cookie` / `chrome.cookies` / `localStorage` / `sessionStorage`；未申请 `cookies` 权限；登录态通过 `credentials:'include'` 由浏览器自动携带，扩展不读取值 |
| 新增接口是否只读 | ✅ 全 GET | 新增收藏夹列表/收藏内容/关注列表/稍后再看 4 个端点均为 `http.getJson`（GET）；全仓无 POST/PUT/DELETE/PATCH；不做点赞/投币/收藏/关注等写操作 |
| 请求域名 | ✅ 仅 B站 API | 新端点由唯一 `BILI_ORIGIN=https://api.bilibili.com` 拼接；`dist/background.js`、`dist/content.js` 静态扫描域名仅 `api.bilibili.com` / `www.bilibili.com`；`passport.bilibili.com` 仅出现在仪表盘「打开 B站登录」<a> 链接（用户点击才导航，扩展不请求） |
| 中转白名单 | ✅ 未变 | `content.ts` 仍只允许 `https://api.bilibili.com/` 前缀且主机名完全匹配；e2e 外部域名 `API_FETCH` 被拒 |
| 权限最小化 | ✅ | `permissions` 仍仅 `storage` + `alarms`；host 仍仅 B站两域；备份下载用 Blob + `<a download>`，**未新增 `downloads` 权限** |
| 数据落地 | ✅ 本地 | 收藏/关注/稍后再看聚合存 `Profile.signals` 与 `signals:last` KV（IndexedDB），周报存 IndexedDB 新 `weekly` 表（DB v2），备份仅本地 JSON 文件；无上传/远程代码/统计上报 |
| 备份隐私提示 | ✅ | UI 黄色提示「备份文件包含完整观看历史，且未加密；请妥善保管，不要上传到公开位置」；README「数据与隐私」同样说明；导入前二次确认「覆盖当前全部本地数据，不可撤销」 |
| 恶意备份输入面 | ✅ **已加固**（复核通过） | 无代码执行/无 URL 主动访问（`backup.ts` 明示不执行文件内代码/不访问网络）；v3.1 起 `safeImageUrl` 对 cover/owner.face/profile.avatar 强制 **https + B站 CDN 域名后缀**（`hdslb.com`/`bilibili.com`/`bilivideo.com`），非白名单置空，新增单测覆盖 evil 域；`history.cover` 未过滤但当前 UI 不渲染历史封面（无请求面，见 D-02 残留说明） |
| 日志敏感度 | ✅ | 新增日志（signals 采集/备份导入/周报生成）只含数量与 mid/周键，无标题、无 cookie、无 URL 查询串 |
| 清空数据语义 | ✅ 有改进 | v0.1.1 起清空后 `autoUpdate=false` 并移除每日闹钟（e2e「清空数据会暂停自动更新并移除每日闹钟」），文案明确「只删本扩展的本地历史副本，不会改动你的 B站账号数据」 |

---

## 5. 截图审查记录（本轮 5 张）

| 截图 | 审查结论 |
|---|---|
| `dashboard-weekly-1440x900.png`（mock，02:31:21 刷新） | ✅ 周报页完整：左侧「周报」导航、周选择器（10-12–10-18）、刷新；4 项概览（**该周**观看 23 个 / 观看时长 3 小时 15 分 / 活跃 7 天 / 完播率 65.6%，含环比）；7 天 CSS 柱状图（峰值周二 4 个）；「**该周**总结」卡片内生成文案已刷新为「**该周共观看 23 个视频…上一周是 17 个**」「**该周活跃 7 天**」；标签 Top12（游戏/生活/音乐，含「持平/新增 +54%」涨跌 chip）；上升/下降榜 —— **D-01 已闭环**。 |
| `dashboard-tags-signals-1440x900.png`（mock，02:31:15 刷新） | ✅ 截图滚动至「收藏与关注」面板，可见收藏 UP Top10 / 关注 UP Top10 / 收藏标签行，以及下方「稍后再看 · 共 27 条·采样 20 条」面板开头；与 `dashboard-tags-1440x900.png` 的 SHA-256 不同（160,683 B vs 269,568 B），独立信号证据成立（D-03 已修复）。 |
| `dashboard-settings-backup-1440x900.png`（mock） | ✅ 设置页备份面板：导出/导入按钮、**未加密警示条**、已导出文件名与大小（208KB）、导入成功摘要（历史 1 / 快照 0 / 推荐 1 天 / 周报 0 / 拉黑 1 / 画像 无）、toast（登录状态已刷新 / 导入成功）；关于区显示版本 v0.2.0、存储与今日结果；清空区文案明确只删本地副本。信息层级清楚，无视觉问题。 |
| `live-today-1440x900.png`（真实公开模式） | ✅ v0.2.0 公开模式：Hero「公开模式」+ 账号登录刷新入口；降级提示两条（分区榜、每周必看风控跳过）；「4 个分区 · 21 条推荐」；今日必看 6 卡、估算增长角标与图例、匹配度/不感兴趣齐全；无信号/周报相关元素（符合公开模式跳过）。 |
| `live-weekly-empty-1440x900.png`（真实公开模式） | ✅ 未登录周报页空态：「周报将在每周一 04:00 的每日更新后自动生成」+ 立即检查；周选择器「暂无可选周报」禁用；Hero 与 live-today 一致；侧边栏 v0.2.0，无 console 级视觉异常。 |

> 另核对：最终 e2e 重跑后 e2e 截图已全部刷新（02:31:14–02:31:40），`screenshots` 10 条路径全部存在；`live-today` / `live-weekly-empty` 仍为公开模式真机截图（02:18），与 `live-acceptance-v0.2.0.json` 数据一致。最终截图哈希：`dashboard-weekly` = `736513E1…7FD34`（224,700 B）、`dashboard-tags` = `48073D38…B8DC`（269,568 B）、`dashboard-tags-signals` = `A9C93E08…33748`（160,683 B）。

---

## 6. 需用户验证清单（本环境无 B站登录会话 / 无法启动系统 Chrome）

1. **账号卡三态与刷新**：真实登录后确认 Hero 昵称/头像、设置页账号卡「已登录」；退出登录（或清除 B站 cookie）后刷新，确认显示「登录已失效 + 上次登录」或「未登录」；点「刷新登录状态」后状态与检测时间更新。
2. **收藏信号**：登录真实账号首页更新，确认「我的标签」显示收藏夹数/收藏总数/采样 60 条、收藏 UP Top10、收藏标签；重点验证 `type=1`（全部收藏夹）真实分页与时间倒序；若账号触发兼容模式，确认「兼容模式：前 3 个收藏夹」提示。
3. **关注 / 稍后再看**：确认关注人数（≤100 采样）、关注 UP Top10、稍后再看条数/分区/标签；`-101` 时不应阻塞主流程（可在隐身窗口自测公开模式）。
4. **周报**：周一（或把系统时间/更新时间调到周一触发）生成上一自然周周报；验证 4 项概览、7 日趋势、标签/分区/UP、上升/下降、周切换 12 份、空周报与「不生成」（未登录）行为；跨年周（12 月底）标签正确。
5. **真实登录推荐链路**：确认 90 天历史采集、signals 并入画像、推荐理由出现「你关注的 UP 主 / 关注 UP」角标、标签画像 ≥15 个、增长实测（两次快照 ≥12h）。
6. **备份真实往返**：真实数据下导出 → 清空 → 导入 → 校验历史/推荐/画像/周报/设置恢复；再用乱改后缀/超大文件验证拒绝且不覆盖；确认导入后「最近一次更新」显示备份数据的时间（D-05 已修，代码层面已清理旧 KV，运行时建议人工确认一次）。
7. **安装与定时**：系统 Chrome/Edge 120+ 加载 `dist/`（e2e 用开源 Chromium 157）；保持浏览器运行到更新时间确认每日闹钟；B站页面右下角悬浮入口与关闭记忆；多分辨率下悬浮按钮与 B站自有按钮不重叠。
8. **清空数据**：确认清空后自动更新暂停、每日闹钟移除、重新开启后恢复（e2e 已覆盖后台行为，UI 端建议人工走一遍）。

---

## 7. 其他观察与改进建议（非缺陷，按优先级）

- **O-01 e2e「空闲 tick 不产生额外请求」仍未真正统计请求数**：该项 detail 自述 `controller 未提供 requestCount`，实际只断言 `running=false / stage=idle`（v0.1.0 遗留）。建议把 `requestCount` 暴露到 `GET_STATUS` 后补断言。
- **O-02 mock 演示 bundle 含第三方图片 URL**（akendfield.gryphline.com、i0.hdslb.com、store.steampowered.com、x.com 等）：仅 `?mock=1`/无扩展环境动态加载，**正常安装不加载、不请求**；D-02 修复后「导入备份」路径的图片 URL 已白名单化，剩余仅 mock 演示数据自身的示例图 URL，建议后续改本地占位图（不影响真实使用）。
- **O-03 账号第三态未显式断言**：`logged-out`（无 `last`）由 `accountState` 代码支持且为首装默认，但 e2e 仅显式断言已登录与登录已失效两态；建议补一条 mock 首装断言（`data-state=logged-out`）。
- **O-04 收藏总数语义**：`favoriteCount` 为所有收藏夹 `media_count` 之和，跨收藏夹重复收藏会重复计数；UI「全部收藏夹 · 收藏 X 条」建议标注「含重复收藏」或改用去重数。
- **O-05 信号 12 小时缓存（✅ 已补充说明）**：v3.1 起 README「数据与隐私」已写明「这些信号会本地缓存 12 小时，失败时只降级、不阻塞推荐」（`README.md:96`）；仍建议在「已知限制」或标签页提示里说明「新增收藏后最多延迟 12h 反映」。
- **O-06 周报/画像无多账号隔离**：README 已说明画像共用；周报同属本地数据也未隔离，切换账号后仍显示旧账号周报，建议 README 一并说明。
- **O-07 备份传输上限风险**：导入 JSON 经 `chrome.runtime.sendMessage` 传输（上限 20MB），而浏览器消息通道本身有大小限制；实际备份通常远小于此（本次 mock 200KB、真实历史量级 MB 以下），如未来支持大备份建议改分片/文件直读。
- **O-08 周报标签混入分区名**：标签 Top12 含一级/叶子分区名（与「分区 Top6」概念重叠），口径已在代码注释中说明并用于涨跌对比；若用户反馈困惑可把分区名在标签云里加不同样式。
- **O-09 收藏兼容模式降级文案**：`signals.ts` 对 -400/空列表回退时写 `degraded='「全部收藏夹」接口不可用，已回退为逐个收藏夹采样'`，页面会进入「数据源降级」横幅；属正确行为，但真实账号若长期走兼容模式会每次显示，建议 UI 用更轻的提示。
- **O-10 history.cover 未走图片白名单（防御纵深，低）**：`backup.ts sanitizeHistory` 仍用 `optStr(item.cover)`（`:154`），但 UI 仅渲染 `Recommendation.cover`（grep `src/ui` 仅 `VideoCard.tsx:27`），历史封面从不渲染 → 当前无请求面；建议后续顺手统一为 `safeImageUrl`。
- **O-11 e2e 未覆盖 Hero「登录状态检测失败」分支**：D-07 修复为纯 UI 分支，e2e 无 nav 失败注入手段；建议 mock 增加 `account.error` 场景并断言告警文案（低成本，可选项）。
- **O-12 代码注释中仍有「本周」字样（非用户文案，低）**：D-01 修复后，用户可见文案已全部「该周」；grep 仍有 `weekly.ts:56`（「本周周一 00:00」注释）、`mock.ts:1219`（「UP 主：本周观看次数」注释）、`weekly.test.ts:154`（「按本周观看次数排序」注释）三处注释。不影响界面/测试，可选顺手统一为「该周」。

---

## 8. 总体结论

- **交付质量**：v0.2.0 的四个新能力（账号卡、只读兴趣信号、周报、数据备份）实现完整、边界处理成熟：信号有缓存/降级/-101 静默、回退兼容；周报有幂等/跨年/空态/12 份保留且文案口径与「上一自然周」一致；备份有 schema/体积/字段白名单/坏行与超限统计/图片 URL 白名单/二次确认/未加密提示，且「校验通过才覆盖」；关键路径均有单测与 e2e 覆盖。7 项 P3 修复后边界进一步收紧（恶意备份图片域名、导入旧 KV、Hero 异常态、周报文案口径）。
- **自动化证据（v3.2 最终复核，QA 实跑）**：typecheck 0 错误、**17 文件 / 206 单测全绿**、probe **10/10**、`validate-dist` **6/6**（最终重建 dist：`dashboard-dvDVDIr_.js` / `dashboard-By0eHghW.css`，manifest 0.2.0）；Lead 实跑 build 成功、e2e **56/56**（02:31:47 重跑，0 fail/skip，截图 02:31:14–02:31:40 全部刷新）、SW 直连 `code=0`；`artifacts/live-acceptance-v0.2.0.json` 已落盘（163 候选 / 84 请求 / 58.957s / 4 分区 / 21 条 / 公开模式无周报）。
- **缺陷情况**：v3 提出的 **7 项 P3 已全部修复并经 QA 最终复核闭环（D-01~D-07）**，**0 项 FAIL、0 项 P0/P1/P2、0 项残留 P3**；§7 剩余均为非阻断观察/建议项（`history.cover` 防御纵深、注释字样、e2e 失败注入等）。
- **发布判断**：**PASS（通过验收，可发布）**。§6 的 8 类真实账号/系统浏览器验证需用户在本机完成（不影响自动化结论）。
- **未发现**：隐私泄露（cookie 读写/第三方上报）、非 B站 API 域名请求、写操作接口、权限扩张、MV3 加载问题、v0.1.x 功能回归；本轮修复未引入新的 FAIL/回归。

---

## 9. 变更历史与附录

| 版本 | 时间 | 基线 | 内容 | 结论 |
|---|---|---|---|---|
| v1 | 2026-10-21 01:05 | `3c8fa02`（v0.1.0） | 独立验收：命令/代码/截图/隐私核查，提出 D-01~D-03（1×P2+2×P3）与 R-01~R-04 README 问题 | Conditional PASS |
| v2 | 2026-10-21 01:12 | `3c2074e`（v0.1.0 修复） | 收尾复核：typecheck 0、138/138 单测、修复后重建 dist validate 6/6、e2e 31/31；D-01~D-03 关闭、R-01~R-04 核对更新 | PASS |
| v3 | 2026-10-21 02:28 | v0.2.0 工作树（HEAD `e9b086a` + 57 项变更） | v0.2.0 独立验收：账号/信号/周报/备份 + 回归 + 隐私 + README + 截图；204 单测、probe 10/10、validate 6/6、e2e 56/56；新增 D-01~D-07（均 P3） | **PASS** |
| v3.1 | 2026-10-21 02:36 | v0.2.0 修复后工作树（HEAD `e9b086a` + 60 项变更；dist 02:24:39；e2e 02:25:27） | 7 项 P3 修复复核：typecheck 0、**206/206 单测**（+2 备份安全/截断）、validate-dist 6/6、e2e 56/56；**D-02~D-07 六项已修复经复核，D-01 部分修复（生成式总结仍「本周」）**；`live-acceptance-v0.2.0.json` 落盘、信号截图哈希已不同 | **PASS**（残留 1 项 P3） |
| v3.2 | 2026-10-21 02:34 | v0.2.0 最终工作树（HEAD `e9b086a` + 60 项变更；dist 02:28:47；e2e 02:31:47） | D-01 补齐复核：`weekly.ts`/`mock.ts` 生成文案改「该周」、`weekly.test.ts` 断言同步（206 全绿）；重建 dist 含「该周观看」；重跑 e2e 56/56 并刷新截图（02:31），周报截图确认「该周共观看/该周活跃」；validate-dist 6/6 | **PASS（7 项 P3 全部闭环，0 残留）** |

**本轮参考数据（v3.2 最终）**：`artifacts/e2e-summary.json`（56 项，at 02:31:47，截图 02:31 刷新）、`artifacts/live-acceptance-v0.2.0.json`（163 候选 / 84 请求 / 58.957s / 4 分区）、`artifacts/validate-dist.mjs`、`artifacts/screenshots/`（10 张 e2e 截图已刷新 + 5 张 live 截图；`dashboard-weekly` 736513E1…/224,700 B、`dashboard-tags` 48073D38…/269,568 B、`dashboard-tags-signals` A9C93E08…/160,683 B）、`dist/`（v0.2.0 最终重建：`dashboard-dvDVDIr_.js` / `mock-ChBNL9k6.js`）、`README.md`（v0.2.0，206/56/10 与工件链接）、`tests/unit/**`（17 文件 206 用例）、`tests/integration/probe.test.ts`（10 项）。旧 `artifacts/live-acceptance.json` 为 v0.1.0 数据，已被新工件取代。

*报告由独立 QA 生成（v3.2，v0.2.0 最终修复复核）；本文件为 QA 作用域内唯一写入产物（`artifacts/qa-report.md`）。*

---

## 10. v3.3 增量记录（v0.2.1 / v0.2.2，Lead 集成记录）

> 本节由 Lead 在 v0.2.0 QA v3.2 结论之后补充，记录两次增量发布的验证结果；不替代上文独立 QA 结论。

| 版本 | 时间 | 内容 | 验证结果 |
|---|---|---|---|
| v0.2.1 | 2026-10-21 02:49 | 周报空态文案明确「只在登录后生成、错过后补生成」；「立即检查」改为「立即更新并生成」，未登录跳转 B站登录页；新增 `generateWeekly`（触发更新→轮询结束→刷新周报） | typecheck 0；206 单测；build + validate-dist 6/6；e2e 56/56；tag `v0.2.1`（commit `024109f`） |
| v0.2.2 | 2026-10-21 02:54 | 增长榜说明标点/格式修复（去掉 `.notice-body > strong` 块级强调造成的断行）；收藏夹接口 -404/空默认收藏夹自动回退逐文件夹采样，空收藏夹静默返回，错误提示更准确 | typecheck 0；**209 单测**（+3 收藏夹回退/空夹用例）；build + validate-dist 6/6；e2e 56/56；tag `v0.2.2`（commit `0fbbdcb`，文档同步后 tag 随 HEAD 更新） |

**当前基线（v0.2.2）**
- `package.json` / `manifest.json` / UI 三处版本号均为 **0.2.2**；`dist/` 由 Lead 于 02:53 重建，e2e 于 02:54:32 重跑，截图同步刷新。
- `npm run typecheck` 0 错误；`npm test` **17 文件 / 209 用例全绿**（engine 174）；`npm run probe` **10/10**；`validate-dist` **6/6**；e2e **56/56**（0 fail/skip）。
- 本轮两次增量未发现 P0/P1/P2/P3；v3.2 的「PASS，可发布」结论继续适用于 v0.2.2。
- 仍待用户在本机真实账号/系统 Chrome 完成 §6 的 8 类人工验证；收藏夹真实 `type=1` 分页与兼容模式回退需在真实账号下确认。

*本节为 Lead 增量记录；v3.2 独立 QA 报告保持原样。*

