# 架構演進 Roadmap

目標藍圖來自「低延遲多人在線跨部門協作」技術棧文件:即時能力拆成四個平面 —— **WebRTC**(媒體)、**WebSocket**(業務事件)、**CRDT**(共同編輯)、**REST**(持久化與查詢),各平面獨立擴張,不互相塞流量。本文件把該藍圖對應到本 codebase 的現況與演進順序。

## 現況(已完成)

| 平面 | 藍圖建議 | 目前實作 | 差距 |
|---|---|---|---|
| 媒體 | LiveKit SFU + coturn | 模式切換:預設 mesh(≤8),SFU 疊加層走 LiveKit(上限 50);simulcast + adaptiveStream + dynacast;coturn TURN fallback;Egress 錄影 → MinIO + **清單與預簽 URL 播放**;**每對等連線品質量測與弱網降級、ICE 重啟** | TURN/TLS 443 需真實憑證(部署層) |
| 業務事件 | Spring WebSocket(STOMP)+ Redis/Kafka backplane | 自訂 JSON envelope(`SignalMessage`);`Backplane` 抽象(單機 / Redis pub-sub + Sentinel HA);transactional outbox → Redpanda + schema registry;**斷線自動重連與重新加入**;**每連線速率/訊框/聊天長度上限** | — |
| 共同編輯 | TipTap/ProseMirror + Yjs + Hocuspocus + Postgres | ✅ 同組合:`collab/` 服務;update log + debounce 快照 compaction;訊息/文件/速率三重上限;多實例經 Redis 同步 | — |
| 持久化 | PostgreSQL 為 source of truth | 聊天、筆記快照、outbox、稽核與搜尋讀模型、會議領域皆入 Postgres;Flyway 管 schema(V1–V5);WAL 歸檔 + PITR + 加密物件儲存歸檔 | 跨區域複寫、KMS(部署層) |
| 前端 | Vue 3 生態系 + Konva 白板 | React 18(既有投資,不重寫)+ Konva 白板 ✅ | 刻意偏離框架 |
| 測試 | (藍圖未細談) | 三層:vitest 單元(CI)、`tests/e2e/` 黑箱、`tests/ui/` 真實瀏覽器;另有壓測/混沌/DR/HA 演練 | 目標環境的藍圖級工作負載(20k 連線) |

## 演進順序(建議)

