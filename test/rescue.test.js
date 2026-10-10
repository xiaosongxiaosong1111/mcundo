import test from "node:test";
import assert from "node:assert/strict";

import {
  orderFingerprint,
  redactText,
  runRescue,
  safeOrderSummary,
} from "../src/rescue.js";

const originalOrder = Object.freeze({
  id: "ORDER-20261010-12345678",
  status: "pending_payment",
  statusCode: "1",
  storeCode: "100001",
  storeName: "测试路餐厅",
  beCode: undefined,
  beType: 1,
  orderType: 1,
  totalFen: 4200,
  replayable: true,
  items: Object.freeze([
    Object.freeze({
      productCode: "P-BURGER",
      name: "测试汉堡",
      quantity: 2,
      roundList: Object.freeze([]),
      modification: undefined,
    }),
    Object.freeze({
      productCode: "P-COLA",
      name: "测试可乐",
      quantity: 1,
      roundList: Object.freeze([]),
      modification: undefined,
    }),
  ]),
});

const cancelledOrder = Object.freeze({
  ...originalOrder,
  status: "cancelled",
  statusCode: "7",
});

const replacementDraft = Object.freeze({
  storeCode: "100001",
  beType: 1,
  orderType: 1,
  takeWayCode: "TAKE_OUT",
  items: Object.freeze([
    Object.freeze({ productCode: "P-BURGER", quantity: 1 }),
  ]),
});

const quote = Object.freeze({
  originalFen: 2400,
  productFen: 2200,
  deliveryFen: 0,
  packingFen: 0,
  discountFen: 200,
  totalFen: 2200,
});

function makeGateway({
  orders = [originalOrder, originalOrder, cancelledOrder],
  quotes = [quote, quote],
  cancelResult = { ok: true },
  createResult = { orderId: "ORDER-NEW-87654321", payUrl: "https://pay.invalid/test" },
  cancelError,
  createError,
} = {}) {
  const calls = [];
  let orderIndex = 0;
  let quoteIndex = 0;

  return {
    calls,
    async getOrder(orderId) {
      calls.push(["getOrder", orderId]);
      const value = orders[Math.min(orderIndex, orders.length - 1)];
      orderIndex += 1;
      if (value instanceof Error) throw value;
      return value;
    },
    async quote(draft) {
      calls.push(["quote", draft]);
      const value = quotes[Math.min(quoteIndex, quotes.length - 1)];
      quoteIndex += 1;
      if (value instanceof Error) throw value;
      return value;
    },
    async cancelOnce(orderId, reasonCode) {
      calls.push(["cancelOnce", orderId, reasonCode]);
      if (cancelError) throw cancelError;
      return cancelResult;
    },
    async createOnce(draft) {
      calls.push(["createOnce", draft]);
      if (createError) throw createError;
      return createResult;
    },
  };
}

function acceptingConfirmer(requests = []) {
  return {
    async confirm(request) {
      requests.push(request);
      return { accepted: true, fingerprint: request.fingerprint };
    },
  };
}

test("happy path writes exactly once and only after cancellation is verified", async () => {
  const gateway = makeGateway();
  const confirmations = [];

  const result = await runRescue({
    gateway,
    confirmer: acceptingConfirmer(confirmations),
    orderId: originalOrder.id,
    reasonCode: "3",
    buildDraft: () => replacementDraft,
  });

  assert.equal(result.status, "created");
  assert.equal(gateway.calls.filter(([name]) => name === "cancelOnce").length, 1);
  assert.equal(gateway.calls.filter(([name]) => name === "createOnce").length, 1);
  assert.deepEqual(confirmations.map(({ action }) => action), ["cancel", "create"]);
  assert.equal(confirmations[0].safeSummary.replacement.total, "¥22.00");
  assert.equal(confirmations[0].safeSummary.replacement.takeWay, "TAKE_OUT");
  assert.deepEqual(confirmations[0].safeSummary.replacement.items, [
    {
      productCode: "P-BURGER",
      name: "测试汉堡",
      beforeQuantity: 2,
      afterQuantity: 1,
    },
    {
      productCode: "P-COLA",
      name: "测试可乐",
      beforeQuantity: 1,
      afterQuantity: 0,
    },
  ]);
  assert.deepEqual(
    confirmations[1].safeSummary.items,
    confirmations[0].safeSummary.replacement.items,
  );
  assert.ok(
    gateway.calls.findIndex(([name]) => name === "createOnce") >
      gateway.calls.findIndex(([name]) => name === "getOrder" && gateway.calls.filter(([n]) => n === "getOrder").length >= 3),
  );
});

