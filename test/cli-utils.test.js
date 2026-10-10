import test from "node:test";
import assert from "node:assert/strict";

import { collectQuantityUpdates, isExactConfirmation } from "../src/cli-utils.js";

test("confirmation accepts only the exact action-bound phrase", () => {
  assert.equal(isExactConfirmation("取消 5678", "取消 5678"), true);
  assert.equal(isExactConfirmation("确认", "取消 5678"), false);
  assert.equal(isExactConfirmation("取消5678", "取消 5678"), false);
  assert.equal(isExactConfirmation("取消 5679", "取消 5678"), false);
});

test("collects only changed quantities while asking every item", async () => {
  const items = [
    { productCode: "A", name: "汉堡", quantity: 2 },
    { productCode: "B", name: "薯条", quantity: 1 },
    { productCode: "C", name: "可乐", quantity: 3 },
  ];
  const answers = ["", "0", "20"];
  let prompts = [];
  const updates = await collectQuantityUpdates(items, async (prompt) => {
    prompts = [...prompts, prompt];
    return answers[prompts.length - 1];
  });

  assert.deepEqual(updates, { B: 0, C: 20 });
  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /汉堡.*当前 2.*回车保持.*0 删除.*1-20/);
});

test("rejects malformed, unsafe, and no-op quantity edits", async () => {
  const items = [{ productCode: "A", name: "汉堡", quantity: 2 }];
  for (const value of ["-1", "1.5", "1e1", "21", "一份"] ) {
    await assert.rejects(
      collectQuantityUpdates(items, async () => value),
      /0 到 20/,
    );
  }
  await assert.rejects(
    collectQuantityUpdates(items, async () => ""),
    /至少修改一项/,
  );
});
