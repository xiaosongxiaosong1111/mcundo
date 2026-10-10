import test from "node:test";
import assert from "node:assert/strict";

import { DemoGateway } from "../src/demo-gateway.js";
import { runRescue } from "../src/rescue.js";

test("demo gateway proves the full cancel-verify-requote-create state change", async () => {
  const gateway = new DemoGateway();
  const [original] = await gateway.listRecentOrders();
  const result = await runRescue({
    gateway,
    confirmer: {
      async confirm(request) {
        return { accepted: true, fingerprint: request.fingerprint };
      },
    },
    orderId: original.id,
    reasonCode: "3",
    buildDraft: (order) => gateway.resolvePickupDraft(order, { "P-BURGER": 1 }),
  });

  assert.equal(result.status, "created");
  assert.equal((await gateway.getOrder(original.id)).status, "cancelled");
  assert.equal(result.created.orderId, "DEMO-NEW-87654321");
  assert.equal(result.quote.totalFen, 2200);
});
