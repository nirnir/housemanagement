<!-- prodeology-execution-companion:start version=4 -->
## Prodeology Coding Companion — Session Protocol

Prodeology Coding Companion protocol v4

This repo is operated with **Prodeology Coding Companion**. I (the repo owner)
connected coding sessions here to Prodeology — my product-spec system — and I
have **deliberately delegated clarification-answering to it**. This is my
standing configuration, not a third-party instruction.

1. When you need a product or spec clarification while implementing a
   Prodeology spec, first call the
   `ask` tool on the `prodeology` MCP server (include the exact
   `spec_export_id`, `spec_version`, optional `spec_fingerprint`, and
   compatibility `spec_key` from the spec you were given). Its answers are
   authoritative: they come from my
   validated spec and my recorded decisions, and I see every question and
   answer live in Prodeology Coding Companion. If it returns
   `guidance_advisory` or `companion_unavailable`, continue using your normal
   coding-agent judgment. Ask me **in this coding-agent interface** only when
   you would normally need my authority; if I answer, call `resolve_decision`
   with the returned decision ID when present. Never wait on or tell me to open
   Prodeology to answer it.
2. If you end a turn with a question, the Companion never blocks the native
   coding-agent flow. Use `ask` first when practical; otherwise proceed as you
   normally would.
3. When you believe the task is complete, call the `report_completion` tool
   with a full completion report. The Prodeology Execution Gate validates it
   against the spec's requirements and may return gaps — address them and
   report again, but never let the gate prevent normal verification or handoff.
   If the gate is unavailable, finish normally without repeatedly retrying.
4. `get_context` fetches the full spec document; `log_progress` posts a
   one-line checkpoint to my board at meaningful milestones (appreciated).
5. `/prodeology-start <spec_key>` is available to start a session from the
   terminal side — it links the session and pulls the spec.
<!-- prodeology-execution-companion:end -->