1. ~~**CRDT 平面強化**~~ ✅ 已完成:awareness 節流(~25 Hz)、update 大小上限(512 KB)、文件尺寸上限(5 MB)、每連線訊息速率上限(120/s)、`collab_update` 日誌 + debounce 快照 compaction。
2. **認證授權** ✅ 大致完成:OIDC Resource Server(`oidc` profile)、collab JWT 驗證、前端 PKCE 登入 + **silent renew**(refresh token 單次使用輪替)、WS **逐訊息 token 過期強制**(4401 切斷)、LiveKit token 簽發、`docker-compose.oidc.yml` overlay(devidp 為開發用 IdP,正式環境以 `OIDC_*` env 換成 Keycloak/Entra)。**資源層級授權(房間層)✅**:開房者為主持人(離開自動交接,backplane 原子維護 host/locked meta),主持人限定的鎖房(`room-locked` 拒新加入)與踢人(`kicked` + 4403 斷線,跨節點經 backplane 投遞),特權訊息以連線 join 身分驗證防冒名;稽核事件 `participant.kicked`/`room.locked`/`room.unlocked`。尚餘(刻意遞延):部門/專案層級 ACL(需組織目錄整合)、真實 IdP 對接演練。
3. **SFU 遷移** ✅ 大致完成:`docker-compose.sfu.yml` 疊加層導入 LiveKit,前端 `SfuRoom`(與 mesh 同介面,由後端 `/api/media/config` 決定模式)、後端房間限定 token 簽發、信令上限放寬到 50、**simulcast + adaptiveStream + dynacast**;mesh 路徑的 coturn/TURN fallback(`docker-compose.turn.yml`)。**錄影 ✅**(`docker-compose.recording.yml`:LiveKit Egress room-composite → MinIO,webhook 驗簽 → `meeting.recording.completed` 事件)。尚餘(刻意遞延):TURN/TLS 443(需真實憑證)。
4. **水平擴展 backplane** ✅ 部分完成:`Backplane` 抽象(預設單機 no-op),`redis` profile 將成員目錄移入 Redis(節點心跳 + 惰性 ghost 清理)、跨節點訊息走 Pub/Sub、房間上限原子化(本地 compute / Redis Lua);collab 以 `extension-redis` 多實例同步;`docker-compose.scale.yml` 跑 backend×2 + collab×2;**Kafka + transactional outbox**(`kafka` profile + Redpanda overlay,at-least-once + eventId 去重;事件:chat.message.created、participant.joined/left、document.snapshot.created)+ **消費端範例 `indexer/`**(audit_log 稽核軌跡 + message_search 全文檢索讀模型,`GET /api/search/messages`)。另有**事件信封契約**(`docs/contracts/warroom-event.schema.json`,indexer 以 ajv 強制,違約 = 毒訊息)。**會議領域與事件 ✅**(`meetings` 表 + `meeting.started`/`meeting.ended`/`participant.rejected`,backplane 回傳叢集人數保證第一人/最後一人判定)。**Redis Sentinel 高可用 ✅**(`docker-compose.ha.yml` 疊在 scale 之上:master + replica + 3 Sentinel quorum 2;後端 `redisha` profile 走 `spring.data.redis.sentinel.*`、collab ioredis 走 Sentinel;`tests/ha/failover-drill.sh` 實測殺 master 後自動升級,信令/CRDT 不中斷)。**Schema Registry ✅**(Redpanda 內建 registry,subject `warroom.events-value`;indexer 啟動註冊 + 以 registry latest 驗證,registry 不可達時退回內帶副本)。尚餘(刻意遞延):Redis Cluster(資料分片規模需求出現時)、OpenSearch 取代 Postgres FTS(搜尋規模需求出現時)。
5. **可觀測性** ✅ 大致完成:backend/collab/indexer Prometheus 指標、**OTLP 分散式追蹤 → Tempo**(overlay 啟用,Grafana datasource 已接)、**LiveKit WebRTC 品質指標**接入 scrape、**Grafana dashboard** 與**告警規則**(target down / backlog / 拒連 / 處理延遲 SLO)。**Alertmanager 通知路由 ✅**(分組、critical 快速通道、target-down 抑制同 job warning;dev 接收端為 webhook logger,實測告警送達)+ **dashboard 補齊**(SFU 房間/參與者與 NACK/封包率、outbox backlog 與發布率、Redis backplane 指令延遲 p99、indexer consumed/failed/deduped)。尚餘:正式環境接 Slack/PagerDuty 憑證(部署層)。
6. **資料層治理** ✅ 部分完成:Flyway 管 schema(V1 聊天、V2 collab 表;Hibernate 改 `validate`,既有資料庫 baseline 接軌)。尚餘:訊息全文檢索(OpenSearch)按需求再進。

7. **壓測與混沌** ✅(藍圖 §十):`tests/load/` k6 信令壓測(SLO 門檻化,400 VU/1.3k msg/s 全綠;首輪即抓到並修復兩個廣播併發競態)+ `tests/chaos/` Toxiproxy(延遲注入無丟失、斷線後成員清理與重連)。詳見 `docs/runbooks/load-testing.md`。**LiveKit RTC 負載測試 ✅**(`tests/load/rtc-load.sh`,3 發布者/9 訂閱者 30 秒:27/27 軌道、21.5mbps、0% 丟包,simulcast 分層可見)+ **Yjs replay 壓測 ✅**(`tests/load/crdt-replay.mjs`,壓縮前/後兩階段對照:重建成本由 log 列數而非文件大小主導——20000 字壓縮後 0.3ms vs 5000 字帶 200 列未壓縮 log 的 4.5ms)。尚餘:目標環境的藍圖級工作負載(20k 連線)。

8. **備份與 DR** ✅(藍圖 §十一,本機形態):backup 疊加層(WAL 歸檔)+ `tests/dr/` 一鍵 PITR 還原演練(災前/災後標記、CRDT snapshot⊕log 重建 hash 比對;首次演練即抓到歸檔權限缺陷並修復)。詳見 `docs/runbooks/disaster-recovery.md`。**物件儲存歸檔 + 備份加密 ✅**(`docker-compose.backup-s3.yml`:rclone shipper 經 `crypt` remote 客戶端加密同步進 MinIO,`tests/dr/restore-s3-drill.sh` 只從 bucket 還原並斷言 bucket 內無明文路徑;演練抓到「物件儲存丟失空目錄導致還原叢集拒啟動」,改用 tar 格式基礎備份修復)。尚餘:跨區域複寫、金鑰管理服務接入(部署層)。

