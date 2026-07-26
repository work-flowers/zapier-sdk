// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/internal-user-ids-to-table-and-notion
// Deployed as `internal-user-ids-zapier`. Published as `workflow.ts` alongside `sync.ts`.
import { defineUserIdSync } from "./sync.ts";

export default defineUserIdSync("zapier");
