// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/esignatures-status-to-notion
// Deployed as `esignatures-contract-sent-to-notion`. Published as `workflow.ts` alongside `shared.ts`.
//
// eSignatures `contract_sent_to_signer` -> mark the SOW or Project Addendum as
// out for signature. Migration of the classic "Update SOW / Project Addendum
// Status When Sent for Signature" Zap.
import { defineStatusSync } from "./shared.ts";

export default defineStatusSync("sent");
