// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/whatsapp-slack-bridge
// Deployed as `slack-reply-to-whatsapp`. Published as `workflow.ts` alongside `shared.ts`.
//
// A human's reply in a `whatsapp-*` Slack channel -> a WhatsApp message back to
// the customer. Migration of the classic "Slack Replies -> WhatsApp" Zap.
//
// Since 2026-10-31 this deployment has NO trigger of its own. The workspace's
// one "message posted anywhere" Slack trigger lives on
// slack-thread-to-notion-discussion, which hands a `whatsapp-*` channel message
// over with triggerWorkflow as a pointer, `{ source: "slack-router", channel,
// channel_name, ts, thread_ts? }`. This workflow re-reads the raw message from
// Slack, because the router's processed payload lacks the raw fields used below
// (files, subtype, bot_id). Two Zaps on one trigger paid the per-run task
// minimum twice for every Slack message in the workspace. A raw Slack event
// (the old trigger's shape) is still accepted, e.g. for a manual re-run.
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import {
  BUSINESS_PHONE,
  C_PHONE,
  M_DIRECTION,
  M_MESSAGE_ID,
  SERVICE_WINDOW_MS,
  SLACK_CONNECTION,
  acceptsCaption,
  findContactByChannel,
  findMessageRowsByTs,
  firstString,
  isBridgeChannelName,
  isoFromEpochMs,
  labeledValue,
  lastInboundAtMs,
  mediaTypeFor,
  normalizeInput,
  normalizePhone,
  postToSlack,
  publicUrlForSlackFile,
  sentMessageId,
  sendWhatsAppMedia,
  sendWhatsAppText,
  slackToWhatsAppText,
  upsertMessageLog,
} from "./shared.ts";

/**
 * Slack message subtypes this workflow treats as a real human reply.
 *
 * Everything else — joins, leaves, edits, deletions, topic changes — is
 * channel noise that must not be relayed to a customer.
 */
const RELAYABLE_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

const sdk = createZapierSdk();

/** `source` on a hand-off from slack-thread-to-notion-discussion. */
const FORWARD_SOURCE = "slack-router";

/**
 * Re-read one message, raw, from Slack. `conversations.replies` answers for a
 * thread reply and for a top-level message alike (keyed on the thread root,
 * bounded to this ts). Null when the message is gone (deleted before this ran).
 * Any other Slack refusal throws: a hand-off we can't read is a real reply
 * that would otherwise be dropped silently. Must be called inside a ctx.step.
 */
async function readSlackMessage(
  channel: string,
  ts: string,
  threadTs: string | null,
): Promise<Record<string, any> | null> {
  const qs =
    `channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs ?? ts)}` +
    `&oldest=${encodeURIComponent(ts)}&latest=${encodeURIComponent(ts)}&inclusive=true&limit=10`;
  const res = await sdk.fetch(`https://slack.com/api/conversations.replies?${qs}`, {
    connection: SLACK_CONNECTION,
  });
  if (!res.ok) throw new Error(`Slack conversations.replies ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { ok?: boolean; error?: string; messages?: Array<Record<string, any>> };
  if (json.ok !== true) {
    if (json.error === "thread_not_found" || json.error === "message_not_found") return null;
    throw new Error(`Slack conversations.replies refused: ${json.error ?? "unknown error"}`);
  }
  return (json.messages ?? []).find((m) => m?.ts === ts) ?? null;
}

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "slack-reply-to-whatsapp",
  async (ctx, rawInput) => {
    let p = (normalizeInput(rawInput) ?? {}) as Record<string, any>;

    // --- Hand-off from slack-thread-to-notion-discussion --------------------
    if (firstString(p.source) === FORWARD_SOURCE) {
      const fwdChannel = firstString(p.channel);
      const fwdTs = firstString(p.ts);
      if (!fwdChannel || !fwdTs) {
        throw new Error(`hand-off from ${FORWARD_SOURCE} has no channel/ts (keys: ${Object.keys(p).join(", ")})`);
      }
      const fwdThreadTs = firstString(p.thread_ts);
      const message = await ctx.step("read-forwarded-message", async () =>
        readSlackMessage(fwdChannel, fwdTs, fwdThreadTs),
      );
      if (!message) {
        return { skipped: true, reason: "forwarded message no longer exists in Slack" };
      }
      // The raw message carries no channel; the hand-off does.
      p = { ...message, channel: fwdChannel, channel_name: firstString(p.channel_name) };
    }

    // --- Free early exits ---------------------------------------------------
    // Under its old trigger this fired for every public message in the
    // workspace, so almost every run ended here. A hand-off is already a
    // whatsapp-* message, but the checks still apply to its raw re-read. The classic Zap had no cheap way to discard one: it
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

    // --- Already relayed? ---------------------------------------------------
    // Every send logs its Slack ts as an outbound row, so a second delivery of
    // the same reply (a Slack redelivery, a manual re-run, or the brief overlap
    // at the 2026-10-31 cutover when the old trigger and the hand-off could
    // both fire) is dropped here instead of messaging the customer twice.
    // Table reads are free.
    if (slackTs) {
      const prior = await ctx.step("find-prior-relay", async () => findMessageRowsByTs(slackTs));
      if (prior.some((r: any) => labeledValue((r?.data ?? {})[M_DIRECTION]) === "outbound")) {
        return { skipped: true, reason: "reply already relayed (its Slack ts is logged as outbound)" };
      }
    }

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

    // Sent as typed, minus Slack's mrkdwn link wrapping. The classic Zap
    // appended "(from <first name>)" via the Internal User IDs Table; dropped,
    // since only Dennis replies from Slack.
    const body = text == null ? null : slackToWhatsAppText(text);

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
        `(${sent.map((s) => s.kind).join(", ")})`,
    );
    return { recipient, channelId, slackTs, sent, quoted: contextMessageId };
  },
);

export default workflow;
