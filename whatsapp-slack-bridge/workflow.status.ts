// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/whatsapp-slack-bridge
// Deployed as `whatsapp-message-status`. Published as `workflow.ts` alongside `shared.ts`.
//
// WhatsApp "Message Status Updated" -> the message log, plus a failure notice
// where the sender will actually see it. Migration of the classic "Message
// Delivery" Zap.
import { defineDurable } from "@zapier/zapier-durable";
import {
  ALERT_CHANNEL,
  BUSINESS_PHONE,
  C_CHANNEL,
  M_MESSAGE_TS,
  findContactRows,
  firstString,
  isoFromEpochMs,
  normalizeInput,
  normalizePhone,
  postToSlack,
  upsertMessageLog,
} from "./shared.ts";

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "whatsapp-message-status",
  async (ctx, rawInput) => {
    const p = (normalizeInput(rawInput) ?? {}) as Record<string, any>;

    const messageId = firstString(p.id);
    const status = (firstString(p.status) ?? "").toLowerCase();
    if (!messageId || !status) {
      console.log("skipping: payload carries no message id / status");
      return { skipped: true, reason: "no message id or status in payload" };
    }

    const recipient = normalizePhone(p.recipient_id);
    const businessPhone = normalizePhone(p.display_phone_number) ?? BUSINESS_PHONE;

    const stampMs = Number(firstString(p.timestamp) ?? "");
    const createdIso =
      Number.isFinite(stampMs) && stampMs > 0 ? isoFromEpochMs(stampMs * 1000) : null;

    // Status updates only ever concern messages WE sent, so a row created here
    // is outbound by definition. This is the path that produced the 27 body-less
    // rows in the Table: it can beat the sending workflow's own log write, and
    // it is the only writer for the template-message Zap, which logs nothing.
    //
    // The status itself is applied monotonically inside upsertMessageLog —
    // WhatsApp does not guarantee webhook ordering, and the classic Zap
    // overwrote unconditionally, so a late `delivered` clobbered `read`.
    const row = await upsertMessageLog(ctx, "log", {
      messageId,
      from: businessPhone,
      to: recipient,
      // Seeds Created only when the row is new — upsertMessageLog treats it as
      // fill-only, so a `read` receipt hours later cannot restate the message's
      // own timestamp.
      createdIso,
      status,
      direction: "outbound",
    });

    if (status !== "failed") {
      console.log(`status ${status} for ${messageId}`);
      return { messageId, status, recipient };
    }

    // --- Failure ------------------------------------------------------------
    const errTitle = firstString(p.errors?.[0]?.title, p.errors?.title);
    const errDetail = firstString(
      p.errors?.[0]?.error_data?.details,
      p.errors?.[0]?.details,
      p.errors?.error_data?.details,
    );
    const detail = [errTitle, errDetail].filter(Boolean).join(" — ") || "no error detail supplied";

    // Thread the failure onto the Slack message that caused it, so the person
    // who typed it finds out. The classic Zap only posted a message id into
    // #zap-alerts, which nobody could trace back to a conversation.
    const slackTs = firstString((row?.data ?? {})[M_MESSAGE_TS]);
    let notifiedInChannel = false;

    if (recipient && slackTs) {
      const contactRows = await ctx.step("find-contact", async () => findContactRows(recipient));
      const channelId = firstString((contactRows[0]?.data ?? {})[C_CHANNEL]);
      if (channelId) {
        await postToSlack(ctx, "post-failure-in-thread", {
          channel: channelId,
          text:
            `:x: *This message was not delivered.*\n${detail}\n\n` +
            `If WhatsApp's 24-hour reply window has closed, react to one of the ` +
            `customer's messages with :whatsapp: to re-open it with the approved template.`,
          threadTs: slackTs,
        });
        notifiedInChannel = true;
      }
    }

    // Keep the #zap-alerts notice as the backstop, and say plainly when the
    // sender could not be told in-channel.
    await postToSlack(ctx, "post-failure-alert", {
      channel: ALERT_CHANNEL,
      text:
        `WhatsApp message \`${messageId}\` failed to send` +
        (recipient ? ` to ${recipient}` : "") +
        `.\n${detail}` +
        (notifiedInChannel
          ? ""
          : `\n_Could not notify the sender in their channel — no Slack message ts or channel ` +
            `on record for this message (a template send, or a send that predates this workflow)._`),
    });

    console.log(`failed ${messageId}: ${detail} (in-channel notice: ${notifiedInChannel})`);
    return { messageId, status, recipient, detail, notifiedInChannel };
  },
);

export default workflow;
