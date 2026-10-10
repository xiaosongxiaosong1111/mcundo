import test from "node:test";
import assert from "node:assert/strict";

import { McdGateway } from "../src/mcd-gateway.js";
import { runReadOnlyVerification } from "../src/live-verification.js";

const REQUIRED_TOOLS = Object.freeze([
  "order-list",
  "query-order",
  "cancel-order",
  "calculate-price",
  "create-order",
]);

const ORDER_ID = "ORDER-DEMO-0001";
const listEntry = Object.freeze({
  orderId: ORDER_ID,
  orderStatus: "1",
  orderType: "1",
  beType: "1",
  storeCode: "STORE-DEMO",
  storeName: "演示餐厅",
  realTotalAmount: "21.00",
  orderProductList: Object.freeze([
    Object.freeze({
      productCode: "P-BURGER",
      productName: "演示汉堡",
      quantity: 2,
      comboItemList: Object.freeze([]),
    }),
  ]),
});

const responses = Object.freeze({
  "order-list": Object.freeze({ data: Object.freeze({ list: Object.freeze([listEntry]) }) }),
  "query-order": Object.freeze({
    data: Object.freeze({
      orderId: ORDER_ID,
      orderStatus: "1",
      storeName: "演示餐厅",
      realTotalAmount: "21.00",
      takeWay: "外带",
      couponList: Object.freeze([]),
      orderProductList: Object.freeze([
        Object.freeze({ productName: "演示汉堡", quantity: 2, comboItemList: Object.freeze([]) }),
      ]),
    }),
  }),
  "calculate-price": Object.freeze({
    data: Object.freeze({
      originalPrice: 2100,
      productPrice: 2100,
      deliveryPrice: 0,
      packingPrice: 0,
      discount: 0,
      price: 2100,
      takeWayList: Object.freeze([
        Object.freeze({ code: "TAKE_OUT", title: "外带", subtitle: "柜台取餐" }),
      ]),
    }),
  }),
  "cancel-order": Object.freeze({
    data: Object.freeze({ cancelResult: true, orderId: ORDER_ID }),
  }),
  "create-order": Object.freeze({
    data: Object.freeze({
      orderId: "ORDER-DEMO-0002",
      payId: "PAY-DEMO-0002",
      payH5Url: "https://pay.example.invalid/demo",
    }),
  }),
});

function createHarness({ terminateError = false } = {}) {
  const calls = [];
  let clientCloseCount = 0;
  let terminateCount = 0;
  const client = {
    async callTool(request, outputSchema, options) {
      calls.push(Object.freeze({ request: structuredClone(request), outputSchema, options }));
      return { structuredContent: responses[request.name] };
    },
    async close() {
      clientCloseCount += 1;
    },
  };
  const transport = {
    async terminateSession() {
      terminateCount += 1;
      if (terminateError) throw new Error("synthetic termination failure");
    },
  };
  const gateway = new McdGateway(
    client,
    transport,
    REQUIRED_TOOLS.map((name) => Object.freeze({ name })),
  );
  return {
    calls,
    gateway,
    closeCounts: () => Object.freeze({ clientCloseCount, terminateCount }),
  };
}

test("McdGateway orchestrates read, quote, cancel, and create tools with bounded arguments", async () => {
  const { calls, gateway, closeCounts } = createHarness();

  const recent = await gateway.listRecentOrders();
  const order = await gateway.getOrder(ORDER_ID);
  const directQuote = await gateway.quote({
    storeCode: "STORE-DEMO",
    orderType: 1,
    beType: 1,
    needTableware: false,
    items: [{ productCode: "P-BURGER", quantity: 2 }],
    takeWayCode: "NOT_SENT_WHEN_QUOTING",
  });
  const draft = await gateway.resolvePickupDraft(order, { "P-BURGER": 1 });
  const cancelled = await gateway.cancelOnce(ORDER_ID, 3);
  const created = await gateway.createOnce(draft);
  const diagnosis = gateway.doctor();
  await gateway.close();

  assert.equal(recent[0].id, ORDER_ID);
  assert.equal(order.replayable, true);
  assert.equal(directQuote.totalFen, 2100);
  assert.equal(draft.takeWayCode, "TAKE_OUT");
  assert.deepEqual(cancelled, { ok: true, orderId: ORDER_ID });
  assert.deepEqual(created, {
    orderId: "ORDER-DEMO-0002",
    payId: "PAY-DEMO-0002",
    payUrl: "https://pay.example.invalid/demo",
  });
  assert.deepEqual(diagnosis, {
    endpoint: "https://mcp.mcd.cn",
    toolCount: REQUIRED_TOOLS.length,
    requiredTools: REQUIRED_TOOLS,
  });

  assert.deepEqual(
    calls.map(({ request }) => request),
    [
      { name: "order-list", arguments: {} },
      { name: "order-list", arguments: {} },
      { name: "query-order", arguments: { orderId: ORDER_ID } },
      {
        name: "calculate-price",
        arguments: {
          storeCode: "STORE-DEMO",
          orderType: 1,
          beType: 1,
          needTableware: false,
          items: [{ productCode: "P-BURGER", quantity: 2 }],
        },
      },
      {
        name: "calculate-price",
        arguments: {
          storeCode: "STORE-DEMO",
          orderType: 1,
          beType: 1,
          needTableware: false,
          items: [{ productCode: "P-BURGER", quantity: 1 }],
        },
      },
      {
        name: "cancel-order",
        arguments: { orderId: ORDER_ID, cancelReasonCode: "3" },
      },
      {
        name: "create-order",
        arguments: {
          storeCode: "STORE-DEMO",
          orderType: 1,
          beType: 1,
          needTableware: false,
          items: [{ productCode: "P-BURGER", quantity: 1 }],
          takeWayCode: "TAKE_OUT",
        },
      },
    ],
  );
  assert.ok(calls.every(({ outputSchema, options }) => outputSchema === undefined && options.timeout === 15_000));
  assert.equal(calls.filter(({ request }) => request.name === "cancel-order").length, 1);
  assert.equal(calls.filter(({ request }) => request.name === "create-order").length, 1);
  assert.deepEqual(closeCounts(), { clientCloseCount: 1, terminateCount: 1 });
});

test("close still closes the client when session termination fails", async () => {
  const { gateway, closeCounts } = createHarness({ terminateError: true });

  await assert.doesNotReject(() => gateway.close());

  assert.deepEqual(closeCounts(), { clientCloseCount: 1, terminateCount: 1 });
});

test("live verification calls only order-list and query-order", async () => {
  const { calls, gateway } = createHarness();

  const report = await runReadOnlyVerification(gateway);

  assert.equal(report.status, "ok");
  assert.equal(report.queryOrder, "ok");
  assert.deepEqual(
    calls.map(({ request }) => request.name),
    ["order-list", "order-list", "query-order"],
  );
  assert.equal(
    calls.some(({ request }) =>
      ["calculate-price", "cancel-order", "create-order"].includes(request.name)),
    false,
  );
});
