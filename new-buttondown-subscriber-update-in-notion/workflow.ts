// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/new-buttondown-subscriber-update-in-notion
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

const EMAIL_TABLE_ID = "01JYEPSEARXB2Z6BJRCMFGXBC2";
const CONTACTS_DATASOURCE = "21991b07-11ac-81a6-a894-000be4a09a67";
const NOTION_CONNECTION = "notioncliapi_connection";

const InputSchema = z.object({
  email_address: z.string(),
});

type Input = z.infer<typeof InputSchema>;

export default defineDurable<Input>(
  "new-buttondown-subscriber-update-in-notion",
  async (ctx, input) => {
    // Table rows are indexed lowercase by the sibling contact-emails-to-zapier-table
    // workflow; the lookup must match that casing or every row misses.
    const lookupEmail = input.email_address.trim().toLowerCase();

    const seeIfContactExists = await ctx.step(
      "Look Up Contact in Email->Page-ID Table",
      async () => {
        return sdk.runAction({
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
      },
    );

    const existingRow = (seeIfContactExists.data[0] as Record<string, unknown> | undefined)
      ?.old as Record<string, unknown> | undefined;
    const existingRowData = existingRow?.data as Record<string, unknown> | undefined;
    const contactPageId = existingRowData?.f2 as string | undefined;
    const contactAlreadyExists = Boolean(contactPageId);

    if (contactAlreadyExists) {
      const notionUpdateDatabaseItem = await ctx.step(
        "Update Database Item in Notion",
        async () => {
          return sdk.runAction({
            appKey: "NotionCLIAPI",
            actionType: "write",
            actionKey: "update_database_item",
            connection: NOTION_CONNECTION,
            inputs: {
              datasource: CONTACTS_DATASOURCE,
              page: contactPageId,
              "properties|||Mailing List|||checkbox": true,
            },
          });
        },
      );
    }

    if (!contactAlreadyExists) {
      const createContact = await ctx.step("Create Contact", async () => {
        const inputs = {
          datasource: CONTACTS_DATASOURCE,
          "properties|||Primary Email|||email": input.email_address,
          use_zapier_datetime_fields: false,
          "properties|||Mailing List|||checkbox": true,
          "properties|||Note|||rich_text": "Newsletter sign-up",
          "properties|||Lead Source|||select": "Newsletter Sign-up",
        };
        // Apply the Contacts default template (repo rule: bot-created contacts
        // must look hand-made). template_mode throws when a data source has no
        // default template -- caught here, inside the step, so a template miss
        // doesn't spin the durable's retry loop.
        try {
          return await sdk.runAction({
            appKey: "NotionCLIAPI",
            actionType: "write",
            actionKey: "create_database_item",
            connection: NOTION_CONNECTION,
            inputs: { ...inputs, template_mode: "default" },
          });
        } catch (err) {
          const msg = String((err as Error)?.message ?? err);
          if (!/no default template/i.test(msg)) throw err;
          return await sdk.runAction({
            appKey: "NotionCLIAPI",
            actionType: "write",
            actionKey: "create_database_item",
            connection: NOTION_CONNECTION,
            inputs,
          });
        }
      });
    }
  },
);
