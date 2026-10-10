#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import process from "node:process";

import { collectQuantityUpdates, isExactConfirmation } from "./cli-utils.js";
import { DemoGateway } from "./demo-gateway.js";
import { runReadOnlyVerification } from "./live-verification.js";
import { McdGateway } from "./mcd-gateway.js";
import { redactText, runRescue, safeOrderSummary } from "./rescue.js";

const rawArgs = process.argv.slice(2);
const commands = rawArgs.filter((arg) => arg !== "--demo");
const unknownArgs = commands.filter((arg) => !["doctor", "verify"].includes(arg));
const demo = rawArgs.includes("--demo");
const doctorOnly = commands[0] === "doctor";
const verifyOnly = commands[0] === "verify";

function write(line = "") {
  process.stdout.write(`${line}\n`);
}

function money(fen) {
  return `¥${(Number(fen ?? 0) / 100).toFixed(2)}`;
}

async function createQuestioner() {
  if (process.stdin.isTTY) {
    return createInterface({ input: process.stdin, output: process.stdout });
  }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const answers = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  let index = 0;
  return Object.freeze({
    async question(prompt) {
      process.stdout.write(prompt);
      if (index >= answers.length) throw new Error("演示输入已结束");
      const answer = answers[index];
      index += 1;
      return answer;
    },
    close() {},
  });
}

function printOrder(order, index) {
  const summary = safeOrderSummary(order);
  write(`${index}. ${summary.order}｜${summary.store}｜${summary.status}｜${summary.total}`);
  for (const item of summary.items) {
    write(`   ${item.name} × ${item.quantity}`);
  }
}

async function chooseOrder(rl, gateway) {
  const orders = await gateway.listRecentOrders();
  if (orders.length === 0) throw new Error("没有可处理的近期订单");
  write("\n近期订单：");
  orders.forEach((order, index) => printOrder(order, index + 1));
  const answer = await rl.question("选择订单序号：");
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= orders.length) {
    throw new Error("订单序号无效");
  }
  return orders[index];
}

async function chooseReason(rl) {
  write("\n错误类型：");
  write("1 改主意了");
  write("2 重复下单");
  write("3 餐品点错、点多或点少");
  write("4 地址或电话错误");
  write("5 送达时间错误");
  const reason = (await rl.question("输入原因代码：")).trim();
  if (!["1", "2", "3", "4", "5"].includes(reason)) {
    throw new Error("取消原因无效");
  }
  return reason;
}

function changeLines(items) {
  const changed = items
    .filter((item) => item.beforeQuantity !== item.afterQuantity)
    .map((item) => `- ${item.name}：${item.beforeQuantity} → ${item.afterQuantity}`);
  return changed.length > 0 ? changed : ["- 餐品数量不变"];
}

function confirmationView(request) {
  const summary = request.safeSummary;
  if (request.action === "cancel" && summary.original) {
    return Object.freeze([
      `${summary.original.order}｜${summary.original.store}｜${summary.original.status}`,
      "餐单变更：",
      ...changeLines(summary.replacement.items),
      `金额：${summary.original.total} → ${summary.replacement.total}`,
      `取餐方式：${summary.replacement.takeWay}`,
    ]);
  }

  if (request.action === "create") {
    return Object.freeze([
      summary.previousOrder,
      "餐单变更：",
      ...changeLines(summary.items),
      `金额：${summary.total}`,
      `取餐方式：${summary.takeWay}`,
    ]);
  }

  return Object.freeze([
    `${summary.order}｜${summary.store}｜${summary.status}`,
    ...summary.items.map((item) => `- ${item.name} × ${item.quantity}`),
    `金额：${summary.total}`,
  ]);
}

function terminalConfirmer(rl) {
  return {
    async confirm(request) {
      write(`\n准备${request.action === "cancel" ? "取消旧单" : "创建新单"}：`);
      confirmationView(request).forEach((line) => write(line));
      if (request.action === "cancel") {
        write("注意：取消成功不等于退款已经到账。");
      }
      const answer = await rl.question(`请输入“${request.expectedPhrase}”确认：`);
      return Object.freeze({
        accepted: isExactConfirmation(answer, request.expectedPhrase),
        fingerprint: request.fingerprint,
      });
    },
  };
}

