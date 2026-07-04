/**
 * pi-tool-search — hide all tools behind a manifest-aware tool_search.
 *
 * The LLM sees a single tool whose description embeds a compact name+one-liner
 * manifest of every available tool. It calls tool_search with the names it
 * needs; those tools become active for the rest of the session.
 *
 * Design:
 *  - session_start       → snapshot all tools, seed unlocked set with core tools
 *  - turn_start          → rebuild manifest before every LLM call, re-register tool_search, setActiveTools
 *  - tool_search.execute → validate names, add to unlocked set, setActiveTools, return terminate:true to
 *                           end the current run (tool schemas are frozen per run), then schedule a fresh
 *                           turn once idle so the enabled tools are actually in the next request's schema
 *
 * User config (settings.json):
 *  "toolSearch": { "alwaysEnabled": ["lsp", "grep"], "showToolSearchFooterStatus": true }
 *  Set "showToolSearchFooterStatus": false to hide the tool-search footer status line.
 */

import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "fs";
import { join } from "path";

const CORE_TOOLS = ["read", "write", "edit", "bash", "grep", "find"];

interface UserConfig {
  alwaysEnabled: string[];
  showToolSearchFooterStatus: boolean;
}

function readUserConfig(): UserConfig {
  try {
    const raw = readFileSync(join(getAgentDir(), "settings.json"), "utf-8");
    const s = JSON.parse(raw)?.toolSearch ?? {};
    return {
      alwaysEnabled: Array.isArray(s.alwaysEnabled)
        ? s.alwaysEnabled.filter((n: unknown): n is string => typeof n === "string")
        : [],
      showToolSearchFooterStatus: s.showToolSearchFooterStatus !== false && s.showFooterStatus !== false && s.showStatus !== false,
    };
  } catch {}
  return { alwaysEnabled: [], showToolSearchFooterStatus: true };
}

