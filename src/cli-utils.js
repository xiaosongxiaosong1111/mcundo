export function isExactConfirmation(input, expectedPhrase) {
  return String(input ?? "").trim() === String(expectedPhrase ?? "");
}

function parseQuantityAnswer(input, currentQuantity) {
  const text = String(input ?? "").trim();
  const quantity = text === "" ? Number(currentQuantity) : Number(text);
  if (
    !/^\d+$/.test(text || String(currentQuantity)) ||
    !Number.isInteger(quantity) ||
    quantity < 0 ||
    quantity > 20
  ) {
    throw new Error("数量必须是 0 到 20 的整数");
  }
  return quantity;
}

export async function collectQuantityUpdates(items, ask) {
  let entries = [];
  for (const item of items) {
    const answer = await ask(
      `${item.name}（当前 ${item.quantity}；回车保持，0 删除，1-20）：`,
    );
    const quantity = parseQuantityAnswer(answer, item.quantity);
    if (quantity !== item.quantity) {
      entries = [...entries, [item.productCode, quantity]];
    }
  }
  if (entries.length === 0) throw new Error("至少修改一项餐品数量");
  return Object.freeze(Object.fromEntries(entries));
}
