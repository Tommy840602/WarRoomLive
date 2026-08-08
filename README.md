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
- **身分由伺服器決定,不是客戶端自報**:開了 `oidc` 之後,WebSocket 握手就把 JWT 的 subject 與 IdP 認可的顯示名稱記在連線上;`join` 時**以 IdP 的名稱覆蓋客戶端送來的**。顯示名稱是房間裡所有人用來判斷「我在跟誰講話」的東西,如果登入的使用者還能自己取任意名字,那登入就只證明了「有權限進來」,對身分毫無意義。subject 跟著進 backplane 的成員目錄,所以連線之外(例如一個 HTTP 請求)也能對「這是誰」做判斷——刪除錄影與刪除檔案因此可以**限房間主持人**。沒有 IdP 時沒有 subject,一切照舊,零依賴預設不受影響。subject 不會放進 `PeerInfo`:房間需要看到名字,不需要看到別人的帳號識別碼。
- **濫用防護(三個平面對稱)**:信令平面有每連線 token bucket(預設 60/s,允許 2 倍突發,所以「加入房間 + 一連串 ICE candidate」不會被誤擋)、容器層的訊框上限(64 KB)、以及聊天長度上限(4000 字,**在寫入資料庫之前**檢查);CRDT 平面本來就有訊息速率/單筆更新/文件大小三重上限;HTTP API 用同一個 token bucket 以來源位址計(預設 20/s + 2 倍突發)。處置方式依意圖不同:信令超速**丟棄該訊息**(突發多半是程式錯誤或網路問題,斷線會連帶讓聊天、presence、協商一起死)、過長聊天**明確回錯**(絕不截斷——發送者必須知道沒送出去)、超大訊框由容器直接以 1009 關閉、HTTP 超量回 **429 + Retry-After**(呼叫端在等答案,可以被告知退讓)。每種拒絕都有指標(`warroomlive.signaling.messages.in`、`warroomlive.api.rejected`)。
  HTTP 這道**跑在認證之前**——洪水應該在讓伺服器驗簽章、抓 IdP 的 JWKS 之前就被擋掉。來源位址取 `X-Forwarded-For` 的**最後一段**(nginx 附加在後面的那段);前面的是客戶端自己塞的、可以偽造,取第一段等於讓任何人每次請求都換一個新額度。健康檢查、`/api/auth/config`、自我認證的 LiveKit webhook 豁免。
