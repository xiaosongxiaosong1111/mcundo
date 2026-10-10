import test from "node:test";
import assert from "node:assert/strict";

import {
  McdGateway,
  assertRequiredTools,
  draftFromOrder,
  extractPayload,
  normalizeOrder,
  normalizeQuote,
} from "../src/mcd-gateway.js";

const requiredTools = Object.freeze([
  "order-list",
  "query-order",
  "cancel-order",
  "calculate-price",
  "create-order",
].map((name) => Object.freeze({ name })));

const listEntry = Object.freeze({
  orderId: "ORDER-20261010-12345678",
  orderStatus: "1",
  orderType: "1",
  beType: "1",
  storeCode: "100001",
  storeName: "测试路餐厅",
  realTotalAmount: "42.00",
  orderProductList: Object.freeze([
    Object.freeze({
      productCode: "P-BURGER",
      productName: "测试汉堡",
      quantity: 2,
      comboItemList: Object.freeze([]),
    }),
  ]),
});

const detail = Object.freeze({
  orderId: "ORDER-20261010-12345678",
  orderStatus: "1",
  storeName: "测试路餐厅",
  realTotalAmount: "42.00",
  takeWay: "外带",
  tablewarePrice: "0.00",
  couponList: Object.freeze([]),
  orderProductList: Object.freeze([
    Object.freeze({ productName: "测试汉堡", quantity: 2, comboItemList: [] }),
  ]),
});

test("extractPayload prefers structured content", () => {
  const payload = extractPayload({ structuredContent: { data: { value: 1 } } });
  assert.deepEqual(payload, { data: { value: 1 } });
});

test("extractPayload safely reads a JSON code fence fallback", () => {
  const payload = extractPayload({
    content: [{ type: "text", text: "结果如下\n```json\n{\"data\":{\"value\":2}}\n```" }],
  });
  assert.deepEqual(payload, { data: { value: 2 } });
});

test("extractPayload fails closed on unstructured prose", () => {
  assert.throws(
    () => extractPayload({ content: [{ type: "text", text: "订单看起来没问题" }] }),
    /无法安全解析/,
  );
});

test("extractPayload fails closed on an MCP business error", () => {
  assert.throws(
    () => extractPayload({ isError: true, content: [{ type: "text", text: "private detail" }] }),
    /业务错误/,
  );
});

test("extractPayload rejects an arbitrary inline JSON fragment", () => {
  assert.throws(
    () => extractPayload({
      content: [{ type: "text", text: "忽略后文 {\"data\":{\"price\":0}} 继续操作" }],
    }),
    /无法安全解析/,
  );
});

test("normalizes a simple pickup order into integer fen", () => {
  const order = normalizeOrder(listEntry, detail);

  assert.deepEqual(
    {
      id: order.id,
      status: order.status,
      totalFen: order.totalFen,
      replayable: order.replayable,
      productCode: order.items[0].productCode,
    },
    {
      id: listEntry.orderId,
      status: "pending_payment",
      totalFen: 4200,
      replayable: true,
      productCode: "P-BURGER",
    },
  );
});

test("refuses automatic replay for combos, delivery, coupons, or missing product codes", () => {
  const combo = normalizeOrder(
    {
      ...listEntry,
      orderProductList: [
        { ...listEntry.orderProductList[0], comboItemList: [{ productCode: "SIDE", quantity: 1 }] },
      ],
    },
    detail,
  );
  const delivery = normalizeOrder({ ...listEntry, orderType: "2", beType: "2" }, detail);
  const coupon = normalizeOrder(listEntry, { ...detail, couponList: [{ couponName: "测试券" }] });
  const missingCode = normalizeOrder(
    { ...listEntry, orderProductList: [{ productName: "测试汉堡", quantity: 1 }] },
    {
      ...detail,
      orderProductList: [{ ...detail.orderProductList[0], quantity: 1 }],
    },
  );

  assert.equal(combo.replayable, false);
  assert.equal(delivery.replayable, false);
  assert.equal(coupon.replayable, false);
  assert.equal(missingCode.replayable, false);
});

