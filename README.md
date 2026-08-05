# WarRoomLive

低延遲、多人在線的跨部門協作討論室。前端 React (TypeScript) + 後端 Java Spring,即時通訊採用 **WebRTC**(音視訊/資料),並以 **WebSocket** 作為 signaling 通道。

## 架構總覽

```
frontend (React + Vite, :5173)                 backend (Spring Boot, :8080)
┌───────────────────────────┐                  ┌──────────────────────────────┐
│ App.tsx                    │   WS /ws/signal  │ SignalingHandler             │
│  └ WebRtcRoom (mesh)       │◀────────────────▶│  └ RoomManager (rooms/peers) │
│      └ SignalingClient     │   JSON envelopes │                              │
│ getUserMedia → RTCPeerConn │                  │ GET /api/health              │
└───────────────────────────┘                  └──────────────────────────────┘
        ▲   媒體(SRTP)直接在 peer 之間流動,不經過伺服器   ▲
        └──────────────────── WebRTC P2P ───────────────────┘
```

- **Signaling 伺服器不碰媒體**:只轉發 SDP offer/answer 與 ICE candidate,並廣播房間成員變化。
- **文字聊天**共用同一條 signaling WebSocket(`chat` 訊息類型),伺服器廣播給房間內其他人,發送者在本地端顯示自己的訊息。
- **成員名稱**:加入時可輸入顯示名稱,隨 `join` 送出;伺服器在 `peers`(id + name)與 `peer-joined` 事件中帶回,前端據此在視訊標籤與聊天中顯示名稱(未填則自動給訪客名)。
- **成員名單面板**:側邊即時顯示房間內所有在線成員(自己置頂),資料來自前端維護的 `peerId → 名稱` 對照表,隨 `peer-joined` / `peer-left` 更新。
- **螢幕分享**:以 `getDisplayMedia` 取得螢幕 track,透過 `RTCRtpSender.replaceTrack` 換掉每個 peer 的視訊 track,**不需重新協商**;停止時(或按瀏覽器內建的停止分享)自動換回攝影機。分享期間加入的新成員也會收到螢幕畫面。
- **靜音 / 關視訊**:本地切換 track 的 `enabled`,並透過 `state` 訊息把音視訊開關廣播給房間;其他成員的視訊標籤與成員名單會顯示對應圖示(🔇 / 📷)。新成員加入時,既有成員會重送一次自己的狀態,確保畫面同步。
- **表情反應 / 舉手**:`reaction` 訊息廣播即時 emoji(👍 ❤️ 😂 🎉 👏),畫面上浮出淡出動畫;`hand` 訊息廣播舉手開關(✋),在視訊標籤與成員名單持續顯示。舉手狀態同樣會在新成員加入時重送。
- **房間人數上限**:因 mesh 上行頻寬隨人數上升,後端對每間房設硬性上限(`warroomlive.signaling.max-room-size`,預設 8),額滿時以 `room-full` 拒絕加入;前端接近上限(6 人)顯示柔性警告橫幅。超過此規模應改用 SFU。
- **聊天記錄持久化**:聊天訊息存進倉儲,加入房間時以 `history` 訊息重播最近記錄(重整或晚到都看得到)。倉儲有兩種實作,以 Spring profile 切換:
  - 預設(無 profile):記憶體環形緩衝(每房最近 `warroomlive.chat.history-limit` 則,預設 100),零依賴,伺服器重啟後消失。
  - `postgres` profile:Spring Data JPA + PostgreSQL,跨重啟耐久。啟用:`SPRING_PROFILES_ACTIVE=postgres`,並提供 `DB_URL` / `DB_USER` / `DB_PASSWORD`。

## Docker 部署(完整 stack)

一鍵啟動 Postgres + 後端 + 前端(nginx),讓別人能實際連上:

```bash
docker compose up --build
# 開啟 http://localhost:8088(埠可用 FRONTEND_PORT 覆寫,如 FRONTEND_PORT=8091 docker compose up)
```

