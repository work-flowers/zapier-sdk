import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

const InputSchema = z.object({
  email_id: z.string(),
  publish_date: z.string(),
});

type Input = z.infer<typeof InputSchema>;

export default defineDurable<Input>(
  "update-notion-when-rescheduled-in-buttondown",
  async (ctx, input) => {
    const tableFindRecord = await ctx.step("Find Record in Table", async () => {
      return sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "search",
        actionKey: "find_record",
        inputs: {
          table_id: "01KNJN2MSBAJVXRME6M1Y65F5B",
          filter_count: "2",
          use_stored_order: false,
          field_data_key: "data__f2",
          operator: "exact",
          lookup_value: input.email_id,
          field_data_key_2: "data__f1",
          operator_2: "isnull",
          lookup_value_2: false,
        },
      });
    });

    const notionUpdateDatabaseItem = await ctx.step(
      "Update Database Item in Notion",
      async () => {
        return sdk.runAction({
          appKey: "NotionCLIAPI",
          actionType: "write",
          actionKey: "update_database_item",
          connection: "notioncliapi_connection",
          inputs: {
            datasource: "0c691b07-11ac-82fa-bc1b-07d0186a095d",
            page: (tableFindRecord.data[0] as Record<string, unknown>).old.data
              .f1,
            use_zapier_datetime_fields: true,
            "properties|||Send Date|||date__start": input.publish_date,
          },
        });
      },
    );

    return notionUpdateDatabaseItem.data;
  },
);
