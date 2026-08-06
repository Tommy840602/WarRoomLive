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

## 規模化到正式環境

沙箱數字只證明「行為正確 + 單機餘裕」;正式驗收應在目標環境跑藍圖工作負載(20k 連線、500 房、5% reconnect storm、1% slow consumer),搭配 observability 疊加層觀察 `warroomlive_*` 指標與 JVM/GC,門檻不變。Redis backplane(scale 疊加層)下建議同時對兩節點壓測。