9. **連線韌性與測試分層** ✅:信令 `SignalingClient` 指數退避重連(每次重讀 URL 以帶上更新過的 token;**被踢 4403 與主動離開永不重試**),恢復後重新 join + 重播媒體/舉手狀態、依伺服器成員清單重建(mesh 重建 peer connection、SFU 不動);伺服器端修掉「被取代的 session 遲到 close 會踢掉活著的連線」競態。**每對等連線品質**(`getStats` 量 RTT/視窗丟包/抖動)在成員名單顯示,持續不佳只降該對等的視訊,恢復比降級慢以免抖動;`failed` 時由較小 peer id 單方發起 ICE 重啟。**測試分三層**:純邏輯與策略進 vitest(CI 唯一會跑的前端測試)、`tests/e2e/` 黑箱、`tests/ui/` 真實瀏覽器(音訊是否真的出得來、編輯器是否接上文件、控制項是否只給對的人)。

## 後續(依價值排序)

**A. 信令平面的濫用防護** ✅ 已完成:每連線 token bucket(`RateLimiter`,預設 60/s + 2 倍突發)、容器層訊框上限(64 KB)、聊天長度上限(4000 字,寫入資料庫前檢查)。處置依意圖分流——超速丟棄、過長回錯、超大訊框由容器 1009 關閉;每種拒絕皆有指標。以 `RateLimiterTest`(注入時鐘)、`SignalingLimitsIntegrationTest`、`tests/e2e/run.sh limits` 驗證,並重跑 k6 壓測確認正常流量未被誤傷(checks 100%、chat RTT p95 6ms)。

**B. 錄影播放介面** ✅ 已完成:`recordings` 表(V6)由 webhook 與事件同交易寫入(egress id 冪等),`GET /api/recordings/{room}` 列出、`/{id}/url` 即時簽發 30 分鐘有效的 SigV4 預簽連結;前端側邊面板列出並就地播放。物件儲存憑證不出後端、位元組不經後端(nginx 轉發)。以 `S3PresignerTest`、`tests/e2e/run.sh recordings`(含竄改簽章需被拒)、`tests/ui/run.sh recordings` 驗證。

**C. 資料保留與刪除** ✅ 已完成:`RetentionService`(postgres profile,每小時)清理錄影+物件、聊天+其 `message_search` 投影、`audit_log`、**已發布**的 `outbox_events`。**每種期限預設 0 = 永久保留**——部署當下就開始刪資料是很糟的驚喜,由維運者逐項以 `warroomlive.retention.*-days` 開啟。刪除分批(500 列/批、每表每輪最多 20 批)且各自獨立交易(用 `TransactionTemplate`——同一 bean 自呼叫的 `@Transactional` 不會生效)。聊天與其搜尋投影共用同一期限是刻意的:只刪訊息卻留索引,等於讓搜尋回傳資料庫已經沒有的內容。未發布的 outbox 列永不碰——那是佇列不是歷史。錄影**先刪物件再刪列**,物件刪不掉就留著列等下一輪,而不是留下沒人指得到的檔案。另加**手動刪除**`DELETE /api/recordings/{room}/{id}`(共用同一條路徑,發 `meeting.recording.deleted` 帶 `actor`),前端錄影面板兩段式確認。V7 補上四個依時間的索引——既有索引都以 room/aggregate 開頭,年齡條件只能全表掃描。以 `tests/e2e/run.sh retention` 驗證(用 `docker compose run` 另起一個開了保留期限的 backend 打同一個資料庫,不動到跑著的 stack;**關鍵斷言是否定的那些**——新資料要活著、未發布的 outbox 列要活著)。

**D. REST 濫用防護與分頁** ✅ 已完成:HTTP API 沿用同一個 token bucket(`limits/RestRateLimitFilter`,預設 20/s + 2 倍突發),**跑在認證之前**——洪水應該在讓伺服器驗簽章、抓 JWKS 之前就被擋掉,這也是為什麼以位址而非 subject 為 key。位址取 `X-Forwarded-For` 的**最後一段**:nginx 是附加在後面,前面的是客戶端自己塞的、可偽造;取第一段等於讓任何人每次請求都換一個新額度。超量回 **429 + Retry-After**(HTTP 呼叫端在等答案,可以被告知退讓;信令則是丟棄)。健康檢查、`/api/auth/config`、自我認證的 LiveKit webhook 豁免。HTTP 沒有斷線事件可以釋放 bucket,改為定期掃除閒置。清單端點改為分頁:`/api/recordings/{room}` 與 `/api/search/messages` 收 `limit`/`offset`(預設 50、上限 200,越界夾住而非報錯),搜尋另限查詢字串長度(ILIKE 分支會掃描)。以 `RateLimiterTest`、`RestRateLimitFilterTest`(含偽造 XFF 不能換額度)、`PagesTest`、`tests/e2e/run.sh limits` 驗證。

