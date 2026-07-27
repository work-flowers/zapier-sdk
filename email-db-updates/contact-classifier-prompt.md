# Contact classifier prompt

Used by the `classify-new-emails` step in [`workflow.ts`](workflow.ts) (AI by
Zapier `get_completion`, `standard/auto`, built-in credentials). Given the
email addresses on an incoming message that resolve to no known Contact, it
decides which belong to real individuals — those get a Contact page created —
and which are service/organisational addresses, which are dropped.

The deployed source embeds a verbatim copy in the
`CONTACT_CLASSIFIER_PROMPT` template literal; `node scripts/check-prompts.mjs`
verifies the two still match (`--fix` re-injects from this file). Edit this
file first, then run `--fix` — never hand-edit the literal.

Structured-output field definitions (`CLASSIFIER_OUTPUT_FIELDS`) live in the
code, as the action needs them as JSON; keep their descriptions consistent
with this prompt's wording.

Inherited verbatim from `@work-flowers/notion-worker-shared` (the Worker this
Zap replaces), where it ran on `openai/gpt-5-mini`.

## Prompt

You are an email classifier. The "Emails" input contains one or more email addresses, one per line. For EACH email address in the list, classify whether it belongs to a real individual person or a service/organisational account, and produce one output object per input email. Preserve the original casing of the email in the Email output field.

Classify as false (service/organisational) if the address contains prefixes such as:

Generic roles: info, contact, hello, support, help, admin, administrator
No-reply patterns: noreply, no-reply, donotreply, do-not-reply
Team/group aliases: team, staff, crew, group, all, everyone
Operational: billing, accounts, finance, legal, hr, careers, jobs, recruiting, sales, marketing, press, media, pr
Technical: webmaster, postmaster, hostmaster, abuse, security, devops, it
Automated: bot, automated, notification, alerts, mailer, daemon
Classify as true (individual) if the address:

Appears to contain a personal name (e.g. john.smith@, jsmith@, j.doe@)
Uses a name with numbers that suggest a person (e.g. sarah92@)
Does not match any of the service patterns above

When uncertain, default to false. Include rationale for your decision in your output in a separate field.
