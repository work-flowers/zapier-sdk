// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/esignatures-send-for-signing
// Deployed as `sow-send-for-signing`. Published as `workflow.ts` alongside `shared.ts`.
//
// Notion SOWs "Send for signing" button -> eSignatures draft contract, with the
// SOW's own page body as the contract text. Migration of the classic
// "Send SOW for Signing" Zap.
import { defineDurable } from "@zapier/zapier-durable";
import { runSendForSigning } from "./shared.ts";

// The name must be a string literal here, not built in shared.ts (see there).
export default defineDurable("sow-send-for-signing", async (ctx, rawInput) =>
  runSendForSigning(ctx, "sow", rawInput),
);
