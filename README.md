# 麦单回正 McUndo

> 给“订单刚提交，才发现点错、点多或重复下单”一个可核对、可停止的补救流程。

下错单之后，真正危险的不是重新点一次，而是取消对象选错、订单状态已经变化、旧单取消了但新价格变了，或网络超时后重复执行写操作。

麦单回正通过麦当劳中国官方 MCP 获取最新订单，把“核对原单 → 修改数量 → 取消旧单 → 重新核价 → 创建待支付新单”编排成一条需要用户逐次确认的安全流程。它不猜订单、不静默重试，也不自动付款。

## 解决什么问题

点餐错误通常发生在时间紧迫的场景：多人代点时数量记错、重复提交、结账后才发现漏点。用户需要的不是一段建议，而是知道系统当前看到的是哪张订单、取消是否真的生效，以及重建后的价格有没有变化。

目标用户包括：

- 刚提交订单、需要尽快纠正错误的个人用户；
- 帮同事或朋友集中点餐、容易出现数量偏差的发起人；
- 希望 MCP 写操作始终由本人确认的开发者和体验者。

## 它能做什么

- 查询近期订单和订单详情；
- 仅在用户输入精确确认语后取消一次旧订单；
- 取消后重新查询订单状态，只有确认已取消才继续；
- 对可安全还原的简单到店订单逐项显示餐品名并修改数量，不要求用户输入内部商品编码；
- 两次确认均展示餐品数量前后差异，删除的餐品也会明确显示为 `原数量 → 0`；
- 重新核价并创建待支付订单；
- 创建新单需要第二次、独立的精确确认；
- 写请求结果不确定时停止，不自动重试；
- 自带完全离线的合成数据演示，不接触真实账户。

## 20 秒离线演示

需要 Node.js 20 或更高版本。

```powershell
git clone https://github.com/xiaosongxiaosong1111/mcundo.git
Set-Location mcundo
npm ci
```

依赖安装完成后，把下面一整行粘贴到 PowerShell，即可观看“2 个汉堡改为 1 个、取消旧单并创建待支付新单”的完整流程：

```powershell
@('1','3','2','1','取消 5678','下单 ¥22.00','') -join "`n" | npm run demo
```

演示模式使用合成订单，不需要麦当劳账号或 Token，不会连接麦当劳服务或产生真实订单。想自己逐步操作，运行 `npm run demo`。

数量修改采用逐项询问：直接输入新数量，按回车保持不变，输入 `0` 删除。若所有数量都未改变，程序会在取消旧单前停止。

```text
演示汉堡（当前 2；回车保持，0 删除，1-20）：1

准备取消旧单：
餐单变更：
- 演示汉堡：2 → 1
金额：¥42.00 → ¥22.00
```

## 连接真实麦当劳 MCP

1. 前往[麦当劳 MCP Server 开放平台](https://open.mcd.cn/mcp)，用手机号登录并在控制台申请 Token。
2. 仅在当前终端设置环境变量。不要把 Token 写入仓库、配置示例、截图或聊天记录。
3. 先运行连接检查和只读订单验证，再启动交互流程。

```powershell
$env:MCD_MCP_TOKEN = ([string](Get-Clipboard)).Trim()
try {
  Set-Clipboard -Value ''
  npm run doctor
  if ($LASTEXITCODE -ne 0) { throw '连接检查失败' }
  npm run verify:live
  if ($LASTEXITCODE -ne 0) { throw '只读订单验证失败' }
  node src/cli.js
} finally {
  Remove-Item Env:MCD_MCP_TOKEN -ErrorAction SilentlyContinue
}
```

运行前先在开放平台复制 Token；上述命令读取后立即清除剪贴板，并在退出时清除环境变量。不要把真实 Token 写进命令。

`doctor` 只建立连接并检查所需工具是否存在。`verify:live` 先调用 `order-list`；有近期订单时，程序会重新获取列表并并行调用一次 `query-order`，验证列表与详情能否一致解析。报告不显示订单号、门店、餐品、电话、地址或支付链接，也不会核价、取消或创建订单。没有近期订单时报告标记为 `partial`，不会假装已经验证 `query-order`。

真实救援模式必须在交互终端运行。程序不会接受管道输入来绕过人工确认。

仓库中的 [`mcp-config.example.json`](mcp-config.example.json) 仅用于展示标准 Streamable HTTP 配置；其中只有环境变量占位符。此 CLI 本身直接读取 `MCD_MCP_TOKEN`。

## 真实 MCP 验证状态

截至 2026-10-10：

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| 官方 MCP 连接与工具发现 | 已通过 | 已连接 `https://mcp.mcd.cn`，发现 35 个工具；本项目所需的 5 个工具均存在 |
| 离线状态机与 CLI 流程 | 已通过 | 合成数据覆盖查询、核价、取消验证、二次确认和创建结果处理 |
| `order-list` / `query-order` 真实只读链路 | 待真实近期订单验证 | 已提供不输出订单内容的 `npm run verify:live`；无近期订单时会明确报告 `partial` |
| `cancel-order` / `create-order` 真实写入 | 未执行 | 不拿用户真实订单做破坏性测试，不声称线上写流程已经实测 |

