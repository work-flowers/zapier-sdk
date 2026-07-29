// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/whatsapp-slack-bridge
// Deployed as `slack-reply-to-whatsapp`. Published as `workflow.ts` alongside `shared.ts`.
//
// A human's reply in a `whatsapp-*` Slack channel -> a WhatsApp message back to
// the customer. Migration of the classic "Slack Replies -> WhatsApp" Zap.
import { defineDurable } from "@zapier/zapier-durable";
import {
  BUSINESS_PHONE,
  C_PHONE,
  M_MESSAGE_ID,
  SERVICE_WINDOW_MS,
  U_FIRST_NAME,
  acceptsCaption,
  findContactByChannel,
  findInternalUser,
  findMessageRowsByTs,
  firstString,
  isBridgeChannelName,
  isoFromEpochMs,
  lastInboundAtMs,
  mediaTypeFor,
  normalizeInput,
  normalizePhone,
  postToSlack,
  publicUrlForSlackFile,
  sentMessageId,
  sendWhatsAppMedia,
  sendWhatsAppText,
  upsertMessageLog,
} from "./shared.ts";

/**
 * Slack message subtypes this workflow treats as a real human reply.
 *
 * Everything else — joins, leaves, edits, deletions, topic changes — is
 * channel noise that must not be relayed to a customer.
 */
