import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// Connection aliases (mapped to real connection IDs at test/publish time).
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";
const GDRIVE_APP_KEY = "GoogleDriveCLIAPI";
const GDRIVE_CONNECTION = "gdrive";

// Fixed targets carried over from the original classic Zap.
const NOTION_COMPANIES_DATASOURCE = "32091b07-11ac-8111-a8ea-000b970565cf"; // Companies
const GDRIVE_SHARED_DRIVE = "0AHY_MJFjT0WtUk9PVA"; // Work.Flowers HQ
const GDRIVE_PARENT_FOLDER = "109hgE0VmTpTFTGUXreEYCNf8xu-jSnc2"; // Client Docs

const InputSchema = z.object({
  // The Notion Companies page id (the "Deal Won" company to set up).
  companyPageId: z.string().min(1),
});
type Input = z.infer<typeof InputSchema>;

// Manual/webhook input may arrive as a JSON string rather than a parsed object.
function normalizeInput(rawInput: unknown): unknown {
  if (typeof rawInput === "string") {
    return JSON.parse(rawInput);
  }
  return rawInput;
}

// Notion read action returns { data: [page] }; pull the single page out.
function firstRow(result: unknown): any {
  const data = (result as any)?.data;
  return Array.isArray(data) ? data[0] : data;
}

const workflow = defineDurable<Input, unknown>(
  "deal-won-set-up-client-workspace",
  async (ctx, rawInput) => {
    const input = InputSchema.parse(normalizeInput(rawInput));

    // Step 1: read the Notion company page.
    const companyPageResult = await ctx.step("get-company-page", async () =>
      sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "search",
        actionKey: "get_page_or_database_item_by_id",
        connection: NOTION_CONNECTION,
        inputs: { page_id: input.companyPageId },
      }),
    );

    // Plain code: extract the fields we need.
    const page = firstRow(companyPageResult);
    const props = page?.properties ?? {};
    const companyName: string =
      props["Company Name"]?.title?.[0]?.plain_text ?? "";
    const existingFolderUrl: string | null =
      props["Google Drive Folder"]?.url ?? null;

    // Guard (the original "filter" step): stop if a Drive folder is already set.
    if (existingFolderUrl) {
      return {
        skipped: true,
        reason: "Company already has a Google Drive Folder",
        companyPageId: input.companyPageId,
        companyName,
        folderUrl: existingFolderUrl,
      };
    }

    // Step 2: create the Google Drive folder for this company.
    const folderResult = await ctx.step("create-drive-folder", async () =>
      sdk.runAction({
        appKey: GDRIVE_APP_KEY,
        actionType: "write",
        actionKey: "folder",
        connection: GDRIVE_CONNECTION,
        inputs: {
          drive: GDRIVE_SHARED_DRIVE,
          folder: GDRIVE_PARENT_FOLDER,
          title: companyName,
        },
      }),
    );

    // Plain code: resolve the new folder's id and a usable URL.
    const folder = firstRow(folderResult) ?? (folderResult as any);
    const folderId: string =
      folder?.id ?? folder?.folderId ?? folder?.fileId ?? "";
    const folderUrl: string =
      folder?.url ??
      folder?.webViewLink ??
      folder?.alternateLink ??
      (folderId ? `https://drive.google.com/drive/folders/${folderId}` : "");

    // Step 3: write the folder URL back onto the Notion company record.
    const updateResult = await ctx.step("update-company-record", async () =>
      sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "update_database_item",
        connection: NOTION_CONNECTION,
        inputs: {
          datasource: NOTION_COMPANIES_DATASOURCE,
          page: input.companyPageId,
          "properties|||Google Drive Folder|||url": folderUrl,
        },
      }),
    );

    return {
      skipped: false,
      companyPageId: input.companyPageId,
      companyName,
      folderId,
      folderUrl,
      updated: firstRow(updateResult) ?? updateResult,
    };
  },
);

export default workflow;