async function chooseQuantities(rl, order) {
  const summary = safeOrderSummary(order);
  const editableItems = order.items.map((item, index) =>
    Object.freeze({
      productCode: item.productCode,
      name: summary.items[index].name,
      quantity: summary.items[index].quantity,
    }),
  );
  write("\n逐项修改餐品数量：");
  return collectQuantityUpdates(editableItems, (prompt) => rl.question(prompt));
}

function renderResult(result, isDemo) {
  write("");
  switch (result.status) {
    case "created":
      write("旧单已验证取消，新待支付订单已创建。");
      write(`新订单：订单…${String(result.created.orderId).slice(-4)}`);
      write(`最新核价：${money(result.quote.totalFen)}`);
      if (isDemo) write("演示支付链接未连接真实麦当劳，不可支付。");
      else if (result.created.payUrl) write(`支付链接（仅本次展示）：${result.created.payUrl}`);
      break;
    case "cancelled":
      write("旧单已验证取消，没有创建新订单。");
      break;
    case "not_replayable":
      write("旧单包含当前无法安全还原的套餐、券、外送信息或特制项，未取消订单。");
      break;
    case "cancel_declined":
      write("未取得精确取消确认，没有执行任何写操作。");
      break;
    case "order_changed":
      write("确认后订单状态或内容发生变化，旧确认已失效，没有取消。");
      break;
    case "cancel_failed":
      write("服务端拒绝取消，没有创建新订单。");
      break;
    case "cancel_not_verified":
      write("取消结果尚未被订单查询确认，已停止，禁止自动重试。");
      break;
    case "manual_check_required":
      write("取消请求结果不确定，请到麦当劳官方 App 核对；禁止自动重试。");
      break;
    case "cancelled_without_replacement":
      write("旧单已验证取消；你没有确认新订单，因此未重建。");
      break;
    case "replacement_quote_failed":
      write("无法可靠核价，已在取消旧单前停止。");
      break;
    case "cancelled_quote_failed":
      write("旧单已验证取消，但替代餐单核价失败，因此没有创建新单。");
      break;
    case "quote_changed":
      write(`取消后价格发生变化（最新 ${money(result.quote.totalFen)}），旧确认已失效，未创建新单。`);
      break;
    case "create_unknown":
      write("创建请求结果不确定，请检查近期订单；禁止自动重试。");
      break;
    default:
      write(`流程已安全停止：${result.status}`);
  }
}

async function main() {
  if (unknownArgs.length > 0) throw new Error("未知命令；可用命令为 doctor 或 verify");
  if (commands.length > 1) throw new Error("只能指定一个命令");
  if (!demo && !doctorOnly && !verifyOnly && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("真实模式必须在交互终端运行，拒绝非交互写操作");
  }

  const gateway = demo ? new DemoGateway() : await McdGateway.connect();
  if (doctorOnly) {
    try {
      const report = gateway.doctor();
      write(JSON.stringify(report, null, 2));
    } finally {
      await gateway.close();
    }
    return;
  }
  if (verifyOnly) {
    try {
      const report = await runReadOnlyVerification(gateway);
      write(JSON.stringify(report, null, 2));
    } finally {
      await gateway.close();
    }
    return;
  }

  const rl = await createQuestioner();
  try {
    write("麦单回正 McUndo");
    write(demo ? "演示模式：不会调用真实麦当劳服务。" : "真实模式：写操作各需一次人工确认。");

    const selected = await chooseOrder(rl, gateway);
    const order = await gateway.getOrder(selected.id);
    const reasonCode = await chooseReason(rl);

    write("\n处理方式：");
    write("1 只取消，不重建");
    write("2 修改餐品数量后重建（MVP 仅支持简单到店单）");
    const action = (await rl.question("选择处理方式：")).trim();
    if (!["1", "2"].includes(action)) throw new Error("处理方式无效");

    let buildDraft;
    if (action === "2") {
      if (!order.replayable) {
        throw new Error("该订单不能安全自动重建，流程已在取消前停止");
      }
      const updates = await chooseQuantities(rl, order);
      buildDraft = (freshOrder) => gateway.resolvePickupDraft(freshOrder, updates);
    }

    const result = await runRescue({
      gateway,
      confirmer: terminalConfirmer(rl),
      orderId: order.id,
      reasonCode,
      buildDraft,
    });
    renderResult(result, demo);
  } finally {
    rl.close();
    await gateway.close();
  }
}

main().catch((error) => {
  process.stderr.write(`错误：${redactText(error?.message ?? "未知错误")}\n`);
  process.exitCode = 1;
});