export default function toolSearchExtension(pi: ExtensionAPI) {
  // Compact snapshot: name + first-sentence description (≤80 chars)
  let manifest: { name: string; blurb: string }[] = [];

  // Names enabled so far this session (persists across turns)
  const unlocked = new Set<string>();

  let showToolSearchFooterStatus = true;

  // ── helpers ────────────────────────────────────────────────────────────────

  function buildManifest() {
    manifest = pi.getAllTools()
      .filter(t => t.name !== "tool_search")
      .map(t => ({
        name: t.name,
        blurb: (t.description ?? "").split(/[.\n]/)[0].trim().slice(0, 80),
      }));
  }

  function buildDescription(): string {
    const active = manifest.filter(t => unlocked.has(t.name));
    const hidden = manifest.filter(t => !unlocked.has(t.name));

    const activeLines = active
      .map(t => `  ${t.name}: ${t.blurb}`)
      .join("\n");
    const hiddenLines = hidden
      .map(t => `  ${t.name}: ${t.blurb}`)
      .join("\n");

    const parts: string[] = [];

    parts.push(`Enable tools by name before calling them. All tools below are hidden until you enable them here.

IMPORTANT: Call tool_search ALONE — never batch it with other tool calls. Enabling a tool ENDS the current turn automatically; the turn then continues by itself and the newly-enabled tools become directly callable. You do not need to do anything between enabling and using a tool. Never call tool_search for a tool that is already active.`);

    if (active.length) {
      parts.push(`Already active (do NOT call tool_search for these):\n${activeLines}`);
    }

    if (hidden.length) {
      parts.push(`Available tools (hidden — enable via tool_search):\n${hiddenLines}`);
    }

    parts.push(`Pass one or more exact tool names. After enabling, the turn ends automatically and the tools become callable in the next turn.`);

    return parts.join("\n\n");
  }

  function refreshActiveTools(ctx?: { ui: { setStatus(id: string, content: string | undefined): void } }) {
    showToolSearchFooterStatus = readUserConfig().showToolSearchFooterStatus;

    buildManifest();
    registerToolSearch();
    pi.setActiveTools(["tool_search", ...unlocked]);

    if (!ctx) return;

    if (showToolSearchFooterStatus) {
      ctx.ui.setStatus("tool-search", `${unlocked.size} / ${manifest.length + 1} tools`);
    } else {
      ctx.ui.setStatus("tool-search", undefined);
    }
  }

  // Tool schemas are frozen for the duration of one agent run: createContextSnapshot
  // in pi-agent-core takes state.tools.slice() once per run, and setActiveToolsByName
  // reassigns state.tools to a new array — so a tool enabled mid-run is invisible to
  // BOTH the provider request schema AND the dispatch lookup until a FRESH run starts.
  // That mismatch is what caused the tool_search infinite loop (the model could only
  // reach for the new tool via tool_search, getting "Already active" forever).
  //
  // Fix: tool_search returns terminate:true to end the stale run immediately, then
  // this helper schedules a fresh turn once the agent is idle. sendMessage with
  // triggerTurn while idle calls agent.prompt(), which takes a new snapshot that
  // finally includes the enabled tools — so the model can call them directly.
  function scheduleResume(ctx: { isIdle(): boolean }, content: string) {
    let tries = 0;
    const tick = () => {
      try {
        if (ctx.isIdle()) {
          pi.sendMessage(
            { customType: "tool-search-resume", content, display: false },
            { triggerTurn: true },
          );
          return;
        }
      } catch {
        return; // session torn down — give up silently
      }
      if (tries++ < 100) setTimeout(tick, 20); // ~2s ceiling
    };
    // Fire after the current (terminating) run unwinds and flips isStreaming=false.
    setTimeout(tick, 0);
  }

  function registerToolSearch() {
    pi.registerTool({
      name: "tool_search",
      label: "Tool Search",
      description: buildDescription(),
      promptSnippet: "Enable hidden tools by name. Call tool_search ALONE — it ends the turn and the tools become callable in the next turn automatically. Never re-enable already-active tools.",
      parameters: Type.Object({
        names: Type.Array(Type.String(), {
          description:
            "Exact tool names to enable (from the list in this tool's description)",
        }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const allNames = new Set(manifest.map(t => t.name));
        const valid: string[] = [];
        const invalid: string[] = [];
        const already: string[] = [];

        for (const n of params.names) {
          if (!allNames.has(n)) {
            invalid.push(n);
          } else if (unlocked.has(n)) {
            already.push(n);
          } else {
            valid.push(n);
          }
        }

        valid.forEach(n => unlocked.add(n));
        refreshActiveTools();

        // Build a directive for the FRESH turn that follows. (Within the current
        // run, tool schemas are frozen, so we must end the run and resume.)
        const resumeParts: string[] = [];
        if (valid.length) {
          resumeParts.push(
            `tool_search enabled: ${valid.join(", ")}. They are now ACTIVE and directly callable in this turn. Call the one you need directly — do NOT call tool_search for them again.`,
          );
        }
        if (already.length) {
          resumeParts.push(
            `Already active and directly callable now: ${already.join(", ")}. Call them directly — do NOT call tool_search for them again.`,
          );
        }
        if (invalid.length) {
          resumeParts.push(`Unknown tool names ignored: ${invalid.join(", ")}. Re-check the list in tool_search's description.`);
        }
        if (!valid.length && !already.length) {
          resumeParts.push("Continue your original task using the already-active tools.");
        }

        // Returning terminate:true ends this run immediately, which breaks any
        // tool_search re-call loop. scheduleResume waits for the run to go idle,
        // then starts a fresh turn whose snapshot includes the enabled tools.
        scheduleResume(ctx, resumeParts.join("\n\n"));

        const parts: string[] = [];
        if (valid.length) parts.push(`Enabled: ${valid.join(", ")}.`);
        if (already.length) parts.push(`Already active: ${already.join(", ")}.`);
        if (invalid.length) parts.push(`Unknown (ignored): ${invalid.join(", ")}.`);
        parts.push(
          "Ending this turn so the tool(s) become available; continuing automatically next turn. Call the tool you need directly — do not call tool_search again for already-active tools.",
        );

        return {
          content: [{ type: "text", text: parts.join("\n") }],
          details: { enabled: valid, alreadyActive: already, unknown: invalid, active: [...unlocked] },
          terminate: true,
        };
      },
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    unlocked.clear();

    const config = readUserConfig();
    showToolSearchFooterStatus = config.showToolSearchFooterStatus;
    for (const name of [...CORE_TOOLS, ...config.alwaysEnabled]) unlocked.add(name);

    refreshActiveTools(ctx);

    ctx.ui.notify(
      `pi-tool-search: ${manifest.length} tools hidden behind tool_search`,
      "info",
    );
  });

  pi.on("turn_start", (_event, ctx) => {
    // Re-snapshot before every LLM call, not only fresh user prompts.
    // This keeps unlocked tools active for agent-loop continuations too.
    refreshActiveTools(ctx);
  });

}
