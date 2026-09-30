Summarise this Azure DevOps activity into short standup bullet points. Everything below is work I did myself, so write it from my point of view.

Group by what makes sense: tickets opened, closed, moved between states, and any info chased via comments.

Rules:
- Each bullet is one short line of plain text.
- Be concise, because this is read out loud in a standup.
- Only mention work that appears in the activity below.
- I've already written some lines myself, listed under "Already written". Leave out anything they already cover, even if worded differently. If they cover everything, return an empty list.

Respond with ONLY valid JSON (no markdown):
{
  "bullets": ["first bullet", "second bullet"]
}

Already written:

{{EXISTING}}

Activity:

{{ACTIVITY}}