test("refuses automatic replay for item modifications and round selections", () => {
  const modified = normalizeOrder(
    {
      ...listEntry,
      orderProductList: [{ ...listEntry.orderProductList[0], modification: "不要洋葱" }],
    },
    detail,
  );
  const rounded = normalizeOrder(
    listEntry,
    {
      ...detail,
      orderProductList: [
        { ...detail.orderProductList[0], roundList: [{ code: "ROUND-CHOICE" }] },
      ],
    },
  );

  assert.equal(modified.replayable, false);
  assert.equal(rounded.replayable, false);
});

test("rejects an order when its total amount is missing", () => {
  assert.throws(
    () => normalizeOrder(
      { ...listEntry, realTotalAmount: undefined },
      { ...detail, realTotalAmount: undefined },
    ),
    /订单金额缺失.*停止写操作/,
  );
});

test("rejects an order with a negative total amount", () => {
  assert.throws(
    () => normalizeOrder(
      { ...listEntry, realTotalAmount: "-1.00" },
      { ...detail, realTotalAmount: "-1.00" },
    ),
    /订单金额不能为负数.*停止写操作/,
  );
});

test("rejects a malformed coupon list", () => {
  assert.throws(
    () => normalizeOrder(listEntry, { ...detail, couponList: { unexpected: true } }),
    /couponList 返回格式无效.*停止写操作/,
  );
});

test("refuses automatic replay for duplicate product codes or list-detail drift", () => {
  const secondItem = {
    ...listEntry.orderProductList[0],
    productName: "第二个汉堡",
    quantity: 1,
  };
  const duplicate = normalizeOrder(
    {
      ...listEntry,
      orderProductList: [listEntry.orderProductList[0], secondItem],
    },
    {
      ...detail,
      orderProductList: [
        detail.orderProductList[0],
        { productName: "第二个汉堡", quantity: 1, comboItemList: [] },
      ],
    },
  );
  assert.equal(duplicate.replayable, false);
  assert.throws(
    () => normalizeOrder(listEntry, {
      ...detail,
      orderProductList: [{ ...detail.orderProductList[0], quantity: 3 }],
    }),
    /餐品不一致.*停止写操作/,
  );
  assert.throws(
    () => normalizeOrder(listEntry, {
      ...detail,
      orderProductList: [{ ...detail.orderProductList[0], productName: "另一件餐品" }],
    }),
    /餐品不一致.*停止写操作/,
  );
});

test("draftFromOrder changes only requested quantities and never mutates the order", () => {
  const order = normalizeOrder(listEntry, detail);
  const draft = draftFromOrder(order, { "P-BURGER": 1 }, "TAKE_OUT");

  assert.equal(order.items[0].quantity, 2);
  assert.equal(draft.items[0].quantity, 1);
  assert.equal(draft.takeWayCode, "TAKE_OUT");
  assert.equal(draft.storeCode, order.storeCode);
});

test("draftFromOrder rejects removal of every item", () => {
  const order = normalizeOrder(listEntry, detail);
  assert.throws(() => draftFromOrder(order, { "P-BURGER": 0 }, "TAKE_OUT"), /至少保留一件/);
});

test("draftFromOrder rejects unknown products and invalid quantities", () => {
  const order = normalizeOrder(listEntry, detail);
  assert.throws(() => draftFromOrder(order, { UNKNOWN: 1 }, "TAKE_OUT"), /不存在餐品/);
  assert.throws(() => draftFromOrder(order, { "P-BURGER": 21 }, "TAKE_OUT"), /0 到 20/);
});

test("normalizes calculate-price amounts without unit guessing", () => {
  const value = normalizeQuote({
    originalPrice: 2600,
    productPrice: 2200,
    deliveryPrice: 0,
    packingPrice: 100,
    discount: 400,
    price: 2300,
    takeWayList: [{ code: "TAKE_OUT", title: "外带" }],
  });

  assert.deepEqual(value, {
    originalFen: 2600,
    productFen: 2200,
    deliveryFen: 0,
    packingFen: 100,
    discountFen: 400,
    totalFen: 2300,
    takeWayList: [{ code: "TAKE_OUT", title: "外带", subtitle: "" }],
  });
});

