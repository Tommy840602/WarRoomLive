# 架構演進 Roadmap

目標藍圖來自「低延遲多人在線跨部門協作」技術棧文件:即時能力拆成四個平面 —— **WebRTC**(媒體)、**WebSocket**(業務事件)、**CRDT**(共同編輯)、**REST**(持久化與查詢),各平面獨立擴張,不互相塞流量。本文件把該藍圖對應到本 codebase 的現況與演進順序。

## 現況(已完成)

| 平面 | 藍圖建議 | 目前實作 | 差距 |
|---|---|---|---|
| 媒體 | LiveKit SFU + coturn | 模式切換:預設 mesh(≤8),SFU 疊加層走 LiveKit(上限 50) | 尚無 coturn/TURN fallback、simulcast 調優 |
| 業務事件 | Spring WebSocket(STOMP)+ Redis/Kafka backplane | 自訂 JSON envelope(`SignalMessage`)單節點 | 單節點夠用;水平擴展需 backplane |
| 共同編輯 | TipTap/ProseMirror + Yjs + Hocuspocus + Postgres | ✅ 同組合:`collab/` 服務,快照落 `collab_document` | 尚未做 update log / snapshot compaction |
| 持久化 | PostgreSQL 為 source of truth | 聊天(`chat_message`)與筆記快照(`collab_document`)入 Postgres | 無 Flyway、無 outbox |
| 前端 | Vue 3 生態系 | React 18(既有投資,不重寫) | 刻意偏離:框架差異不影響架構分層 |

## 演進順序(建議)

1. ~~**CRDT 平面強化**~~ ✅ 已完成:awareness 節流(~25 Hz)、update 大小上限(512 KB)、文件尺寸上限(5 MB)、每連線訊息速率上限(120/s)、`collab_update` 日誌 + debounce 快照 compaction。
2. **認證授權** ✅ 部分完成:OIDC Resource Server(`oidc` profile)、collab JWT 驗證、前端 PKCE 登入、`docker-compose.oidc.yml` overlay(devidp 為開發用 IdP,正式環境以 `OIDC_*` env 換成 Keycloak/Entra)。尚餘:token 過期後的 silent renew 與連線 re-auth、join/publish 逐事件授權(目前為連線層)、LiveKit token 簽發(隨 SFU 一起做)。
3. **SFU 遷移** ✅ 部分完成:`docker-compose.sfu.yml` 疊加層導入 LiveKit,前端 `SfuRoom`(與 mesh 同介面,由後端 `/api/media/config` 決定模式)、後端房間限定 token 簽發、信令上限放寬到 50;mesh 路徑的 coturn/TURN fallback(`docker-compose.turn.yml`)。尚餘:simulcast/adaptive stream 調優、錄影、TURN/TLS 443。
4. **水平擴展 backplane** ✅ 部分完成:`Backplane` 抽象(預設單機 no-op),`redis` profile 將成員目錄移入 Redis(節點心跳 + 惰性 ghost 清理)、跨節點訊息走 Pub/Sub、房間上限原子化(本地 compute / Redis Lua);collab 以 `extension-redis` 多實例同步;`docker-compose.scale.yml` 跑 backend×2 + collab×2;**Kafka + transactional outbox**(`kafka` profile + Redpanda overlay,`chat.message.created` 起步,at-least-once + eventId 去重)。尚餘:更多事件類型(成員/會議/文件)、消費端範例(audit / search indexer)、Redis Cluster/Sentinel 高可用、Schema Registry。
5. **可觀測性** ✅ 部分完成:backend `/actuator/prometheus` + collab `/metrics`(連線數、訊息進出、處理耗時、CRDT update 速率/大小、房間人數),`docker-compose.observability.yml` 疊加層(Prometheus + Grafana)。尚餘:OpenTelemetry 分散式追蹤(OTLP)、WebRTC 品質指標(packet loss / RTT,可由 LiveKit Prometheus 端點接入)、告警規則。
6. **資料層治理** ✅ 部分完成:Flyway 管 schema(V1 聊天、V2 collab 表;Hibernate 改 `validate`,既有資料庫 baseline 接軌)。尚餘:訊息全文檢索(OpenSearch)按需求再進。

## 原則(照藍圖)

- WebRTC 只載媒體;WebSocket 只載控制與業務事件;CRDT 只載共同編輯;不要把所有即時需求塞進單一通道。
- Durable(文件、聊天、稽核)進 Postgres;ephemeral(游標、presence、typing)只 relay、最多進 Redis + TTL,不落 DB。
- 權限判定永遠在伺服器端;token 不進瀏覽器可見的儲存。
- 每一步演進保持「預設零依賴可跑」:無 DB 時聊天走記憶體、筆記走記憶體,是刻意的開發體驗,不要移除。
