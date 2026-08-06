# 架構演進 Roadmap

目標藍圖來自「低延遲多人在線跨部門協作」技術棧文件:即時能力拆成四個平面 —— **WebRTC**(媒體)、**WebSocket**(業務事件)、**CRDT**(共同編輯)、**REST**(持久化與查詢),各平面獨立擴張,不互相塞流量。本文件把該藍圖對應到本 codebase 的現況與演進順序。

## 現況(已完成)

| 平面 | 藍圖建議 | 目前實作 | 差距 |
|---|---|---|---|
| 媒體 | LiveKit SFU + coturn | 模式切換:預設 mesh(≤8),SFU 疊加層走 LiveKit(上限 50) | 尚無 coturn/TURN fallback、simulcast 調優 |
| 業務事件 | Spring WebSocket(STOMP)+ Redis/Kafka backplane | 自訂 JSON envelope(`SignalMessage`)單節點 | 單節點夠用;水平擴展需 backplane |
| 共同編輯 | TipTap/ProseMirror + Yjs + Hocuspocus + Postgres | ✅ 同組合:`collab/` 服務,快照落 `collab_document` | 尚未做 update log / snapshot compaction |
| 持久化 | PostgreSQL 為 source of truth | 聊天(`chat_message`)與筆記快照(`collab_document`)入 Postgres | 無 Flyway、無 outbox |
| 前端 | Vue 3 生態系 + Konva 白板 | React 18(既有投資,不重寫)+ Konva 白板 ✅ | 刻意偏離框架;白板已落地(筆畫/便利貼 durable、游標/進行中筆畫 ephemeral) |

## 演進順序(建議)

1. ~~**CRDT 平面強化**~~ ✅ 已完成:awareness 節流(~25 Hz)、update 大小上限(512 KB)、文件尺寸上限(5 MB)、每連線訊息速率上限(120/s)、`collab_update` 日誌 + debounce 快照 compaction。
2. **認證授權** ✅ 大致完成:OIDC Resource Server(`oidc` profile)、collab JWT 驗證、前端 PKCE 登入 + **silent renew**(refresh token 單次使用輪替)、WS **逐訊息 token 過期強制**(4401 切斷)、LiveKit token 簽發、`docker-compose.oidc.yml` overlay(devidp 為開發用 IdP,正式環境以 `OIDC_*` env 換成 Keycloak/Entra)。尚餘(刻意遞延):資源層級授權(部門/專案 ACL——需要先有那些領域物件)、真實 IdP 對接演練。
3. **SFU 遷移** ✅ 大致完成:`docker-compose.sfu.yml` 疊加層導入 LiveKit,前端 `SfuRoom`(與 mesh 同介面,由後端 `/api/media/config` 決定模式)、後端房間限定 token 簽發、信令上限放寬到 50、**simulcast + adaptiveStream + dynacast**;mesh 路徑的 coturn/TURN fallback(`docker-compose.turn.yml`)。**錄影 ✅**(`docker-compose.recording.yml`:LiveKit Egress room-composite → MinIO,webhook 驗簽 → `meeting.recording.completed` 事件)。尚餘(刻意遞延):TURN/TLS 443(需真實憑證)。
4. **水平擴展 backplane** ✅ 部分完成:`Backplane` 抽象(預設單機 no-op),`redis` profile 將成員目錄移入 Redis(節點心跳 + 惰性 ghost 清理)、跨節點訊息走 Pub/Sub、房間上限原子化(本地 compute / Redis Lua);collab 以 `extension-redis` 多實例同步;`docker-compose.scale.yml` 跑 backend×2 + collab×2;**Kafka + transactional outbox**(`kafka` profile + Redpanda overlay,at-least-once + eventId 去重;事件:chat.message.created、participant.joined/left、document.snapshot.created)+ **消費端範例 `indexer/`**(audit_log 稽核軌跡 + message_search 全文檢索讀模型,`GET /api/search/messages`)。另有**事件信封契約**(`docs/contracts/warroom-event.schema.json`,indexer 以 ajv 強制,違約 = 毒訊息)。**會議領域與事件 ✅**(`meetings` 表 + `meeting.started`/`meeting.ended`/`participant.rejected`,backplane 回傳叢集人數保證第一人/最後一人判定)。**Redis Sentinel 高可用 ✅**(`docker-compose.ha.yml` 疊在 scale 之上:master + replica + 3 Sentinel quorum 2;後端 `redisha` profile 走 `spring.data.redis.sentinel.*`、collab ioredis 走 Sentinel;`tests/ha/failover-drill.sh` 實測殺 master 後自動升級,信令/CRDT 不中斷)。尚餘(刻意遞延):Redis Cluster(資料分片規模需求出現時)、託管 Schema Registry(多團隊時)、OpenSearch 取代 Postgres FTS(搜尋規模需求出現時)。
5. **可觀測性** ✅ 大致完成:backend/collab/indexer Prometheus 指標、**OTLP 分散式追蹤 → Tempo**(overlay 啟用,Grafana datasource 已接)、**LiveKit WebRTC 品質指標**接入 scrape、**Grafana dashboard** 與**告警規則**(target down / backlog / 拒連 / 處理延遲 SLO)。尚餘:Alertmanager 通知路由、更完整的 dashboard 面板。
6. **資料層治理** ✅ 部分完成:Flyway 管 schema(V1 聊天、V2 collab 表;Hibernate 改 `validate`,既有資料庫 baseline 接軌)。尚餘:訊息全文檢索(OpenSearch)按需求再進。

7. **壓測與混沌** ✅(藍圖 §十):`tests/load/` k6 信令壓測(SLO 門檻化,400 VU/1.3k msg/s 全綠;首輪即抓到並修復兩個廣播併發競態)+ `tests/chaos/` Toxiproxy(延遲注入無丟失、斷線後成員清理與重連)。詳見 `docs/runbooks/load-testing.md`。尚餘:目標環境的藍圖級工作負載(20k 連線)、LiveKit RTC 負載測試、Yjs replay 壓測。

8. **備份與 DR** ✅(藍圖 §十一,本機形態):backup 疊加層(WAL 歸檔)+ `tests/dr/` 一鍵 PITR 還原演練(災前/災後標記、CRDT snapshot⊕log 重建 hash 比對;首次演練即抓到歸檔權限缺陷並修復)。詳見 `docs/runbooks/disaster-recovery.md`。尚餘:物件儲存歸檔、跨區域備份、備份加密(部署層)。

## 原則(照藍圖)

- WebRTC 只載媒體;WebSocket 只載控制與業務事件;CRDT 只載共同編輯;不要把所有即時需求塞進單一通道。
- Durable(文件、聊天、稽核)進 Postgres;ephemeral(游標、presence、typing)只 relay、最多進 Redis + TTL,不落 DB。
- 權限判定永遠在伺服器端;token 不進瀏覽器可見的儲存。
- 每一步演進保持「預設零依賴可跑」:無 DB 時聊天走記憶體、筆記走記憶體,是刻意的開發體驗,不要移除。