**E. 身分綁定與產品缺口** ✅ 已完成:

- **身分由伺服器決定**:WS 握手擷取 JWT 的 subject 與 IdP 認可的名稱(`WebSocketConfig`),`join` 時**以驗證過的名稱覆蓋客戶端送來的**,subject 進 backplane 成員目錄(`tryRegister(..., subject, ...)` / `Backplane.subjectOf`,Redis 的 `MemberEntry` 多一個欄位、缺欄位 Jackson 給 null,滾動升級不用遷移)。這補上了上一輪標出的缺口:登入原本只證明「有權限」,對「你是誰」毫無約束力。subject **不放進 `PeerInfo`**——房間需要名字,不需要別人的帳號識別碼。刪除錄影與刪除檔案因此改為**房間主持人限定**(主持人 subject 已知時);房間空著或沒有 IdP 時沒有可比對的對象,退回只做歸屬。以 `LocalBackplaneTest`(含交接時 subject 要跟著走)與 `tests/e2e/run.sh oidc`(用 alice 的 token 自稱別的名字,房間看到的仍是 alice;bob 刪 alice 主持的房間的錄影得到 403,而且**在查有沒有這支錄影之前**就被擋——404 會洩漏存在與否)驗證。
- **共享檔案**(`attachments/` + `AttachmentController`,V8):簽章 → 瀏覽器直接 PUT 到物件儲存 → 確認,**列最後才寫**。物件 key 由伺服器決定並固定在 `attachments/<房名>/`,確認時檢查前綴。大小上限查兩次(簽章前看宣告、確認時看實際存進去的),因為預簽 PUT 自己擋不了大小。`ObjectStore` 收斂成唯一知道物件儲存位置與簽章方式的地方;nginx 多一個 `/objects/` location(同樣改寫 Host,另外放行 PUT body)。上傳完成經 `SignalingHandler.broadcastToRoom` 以 `attachment` 訊息通知房內。納入保留期(`RETENTION_ATTACHMENTS_DAYS`)與事件(`attachment.created` / `attachment.deleted`)。
- **訊息搜尋介面**:`GET /api/search/messages` 之前沒有任何入口。側邊面板支援房內/全部切換與分頁;搜尋未啟用時明說,而不是回空結果。
- **手機版版面**:窄螢幕收成單欄,側邊面板變成頁籤(CSS 媒體查詢 + `data-active`,桌面版完全不變)。

驗證:`mvn test`、`frontend npm test`、`tests/e2e run.sh`(base / recording / oidc)、`tests/ui run.sh`。

**F. 共用待辦與共用行事曆** ✅ 已完成:`agenda/`(V9:`todos`、`calendar_events`)+ `TodoController` / `CalendarController`。

**架構決定:走 Postgres,不走 Yjs。** 筆記與白板是 CRDT,因為那是自由文字與圖形的並行編輯;待辦與行事曆是**結構化業務紀錄**——有負責人、期限、完成時間,會被查詢、被稽核,而且活得比這場會議久。藍圖原則本來就是「Durable 進 Postgres」;CRDT 查不了、驗不了、進不了事件骨幹。代價是同欄位並行編輯沒 CRDT 優雅,但待辦標題是短欄位不是文件,聊天早就是同一個模式。

- **排序是伺服器的**:未完成優先、期限近的在前、沒期限的最後(`NULLS LAST`——Postgres 對 DESC 的預設剛好相反);行事曆從 `from`(預設 now)往前讀。前端只渲染不重排:兩個 client 各自排序,就會對「第一件事」講不同的東西。
- **完成是事實不是旗標**:記時間與人;重複完成是 no-op,第二次點擊不會改寫是誰做完的;只有真正的狀態轉換才發事件(否則骨幹會被重複點擊灌滿)。
- **權限分層**:新增與勾選人人可做(只有主持人能勾的清單不叫共用),刪除限主持人。`web/RoomAuthorization` 把 `caller()` 與 `requireHostIfKnown()` 收成一份,錄影與檔案兩個 controller 一起改用——**授權必須跑在查詢之前**,否則 404 會洩漏存在與否。
- 變更經 `broadcastToRoom` 發 `agenda` 訊息帶 `{kind}`,只有受影響的清單重抓。納入保留期(`RETENTION_AGENDA_DAYS`,待辦與行事曆共用一個期限——留著任務卻讓它所屬的會議消失,會變成一份沒人放得回脈絡的清單)。
- 順帶補上前一輪留下的測試缺口:`retention` e2e 現在也涵蓋共享檔案與 agenda 兩張表。