const RELAYABLE_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "slack-reply-to-whatsapp",
  async (ctx, rawInput) => {
    const p = (normalizeInput(rawInput) ?? {}) as Record<string, any>;

    // --- Free early exits ---------------------------------------------------
    // This trigger fires for every public message in the workspace, so almost
    // every run ends here. The classic Zap had no cheap way to discard one: it
    // went straight into a Find Record with success-on-miss off, so every
    // Slack message posted anywhere outside a whatsapp-* channel produced a
    // hard Zap error. Returning early costs no task and raises nothing.

    const subtype = firstString(p.subtype);
    if (subtype && !RELAYABLE_SUBTYPES.has(subtype)) {
      return { skipped: true, reason: `slack subtype ${subtype}` };
    }

    // Our own inbound workflow posts into these channels as a bot. Relaying a
    // bot message would loop it straight back to WhatsApp. The trigger is also
    // published with listen_for_bots: false; this is the belt to that braces.
    if (firstString(p.bot_id) || p.user?.is_bot === true) {
      return { skipped: true, reason: "bot message" };
    }

    const channelId = firstString(p.channel, p.channel?.id);
    if (!channelId) return { skipped: true, reason: "no channel in payload" };

    // Cheapest possible check when the trigger gives us a name at all.
    const channelName = firstString(p.channel_name, p.channel?.name);
    if (channelName && !isBridgeChannelName(channelName)) {
      return { skipped: true, reason: `channel ${channelName} is not a WhatsApp channel` };
    }

    // Table reads are free, so this is still a no-task exit.
    const contact = await ctx.step("find-contact", async () => findContactByChannel(channelId));
    if (!contact) {
      return { skipped: true, reason: "no WhatsApp contact mapped to this Slack channel" };
    }

    const recipient = normalizePhone((contact.data ?? {})[C_PHONE]);
    if (!recipient) {
      return { skipped: true, reason: "contact row has no usable phone number" };
    }

    const text = firstString(p.text);
    const files: any[] = Array.isArray(p.files) ? p.files : [];
    if (!text && files.length === 0) {
      return { skipped: true, reason: "message has neither text nor files" };
    }

    const slackTs = firstString(p.ts);
    const threadTs = firstString(p.thread_ts);

    // --- The 24-hour service window ---------------------------------------
    // WhatsApp only allows a freeform message within 24h of the customer's last
    // message. The classic Zap sent regardless: the send "succeeded" at Zapier
    // and then failed at Meta, surfacing only as a message id in #zap-alerts.
    const nowMs = await ctx.step("read-clock", async () => Date.now());
    const lastInbound = await ctx.step("find-last-inbound", async () =>
      lastInboundAtMs(recipient),
    );

    if (lastInbound == null || nowMs - lastInbound > SERVICE_WINDOW_MS) {
      const ago =
        lastInbound == null
          ? "we have no inbound message on record"
          : `their last message was ${Math.floor((nowMs - lastInbound) / 3600000)}h ago`;
      await postToSlack(ctx, "warn-window-closed", {
        channel: channelId,
        text:
          `:warning: *Not sent — WhatsApp's 24-hour reply window has closed* ` +
          `(${ago}).\nWhatsApp only allows a free-text reply within 24 hours of the ` +
          `customer's last message. To re-open the conversation, react to one of ` +
          `their messages with :whatsapp: to send the approved re-engagement template.`,
        threadTs: slackTs,
      });
      console.log(`window closed for ${recipient}; reply not sent`);
      return {
        skipped: true,
        reason: "service window closed",
        recipient,
        lastInboundAt: lastInbound == null ? null : isoFromEpochMs(lastInbound),
      };
    }

    // --- Attribution -------------------------------------------------------
    // Who in Slack is replying. The classic Zap looked this up with
    // success-on-miss off, so a reply from anyone not in the Internal User IDs
    // Table errored the whole Zap. Now it just goes unsigned.
    const slackUserId = firstString(p.user, p.user?.id);
    const internal = slackUserId
      ? await ctx.step("find-internal-user", async () => findInternalUser(slackUserId))
      : null;
    const senderName = firstString((internal?.data ?? {})[U_FIRST_NAME]);
    const body = text ? (senderName ? `${text}\n\n(from ${senderName})` : text) : null;

    // --- Quote the WhatsApp message this Slack thread belongs to ----------
    let contextMessageId: string | null = null;
    if (threadTs) {
      const parent = await ctx.step("find-quoted-message", async () =>
        findMessageRowsByTs(threadTs),
      );
      contextMessageId = firstString((parent[0]?.data ?? {})[M_MESSAGE_ID]);
    }

    const createdIso = isoFromEpochMs(nowMs);
    const sent: Array<{ messageId: string | null; kind: string }> = [];
    let captionConsumed = false;
    let quoteAvailable = contextMessageId;

    // --- Files -------------------------------------------------------------
    // The classic Zap handled PDFs and images only, sent just the first
    // attachment, and tested for PDF with `ireversecontains "pdf"` — true for
    // "p", "pd" and the empty string. Everything else matched the "File
    // Attached" path, hit neither sub-path, and was dropped silently.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileId = firstString(file?.id);
      if (!fileId) continue;

      const mediaType = mediaTypeFor(file?.mimetype, file?.filetype);
      const publicUrl = await publicUrlForSlackFile(ctx, `make-file-public-${i}`, fileId);
      if (!publicUrl) {
        await postToSlack(ctx, `warn-file-unshareable-${i}`, {
          channel: channelId,
          text:
            `:warning: Could not produce a public URL for \`${firstString(file?.name) ?? fileId}\`, ` +
            `so it was not sent to the customer.`,
          threadTs: slackTs,
        });
        continue;
      }

      // Only image/video/document take a caption — audio does not, so text
      // accompanying a voice note has to go as its own message.
      const useCaption = !captionConsumed && body != null && acceptsCaption(mediaType);
      const res = await sendWhatsAppMedia(ctx, `send-media-${i}`, {
        recipient,
        mediaType,
        fileUrl: publicUrl,
        caption: useCaption ? body : null,
        filename: firstString(file?.name),
        contextMessageId: quoteAvailable,
      });
      if (useCaption) captionConsumed = true;
      quoteAvailable = null; // quote once, on the first message only

      const waId = sentMessageId(res);
      sent.push({ messageId: waId, kind: mediaType });
      if (waId) {
        await upsertMessageLog(ctx, `log-media-${i}`, {
          messageId: waId,
          from: BUSINESS_PHONE,
          to: recipient,
          createdIso,
          status: "sent",
          body: useCaption ? body : `[${mediaType}] ${firstString(file?.name) ?? ""}`.trim(),
          messageTs: slackTs,
          direction: "outbound",
        });
      }
    }

    // --- Text --------------------------------------------------------------
    // Sent when there are no files at all, or when the files could not carry
    // the caption (audio).
    if (body != null && !captionConsumed) {
      const res = await sendWhatsAppText(ctx, "send-text", recipient, body, quoteAvailable);
      const waId = sentMessageId(res);
      sent.push({ messageId: waId, kind: "text" });
      if (waId) {
        await upsertMessageLog(ctx, "log-text", {
          messageId: waId,
          from: BUSINESS_PHONE,
          to: recipient,
          createdIso,
          status: "sent",
          body,
          messageTs: slackTs,
          direction: "outbound",
        });
      }
    }

    if (sent.length === 0) {
      return { skipped: true, reason: "nothing could be sent", recipient };
    }

    console.log(
      `sent ${sent.length} message(s) to ${recipient} ` +
        `(${sent.map((s) => s.kind).join(", ")})` +
        (senderName ? ` from ${senderName}` : ""),
    );
    return { recipient, channelId, slackTs, sent, quoted: contextMessageId };
  },
);

export default workflow;
