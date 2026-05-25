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
import { generateTurn, isGenerating } from "@/server/gm";
import { chatStreamSchema } from "@/server/validation";
import { getMemoryClient, MemoryClient } from "@/server/memory/client";
import { RelationshipManager } from "@/server/relationshipManager";
import { getCurrentOptions } from "@/server/gameState";
import { queryWorld } from "@/server/assistant/tools/queryWorld";
import { searchWorld } from "@/server/assistant/tools/searchWorld";
import { editNode } from "@/server/assistant/tools/editNode";
import { editRelationship } from "@/server/assistant/tools/editRelationship";
import { editNote } from "@/server/tools/editNote";
import { editPlot } from "@/server/gm/tools/editPlot";
import { manageSchema } from "@/server/assistant/tools/manageSchema";
import type { Message } from "@/types/dialogue";
import { getContext } from "@/server/assistant/tools/getContext";
import { delegateToAssistant, type AssistantContext } from "@/server/assistant";
import { listCheckpoints, restoreCheckpoint } from "@/server/checkpointManager";

const debugToolRegistry: Record<string, { execute: (args: any) => Promise<string> }> = {
  queryWorld: queryWorld as any,
  searchWorld: searchWorld as any,
  editNode: editNode as any,
  editRelationship: editRelationship as any,
  manageSchema: manageSchema as any,
  editNote: editNote as any,
  editPlot: editPlot as any,
  getContext: getContext as any,
  delegateToAssistant: {
    execute: async (args: any) => {
      const ctx: AssistantContext = {
        recentConversation: "",
        gmToolCalls: [],
        turnNumber: 0,
      };
      return delegateToAssistant(args.request ?? "", ctx);
    },
  },
};

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
    console.log(
      `[chat/stream] userInput="${String(userInput).slice(0, 80)}" historyLen=${history?.length ?? 0} hasCheck=${!!check}`,
    );
    await generateTurn(userInput, history ?? [], res, check);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Chat stream error:", message);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    } else {
      res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      res.end();
    }
  }
});

// ── History ──

apiRouter.get("/history", async (_req, res) => {
  try {
    const client = getMemoryClient();
    const messages = await client.shortTerm.getConversation();
    const history: Message[] = messages.map((m, i) => {
      const meta = m.metadata || {};
      const msg: Message = {
        id: `msg_${i}`,
        speaker: (meta.speaker as string) || "SYSTEM",
        type: (meta.type as Message["type"]) || "SYSTEM",
        text: m.content || "",
        metadata: meta as Message["metadata"],
      };
      if (meta.rollResult) {
        msg.rollResult = meta.rollResult as Message["rollResult"];
      }
      return msg;
    });
    res.json(history);
  } catch (error: unknown) {
    console.error("History fetch error:", error);
    res.json([]);
  }
});

// ── Game state ──

apiRouter.get("/game/current", async (_req, res) => {
  try {
    const state = await getCurrentOptions();
    res.json(state);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Session state fetch error:", message);
    res.json(null);
  }
});

// ── Debug tool invocation ──

apiRouter.post("/debug/tools/:toolName", async (req, res) => {
  const tool = debugToolRegistry[req.params.toolName];
  if (!tool) {
    res.status(404).json({ error: `Unknown tool: ${req.params.toolName}` });
    return;
  }
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
    // Clear Neo4j and re-seed
    const { clearNeo4jDatabase } = await import("@/server/memory/reset");
    await clearNeo4jDatabase();
    const { seedDatabase } = await import("@/server/stories/seed");
    await seedDatabase();

    // Reset in-memory GM_DEFINED types, then sync INTERNAL + PREDEFINED back to Neo4j
    const relManager = RelationshipManager.getCachedInstance();
    relManager.reset();
    const nodeManager = (await import("@/server/nodeManager")).getNodeManager();
    nodeManager.reset();
    const client = await MemoryClient.getInstance();
    await relManager.syncToNeo4j(client.neo4j);
    await nodeManager.syncToNeo4j(client.neo4j);

    res.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

// ── Checkpoints ──

apiRouter.get("/checkpoints", async (_req, res) => {
  try {
    const checkpoints = await listCheckpoints();
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
    const result = await restoreCheckpoint(turnNumber);
    res.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

export default apiRouter;
