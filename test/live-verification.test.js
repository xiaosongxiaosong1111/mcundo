import test from "node:test";
import assert from "node:assert/strict";

import { runReadOnlyVerification } from "../src/live-verification.js";

test("read-only verification succeeds without querying when there are no recent orders", async () => {
  const calls = [];
  const gateway = {
    doctor() {
      calls.push("doctor");
      return { endpoint: "https://mcp.mcd.cn" };
    },
    async listRecentOrders() {
      calls.push("listRecentOrders");
      return [];
    },
    async getOrder() {
      calls.push("getOrder");
      throw new Error("must not query an absent order");
    },
  };

  const report = await runReadOnlyVerification(gateway);

  assert.deepEqual(report, {
    status: "partial",
    mode: "read-only",
    endpoint: "https://mcp.mcd.cn",
    orderList: "ok",
    queryOrder: "skipped_no_recent_order",
    recentOrderCount: 0,
    sampleOrderValidated: false,
    writeOperations: "not_called",
  });
  assert.deepEqual(calls, ["doctor", "listRecentOrders"]);
  assert.equal(Object.isFrozen(report), true);
});

test("read-only verification validates one order without returning account data", async () => {
  const privateOrderId = "PRIVATE-ORDER-12345678";
  const calls = [];
  const gateway = {
    doctor() {
      calls.push("doctor");
      return { endpoint: "https://mcp.mcd.cn" };
    },
    async listRecentOrders() {
      calls.push("listRecentOrders");
      return [{ id: privateOrderId }];
    },
    async getOrder(orderId) {
      calls.push(`getOrder:${orderId}`);
      return {
        id: privateOrderId,
        storeName: "私人地址餐厅\u202e",
        phone: "13800138000",
        payUrl: "https://private.invalid/order",
        token: "Bearer private-token",
      };
    },
  };

  const report = await runReadOnlyVerification(gateway);
  const output = JSON.stringify(report);

  assert.deepEqual(report, {
    status: "ok",
    mode: "read-only",
    endpoint: "https://mcp.mcd.cn",
    orderList: "ok",
    queryOrder: "ok",
    recentOrderCount: 1,
    sampleOrderValidated: true,
    writeOperations: "not_called",
  });
  assert.deepEqual(calls, ["doctor", "listRecentOrders", `getOrder:${privateOrderId}`]);
  assert.doesNotMatch(output, /PRIVATE|13800138000|private\.invalid|private-token|私人地址|\u202e/i);
});

test("read-only verification rejects a non-empty order list without a queryable id", async () => {
  let queried = false;
  const gateway = {
    doctor: () => ({ endpoint: "https://mcp.mcd.cn" }),
    listRecentOrders: async () => [{ id: "  " }],
    async getOrder() {
      queried = true;
    },
  };

  await assert.rejects(
    () => runReadOnlyVerification(gateway),
    /近期订单缺少可查询订单号/,
  );
  assert.equal(queried, false);
});

test("read-only verification rejects a mismatched queried order", async () => {
  const gateway = {
    doctor: () => ({ endpoint: "https://mcp.mcd.cn" }),
    listRecentOrders: async () => [{ id: "EXPECTED-ORDER" }],
    getOrder: async () => ({ id: "DIFFERENT-ORDER" }),
  };

  await assert.rejects(
    () => runReadOnlyVerification(gateway),
    /query-order 返回验证失败/,
  );
});
