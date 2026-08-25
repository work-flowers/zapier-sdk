<!-- shared-rules v3 · upstream: work-flowers/zapier-durables-template
     BYTE-IDENTICAL ACROSS ALL ZAP REPOS. Do not add repo-specific facts here —
     connection ids, data-source state, named Zaps, account ids and workspace
     details belong in that repo's CLAUDE.md. Anything written here propagates
     to every client repo on the next sync. -->

# Zapier Durables — writing the code

Companion to `durables.md`, which covers how a Zap repo ships. This file covers
writing durable code: the runtime's guards, the SDK's sharp edges, and the guard
and retry design lessons that were learned by shipping the wrong thing.

## The determinism guard

**Never write `new Date` (or `Date.now()`, `Math.random()`, `fetch`, `setTimeout`) in a durable's workflow body — only inside a `ctx.step`.** `@zapier/zapier-durable` monkey-patches those globals at startup and runs the workflow function in GUARDED mode, so a call outside a step throws `DeterminismViolation: Non-deterministic API "…" called in GUARDED mode`. **The `Date` guard is argument-blind:** its Proxy's `construct` trap asserts *before* looking at the arguments, so `new Date(ms)` and `new Date(Date.UTC(y, m, d))` — both perfectly deterministic — fail exactly as hard as a bare `new Date()`. (`Date.UTC` and `Date.parse` are unguarded, since the `get` trap only special-cases `now`, but don't build on that.)

- **Calendar arithmetic:** integer maths, no `Date` at all. Use the `daysFromCivil` / `isoDateFromEpochMs` / `daysInMonth` helpers — `CLAUDE.md` names where this repo's copy lives. Paying a task for a `ctx.step` just to format a date is absurd.
- **A genuine clock read:** wrap it, e.g. `await ctx.step("today", async () => isoDateFromEpochMs(Date.now()))`. The value is then fixed for every retry of that run, which is the whole point of the rule.
- **Nothing catches this before production.** The guard is a runtime component of the durable package — not a lint, not a publish-time check — so `tsc` passes and `publish-workflow-version` succeeds, and the failure only appears when a real payload reaches that line. It has cost a Zap 100% of its runs, and the same latent bug has shipped twice. **When testing a new durable with `run-durable`, use a payload that reaches the main path**, not one that returns at an early guard clause — a skip-path test proves nothing about the code after it.

## Type-check before publishing

**Nothing on the publish path runs `tsc` for you.** `npm install --no-save` the pinned deps into a scratch directory, then:

```
npx tsc --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --noEmit workflow.ts
```

Adding `--noUnusedLocals` catches constants left behind by a port. Where a Zap publishes extra `source_files` with `.ts` import specifiers, add `--allowImportingTsExtensions`.

**`defineDurable`'s input generic is constrained from 0.10.1 onward.** The signature is `defineDurable<TInput extends Record<string, unknown>, TOutput>`, so the plausible `defineDurable<unknown, unknown>(name, run)` form fails with `TS2344: Type 'unknown' does not satisfy the constraint 'Record<string, unknown>'`. Omit the type parameters — the declared input type is a half-truth anyway, since a webhook payload may arrive as a (sometimes double-encoded) JSON string. Nobody noticed this for weeks because nothing on the publish path runs `tsc`, so the broken form published and ran fine.

**Corollary: a Zap compiling is not evidence anyone ever compiled it.** Type-check before assuming an untouched file is clean.

Also watch the call shape: `defineDurable` takes `(name, async (ctx, rawInput) => …)`. The plausible-looking `(name, options, async (input, ctx) => …)` publishes fine and then fails at run time with `durable.run is not a function`.

## Multi-file workflows

**Multi-file `source_files` works** — verified 2026-08-05 on `@zapier/zapier-durable` **0.11.1 and 0.12.3**. Pass extra keys alongside `workflow.ts`: `{"workflow.ts": …, "helper.ts": …}`.

**The import specifier MUST carry an explicit `.ts` extension.** `import … from "./helper.ts"` resolves; `"./helper.js"` — the specifier `--module nodenext` would normally want — fails at run time with `ERR_MODULE_NOT_FOUND: Cannot find module '/vercel/sandbox/helper.js'`. The file IS uploaded; only the specifier is wrong, so the error reads like a missing file.

## Triggering another Zap

**Any Zap can trigger any other Zap — there is no such thing as a sub-Zap.** A durable can fire any other workflow whose required input fields its payload satisfies; a `[Sub-Zap]` prefix in a legacy classic Zap is naming, not a platform concept, and nothing needs to be structured as a "child".

Fan out with `sdk.triggerWorkflow({ workflow: <workflow_id>, input })` rather than a plain `fetch` to the public catch URL — the durable sandbox's network allowlist blocks `hooks.zapier.com`, and the internal `trigger_url` needs a JWT the durable cannot mint.

Any fan-out creates a cycle risk. Bound it explicitly: a hop counter refused past a fixed depth, a flag the callee sets that forbids fanning back out, and a guard on the *specific* state that should fan out rather than merely "the earlier guard passed".

## Connections

**Connection listings hide shared connections by default, and that looks exactly like "the connection doesn't exist".** The default filter is the caller's own connections, so one another user owns and shared with the account simply does not appear. **Ask for shared explicitly on either path:** over MCP, `list_zapier_connections` with `include_shared: true` (it also reports `is_shared` per row); on the CLI, `--include-shared`, itself gated behind the top-level `--can-include-shared-connections` flag (or `ZAPIER_CAN_INCLUDE_SHARED_CONNECTIONS=true` / `canIncludeSharedConnections` in `.zapierrc`).

**A connection owned by another user and shared with the account CAN be bound and used by a durable** — verified on a QuickBooks connection with `use` + `test` permission only: dynamic field discovery resolved that org's own custom fields and a read-only `run-action` returned live records. So shared connections are not blocked in general — **but verify each one before building on it**, because per-user entitlement walls do exist. Cheapest check: read the action's input fields bound to that connection (dynamic fields only resolve on a working auth) — `inspect_zapier_actions` over MCP, `list-action-input-fields <app> <type> <action> --connection <id>` on the CLI — then one read-only probe.

## Action input fields

**An invalid dynamic-enum value returns an empty result, not an error.** A search with `search_field: "Id"` instead of the valid lowercase `"id"` returned zero rows and no error. When a search action mysteriously finds nothing, check the field's real choices before assuming the data is missing — `inspect_zapier_actions` with `enum_property` over MCP, `list-action-input-field-choices` on the CLI.

**`sdk.runAction` accepts an array ONLY where the field declares `value_type: ARRAY` with an `items` type.** Otherwise the field is scalar-only, and a classic Zap's line-item arrays cannot be ported. This is the single biggest porting trap found so far, and it kills a whole class of migration outright.

**A `fieldset` in `list-action-input-fields` output is only a display grouping, not a real input.** The SDK synthesises it in `transformNeedsToFields` from each field's `parent_key`, so a `line_items` fieldset key does **not** exist as an input — nesting an array of per-line objects under it is silently ignored, and you get a misleading "you must provide Line Items - Amount" from the top-level validator instead. Submit the flat child keys.

## Retry design

**"Retryable" is a claim about WHY something failed, and if the why is wrong the retry converts a readable error into an unreadable one.** A real case: a duplicate-document-number fault was classified retryable, reasoning that a collision means another run took the number between our read and our write — recompute and it clears. True for a race. False when the number is held by a record the query cannot see, so all three attempts recomputed the same doomed number and the record could never be written.

- **Exhausting a `ctx.step`'s attempts DESTROYS the vendor's message.** The step reports only `"Step … exhausted all retry attempts"`, so the run falls through to whatever branch handles transient failure and reports something like "could not reach the vendor, please try again in a minute" — while the vendor was answering normally and the retry could never succeed. A wrong retry flag does not just waste attempts; it actively misinforms whoever reads the record, and tells them to do the one thing that cannot work.
- **Absorb the race where it happens, and let genuine rejections fail fast.**
- **Make the retry provably terminate.** Recomputing "the next free value" can return the same value forever when the blocker is invisible to the computation. Step explicitly past the value just tried when the recomputed one has not moved, rather than trusting the recomputation to advance.
- **Only retry an error that guarantees no write happened.** A retry on an ambiguous failure risks double-writing — a duplicate invoice, a duplicate order.

## Guard design

**A property helper that coerces absence to a value DISARMS every guard downstream of it, and the guard is where everyone looks.** A real case: an order was invoiced at 0.00 because the unit price was blank, and the numeric helper mapped a blank Notion number to `0`. By the time the missing-fields pre-flight ran, "no price" and "priced at zero" were the same value. The pre-flight was not missing a check so much as *unable to have one*. Reviewing the guard finds nothing wrong with the guard. **The fix is a second helper that preserves absence, not a rewritten guard.**

**A vendor's uniqueness constraint may span record types you are not querying — check the constraint's real scope before deriving a value from a `MAX()`.** QuickBooks enforces `DocNumber` uniqueness *across* transaction types, so `SELECT MAX(DocNumber) FROM Invoice` returned a number already held by a credit memo. The error names the culprit — read it rather than assuming the sequence is yours. Do not over-correct to "query every record type" either; find the constraint's actual scope.

**A hardcoded constant carried over from a classic Zap port is unreviewed by default — treat every literal in a ported payload as an unverified assumption.** A real case: a `delivery_method_type: "PICKUP"` literal carried over from a classic Sub-Zap survived three published versions, so every sales order was flagged as a warehouse collection and the vendor silently substituted the warehouse address for the customer's. The address fields were mapped correctly the whole time — which is exactly why nobody found it by reading the mapping code.