test("refuses to cancel when a replacement cannot be reconstructed", async () => {
  const gateway = makeGateway({
    orders: [{ ...originalOrder, replayable: false }],
  });

  const result = await runRescue({
    gateway,
    confirmer: acceptingConfirmer(),
    orderId: originalOrder.id,
    reasonCode: "3",
    buildDraft: () => replacementDraft,
  });

  assert.equal(result.status, "not_replayable");
  assert.equal(gateway.calls.some(([name]) => name === "cancelOnce"), false);
  assert.equal(gateway.calls.some(([name]) => name === "createOnce"), false);
});

test("stops before cancellation when the replacement cannot be quoted", async () => {
  const gateway = makeGateway({ quotes: [new Error("quote failed")] });

  const result = await runRescue({
    gateway,
    confirmer: acceptingConfirmer(),
    orderId: originalOrder.id,
    reasonCode: "3",
    buildDraft: () => replacementDraft,
  });

  assert.equal(result.status, "replacement_quote_failed");
  assert.equal(gateway.calls.some(([name]) => name === "cancelOnce"), false);
});

test("does not write without an exact cancellation confirmation", async () => {
  const gateway = makeGateway();
  const confirmer = {
    async confirm(request) {
      return { accepted: false, fingerprint: request.fingerprint };
    },
  };

  const result = await runRescue({
    gateway,
    confirmer,
    orderId: originalOrder.id,
    reasonCode: "3",
    buildDraft: () => replacementDraft,
  });

  assert.equal(result.status, "cancel_declined");
  assert.equal(gateway.calls.some(([name]) => name === "cancelOnce"), false);
});

test("invalidates confirmation when the order changes before cancellation", async () => {
  const gateway = makeGateway({
    orders: [originalOrder, { ...originalOrder, totalFen: 4300 }],
  });

  const result = await runRescue({
    gateway,
    confirmer: acceptingConfirmer(),
    orderId: originalOrder.id,
    reasonCode: "3",
    buildDraft: () => replacementDraft,
  });

  assert.equal(result.status, "order_changed");
  assert.equal(gateway.calls.some(([name]) => name === "cancelOnce"), false);
});

test("never retries cancellation after an uncertain transport failure", async () => {
  const gateway = makeGateway({
    orders: [originalOrder, originalOrder, originalOrder],
    cancelError: new Error("timeout"),
  });

  const result = await runRescue({
    gateway,
    confirmer: acceptingConfirmer(),
    orderId: originalOrder.id,
    reasonCode: "3",
    buildDraft: () => replacementDraft,
  });

  assert.equal(result.status, "manual_check_required");
  assert.equal(gateway.calls.filter(([name]) => name === "cancelOnce").length, 1);
  assert.equal(gateway.calls.some(([name]) => name === "createOnce"), false);
});

test("does not rebuild until a fresh query confirms cancellation", async () => {
  const gateway = makeGateway({
    orders: [originalOrder, originalOrder, originalOrder],
  });

  const result = await runRescue({
    gateway,
    confirmer: acceptingConfirmer(),
    orderId: originalOrder.id,
    reasonCode: "3",
    buildDraft: () => replacementDraft,
  });

  assert.equal(result.status, "cancel_not_verified");
  assert.equal(gateway.calls.some(([name]) => name === "createOnce"), false);
});

test("cancellation-only never quotes or creates a replacement", async () => {
  const gateway = makeGateway();

  const result = await runRescue({
    gateway,
    confirmer: acceptingConfirmer(),
    orderId: originalOrder.id,
    reasonCode: "3",
  });

  assert.equal(result.status, "cancelled");
  assert.equal(gateway.calls.filter(([name]) => name === "cancelOnce").length, 1);
  assert.equal(gateway.calls.some(([name]) => name === "quote"), false);
  assert.equal(gateway.calls.some(([name]) => name === "createOnce"), false);
});

test("reports an uncertain cancellation when verification query fails", async () => {
  const gateway = makeGateway({
    orders: [originalOrder, originalOrder, new Error("query timeout")],
  });

  const result = await runRescue({
    gateway,
    confirmer: acceptingConfirmer(),
    orderId: originalOrder.id,
    reasonCode: "3",
    buildDraft: () => replacementDraft,
  });

  assert.equal(result.status, "manual_check_required");
  assert.equal(gateway.calls.filter(([name]) => name === "cancelOnce").length, 1);
  assert.equal(gateway.calls.some(([name]) => name === "createOnce"), false);
});