驗證:`mvn test`、`frontend npm test`(TodoPanel / CalendarPanel 含逾期判定、時區轉換、分組不重排)、`tests/e2e/run.sh agenda`、`tests/ui/run.sh agenda`(兩個瀏覽器:一方新增另一方**不用重整**就看到、排序一致、勾選後沉到底)。

**G. 版面與外觀** ✅ 已完成:F 交出來的待辦/行事曆長得像 Jira 的表單——四個欄位、絕對時間、七個面板擠在同一條側欄。兩件事一起改。

- **一行輸入**(`frontend/src/agenda/capture.ts`):`寄簡報 @bob 明天15:00` 解析成 `{text, assignee, dueAt}`。唯一不變式是**認不出來的字留在文字裡**——連「認出來但不合法」的(`25:00`、`2/31`)也放回去,而不是默默吞掉。送出前把「解讀為」顯示回去(preview 與送出共用同一個 `useMemo`,所以兩者不可能講不一樣的話)。伺服器仍然全部驗證——這是打字的便利,不是信任邊界。踩到的坑:JS 的 `\b` 只認 ASCII,`15點` 後面沒有邊界,時間 pattern 改用明確的 lookaround。
- **面板一次開一個,任何寬度都一樣**:原本頁籤只在窄螢幕出現,桌面版七個面板疊在 320px 側欄裡,每個都只分到一條縫。`sidebarPanels` 由實際渲染出來的面板推導,頁籤不會切到空白。
- **日夜主題**(`frontend/src/theme/`):`resolveTheme()` 是純函式、可單測;`useTheme` 把 `data-theme` 與 `color-scheme` 掛上 `<html>`,計時器**瞄準下一個交界**(07:00/19:00)而不是輪詢,另外聽 `matchMedia` 與 `visibilitychange`(筆電睡過黃昏,計時器根本沒機會響)。作業系統偏好**刻意不對稱**:`dark` 壓過時鐘(那是使用者主動選的),`light` 讓給時鐘(那是什麼都沒設定時的回報值,不算表態)。`App.css` 裡的顏色全部換成 token,否則兩套外觀會一條規則一條規則地走鐘;`--tile-bg`/`--on-tile` 在兩套裡刻意相同——影像就是影像,黑色遮罩上的名牌不能跟著頁面的墨色跑。`--skin-fade` 的 `none` 必須寫在 `prefers-reduced-motion` 查詢**之前**,反過來的話同分比後者贏,淡入淡出就會靜靜地死掉。

驗證:`frontend npm test`(100 項:capture 解析與復原、theme 解析與下一個交界、兩個面板的行為)、`tests/ui/run.sh layout agenda`(一行輸入真的把負責人與期限送上線;兩套外觀確實是不同的底色、影像磚兩邊都是黑的、手動選擇撐得過重整)。

**H. 一份議程(Chandler)** ✅ 已完成:G 把外觀修好了,但 F 交出來的資料模型還是 Jira 的——待辦一個面板、行事曆一個面板,使用者得先決定這件事屬於哪一邊才寫得下去。**Chandler 的觀察是這兩者根本不是兩種東西**:差別在於項目帶了哪些面向(stamp),而不是它被歸到哪個清單。

- **面向從項目讀,不從表讀**(`frontend/src/agenda/item.ts`):有人要做 → `task`(可勾),佔用一段時間 → `event`(約會),可以同時成立。兩張表仍在,但 UI 併成一種項目;`mergeFeeds` 是「排序歸伺服器」這條規則唯一撐不住的地方——兩個各自排好的來源必須交錯——所以改成每個 client 都算得出同一個全序(近的先、沒時間的最後、同分比 key)。那條規則保護的本來就是「兩個人不會對第一件事講不同的話」。
- **Triage:現在 / 稍後 / 完成**(V10 `triage` 欄)。不是優先級也不是期限:「重要」跟「週五到期」是工作的屬性、各自解讀,而「現在還是稍後」是一個房間真的做得出來的決定。**時鐘提議、房間決定**——沒存值就從時間算(一天以內算現在,沒時間的算稍後),存了值就是有人表過態,`isAuto` 把差別畫成虛線圈:「沒人看過」跟「房間決定了」是兩回事,會自動分類的看板必須說得出是哪一種。
- **Triage 是欄位不是 component state**:戰情室裡「這件事現在要處理」是共識,不是個人檢視,所以它跨瀏覽器生效。但它**不發事件**——一天會改好幾次的意見灌進骨幹,骨幹就沒人讀了。
- **`DONE` 永遠不存進 triage 欄**:完成是有時間有作者的事實,已經有自己的欄位;把「做完了」再寫一份進 triage,就是準備讓兩份副本吵架。controller 把 `triage: "DONE"` 轉成一筆完成,把 `NOW`/`LATER` 蓋在已完成的項目上則會重新打開它(那顯然是使用者的意思)。行事曆項目因此也補上了完成欄位——在同一塊看板上它們是同一種東西,而一個沒辦法標成「處理完了」的項目會永遠擋在那裡。
- **一行輸入認得時段**:`14:00-15:00` 就是約會的 stamp。時段 pattern 必須排在單一時間之前,否則 `14:00` 被吃掉、`-15:00` 留在文字裡——正好是這個 parser 最不該犯的錯。跨午夜的 `23:00-01:00` 往後滾一天而不是倒過來(伺服器會拒絕倒著的時段)。
- **行事曆是同一批項目的另一個檢視**,不是另一個功能。沒有時間的項目放不上去,所以面板明說還有幾個在清單檢視。
- 截圖抓到一個測試看不出來的缺陷:清單檢視裡的約會只顯示 `16:37`,而那是個沒辦法回答的問題(哪一天的 16:37?)。行事曆檢視有日期標題所以不需要,清單檢視需要——同一個函式,兩種呼叫。