- **清單端點都是分頁**:`/api/recordings/{room}` 與 `/api/search/messages` 收 `limit`/`offset`(預設 50、上限 200,越界夾住而非報錯)。
- **資料保留**:錄影(連同 MP4)、共享檔案(連同物件)、聊天(連同全文檢索投影)、待辦與行事曆、稽核軌跡、已發布的 outbox 列都有可設定的保留期,每小時分批清理。**預設全部是 0 = 永久保留**——部署當下就開始刪資料是很糟的驚喜,由維運者用 `RETENTION_*_DAYS` 逐項開啟。未發布的 outbox 列永不刪(那是佇列不是歷史);聊天與其搜尋投影共用同一期限,否則搜尋會回傳資料庫已經沒有的內容。
- **連線品質與弱網處理**:每 2 秒量測與每位成員之間的連線(RTT、封包遺失、抖動),在成員名單以訊號格顯示良好/普通/不佳。**持續**不佳時只降低送給該位成員的視訊碼率與解析度——一個人網路差不該拖累其他人;恢復判定刻意比降級慢,避免網路抖動造成畫質反覆跳動。連線被瀏覽器判定 `failed` 時(例如換網路)自動做 ICE 重啟,由 peer id 較小的一方發起以避免雙方相撞。SFU 模式直接採用 LiveKit 的連線品質評級,降級交給既有的 adaptiveStream/dynacast。
- **斷線自動重連**:筆電休眠、Wi-Fi 切換或後端重啟都會切斷信令連線。前端以指數退避(上限 10 秒、帶抖動)自動重連,期間顯示提示橫幅並暫停聊天輸入;連線恢復後自動重新加入房間、重送音視訊與舉手狀態,並依伺服器回傳的最新成員清單重建畫面(mesh 模式重建 peer connection;SFU 模式的媒體走 LiveKit 自己的連線,不受影響)。**被主持人移出(4403)與主動離開不會重連**——否則等於繞過伺服器的決定。共享筆記與白板本來就會自癒,所以重連只需處理信令平面。
- **房間權限(主持人 / 鎖定 / 踢人)**:開房者即主持人(👑,離開時自動交接給最資深成員);只有主持人能 **鎖定房間**(🔒 之後新成員以 `room-locked` 被拒,既有成員重連不受影響)與 **移出成員**(對方收到 `kicked` 通知後連線以 4403 關閉)。授權全部在伺服器端驗證——訊息的 `from` 必須等於該連線 join 時的身分,再比對 backplane 中的房間主持人;房間 meta(`room-state`:host + locked)在加入時下發、變更時廣播,多節點部署下由 Redis 原子維護。相應稽核事件:`participant.kicked`、`room.locked`、`room.unlocked`。
- **聊天記錄持久化**:聊天訊息存進倉儲,加入房間時以 `history` 訊息重播最近記錄(重整或晚到都看得到)。倉儲有兩種實作,以 Spring profile 切換:
  - 預設(無 profile):記憶體環形緩衝(每房最近 `warroomlive.chat.history-limit` 則,預設 100),零依賴,伺服器重啟後消失。
  - `postgres` profile:Spring Data JPA + PostgreSQL,跨重啟耐久。啟用:`SPRING_PROFILES_ACTIVE=postgres`,並提供 `DB_URL` / `DB_USER` / `DB_PASSWORD`。Schema 由 **Flyway** 管理(`backend/src/main/resources/db/migration/`,含 collab 服務的表),Hibernate 只做 `validate`;既有資料庫以 baseline 無縫接軌。
