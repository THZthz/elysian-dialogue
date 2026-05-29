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

import { parse as parsePartial } from "partial-json";
import type { Response } from "express";
import type { Message, DialogueOption } from "@/types/dialogue";
import { TurnEventEmitter } from "@/server/llm/events";
import { buildSystemPrompt, MAX_GM_STEPS } from "@/server/llm/prompt";
import { Database } from "@/server/db";
import { queryWorld } from "@/server/llm/tools/queryWorld";
import { searchWorld } from "@/server/llm/tools/searchWorld";
import { editNode } from "@/server/llm/tools/editNode";
import { editRelationship } from "@/server/llm/tools/editRelationship";
import { editNote } from "@/server/llm/tools/editNote";
import { editPlot } from "@/server/llm/tools/editPlot";
import { getContext } from "@/server/llm/tools/getContext";
import { manageSchema } from "@/server/llm/tools/manageSchema";
import { createGenerateDialogueStepTool } from "@/server/llm/tools/generateDialogueStep";
import { createManageSceneTool } from "@/server/llm/tools/manageScene";
import { performSkillCheck } from "@/server/llm/rollSkillCheck";
import { type SkillName, TOOL_NAMES } from "@/shared/constants";
import {
  DeepSeekClient,
  ImmutablePrefix,
  createGameLoop,
  vercelToolToSpec,
  type ToolSpec,
} from "@/sdk";

let generating = false;

export function isGenerating(): boolean {
  return generating;
}

// ── SDK Integration ──

let _cachedClient: DeepSeekClient | null = null;
let _cachedPrefix: ImmutablePrefix | null = null;

function getDeepSeekClient(): DeepSeekClient {
  if (_cachedClient) return _cachedClient;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required.");
  _cachedClient = new DeepSeekClient({ apiKey });
  return _cachedClient;
}

export async function getPrefix(): Promise<ImmutablePrefix> {
  if (_cachedPrefix) return _cachedPrefix;
  const systemPrompt = await buildSystemPrompt();
  const allTools = [
    queryWorld,
    searchWorld,
    manageSchema,
    editNode,
    editRelationship,
    editNote,
    editPlot,
    getContext,
  ];
  const toolSpecs: ToolSpec[] = allTools.map((t: any) => vercelToolToSpec(t));
  _cachedPrefix = new ImmutablePrefix({ system: systemPrompt, toolSpecs });
  return _cachedPrefix;
}

function createToolHandlers(
  dialogueStepTool: ReturnType<typeof createGenerateDialogueStepTool>,
  manageSceneTool: ReturnType<typeof createManageSceneTool>,
) {
  return {
    queryWorld: async (args: string) => (queryWorld as any).execute(JSON.parse(args)),
    searchWorld: async (args: string) => (searchWorld as any).execute(JSON.parse(args)),
    manageSchema: async (args: string) => (manageSchema as any).execute(JSON.parse(args)),
    editNode: async (args: string) => (editNode as any).execute(JSON.parse(args)),
    editRelationship: async (args: string) => (editRelationship as any).execute(JSON.parse(args)),
    editNote: async (args: string) => (editNote as any).execute(JSON.parse(args)),
    editPlot: async (args: string) => (editPlot as any).execute(JSON.parse(args)),
    getContext: async (args: string) => (getContext as any).execute(JSON.parse(args)),
    generateDialogueStep: async (args: string) =>
      (dialogueStepTool.tool as any).execute(JSON.parse(args)),
    manageScene: async (args: string) => (manageSceneTool as any).execute(JSON.parse(args)),
  };
}

