/**
 * Envio handlers — record each Horizon Pool action and maintain per-reserve flow
 * totals. Run `npx envio codegen` after editing config.yaml/schema.graphql to
 * generate the typed `HorizonPool` handler bindings, then `npx envio dev`.
 */
import { HorizonPool } from "generated";

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