- **共享檔案**:房間側邊可以直接丟檔案給大家(預設上限 25 MB)。**位元組不經過後端**——後端只簽一條短效的 URL,瀏覽器直接 PUT 到物件儲存,下載也是即時簽發的 GET。上傳完成才寫入資料庫列(有列沒物件是壞掉的下載;有物件沒列只是看不到,會被保留期掃掉)。物件 key 由伺服器決定並固定在 `attachments/<房名>/` 之下,確認時檢查前綴,所以別的房間的檔案塞不進來。大小上限查兩次:簽章前看宣告值,確認時看**實際存進去的大小**——預簽 PUT 本身沒辦法限制大小,少了第二次檢查上限就只是建議。上傳完成會經信令通知房內所有人,清單即時更新。
- **一份議程,不是待辦加行事曆**:側邊只有一個「議程」面板。**待辦和行事曆本來就不是兩種東西**——差別在於這個項目帶了哪些面向(Chandler 說的 stamp):有人要做它,就能勾掉;它佔用一段時間,就是約會;兩者可以同時成立。所以面向是從項目本身讀出來的,不是從它存在哪張表讀出來的。項目分成三個 **triage** 區段:**現在 / 稍後 / 完成**。這不是優先級也不是期限——「重要」和「週五到期」是工作的屬性,大家各自解讀;「現在還是稍後」則是一個房間真的做得出來的決定。
- **時鐘提議,房間決定**:沒有人表態時,區段由項目的時間自動判定(一天以內算「現在」,沒有時間的算「稍後」——把沒排時間的事推到正在處理事故的人面前,是「現在」這一欄變成雜訊的原因)。任何人可以覆寫,**覆寫存在資料庫、對全房間生效**——戰情室裡「這件事現在要處理」是共識,不是個人檢視。自動判定中的項目畫虛線圈,已經有人決定的畫實線:「沒人看過」和「房間決定了」是兩回事,會自動分類的看板必須說得出是哪一種。右鍵把項目交還給時鐘。triage **不發事件**——它是一天會改好幾次的意見,而事件骨幹記的是工作的事實;**「完成」則永遠不存進 triage 欄**,而是變成一筆有時間有作者的完成記錄,免得「做完了」有兩份會互相打架的副本。
- **行事曆是時間格線**(像 Google 日曆):日欄 × 小時列、事件是有高度的區塊、同時發生的並排、一條紅色的「現在」線、今天的日期用主色圈起來。**依日分組的清單答得出「週四有什麼」,答不出「週四下午有沒有空」**——空檔沒有列,而區塊之間的縫隙正是一個房間在找時段時真正在看的東西。跨午夜的項目在兩天都畫得出來,後面那天標上 `↳`;沒有長度的項目給它一個按得到的最小高度,但**不會因此長過午夜**。要顯示幾天由**量出來的面板寬度**決定,不是媒體查詢——這個面板可以拉,媒體查詢量的是錯的東西。七欄大約需要 640px,所以下面那條分隔線很重要。沒有時間的項目放不上格線,所以它明說還有幾個在清單檢視。
- **版面可以拉**:影像區與側邊面板之間有一條分隔線,拖曳就能調整——把面板拉寬,行事曆就從三天變成完整的一週。可以用左右方向鍵移動(只能用滑鼠調的版面,等於只有一部分人調得動),雙擊回到預設。影像磚另有獨立的縮放控制(五段),浮在影像上而不是放在房間控制列裡:**它改變的是這個螢幕看到什麼,不是別人看到什麼**。兩者都存在 localStorage,不走信令平面——這跟 triage 剛好相反,而且理由也剛好相反。
- **底層仍是資料庫,不是 Yjs**:筆記與白板是自由文字與圖形的並行編輯;議程項目是有負責人、期限、完成時間的**業務紀錄**,人們會查它、稽核它,而且它活得比這場會議久。CRDT 查不了、驗不了、也進不了事件骨幹。新增與 triage 人人可做(只有主持人能動的議程不叫共用),刪除限主持人。任何變更都經信令通知房內,對方不用重整就會看到。
- **會議紀錄與匯出**:側邊的「紀錄」面板列出這個房間開過的每一場會議——什麼時候、多久、最多幾個人。**這些列從會議領域上線那天就一直在寫,而在此之前沒有任何地方讀得到它**,房間答不出關於自己的「上次我們開了多久」。每一列可以把整場會議匯出成一份 Markdown:聊天、議程、共同筆記、共享檔案、錄影。散會之後,一個戰情室原本什麼都不留,只留下五個沒有人會一起打開的地方。
- **匯出對自己能做什麼是誠實的**:聊天、檔案、錄影帶著自己的時間,所以會**框到那場會議**;議程不會——一件在這場會議提出、下場會議關掉的事屬於兩場,所以匯出的是房間目前的議程,並且**標明是目前狀態**。共同筆記是一個房間一份 Yjs 文件、不是一場會議一份,所以同樣是目前內容而不是當時快照,文件裡直說,而不是暗示一個它拿不出來的東西。筆記由 collab 服務提供(只有它有 Yjs 可以解那串 update),那個端點是內部的、nginx 不代理;讀不到就寫一行說讀不到,而不是安靜地少一段。
- **到期會通知**:期限到了,伺服器會告訴房間一次——**剛好一次**。只在你打開面板時才存在的期限,不是工具在幫你記的期限。`reminded_at` 與廣播在同一個交易裡提交:靠記憶體記住說過什麼的排程器,重啟後會全部重講,兩個節點則會各講一次。
- **訊息搜尋**:側邊可以搜尋聊天記錄(預設只搜這個房間,可切換成全部),結果分頁。資料來自 indexer 的讀模型,所以需要 events 疊加層在跑;沒啟用時會明說「沒有啟用訊息搜尋」,而不是回一個空結果——「沒有符合」跟「沒有索引」是兩件事。
- **一行輸入**:議程只有一個輸入框,整句寫進去就好——`寄簡報 @bob 明天15:00`、`對外說明稿定稿 週三14:00`、`與法務對齊 明天14:00-15:00`。負責人、日期、時間由前端從那一行解析出來(今天/明天/後天、週X/禮拜X/星期X、`HH:MM` 與 `HH點`、`M/D`、`N天後`/`N小時後`、以及**時段** `14:00-15:00`——**有結束時間就是約會,沒有就是待辦**,而送出前的預覽會直說是哪一種,所以一行輸入不會偷偷替你決定這是一場會議);**認不出來的字一律留在文字裡**,不會被吃掉。送出前把「解讀為」顯示回去,所以解析永遠不是事後才發現的猜測。會議進行中沒有人會 tab 過四個欄位,而那正是這份清單該被填的時刻。約會顯示時鐘時間(那是你要到場的時刻),待辦顯示還有多久(沒有人「到場」參加一個期限,他們只想知道那是不是今天的事);在清單檢視裡,不是今天的約會會帶上日期——單獨一個「16:37」是個沒辦法回答的問題。絕對時間放在 tooltip。
- **面板頁籤**:側邊面板一次只開一個,任何寬度都一樣。七個面板疊在 320px 的側欄裡,每個都只分到一條縫,誰都讀不完;手機上疊起來更糟,聊天輸入框會被推到影像下方好幾個畫面的地方,那正好是通話中沒有人會捲過去的位置。窄視窗另外收成單欄。
- **日夜主題**:同一個房間的兩種外觀,**預設跟著使用者本地時鐘走**(07:00 起日間、19:00 起夜間;計時器直接瞄準下一個交界而不是輪詢,筆電睡過黃昏後靠 `visibilitychange` 補上)。夜間是螢幕在沒開燈的房間裡的藍黑,日間是骨白而不是純白——戰情室不是文字編輯器,影像旁邊一整片純白等於一盞對著人照的燈;影像磚在兩種外觀下都維持全黑,否則臉的四周會亮出一圈白邊。跨過切換還認得出是同一個房間,靠的是同一個琥珀色主色(儀表指示燈的顏色),只調亮度。**作業系統偏好是不對稱處理的**:`prefers-color-scheme: dark` 是使用者主動選的(常常是無障礙需求),壓過時鐘;`light` 是什麼都沒設定時瀏覽器回報的預設值,不算表態,所以讓給時鐘。也可以手動固定日/夜——「跟著時鐘」是好的預設值、糟糕的規則:晚上九點要投影給客戶的人需要日間配色,而時鐘無從得知。選擇記在 localStorage。
- **共享白板**:與筆記同面板的「白板」分頁——畫筆(五色)、可拖動/雙擊編輯的便利貼、自己操作的復原(Yjs `UndoManager`,只回退本人變更)。畫完的筆畫與便利貼是 durable 狀態(落在同一份房間 Yjs 文件的 `board:*` 型別,沿用 collab 服務的持久化/限流/快照事件);**進行中的筆畫與游標走 ephemeral awareness**(~25Hz 節流、不落地)——藍圖 durable/ephemeral 分離的白板版。前端以 Konva(react-konva)渲染。
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