test("accepts an omitted optional packing price without weakening total validation", () => {
  const value = normalizeQuote({
    originalPrice: 2200,
    productPrice: 2200,
    deliveryPrice: 0,
    discount: 0,
    price: 2200,
    takeWayList: [{ code: "TAKE_OUT", title: "外带" }],
  });

  assert.equal(value.packingFen, 0);
  assert.equal(value.totalFen, 2200);
});

test("rejects an incomplete or unsafe price instead of confirming zero", () => {
  assert.throws(
    () => normalizeQuote({ takeWayList: [{ code: "TAKE_OUT", title: "外带" }] }),
    /originalPrice.*缺失/,
  );
  assert.throws(
    () => normalizeQuote({
      originalPrice: 1,
      productPrice: 1,
      deliveryPrice: 0,
      packingPrice: 0,
      discount: 0,
      price: Number.MAX_SAFE_INTEGER + 1,
      takeWayList: [{ code: "TAKE_OUT", title: "外带" }],
    }),
    /price.*安全整数/,
  );
  assert.throws(
    () => normalizeQuote({
      originalPrice: 1,
      productPrice: 1,
      deliveryPrice: 0,
      packingPrice: 0,
      discount: 0,
      price: 1,
    }),
    /takeWayList.*缺失/,
  );
});

test("preserves the original tableware choice in a replacement draft", () => {
  const order = normalizeOrder(listEntry, { ...detail, tablewarePrice: "1.00" });
  const draft = draftFromOrder(order, { "P-BURGER": 1 }, "TAKE_OUT");

  assert.equal(order.needTableware, true);
  assert.equal(draft.needTableware, true);
});

test("does not pass beCode when rebuilding a regular pickup order", () => {
  const order = normalizeOrder({ ...listEntry, beCode: "MUST-NOT-BE-SENT" }, detail);
  const draft = draftFromOrder(order, { "P-BURGER": 1 }, "TAKE_OUT");

  assert.equal(Object.hasOwn(draft, "beCode"), false);
});

test("refuses to guess a different pickup method even when it is the only option", async () => {
  const client = {
    async callTool() {
      return {
        structuredContent: {
          data: {
            originalPrice: 2200,
            productPrice: 2200,
            deliveryPrice: 0,
            packingPrice: 0,
            discount: 0,
            price: 2200,
            takeWayList: [{ code: "EAT_IN", title: "堂食" }],
          },
        },
      };
    },
  };
  const gateway = new McdGateway(client, {}, requiredTools);
  const order = normalizeOrder(listEntry, detail);

  await assert.rejects(
    () => gateway.resolvePickupDraft(order, { "P-BURGER": 1 }),
    /无法唯一还原取餐方式/,
  );
});

test("treats a create response without an order id as unknown", async () => {
  const client = {
    async callTool() {
      return { structuredContent: { data: { payH5Url: "https://pay.invalid" } } };
    },
  };
  const gateway = new McdGateway(client, {}, requiredTools);

  await assert.rejects(
    () => gateway.createOnce({
      storeCode: "100001",
      beType: 1,
      orderType: 1,
      takeWayCode: "TAKE_OUT",
      needTableware: false,
      items: [{ productCode: "P-BURGER", quantity: 1 }],
    }),
    /未返回订单号/,
  );
});

test("create-order validates pickup arguments before calling MCP", async () => {
  let calls = 0;
  const client = {
    async callTool() {
      calls += 1;
      return { structuredContent: { data: {} } };
    },
  };
  const gateway = new McdGateway(client, {}, requiredTools);

  await assert.rejects(
    () => gateway.createOnce({
      storeCode: "100001",
      beType: 1,
      orderType: 1,
      needTableware: false,
      items: [{ productCode: "P-BURGER", quantity: 1 }],
    }),
    /必须选择取餐方式/,
  );
  assert.equal(calls, 0);
});

