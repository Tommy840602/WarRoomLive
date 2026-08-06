# 壓力測試與混沌測試 Runbook

藍圖第十章的落地:k6 打信令平面、Toxiproxy 注入網路故障。兩套皆以腳本化斷言收斂(紅了就非零退出),適合在發版前手動跑;CI 不跑(重負載)。

## 負載測試(`tests/load/`)

```bash
docker compose up -d          # 任意疊加層組合
tests/load/run.sh             # 預設:120 VUs、每房 4 人、每人 2 秒 1 則聊天
VUS=400 CHAT_INTERVAL_MS=1000 HOLD=120s tests/load/run.sh   # 加壓
```

每個 VU 開一條 WebSocket、加入共享房間並定時聊天;延遲由 payload 內嵌時間戳計算(所有 VU 同進程、同時鐘):

| 指標 | 意義 | 門檻(藍圖 SLO) |
|---|---|---|
| `warroom_join_rtt` | join 送出 → `peers` 回覆 | P95 < 250ms |
| `warroom_chat_rtt` | 任一 VU 送出 → 房內另一 VU 收到 | P95 < 150ms、P99 < 300ms |
| `warroom_errors` | 伺服器 `error` 回覆或連線層錯誤 | 必須為 0 |
| `warroom_room_full` | 容量拒絕(工作負載迭代交界的預期行為) | 觀察用 |

### 本次基準結果(沙箱單機,2026-08-06)

| 情境 | 送達速率 | chat RTT p95/p99 | join p95 | 錯誤 |
|---|---|---|---|---|
| 120 VUs、2s 間隔 | ~149 msg/s | 4ms / — | 16ms | 0 |
| 400 VUs、1s 間隔 | ~1337 msg/s | 5ms / 10ms | 11ms | 0 |

皆遠低於 SLO 門檻;單機瓶頸未觸及。

### 壓測抓到並已修復的缺陷

第一輪 400 VU 即暴露兩個併發競態(15–17 條連線被 1011 斷線):

1. 廣播對象的 session 恰在關閉時,`sendMessage` 拋出的 `IllegalStateException` 未被接住,往上冒泡導致**發送者**被斷線;
2. 併發清理下 `send()` 退回裸 session 寫入,造成 `TEXT_PARTIAL_WRITING` 幀交錯。

兩者均修於 `SignalingHandler.send()`(只經 decorator 寫、接住 per-recipient 競態);修復後 400 VU 錯誤歸零。

## 混沌測試(`tests/chaos/`)

```bash
docker compose up -d
tests/chaos/run.sh
```

Toxiproxy 插在客戶端與 backend 之間,7 項斷言:

- **基準**:經 proxy 與直連的兩人同房,聊天送達 ~2ms;
- **+200ms 延遲注入**:5/5 訊息全數送達(無丟失),送達延遲精確平移(2.2ms → 199.6ms);
- **粗暴斷線**(disable proxy):倖存者數秒內收到 `peer-left`、被切斷者直連重加入看到乾淨成員名單(無自身殘影)、聊天立即恢復。

## CRDT 重播壓測(`tests/load/crdt-replay.mjs`)

```bash
docker compose up -d
npm --prefix tests/load install          # 首次
DB_HOST=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' warroomlive-db-1) \
  node tests/load/crdt-replay.mjs 200 1000 5000 20000
```

量測「冷啟動重建一份房間文件」要多久——每次文件無人持有後再被開啟、以及 DR 演練的驗證,付的都是這個成本。每個規模量兩次:**壓縮前**(快照尚未落地,update log 保有全部未壓縮列,等同崩潰後重建的最壞情況)與**壓縮後**(去抖動快照已寫入並裁掉 log 的穩態)。播種走真實 `/ws/doc` 路徑,並以每 25 次編輯一個 Yjs transaction 節流,尊重服務端 120 msg/s 的速率上限。

單機 compose(200/1000/5000/20000 次編輯)結果:

| 編輯數 | 階段 | log 列 | 快照 B | log B | 讀取 ms | 重建 ms |
|---|---|---|---|---|---|---|
| 1000 | 壓縮前 | 40 | 0 | 1749 | 2.9 | 2.5 |
| 1000 | 壓縮後 | 0 | 1019 | 0 | 2.4 | 0.3 |
| 5000 | 壓縮前 | 200 | 0 | 8789 | 4.9 | 4.5 |
| 5000 | 壓縮後 | 0 | 5019 | 0 | 2.6 | 0.5 |
| 20000 | 壓縮後 | 0 | 20020 | 0 | 2.1 | 0.3 |

觀察:重建成本由 **log 列數**主導而非文件大小——20000 字的壓縮後文件重建 0.3ms,5000 字但帶 200 列未壓縮 log 的重建 4.5ms(慢一個數量級)。壓縮把成本壓回常數級,且兩階段的重建 state hash 相同(壓縮不改變文件語意)。結論:壓縮延遲(去抖動視窗)是重建延遲的主要旋鈕;若未來把去抖動拉長,冷載入延遲會線性隨累積列數上升。

## RTC 媒體壓測(`tests/load/rtc-load.sh`)

```bash
docker compose -f docker-compose.yml -f docker-compose.sfu.yml up -d
tests/load/rtc-load.sh 3 9 30s        # publishers subscribers duration
```

k6 套件只涵蓋信令;這支用 `lk load-test` 打真實媒體路徑(模擬發布者與訂閱者,含 speaker 事件)。單機 compose 3 發布者 / 9 訂閱者 / 30 秒:**27/27 訂閱軌道全部建立,總計 21.5mbps(平均 2.4mbps/訂閱者),丟包 0(0%),錯誤 0**。simulcast 分層可見(同一發布者同時有 ~1.9mbps 與 ~290kbps 的軌道被訂閱),與 SFU 疊加層的 simulcast/dynacast 設定一致。跑測時可對照 observability 疊加層的 SFU 面板。

## 規模化到正式環境

沙箱數字只證明「行為正確 + 單機餘裕」;正式驗收應在目標環境跑藍圖工作負載(20k 連線、500 房、5% reconnect storm、1% slow consumer),搭配 observability 疊加層觀察 `warroomlive_*` 指標與 JVM/GC,門檻不變。Redis backplane(scale 疊加層)下建議同時對兩節點壓測。
