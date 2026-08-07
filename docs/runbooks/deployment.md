# 部署：`live.tommy-huang.dev`（Hetzner，與既有站台同一台機器）

目標拓撲：`live.tommy-huang.dev` 與 `twin.tommy-huang.dev` 共用 **178.104.225.148**。
`:80` / `:443` 已經被既有的 reverse proxy 佔著，所以 WarRoomLive **不自己起 edge**——
它把 frontend 綁在 loopback，由既有的 proxy 轉進來。

> 這也是為什麼**不要**在這台機器上用 `docker-compose.tls.yml`：那個疊加層會自己起一個
> Caddy 綁 `:80`/`:443`，跟已經握著那兩個 port 的 edge 直接相撞。用
> `docker-compose.prod.yml`。

---

## 開始之前

三件事會決定後面的做法，先確認：

| 問題 | 為什麼重要 |
|---|---|
| 既有的 edge 是 Caddy 還是 nginx？ | 決定用 `infrastructure/edge/` 底下哪一份設定 |
| `:8088` 在這台機器上是空的嗎？ | 被佔用就改 `WARROOM_PORT`，edge 設定要跟著改 |
| 要不要超過 8 人同時開？ | 決定要不要 SFU，而 SFU 需要**額外開對外 port**（見下方「媒體」） |

檢查 port：

```bash
ss -tlnp | grep -E ':(80|443|8088)\b'
```

---

## 1. DNS

`live.tommy-huang.dev` **目前沒有記錄**（`twin` 有，指向 178.104.225.148）。先加：

```
live.tommy-huang.dev.  A     178.104.225.148
```

有 IPv6 就一併加 `AAAA`。憑證簽發需要這筆記錄先生效：

```bash
dig +short live.tommy-huang.dev        # 應該回 178.104.225.148
```

---

## 2. 取得程式碼與設定

```bash
sudo mkdir -p /srv/warroomlive && sudo chown "$USER" /srv/warroomlive
git clone https://github.com/Tommy840602/WarRoomLive.git /srv/warroomlive
cd /srv/warroomlive

cp .env.prod.example .env.prod
chmod 600 .env.prod
$EDITOR .env.prod          # DB_PASSWORD 必填，PUBLIC_ORIGIN 已預填
```

`DB_PASSWORD` 用 `openssl rand -base64 32` 產。**這個值之後很難改**——它會寫進
Postgres 的 volume，事後要改得連 volume 一起處理。

> 沒填 `DB_PASSWORD` 或 `PUBLIC_ORIGIN` 的話 compose 會直接拒絕啟動。這是刻意的：
> 這個 repo 到處都有開發用的預設密碼，用預設值跑在有公開位址的機器上，是那種不該
> 「因為忘了」而發生的事。

---

## 3. 啟動 stack

```bash
docker compose --env-file .env.prod \
  -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

確認它活著（此時只有 loopback 通）：

```bash
curl -s http://127.0.0.1:8088/api/health      # {"status":"ok",...}
docker compose ps
```

---

## 4. 接上既有的 edge

`infrastructure/edge/` 底下有兩份，**依既有 edge 二選一**：

### Caddy

```bash
sudo cp infrastructure/edge/live.tommy-huang.dev.Caddyfile \
        /etc/caddy/sites/live.tommy-huang.dev.caddyfile
# 確認主 Caddyfile 有 import /etc/caddy/sites/*，沒有就把內容貼進主檔
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

憑證 Caddy 會自己簽（Let's Encrypt），前提是 DNS 已生效且 `:80` 對外通。

### nginx

```bash
sudo cp infrastructure/edge/live.tommy-huang.dev.nginx.conf \
        /etc/nginx/sites-available/live.tommy-huang.dev
sudo ln -s ../sites-available/live.tommy-huang.dev /etc/nginx/sites-enabled/
sudo certbot --nginx -d live.tommy-huang.dev
sudo nginx -t && sudo systemctl reload nginx
```

`$connection_upgrade` 這個 map 如果既有設定裡還沒有，設定檔結尾有註解說明要加什麼——
少了它 WebSocket 不會升級，房間會連不上。

---

## 5. 驗證

```bash
curl -s https://live.tommy-huang.dev/api/health
curl -sI https://live.tommy-huang.dev/ | head -3
```

然後用瀏覽器開兩個分頁進同一個房間，確認：