- `frontend`(nginx):服務前端靜態檔,並把 `/api` 與 `/ws`(含 WebSocket upgrade)反向代理到 `backend`,所以瀏覽器只需連前端這一個 origin。
- `backend`:以 `postgres` profile 執行,資料源指向 `db` 服務。
- `db`:PostgreSQL,資料存於具名 volume `pgdata`(`docker compose down -v` 才會清除)。

> 前端使用相對路徑與 `window.location.host` 組出 WebSocket URL,因此不論部署在哪個網域/埠都不需改設定。

## 正式對外:HTTPS(TLS 反向代理)

用 Caddy 當邊緣代理,自動取得憑證。這是**選用的疊加層**(`docker-compose.tls.yml`),不影響上面的簡易部署。

**正式環境**(真實網域,自動 Let's Encrypt,需 80/443 對外可達):

```bash
SITE_ADDRESS=warroom.example.com \
  docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build
# 開啟 https://warroom.example.com
```

**本機測試 TLS**(Caddy 內建自簽 CA,瀏覽器會警告是正常的):

```bash
HTTP_PORT=8081 HTTPS_PORT=8443 \
  docker compose -f docker-compose.yml -f docker-compose.tls.yml up --build
# 開啟 https://localhost:8443
```

啟用 TLS 疊加層後,前端不再直接對外(由 Caddy 終結 TLS 再轉給 nginx);頁面走 HTTPS 時,WebSocket 會自動使用 `wss`。對外公開時記得把 `WARROOMLIVE_SIGNALING_ALLOWED_ORIGINS` 收斂成實際網域。

## 使用 PostgreSQL 持久化(選用,直接跑後端)

```bash
docker run -d --name wrl-pg -e POSTGRES_USER=warroomlive -e POSTGRES_PASSWORD=warroomlive \
  -e POSTGRES_DB=warroomlive -p 5432:5432 postgres:16-alpine

cd backend
SPRING_PROFILES_ACTIVE=postgres \
DB_URL=jdbc:postgresql://localhost:5432/warroomlive DB_USER=warroomlive DB_PASSWORD=warroomlive \
mvn spring-boot:run
```

不帶 profile 執行則自動使用記憶體儲存,無需資料庫。
- **Full mesh 拓撲**:每個參與者與其他人各建立一條 `RTCPeerConnection`。小群組(約 6–8 人內)最簡單、延遲最低;規模再大時應改用 SFU。
- 開發時前端 Vite dev server 會把 `/api` 與 `/ws` 代理到後端 `:8080`,瀏覽器只需與 `:5173` 溝通。

Signaling 訊息格式(前後端共用)定義於 `frontend/src/signaling/types.ts` 與 `backend/.../signaling/SignalMessage.java`,新增訊息類型時兩邊要同步。

## 開發環境需求

- Java 21、Maven 3.9+
- Node 20+、npm 10+

## 後端(backend/)

```bash
cd backend
mvn spring-boot:run        # 啟動於 http://localhost:8080
mvn test                   # 執行測試
mvn -Dtest=SignalingHandlerIntegrationTest test   # 單一測試類別
mvn package                # 打包成可執行 jar(target/)
```

## 前端(frontend/)

```bash
cd frontend
npm install
npm run dev                # 開發伺服器 http://localhost:5173
npm run build              # 型別檢查 + 產出 dist/
npm run typecheck          # 只做型別檢查
```

## 本地端到端試跑

1. 一個終端機:`cd backend && mvn spring-boot:run`
2. 另一個終端機:`cd frontend && npm run dev`
3. 用兩個瀏覽器分頁開啟 http://localhost:5173,輸入相同房間名稱後各自「加入房間」,即可看到彼此的視訊。

> WebRTC 需要 `getUserMedia`,瀏覽器僅允許在 `localhost` 或 HTTPS 下使用攝影機/麥克風。
