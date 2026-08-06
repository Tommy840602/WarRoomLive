# 備份與災難復原 Runbook

藍圖第十一章的落地(本機/開發形態):WAL 歸檔 + 實體基底備份 = PITR 能力,加上一套**可重複執行的還原演練**。PostgreSQL 是唯一 source of truth——聊天、collab 快照與 update log、outbox、會議、稽核/搜尋讀模型都在其中,一次 PITR 覆蓋全部;讀模型(audit/search)另可從事件重放重建。

## 啟用備份(backup 疊加層)

```bash
docker compose -f docker-compose.yml -f docker-compose.backup.yml up -d
tests/dr/backup.sh        # 產生一份 base backup(pg_basebackup -Xstream)
```

疊加層開啟 `archive_mode=on`,WAL 持續歸檔到 `backups` volume(`archive_timeout=60` 保證至少每分鐘一段);正式環境把 `archive_command` 換成上傳物件儲存,並照藍圖做 Multi-AZ、跨區域備份與備份加密。

## 還原演練(`tests/dr/restore-drill.sh`)

一鍵完整 PITR 演練,步驟:

1. 經**真實應用路徑**種入標記 A(信令 WebSocket 聊天 + collab 共同筆記編輯)
2. 取 base backup
3. 記下還原目標時間 **T**
4. 種入「災後」標記 B(不得在還原結果中出現)
5. `pg_switch_wal` 確保 T 之前的變更都已歸檔
6. 以 base backup + WAL 歸檔在**全新容器**還原,`recovery_target_time = T`
7. 斷言:A 存在、B 不存在;`tests/dr/verify-crdt.mjs` 在來源庫與還原庫各自「載入 snapshot → replay update log → 重建 Yjs 文件」,逐文件比對 SHA-256 與筆記內容

### 本次演練結果(2026-08-06)

- 還原庫在數秒內完成 recovery 並 promote
- `ok: marker A survived the restore`
- `ok: post-disaster marker B correctly absent (PITR honored T)`
- `ok: CRDT documents rebuild to identical hashes on source and restored DBs`(含筆記文字內容比對)

### 演練抓到並已修復的缺陷

首次執行時歸檔靜默失敗(`pg_stat_archiver.failed_count` 持續上升、歸檔目錄為空):備份目錄由 root 建立,postgres 歸檔程序無寫入權限,導致「以為有 PITR、實際上沒有」——正是定期演練要抓的那類問題。已修:`backup.sh` 建目錄後 `chown postgres`。**監控建議**:對 `pg_stat_archiver.failed_count` 設告警。

## 節奏與範圍(藍圖)

- 每日 full backup + WAL 連續歸檔;**每季至少一次還原演練**(直接跑本 drill)
- 錄影(MinIO)：開啟 bucket versioning 與 lifecycle;跨區域複寫視需求
- Kafka:重要 topic 定期匯出物件儲存;還原後以 consumer replay 重建讀模型驗證