## 會議錄影(選用疊加層,疊在 SFU 之上)

```bash
docker compose -f docker-compose.yml -f docker-compose.sfu.yml -f docker-compose.recording.yml up --build
```

- 房間內(SFU 模式)出現「錄影」按鈕:後端呼叫 **LiveKit Egress** 的 twirp API 啟動 room-composite 錄影(headless Chrome 合成畫面),MP4 直接上傳 **MinIO**(S3 API,bucket `recordings`);LiveKit secret 與儲存憑證都不出後端。離開房間時自動停止。
- **錄影清單與播放**:錄完的影片會列在房間側邊(時間、長度、大小),點播放即在頁面內播。播放走**預簽 URL**——資料庫只存物件 key,每次點播放才即時簽發一條 30 分鐘有效的連結,物件儲存的憑證永遠不出後端,影音位元組也不經過後端(nginx 直接把請求轉給物件儲存)。webhook 寫入的錄影列與事件同交易提交,重送不會產生重複。
- **完成通知走 webhook**:LiveKit 以「body 雜湊 JWT」簽名回呼 `/api/livekit/webhook`(後端驗簽),搭配 events 疊加層時轉成 `meeting.recording.completed` 事件進骨幹。
- **刪除**:清單上每筆有刪除鍵(兩段式確認,不用會卡住整頁的 `confirm()`)。`DELETE /api/recordings/{room}/{id}` **先刪物件、再刪列**——物件刪不掉就把列留著等重試,反過來會留下沒人指得到的檔案。刪除會發 `meeting.recording.deleted` 事件,帶 `reason` 與 `actor`(有登入時是 JWT subject)。
- **會議領域**(`postgres` profile 自動啟用):第一人加入開啟 `meetings` 列、最後一人離開關閉(含時長與人數峰值);`meeting.started` / `meeting.ended` 與列同交易寫入 outbox。`Backplane.tryRegister/unregister` 回傳叢集人數,多節點下「第一人/最後一人」判定也精準。房間額滿的拒絕會發 `participant.rejected` 事件(權限類稽核)。

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
- **Token 生命週期**:devidp 發 refresh token(單次使用、每次輪替),前端 `automaticSilentRenew` 在到期前自動換新;後端在 WS 握手時記下 token 到期時間,**逐訊息檢查**——過期連線以 close code `4401` 切斷,client 需以新 token 重連。長連線不會比憑證活得久。

