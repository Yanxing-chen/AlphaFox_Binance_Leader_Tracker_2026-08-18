# Binance 带单员追踪台 Cloudflare 部署版

这套目录是正式线上版本。当前最终方案是：

```text
GitHub Actions 每 5 分钟抓 Binance
        -> POST 到 Cloudflare Worker /api/ingest
        -> Worker 写入 D1
        -> 朋友访问 workers.dev 页面读取 D1
```

注意：不要再让 Cloudflare Worker 自己抓 Binance。实测 Binance 对 Cloudflare Worker 出口返回 `HTTP 403`。

## 当前线上地址

```text
https://binance-leader-tracker.cyanbin96.workers.dev
```

## 文件说明

- `src/worker.js`：Cloudflare Worker，负责网页 API、D1 读取、受保护写入入口 `/api/ingest`
- `public/index.html`：网页操作台
- `scripts/fetch_and_ingest.js`：从 Binance 抓数据，并推送到 Worker
- `.github/workflows/poll-binance-leaders.yml`：GitHub Actions 每 5 分钟自动抓取
- `schema.sql`：D1 数据库表结构
- `wrangler.toml`：Cloudflare 配置

## 已完成

- Worker 已部署
- D1 数据库已创建：`leader_tracker_db`
- D1 绑定名保持为：`DB`

## 下一步：设置写入密钥

先生成一个写入密钥，注意不要截图、不要发给别人：

```powershell
$secret = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
$secret
```

把它设置到 Cloudflare Worker：

```powershell
npx.cmd wrangler secret put INGEST_SECRET
```

Wrangler 提示输入 secret 时，粘贴刚才 `$secret` 打印出来的那串字符。

然后重新部署 Worker：

```powershell
npx.cmd wrangler deploy
```

## 本地先测试一次抓取并写入

在 `cloudflare` 目录里执行：

```powershell
$env:LEADER_TRACKER_INGEST_URL="https://binance-leader-tracker.cyanbin96.workers.dev/api/ingest"
$env:LEADER_TRACKER_INGEST_SECRET=$secret
node .\scripts\fetch_and_ingest.js
```

成功后，打开：

```text
https://binance-leader-tracker.cyanbin96.workers.dev/api/health
```

如果看到 `lastPollAt` 不再是 `null`，说明数据已经写入 D1。

## GitHub 自动 5 分钟抓取

把整个项目推到 GitHub 后，在 GitHub 仓库里设置两个 Actions Secret：

```text
LEADER_TRACKER_INGEST_URL
```

值填：

```text
https://binance-leader-tracker.cyanbin96.workers.dev/api/ingest
```

再加一个：

```text
LEADER_TRACKER_INGEST_SECRET
```

值填刚才你生成的 `$secret`。

然后进入 GitHub 仓库：

1. 点 `Actions`
2. 选择 `Poll Binance leaders`
3. 点 `Run workflow`

跑通后，它会每 5 分钟自动执行一次。

## 本地 dry-run

只抓 Binance，不写 Cloudflare：

```powershell
node .\scripts\fetch_and_ingest.js --dry-run
```

这个用于判断 Binance 是否能从当前网络抓到数据。
