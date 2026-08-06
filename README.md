# WarRoomLive

低延遲、多人在線的跨部門協作討論室。前端 React (TypeScript) + 後端 Java Spring,即時通訊分三個平面:**WebRTC**(音視訊媒體)、**WebSocket**(signaling 與業務事件)、**CRDT(Yjs)**(共同筆記協作編輯)。

## 架構總覽

```
frontend (React + Vite, :5173)                 backend (Spring Boot, :8080)
┌───────────────────────────┐                  ┌──────────────────────────────┐
│ App.tsx                    │   WS /ws/signal  │ SignalingHandler             │
│  └ WebRtcRoom (mesh)       │◀────────────────▶│  └ RoomManager (rooms/peers) │
│      └ SignalingClient     │   JSON envelopes │                              │
│  └ CollabNotes (TipTap)    │                  │ GET /api/health              │
│ getUserMedia → RTCPeerConn │                  └──────────────────────────────┘
└───────────┬───────────────┘                  collab (Hocuspocus/Yjs, :1234)
        ▲   │                  WS /ws/doc       ┌──────────────────────────────┐
        │   └───────────────────────────────────▶ Yjs CRDT sync + awareness    │
        │                     binary updates    │  └ snapshots → PostgreSQL    │
        │                                       └──────────────────────────────┘
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
- **房間人數上限**:因 mesh 上行頻寬隨人數上升,後端對每間房設硬性上限(`warroomlive.signaling.max-room-size`,預設 8),額滿時以 `room-full` 拒絕加入;前端接近上限(6 人)顯示柔性警告橫幅(僅 mesh 模式)。需要更大房間時改用 SFU 疊加層(見下方)。
- **聊天記錄持久化**:聊天訊息存進倉儲,加入房間時以 `history` 訊息重播最近記錄(重整或晚到都看得到)。倉儲有兩種實作,以 Spring profile 切換:
  - 預設(無 profile):記憶體環形緩衝(每房最近 `warroomlive.chat.history-limit` 則,預設 100),零依賴,伺服器重啟後消失。
  - `postgres` profile:Spring Data JPA + PostgreSQL,跨重啟耐久。啟用:`SPRING_PROFILES_ACTIVE=postgres`,並提供 `DB_URL` / `DB_USER` / `DB_PASSWORD`。
- **共同筆記(CRDT 協作編輯)**:房間內所有人同時編輯同一份筆記,採 Yjs CRDT 無衝突合併——前端 TipTap 編輯器 + `y-prosemirror`,經 `/ws/doc` 連到獨立的 **collab 服務**(Node + Hocuspocus)。游標與名稱走 ephemeral awareness(不落地,前端節流至 ~25 Hz);文件內容持久化到 PostgreSQL:每筆增量 update 先進 `collab_update` 日誌(崩潰也不掉字),debounce 後合併成 `collab_document` 快照並清掉已涵蓋的日誌(compaction)。單筆訊息(512 KB)、文件大小(5 MB)、每連線訊息速率(120/s)皆有上限,超限只斷開該連線。每個房間對應一份文件(`warroom:<房名>`)。

## Docker 部署(完整 stack)

一鍵啟動 Postgres + 後端 + collab 服務 + 前端(nginx),讓別人能實際連上:

```bash
docker compose up --build
# 開啟 http://localhost:8088(埠可用 FRONTEND_PORT 覆寫,如 FRONTEND_PORT=8091 docker compose up)
```

- `frontend`(nginx):服務前端靜態檔,並反向代理 `/api`、`/ws`(→ `backend`)與 `/ws/doc`(→ `collab`,含 WebSocket upgrade),所以瀏覽器只需連前端這一個 origin。
- `backend`:以 `postgres` profile 執行,資料源指向 `db` 服務。
- `collab`:Hocuspocus(Yjs)文件同步服務,文件快照持久化到同一個 `db`。
- `db`:PostgreSQL,資料存於具名 volume `pgdata`(`docker compose down -v` 才會清除)。

> 前端使用相對路徑與 `window.location.host` 組出 WebSocket URL,因此不論部署在哪個網域/埠都不需改設定。

## SFU 模式(選用疊加層):突破 8 人上限

預設媒體走瀏覽器間 full mesh(≤8 人)。掛上 SFU 疊加層後,媒體改經 **LiveKit**:每人只上傳一份,由 SFU 扇出,上行頻寬不再隨人數增長:

```bash
docker compose -f docker-compose.yml -f docker-compose.sfu.yml up --build
```

- 後端 `/api/media/config` 宣告 `sfu` 模式,前端據此改用 LiveKit Client SDK(`SfuRoom`,與 mesh 的 `WebRtcRoom` 同介面);未設定時一切照舊走 mesh——模式由後端決定,前端零設定。
- 後端 `/api/media/token` 以 API secret 簽發**限單一房間**的 LiveKit access token(HS256 video grant);secret 不出伺服器。啟用 `oidc` profile 時此端點自動要求登入。
- LiveKit 信令 WebSocket 由 nginx 代理在同 origin 的 `/livekit`;媒體(SRTP)直接走 SFU 的 RTC 埠(7881/tcp、7882/udp)。瀏覽器無法直達容器網路的環境(macOS/Windows 或對外部署)請在 `infrastructure/livekit/livekit.yaml` 設 `rtc.node_ip`。
- 房間人數上限(信令層)在此模式放寬到 50;聊天、筆記、表情、舉手等仍走原本的 signaling WebSocket,完全不受媒體傳輸方式影響。

## OIDC 認證(選用疊加層)

預設 stack 不需登入(零依賴開發體驗)。要求登入才能進房與共編:

```bash
docker compose -f docker-compose.yml -f docker-compose.oidc.yml up --build
# 開啟 http://localhost:8088 → 會先看到登入頁(測試帳號 alice/alice123、bob/bob123)
```

- **後端**加上 `oidc` profile 變成 OAuth2 Resource Server:除 `/api/health` 與 `/api/auth/config` 外全部要求有效 JWT;WebSocket 握手無法帶 header,token 以 `access_token` query 參數傳遞(RFC 6750)。
- **collab 服務**設定 `OIDC_ISSUER` 後,每條連線都要在 Hocuspocus 協定內附 JWT,否則不建立同步、拿不到任何文件內容。
- **前端**先打 `/api/auth/config`:未啟用就照舊直接進房;啟用則走 OIDC Authorization Code + PKCE(`oidc-client-ts`),登入後顯示名稱預填 IdP 的 `preferred_username`,token 自動附掛到信令與筆記連線。
- **devidp** 是隨附的**僅供開發** IdP(固定測試帳號、記憶體金鑰),掛在同一 origin 的 `/auth` 之下。整個系統只講標準 OIDC(discovery + JWKS)——正式環境把 `OIDC_ISSUER` / `OIDC_JWK_SET_URI` / `OIDC_CLIENT_ID` 指向 Keycloak / Entra ID 等真正的 IdP 即可(例如 Keycloak 以 `KC_HTTP_RELATIVE_PATH=/auth` 掛同路徑),移除 devidp 服務。
- 換網域/埠時設 `PUBLIC_ORIGIN`(預設 `http://localhost:8088`),JWT 的 `iss` 與前端 authority 都由它導出。

