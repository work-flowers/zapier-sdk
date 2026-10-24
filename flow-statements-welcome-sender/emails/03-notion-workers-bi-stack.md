---
subject: Why Notion Workers + Dashboards are my New BI Stack
source: em_4tsdpj2bjq8xh9tmzma3tnr26m
---
<!-- buttondown-editor-mode: fancy -->![](https://assets.buttondown.email/images/7766db3d-a1da-4dd7-bdd7-7806463409fa.png)

*The second earlier piece, from May 2026, and the one I've updated most. It makes the case that many small teams can skip the data warehouse and do their reporting in Notion. I've refreshed the details on Notion Workers and their pricing, which have moved on since I first wrote it.*

---

Until recently, my default answer when a colleague or founder asked "how do we get visibility into our metrics?" was some variation of: ELT the data from all your SaaS tools into a cloud warehouse like BigQuery or Redshift, write a bunch of SQL, and then visualise it in Tableau. That was and still is an obvious upgrade from spreadsheets; ELT-as-a-service companies like Fivetran made it easier than ever to spin up a data warehouse, and I still think it's the right answer for a particular kind of company.

However, most of the startups and small businesses I work with are not that kind of company. And since Notion's [Make with Notion: Developer Platform](https://makewithnotion.com/) event in May 2026, I have a different default for them.

![Image](https://assets.buttondown.email/images/bedb4af1-0554-40fd-8380-63492c28b37f.png)



## The case I used to make

The benefits of a warehouse-plus-BI stack are obvious: you aggregate your data in one place, model it once, and then build dashboards that your team and stakeholders can trust. The data team owns the pipes, business users get self-serve answers, and nobody is copy-pasting CSVs at 2am before a big meeting.

I've helped clients and my former employees build just this setup. [Ordinary Folk's data stack](https://www.work.flowers/blog/ordinary-folk-data-stack?utm_source=newsletter&utm_medium=email&utm_campaign=welcome_sequence) is the kind of business that absolutely warranted a warehouse: multiple revenue and expense streams from disparate sources, a ton of complex financial and operational metrics to report on, and a complex data ecosystem with many internal databases as well as third-party SaaS tools like Stripe. For them, BigQuery and Tableau Pulse made sense, because you can only combine data from so many different sources with a proper data warehouse. 

But the cost of that stack can be significant, both financially and measured in time/effort:

- Managed ELT tools like Fivetran have generous free tiers, but the costs can grow quickly in line with data volumes
- BigQuery itself is usually the cheap part for small data sets, but query costs increase as the pipeline grows more complex with intermediate staging tables and multiple dashboards refresh frequently
- Tableau Cloud is $75/user/month for Creator and $15/user/month for Viewer. This kind of cost causes organisations to make hard choices and limit access, thereby stripping many team members of the data they need to do their jobs more effectively
- And then, of course, there’s the build and maintenance cost: setting up and maintaining all this requires specific expertise, and if you have folks in-house with those kinds of technical skills, you probably want them applied to building your product rather than internal reporting

For a Series B SaaS company with five revenue streams and a finance team, that's manageable. For a five-person startup, maybe not so much.

## What changed

At that event, Notion introduced [Notion Workers](https://developers.notion.com/workers/get-started/overview): TypeScript programs that run inside Notion's own sandboxes.

There are a myriad of things you can build with Workers, but the relevant one for this post is the Sync worker: a small program that pulls data from any API on a schedule and writes it into a Notion database.

A few details:

- Workers are priced on how much work each run does, not on tokens or rows. Notion's own estimate is about $0.0023 per typical run, so a nightly sync that hits a handful of endpoints costs cents per month.
- Notion handles OAuth, rate limiting, scheduling, backfills, and deduplication. You (or, more precisely, your coding agent) write the fetch-and-map logic; the platform handles the boring reliability work.
- The data lands in a Notion database, which means it's queryable via filters, charts, and views just like any other database, and Notion AI can reason over it.
- Workers are available on Business and Enterprise plans and, as of October 2026, still in beta and free to use. Notion says they will eventually draw on Notion credits ($10 per 1,000), which works out to roughly 4,300 typical runs per $10. The [Workers pricing page](https://www.notion.com/help/understand-pricing-for-workers) has the current position.

Building and deploying Notion Workers in code might sound intimidating if you're not a developer, but it is much less so now. The rise of coding agents like Claude Code and Codex means you don't have to understand or even read every line that gets written. As long as you can articulate how you want the sync to work, and then give your coding agent feedback on what's actually showing up in Notion, that's usually enough to get a sync worker up and running.

![Image](https://assets.buttondown.email/images/5c68ce18-f777-4362-aaf0-8a550fe68318.png)

## Dashboards make the data legible

Workers are only half the picture. In March 2026, Notion shipped [**Dashboard views**](https://www.notion.com/help/dashboards): a dedicated page layout designed for composing chart blocks, key metric callouts, and database tables into something that actually reads as a reporting surface. Before Dashboards, visualising data inside Notion meant dropping a chart block above a database and hoping the spacing held up. Now you get a purpose-built layout with chart types, comparisons, and trend indicators that hold their own against the BI tools they're replacing.

I don’t know if Notion planned it this way, but Workers and Dashboards feel like they’re designed for each other. Workers pull the data on a schedule; Dashboards turn it into something you'd happily show an investor, your boss, or a client. 

- A finance dashboard with revenue, expenses, and runway can sit on the same page as your monthly review, refreshed every few hours by a worker reading Stripe and Xero.
- A marketing Dashboard with sessions, signups, and source mix updates without anyone opening Google Analytics.

The metric block, in particular, is quietly the most useful primitive: a single number with a comparison period and a sparkline, which is 80% of what executives actually look at in Tableau anyway.

![Image](https://assets.buttondown.email/images/f1132313-6708-4797-9509-3cec7e4708e4.png)

## The new default stack

Going forward, my default recommended BI stack for most small and early-stage teams looks like this:

1. **Sync Workers** pull data from the systems you care about: Stripe, Harvest, HubSpot or Attio, Google Analytics, your email tool, your support tool.
1. **Notion databases** hold the raw data. One database per source, schemas tuned for the views you'll build.
1. **Notion Dashboards** sit on top: a finance Dashboard, a marketing Dashboard, a delivery Dashboard. Each one is a single page composing chart blocks, key metric callouts, and the underlying database views, all linked from your team home.
1. **Notion AI** handles the questions the dashboards don't answer directly: "summarise this month's time entries by client", "what's our trailing 90-day site traffic", "which newsletter issue drove the most signups".

So far I've built sync workers for:

- **Harvest** time entries, feeding an Hours-by-Client rollup we use for capacity planning
- **Google Analytics** sessions, sources, and goal completions, for a marketing-funnel dashboard
- **Buttondown** newsletter analytics (opens, clicks, growth), so we can stop opening Buttondown to see if a piece landed
- **Xero** sales invoices, which I link to our Notion CRM so we can quickly see the invoices by status from any Client record

Once you get the hang of it, you can spin these up quite quickly.

## Where Notion charts still fall short

I'm not going to pretend this is Tableau. It isn't, and you should know what you're trading and whether you still need something more conventional and robust. 

- **No semantic layer.** There's no dbt-equivalent inside Notion. If you need shared metric definitions across many dashboards and many people, this isn't it.
- **Limited chart types and styling.** Bar, line, donut, area, table, and a handful of aggregations. Pulse-style narrative summaries, and custom visual encodings are not on offer (at least not yet).
- **Cross-source joins are basic.** Notion relations work well for linking pages, but if your dashboard needs a five-table join with windowed aggregations, you want SQL and a warehouse.
- **Refresh granularity is per-worker.** Real-time streaming dashboards aren't the use case. If you need anything closer than every 15 minutes, look elsewhere.

If any of those are dealbreakers, keep the warehouse-plus-BI stack. Notion's charts aren't universally better than Tableau. The bar for "good enough" is just much lower than the industry default would have you believe, and most small teams sit well below it.

## Where it's actually better

For the teams I work with, the trade-offs go the other way:

- **The dashboards live next to the work.** When your MRR chart sits two clicks away from the CRM record of the deal that closed last week, the chart stops being something you check in a separate tool. It's just part of the workspace.
- **One tool, one bill.** You probably already pay for Notion. Adding Workers usage is small. Killing the warehouse-plus-BI line items frees up budget for things that matter more at this stage.
- **The maintenance cost is tiny.** A worker is a few hundred lines of TypeScript that you can version, test, and deploy. There's no Airflow, no dbt project, no schema registry, no separate identity provider.
- **AI works on the same surface.** Notion AI and Custom Agents can read the database directly. The same dashboard that powers your weekly review can answer ad-hoc questions in chat.

I learned the value of the first point the hard way during my time at Twitter. My team and I would spend months building sophisticated Tableau dashboards for the leadership team, and the execs who were the primary audience almost never opened them. Instead, every week found us screenshotting the charts onto slides because the execs simply weren't used to logging into and navigating Tableau. The dashboards were technically excellent and went largely unread. 

If you want a metric to actually inform decisions, putting it where your team already spends its day has tremendous value you shouldn’t overlook.

## What I'd do this week

If you're already on a Notion Business or Enterprise plan:

1. Pick one metric that matters and lives in another tool.
1. Spend an afternoon writing a sync worker for it.
1. Build a Notion database with the right schema, point the worker at it, and add a chart on a Metrics page.
1. See if anyone on the team actually uses it before building more.

If they do, the second source takes half as long, and the third half again. Six weeks in, you've replaced the part of the modern data stack you were going to build, for roughly the cost of a single Tableau seat.

If you'd like a second pair of eyes on whether this is the right stack for your team, [book a discovery call](https://www.work.flowers/meet-dennis?utm_source=newsletter&utm_medium=email&utm_campaign=welcome_sequence) and we can talk it through.

If you're not on Notion yet, you can [start a free trial here](https://www.work.flowers/notion-builders). *(Referral link; we earn a small commission if you sign up.)*



[Read in your browser](https://www.work.flowers/blog/notion-workers-startup-dashboards?utm_source=newsletter&utm_medium=email&utm_campaign=welcome_sequence)
