---
subject: AI Is Writing Faster Than We Can Read
source: em_32ng61zqng88na5dmfxe0nhf90
---
<!-- buttondown-editor-mode: fancy -->![](https://assets.buttondown.email/images/9dc97e36-90f6-46d1-94a9-23e7e459d299.png)

*The last of the earlier pieces, from October 2026, and the newest. It's less of a how-to than the others: AI now produces good work faster than people can read it, and I don't think anyone has solved that yet.*

---

In August 2026, OpenAI announced that a then-unreleased model called Astra had produced solutions to ten long-standing mathematics problems, some of which had stumped researchers for decades. Robert Hart's [piece in The Verge](https://www.theverge.com/ai-artificial-intelligence/1008726/openai-mathematics-solutions-chaos) on how mathematicians are taking it is worth reading in full, but the bit that resonated most for me was how AI is now generating more content, often of very high quality, than any human can process. 

OpenAI released more than 250 pages of papers setting out the solutions, plus another 60 pages explaining how the ideas came together. Many of the mathematicians Hart spoke to said they couldn't personally evaluate some, or any, of the solutions. The field has become so specialised that few people are equipped to check work spanning that many areas.

The general consensus is that the results are real. Nobody is accusing the model of making things up. The problem is that a small group of the world's best mathematicians can't comfortably read what it produced.

---

## A different kind of AI problem

For the last couple of years, complaints about AI output have mostly been about quality: first it was confidently inventing “facts”, and more recently the generic filler people now call AI workslop. In my experience, both have become much rarer as the models have gotten smarter at a rapid clip. I find the outputs now are usually correct.

The problem I see now is output that is good, but so voluminous and so tightly interlinked that a lowly human can't get their head around it in any reasonable amount of time.

Mathematics is an extreme case, but I hit a small-scale version of this recently on a client project.

---

## A smaller example from a client project

I was picking up an internal project partway through. Over the preceding weeks, the team and the Claude instances working alongside them had produced a sprawl of Jira tickets, Confluence pages, Claude Docs and local markdown files, all cross-referencing each other.

It was all well-written and thought through. But I couldn't get a quick sense of what was going on without throwing my own Claude at it, and even my Claude struggled, because every answer depended on another source it then had to go and find. I asked it why one ticket was so hard to follow. Here is what it told me:

> The hierarchy isn't extreme; the problem is that no single ticket can be understood on its own.
>
> What I had to do to understand PROJ-116:
>
> - PROJ-116 describes the data but says "follow the rules in the parent story" instead of stating them.
> - PROJ-115, its parent, holds the rules, the goal, the deadline and the sibling tasks. It points to PROJ-69 decision 8 for the reasoning and to PROJ-70 and PROJ-67 for what depends on it.
> - PROJ-60, the epic above that, I haven't read at all.
> - PROJ-97, this spike, lives in a separate branch of the tree, and its brief is spread across your prompt, a [claude.ai](http://claude.ai) working doc and a ticket comment.
>
> That makes three levels of nesting plus four referenced tickets and a doc. I still haven't read PROJ-69, PROJ-70 or PROJ-67. My caveat in the last answer, "decision 8 might explain this", exists only because the reasoning is in a different ticket.
>
> Why it's costly:
>
> - Subtasks are too thin to act on. PROJ-117 and PROJ-118 are about three sentences each and depend on their parent for the rules. Anyone who picks one up, human or agent, has to walk up the tree first.
> - Reasoning is referenced instead of stated. "Background: PROJ-69 decision 8" tells you where the reason is, not what it is.
> - It's hard for agents. Each hop is another tool call, and it's easy to stop one level too early. I almost did: PROJ-116 showed no sub-issues, and only then did I go up to find the siblings.

![](https://assets.buttondown.email/images/29bd437f-ea57-4358-8aa2-37d16b1029bd.png)

It's worth understanding how the material ended up like this. The Claude that wrote it had everything in its context window, or in its local memory store. To that Claude, "see PROJ-69 decision 8" made perfect sense, because it already knew what decision 8 said. Cross-referencing instead of restating was the efficient, token-minimising choice for the writer. Once a second human enters the picture, though, this starts to break down.

Of course, the obvious solution to "there's too much to read" these days is to have an AI read it for you and give you the TL;DR. That does work, up to a point. But first, that agent burns through tokens for each tool call it has to make to crawl the relevant context, which translates to time and money. Second, and more importantly, the more we have to lean on AI to process all this content for us, the more tenuous our grasp of what’s actually happening becomes.

---

## What helps

I think this is still largely an unsolved problem because it’s a new one (I don’t think this was really an issue until early 2026), and we’re all just trying to keep our heads above water as AI continues to transform the way we work.

But I think some of it can be mitigated by being thoughtful in how you instruct the agents producing the material. A few things I've resolved to start doing:

- **State the rule and the reason in place.** If a subtask depends on a decision made in another ticket or doc, write the decision into the subtask in a sentence and link out to the source for anyone who wants the background. For the agent doing the writing, this might feel like a waste of tokens, but at the organisational level, it will pay off if someone else needs to pick up the work later. 
- **Make every unit readable cold.** A useful acceptance test for a ticket or doc: could a person, or an agent, with none of the surrounding context act on this alone? If not, it isn't finished.
- **Keep one current-state page for every project.** Somewhere there should be a single page that says what is going on right now, in plain language, and it should be updated at the end of every working session. Basically like a README if you’re working in a code repository, or some equivalent if you’re doing other kinds of knowledge work.

None of this is new advice for human-written documentation. It just used to be enforced naturally by how tedious writing was. Nobody wrote 250 pages, or a ticket tree that deep, unless they had to.

---

## Volume is now the constraint

Mathematicians are at least asking the right question: how is anyone supposed to understand and build on work that’s churned out faster than people can read it? And this problem is coming in hot for any teams using agents extensively at work.

Maybe Opus 6 or GPT Sol-6.5 or whatever comes out in a few months will solve this. But until then, I think the best we can do is ask our agents to chill out a bit and write stuff in a way that doesn’t assume their audience already knows everything they do.

---

That's the end of the welcome series. From here you'll get new issues as I publish them.

One question before you go: have you hit this yet, where the AI's output is fine but there's too much of it to follow? Hit reply and tell me how your team is dealing with it. Replies come straight to me.

Dennis