## 水平擴展(選用疊加層):多節點信令 + 多實例協作

```bash
docker compose -f docker-compose.yml -f docker-compose.scale.yml up --build
# backend x2 + collab x2,經 Redis 共享房間與文件
```

- **後端 `redis` profile**:房間成員目錄移到 Redis(hash,每個成員記錄所在節點),跨節點訊息(offer/answer/candidate 的點對點轉發、chat/state/reaction 等廣播)走 Redis Pub/Sub;`Backplane` 介面隔離,預設 profile 仍是零依賴的單機實作。
- **節點崩潰自癒**:每個節點維護帶 TTL 的心跳鍵(15 秒),讀取房間成員時惰性清除「所在節點已死」的 ghost 成員。
- **collab 多實例**:`REDIS_HOST` 設定後以 `@hocuspocus/extension-redis` 跨實例同步 Yjs update 與 awareness;快照仍寫 PostgreSQL。
- **nginx 輪詢**:`/api`、`/ws`、`/ws/doc` 皆改為請求時 DNS 解析,docker DNS 將新連線輪流導向各副本;WebSocket 連線建立後黏在該副本上。
- 已知取捨:房間人數上限的檢查在叢集模式下非原子(讀成員數與註冊是兩步),多節點同時加入可能短暫超額一兩人;收緊需 Lua script,已記錄於 `RedisBackplane`。

## 可觀測性(選用疊加層)

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up --build
# Prometheus: http://localhost:9090   Grafana(匿名 Admin): http://localhost:3000
```

後端在 `/actuator/prometheus`(信令連線數、各類型訊息進出計數、處理耗時、房間/成員 gauge),collab 在 `/metrics`(update 計數與大小分佈、fetch/store 耗時、被拒連線計數、連線/開啟文件 gauge)。兩者皆不經 nginx 代理,只在 compose 網路內可達。

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
- 開發時前端 Vite dev server 會把 `/api`、`/ws` 代理到後端 `:8080`、`/ws/doc` 代理到 collab 服務 `:1234`,瀏覽器只需與 `:5173` 溝通。

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

## Collab 服務(collab/)

```bash
cd collab
npm install
npm start                  # Hocuspocus 於 ws://localhost:1234
```

啟動時若連得上 PostgreSQL 就持久化文件快照;連不上則自動降級為純記憶體(與後端聊天儲存同一哲學)。環境變數:`PORT`(預設 1234)、`DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD`(預設對應本機 `warroomlive`)。

## 本地端到端試跑

1. 一個終端機:`cd collab && npm start`(共同筆記;不啟動它其餘功能照常)
2. 一個終端機:`cd backend && mvn spring-boot:run`
3. 另一個終端機:`cd frontend && npm run dev`
4. 用兩個瀏覽器分頁開啟 http://localhost:5173,輸入相同房間名稱後各自「加入房間」,即可看到彼此的視訊,並在下方「共同筆記」同時編輯。

> WebRTC 需要 `getUserMedia`,瀏覽器僅允許在 `localhost` 或 HTTPS 下使用攝影機/麥克風。
