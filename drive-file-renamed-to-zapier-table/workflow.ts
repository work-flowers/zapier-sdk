// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/drive-file-renamed-to-zapier-table
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// [Table] Google Drive Files and Folders — inventory owned by
// drive-files-to-zapier-table. This workflow only keeps "Name" honest.
const TABLE_ID = "01K5ZN0AGNDHS4C424XEDCWJZY";
const KEY_FIELD = "ID";
const NAME_FIELD = "Name";
const PARENT_FIELD = "Parent ID";

const InputSchema = z.unknown();

type Outcome =
  | { skipped: string; driveId?: string; name?: string }
  | { renamed: true; driveId: string; recordId: string; from: string; to: string; movedTo?: string };

// --- Helpers -----------------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const t = v.trim();
    if (t[0] !== "{" && t[0] !== "[") break;
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
  }
  return v;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function pick(o: Record<string, any>, keys: string[]): string {
  for (const k of keys) {
    const direct = str(o[k]);
    if (direct) return direct;
  }
  const nested = (o.data ?? o.file ?? null) as Record<string, any> | null;
  if (nested && typeof nested === "object") {
    for (const k of keys) {
      const v = str(nested[k]);
      if (v) return v;
    }
  }
  return "";
}

// --- Workflow ----------------------------------------------------------------
const workflow = defineDurable({
  name: "drive-file-renamed-to-zapier-table",
  description:
    "When a Google Drive file or folder is updated, keep its Name (and parent) current in [Table] Google Drive Files and Folders. A Drive object the inventory has never seen, and a no-op update, both skip quietly instead of erroring.",
  inputSchema: InputSchema,
  run: async (ctx, rawInput) => {
    const raw = normalizeInput(rawInput);
    if (!raw || typeof raw !== "object") {
      throw new Error(`Unusable trigger payload: ${JSON.stringify(raw).slice(0, 300)}`);
    }
    const o = raw as Record<string, any>;
    const driveId = pick(o, ["id", "fileId", "file_id"]);
    if (!driveId) {
      throw new Error(
        `Could not find a Drive object id in the trigger payload: ${JSON.stringify(raw).slice(0, 300)}`,
      );
    }
    const name = pick(o, ["title", "name", "originalFilename"]);
    const parentId = pick(o, ["parent_id", "parentId", "parents"]);

    if (!name) {
      // Drive told us something changed but gave us no name to mirror. Nothing
      // to write, and blanking the stored name would be worse than doing nothing.
      return { skipped: "no-name-in-payload", driveId } satisfies Outcome;
    }

    const outcome = await ctx.step("sync-name-to-table", async (): Promise<Outcome> => {
      const res = await sdk.listTableRecords({
        table: TABLE_ID,
        keyMode: "names",
        filters: [{ fieldKey: KEY_FIELD, operator: "exact", value: driveId }],
        pageSize: 100,
      });
      const records = (res.data ?? []).slice().sort((a: any, b: any) => (a.id < b.id ? -1 : 1));

      // The classic Zap's find had "success on miss" off, so every update to a
      // file the inventory had never logged surfaced as a Zap error. Skipping is
      // the honest outcome: drive-files-to-zapier-table owns row creation.
      if (!records.length) {
        return { skipped: "not-in-inventory", driveId, name } satisfies Outcome;
      }

      const record = records[0];
      const storedName = str(record.data?.[NAME_FIELD]);
      const storedParent = str(record.data?.[PARENT_FIELD]);
      const parentMoved = parentId !== "" && parentId !== storedParent;

      // The classic Zap folded "name differs" into the search filter, so an
      // update that changed something else counted as a miss (and errored).
      if (storedName === name && !parentMoved) {
        return { skipped: "already-current", driveId, name } satisfies Outcome;
      }

      const data: Record<string, string> = { [NAME_FIELD]: name };
      if (parentMoved) data[PARENT_FIELD] = parentId;
      await sdk.updateTableRecords({
        table: TABLE_ID,
        keyMode: "names",
        records: [{ id: record.id, data }],
      });

      const result: Outcome = {
        renamed: true,
        driveId,
        recordId: record.id,
        from: storedName,
        to: name,
      };
      if (parentMoved) result.movedTo = parentId;
      return result;
    });

    console.log(`drive object ${driveId}: ${Object.keys(outcome)[0]}`);
    return outcome;
  },
});

export default workflow;
