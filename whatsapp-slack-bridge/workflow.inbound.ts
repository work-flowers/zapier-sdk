// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/whatsapp-slack-bridge
// Deployed as `whatsapp-message-to-slack`. Published as `workflow.ts` alongside `shared.ts`.
//
// WhatsApp "New Message Received" -> the contact's own Slack channel.
// Migration of the classic "WhatsApp -> Slack" Zap.
import { defineDurable } from "@zapier/zapier-durable";
import {
  ALERT_CHANNEL,
  BUSINESS_PHONE,
  C_CHANNEL,
  C_FIRST_NAME,
  C_OPT_IN,
  C_OPT_OUT_DATE,
  C_OPT_OUT_SOURCE,
  C_USERNAME,
  CONTACTS_TABLE,
  M_MESSAGE_TS,
  SLACK_APP,
  SLACK_CONNECTION,
  UNSUPPORTED_REPLY,
  channelNameFor,
  findMessageRowsById,
  firstString,
  firstToken,
  inboundFileUrl,
  isoFromEpochMs,
  isOptOutMessage,
  normalizeInput,
  normalizePhone,
  placeholderForType,
  postToSlack,
  postedTs,
  sdk,
  sendWhatsAppText,
  upsertContact,
  upsertMessageLog,
} from "./shared.ts";

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "whatsapp-message-to-slack",
  async (ctx, rawInput) => {
    const p = (normalizeInput(rawInput) ?? {}) as Record<string, any>;

    const messageId = firstString(p.id);
    const phone = normalizePhone(p.from);
    if (!messageId || !phone) {
      console.log("skipping: payload carries no message id / sender (empty or test delivery)");
      return { skipped: true, reason: "no message id or sender in payload" };
    }

    const type = firstString(p.type) ?? "text";
    const profileName = firstString(p.contact_name);
    const businessPhone = normalizePhone(p.display_phone_number) ?? BUSINESS_PHONE;

    // The message's own text, the caption of whatever media it carried, or a
    // typed stand-in. The classic Zap coalesced only text.body and
    // image.caption, so documents, audio, video and location all showed up in
    // Slack as the literal string "No Text".
    const bodyText =
      firstString(p.text?.body, p[type]?.caption) ?? placeholderForType(type, p);
    const fileUrl = inboundFileUrl(type, p);

    // Clock read must be inside a step: the durable runtime proxies Date and
    // Date.now() and throws DeterminismViolation in the workflow body.
    const nowMs = await ctx.step("read-clock", async () => Date.now());
    const nowIso = isoFromEpochMs(nowMs);

    // WhatsApp's timestamp is epoch seconds as a string.
    const sentAtMs = Number(firstString(p.timestamp) ?? "");
    const createdIso = Number.isFinite(sentAtMs) && sentAtMs > 0
      ? isoFromEpochMs(sentAtMs * 1000)
      : nowIso;

    const optOut = isOptOutMessage(p.text?.body);

    // 1. Find-or-create the contact, race-safely.
    //
    // `WhatsApp Username` now receives the real WhatsApp profile name. The
    // classic Zap wrote `from` into it, which is why four contacts in the Table
    // have their own phone number as their username — and why the
    // re-engagement template greets people as "Hi 6598555846".
    const contact = await upsertContact(
      ctx,
      "contact",
      phone,
      {
        ...(profileName ? { [C_USERNAME]: profileName } : {}),
        ...(firstToken(profileName) ? { [C_FIRST_NAME]: firstToken(profileName) } : {}),
        ...(optOut
          ? {
              [C_OPT_IN]: false,
              [C_OPT_OUT_DATE]: nowIso,
              [C_OPT_OUT_SOURCE]: "WhatsApp Opt-Out Request",
            }
          : {}),
      },
      (existing) => {
        const changes: Record<string, unknown> = {};
        // Username mirrors the live WhatsApp profile, so track changes to it.
        if (profileName && firstString(existing[C_USERNAME]) !== profileName) {
          changes[C_USERNAME] = profileName;
        }
        // First Name is human-curated (the Table has a hand-corrected
        // Grace/Tang row), so only ever fill it when empty.
        if (!firstString(existing[C_FIRST_NAME]) && firstToken(profileName)) {
          changes[C_FIRST_NAME] = firstToken(profileName);
        }
        if (optOut) {
          changes[C_OPT_IN] = false;
          // Deliberately NOT touching Marketing Opt-In Date / Opt-In Source:
          // the classic Zap overwrote both, destroying the record of when and
          // how consent was originally given.
          changes[C_OPT_OUT_DATE] = nowIso;
          changes[C_OPT_OUT_SOURCE] = "WhatsApp Opt-Out Request";
        }
        return changes;
      },
    );

    if (!contact) {
      console.log(`contact upsert produced no row for ${phone}`);
      return { skipped: true, reason: "contact row unavailable after upsert" };
    }

    // 2. Ensure the contact has a Slack channel.
    //
    // Two fixes over the classic Zap. It only created a channel when the
    // contact record was BRAND NEW, so 36 of 42 contacts have none and their
    // messages had nowhere to go. And it created the channel on a path running
    // CONCURRENTLY with the one that posts the message, so a new contact's
    // first message raced the channel into existence and was usually lost.
    // Here it is simply sequential.
    let channelId = firstString((contact.data ?? {})[C_CHANNEL]);
    if (!channelId) {
      const preferred = channelNameFor(profileName, phone);
      const fallback = `${preferred}-${phone.slice(-4)}`.slice(0, 80);

      const created = await ctx.step("create-slack-channel", async () => {
        // Catch inside the step so a name collision resolves here rather than
        // spinning the durable's step-retry loop.
        try {
          return await sdk.runAction({
            appKey: SLACK_APP,
            actionType: "write",
            actionKey: "new_channel",
            connection: SLACK_CONNECTION,
            inputs: { name: preferred },
          });
        } catch (err) {
          const msg = String((err as any)?.message ?? err);
          if (!/name_taken|already/i.test(msg)) throw err;
          // Deterministic second name, so a retry of this step asks for the
          // same thing rather than creating a new channel each attempt.
          return await sdk.runAction({
            appKey: SLACK_APP,
            actionType: "write",
            actionKey: "new_channel",
            connection: SLACK_CONNECTION,
            inputs: { name: fallback },
          });
        }
      });

      const row = (created as any)?.data?.[0];
      channelId = firstString(row?.channel?.id, row?.id);
      if (!channelId) {
        // Both names taken, or Slack returned no id. Tell a human rather than
        // dropping the message silently.
        await postToSlack(ctx, "alert-channel-create-failed", {
          channel: ALERT_CHANNEL,
          text:
            `Could not create a Slack channel for WhatsApp contact \`${phone}\`` +
            (profileName ? ` (${profileName})` : "") +
            `. Tried \`${preferred}\` and \`${fallback}\`. ` +
            `Their message is not in Slack. Create the channel and paste its ID into ` +
            `the "${C_CHANNEL}" column of the WhatsApp Contact Info Table.`,
        });
        return { skipped: true, reason: "slack channel could not be created", phone };
      }

      await ctx.step("store-slack-channel", async () =>
        sdk.updateTableRecords({
          table: CONTACTS_TABLE,
          keyMode: "names",
          records: [{ id: String(contact.id), data: { [C_CHANNEL]: channelId } }],
        }),
      );
      console.log(`contact ${phone}: created Slack channel ${channelId}`);
    }

    // 3. Thread under the quoted message, when the customer quoted one.
    //    WhatsApp only sets `context.id` on an explicit reply, so ordinary
    //    consecutive messages stay top-level in the channel.
    let threadTs: string | null = null;
    const quotedId = firstString(p.context?.id);
    if (quotedId) {
      const quoted = await ctx.step("find-quoted-message", async () =>
        findMessageRowsById(quotedId),
      );
      threadTs = firstString((quoted[0]?.data ?? {})[M_MESSAGE_TS]);
    }

    // 4. Post it.
    const posted = await postToSlack(ctx, "post-to-slack", {
      channel: channelId,
      text: bodyText,
      username: profileName ?? phone,
      threadTs,
      fileUrl,
    });
    const slackTs = postedTs(posted);

    // 5. Log the message. Direction is explicit now — the business number has
    //    changed over time, so From/To cannot be used to infer it.
    await upsertMessageLog(ctx, "log", {
      messageId,
      from: phone,
      to: businessPhone,
      createdIso,
      status: "delivered",
      body: bodyText,
      messageTs: slackTs,
      direction: "inbound",
    });

    // 6. A message WhatsApp itself could not represent gets an auto-reply. The
    //    customer just messaged us, so we are inside the service window.
    let autoReplied = false;
    if (type === "unsupported") {
      await sendWhatsAppText(ctx, "reply-unsupported", phone, UNSUPPORTED_REPLY, messageId);
      autoReplied = true;
    }

    // 7. Make an opt-out visible to the humans in the channel. The classic Zap
    //    flipped the flag silently.
    if (optOut) {
      await postToSlack(ctx, "post-opt-out-notice", {
        channel: channelId,
        text:
          `:no_bell: *${profileName ?? phone} asked to stop receiving messages.* ` +
          `Marketing opt-in is now off and the opt-out has been dated. ` +
          `Replies to this conversation still work — this only blocks proactive sends.`,
        threadTs: slackTs,
      });
    }

    console.log(
      `posted ${type} from ${phone} to ${channelId}` +
        (threadTs ? ` in thread ${threadTs}` : "") +
        (fileUrl ? " with file" : ""),
    );
    return {
      messageId,
      phone,
      type,
      channelId,
      slackTs,
      threadTs,
      hadFile: fileUrl != null,
      optOut,
      autoReplied,
    };
  },
);

export default workflow;
