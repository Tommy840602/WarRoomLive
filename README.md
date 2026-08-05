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
