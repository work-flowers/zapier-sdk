// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/esignatures-status-to-notion
// Deployed as `esignatures-contract-signed-to-notion`. Published as `workflow.ts` alongside `shared.ts`.
//
// eSignatures `contract_signed` -> mark the SOW Signed / the Project Addendum
// Executed, and file the executed PDF on the record. Migration of the classic
// "Signed SOWs / Project Addenda" Zap, which never filed the PDF.
import { defineStatusSync } from "./shared.ts";

export default defineStatusSync("signed");
