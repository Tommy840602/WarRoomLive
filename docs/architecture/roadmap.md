# 架構演進 Roadmap

目標藍圖來自「低延遲多人在線跨部門協作」技術棧文件:即時能力拆成四個平面 —— **WebRTC**(媒體)、**WebSocket**(業務事件)、**CRDT**(共同編輯)、**REST**(持久化與查詢),各平面獨立擴張,不互相塞流量。本文件把該藍圖對應到本 codebase 的現況與演進順序。

## 現況(已完成)

| 平面 | 藍圖建議 | 目前實作 | 差距 |
|---|---|---|---|
| 媒體 | LiveKit SFU + coturn | WebRTC full mesh(≤8 人硬上限) | 小群組內等價;超過 ~8 人需 SFU |
| 業務事件 | Spring WebSocket(STOMP)+ Redis/Kafka backplane | 自訂 JSON envelope(`SignalMessage`)單節點 | 單節點夠用;水平擴展需 backplane |
| 共同編輯 | TipTap/ProseMirror + Yjs + Hocuspocus + Postgres | ✅ 同組合:`collab/` 服務,快照落 `collab_document` | 尚未做 update log / snapshot compaction |
| 持久化 | PostgreSQL 為 source of truth | 聊天(`chat_message`)與筆記快照(`collab_document`)入 Postgres | 無 Flyway、無 outbox |
| 前端 | Vue 3 生態系 | React 18(既有投資,不重寫) | 刻意偏離:框架差異不影響架構分層 |

## 演進順序(建議)

1. ~~**CRDT 平面強化**~~ ✅ 已完成:awareness 節流(~25 Hz)、update 大小上限(512 KB)、文件尺寸上限(5 MB)、每連線訊息速率上限(120/s)、`collab_update` 日誌 + debounce 快照 compaction。
2. **認證授權** ✅ 部分完成:OIDC Resource Server(`oidc` profile)、collab JWT 驗證、前端 PKCE 登入、`docker-compose.oidc.yml` overlay(devidp 為開發用 IdP,正式環境以 `OIDC_*` env 換成 Keycloak/Entra)。尚餘:token 過期後的 silent renew 與連線 re-auth、join/publish 逐事件授權(目前為連線層)、LiveKit token 簽發(隨 SFU 一起做)。
3. **SFU 遷移**:房間規模需求超過 ~8 人時導入 LiveKit(自架或雲端),前端以 LiveKit Client SDK 取代 `WebRtcRoom` mesh;屆時移除 `max-room-size` 與前端警告(CLAUDE.md 有標記)。coturn 供 TURN fallback。
4. **水平擴展 backplane**:`RoomManager` 的房間成員狀態移到 Redis;跨節點事件用 Redis Pub/Sub 起步,業務事件成長後改 Kafka + transactional outbox。
5. **可觀測性**:OpenTelemetry + Prometheus 指標(WebSocket 連線數、訊息延遲、CRDT update 速率、房間人數),先於任何多節點部署。
6. **資料層治理**:Flyway 管 schema(取代 `ddl-auto: update` 與 collab 服務的 `CREATE TABLE IF NOT EXISTS`)、訊息全文檢索(OpenSearch)按需求再進。

## 原則(照藍圖)

- WebRTC 只載媒體;WebSocket 只載控制與業務事件;CRDT 只載共同編輯;不要把所有即時需求塞進單一通道。
- Durable(文件、聊天、稽核)進 Postgres;ephemeral(游標、presence、typing)只 relay、最多進 Redis + TTL,不落 DB。
- 權限判定永遠在伺服器端;token 不進瀏覽器可見的儲存。
- 每一步演進保持「預設零依賴可跑」:無 DB 時聊天走記憶體、筆記走記憶體,是刻意的開發體驗,不要移除。
