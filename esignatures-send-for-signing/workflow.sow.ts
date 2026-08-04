// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/esignatures-send-for-signing
// Deployed as `sow-send-for-signing`. Published as `workflow.ts` alongside `shared.ts`.
//
// Notion SOWs "Send for signing" button -> eSignatures draft contract, with the
// SOW's own page body as the contract text. Migration of the classic
// "Send SOW for Signing" Zap.
import { defineSendForSigning } from "./shared.ts";

export default defineSendForSigning("sow");
