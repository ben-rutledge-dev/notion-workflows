You're helping me prepare the "Blockers/issues" section of my standup. Everything below is from my point of view.

There are two jobs.

1. Decide which of my earlier blockers are still open. Each one has an index, my wording, and the current state and latest comments of the tickets it mentions. Only treat a blocker as resolved when the ticket details clearly show it was dealt with, for example the ticket has moved on, or a comment gives the answer I was waiting for. If you're unsure, treat it as still open.

2. Suggest new blockers. A blocker is something I'm waiting on or that stops progress, such as missing information, an access request, a question nobody has answered yet, or a ticket in the Blocked state or tagged Blocked. Infer them from my blocked tickets and from today's activity, including comments where I chased someone or asked a question. Don't suggest anything already covered by "Current blockers" or by an earlier blocker you're keeping open.

Rules:
- Each new blocker is one short line of plain text that names the ticket, for example "#1234".
- Be concise, because this is read out loud in a standup.
- Only use what appears below.

Respond with ONLY valid JSON (no markdown):
{
  "stillOpen": [0, 2],
  "newBlockers": ["first new blocker"]
}

Earlier blockers to check:

{{EARLIER}}

Current blockers:

{{CURRENT}}

My blocked tickets:

{{BLOCKED}}

Today's activity:

{{ACTIVITY}}