- 看得到對方的影像與聲音
- 聊天、共享筆記、白板會同步
- 待辦與行事曆改一邊、另一邊不用重整就更新

**限流那條要特別驗**，因為它是這個拓撲最容易壞的地方：

```bash
# 從外面連續打，應該只有你這個來源被擋，而且會有 200 也有 429
for i in $(seq 1 60); do
  curl -s -o /dev/null -w "%{http_code} " https://live.tommy-huang.dev/api/media/config
done; echo
```

看到全部 429、或第一個請求就 429，代表 `real-ip.conf` 沒生效——所有人被算成同一個
呼叫端了。確認 `docker-compose.prod.yml` 有掛上它：

```bash
docker compose exec frontend ls /etc/nginx/conf.d/
# 應該看到 00-real-ip.conf 與 default.conf
```

---

## 媒體：唯一不走 edge 的東西

HTTP 與 WebSocket 都能穿過既有的 reverse proxy。**媒體不行**——它是 SRTP/UDP，
reverse proxy 代理不了。這決定了要不要動防火牆：

| 模式 | 對外要開的 port | 何時需要 |
|---|---|---|
| **Mesh（預設）** | 無 | ≤8 人，且雙方 NAT 不算嚴格。媒體點對點直連，伺服器只轉信令 |
| **+ TURN**（`docker-compose.turn.yml`） | `3478/tcp`、`3478/udp`、`49160-49200/udp` | 有人在嚴格 NAT／企業網路後面連不上時 |
| **SFU**（`docker-compose.sfu.yml`） | `7881/tcp`、`7882/udp` | 要超過 8 人 |

先用預設的 mesh 上線，遇到「有人看不到彼此」再加 TURN。多開 port 之前先確認沒有跟
`twin` 那邊撞到：

```bash
ss -ulnp | grep -E ':(3478|7882|49160)\b'
```

加 TURN 時 `.env.prod` 要設 `TURN_PUBLIC_HOST=live.tommy-huang.dev`，而且
**coturn 的預設帳密是開發用的**（`warroom:warroomsecret`，寫死在
`docker-compose.turn.yml` 裡），對外開放前務必換掉，或改用 `--use-auth-secret`。
一個公開的、憑證是公開值的 TURN relay，就是一台免費的流量中繼。

SFU 還要在 `infrastructure/livekit/livekit.yaml` 設 `rtc.node_ip: 178.104.225.148`——
瀏覽器要直接連到那個位址，不是容器網路的內部 IP。

---

## 資料保留

預設**全部保留永久**。要開就改 `.env.prod` 的 `RETENTION_*_DAYS` 再重啟 backend：

```bash
docker compose --env-file .env.prod \
  -f docker-compose.yml -f docker-compose.prod.yml up -d backend
```

第一次開的時候要有心理準備：如果資料庫裡已經有超過期限的資料，第一輪掃描就會刪。
排程每小時跑一次，啟動後一分鐘跑第一次。

---

## 升級

```bash
cd /srv/warroomlive
git pull
docker compose --env-file .env.prod \
  -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Flyway 會在 backend 啟動時自己跑 migration。升級期間房間會斷線，但前端會自動重連並
重新加入——不需要請大家重整。

回滾：`git checkout <上一個 tag 或 commit>` 再跑同一行。**但 migration 不會自動倒回**；
往回退版本前先看 `backend/src/main/resources/db/migration/` 有沒有新的 `V<n>__*.sql`。

---

## 備份

Postgres 的資料在具名 volume `pgdata` 裡，`docker compose down` 不會動它，
`down -v` 會刪掉。最小的備份：

```bash
docker compose exec -T db pg_dump -U warroomlive warroomlive | gzip > warroom-$(date +%F).sql.gz
```

要做到可以還原到任意時間點（WAL 歸檔 + PITR 演練），見
[`disaster-recovery.md`](disaster-recovery.md)。

---

## 需要登入才能進房（選用）

預設不需要登入。要接自己的 IdP（Keycloak／Entra）時用 `oidc` profile，
**不要**把 `docker-compose.oidc.yml` 直接搬上來——那個疊加層裡的 `devidp` 是
開發用的假 IdP（固定帳密 alice/bob、記憶體金鑰），對外部署等於開一道無條件的門。
要用的是它的 `OIDC_*` 環境變數指向真的 IdP。
