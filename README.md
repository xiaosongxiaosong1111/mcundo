<p align="center">
  <img src="docs/assets/mcundo-hero.png" alt="麦单回正：订单小票、回正箭头与安全确认" width="100%" />
</p>

<h1 align="center">麦单回正 McUndo</h1>

<p align="center">
  点错、点多、重复下单时，先核对，再取消，再按新价格重建。<br />
  每次写操作都需要明确确认；状态不确定，立即停止。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white" alt="Node.js 20 或更高版本" />
  <img src="https://img.shields.io/badge/tests-71%2F71_passed-2ea043" alt="71 项测试全部通过" />
  <img src="https://img.shields.io/badge/MCP-Streamable_HTTP-ffb000" alt="MCP Streamable HTTP" />
  <img src="https://img.shields.io/badge/write_safety-double_confirmation-c93c37" alt="写操作双重确认" />
</p>

<p align="center"><sub>麦当劳程序员创意开发大赛独立参赛作品 · 非麦当劳官方产品</sub></p>

---

## 为什么做它

下错单之后，危险的并不是“再点一次”，而是：取消错订单、状态已经变化、旧单取消后价格变了，或者网络超时后重复执行写操作。

McUndo 把麦当劳 MCP Server 的订单能力编排成一条**带双重确认和失败停止机制**的补救流程：

| 下错单时的风险 | McUndo 的处理 |
| --- | --- |
| 取消对象选错 | 重新读取详情，并在写入前再次核对订单指纹 |
| 订单状态或餐单变化 | 旧确认立即失效，取消前停止 |
| 旧单取消后价格变化 | 重新核价，并要求第二次独立确认 |
| 超时后不知道是否成功 | 写操作不自动重试，提示回官方 App 核对 |
| 无意中自动付款 | 只创建待支付订单，支付始终由用户完成 |

目标用户是刚提交订单才发现点错、点多或重复下单的人，也包括帮同事、朋友集中点餐而容易出现数量偏差的发起人，以及希望 MCP 写操作始终由本人确认的开发者。

## 克隆后立即体验

离线演示使用合成订单，**不需要麦当劳账号或 Token，也不会产生真实订单**。

```powershell
git clone https://github.com/xiaosongxiaosong1111/mcundo.git
Set-Location mcundo
npm ci
npm run demo
```

数量修改采用逐项询问：输入新数量，按回车保持，输入 `0` 删除。演示会完整走过核价、两次确认、取消验证和创建待支付新单。

<p align="center">
  <img src="docs/assets/demo-terminal.svg" alt="McUndo 离线合成数据演示" width="100%" />
</p>

<p align="center"><sub>上图是合成数据流程示意，不是线上订单执行截图。</sub></p>

## 连接自己的麦当劳账户

