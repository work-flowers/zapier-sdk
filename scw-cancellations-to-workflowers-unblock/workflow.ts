// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/scw-cancellations-to-workflowers-unblock
//
// Deletion propagation for the two-way calendar-blocking pair. The
// `event_updated` trigger scw-events-to-workflowers-block runs on delivers
// cancellations ONLY with `expand_recurring: false`; with `true` (which
// blocking needs) they are silently dropped — proven 2026-08-31, when the
// sibling meeting-note Zap (expand_recurring: false, same account) had 13
// cancelled tombstones in its last 100 runs while the blocking Zap had 0 in
// 100, and a deleted work.flowers event left its SCW block standing. So the
// `event_cancelled` trigger gets its own slim workflow per direction: look the
// cancelled SCW event up in the GCal Sync Map, delete its work.flowers mirror,
// mark the row. Nothing else — creates and updates stay with the main Zap.
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// The SCW Google credential lives on the TRIGGER (the calendar whose
// cancellations are being read); the work.flowers credential is bound here
// because this workflow deletes mirrors there.
const GCAL_APP_KEY = "GoogleCalendarCLIAPI";
const DEST_CONNECTION = "gcal_wf";
const DEST_CALENDAR = "dennis@work.flowers";
const DIRECTION = "scw_to_wf";

/** See scw-events-to-workflowers-block/workflow.ts for the column map. */
const SYNC_MAP_TABLE = "01M13QPJ5GRJV33096MBNSN1Q5";

// --- Input -------------------------------------------------------------------
// The `event_cancelled` payload is the raw Google event resource with
// `status: "cancelled"` — full fields for a plain deletion, sparse for a
// recurring-instance tombstone. Only `id` matters here.

const InputSchema = z
  .object({
    id: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    updated: z.string().optional().nullable(),
  })
  .passthrough();

type Input = z.infer<typeof InputSchema>;

/** `run-durable` hands manual input through as a JSON string. */
function normalizeInput(rawInput: unknown): unknown {
  if (typeof rawInput === "string") return JSON.parse(rawInput);
  return rawInput;
}

// --- Helpers -------------------------------------------------------------------

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

interface MappingRow {
  recordId: string;
  mirrorEventId: string | null;
  status: string | null;
}

function extractRow(result: unknown): MappingRow | null {
  const rows = Array.isArray(result) ? result : [];
  const hit = rows[0] as
    | { record_id?: unknown; old?: { data?: Record<string, unknown> } }
    | undefined;
  if (!hit) return null;
  const recordId = firstString(hit.record_id);
  if (!recordId) return null;
  const data = hit.old?.data ?? {};
  return {
    recordId,
    mirrorEventId: firstString(data.f2),
    status: firstString(data.f4),
  };
}

/** Google's error text when the mirror was already deleted by hand. */
const MIRROR_GONE_PATTERN = /not\s*found|has been deleted|410|404/i;

// --- Workflow --------------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  "scw-cancellations-to-workflowers-unblock",
  async (ctx: DurableContext, rawInput: Input) => {
    const event = InputSchema.parse(normalizeInput(rawInput));

    const eventId = firstString(event.id);
    if (!eventId) {
      console.log("payload has no event id — nothing to unblock");
      return { skipped: "no-event-id" };
    }
    const updatedAt = firstString(event.updated);

    // Loop guard: deleting a mirror fires `event_cancelled` on ITS calendar,
    // which is this trigger's calendar for the reverse direction's mirrors.
    // Anything whose id is recorded as a Mirror Event ID is the sync's own
    // deletion echoing back. Free.
    const mirrorGuard = await ctx.step("guard-created-by-sync", async () =>
      sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "search",
        actionKey: "find_record",
        inputs: {
          table_id: SYNC_MAP_TABLE,
          filter_count: "1",
          use_stored_order: false,
          field_data_key: "data__f2",
          operator: "exact",
          lookup_value: eventId,
          _zap_search_multiple_results: "first",
          _zap_search_success_on_miss: true,
        },
      }),
    );
    if (extractRow((mirrorGuard as { data?: unknown }).data)) {
      return { skipped: "created-by-sync", eventId };
    }

    const lookup = await ctx.step("find-mapping-row", async () =>
      sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "search",
        actionKey: "find_record",
        inputs: {
          table_id: SYNC_MAP_TABLE,
          filter_count: "2",
          use_stored_order: false,
          field_data_key: "data__f1",
          operator: "exact",
          lookup_value: eventId,
          field_data_key_2: "data__f3",
          operator_2: "exact",
          lookup_value_2: DIRECTION,
          _zap_search_multiple_results: "first",
          _zap_search_success_on_miss: true,
        },
      }),
    );
    const row = extractRow((lookup as { data?: unknown }).data);
    if (!row) {
      // Overwhelmingly the normal outcome: a cancelled event that was never
      // mirrored (all-day, Free, declined, beyond-horizon, or predates cutover).
      return { skipped: "never-mirrored", eventId };
    }
    if (row.status !== "active" || !row.mirrorEventId) {
      return { skipped: "already-unmirrored", eventId };
    }

    const mirrorEventId = row.mirrorEventId;
    await ctx.step("delete-mirror", async () => {
      try {
        return await sdk.runAction({
          appKey: GCAL_APP_KEY,
          actionType: "write",
          actionKey: "delete_event",
          connection: DEST_CONNECTION,
          inputs: {
            calendarid: DEST_CALENDAR,
            eventid: mirrorEventId,
            send_notifications: false,
          },
        });
      } catch (error) {
        // Already gone is the outcome we wanted; anything else retries.
        const message = error instanceof Error ? error.message : String(error);
        if (MIRROR_GONE_PATTERN.test(message)) return { alreadyGone: true };
        throw error;
      }
    });

    await ctx.step("mark-row-deleted", async () =>
      sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "write",
        actionKey: "update_record",
        inputs: {
          table_id: SYNC_MAP_TABLE,
          record_id: row.recordId,
          new__data__f4: "deleted",
          ...(updatedAt ? { new__data__f8: updatedAt } : {}),
        },
      }),
    );

    return { unmirrored: true, eventId, mirrorEventId };
  },
);

export default workflow;
