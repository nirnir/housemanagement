#!/usr/bin/env node
// Prodeology Coding Companion protocol v4 — advisory bridge + deep-tier hooks.
// Installed by the Prodeology Session Kit. Configured by the repo owner.
// Adds grounded recommendations when available; never answers for the user.
import fs from "node:fs";

const SERVER_URL = "https://www.prodeology.com";
const input = JSON.parse(fs.readFileSync(0, "utf8"));

// Best-effort server round-trip. The server owns semantic classification,
// persisted gate truth, exact session binding, and live policy. Any failure
// fails open: this hook never guesses from punctuation or assistant prose.
async function hookEvent(event, payload = {}) {
  const key = process.env.PRODEOLOGY_COMPANION_KEY;
  if (!key) return null;
  try {
    const res = await fetch(SERVER_URL + "/api/companion/hook-event", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({
        event,
        claudeSessionId: input.session_id || undefined,
        ...payload,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

if (input.hook_event_name === "SessionStart") {
  await hookEvent("session_start");
  process.exit(0);
}

// ── PreToolUse: structured question enrichment ──
if (input.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion") {
  const result = await hookEvent("ask_user_question", {
    toolInput: input.tool_input,
  });
  if (result?.action === "update_input" && result.updatedInput) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: result.updatedInput,
        },
      })
    );
  }
  process.exit(0);
}

process.exit(0);