## TURN fallback(選用疊加層)

嚴格 NAT / 企業網路擋 UDP 直連時,mesh 通話可退到 coturn 中繼:

```bash
docker compose -f docker-compose.yml -f docker-compose.turn.yml up --build
```

後端把 relay 加進 `/api/media/config` 的 `iceServers`(`TURN_URLS` / `TURN_USERNAME` / `TURN_PASSWORD` 環境變數驅動,三者齊備才啟用;STUN 預設仍在)。瀏覽器 ICE 自動在直連失敗時改走 relay。對外部署時設 `TURN_PUBLIC_HOST` 為瀏覽器可達的位址,並更換預設帳密。SFU 模式的 ICE 由 LiveKit 自管,此疊加層針對 mesh 路徑。

## 水平擴展(選用疊加層):多節點信令 + 多實例協作

```bash
docker compose -f docker-compose.yml -f docker-compose.scale.yml up --build
# backend x2 + collab x2,經 Redis 共享房間與文件
```

- **後端 `redis` profile**:房間成員目錄移到 Redis(hash,每個成員記錄所在節點),跨節點訊息(offer/answer/candidate 的點對點轉發、chat/state/reaction 等廣播)走 Redis Pub/Sub;`Backplane` 介面隔離,預設 profile 仍是零依賴的單機實作。
- **節點崩潰自癒**:每個節點維護帶 TTL 的心跳鍵(15 秒),讀取房間成員時惰性清除「所在節點已死」的 ghost 成員。
- **collab 多實例**:`REDIS_HOST` 設定後以 `@hocuspocus/extension-redis` 跨實例同步 Yjs update 與 awareness;快照仍寫 PostgreSQL。
- **nginx 輪詢**:`/api`、`/ws`、`/ws/doc` 皆改為請求時 DNS 解析,docker DNS 將新連線輪流導向各副本;WebSocket 連線建立後黏在該副本上。
- **房間上限為原子判斷**:單機以 per-room `compute` 序列化、叢集以 Redis Lua script(計數 + 條件寫入一步完成),多節點同時加入也不會超額。

## Redis 高可用(選用疊加層,疊在水平擴展之上):Sentinel 自動故障轉移

