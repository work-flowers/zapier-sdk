// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/update-notion-when-rescheduled-in-buttondown
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// Zapier Table written by the outbound `notion-newsletter-to-buttondown` Zap.
// f1 = Notion Newsletter Issues page id, f2 = Buttondown email id, f3 = created at.
const MAPPING_TABLE_ID = "01KNJN2MSBAJVXRME6M1Y65F5B";

// Notion "Newsletter Issues" data source. Only `Send Date` is ever written.
const NEWSLETTER_ISSUES_DATA_SOURCE = "0c691b07-11ac-82fa-bc1b-07d0186a095d";

const InputSchema = z.object({
  email_id: z.string(),
  publish_date: z.string(),
});

type Input = z.infer<typeof InputSchema>;

// `find_record` wraps each hit as {new, old, record_id, table_id}; on a plain
// search `new` is null and the stored values live under `old.data`.
type TableHit = {
  old?: { data?: Record<string, unknown> } | null;
};

export default defineDurable<Input>(
  "update-notion-when-rescheduled-in-buttondown",
  async (ctx, input) => {
    // The trigger has never delivered a real payload, so fail with the keys we
    // actually got rather than writing `undefined` into Notion.
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(
        `Unexpected trigger payload — expected email_id + publish_date, got keys [${Object.keys(
          (input ?? {}) as Record<string, unknown>,
        ).join(", ")}]`,
      );
    }
    const { email_id, publish_date } = parsed.data;

    // Resolve the Buttondown email back to the Notion page it was sent from.
    // Only the page id is returned, to keep the step checkpoint small.
    const mapping = await ctx.step("find-mapping-row", async () => {
      const res = await sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "search",
        actionKey: "find_record",
        inputs: {
          table_id: MAPPING_TABLE_ID,
          filter_count: "2",
          use_stored_order: false,
          field_data_key: "data__f2",
          operator: "exact",
          lookup_value: email_id,
          // Legacy rows exist with a null Page ID; they must never match.
          field_data_key_2: "data__f1",
          operator_2: "isnull",
          lookup_value_2: false,
        },
      });
      const pageId = (res.data?.[0] as TableHit | undefined)?.old?.data?.f1;
      return { pageId: typeof pageId === "string" && pageId ? pageId : null };
    });

    // The trigger polls EVERY scheduled Buttondown email, not just ones sent
    // from Notion, so a miss is a routine non-event and must not raise. Log it
    // so the run history still shows the email was seen.
    if (!mapping.pageId) {
      console.log(
        `No Notion Newsletter Issues page mapped to Buttondown email ${email_id} — skipping.`,
      );
      return { skipped: "no-notion-page-for-email", email_id };
    }

    const updated = await ctx.step("update-notion-send-date", async () => {
      return sdk.runAction({
        appKey: "NotionCLIAPI",
        actionType: "write",
        actionKey: "update_database_item",
        connection: "notioncliapi_connection",
        inputs: {
          datasource: NEWSLETTER_ISSUES_DATA_SOURCE,
          page: mapping.pageId,
          use_zapier_datetime_fields: true,
          "properties|||Send Date|||date__start": publish_date,
        },
      });
    });

    return updated.data;
  },
);
