---
subject: How Knoxx Foods Built the Operational Foundations for AI
source: em_6kppy625nv8cp8nzan86h4fyq2
---
<!-- buttondown-editor-mode: fancy -->![](https://assets.buttondown.email/images/37179cad-5714-4abc-84d0-6b291c249a92.png)

*The third earlier piece, from July 2026, is a client case study. Knoxx Foods, a Sydney food ingredients importer, is a good example of why the plumbing has to come before the AI.*

---

Useful AI inside a company depends less on which model you pick and more on whether the operational data underneath is structured, connected, and trustworthy. Most companies aren't there. Getting them there is mostly plumbing work: connecting systems, consolidating data, and building a single source of truth. Our work with Knoxx Foods is a case study in exactly that.

[Knoxx Foods](https://www.knoxxfoods.com/) is a Sydney-based B2B importer and supplier of premium bulk food ingredients, supplying processed tomatoes, rice, dehydrated vegetables, coconut products, and more to food processors, ready-meal manufacturers, and foodservice distributors across Australia and New Zealand. Knoxx was already further along than most when we came in: a data warehouse, dashboards for reporting, and Custom GPTs deployed against specific operational tasks. What had grown faster than everything else was the operational layer underneath. Orders, warehouse logistics, customer relationships, and accounting each lived in separate systems with no connections between them, and a lean team was spending hours each week manually copying data between platforms just to keep the lights on.

Below are two of our favourite pieces from the work. The full case study, covering business presentations on autopilot, proof of delivery verified by AI, and the consolidation of Knoxx's operations into a single Notion hub, is on the blog:

[**Read the full case study**](https://www.work.flowers/blog/knoxx-foods-ai-foundations?utm_source=newsletter&utm_medium=email&utm_campaign=welcome_sequence)

---

## No API? No problem.

Knoxx's order management platform had no API at all. No export function, webhooks, or documented way to programmatically access the data. For most consultancies, this would be a dead end. We approached it as a fun challenge worth tackling. We built a custom bridge to extract and sync order data reliably through a system that, on paper, had no programmatic interface at all.

That platform was also an example of a common pattern we see: the price on the invoice is rarely a tool's full cost. Over time it became clear the system was full of features the team didn't really need, and the way it worked didn't match how Knoxx's customers actually preferred to do business. So it has now been fully replaced by a custom system built natively in Notion, living alongside the rest of Knoxx's operational data. Besides removing a technical headache, this migration took a significant annual platform cost off the table.

---

## Orders that create themselves

Here's what that foundation makes possible. With orders, products, customers, and pricing all modelled cleanly in one place, we could finally put an agent on top of the data, and the first one we built tackles the most repetitive job in the business: order entry.

A Notion Custom Agent now watches the orders inbox. When a customer emails an order, exactly as they always have, the agent reads the message and creates the order directly in Notion. If anything is ambiguous, it doesn't guess; it flags a person. Customers changed nothing. The data entry just stopped being someone's job.

![](https://assets.buttondown.email/images/63c51731-66ed-4427-863f-bcc31a2787bb.png)

Once the agent creates an order and it's ready for processing, Zapier workflows take over: the downstream fulfilment, invoicing, and record-keeping follow automatically. Agents are applied where judgement matters, deterministic automation where it just needs to run.

---

## What made the partnership work

Read this as a story about a team that was already thinking the right way; the tooling is secondary.

> "*AI is not an accessory. It must become part of how you think, work and decide every day. At Knoxx, we are going all-in, investing heavily in AI adoption, AI-based devices, software, and automation. This is not a trial run; this is readiness for the future.*"
> Ajay Pal Singh, CEO, Knoxx Foods ([LinkedIn, January 2026](https://www.linkedin.com/posts/ajay-pal-singh-2497b434_ai-is-no-longer-a-choice-those-who-refuse-activity-7421720122437873664-1xGH))

Knoxx's leadership came to every conversation with their own ideas about where automation and AI could help. When we recommended something, decisions came back fast. When something didn't work the first time, they were curious about why rather than nervous about the cost. A lot of what's in this case study wouldn't have been possible without leadership that was genuinely leaning into the work.

There's plenty more in the full write-up, including presentation decks generated in one click, AI-verified proof of delivery, and why tool sprawl costs several multiples of the SaaS invoice:

[**Read the full case study**](https://www.work.flowers/blog/knoxx-foods-ai-foundations?utm_source=newsletter&utm_medium=email&utm_campaign=welcome_sequence)

*If your operations feel like they're held together by spreadsheets and good intentions, *[let's talk](https://www.work.flowers/meet-dennis?utm_source=newsletter&utm_medium=email&utm_campaign=welcome_sequence).
