# Hand-off prompt

The message this Zap sends to the **Dennis' Email Sync Agent** Custom Agent
(`38991b07-11ac-8046-a76d-0092353ee522`) through the **Notion Agents
(Unofficial)** custom integration's *Send Message to Agent* action. One message
per thread tagged **Send to Notion**.

> **This file is the source of truth for the prompt.** `workflow.ts` embeds a
> verbatim copy in the `HANDOFF_PROMPT` template literal. Edit here first, then
> run `node scripts/check-prompts.mjs --fix` from the repo root.

**The agent's own Instructions do the work** (page in Emails with the default
template, the real thread id in Gmail Thread ID, a Mail block for the whole
thread). This message replaces only the agent's native mail-label trigger,
which started firing once per message. It carries only what the Instructions
can't know:

- the thread id;
- that the duplicate check is done: the Zap's free Table lookup is the only
  dedupe, so the agent must not spend a search of Emails on it (Dennis,
  2026-11-19);
- that nobody is watching, so it must not ask a question;
- the `<<<RESULT … RESULT>>>` block, read by `parseAgentResult()` in
  `workflow.ts`. A missing block, `no_mail_block` or `failed` fails the run,
  which raises a Zapier error alert. Change the block format here and the
  parser together.

**Kept short on purpose (2026-11-19).** The Custom Agent can only read the
thread and edit records in Emails: it has no tool to send or forward email.
So the prompt has no untrusted-content rule, no sender, subject or link, and
no Mail-connector hint, all of which the first version carried over from
[`gmail-label-to-agent-email-draft`](../gmail-label-to-agent-email-draft/),
whose personal agent can send mail. Add them back only if the agent gains
tools that make them matter.

`{{THREAD_ID}}` is filled in by `buildHandoffMessage()`.

---

## Prompt

Gmail thread {{THREAD_ID}} (dennis@work.flowers) has just been tagged Send to Notion. The automation has already checked that it is not in Emails, so file it now, following your instructions, without searching Emails first. Nobody is watching this chat, so do not ask questions.

End your answer with exactly this block:

<<<RESULT
outcome: created, no_mail_block or failed
page: the page's URL, or none
note: one sentence
RESULT>>>

"created": page and Mail block. "no_mail_block": page, but the Mail block failed. "failed": no page.
