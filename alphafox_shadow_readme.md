# AlphaFox 隐含仓位追踪台

这个本地工具分两层：

1. `alphafox_shadow_console.html`：解析 AlphaFox 可见中文开平仓记录，重建净仓、均价、数量、名义价值、未实现盈亏和推算杠杆。
2. `alphafox_shadow_server.js`：本机只读代理，读取币安 USD-M 合约公开标记价，以及你自己账号的只读合约账户数据。

重要边界：

- 你的 Binance API key 只能读取你自己的账户数据。
- 它不能读取目标交易员的隐藏仓位、余额或私有订单。
- 如果目标交易员的开平仓记录、余额、收益曲线是 AlphaFox 或 Binance 前端公开展示的数据，可以用这些可见数据做外部推算。
- 不要把 API key 和 secret 发到聊天里。只在本机 `.env` 中配置。
- Binance API key 建议只开读取权限，关闭提现和交易权限，并绑定 IP。

## 本地运行

在这个目录下创建 `.env`，字段参考 `.env.example`。

然后运行：

```powershell
node .\alphafox_shadow_server.js
```

打开：

```text
http://127.0.0.1:8787/
```

## 输入格式

直接粘贴 AlphaFox 的中文流水，例如：

```text
2026-08-17 22:04 开空
以均价为1,769.48489开启做空SNDKUSDT USDT仓位，成交数量为39.04SNDK，总价值为69,080.6902969USDT。
```

多个记录用空行隔开。

## 已实现接口

- `GET /api/health`
- `GET /api/binance/mark?symbol=SNDKUSDT`
- `GET /api/binance/account`
- `GET /api/binance/position-risk?symbol=SNDKUSDT`
- `GET /api/binance/user-trades?symbol=SNDKUSDT`
- `GET /api/binance/income?symbol=SNDKUSDT&incomeType=REALIZED_PNL`

所有接口都是只读 `GET`。

## Binance 公开带单员轮询器

如果目标是 Binance 跟单页公开可见的带单员数据，使用：

```powershell
node .\binance_leader_poller.js
```

打开：

```text
http://127.0.0.1:8790/
```

默认追踪：

```text
LEADER_PORTFOLIO_ID=5075281354358777856
```

当前内置交易员：

- 熬鹰资本：`5075281354358777856`
- 鎏渊：`5108371059752839168`

页面左上角三横杠菜单可以切换交易员。后续新增交易员时，在 `binance_leader_poller.js` 顶部的 `traders` 数组里添加 `portfolioId` 和名称即可。

这个轮询器读取 Binance 公开网页 BAPI：

- 带单员详情：`/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=...`
- 最新交易记录：`/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history`

它不需要 Binance API key。你的 API key 仍然只能读取你自己的账户数据，不能替代这些公开网页接口。程序启动时会回填订单历史，之后每 5 分钟轮询最新一页并去重保存到 `data/`。

默认不查实时标记价，避免行情接口在某些网络环境下拖慢快照。需要实时未实现盈亏时，在 `.env` 中设置：

```text
LEADER_FETCH_MARK_PRICES=1
```
