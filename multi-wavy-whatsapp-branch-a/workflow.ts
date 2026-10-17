// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/multi-wavy-whatsapp-branch-a
//
// Multi-Wavy WhatsApp | Branch A (+1 929-762-2048): every new inbound WhatsApp message
// on this number's connection is forwarded to the multi-wavy-numbers Lovable app's
// inbound webhook. Published as `workflow.ts` alongside `forwarder-core.ts`
// (a byte-identical copy of multi-wavy-whatsapp-forwarder/forwarder-core.ts).
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import {
  FORWARD_URL,
  classifyAttempt,
  outcomeFromError,
  prepareForward,
  type Branch,
} from "./forwarder-core.ts";

const sdk = createZapierSdk();

// The trigger is bound to this connection in zap.json (trigger.authentication_id);
// this code never calls WhatsApp, and sends NO X-Webhook-Secret header (the app's
// auth change is a separate piece of work, so until it lands the app answers 401
// and the run fails, loudly). prepareForward refuses the live +65 connection and
// number before anything else happens.
const BRANCH: Branch = {
  label: "Branch A",
  connectionId: "0219aff1-73d3-866c-98a1-3f6cff9b4bf9",
  displayDigits: "19297622048",
};

const workflow = defineDurable("multi-wavy-whatsapp-branch-a", async (ctx, rawInput: unknown) => {
  const prepared = prepareForward(BRANCH, rawInput);
  if (prepared.action === "skip") {
    console.log(`skipping: ${prepared.reason} (manual test or empty delivery, not a message)`);
    return { skipped: prepared.reason };
  }
  const body = prepared.body;

  // ONE POST, replayed up to 3 times only on errors classifyAttempt calls retryable
  // (network, timeout, 408, 429, 5xx). Replay is safe because the app dedupes on
  // the wamid. Genuine rejections (401, 400, 413...) are RETURNED, not thrown, so
  // the run fails below with the app's own message instead of the step's
  // "exhausted all retry attempts".
  const sent = await ctx.step({
    name: "forward-to-app",
    maxAttempts: 3,
    retryDelaySeconds: 10,
    run: async () => {
      let res: Response;
      try {
        res = await sdk.fetch(FORWARD_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (classifyAttempt(outcomeFromError(err)) === "retry") throw err;
        return { status: 0, text: `request failed: ${String((err as Error)?.message ?? err).slice(0, 500)}` };
      }
      const text = (await res.text()).slice(0, 500);
      if (classifyAttempt({ kind: "response", status: res.status }) === "retry") {
        throw new Error(`app answered ${res.status}: ${text}`);
      }
      return { status: res.status, text };
    },
  });

  if (classifyAttempt({ kind: "response", status: sent.status }) !== "ok") {
    throw new Error(`${BRANCH.label}: app rejected message ${body.id} (${sent.status}): ${sent.text}`);
  }
  console.log(`forwarded ${BRANCH.label} message ${body.id} (type ${body.type || "?"}): ${sent.text}`);
  return { forwarded: true, branch: BRANCH.label, id: body.id, status: sent.status };
});

export default workflow;