驗證:`mvn test`(含 `TriageTest`:`auto` 與缺值等價、未知的字要拒絕、`DONE` 不是可儲存的值)、`frontend npm test`(133 項)、`tests/e2e/run.sh agenda`(triage 的儲存規則:意見會存、`DONE` 變成完成、壞值回 400 且不會讓同一個 PATCH 的其他部分半套生效)、`tests/ui/run.sh agenda`(兩個瀏覽器:一方的 triage 決定另一方看得到,而且不再被標成自動)。

**I. 行事曆格線與可調版面** ✅ 已完成:

- **行事曆從清單變成時間格線**(`frontend/src/agenda/grid.ts` + `CalendarGrid.tsx`):依日分組的清單答得出「週四有什麼」,答不出「週四下午有沒有空」——空檔沒有列,而區塊之間的縫隙才是找時段的人在讀的東西。`layOutDay` 是純函式:跨午夜的項目在每一天都畫、後面那天標 `continues`;沒有長度的項目給最小高度,但**夾住不讓它長過午夜**(測試抓到的:23:45 的項目原本會溢出到隔天);並排的 lane **以重疊叢集為單位**計算,不是以整天為單位——後者會讓兩場撞期的會議把當天所有區塊都擠成一半寬,讀起來比實際忙得多。
- **欄數由量出來的寬度決定**,經 `ResizeObserver`,不用媒體查詢:這個面板可以拉,媒體查詢量的是錯的盒子。
- **版面可拉**(`layout/workspace.ts` + `WorkspaceDivider.tsx`):分隔線可拖曳、可用方向鍵、雙擊回預設;`clampSidebar` 保證拖不到「影像欄為零、連分隔線都消失」的狀態。影像磚另有五段縮放。兩者都存 localStorage、**不走信令平面**——這是 triage 的鏡像,理由也是鏡像的:版面是這個螢幕的偏好,triage 是房間的共識。
- 兩個測試抓到的缺陷:`Number('')` 是 0 而且是有限的,所以空字串會被當成合法的寬度 0;以及分隔線的 window listener 依賴當前寬度,每次 pointermove 都重跑 effect、而 cleanup 會結束拖曳——**分隔線移動一步就放手了**,截圖才看得出來。

驗證:`frontend npm test`(184 項;`grid.ts` 23 項含跨午夜、夾住、叢集 lane,`workspace.ts` 15 項含儲存的壞值)、`tests/ui/run.sh layout agenda`(真的拖得動、影像讓出寬度、重整後記得、方向鍵也能動;一小時的約會畫成一小時高、現在線只在今天、翻頁後消失而「今天」把它帶回來)。

**J. 補上真正的缺口(一次做完 A–F)** ✅ 已完成:roadmap 上只剩「要真實環境」與「等規模」,但翻程式碼還有六個真的缺口,其中一個是前一輪自己弄出來的。

