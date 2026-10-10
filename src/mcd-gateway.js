const ENDPOINT = "https://mcp.mcd.cn";
const REQUIRED_TOOLS = Object.freeze([
  "order-list",
  "query-order",
  "cancel-order",
  "calculate-price",
  "create-order",
]);

const STATUS = Object.freeze({
  "1": "pending_payment",
  "2": "preparing",
  "4": "delivering",
  "6": "completed",
  "7": "cancelled",
  "8": "reviewed",
  "10": "preparing",
});

function parseObject(text) {
  const source = String(text ?? "").trim();
  const fences = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const fenced = fences.length === 1 ? fences[0][1].trim() : undefined;
  for (const candidate of [source, fenced]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next bounded candidate.
    }
  }
  return undefined;
}

function nonNegativeInteger(value, field) {
  if (value === undefined || value === null) {
    throw new Error(`${field} 缺失，已停止写操作`);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} 不是有效的非负安全整数金额`);
  }
  return value;
}

function yuanToFen(value) {
  // shortcut: order-list/query-order amounts follow the current live schema's yuan strings; add schema-version adapters if the server changes units.
  if (value === undefined || value === null) {
    throw new Error("订单金额缺失，已停止写操作");
  }
  const match = String(value).trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error("订单金额格式未知，已停止写操作");
  if (match[1] === "-") throw new Error("订单金额不能为负数，已停止写操作");
  const fen = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(fen)) throw new Error("订单金额超出安全范围，已停止写操作");
  return fen;
}

function cleanItems(listEntry) {
  return Object.freeze(
    (listEntry?.orderProductList ?? []).map((item) =>
      Object.freeze({
        productCode: String(item?.productCode ?? ""),
        name: String(item?.productName ?? "未命名餐品"),
        quantity: Number(item?.quantity ?? 0),
        comboItemList: Object.freeze(
          (item?.comboItemList ?? []).map((child) =>
            Object.freeze({
              productCode: String(child?.productCode ?? ""),
              name: String(child?.name ?? ""),
              quantity: Number(child?.quantity ?? 0),
            }),
          ),
        ),
      }),
    ),
  );
}

function detailItemsMatch(items, detail) {
  const detailItems = detail?.orderProductList;
  return (
    Array.isArray(detailItems) &&
    detailItems.length === items.length &&
    items.every((item, index) => {
      const detailItem = detailItems[index];
      const detailName = String(detailItem?.productName ?? detailItem?.name ?? "");
      return detailName === item.name && Number(detailItem?.quantity) === item.quantity;
    })
  );
}

function hasSelection(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function hasCustomization(order) {
  return (order?.orderProductList ?? []).some(
    (item) =>
      hasSelection(item?.comboItemList) ||
      hasSelection(item?.modification) ||
      hasSelection(item?.roundList),
  );
}

function orderEntries(payload) {
  const list = payload?.data?.list;
  if (!Array.isArray(list)) throw new Error("order-list 返回格式无效，已停止写操作");
  return list;
}

export function extractPayload(result) {
  if (result?.isError) throw new Error("MCP 工具返回业务错误");
  if (
    result?.structuredContent &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
  ) {
    return result.structuredContent;
  }

  const text = (result?.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  const payload = parseObject(text);
  if (!payload) throw new Error("MCP 返回无法安全解析，已停止写操作");
  return payload;
}

export function normalizeOrder(listEntry = {}, detail = {}) {
  const items = cleanItems(listEntry);
  if (!detailItemsMatch(items, detail)) {
    throw new Error("order-list 与 query-order 的餐品不一致，已停止写操作");
  }
  const statusCode = String(detail.orderStatus ?? listEntry.orderStatus ?? "");
  const orderType = Number(listEntry.orderType ?? 0);
  const beType = Number(listEntry.beType ?? 0);
  const needTableware = yuanToFen(detail.tablewarePrice ?? "0") > 0;
  const hasComboOrCustomization = hasCustomization(listEntry) || hasCustomization(detail);
  const coupons = detail.couponList ?? [];
  if (!Array.isArray(coupons)) {
    throw new Error("couponList 返回格式无效，已停止写操作");
  }
  const hasCoupon = coupons.length > 0;
  const completeSimpleItems =
    items.length > 0 &&
    items.every(
      (item) =>
        item.productCode.length > 0 &&
        Number.isInteger(item.quantity) &&
        item.quantity > 0,
    );
  const uniqueProductCodes = new Set(items.map(({ productCode }) => productCode)).size === items.length;
  const replayable =
    orderType === 1 &&
    beType === 1 &&
    completeSimpleItems &&
    uniqueProductCodes &&
    !hasComboOrCustomization &&
    !hasCoupon;

  return Object.freeze({
    id: String(detail.orderId ?? listEntry.orderId ?? ""),
    status: STATUS[statusCode] ?? "unknown",
    statusCode,
    storeCode: String(listEntry.storeCode ?? ""),
    storeName: String(detail.storeName ?? listEntry.storeName ?? "未知门店"),
    beCode: listEntry.beCode ? String(listEntry.beCode) : undefined,
    beType,
    orderType,
    takeWay: String(detail.takeWay ?? ""),
    needTableware,
    totalFen: yuanToFen(detail.realTotalAmount ?? listEntry.realTotalAmount),
    replayable,
    items,
  });
}

export function draftFromOrder(order, quantityUpdates = {}, takeWayCode) {
  if (!order?.replayable) throw new Error("该订单不能安全自动重建");
  const knownCodes = new Set(order.items.map(({ productCode }) => productCode));
  for (const code of Object.keys(quantityUpdates)) {
    if (!knownCodes.has(code)) throw new Error(`订单中不存在餐品 ${code}`);
  }

  const items = order.items
    .map((item) => {
      const requested = Object.hasOwn(quantityUpdates, item.productCode)
        ? Number(quantityUpdates[item.productCode])
        : item.quantity;
      if (!Number.isInteger(requested) || requested < 0 || requested > 20) {
        throw new Error("餐品数量必须是 0 到 20 的整数");
      }
      return Object.freeze({ productCode: item.productCode, quantity: requested });
    })
    .filter(({ quantity }) => quantity > 0);

  if (items.length === 0) throw new Error("替代订单至少保留一件餐品");

  return Object.freeze({
    storeCode: order.storeCode,
    beType: order.beType,
    orderType: order.orderType,
    ...(order.beType !== 1 && order.beCode ? { beCode: order.beCode } : {}),
    ...(takeWayCode ? { takeWayCode: String(takeWayCode) } : {}),
    needTableware: order.needTableware === true,
    items: Object.freeze(items),
  });
}

export function normalizeQuote(data = {}) {
  if (!Array.isArray(data.takeWayList) || data.takeWayList.length === 0) {
    throw new Error("takeWayList 缺失，已停止写操作");
  }
  return Object.freeze({
    originalFen: nonNegativeInteger(data.originalPrice, "originalPrice"),
    productFen: nonNegativeInteger(data.productPrice, "productPrice"),
    deliveryFen: nonNegativeInteger(data.deliveryPrice, "deliveryPrice"),
    packingFen: nonNegativeInteger(data.packingPrice ?? 0, "packingPrice"),
    discountFen: nonNegativeInteger(data.discount, "discount"),
    totalFen: nonNegativeInteger(data.price, "price"),
    takeWayList: Object.freeze(
      data.takeWayList.map((item) => {
        const code = String(item?.code ?? "").trim();
        const title = String(item?.title ?? "").trim();
        if (!code || !title) throw new Error("takeWayList 包含无效取餐方式");
        return Object.freeze({
          code,
          title,
          subtitle: String(item?.subtitle ?? ""),
        });
      }),
    ),
  });
}

export function assertRequiredTools(tools) {
  const names = new Set((tools ?? []).map(({ name }) => name));
  const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`MCP 缺少必要工具：${missing.join(", ")}`);
}

function quoteArguments(draft) {
  return Object.fromEntries(
    Object.entries({
      storeCode: draft.storeCode,
      orderType: draft.orderType,
      beType: draft.beType,
      beCode: draft.beCode,
      reservationDate: draft.reservationDate,
      gmServiceCode: draft.gmServiceCode,
      needTableware: draft.needTableware,
      withOrder: draft.withOrder,
      items: draft.items,
    }).filter(([, value]) => value !== undefined),
  );
}

function createArguments(draft) {
  if (draft.orderType === 1 && !draft.takeWayCode) {
    throw new Error("创建到店订单前必须选择取餐方式");
  }
  if (draft.orderType === 2 && !draft.addressId) {
    throw new Error("创建外送订单前必须选择配送地址");
  }
  return Object.fromEntries(
    Object.entries({
      ...quoteArguments(draft),
      addressId: draft.addressId,
      takeWayCode: draft.takeWayCode,
      remark: draft.remark,
    }).filter(([, value]) => value !== undefined),
  );
}

function safeHttpsUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

async function listAllTools(client) {
  const collected = [];
  const seenCursors = new Set();
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    collected.push(...(page.tools ?? []));
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error("MCP 工具分页游标重复");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return collected;
}

export class McdGateway {
  constructor(client, transport, tools) {
    this.client = client;
    this.transport = transport;
    this.tools = Object.freeze([...tools]);
  }

  static async connect(token = process.env.MCD_MCP_TOKEN) {
    const rawCredential = String(token ?? "");
    const credential = rawCredential.trim();
    if (!credential) throw new Error("缺少 MCD_MCP_TOKEN 环境变量");
    if (rawCredential !== credential || !/^[A-Za-z0-9._~+\/=\-]+$/.test(credential)) {
      throw new Error("MCD_MCP_TOKEN 格式无效");
    }
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    ]);
    const client = new Client({ name: "mcundo", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      requestInit: { headers: { Authorization: `Bearer ${credential}` } },
    });
    try {
      await client.connect(transport);
      const tools = await listAllTools(client);
      assertRequiredTools(tools);
      return new McdGateway(client, transport, tools);
    } catch {
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
      throw new Error("MCP 连接失败，请检查 Token 或网络");
    }
  }

  async call(name, arguments_) {
    try {
      const result = await this.client.callTool(
        { name, arguments: arguments_ },
        undefined,
        { timeout: 15_000 },
      );
      return extractPayload(result);
    } catch {
      throw new Error(`${name} 调用结果不确定或失败`);
    }
  }

  async listRecentOrders() {
    const payload = await this.call("order-list", {});
    return Object.freeze(
      orderEntries(payload).map((entry) => normalizeOrder(entry, entry)),
    );
  }

  async getOrder(orderId) {
    const [listPayload, detailPayload] = await Promise.all([
      this.call("order-list", {}),
      this.call("query-order", { orderId }),
    ]);
    const listEntry = orderEntries(listPayload).find(
      (item) => String(item?.orderId) === String(orderId),
    );
    const detail = detailPayload?.data;
    if (String(detail?.orderId ?? "") !== String(orderId)) {
      throw new Error("query-order 返回的订单号与请求不一致，已停止写操作");
    }
    return normalizeOrder(listEntry ?? { orderId }, detail);
  }

  async quote(draft) {
    const payload = await this.call("calculate-price", quoteArguments(draft));
    return normalizeQuote(payload?.data ?? {});
  }

  async resolvePickupDraft(order, quantityUpdates) {
    const provisional = draftFromOrder(order, quantityUpdates);
    const quote = await this.quote(provisional);
    const normalizedTakeWay = order.takeWay.trim().toLowerCase();
    const matches = quote.takeWayList.filter(
      ({ title }) =>
        normalizedTakeWay.length > 0 && title.trim().toLowerCase() === normalizedTakeWay,
    );
    const chosen = matches.length === 1 ? matches[0] : undefined;
    if (!chosen?.code) throw new Error("无法唯一还原取餐方式，请重新选择餐单");
    return Object.freeze({
      ...draftFromOrder(order, quantityUpdates, chosen.code),
      takeWayLabel: chosen.title,
    });
  }

  async cancelOnce(orderId, reasonCode) {
    const payload = await this.call("cancel-order", {
      orderId,
      cancelReasonCode: String(reasonCode),
    });
    return Object.freeze({
      ok: payload?.data?.cancelResult === true,
      orderId: String(payload?.data?.orderId ?? orderId),
    });
  }

  async createOnce(draft) {
    const payload = await this.call("create-order", createArguments(draft));
    const orderId = String(
      payload?.data?.orderId ?? payload?.data?.orderDetail?.orderId ?? "",
    ).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) {
      throw new Error("create-order 未返回订单号或格式无效，结果不确定");
    }
    return Object.freeze({
      orderId,
      payId: String(payload?.data?.payId ?? ""),
      payUrl: safeHttpsUrl(payload?.data?.payH5Url),
    });
  }

  doctor() {
    assertRequiredTools(this.tools);
    return Object.freeze({
      endpoint: ENDPOINT,
      toolCount: this.tools.length,
      requiredTools: REQUIRED_TOOLS,
    });
  }

  async close() {
    await this.transport?.terminateSession?.().catch(() => {});
    await this.client?.close?.().catch(() => {});
  }
}
