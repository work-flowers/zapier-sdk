// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/gws-new-user-provisioning
//
// Durable port of the classic Zap "New Google Workspace Account -> Provision
// Standard Accounts". A new Google Workspace user gets:
//   1. A row in the "Internal User IDs" Zapier Table (find-or-create by email).
//      The five internal-user-ids-* durables key on the same Email column, so
//      this row is the anchor the whole identity map hangs off.
//   2. A Zapier team invite (team 20495893's work.flowers team 20491667) —
//      only if the row has no Zapier ID yet. When they accept, the live
//      internal-user-ids-zapier durable writes the ID back onto this row.
//   3. A welcome email pointing at the Slack / Notion SSO join links (neither
//      workspace can be joined by API on our plans — SSO is the mechanism).
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

/** Zapier Table "Internal User IDs" — free reads/writes, no connection. */
const USER_ID_TABLE = "01JM3J9SG5X6S8GBSSC8AS28AT";
/** work.flowers Zapier team (Zapier Manager `team_invite`, built-in auth). */
const ZAPIER_TEAM_ID = "20491667";

// --- Pure helpers (lifted from internal-user-ids-to-table-and-notion) --------

/** The trigger pipeline can deliver input double-encoded; run-durable delivers
 *  it single-encoded. Parse until we reach a non-string. */
function normalizeInput(rawInput: unknown): unknown {
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const t = v.trim();
    if (t[0] !== "{" && t[0] !== "[" && t[0] !== '"') break;
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
  }
  return v;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** Lowercased, validated email — the Table's Email column is all-lowercase and
 *  every internal-user-ids durable matches on it exactly. */
function cleanEmail(v: unknown): string | null {
  const s = str(v)?.toLowerCase() ?? null;
  return s && EMAIL_RE.test(s) ? s : null;
}

function firstResult(res: any): any {
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

/** The classic Zap's welcome email, verbatim. */
function welcomeEmailBody(givenName: string): string {
  return `Hi ${givenName},
<br><br>
Welcome to the team! You'll automatically be sent an invite for our Zapier workspace. In the meantime, you can automatically join the following workspaces via SSO / Sign in with Google:

<b>Slack</b>: https://join.slack.com/t/workflowers-workspace/signup
<br>
<b>Notion</b>: https://www.notion.so/work-flowers

<br><br>
If you have any questions, please reach out to Dennis!`;
}

// --- Workflow -----------------------------------------------------------------

// The durable's input generic requires Record<string, unknown>; the payload is
// still normalized + validated by hand because it can arrive JSON-encoded.
const workflow = defineDurable<Record<string, unknown>, unknown>(
  "gws-new-user-provisioning",
  async (ctx, rawInput) => {
    const payload = normalizeInput(rawInput) as any;

    // Google Admin Directory user object: primaryEmail + name.{givenName,...}.
    const email = cleanEmail(payload?.primaryEmail);
    // A UI "test" run or malformed payload exits as a clean no-op, not an
    // error alert (polling trigger, so this should be rare).
    if (!email) {
      console.log("skipping: no valid primaryEmail in payload");
      return { skipped: true, reason: "no valid primaryEmail in payload" };
    }

    const givenName =
      str(payload?.name?.givenName) ??
      str(payload?.name?.fullName)?.split(/\s+/)[0] ??
      email.split("@")[0];

    // --- 1. Find-or-create the Internal User IDs row ----------------------
    const hit = await ctx.step("find-table-row", async () =>
      sdk.listTableRecords({
        table: USER_ID_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "Email", operator: "exact", value: email }],
        pageSize: 1,
      }),
    );
    let row = hit?.data?.[0] ?? null;
    const created = !row;

    if (!row) {
      // Google Workspace is the identity source, so its names are
      // authoritative — seed them on create (the classic Zap set Email only).
      // Never written on an existing row; those are curated by hand.
      const data: Record<string, string> = { Email: email };
      const first = str(payload?.name?.givenName);
      const last = str(payload?.name?.familyName);
      if (first) data["First Name"] = first;
      if (last) data["Last Name"] = last;

      const made = await ctx.step("create-table-row", async () =>
        sdk.createTableRecords({
          table: USER_ID_TABLE,
          keyMode: "names",
          records: [{ data }],
        }),
      );
      row = firstResult(made);
    }

    // --- 2. Invite to the Zapier team, unless they already have a Zapier ID.
    // The internal-user-ids-zapier durable fills `Zapier ID` in when the
    // invite is accepted (Zapier Manager `team_member` trigger).
    const zapierId = str(row?.data?.["Zapier ID"]);
    let invited = false;
    if (!zapierId) {
      await ctx.step("invite-to-zapier-team", async () =>
        sdk.runAction({
          appKey: "ZapierManagerCLIAPI",
          actionType: "write",
          actionKey: "team_invite",
          inputs: { team: ZAPIER_TEAM_ID, email },
        }),
      );
      invited = true;
    }

    // --- 3. Welcome email (Email by Zapier — no connection, no tasks saved
    // by skipping, and the classic Zap sent it unconditionally).
    await ctx.step("send-welcome-email", async () =>
      sdk.runAction({
        appKey: "ZapierMailCLIAPI",
        actionType: "write",
        actionKey: "outbound",
        inputs: {
          to: email,
          subject: "Welcome to work.flowers!",
          body: welcomeEmailBody(givenName),
          from_name: "work.flowers Onboarding",
          reply_to: "dennis@work.flowers",
          cc: "dennis@work.flowers",
          open_tracking: false,
        },
      }),
    );

    return {
      email,
      tableRowId: row?.id ?? null,
      tableRowCreated: created,
      zapierInviteSent: invited,
      welcomeEmailSent: true,
    };
  },
);

export default workflow;
