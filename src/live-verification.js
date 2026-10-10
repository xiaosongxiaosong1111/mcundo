export async function runReadOnlyVerification(gateway) {
  const diagnosis = gateway.doctor();
  const orders = await gateway.listRecentOrders();
  if (!Array.isArray(orders)) throw new Error("order-list 返回格式无效");

  let queryOrder = "skipped_no_recent_order";
  let sampleOrderValidated = false;
  if (orders.length > 0) {
    const candidate = orders.find((order) => String(order?.id ?? "").trim().length > 0);
    if (!candidate) throw new Error("近期订单缺少可查询订单号");

    const orderId = String(candidate.id).trim();
    const detail = await gateway.getOrder(orderId);
    if (!detail || String(detail.id) !== orderId) {
      throw new Error("query-order 返回验证失败");
    }
    queryOrder = "ok";
    sampleOrderValidated = true;
  }

  return Object.freeze({
    status: sampleOrderValidated ? "ok" : "partial",
    mode: "read-only",
    endpoint: String(diagnosis?.endpoint ?? ""),
    orderList: "ok",
    queryOrder,
    recentOrderCount: orders.length,
    sampleOrderValidated,
    writeOperations: "not_called",
  });
}
