Prodeology Coding Companion protocol v4

Link this coding session to the Prodeology Live Coding Companion.

Spec argument (optional): $ARGUMENTS

Steps:

1. Read the spec document's "Live Coding Companion" protocol header. Copy
   its `spec_key`, `spec_export_id`, `spec_version`, and optional
   `spec_fingerprint` exactly. If the document has only `spec_key`, use it
   as a documented legacy fallback. An argument above may supply that fallback.
2. Call the `ask` tool on the `prodeology` MCP server with the exact tuple
   and the question: "Session start — confirm this session is linked to the
   spec, and tell me anything I should know before I begin."
3. Call `get_context` with the same exact tuple to pull the full validated spec, and
   treat it as the authoritative task description.
4. For the rest of the session, follow the companion protocol: route product
   and spec clarifications through `ask`. If it returns
   `guidance_advisory` or `companion_unavailable`, continue with your normal
   coding-agent judgment. Ask the user here only when you would normally need
   their authority, and call `resolve_decision` if a decision ID was supplied.
   Never wait on or send the user to Prodeology. Post milestones via `log_progress`, and
   when you believe the work is complete call `report_completion`. Apply
   useful feedback when available; if the call fails or times out, finish your
   normal verification and handoff without retrying in a loop.