```bash
docker compose -f docker-compose.yml -f docker-compose.scale.yml \
  -f docker-compose.ha.yml up --build
# Redis master + replica + 3 Sentinel(quorum 2);殺掉 master 約 5–15 秒自動升級
```

- **拓撲**:`redis`(初始 master)+ `redis-replica` + `sentinel-1/2/3`(`infrastructure/redis/sentinel.conf`,`down-after 5s`、`failover-timeout 15s`,hostname 模式)。單靠 scale 疊加層時 Redis 是單點,此疊加層補上這一塊。
- **後端(Lettuce)**:`redisha` profile(`application-redisha.yml`)改用 `spring.data.redis.sentinel.*`,透過 Sentinel 詢問當前 master,故障轉移後自動跟隨新 master;信令、房間目錄、心跳不需重啟即恢復。
- **collab(ioredis)**:`REDIS_SENTINEL_NODES` 設定後 `extension-redis` 改走 Sentinel 連線,CRDT 跨實例同步同樣自動跟隨。
- **演練**:`sh tests/ha/failover-drill.sh`(先 `npm --prefix tests/ha ci`)— 建立跨節點聊天與 CRDT 基線 → `docker kill` master → 驗證 Sentinel 升級 replica、既有連線恢復、新加入與 CRDT 同步全部繼續;演練後 `up -d` 會把舊 master 以 replica 身分接回。

## 事件骨幹(選用疊加層):Transactional Outbox + Redpanda

```bash
docker compose -f docker-compose.yml -f docker-compose.events.yml up --build
```

- 後端加上 `kafka` profile(需搭配 `postgres`):聊天訊息與其 `chat.message.created` 事件**在同一筆交易**寫入(`outbox_events` 表,V3 遷移),`OutboxPublisher` 每秒輪詢未發布列(`FOR UPDATE SKIP LOCKED`,多副本可並行不重工)推送到 Kafka 相容的 Redpanda(主題 `warroom.events`)。
- 語義為 **at-least-once**:broker 斷線只會累積 backlog(Prometheus 指標 `warroomlive_events_backlog`),恢復後按序補發;消費端須以信封中的 `eventId` 去重。信封含 `eventId` / `eventType` / `aggregateType` / `aggregateId` / `schemaVersion` / `occurredAt` / `payload`。
- 檢視事件:`docker compose ... exec redpanda rpk topic consume warroom.events --num 5`。
- **事件類型**:`chat.message.created`(與訊息同交易)、`participant.joined` / `participant.left`(信令層)、`document.snapshot.created`(collab 服務在快照交易內直接寫**同一張** outbox 表,由後端 publisher 統一發布)。
- **事件契約**:信封的 JSON Schema 在 `docs/contracts/warroom-event.schema.json`(indexer 內帶副本,CI 驗證兩檔一致);indexer 以 ajv 驗證每個信封,違反契約的訊息列為毒訊息計數後跳過。**Schema Registry**:events 疊加層開啟 Redpanda 內建的 registry(`:8081`),indexer 啟動時把內帶 schema 註冊到 subject `warroom.events-value`(相同內容不會產生新版本),之後以 registry 的 latest 版本編譯驗證器——契約的單一真實來源移到 registry,獨立演進的消費端會收斂到同一份契約;未設 `SCHEMA_REGISTRY_URL` 或 registry 不可達時退回內帶副本。
- **消費端範例(`indexer/`)**:訂閱 `warroom.events`,以 `event_id` 主鍵冪等寫入兩個可重建的讀模型——`audit_log`(全事件稽核軌跡)與 `message_search`(訊息全文檢索,Postgres FTS + GIN;之後可換 OpenSearch)。兩個投影在同一交易提交,offset 於寫入後才提交,毒訊息計數後跳過、DB 錯誤重試。查詢:`GET /api/search/messages?q=關鍵字&room=房名`(`postgres` profile;結果來自事件管線,需 events 疊加層在跑)。