export async function generateTurn(
  userInput: string,
  history: Message[],
  res: Response,
  check?: DialogueOption["check"],
): Promise<void> {
  if (generating) {
    res.status(409).json({ error: "A turn is already in progress" });
    return;
  }
  generating = true;

  try {
    const events = new TurnEventEmitter(res);
    const db = Database.getExisting();

    console.log(
      `[generateTurn] historyLen=${history.length} userInput="${String(userInput).slice(0, 80)}"`,
    );

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    events.startStep(`step_${Date.now()}`);

    // ── Load turn state ──
    let turnNumber = 1;
    try {
      turnNumber = await db.messages.getNextTurnNumber();
    } catch {
      /* use default */
    }

    // ── Skill check ──
    const promptParts: string[] = [];
    if (check) {
      const rollResult = await performSkillCheck(check).catch((err) => {
        console.error("[generateTurn] Skill check failed:", err);
        return null;
      });
      if (rollResult) {
        events.emitRollResult(rollResult);
        // Persist roll to scene
        try {
          const activeScene = await db.scene.getActive();
          if (activeScene) {
            await db.scene.appendRollLog(
              activeScene.name,
              `Rolled ${check.diceCount}d6 + ${check.skill}(${rollResult.statBonus}) | Total: ${rollResult.total} vs Difficulty: ${check.difficulty} | Result: ${rollResult.success ? "SUCCESS" : "FAILURE"}`,
              {
                speaker: check.skill,
                rollResult: {
                  skill: rollResult.skill as SkillName,
                  difficulty: rollResult.difficulty,
                  dice: rollResult.dice,
                  total: rollResult.total,
                  success: rollResult.success,
                },
              },
            );
          }
        } catch (err) {
          console.error("[generateTurn] failed to log roll:", err);
        }
        promptParts.push(
          "## SKILL CHECK RESULT",
          rollResult.narrativeSummary,
          "",
          `The player ${rollResult.success ? "succeeded" : "failed"} this skill check.`,
          `Narrate naturally via ${TOOL_NAMES.GENERATE_DIALOGUE}.`,
          "",
          "---",
          "",
        );
      }
    }

    // ── Player action ──
    promptParts.push("## PLAYER ACTION", `The player just said/did: "${userInput}"`, "", "---", "");

    // Persist player input to scene log
    try {
      const activeScene = await db.scene.getActive();
      if (activeScene) await db.scene.appendPlayerLog(activeScene.name, userInput);
    } catch (err) {
      console.error("[generateTurn] failed to log player input:", err);
    }

    // ── First turn helper ──
    if (turnNumber === 1) {
      promptParts.push(
        "## BEGIN FIRST TURN",
        `This is first turn, you should call \`${TOOL_NAMES.GET_CONTEXT}\` with ["SCHEMA_DUMP", "CHARACTERS_BRIEF", "LOCATIONS_BRIEF", "OBJECTS_BRIEF", "PLOTS_BRIEF", "RELATIONSHIP_DUMP"].`,
        `Explore with \`${TOOL_NAMES.QUERY_WORLD}\`.`,
        `Check notes/plots by \`${TOOL_NAMES.SEARCH_WORLD}\`. Search note with "Opening Scene" recommended.`,
        "",
        "---",
        "",
      );
    }

    promptParts.push("Generate the narrative response following the output format.", "");
    const promptText = promptParts.join("\n");

    // ── Set up SDK loop ──
    const prefix = await getPrefix();
    const client = getDeepSeekClient();
    const dialogueStepTool = createGenerateDialogueStepTool();
    const manageSceneTool = createManageSceneTool(events);
    dialogueStepTool.resetForTurn();

    let dialogueStepCalled = false;
    let nudgeCount = 0;
    const handlers = createToolHandlers(dialogueStepTool, manageSceneTool);

    const loop = createGameLoop({
      client,
      prefix,
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      thinking: true,
      reasoningEffort: "high",
      maxIterPerTurn: MAX_GM_STEPS,
      runTool: async (name, args, signal) => {
        const handler = handlers[name as keyof typeof handlers];
        if (!handler) return { result: `Unknown tool: ${name}` };
        const result = await handler(args);
        if (name === TOOL_NAMES.GENERATE_DIALOGUE) {
          dialogueStepCalled = true;
          nudgeCount = 0;
          if (dialogueStepTool.wasValid()) return { result, turnComplete: true };
        }
        return { result };
      },
      onIterStart: (iter, log) => {
        const minIter = turnNumber === 1 ? 6 : 4;
        if (iter < minIter || dialogueStepCalled) return;
        nudgeCount++;
        const prefix_ = nudgeCount === 1 ? "Reminder:" : "ERROR:";
        const msg = `${prefix_} You have not yet called ${TOOL_NAMES.GENERATE_DIALOGUE}. The player cannot see any response. You MUST call ${TOOL_NAMES.GENERATE_DIALOGUE} now.`;
        log.append({ role: "user", content: msg });
      },
      rebuildSystem: () => buildSystemPrompt() as unknown as string,
    });

    // ── Stream events to SSE ──
    let finalMessages: Record<string, unknown>[] = [];
    let finalOptions: DialogueOption[] = [];
    let toolRawArgs = "";
    let hasEmittedStreaming = false;

    for await (const event of loop.step(promptText)) {
      switch (event.role) {
        case "tool_call_delta":
          if (event.toolName === TOOL_NAMES.GENERATE_DIALOGUE) {
            if (event.argsDelta) {
              // New dialogue call → reset streaming
              if (hasEmittedStreaming) {
                events.emitStreamingReset();
                hasEmittedStreaming = false;
              }
              // Accumulate args across deltas
              toolRawArgs += event.argsDelta;
              try {
                const parsed = parsePartial(toolRawArgs) as Record<string, unknown>;
                if (
                  parsed.messages &&
                  Array.isArray(parsed.messages) &&
                  (parsed.messages as any[]).length > 0
                ) {
                  finalMessages = parsed.messages as Record<string, unknown>[];
                  hasEmittedStreaming = true;
                  events.emitStreamingMessages(
                    (finalMessages as any[]).map((m: any) => ({
                      speaker: m.speaker || "SYSTEM",
                      type: m.type || "SYSTEM",
                      text: m.text || "",
                      metadata: m.metadata,
                    })),
                  );
                }
                if (parsed.options && Array.isArray(parsed.options)) {
                  finalOptions = (parsed.options as any[]).map((o: any) => ({
                    text: o.text || "",
                    hintBefore: o.hintBefore,
                    hintAfter: o.hintAfter,
                    check: o.check
                      ? {
                          skill: o.check.skill,
                          difficulty: o.check.difficulty,
                          difficultyText: o.check.difficultyText || "",
                          diceCount: o.check.diceCount ?? 2,
                          conditions: (o.check.conditions || []).map((c: any, ci: number) => ({
                            expression: c.expression,
                            label: c.label,
                            color: c.color,
                            stepId: c.stepId || `step_res_${ci}`,
                          })),
                        }
                      : undefined,
                  }));
                  if (finalOptions.length > 0) events.emitOptions(finalOptions);
                }
              } catch {
                /* Partial JSON not parseable yet */
              }
            }
          }
          break;
        case "assistant_final":
          console.log(`[generateTurn] cacheHitRatio: ${(event.cacheHitRatio * 100).toFixed(1)}%`);
          break;
        case "error":
          events.emitError(event.error);
          break;
        case "warning":
          console.warn(`[generateTurn] ${event.content}`);
          break;
      }
    }

    // ── Post-turn ──
    const dialogueWasValid = dialogueStepTool.wasValid();
    if (!dialogueWasValid) {
      finalMessages = [];
      finalOptions = [];
    }

    // Persist GM dialogue to scene log
    if (dialogueWasValid && finalMessages.length > 0) {
      try {
        const activeScene = await db.scene.getActive();
        if (activeScene) {
          await db.scene.appendGMLog(
            activeScene.name,
            finalMessages as Array<{
              speaker: string;
              type: string;
              text: string;
              metadata?: Record<string, unknown>;
            }>,
            finalOptions.length > 0
              ? (finalOptions as unknown as Record<string, unknown>)
              : undefined,
          );
        }
      } catch (err) {
        console.error("[generateTurn] failed to log GM output:", err);
      }
    }

    if (finalMessages.length === 0) {
      events.emitError("Failed to generate valid dialogue");
    } else {
      events.emitParsed(
        finalMessages.map((m: any) => ({
          speaker: m.speaker,
          type: m.type,
          text: m.text,
          metadata: m.metadata,
        })),
        finalOptions,
      );
      events.emitOptions(finalOptions);
    }
    events.finish();

    // Persist options
    if (finalOptions.length > 0) {
      try {
        const activeScene = await db.scene.getActive();
        if (activeScene) await db.scene.saveOptions(activeScene.name, finalOptions);
      } catch (err) {
        console.error("[generateTurn] failed to persist options:", err);
      }
    }

    // Save checkpoint
    try {
      await db.checkpoint.save(
        turnNumber,
        async () => {
          await Database.closeInstance();
        },
        async () => {
          await Database.getInstance();
        },
      );
    } catch (err) {
      console.error("[generateTurn] failed to save checkpoint:", err);
    }
  } finally {
    generating = false;
  }
}