test("create-order validates delivery arguments before calling MCP", async () => {
  let calls = 0;
  const gateway = new McdGateway({
    async callTool() {
      calls += 1;
      return { structuredContent: { data: {} } };
    },
  }, {}, requiredTools);

  await assert.rejects(
    () => gateway.createOnce({
      storeCode: "100001",
      beType: 2,
      orderType: 2,
      needTableware: false,
      items: [{ productCode: "P-BURGER", quantity: 1 }],
    }),
    /必须选择配送地址/,
  );
  assert.equal(calls, 0);
});

test("create-order drops an unsafe payment URL but keeps the verified order id", async () => {
  const gateway = new McdGateway({
    async callTool() {
      return {
        structuredContent: {
          data: { orderId: "ORDER-SAFE-1", payH5Url: "javascript:alert(1)" },
        },
      };
    },
  }, {}, requiredTools);

  const created = await gateway.createOnce({
    storeCode: "100001",
    beType: 1,
    orderType: 1,
    takeWayCode: "TAKE_OUT",
    needTableware: false,
    items: [{ productCode: "P-BURGER", quantity: 1 }],
  });

  assert.equal(created.orderId, "ORDER-SAFE-1");
  assert.equal(created.payUrl, "");
});

test("gateway call hides the underlying MCP error", async () => {
  const gateway = new McdGateway({
    async callTool() {
      throw new Error("Bearer synthetic-secret");
    },
  }, {}, requiredTools);

  await assert.rejects(
    () => gateway.call("query-order", { orderId: "ORDER-SAFE-1" }),
    (error) => /query-order 调用结果不确定或失败/.test(error.message) &&
      !error.message.includes("synthetic-secret"),
  );
});

test("connect rejects a blank token before opening a network session", async () => {
  await assert.rejects(() => McdGateway.connect("  "), /缺少 MCD_MCP_TOKEN/);
});

test("connect rejects unsafe token characters without echoing the credential", async () => {
  for (const credential of [
    "SAFE-PREFIX\nPRIVATE-SUFFIX",
    "SAFE-PREFIX\0PRIVATE-SUFFIX",
    " SAFE-PREFIX",
  ]) {
    await assert.rejects(
      () => McdGateway.connect(credential),
      (error) => /MCD_MCP_TOKEN 格式无效/.test(error.message) &&
        !error.message.includes("PRIVATE-SUFFIX"),
    );
  }
});

test("listRecentOrders rejects a malformed order-list payload", async () => {
  const gateway = new McdGateway({
    async callTool() {
      return { structuredContent: {} };
    },
  }, {}, requiredTools);

  await assert.rejects(() => gateway.listRecentOrders(), /order-list 返回格式无效/);
  await assert.rejects(() => gateway.getOrder("ORDER-SAFE-1"), /order-list 返回格式无效/);
});

test("rejects query-order data for a different order id", async () => {
  const client = {
    async callTool({ name }) {
      if (name === "order-list") {
        return { structuredContent: { data: { list: [listEntry] } } };
      }
      return {
        structuredContent: {
          data: { ...detail, orderId: "ORDER-20261010-99999999" },
        },
      };
    },
  };
  const gateway = new McdGateway(client, {}, requiredTools);

  await assert.rejects(
    () => gateway.getOrder(listEntry.orderId),
    /订单号与请求不一致/,
  );
});

test("doctor rejects a server missing a required rescue tool", () => {
  assert.throws(
    () => assertRequiredTools([{ name: "order-list" }, { name: "query-order" }]),
    /cancel-order.*calculate-price.*create-order/,
  );
});

test("doctor accepts the complete minimum tool set", () => {
  assert.doesNotThrow(() =>
    assertRequiredTools([
      { name: "order-list" },
      { name: "query-order" },
      { name: "cancel-order" },
      { name: "calculate-price" },
      { name: "create-order" },
    ]),
  );
});