## 可觀測性(選用疊加層)

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up --build
# Prometheus: http://localhost:9090   Grafana(匿名 Admin): http://localhost:3000
```

後端在 `/actuator/prometheus`(信令連線數、各類型訊息進出計數、處理耗時、房間/成員 gauge),collab 在 `/metrics`(update 計數與大小分佈、fetch/store 耗時、被拒連線計數、連線/開啟文件 gauge),indexer 在 `:9400/metrics`;與 SFU 疊加層併用時也抓 LiveKit 的 WebRTC 品質指標(`livekit:6789`)。皆不經 nginx 代理,只在 compose 網路內可達。

此疊加層還包含:
- **分散式追蹤**:後端以 OTLP 送 **Tempo**(overlay 設 `TRACING_ENABLED=true`;預設關閉零成本),Grafana 已接 Tempo datasource。
- **Grafana dashboard**「WarRoomLive Overview」自動 provision(連線數、訊息速率、CRDT update、事件 backlog/發布率等)。
- **告警規則**(`infrastructure/observability/alerts.yml`):scrape target down、outbox backlog 累積、collab 拒連暴增、信令處理超過 20ms SLO。
- **告警通知路由**(`infrastructure/observability/alertmanager.yml`,`:9093`):分組(alertname + severity)、critical 走快速通道(group_wait 5s)、**抑制規則**(某 job 的 scrape target 掛掉時,壓下同 job 的 warning 告警——它們的指標本來就已失真)。開發用接收端是 `alert-logger` webhook 容器,可用 `docker compose logs alert-logger` 直接看到通知送達;正式環境只換 receivers(Slack/Email/PagerDuty),路由樹不動。

## 測試(三層)

```bash
# 1. 單元測試 —— 唯一會在 CI 跑的前端測試
cd frontend && npm test

# 2. 端到端(黑箱,經 nginx 單一入口)
docker compose up -d
npm --prefix tests/e2e ci        # 只需一次
tests/e2e/run.sh                 # 自動挑選目前 stack 支援的套件
tests/e2e/run.sh signaling crdt  # 指定套件
tests/e2e/run.sh --all           # 含破壞性套件(殺服務驗恢復)

# 3. 瀏覽器層(真實 Chromium,假攝影機/麥克風)
npm --prefix tests/ui ci && npx --prefix tests/ui playwright install chromium
tests/ui/run.sh                  # media / collab / room-acl / quality
tests/ui/run.sh --all            # 再加上會重啟後端的 reconnect
```

**分層原則**:純邏輯與策略(重連的關閉碼規則、品質門檻與遲滯、主持人限定的介面)寫成單元測試進 CI;需要跑起來的 stack 才能驗的走 `tests/e2e/`;只有真實瀏覽器能回答的問題(聲音是否真的出得來、編輯器是否真的接上文件、控制項是否只給對的人)走 `tests/ui/`。詳見各自的 README。

所有套件都經由 nginx 單一入口(`:8088`)操作,和瀏覽器走同一條路徑,因此代理路由、profile 接線與疊加層拓撲都在測試範圍內。`run.sh` 依「目前實際在跑什麼」挑套件,所以同一行指令在基本 stack 與任何疊加層組合上都適用:

| 套件 | 需要 | 涵蓋 |
|---|---|---|
| `signaling` / `room-acl` / `crdt` / `capacity` | 任何 stack | 信令與成員事件、房間權限(主持人/鎖房/踢人)、CRDT 收斂、房間上限的原子性 |
| `limits` | 任何 stack | 三個平面的濫用防護:聊天長度、訊框上限、信令與 HTTP 的 token bucket(429 + Retry-After、健康檢查豁免、退讓後恢復)|
| `retention` | 任何 stack | 過期資料被刪、**新資料與未發布的 outbox 列必須活著**;有物件儲存時連 MP4 一起刪 |
| `recordings` | recording 疊加層 | webhook → 列 → 清單分頁 → 預簽播放 → 刪除(列與物件一起消失)|
| `oidc` / `token-lifecycle` | oidc 疊加層 | 兩個 WS 平面的認證強制;refresh 輪替與 token 過期後 4401 斷線 |
| `events` | events 疊加層 | 活動 → outbox → Redpanda → indexer → 讀模型 → 搜尋 API,以及重放去重 |
| `crdt-hardening` / `scale` | 破壞性 | 快照前崩潰的耐久性、超大更新拒絕與壓縮;跨 collab 副本收斂與節點死亡後的 ghost 清理 |
| `reconnect` | 任何 stack | 重連的伺服器端契約:突然斷線的廣播、重新加入不重複、被取代的 session 遲到的 close 不得踢掉活著的連線 |

瀏覽器層套件(`tests/ui/`):`media`(聲音是否真的播出來)、`collab`(筆記與白板同步)、`room-acl`(主持人限定介面、被踢者不得被重連帶回)、`quality`(品質指示)、`reconnect`(重啟後端後完整恢復)。詳細說明見 `tests/e2e/README.md` 與 `tests/ui/README.md`。

## 備份、DR 與壓測(選用疊加層 + 手動套件)

```bash
# WAL 歸檔 + PITR 還原演練
docker compose -f docker-compose.yml -f docker-compose.backup.yml up -d
tests/dr/restore-drill.sh

