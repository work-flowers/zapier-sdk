// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/esignatures-status-to-notion
// Deployed as `esignatures-contract-sent-to-notion`. Published as `workflow.ts` alongside `shared.ts`.
//
// eSignatures `contract_sent_to_signer` -> mark the Agreement Pipeline row (or a
// legacy SOW, Project Addendum or NDA) as out for signature, and move a client
// agreement's Deal to In signing. Migration of the classic "Update SOW / Project Addendum
// Status When Sent for Signature" Zap.
import { defineDurable } from "@zapier/zapier-durable";
import { runStatusSync } from "./shared.ts";

// The name must be a string literal here, not built in shared.ts (see there).
export default defineDurable("esignatures-contract-sent-to-notion", async (ctx, rawInput) =>
  runStatusSync(ctx, "sent", rawInput),
);
