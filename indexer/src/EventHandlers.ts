/**
 * Envio HyperIndex V3 handlers. Run `npx envio codegen` after editing
 * config.yaml/schema.graphql, then `npx envio dev`.
 *
 * V3 registration API: `indexer.onEvent({ contract, event }, async ({ event, context }) => {...})`
 * (V2's `import { Contract } from "generated"; Contract.Event.handler(...)` is gone.)
 *
 * Two projections:
 *  - HorizonPool Supply/Withdraw/Borrow/Repay -> ReserveAction + ReserveFlow (flows, active addresses)
 *  - RwaAToken Mint/Burn/BalanceTransfer      -> Holding + TokenHolders (holder counts)
 *    (RwaATokens are non-transferable, so holders are reconstructed from these, not Transfer)
 */
import { indexer } from "envio";

// ── Flows (Horizon Pool) ──────────────────────────────────────────────────
async function bumpFlow(context: any, reserve: string, field: string, amount: bigint, block: number) {
  const id = reserve.toLowerCase();
  const cur = (await context.ReserveFlow.get(id)) ?? {
    id, reserve: id, totalSupplied: 0n, totalWithdrawn: 0n, totalBorrowed: 0n, totalRepaid: 0n, actionCount: 0, lastBlock: 0,
  };
  context.ReserveFlow.set({ ...cur, [field]: (cur as any)[field] + amount, actionCount: cur.actionCount + 1, lastBlock: block });
}
function recordAction(context: any, e: any, kind: string, reserve: string, user: string, amount: bigint) {
  context.ReserveAction.set({
    id: `${e.transaction.hash}-${e.logIndex}`, kind, reserve: reserve.toLowerCase(), user: user.toLowerCase(),
    amount, blockNumber: e.block.number, timestamp: e.block.timestamp, txHash: e.transaction.hash,
  });
}

indexer.onEvent({ contract: "HorizonPool", event: "Supply" }, async ({ event, context }) => {
  recordAction(context, event, "supply", event.params.reserve, event.params.onBehalfOf, event.params.amount);
  await bumpFlow(context, event.params.reserve, "totalSupplied", event.params.amount, event.block.number);
});
indexer.onEvent({ contract: "HorizonPool", event: "Withdraw" }, async ({ event, context }) => {
  recordAction(context, event, "withdraw", event.params.reserve, event.params.user, event.params.amount);
  await bumpFlow(context, event.params.reserve, "totalWithdrawn", event.params.amount, event.block.number);
});
indexer.onEvent({ contract: "HorizonPool", event: "Borrow" }, async ({ event, context }) => {
  recordAction(context, event, "borrow", event.params.reserve, event.params.onBehalfOf, event.params.amount);
  await bumpFlow(context, event.params.reserve, "totalBorrowed", event.params.amount, event.block.number);
});
indexer.onEvent({ contract: "HorizonPool", event: "Repay" }, async ({ event, context }) => {
  recordAction(context, event, "repay", event.params.reserve, event.params.repayer, event.params.amount);
  await bumpFlow(context, event.params.reserve, "totalRepaid", event.params.amount, event.block.number);
});

// ── Holders (RwaAToken Mint/Burn/BalanceTransfer) ─────────────────────────
async function adjust(context: any, token: string, account: string, delta: bigint, block: number) {
  if (/^0x0+$/i.test(account)) return; // skip zero address (mint/burn counterparty)
  const tok = token.toLowerCase(), acct = account.toLowerCase(), id = `${tok}-${acct}`;
  const prev = (await context.Holding.get(id)) ?? { id, token: tok, account: acct, balance: 0n, updatedBlock: 0 };
  const wasHolder = prev.balance > 0n;
  const next = prev.balance + delta;
  context.Holding.set({ ...prev, balance: next < 0n ? 0n : next, updatedBlock: block });
  const isHolder = next > 0n;
  if (wasHolder !== isHolder) {
    const tc = (await context.TokenHolders.get(tok)) ?? { id: tok, token: tok, holderCount: 0, lastBlock: 0 };
    context.TokenHolders.set({ ...tc, holderCount: Math.max(0, tc.holderCount + (isHolder ? 1 : -1)), lastBlock: block });
  }
}

indexer.onEvent({ contract: "RwaAToken", event: "Mint" }, async ({ event, context }) => {
  await adjust(context, event.srcAddress, event.params.onBehalfOf, event.params.value, event.block.number);
});
indexer.onEvent({ contract: "RwaAToken", event: "Burn" }, async ({ event, context }) => {
  await adjust(context, event.srcAddress, event.params.from, -event.params.value, event.block.number);
});
indexer.onEvent({ contract: "RwaAToken", event: "BalanceTransfer" }, async ({ event, context }) => {
  await adjust(context, event.srcAddress, event.params.from, -event.params.value, event.block.number);
  await adjust(context, event.srcAddress, event.params.to, event.params.value, event.block.number);
});
