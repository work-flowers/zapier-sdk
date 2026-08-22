// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/drive-files-to-zapier-table
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// [Table] Google Drive Files and Folders — the flat inventory of everything on
// the Work.Flowers HQ shared drive. One row per Drive object, keyed on "ID".
const TABLE_ID = "01K5ZN0AGNDHS4C424XEDCWJZY";
const KEY_FIELD = "ID";

const InputSchema = z.unknown();

type Outcome =
  | { skipped: string; driveId?: string }
  | { created: true; driveId: string; kind: string; name: string; parentId: string }
  | { unchanged: true; driveId: string; recordId: string }
  | { repaired: true; driveId: string; recordId: string; changed: string[] };

// --- Helpers -----------------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline may deliver the payload double-encoded.
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

/** Pull the first non-empty value for any of `keys`, tolerating the flattened
 *  (`data__id`) and nested (`data.id`) shapes a trigger payload can arrive in. */
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

type DriveObject = { id: string; kind: string; name: string; parentId: string };

function extractDriveObject(raw: unknown): DriveObject {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Unusable trigger payload: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  const o = raw as Record<string, any>;
  const id = pick(o, ["id", "fileId", "file_id"]);
  if (!id) {
    throw new Error(
      `Could not find a Drive object id in the trigger payload: ${JSON.stringify(raw).slice(0, 300)}`,
    );
  }
  return {
    id,
    // "kind" is Drive's own discriminator (drive#file / drive#folder). Fall back
    // to the mime type, which is what distinguishes a folder when kind is absent.
    kind: pick(o, ["kind", "mimeType", "mime_type"]),
    name: pick(o, ["title", "name", "originalFilename"]),
    parentId: pick(o, ["parent_id", "parentId", "parents"]),
  };
}

async function findRecords(driveId: string) {
  const res = await sdk.listTableRecords({
    table: TABLE_ID,
    keyMode: "names",
    filters: [{ fieldKey: KEY_FIELD, operator: "exact", value: driveId }],
    pageSize: 100,
  });
  // Earliest ULID is the deterministic winner if two runs raced a create.
  return (res.data ?? []).slice().sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
}

// --- Workflow ----------------------------------------------------------------
const workflow = defineDurable({
  name: "drive-files-to-zapier-table",
  description:
    "Log every new file and folder on the Work.Flowers HQ shared drive into [Table] Google Drive Files and Folders, keyed on the Drive object id. Idempotent: an id already on file is left alone (or repaired if its name/parent drifted) rather than duplicated.",
  inputSchema: InputSchema,
  run: async (ctx, rawInput) => {
    const obj = extractDriveObject(normalizeInput(rawInput));

    const outcome = await ctx.step("upsert-table-record", async (): Promise<Outcome> => {
      const existing = await findRecords(obj.id);
      const data: Record<string, string> = {
        [KEY_FIELD]: obj.id,
        Kind: obj.kind,
        Name: obj.name,
        "Parent ID": obj.parentId,
      };

      if (!existing.length) {
        await sdk.createTableRecords({
          table: TABLE_ID,
          keyMode: "names",
          records: [{ data }],
        });
        // Re-query so racing creates converge: every racer keeps the earliest
        // ULID and deletes the rest (deletes are idempotent).
        const after = await findRecords(obj.id);
        if (after.length > 1) {
          await sdk.deleteTableRecords({
            table: TABLE_ID,
            records: after.slice(1).map((r: any) => r.id),
          });
        }
        return { created: true, driveId: obj.id, kind: obj.kind, name: obj.name, parentId: obj.parentId };
      }

      // Already inventoried. The classic Zap created a second row here; this
      // one keeps a single row and repairs it only if something actually moved.
      if (existing.length > 1) {
        await sdk.deleteTableRecords({
          table: TABLE_ID,
          records: existing.slice(1).map((r: any) => r.id),
        });
      }
      const record = existing[0];
      const changed = Object.entries(data)
        .filter(([k, v]) => v !== "" && str(record.data?.[k]) !== v)
        .map(([k]) => k);
      if (!changed.length) {
        return { unchanged: true, driveId: obj.id, recordId: record.id };
      }
      await sdk.updateTableRecords({
        table: TABLE_ID,
        keyMode: "names",
        records: [{ id: record.id, data }],
      });
      return { repaired: true, driveId: obj.id, recordId: record.id, changed };
    });

    console.log(`drive object ${obj.id} ("${obj.name}"): ${Object.keys(outcome)[0]}`);
    return outcome;
  },
});

export default workflow;
