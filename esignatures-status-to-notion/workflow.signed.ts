// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/esignatures-status-to-notion
// Deployed as `esignatures-contract-signed-to-notion`. Published as `workflow.ts` alongside `shared.ts`.
//
// eSignatures `contract_signed` -> mark the SOW / NDA Signed, the Project Addendum
// Executed, and file the executed PDF on the record. Migration of the classic
// "Signed SOWs / Project Addenda" Zap, which never filed the PDF.
import { defineDurable } from "@zapier/zapier-durable";
import { runStatusSync } from "./shared.ts";

// The name must be a string literal here, not built in shared.ts (see there).
export default defineDurable("esignatures-contract-signed-to-notion", async (ctx, rawInput) =>
  runStatusSync(ctx, "signed", rawInput),
);