## 架构与调用链

```text
用户 / CLI
    ├─ --demo ───────────────→ DemoGateway（合成数据）
    └─ 真实模式 ─────────────→ McdGateway ── Streamable HTTP ──→ https://mcp.mcd.cn
                                      │
                                      └─ Rescue 状态机：复核、确认、核价、写入、验证
```

## 一次“修改数量后重建”的流程

1. `order-list` 列出近期订单，用户选择目标订单。
2. `query-order` 获取最新详情；程序判断能否安全还原。
3. `calculate-price` 对替代餐单核价。
4. 展示脱敏摘要，要求输入类似 `取消 5678` 的精确确认语。
5. 再次查询并比对订单指纹；未变化才调用一次 `cancel-order`。
6. 再次 `query-order`，确认服务端状态已取消。
7. 重新核价，要求输入类似 `下单 ¥22.00` 的第二次确认语。
8. 最后核价仍一致时，调用一次 `create-order`，返回新的待支付订单。

更完整的工具说明见 [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md)。

## 安全机制与限制

- 真实写流程只允许在交互终端运行，不能通过管道输入绕过人工确认。
- 取消和创建各需一次精确确认；确认后若订单指纹、餐单或价格发生变化，旧确认立即失效。
- Token 仅从环境变量读取，配置示例不包含凭证；错误信息和订单摘要会先经过脱敏。
- MVP 自动重建仅支持可完整识别的简单到店订单：无套餐/特制项、无优惠券、商品编码唯一，且订单列表与详情中的餐品和数量一致。外送、团餐、套餐、特制、优惠券、数据不一致或无法唯一还原取餐方式时会在取消前停止。
- “取消成功”不代表退款已经到账；退款和订单状态以麦当劳官方渠道为准。
- `cancel-order` 与 `create-order` 都最多调用一次。超时或返回不确定时，程序要求用户到麦当劳官方 App 核对，不会盲目重试。
- 不要在多个终端中同时处理同一订单；若出现结果不确定，先到官方 App 核对，不能重新运行写流程碰碰运气。
- 新订单只创建到待支付阶段；程序不会自动打开支付链接或完成支付。
- 价格、库存、可取消状态和服务能力均可能实时变化，以官方 MCP 和麦当劳官方渠道的最终结果为准。
- 终端会显示完成判断所需的订单摘要；请只在可信设备上运行，不要保存或公开终端输出。
- 本项目是独立参赛作品，不是麦当劳官方产品，也不暗示官方背书。

## 安装、测试与命令

```powershell
npm ci                 # 按 lockfile 安装依赖
npm test               # 单元、集成和 CLI 端到端测试
npm run coverage       # 测试并输出覆盖率
npm run demo           # 完全离线的交互演示
npm run doctor         # 真实 MCP 连接与工具发现检查
npm run verify:live    # 真实 MCP 只读订单链路检查
node src/cli.js         # 真实救援流程，需要交互终端与 Token
```

## 项目结构

```text
src/                 CLI、安全状态机、MCP 适配器和离线演示
test/                单元、适配器和 CLI 端到端测试
SKILL.md             供 Codex 等智能体使用的安全操作规范
MCP_INTEGRATION.md   MCP 工具、调用链和价值说明
```

## 参赛说明

本项目是麦当劳程序员创意开发大赛的独立参赛作品，不是麦当劳官方产品，也不暗示官方背书。项目按比赛要求提供 [`CONTEST_DECLARATION.md`](CONTEST_DECLARATION.md)、[`MCP_INTEGRATION.md`](MCP_INTEGRATION.md) 和脱敏配置示例。

- [比赛官方仓库](https://github.com/M-China/mcd-developer-innovation-challenge)
- [活动规则](https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/activityGuidelines.md)
- [麦当劳中国 MCP Server 文档](https://github.com/M-China/mcd-mcp-server)
- [MCP 开放平台](https://open.mcd.cn/mcp)