> [!CAUTION]
> **本仓库不会附带项目作者的真实 Token。** Token 是账户权限凭证，公开后任何人都可能读取或操作对应账户。每位使用者必须在[麦当劳 MCP 开放平台](https://open.mcd.cn/mcp)申请并使用自己的 Token。

### Windows PowerShell

先在开放平台复制 **Token 本体**，不要复制 `Bearer`。然后在项目目录执行：

```powershell
try {
  $env:MCD_MCP_TOKEN = ([string](Get-Clipboard)).Trim()
  Set-Clipboard -Value '' -ErrorAction Stop

  npm run doctor
  if ($LASTEXITCODE -ne 0) { throw '连接检查失败' }

  npm run verify:live
  if ($LASTEXITCODE -ne 0) { throw '只读订单验证失败' }

  npm start
} finally {
  Remove-Item Env:MCD_MCP_TOKEN -ErrorAction SilentlyContinue
}
```

这段命令会立即清空剪贴板，并在退出时删除当前终端中的环境变量。Token 不会写入项目文件、Git 历史或日志。

<details>
<summary><strong>macOS / Linux 安全输入方式</strong></summary>

```bash
read -rsp "MCD MCP Token: " MCD_MCP_TOKEN
echo
export MCD_MCP_TOKEN

npm run doctor && npm run verify:live && npm start

unset MCD_MCP_TOKEN
```

</details>

> [!IMPORTANT]
> `doctor` 只检查连接和工具；`verify:live` 只调用 `order-list` / `query-order`，不会核价、取消或创建订单。真实救援模式必须在交互终端运行，不能通过管道绕过人工确认。

## 一次回正是怎样完成的

```mermaid
flowchart LR
  A[选择近期订单] --> B[读取最新详情]
  B --> C{能否完整还原}
  C -- 否 --> S[停止并提示核对]
  C -- 是 --> D[修改数量并核价]
  D --> E{精确确认取消}
  E --> F[仅取消一次]
  F --> G{重新查询已取消}
  G -- 否或不确定 --> S
  G -- 是 --> H[再次核价]
  H --> I{确认最终价格}
  I --> J[创建待支付新单]
```

流程实际调用五个 MCP 工具：

| Tool | 用途 | 写操作 |
| --- | --- | :---: |
| `order-list` | 获取近期订单，供用户选择 | 否 |
| `query-order` | 读取最新详情并验证状态 | 否 |
| `calculate-price` | 对替代餐单重新核价 | 否 |
| `cancel-order` | 精确确认后取消旧单一次 | 是 |
| `create-order` | 独立确认后创建待支付新单一次 | 是 |

完整参数边界与业务价值见 [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md)。

## 安全机制

| 机制 | 保证 |
| --- | --- |
| 双重确认 | 取消旧单和创建新单分别授权，一次确认不能复用 |
| 写前复核 | 确认后再次读取订单；内容变化就让确认失效 |
| 写后验证 | 只有重新查询确认旧单已取消，才允许继续重建 |
| 最终核价 | 创建前再次核价；价格变化就要求重新确认 |
| 不确定即停止 | 取消和创建均不自动重试，避免重复写入 |
| 最少披露 | 不展示完整订单号、电话或地址；支付链接仅在创建成功时显示一次 |
| Token 不落盘 | 只从环境变量读取，配置示例仅保留占位符 |

<details>
<summary><strong>当前支持范围与限制</strong></summary>

- 自动重建仅覆盖能被现有字段完整描述的简单到店订单。
- 套餐、特制项、优惠券、外送、团餐、缺失或重复商品编码、列表与详情不一致时，会在取消前停止。
- 无法唯一还原取餐方式时不会猜测。
- “取消成功”不等于退款到账，退款和最终状态以麦当劳官方渠道为准。
- 价格、库存、可取消状态及服务能力会实时变化。
- 不要在多个终端同时处理同一订单；结果不确定时先回官方 App 核对。
- 终端可能显示完成操作所需的订单摘要及支付链接（仅显示一次），请勿截图或公开终端输出。
- 新订单只创建到待支付阶段，本项目不会自动付款。

</details>

## 验证状态

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| 自动化测试 | ✅ 通过 | 2026-10-12：71/71 单元、集成与 CLI 端到端测试通过 |
| 官方 MCP 连接与工具发现 | ✅ 通过 | 2026-10-10：连接 `https://mcp.mcd.cn`，发现 35 个工具，所需 5 个均存在 |
| `order-list` / `query-order` 真实只读链路 | ⚠️ 待近期订单验证 | 已提供不输出订单内容的 `npm run verify:live` |
| `cancel-order` / `create-order` 真实写入 | ⛔ 未执行 | 不拿真实订单做破坏性验收，也不声称线上端到端已实测 |

没有近期订单时，`verify:live` 会报告 `partial`，不会把未执行的 `query-order` 伪装成成功。

## 命令速查

| 命令 | 作用 | 需要 Token |
| --- | --- | :---: |
| `npm run demo` | 完全离线的交互演示 | 否 |
| `npm test` | 运行全部自动化测试 | 否 |
| `npm run coverage` | 测试并输出覆盖率 | 否 |
| `npm run doctor` | 检查真实 MCP 连接与工具 | 是 |
| `npm run verify:live` | 验证真实只读订单链路 | 是 |
| `npm start` | 启动真实交互救援流程 | 是 |

## 项目结构

```text
src/                    CLI、安全状态机、MCP 适配器、离线演示
test/                   单元、集成和 CLI 端到端测试
docs/assets/            README 横幅与合成演示图
SKILL.md                供 Codex 等智能体使用的安全操作规范
MCP_INTEGRATION.md      MCP 工具、调用流程与业务价值
mcp-config.example.json 脱敏 MCP 配置示例
```

## 参赛说明

本项目是麦当劳程序员创意开发大赛的独立参赛作品，不是麦当劳官方产品，也不暗示官方背书。仓库按比赛要求提供：

- [`CONTEST_DECLARATION.md`](CONTEST_DECLARATION.md)
- [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md)
- [`mcp-config.example.json`](mcp-config.example.json)
- 可运行源码与测试

相关链接：

- [比赛官方仓库](https://github.com/M-China/mcd-developer-innovation-challenge)
- [活动规则](https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/activityGuidelines.md)
- [麦当劳 MCP Server 文档](https://github.com/M-China/mcd-mcp-server)
- [麦当劳 MCP 开放平台](https://open.mcd.cn/mcp)
