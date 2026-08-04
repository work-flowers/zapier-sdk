// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/esignatures-send-for-signing
// Deployed as `project-addendum-send-for-signing`. Published as `workflow.ts` alongside `shared.ts`.
//
// Notion Project Addendums "Send for signing" button -> eSignatures draft
// contract, addressed to the Consultant. Migration of the classic
// "Send Project Addendum for Signing" Zap.
import { defineSendForSigning } from "./shared.ts";

export default defineSendForSigning("addendum");
