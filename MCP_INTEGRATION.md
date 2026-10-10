# 麦当劳 MCP 接入说明

## Server

- 官方开放平台：<https://open.mcd.cn/mcp>
- MCP Server：`https://mcp.mcd.cn`
- 传输：Streamable HTTP
- 鉴权：`Authorization: Bearer <Token>`，Token 仅从本机环境变量 `MCD_MCP_TOKEN` 读取

程序使用官方 Model Context Protocol TypeScript SDK 建立连接，并在启动时通过工具发现检查以下五个工具是否都可用。缺失任一工具即停止，不进入订单处理流程。

## 实际使用的 Tools

| Tool | 在项目中的用途 | 是否可能改变账户状态 |
| --- | --- | --- |
| `order-list` | 获取近期到店/外送订单，供用户选择目标订单 | 否 |
| `query-order` | 查询最新详情、取消前检查变化、取消后验证状态 | 否 |
| `calculate-price` | 对替代餐单核价，并在创建前检查价格是否变化 | 否 |
| `cancel-order` | 在明确确认后取消一次指定旧订单 | 是 |
| `create-order` | 在独立确认且最终核价一致后创建一次待支付订单 | 是 |

## 调用链

### 发布前只读验证

```text
工具发现
  → order-list
  → 若存在近期订单：order-list（刷新）+ query-order（验证列表与详情可一致解析）
  → 输出不含订单内容的检查报告
```

运行 `npm run verify:live` 即可执行这条链路。没有近期订单时，`order-list` 仍记为成功，报告状态为 `partial`，`query-order` 标记为 `skipped_no_recent_order`。该命令不会调用 `calculate-price`、`cancel-order` 或 `create-order`。

### 只取消

```text
order-list
  → query-order
  → 展示脱敏摘要并要求精确取消确认
  → query-order（确认后再次检查订单指纹）
  → cancel-order（只调用一次）
  → query-order（验证状态确为已取消）
```

用户未精确确认、确认后订单发生变化、服务端拒绝取消或无法验证取消状态时，流程立即停止。

### 修改数量后重建

```text
order-list
  → query-order
  → 判断原单是否能无损还原
  → calculate-price（替代餐单预核价）
  → 独立执行上述“只取消”链路
  → calculate-price（取消后重新核价）
  → 展示新餐单和总价并要求独立创建确认
  → calculate-price（创建前最终核价）
  → create-order（只调用一次，生成待支付订单）
```

取消与创建是两个独立授权：确认取消不等于确认创建。最终价格或餐单指纹与用户确认时不同，旧确认立即失效。

## 业务价值

麦当劳 MCP 原本已经提供查询、取消、核价和创建订单的原子能力。麦单回正的价值是把这些能力编排成一条防误操作的补救流程：

- 用最新订单状态而不是用户记忆确定操作对象；
- 把不可逆或有财务影响的步骤留给用户逐次确认；
- 取消后以服务端查询结果验证，而不是只相信单次返回；
- 重建前后重复核价，避免用户在价格变化后仍沿用旧授权；
- 对网络超时等未知结果停止重试，避免重复取消或重复下单。

## 能力边界

MCP 并不保证任意订单都可取消，也不提供“原订单原地修改”。本项目采用“取消旧单并创建新单”的方式实现回正，因此不会承诺退款到账时间、库存保留、价格不变或优惠继续有效。

自动重建目前只覆盖能被现有返回字段完整描述的简单到店订单。套餐/特制、优惠券、外送地址、团餐和缺失商品编码的订单会安全停止，不尝试猜测参数。`create-order` 只生成待支付订单，本项目不自动支付。

所有工具参数和可用性均在运行时由真实 MCP Server 决定；服务端规则或 Schema 变化时，程序应以停止写操作为默认行为。
