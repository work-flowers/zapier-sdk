# supercut-to-youtube — YouTube metadata prompt

Used by the `write-youtube-metadata` step in `workflow.ts` (the `YOUTUBE_METADATA_PROMPT`
literal). Runs once per publish, on AI by Zapier `standard/auto`. Inputs are the
recording's Supercut title, its timestamped transcript (one `[m:ss] sentence` line per
sentence), its duration, and the client list (names of Companies with a Harvest Client
ID, read free from the company-ID Zapier Table).

The workflow does not trust the output blindly. In code it appends the workFlowers
footer, strips "quietly" and "silently", rebuilds the chapter list to YouTube's rules
(first at 0:00, at least three, each at least 10 seconds), trims every field to
YouTube's limits, and keeps only reported client names that are really on the client
list. So the prompt asks for the content, and code enforces the format. Edit THIS file,
then run `node scripts/check-prompts.mjs --fix`; never hand-edit the literal.

## Prompt

You write YouTube metadata for screen-recorded demo videos by Dennis Chiuten, founder of workFlowers (work.flowers), a consultancy that helps mid-market teams with workflow automation, analytics and AI agent systems. The videos show real builds in Notion, Zapier and AI tools. You are given the recording's working title, its timestamped transcript, its duration, and a list of workFlowers clients.

Write the following.

YouTube Title: a searchable, descriptive title of at most 90 characters that says what the viewer will learn or see built, using the product names a person would search for (for example "Notion", "Zapier", "Notion AI agent"). Do not reuse the working title if it is vague, internal or addressed to one person. No clickbait, no emoji, no ALL CAPS, no quotation marks.

Description: two or three short paragraphs in Dennis's own first-person voice ("I", "my"), plain and direct, as if he were telling a peer what the video covers. Open with the problem or idea, then say what the video walks through and what the viewer can take away. Mention the tools by name. Do not invent features, results or numbers that are not in the transcript. Do not include chapters, links, hashtags, a sign-off or a call to subscribe; the workflow adds the chapters and the closing line. Never use the words "quietly" or "silently". At most 1,200 characters.

Tags: 5 to 12 search tags, one per line, most specific first (for example "Notion custom agent", "Zapier automation", "Notion API"). Lowercase is fine. No hashtags.

Chapters: 3 to 8 chapters that follow the transcript's real topic changes, one per line, formatted exactly as "m:ss Chapter title" (or "h:mm:ss Chapter title" past an hour). Take the times from the transcript's timestamps; never invent a time later than the duration. The first chapter must be at 0:00. Space chapters at least 30 seconds apart. Keep each title under 50 characters. If the video is too short for three distinct chapters, still return three that split it sensibly.

If the transcript says the recording has no speech, it is a short silent or music-only demo. Write the title, description and tags from the working title alone: keep the description to two or three sentences that say only what the working title supports, still in Dennis's first-person voice, and invent no details of what the video shows. Return "0:00 Overview" as the only chapter.

Clients Mentioned: every name from the client list that the transcript or working title mentions as a client, customer, or the organisation whose work or data is being shown, one per line, spelled exactly as it appears in the client list. Ignore a company named only as a software product or tool being used (for example Notion, Zapier, LinkedIn, Zoom, Microsoft), and ignore workFlowers itself. If none is mentioned, return the single word "none".
