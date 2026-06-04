/**
 * Envio handlers. Run `npx envio codegen` after editing config.yaml/schema.graphql
 * to generate the typed `HorizonPool` / `RwaAToken` bindings, then `npx envio dev`.
 *
 * Two projections:
 *  - HorizonPool Supply/Withdraw/Borrow/Repay -> ReserveAction + ReserveFlow (flows, active addresses)
 *  - RwaAToken Mint/Burn/BalanceTransfer      -> Holding + TokenHolders (holder counts)
 *    (RwaATokens are non-transferable, so holders are reconstructed from these, not Transfer)
 */
import { HorizonPool, RwaAToken } from "generated";

// ── Flows (Horizon Pool) ──────────────────────────────────────────────────
async function bumpFlow(context: any, reserve: string, field: string, amount: bigint, block: number) {
  const id = reserve.toLowerCase();
  const cur = (await context.ReserveFlow.get(id)) ?? {
    id, reserve: id, totalSupplied: 0n, totalWithdrawn: 0n, totalBorrowed: 0n, totalRepaid: 0n, actionCount: 0, lastBlock: 0,
  };
  context.ReserveFlow.set({ ...cur, [field]: (cur as any)[field] + amount, actionCount: cur.actionCount + 1, lastBlock: block });
}
function action(context: any, e: any, kind: string, reserve: string, user: string, amount: bigint) {
  context.ReserveAction.set({
    id: `${e.transaction.hash}-${e.logIndex}`, kind, reserve: reserve.toLowerCase(), user: user.toLowerCase(),
    amount, blockNumber: e.block.number, timestamp: e.block.timestamp, txHash: e.transaction.hash,
  });
}
HorizonPool.Supply.handler(async ({ event, context }) => {
  action(context, event, "supply", event.params.reserve, event.params.onBehalfOf, event.params.amount);
  await bumpFlow(context, event.params.reserve, "totalSupplied", event.params.amount, event.block.number);
});
HorizonPool.Withdraw.handler(async ({ event, context }) => {
  action(context, event, "withdraw", event.params.reserve, event.params.user, event.params.amount);
  await bumpFlow(context, event.params.reserve, "totalWithdrawn", event.params.amount, event.block.number);
});
HorizonPool.Borrow.handler(async ({ event, context }) => {
  action(context, event, "borrow", event.params.reserve, event.params.onBehalfOf, event.params.amount);
  await bumpFlow(context, event.params.reserve, "totalBorrowed", event.params.amount, event.block.number);
});
HorizonPool.Repay.handler(async ({ event, context }) => {
  action(context, event, "repay", event.params.reserve, event.params.repayer, event.params.amount);
  await bumpFlow(context, event.params.reserve, "totalRepaid", event.params.amount, event.block.number);
});

// ── Holders (RwaAToken Mint/Burn/BalanceTransfer) ─────────────────────────
async function adjust(context: any, token: string, account: string, delta: bigint, block: number) {
  if (account === "0x0000000000000000000000000000000000000000") return;
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
RwaAToken.Mint.handler(async ({ event, context }) => {
  await adjust(context, event.srcAddress, event.params.onBehalfOf, event.params.value, event.block.number);
});
RwaAToken.Burn.handler(async ({ event, context }) => {
  await adjust(context, event.srcAddress, event.params.from, -event.params.value, event.block.number);
});
RwaAToken.BalanceTransfer.handler(async ({ event, context }) => {
  await adjust(context, event.srcAddress, event.params.from, -event.params.value, event.block.number);
  await adjust(context, event.srcAddress, event.params.to, event.params.value, event.block.number);
});
