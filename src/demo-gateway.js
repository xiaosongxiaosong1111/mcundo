import { draftFromOrder } from "./mcd-gateway.js";

function freezeOrder(order) {
  return Object.freeze({
    ...order,
    items: Object.freeze(order.items.map((item) => Object.freeze({ ...item }))),
  });
}

const INITIAL_ORDER = freezeOrder({
  id: "DEMO-ORDER-12345678",
  status: "pending_payment",
  statusCode: "1",
  storeCode: "100001",
  storeName: "麦单回正演示餐厅",
  beType: 1,
  orderType: 1,
  takeWay: "外带",
  totalFen: 4200,
  replayable: true,
  items: [
    {
      productCode: "P-BURGER",
      name: "演示汉堡",
      quantity: 2,
      comboItemList: Object.freeze([]),
    },
  ],
});

export class DemoGateway {
  constructor() {
    this.state = Object.freeze({ original: INITIAL_ORDER, created: undefined });
  }

  async listRecentOrders() {
    return Object.freeze(
      [this.state.created, this.state.original].filter(Boolean),
    );
  }

  async getOrder(orderId) {
    const found = [this.state.original, this.state.created].find(
      (order) => order?.id === orderId,
    );
    if (!found) throw new Error("演示订单不存在");
    return found;
  }

  async quote(draft) {
    const count = draft.items.reduce((sum, item) => sum + item.quantity, 0);
    const originalFen = count * 2400;
    const productFen = count * 2200;
    return Object.freeze({
      originalFen,
      productFen,
      deliveryFen: 0,
      packingFen: 0,
      discountFen: originalFen - productFen,
      totalFen: productFen,
      takeWayList: Object.freeze([
        Object.freeze({ code: "TAKE_OUT", title: "外带", subtitle: "" }),
      ]),
    });
  }

  async resolvePickupDraft(order, quantityUpdates) {
    return draftFromOrder(order, quantityUpdates, "TAKE_OUT");
  }

  async cancelOnce(orderId) {
    if (this.state.original.id !== orderId || this.state.original.status === "cancelled") {
      return Object.freeze({ ok: false, orderId });
    }
    const original = freezeOrder({
      ...this.state.original,
      status: "cancelled",
      statusCode: "7",
    });
    this.state = Object.freeze({ ...this.state, original });
    return Object.freeze({ ok: true, orderId });
  }

  async createOnce(draft) {
    const quote = await this.quote(draft);
    const created = freezeOrder({
      id: "DEMO-NEW-87654321",
      status: "pending_payment",
      statusCode: "1",
      storeCode: draft.storeCode,
      storeName: this.state.original.storeName,
      beType: draft.beType,
      orderType: draft.orderType,
      takeWay: "外带",
      totalFen: quote.totalFen,
      replayable: true,
      items: draft.items.map((item) => ({
        ...item,
        name: item.productCode === "P-BURGER" ? "演示汉堡" : "演示餐品",
        comboItemList: Object.freeze([]),
      })),
    });
    this.state = Object.freeze({ ...this.state, created });
    return Object.freeze({
      orderId: created.id,
      payId: "DEMO-PAY-ID",
      payUrl: "https://pay.example.invalid/demo",
    });
  }

  doctor() {
    return Object.freeze({
      endpoint: "demo://local",
      toolCount: 5,
      requiredTools: Object.freeze([
        "order-list",
        "query-order",
        "cancel-order",
        "calculate-price",
        "create-order",
      ]),
    });
  }

  async close() {}
}
