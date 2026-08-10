// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/buttondown-unsubscribe-to-notion-contact
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// Shared email -> Notion Contacts page-id map, written by contact-emails-to-zapier-table.
// f2 = Notion Contacts page id, f3 = email (stored lowercase).
const EMAIL_TABLE_ID = "01JYEPSEARXB2Z6BJRCMFGXBC2";

// Notion "Contacts" data source. Only `Mailing List` is ever written.
const CONTACTS_DATA_SOURCE = "21991b07-11ac-81a6-a894-000be4a09a67";
const NOTION_CONNECTION = "notion_wf";

const InputSchema = z.object({
  email_address: z.string().min(1),
});

type Input = z.infer<typeof InputSchema>;

// `find_record` wraps each hit as {new, old, record_id, table_id}; on a plain
// search `new` is null and the stored values live under `old.data`. A miss is
// `{data: []}`, so `data[0].old` would throw if read unguarded.
type TableHit = {
  old?: { data?: Record<string, unknown> } | null;
};

export default defineDurable<Input>(
  "buttondown-unsubscribe-to-notion-contact",
  async (ctx, input) => {
    // A payload with no address is a real event whose shape we failed to
    // understand — throw, naming the keys we actually got.
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(
        `Unexpected trigger payload — expected email_address, got keys [${Object.keys(
          (input ?? {}) as Record<string, unknown>,
        ).join(", ")}]`,
      );
    }

    // The Table is indexed lowercase by contact-emails-to-zapier-table; the
    // lookup must match that casing or every row misses.
    const lookupEmail = parsed.data.email_address.trim().toLowerCase();

    const mapping = await ctx.step("find-contact-page-id", async () => {
      const res = await sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "search",
        actionKey: "find_record",
        inputs: {
          table_id: EMAIL_TABLE_ID,
          filter_count: "1",
          use_stored_order: false,
          field_data_key: "data__f3",
          operator: "exact",
          lookup_value: lookupEmail,
          _zap_search_success_on_miss: true,
        },
      });
      const pageId = (res.data?.[0] as TableHit | undefined)?.old?.data?.f2;
      // Only the page id is returned, to keep the step checkpoint small.
      return { pageId: typeof pageId === "string" && pageId ? pageId : null };
    });

    // Buttondown holds addresses that were never CRM contacts (site sign-ups,
    // imported lists), so an unsubscribe with no Notion page is routine. Log it
    // and skip — raising here would alert on a non-event.
    if (!mapping.pageId) {
      console.log(
        `No Notion contact mapped to ${lookupEmail} — nothing to untick, skipping.`,
      );
      return { skipped: "no-notion-contact-for-email", email: lookupEmail };
    }

    await ctx.step("untick-mailing-list", async () =>
      sdk.runAction({
        appKey: "NotionCLIAPI",
        actionType: "write",
        actionKey: "update_database_item",
        connection: NOTION_CONNECTION,
        inputs: {
          datasource: CONTACTS_DATA_SOURCE,
          page: mapping.pageId,
          "properties|||Mailing List|||checkbox": false,
        },
      }),
    );

    // The update action echoes the entire Notion page; return only what a
    // reader of the run history needs, so the checkpoint stays small.
    return { email: lookupEmail, contactPageId: mapping.pageId, unticked: true };
  },
);