test("cancellation confirmation never authorizes the replacement order", async () => {
  const gateway = makeGateway();
  const confirmer = {
    async confirm(request) {
      return {
        accepted: request.action === "cancel",
        fingerprint: request.fingerprint,
      };
    },
  };

  const result = await runRescue({
    gateway,
    confirmer,
    orderId: originalOrder.id,
    reasonCode: "3",
    buildDraft: () => replacementDraft,
  });

  assert.equal(result.status, "cancelled_without_replacement");
  assert.equal(gateway.calls.some(([name]) => name === "createOnce"), false);
});

test("reports that cancellation succeeded when post-cancel quoting fails", async () => {
  const gateway = makeGateway({ quotes: [quote, new Error("quote failed")] });

  const result = await runRescue({
    gateway,
    confirmer: acceptingConfirmer(),
    orderId: originalOrder.id,
    reasonCode: "3",
    buildDraft: () => replacementDraft,
  });

  assert.equal(result.status, "cancelled_quote_failed");
  assert.equal(gateway.calls.some(([name]) => name === "createOnce"), false);
});

test("never retries creation after an uncertain transport failure", async () => {
  const gateway = makeGateway({ createError: new Error("timeout") });

  const result = await runRescue({
    gateway,
    confirmer: acceptingConfirmer(),
    orderId: originalOrder.id,
    reasonCode: "3",
    buildDraft: () => replacementDraft,
  });

  assert.equal(result.status, "create_unknown");
  assert.equal(gateway.calls.filter(([name]) => name === "createOnce").length, 1);
});

test("invalidates create confirmation when the final quote changes", async () => {
  const gateway = makeGateway({
    quotes: [quote, quote, { ...quote, totalFen: 2300 }],
  });

  const result = await runRescue({
    gateway,
    confirmer: acceptingConfirmer(),
    orderId: originalOrder.id,
    reasonCode: "3",
    buildDraft: () => replacementDraft,
  });

  assert.equal(result.status, "quote_changed");
  assert.equal(gateway.calls.some(([name]) => name === "createOnce"), false);
});

test("fingerprints are stable across object key order but change with the plan", () => {
  const a = orderFingerprint(originalOrder);
  const b = orderFingerprint({
    totalFen: 4200,
    items: originalOrder.items,
    id: originalOrder.id,
    orderType: 1,
    beType: 1,
    beCode: undefined,
    replayable: true,
    storeName: originalOrder.storeName,
    storeCode: originalOrder.storeCode,
    statusCode: "1",
    status: "pending_payment",
  });
  const changed = orderFingerprint({ ...originalOrder, totalFen: 4300 });
  const changedPickup = orderFingerprint({ ...originalOrder, takeWay: "堂食" });
  const changedReplayability = orderFingerprint({ ...originalOrder, replayable: false });

  assert.equal(a, b);
  assert.notEqual(a, changed);
  assert.notEqual(a, changedPickup);
  assert.notEqual(a, changedReplayability);
});

test("safe output never exposes token, full phone, full order id, pay link, or address", () => {
  const source =
    "Bearer secret-token-123 13812345678 ORDER-20261010-12345678 1030108270000795607354880945 https://pay.example/x 上海市测试区测试路88号1203室\u001b[2J";
  const redacted = redactText(source);
  const summary = safeOrderSummary({
    ...originalOrder,
    storeName: "Bearer nested-secret-456 13912345678 演示餐厅\u001b[2J\n伪造确认",
    items: [{
      ...originalOrder.items[0],
      productCode: "1030108270000795607354880945",
      name: "演示汉堡 测试路88号1203室 https://nested.invalid/x\u061c\u200e\u200f",
    }],
    phone: "13812345678",
    address: "上海市测试区测试路88号1203室",
    payUrl: "https://pay.example/x",
  });

  assert.doesNotMatch(redacted, /secret-token-123|13812345678|ORDER-20261010-12345678|1030108270000795607354880945|pay\.example|1203/);
  assert.doesNotMatch(JSON.stringify(summary), /nested-secret-456|13912345678|1030108270000795607354880945|nested\.invalid|1203/);
  assert.doesNotMatch(redacted, /[\u0000-\u001f\u007f-\u009f]/);
  assert.doesNotMatch(redacted, /\p{Bidi_Control}/u);
  assert.doesNotMatch(summary.store, /[\u0000-\u001f\u007f-\u009f]/);
  assert.doesNotMatch(summary.store, /\p{Bidi_Control}/u);
  assert.doesNotMatch(summary.items[0].name, /[\u0000-\u001f\u007f-\u009f]/);
  assert.doesNotMatch(summary.items[0].name, /\p{Bidi_Control}/u);
  assert.match(JSON.stringify(summary), /5678/);
});
