// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/buttondown-email-sent-to-notion-newsletter
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// Zapier Table written by the outbound `notion-newsletter-to-buttondown` Zap.
// f1 = Notion Newsletter Issues page id, f2 = Buttondown email id, f3 = created at.
const MAPPING_TABLE_ID = "01KNJN2MSBAJVXRME6M1Y65F5B";

// Notion "Newsletter Issues" data source.
const NEWSLETTER_ISSUES_DATA_SOURCE = "0c691b07-11ac-82fa-bc1b-07d0186a095d";
const NOTION_CONNECTION = "notion_wf";

const InputSchema = z.object({
  id: z.string().min(1),
  // Buttondown sets publish_date when the email actually goes out. Optional so a
  // payload without it still marks the issue Sent rather than failing the run.
  publish_date: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;

// `find_record` wraps each hit as {new, old, record_id, table_id}; a miss is
// `{data: []}`, so `data[0].old` would throw if read unguarded.
type TableHit = {
  old?: { data?: Record<string, unknown> } | null;
};

export default defineDurable<Input>(
  "buttondown-email-sent-to-notion-newsletter",
  async (ctx, input) => {
    // No email id means a real event whose shape we failed to understand.
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(
        `Unexpected trigger payload — expected a Buttondown email id, got keys [${Object.keys(
          (input ?? {}) as Record<string, unknown>,
        ).join(", ")}]`,
      );
    }
    const { id: emailId, publish_date: publishDate } = parsed.data;

    // Resolve the Buttondown email back to the Notion page it was sent from.
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
          lookup_value: emailId,
          // Legacy rows exist with a null Page ID; they must never match.
          field_data_key_2: "data__f1",
          operator_2: "isnull",
          lookup_value_2: false,
          _zap_search_success_on_miss: true,
        },
      });
      const pageId = (res.data?.[0] as TableHit | undefined)?.old?.data?.f1;
      return { pageId: typeof pageId === "string" && pageId ? pageId : null };
    });

    // The trigger fires for EVERY email Buttondown sends, not only ones drafted
    // from Notion, so a miss is a routine non-event. Log it and skip — this is
    // the same trap that made the reschedule Zap alert on other people's sends.
    if (!mapping.pageId) {
      console.log(
        `No Notion Newsletter Issues page mapped to Buttondown email ${emailId} — skipping.`,
      );
      return { skipped: "no-notion-page-for-email", emailId };
    }

    // `use_zapier_datetime_fields` is required alongside a date property write.
    const dateInputs = publishDate
      ? {
          use_zapier_datetime_fields: true,
          "properties|||Send Date|||date__start": publishDate,
        }
      : {};

    await ctx.step("mark-issue-sent", async () =>
      sdk.runAction({
        appKey: "NotionCLIAPI",
        actionType: "write",
        actionKey: "update_database_item",
        connection: NOTION_CONNECTION,
        inputs: {
          datasource: NEWSLETTER_ISSUES_DATA_SOURCE,
          page: mapping.pageId,
          "properties|||Status|||status": "Sent",
          ...dateInputs,
        },
      }),
    );

    // The update action echoes the entire Notion page; return only what a
    // reader of the run history needs, so the checkpoint stays small.
    return {
      emailId,
      pageId: mapping.pageId,
      publishDate: publishDate ?? null,
      markedSent: true,
    };
  },
);