- **A. 議程的時鐘停了**(前一輪的缺陷):`sectionsOf(items)` 包在 `useMemo(..., [items])` 裡、沒有任何計時器,所以一個在「稍後」的項目時間到了**不會**移到「現在」,除非剛好有人改了什麼。行事曆格線有計時器、清單沒有——**同一份資料的兩個檢視會給出不一樣的答案**,而 PR #20 花三段解釋的「時鐘提議」在面板開著的時候其實不會提議。改成共用 `agenda/useNow`。測試先驗證它在修好之前會失敗:一個兩者皆過的測試等於沒有測試。
- **B. `meetings` 是唯一寫了沒人讀得到的表**,而且**也是唯一沒有被保留期掃到的**——它只會一直長大,而且誰都看不到。`GET /api/meetings/{room}` 往回讀(歷史從剛發生的事開始),保留期以 **`started_at`** 計齡而不是 `ended_at`:節點掛掉的會議沒有結束時間,用可為 null 的欄位計齡會把那些列永遠留著。
- **C. 會議結束後什麼都不留**:`MeetingExporter` 把聊天、議程、筆記、檔案、錄影縫成一份 Markdown。**對自己能做什麼是誠實的**——帶時間的東西框到那場會議,議程與筆記是房間目前狀態並且標明。筆記走 collab 服務新的 `GET /export/:name`(只有它有 Yjs)。踩到的坑:Java 的 HttpClient 預設會提議 h2c 升級,而 collab 是 WebSocket 伺服器——它的 `ws` 層看到不是 `websocket` 的 Upgrade 就回 400,**在請求到達 handler 之前**。端點沒問題,協商有問題;跟 `verify.sh` 那個 HTTP/2 的坑是同一家族。
- **D. 到期不提醒任何人**:`DueReminder`(V11 `reminded_at`)。標記與廣播**同一個交易**——靠記憶體的排程器重啟後全部重講、兩個節點各講一次。走信令(給房裡的人的提示)而不是事件骨幹(工作的事實);`agenda-due` 與 `agenda` 刻意分開,後者是「重抓」,而只會重抓的面板顯示的還是同一份清單。
- **F. 無障礙**:側邊頁籤原本是一排 `aria-pressed` 按鈕——螢幕閱讀器唸成七個各自獨立的開關而不是一個有七種設定的控制項,而且鍵盤要按七次 Tab 才走得到內容。改成真正的 tablist(roving tabindex、方向鍵/Home/End、`aria-controls` 接到 `role="tabpanel"`)。`RoomAnnouncer` 用 polite live region 播報**差異**:每次都重唸整份名單的區域,是會被關掉的區域。
- **E. 兩個從沒跑過的 e2e**:`attachments` 首跑 18/18;`retention` 首跑 14/14,再補上 meetings 掃描後 15/15——補的時候才發現 `RETENTION_MEETINGS_DAYS` 根本沒接到 `application.yml`,環境變數送進去也不會生效。

跑測試又抓到兩個**測試自己**的缺陷:`tests/ui/agenda` 用 `明天14:00-15:00` 斷言它落在「現在」,而那只有在下午兩點之後跑才成立——它整個下午都過,凌晨十二點五十分掛掉,產品什麼都沒變;同一支套件用「第一個 triage 按鈕」定位,但區段會隨項目移動重排,所以每按一次「第一個」就換一個項目。兩者都改成用名稱定位、用相對時間。

驗證:`mvn test` 46、`frontend npm test` 195(含一個先確認會失敗的時鐘測試)、`tests/e2e`(signaling 12、room-acl 15、crdt 5、capacity 1、meetings 15、limits 13、agenda 32、reconnect 6、crdt-hardening 9、attachments 18、retention 15、due 3)、`tests/ui`(layout 23、agenda 21、media 10、collab 4、room-acl 12、quality 9)。

**K. @ 標註與時間區間** ✅ 已完成:兩個功能請求,交叉點上有一個真的缺陷。

- **缺陷**:一行輸入一直解析得出 `@名字`,預覽也一直顯示它——但**同時**帶時間區間的那一行會被路由到行事曆,而 `calendar_events` 沒有負責人欄位,所以 `與法務對齊 @bob 明天14:00-15:00` 預覽看得到 @bob、送出去就沒了。parser 的「認不出來的字留在文字裡」在 parser 內部成立,在上一層破掉。V12 補上欄位。
- **`@` 標註像 IG**(`agenda/mention.ts` + `MentionPicker`):打 `@` 就列出房間的人,空查詢列全部——那是讓人**發現**它的方式,而不是一個要先知道才用得到的語法。方向鍵/Enter/Tab/Esc,input 上是 combobox 語意。**欄位仍然是自由文字**:一件事可以屬於從沒開過這個 app 的人,所以列表外的名字照收——picker 是建議不是白名單,會拒絕未知名字的 picker 讓常見情況變快、真實情況變成不可能。
- 兩個測試抓到的東西:`@` 是 `aria-hidden`,所以選項的可及名稱是名字本身而不是 `@名字`(那是對的,@ 是裝飾);以及 **Esc 用「把游標移出 token」實作根本不會生效**——行尾的標註沒有「外面」可以移過去,所以 dismiss 必須是自己的狀態。
- **區間預覽**:送出前顯示那段區間本身,因為「1 天後」講不出「星期四下午會被吃掉多少」。