# 再疊上物件儲存歸檔(加密)後,改跑「只從 bucket 還原」的演練
docker compose -f docker-compose.yml -f docker-compose.backup.yml \
  -f docker-compose.backup-s3.yml up -d
tests/dr/restore-s3-drill.sh
```

- **備份與 DR**:backup 疊加層開 WAL 歸檔;backup-s3 疊加層再以 rclone `crypt` remote 把基礎備份與 WAL **客戶端加密**後同步進 MinIO(連檔名都是密文),還原演練完全只靠 bucket。詳見 `docs/runbooks/disaster-recovery.md`。
- **壓測**:`tests/load/`(k6 信令 SLO 壓測、`crdt-replay.mjs` CRDT 冷重建基準、`rtc-load.sh` LiveKit 媒體壓測)與 `tests/chaos/`(Toxiproxy)。實測數字與抓到的缺陷記在 `docs/runbooks/load-testing.md`。
- **Redis 故障轉移演練**:`tests/ha/failover-drill.sh`(見上方 HA 疊加層)。

以上皆不在 CI 跑,需對著實際跑起來的 stack 手動執行。

## 部署到已經有其他站台的機器

機器上 `:80`/`:443` 已經被別的站台的 reverse proxy 佔著時,用 `docker-compose.prod.yml`
而**不是** TLS 疊加層——後者會自己起一個 Caddy 綁那兩個 port,直接相撞。

```bash
cp .env.prod.example .env.prod && chmod 600 .env.prod   # DB_PASSWORD 必填
docker compose --env-file .env.prod \
  -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

- frontend **只綁 loopback**,由既有的 edge 轉進來;`infrastructure/edge/` 有 Caddy 與 nginx 兩份 site 設定可以直接抄。
- 少了 `DB_PASSWORD` 或 `PUBLIC_ORIGIN` 會**拒絕啟動**——這個 repo 到處是開發用預設密碼,用預設值跑在公開位址上不該因為「忘了」而發生。
- **多一層 proxy 會打壞 REST 限流**:後端取 `X-Forwarded-For` 的最後一段(單層拓撲下那是唯一偽造不了的),多一跳之後那段變成 edge 的位址,全世界共用一個額度。這個疊加層會掛上 `infrastructure/edge/real-ip.conf` 修正,runbook 裡有驗證指令。
- **媒體不走 edge**(SRTP/UDP,proxy 代理不了):mesh 不需要額外開 port,TURN 與 SFU 需要。

完整步驟(DNS、憑證、防火牆、升級、備份)見 [`docs/runbooks/deployment.md`](docs/runbooks/deployment.md)。

## 正式對外:HTTPS(TLS 反向代理,WarRoomLive 獨佔整台機器時)

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
