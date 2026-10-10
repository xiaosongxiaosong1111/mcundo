---
name: mcundo
description: Safely inspect, cancel, and optionally rebuild a mistaken McDonald's China order through the official MCP. Use when a user asks to correct a recent food order; do not use for payment, refunds, or unsupported order reconstruction.
---

# McUndo

Use the official McDonald's China MCP at `https://mcp.mcd.cn`. Read the Token only from `MCD_MCP_TOKEN`; never request that the user paste it into chat or write it to a tracked file.

Use demo mode for product demonstrations or tests without a real account:

```powershell
npm run demo
```

With explicit user authorization and a locally configured Token, validate the live integration without changing account state:

```powershell
npm run doctor
npm run verify:live
```

The live verification command may call only `order-list` and `query-order`. Do not expose or retain its account data.

## Safe workflow

1. Use `order-list` and `query-order` to identify exactly one recent order. Show only the minimum useful summary; mask the order ID except its last four characters and omit addresses, phones, tokens, and payment URLs.
2. Ask whether the user wants cancellation only or a quantity-corrected replacement. Do not infer permission to cancel from a request to inspect or explain an order.
3. For a replacement, proceed only when the application marks the original order `replayable`. Do not guess how to reconstruct delivery, group-order, combo, customized, coupon-bearing, or incomplete orders.
4. Quote the replacement with `calculate-price` before cancellation so the user can assess the consequence.
5. Bind the cancellation authorization to the current order fingerprint, cancellation reason, replacement draft, and quote. Require the exact confirmation phrase shown by the application.
6. After confirmation, query the order again. If its fingerprint changed, discard the confirmation. Otherwise call `cancel-order` no more than once, then use `query-order` to verify the cancelled state.
7. If rebuilding, call `calculate-price` again and require a second, independent confirmation for the replacement order and displayed total. Cancellation confirmation never authorizes creation.
8. Quote once more immediately before creation. If the quote changed, discard the confirmation. Otherwise call `create-order` no more than once and report that the result is only a pending-payment order.

If a write call times out, disconnects, or has an unknown result, stop. Never retry `cancel-order` or `create-order`; direct the user to check the official McDonald's App or recent orders first. Do not pay, auto-open a payment URL, promise cancellation eligibility, or claim that cancellation means a refund has arrived.