驗證:`mvn test`、`frontend npm test` 229(mention 純邏輯 21、picker 與區間 13)、`tests/e2e/run.sh agenda`(負責人存得住、讀得回、改得掉、清得掉,而且不會被無關的 PATCH 洗掉)。

**N. 即時字幕、逐字稿與重點摘要,加上超過 8 人自動切 SFU** ✅ 已完成。

- **第四個平面,用既有的那條分界線切**:辨識在瀏覽器裡跑(麥克風本來就在那,把音訊再送一份上去等於在媒體平面旁邊把上行翻倍)。**草稿只轉發、定稿才落地**——跟 CRDT 平面上「文件 vs 游標」是同一條線。定稿拿到 id 後連 id 廣播回去,**包含說話者自己**:他的字幕是自己畫的,沒有那個 id 就對不上稍後回來的翻譯。
- **翻譯永遠不擋字幕**:另一則 `caption-translated`,晚到、用 id 對回去。有界佇列**滿了就丟**——遲到兩分鐘的翻譯是在幫對話的另一段配字幕。`Lang` 把 BCP-47 收斂成 zh/en 並且**拒絕其他語言**(Chrome 回報的是 `cmn-Hant-TW`,`startsWith("zh")` 剛好在這個房間最常用的 locale 上出錯)。
- **摘要做一次就留著**:再問一次會得到不一樣的答案,而會變的東西不叫紀錄。三段固定骨架、用會議實際講得多的語言寫、句數不足回 422。待辦是**提供**給清單而不是自動塞進去,而且走議程本來那條一行輸入文法。
- **媒體傳輸是房間的屬性,不是部署的屬性**:mesh 到 8 人,之後切 SFU,**單向閂鎖**到房間清空(有遲滯門檻的話,在門檻附近進出的房間會整場都在重新協商)。閂鎖放在 `RoomState`,只會單向設定所以不需要自己的原子性;跨過門檻用既有的 `room-state` 通知——那則訊息本來就是「每個加入者都要知道、改變時每個人都要被告知」。切換時信令 socket 與本地 stream 都沿用,所以聊天/筆記/議程/字幕不中斷。
- **測試與截圖各抓到不同的東西**。測試抓到:摘要 idempotency 失敗,因為 Java `Instant` 有奈秒而 `timestamptz` 只有微秒,同一個欄位「剛建立」和「讀回來」長得不一樣;以及**側邊面板的顯示規則要把每個面板名字寫兩次**,新面板漏了那一行就會渲染進 DOM 卻永遠看不見(`.count()` 看得到、人看不到)——改成面板自己帶 `hidden`,順便就是 tabpanel 該有的 ARIA。截圖抓到:字幕控制項一加進去,整排按鈕就被壓到一個字一行(flex 會把按鈕縮到比裡面的詞還窄);以及字幕蓋住視訊格自己的名牌與表情列,而錨在 stage 底部又會掉到摺線以下——最後錨在**視訊區塊**底下。
- 驗證:`mvn test` 58、`frontend npm test` 262、`tests/e2e` 11 支 122 項(captions 32)、`tests/ui` 8 支 109 項(captions 18)。

**L. 需要真實環境才能推進(部署層,非程式碼缺口)**
真實 IdP(Keycloak/Entra)對接演練、Slack/PagerDuty 告警接收端、TURN/TLS 443 真憑證、跨區域備份複寫與 KMS、目標環境的藍圖級工作負載(20k 連線)。

**M. 等規模需求出現再做**
Redis Cluster(資料分片;可用性已由 Sentinel 覆蓋)、OpenSearch 取代 Postgres FTS、部門/專案層級 ACL(需組織目錄整合)。

## 原則(照藍圖)

- WebRTC 只載媒體;WebSocket 只載控制與業務事件;CRDT 只載共同編輯;不要把所有即時需求塞進單一通道。
- Durable(文件、聊天、稽核)進 Postgres;ephemeral(游標、presence、typing)只 relay、最多進 Redis + TTL,不落 DB。
- 權限判定永遠在伺服器端;token 不進瀏覽器可見的儲存。
- 每一步演進保持「預設零依賴可跑」:無 DB 時聊天走記憶體、筆記走記憶體,是刻意的開發體驗,不要移除。
