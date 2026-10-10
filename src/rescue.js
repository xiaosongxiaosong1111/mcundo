import { createHash } from "node:crypto";

const CANCELLATION_REASONS = new Set(["-1", "1", "2", "3", "4", "5"]);

function singleLine(value, fallback = "") {
  const text = String(value ?? "")
    .replace(/\p{Bidi_Control}/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex")
    .slice(0, 16);
}

function orderTail(orderId) {
  return singleLine(orderId).slice(-4).padStart(4, "*");
}

function money(fen) {
  return `¥${(Number(fen || 0) / 100).toFixed(2)}`;
}

function accepted(confirmation, expectedFingerprint) {
  return (
    confirmation?.accepted === true &&
    confirmation?.fingerprint === expectedFingerprint
  );
}

function isCancelled(order) {
  return order?.status === "cancelled" || String(order?.statusCode) === "7";
}

function quoteFingerprint(draft, quote) {
  return fingerprint({ draft, quote });
}

export function orderFingerprint(order) {
  return fingerprint({
    id: order?.id,
    status: order?.status,
    statusCode: order?.statusCode,
    storeCode: order?.storeCode,
    beCode: order?.beCode,
    beType: order?.beType,
    orderType: order?.orderType,
    takeWay: order?.takeWay,
    needTableware: order?.needTableware,
    totalFen: order?.totalFen,
    replayable: order?.replayable,
    items: order?.items,
  });
}

export function redactText(value) {
  return singleLine(value)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [已隐藏]")
    .replace(/https?:\/\/[^\s]+/gi, "[链接已隐藏]")
    .replace(/\b1[3-9]\d{9}\b/g, (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`)
    .replace(/\b[A-Za-z]+-\d{8}-\d{8}\b/g, (id) => `订单…${id.slice(-4)}`)
    .replace(/\b\d{20,64}\b/g, (id) => `订单…${id.slice(-4)}`)
    .replace(/[\u4e00-\u9fff]{2,}(?:路|街|道|弄|巷)\d+(?:号)?[^\s,，。;；]*/g, "[地址已隐藏]");
}

export function safeOrderSummary(order) {
  return Object.freeze({
    order: `订单…${orderTail(order?.id)}`,
    status: redactText(order?.status) || "unknown",
    store: redactText(order?.storeName) || "未知门店",
    total: money(order?.totalFen),
    items: Object.freeze(
      (order?.items ?? []).map((item) =>
        Object.freeze({
          productCode: redactText(item?.productCode) || "无商品编码",
          name: redactText(item?.name) || "未命名餐品",
          quantity: Number(item?.quantity ?? 0),
        }),
      ),
    ),
  });
}

function assertInputs({ gateway, confirmer, orderId, reasonCode }) {
  if (!gateway || !confirmer) throw new TypeError("gateway 和 confirmer 必填");
  if (!String(orderId ?? "").trim()) throw new TypeError("orderId 必填");
  if (!CANCELLATION_REASONS.has(String(reasonCode))) {
    throw new TypeError("不支持的取消原因");
  }
}

function replacementSummary(original, draft, quote) {
  const safeItems = safeOrderSummary(original).items;
  return Object.freeze({
    total: money(quote.totalFen),
    takeWay: redactText(draft.takeWayLabel ?? draft.takeWayCode) || "未知",
    items: Object.freeze(
      safeItems.map((item, index) => {
        const rawCode = original.items[index]?.productCode;
        const replacement = (draft.items ?? []).find(
          (candidate) => candidate.productCode === rawCode,
        );
        return Object.freeze({
          productCode: item.productCode,
          name: item.name,
          beforeQuantity: item.quantity,
          afterQuantity: replacement ? Number(replacement.quantity) : 0,
        });
      }),
    ),
  });
}

export async function runRescue({
  gateway,
  confirmer,
  orderId,
  reasonCode,
  buildDraft,
}) {
  assertInputs({ gateway, confirmer, orderId, reasonCode });

  const original = await gateway.getOrder(orderId);
  let draft;
  let initialQuote;

  if (buildDraft) {
    if (!original?.replayable) {
      return { status: "not_replayable", order: safeOrderSummary(original) };
    }

    draft = await buildDraft(original);
    if (!draft) return { status: "not_replayable", order: safeOrderSummary(original) };

    try {
      initialQuote = await gateway.quote(draft);
    } catch {
      return { status: "replacement_quote_failed", order: safeOrderSummary(original) };
    }
  }

  const cancelFingerprint = fingerprint({
    order: orderFingerprint(original),
    reasonCode: String(reasonCode),
    draft,
    initialQuote,
  });
  const cancelConfirmation = await confirmer.confirm({
    action: "cancel",
    fingerprint: cancelFingerprint,
    expectedPhrase: `取消 ${orderTail(orderId)}`,
    safeSummary: draft
      ? Object.freeze({
          original: safeOrderSummary(original),
          replacement: replacementSummary(original, draft, initialQuote),
        })
      : safeOrderSummary(original),
  });

  if (!accepted(cancelConfirmation, cancelFingerprint)) {
    return { status: "cancel_declined", order: safeOrderSummary(original) };
  }

  const freshOrder = await gateway.getOrder(orderId);
  if (orderFingerprint(freshOrder) !== orderFingerprint(original)) {
    return { status: "order_changed", order: safeOrderSummary(freshOrder) };
  }

  let cancelResult;
  try {
    cancelResult = await gateway.cancelOnce(orderId, String(reasonCode));
  } catch {
    let latest;
    try {
      latest = await gateway.getOrder(orderId);
    } catch {
      latest = undefined;
    }
    return {
      status: "manual_check_required",
      order: latest ? safeOrderSummary(latest) : safeOrderSummary(freshOrder),
    };
  }

  if (cancelResult?.ok !== true) {
    return { status: "cancel_failed", order: safeOrderSummary(freshOrder) };
  }

  let cancelled;
  try {
    cancelled = await gateway.getOrder(orderId);
  } catch {
    return { status: "manual_check_required", order: safeOrderSummary(freshOrder) };
  }
  if (!isCancelled(cancelled)) {
    return { status: "cancel_not_verified", order: safeOrderSummary(cancelled) };
  }

  if (!draft) {
    return { status: "cancelled", order: safeOrderSummary(cancelled) };
  }

  let currentQuote;
  try {
    currentQuote = await gateway.quote(draft);
  } catch {
    return { status: "cancelled_quote_failed", order: safeOrderSummary(cancelled) };
  }

  const createFingerprint = quoteFingerprint(draft, currentQuote);
  const createConfirmation = await confirmer.confirm({
    action: "create",
    fingerprint: createFingerprint,
    expectedPhrase: `下单 ${money(currentQuote.totalFen)}`,
    safeSummary: Object.freeze({
      previousOrder: `订单…${orderTail(orderId)}`,
      ...replacementSummary(original, draft, currentQuote),
    }),
  });

  if (!accepted(createConfirmation, createFingerprint)) {
    return {
      status: "cancelled_without_replacement",
      order: safeOrderSummary(cancelled),
      quote: currentQuote,
    };
  }

  let finalQuote;
  try {
    finalQuote = await gateway.quote(draft);
  } catch {
    return { status: "cancelled_quote_failed", order: safeOrderSummary(cancelled) };
  }

  if (quoteFingerprint(draft, finalQuote) !== createFingerprint) {
    return {
      status: "quote_changed",
      order: safeOrderSummary(cancelled),
      quote: finalQuote,
    };
  }

  try {
    const created = await gateway.createOnce(draft);
    return {
      status: "created",
      order: safeOrderSummary(cancelled),
      quote: finalQuote,
      created,
    };
  } catch {
    return {
      status: "create_unknown",
      order: safeOrderSummary(cancelled),
      quote: finalQuote,
    };
  }
}
