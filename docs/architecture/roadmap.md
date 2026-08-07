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

**F. 需要真實環境才能推進(部署層,非程式碼缺口)**
真實 IdP(Keycloak/Entra)對接演練、Slack/PagerDuty 告警接收端、TURN/TLS 443 真憑證、跨區域備份複寫與 KMS、目標環境的藍圖級工作負載(20k 連線)。

**G. 等規模需求出現再做**
Redis Cluster(資料分片;可用性已由 Sentinel 覆蓋)、OpenSearch 取代 Postgres FTS、部門/專案層級 ACL(需組織目錄整合)。

## 原則(照藍圖)

- WebRTC 只載媒體;WebSocket 只載控制與業務事件;CRDT 只載共同編輯;不要把所有即時需求塞進單一通道。
- Durable(文件、聊天、稽核)進 Postgres;ephemeral(游標、presence、typing)只 relay、最多進 Redis + TTL,不落 DB。
- 權限判定永遠在伺服器端;token 不進瀏覽器可見的儲存。
- 每一步演進保持「預設零依賴可跑」:無 DB 時聊天走記憶體、筆記走記憶體,是刻意的開發體驗,不要移除。
