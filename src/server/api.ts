/**
 * Chorus — cinematic dialogue engine
 * Copyright (C) 2026 Amias
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import express from "express";
import { logger } from "@/server/logger";
import { generateTurn, isGenerating } from "@/server/llm";
import { chatStreamSchema } from "@/server/validation";
import { Database } from "@/server/db";
import { queryWorld } from "@/server/llm/tools/queryWorld";
import { searchWorld } from "@/server/llm/tools/searchWorld";
import { manageNode } from "@/server/llm/tools/manageNode";
import { manageRelationship } from "@/server/llm/tools/manageRelationship";
import { editNote } from "@/server/llm/tools/editNote";
import { editPlot } from "@/server/llm/tools/editPlot";
import { manageSchema } from "@/server/llm/tools/manageSchema";
import { createGenerateDialogueStepTool } from "@/server/llm/tools/generateDialogueStep";
import { createManageSceneTool } from "@/server/llm/tools/manageScene";
import { toolToSpec } from "@/sdk/bridge";
import type { Message, DialogueOption } from "@/types/dialogue";
import { getContext } from "@/server/llm/tools/getContext";
import { seedDatabase } from "@/server/stories/seed";
import { DeepSeekError } from "@/sdk";
import { buildSystemPrompt } from "@/server/llm/prompt";
import { validateToolsPreset, TOOLS_PRESETS, type ToolsPreset } from "@/shared/constants";

function resolvePresetFromQuery(reqQuery: any): ToolsPreset {
  const raw = typeof reqQuery?.preset === "string" ? reqQuery.preset : undefined;
  if (raw && (TOOLS_PRESETS as readonly string[]).includes(raw)) {
    return raw as ToolsPreset;
  }
  return validateToolsPreset(process.env.TOOLS_PRESET);
}

const debugToolRegistry: Record<string, { execute: (args: any) => Promise<string> }> = {
  queryWorld: queryWorld as any,
  searchWorld: searchWorld as any,
  manageNode: manageNode as any,
  manageRelationship: manageRelationship as any,
  manageSchema: manageSchema as any,
  editNote: editNote as any,
  editPlot: editPlot as any,
  getContext: getContext as any,
};

function mapUpstreamStatus(status: number): number {
  if (status === 0 || status === 429 || status === 500 || status === 503) return 503;
  if (status === 400 || status === 422) return 500;
  return status; // 401, 402 pass through (GM is the operator)
}

const apiRouter = express.Router();

// ── Chat (streaming SSE) ──

apiRouter.post("/chat/stream", async (req, res) => {
  const parsed = chatStreamSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  try {
    const { userInput, history, check } = parsed.data;
    logger.info(
      `[chat/stream] userInput="${String(userInput).slice(0, 80)}" historyLen=${history?.length ?? 0} hasCheck=${!!check}`,
    );
    await generateTurn(userInput, history ?? [], res, check as DialogueOption["check"] | undefined);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Chat stream error:", message);
    if (!res.headersSent) {
      const httpStatus = error instanceof DeepSeekError ? mapUpstreamStatus(error.status) : 500;
      res.status(httpStatus).json({ error: message });
    } else {
      res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      res.end();
    }
  }
});

// ── History ──

apiRouter.get("/history", async (_req, res) => {
  try {
    const db = Database.getExisting();
    const logEntries = await db.scene.getHistory();
    const history: Message[] = [];
    for (const entry of logEntries) {
      if (entry.type === "gm") {
        for (const c of entry.content) {
          history.push({
            id: `hist_${history.length}`,
            speaker: c.speaker,
            type: (c.type as Message["type"]) || "SYSTEM",
            text: c.text,
            metadata: c.metadata as Message["metadata"],
          });
        }
      } else if (entry.type === "player") {
        history.push({
          id: `hist_${history.length}`,
          speaker: "YOU",
          type: "YOU",
          text: entry.content,
        });
      } else if (entry.type === "roll") {
        history.push({
          id: `hist_${history.length}`,
          speaker: (entry.metadata?.speaker as string) || "SYSTEM",
          type: "ROLL",
          text: entry.content,
          rollResult: entry.metadata?.rollResult as Message["rollResult"],
        });
      }
    }
    res.json(history);
  } catch (error: unknown) {
    logger.error("History fetch error:", error);
    res.json([]);
  }
});

// ── Game state ──

apiRouter.get("/game/current", async (_req, res) => {
  try {
    const db = Database.getExisting();
    const active = await db.scene.getActive();
    if (active && active.options) {
      res.json({ id: active.name, options: active.options });
    } else {
      res.json(null);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Session state fetch error:", message);
    res.json(null);
  }
});

// ── Debug: dump all tool schemas ──

const allTools = [
  queryWorld,
  searchWorld,
  manageNode,
  manageRelationship,
  editNote,
  editPlot,
  manageSchema,
  getContext,
  createGenerateDialogueStepTool().tool,
  createManageSceneTool({} as any),
];

const presetTools: Record<ToolsPreset, string[]> = {
  full: [
    "queryWorld", "searchWorld", "manageNode", "manageRelationship",
    "editNote", "editPlot", "manageSchema", "getContext",
    "generateDialogueStep", "manageScene",
  ],
  story: ["editNote", "editPlot", "generateDialogueStep", "manageScene"],
  pure: ["generateDialogueStep"],
};

apiRouter.get("/debug/tools", async (req, res) => {
  const preset = resolvePresetFromQuery(req.query);
  const names = new Set(presetTools[preset]);
  const specs = allTools
    .filter((t) => names.has((t as any)?.name ?? ""))
    .map((t) => {
      try {
        return toolToSpec(t as any);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { error: `Failed to convert tool: ${msg}`, name: (t as any)?.name ?? "(unnamed)" };
      }
    });
  res.json({ preset, tools: specs });
});

// ── Debug: render system prompt ──

apiRouter.get("/debug/prompt", async (req, res) => {
  const preset = resolvePresetFromQuery(req.query);
  try {
    const prompt = await buildSystemPrompt(preset);
    res.set("Content-Type", "text/plain; charset=utf-8").send(prompt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ── Debug tool invocation ──

apiRouter.post("/debug/tools/:toolName", async (req, res) => {
  const tool = debugToolRegistry[req.params.toolName];
  if (!tool) {
    res.status(404).json({ error: `Unknown tool: ${req.params.toolName}` });
    return;
  }
  logger.info(`[/debug/tools/${req.params.toolName}] accept request`);
  try {
    const result = await tool.execute(req.body ?? {});
    res.set("Content-Type", "text/plain; charset=utf-8").send(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

// ── Reset ──

apiRouter.post("/reset", async (_req, res) => {
  try {
    // Clear database and re-seed
    await Database.getExisting().reset();
    await seedDatabase();

    // Database.reset() reinitializes everything — SchemaRegistry, tables, seed

    res.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

// ── Checkpoints ──

apiRouter.get("/checkpoints", async (_req, res) => {
  try {
    const db = Database.getExisting();
    const checkpoints = await db.checkpoint.list();
    res.json(checkpoints);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

apiRouter.post("/checkpoint/restore/:turnNumber", async (req, res) => {
  if (isGenerating()) {
    res.status(409).json({ error: "A turn is in progress" });
    return;
  }
  const turnNumber = parseInt(req.params.turnNumber, 10);
  if (!Number.isFinite(turnNumber) || turnNumber < 1) {
    res.status(400).json({ error: "Invalid turn number" });
    return;
  }
  try {
    const db = Database.getExisting();
    await Database.closeInstance();
    await db.checkpoint.restore(turnNumber);
    await Database.getInstance();
    res.json({ success: true, turn: turnNumber });
  } catch (error: unknown) {
    await Database.getInstance();
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

// ── Logs (SSE) ──

apiRouter.get("/logs/stream", (_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const entry of logger.getBuffer()) {
    res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  }

  const unsub = logger.subscribe((entry) => {
    res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  });

  res.on("close", () => {
    unsub();
  });
});

export default apiRouter;
