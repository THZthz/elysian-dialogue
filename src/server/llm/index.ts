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

import * as path from "node:path";
import { parse as parsePartial } from "partial-json";
import type { Response } from "express";
import type { Message, DialogueOption } from "@/types/dialogue";
import { TurnEventEmitter } from "@/server/llm/events";
import { buildSystemPrompt, MAX_GM_STEPS } from "@/server/llm/prompt";
import { Database } from "@/server/db";
import { queryWorld } from "@/server/llm/tools/queryWorld";
import { searchWorld } from "@/server/llm/tools/searchWorld";
import { manageNode } from "@/server/llm/tools/manageNode";
import { manageRelationship } from "@/server/llm/tools/manageRelationship";
import { editNote } from "@/server/llm/tools/editNote";
import { editPlot } from "@/server/llm/tools/editPlot";
import { getContext } from "@/server/llm/tools/getContext";
import { manageSchema } from "@/server/llm/tools/manageSchema";
import { createGenerateDialogueStepTool } from "@/server/llm/tools/generateDialogueStep";
import { createManageSceneTool } from "@/server/llm/tools/manageScene";
import { enrichResult } from "@/server/llm/enrichment";
import { validateAndExecute } from "@/server/llm/tools/shared";
import { performSkillCheck } from "@/server/llm/rollSkillCheck";
import chalk from "chalk";
import { highlightJson, highlightMarkdown } from "@/shared/highlight";
import {
  type SkillName,
  TOOL_NAMES,
  DEBUG_PRINT_LLM_GENERATIONS,
  ROLE_NAMES,
} from "@/shared/constants";

const SEP = chalk.dim("─".repeat(48));
import {
  DeepSeekClient,
  ImmutablePrefix,
  createGameLoop,
  toolToSpec,
  type ToolSpec,
  JsonlPersistence,
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
  const dbTools = [
    queryWorld,
    searchWorld,
    manageSchema,
    manageNode,
    manageRelationship,
    editNote,
    editPlot,
    getContext,
  ];
  const toolSpecs: ToolSpec[] = dbTools.map((t) => toolToSpec(t));

  // Per-turn tools have factory-created state, but their schemas are static —
  // register specs here so the LLM knows the exact parameter names.
  toolSpecs.push(toolToSpec(createGenerateDialogueStepTool().tool));
  toolSpecs.push(toolToSpec(createManageSceneTool(null!)));

  _cachedPrefix = new ImmutablePrefix({ system: systemPrompt, toolSpecs });
  return _cachedPrefix;
}

function createToolHandlers(
  dialogueStepTool: ReturnType<typeof createGenerateDialogueStepTool>,
  manageSceneTool: ReturnType<typeof createManageSceneTool>,
) {
  return {
    queryWorld: async (args: string) => validateAndExecute(queryWorld, args),
    searchWorld: async (args: string) => validateAndExecute(searchWorld, args),
    manageSchema: async (args: string) => validateAndExecute(manageSchema, args),
    manageNode: async (args: string) => validateAndExecute(manageNode, args),
    manageRelationship: async (args: string) => validateAndExecute(manageRelationship, args),
    editNote: async (args: string) => validateAndExecute(editNote, args),
    editPlot: async (args: string) => validateAndExecute(editPlot, args),
    getContext: async (args: string) => validateAndExecute(getContext, args),
    generateDialogueStep: async (args: string) => validateAndExecute(dialogueStepTool.tool, args),
    manageScene: async (args: string) => validateAndExecute(manageSceneTool, args),
  };
}

function detectFormat(content: string) {
  let parsed: null;
  try {
    parsed = JSON.parse(content);
  } catch {
    return "markdown";
  }

  if (typeof parsed === "object" && parsed !== null) {
    return "json"; // array or object
  }

  if (typeof parsed === "string") {
    const markdownPatterns = [
      /^#{1,6}\s+\S/m, // headers
      /^[*\-+]\s+\S/m, // unordered lists
      /^\d+\.\s+\S/m, // ordered lists
      /\[.+\]\(.+\)/, // links
      /```/, // code fences
      /^>/m, // blockquotes
      /\*\*.*\*\*/, // bold
      /__.*__/, // bold (alternative)
      /\*.*\*/, // italic
    ];
    if (markdownPatterns.some((pattern) => pattern.test(content))) {
      return "markdown";
    }
    return "json";
  }
  // number, boolean, null
  return "json";
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
    // Count existing checkpoints — GMTurnMessage nodes are not the canonical
    // turn counter (generateDialogueStep persistence is optional).
    let turnNumber = 1;
    try {
      const checkpoints = await db.checkpoint.list();
      if (checkpoints.length > 0) {
        turnNumber = Math.max(...checkpoints.map((c) => c.turn)) + 1;
      }
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
        `Check notes/plots by \`${TOOL_NAMES.SEARCH_WORLD}\`. Search note with "Opening Scene" (limit: 1) is recommended.`,
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

    const messageLogDir = path.dirname(db.messageLogPath);
    const sessionName = path.basename(db.messageLogPath, ".jsonl");
    const persistence = new JsonlPersistence(messageLogDir, sessionName);

    let dialogueStepCalled = false;
    let nudgeCount = 0;
    const handlers = createToolHandlers(dialogueStepTool, manageSceneTool);

    const loop = createGameLoop({
      client,
      prefix,
      sessionName,
      persistence,
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      reasoningEffort: "max",
      maxIterPerTurn: MAX_GM_STEPS,
      runTool: async (name, args, _signal) => {
        const handler = handlers[name as keyof typeof handlers];
        if (!handler) return { result: `Unknown tool: ${name}` };
        const rawResult = await handler(args);
        const result = await enrichResult(name, args, rawResult);
        if (name === TOOL_NAMES.GENERATE_DIALOGUE) {
          dialogueStepCalled = true;
          nudgeCount = 0;
          if (dialogueStepTool.wasValid()) return { result, turnComplete: true };
        }
        return { result };
      },
      onIterStart: (iter, log) => {
        if (iter < 2 || dialogueStepCalled) return;
        nudgeCount++;
        const prefix_ = nudgeCount === 1 ? "Reminder:" : "ERROR:";
        const msg = `${prefix_} You have not yet called ${TOOL_NAMES.GENERATE_DIALOGUE}. The player cannot see any response. You MUST call ${TOOL_NAMES.GENERATE_DIALOGUE} now — do not output text, call the tool.`;
        log.append({ role: "user", content: msg, name: ROLE_NAMES.GM_ASSISTANT });
      },
      canEndTurn: () => {
        if (dialogueStepCalled) return null;
        nudgeCount++;
        return `BLOCKED: You must call ${TOOL_NAMES.GENERATE_DIALOGUE} to speak to the player before ending your turn. Text replies are not shown to the player — only ${TOOL_NAMES.GENERATE_DIALOGUE} output is visible. Call ${TOOL_NAMES.GENERATE_DIALOGUE} now.`;
      },
      rebuildSystem: () => buildSystemPrompt() as unknown as string,
    });

    // ── Stream events to SSE ──
    let finalMessages: Record<string, unknown>[] = [];
    let finalOptions: DialogueOption[] = [];
    let toolRawArgs = "";
    let streamingNeedsReset = false;

    // Debug: track tool call argument deltas to print complete requests
    let debugToolCalls: Map<number, { name: string; args: string }> | null = null;

    if (DEBUG_PRINT_LLM_GENERATIONS) {
      debugToolCalls = new Map();
      console.log(chalk.bold.magenta("\n══════════════════════════════════════════"));
      console.log(chalk.bold.magenta("  LLM GENERATION — Turn"), turnNumber);
      console.log(chalk.bold.magenta("══════════════════════════════════════════"));

      if (turnNumber == 1) {
        console.log(SEP);
        console.log(chalk.bold.cyan("[TOOL SCHEMAS]"));
        for (const spec of prefix.toolSpecs) {
          console.log(chalk.cyan(`${spec.function.name}`));
          console.log(highlightJson(JSON.stringify(spec, null, 2)));
          console.log("\n");
        }
        console.log(SEP);
        console.log(chalk.bold.blue("[SYSTEM PROMPT]"));
        console.log(highlightMarkdown(prefix.system));
      }

      console.log(SEP);
      console.log(chalk.bold.blue("[USER PROMPT]"));
      console.log(highlightMarkdown(promptText));
    }

    let hadError = false;

    for await (const event of loop.step(promptText)) {
      switch (event.role) {
        case "tool_call_delta": {
          if (debugToolCalls) {
            const entry = debugToolCalls.get(event.index) ?? { name: event.toolName, args: "" };
            entry.name = event.toolName;
            if (event.argsDelta) entry.args += event.argsDelta;
            debugToolCalls.set(event.index, entry);
          }
          if (event.toolName === TOOL_NAMES.GENERATE_DIALOGUE) {
            if (event.argsDelta) {
              // Reset streaming when starting a new dialogue call (e.g. correction)
              if (streamingNeedsReset) {
                toolRawArgs = "";
                events.emitStreamingReset();
                streamingNeedsReset = false;
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
                  events.emitStreamingMessages(
                    (finalMessages as any[])
                      .filter((m: any) => m.speaker && m.text)
                      .map((m: any) => ({
                        speaker: m.speaker,
                        type: m.type || "SYSTEM",
                        text: m.text,
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
        }
        case "assistant_final": {
          const promptHitRatio = (
            (event.usage.promptCacheHitTokens / event.usage.promptTokens) *
            100
          ).toFixed(2);
          const promptMissRatio = (
            (event.usage.promptCacheMissTokens / event.usage.promptTokens) *
            100
          ).toFixed(2);
          console.log(
            `[generateTurn] cacheHitRatio: ${(event.cacheHitRatio * 100).toFixed(2)}% | promptHitRatio: ${promptHitRatio}% | promptMissRatio: ${promptMissRatio}% | promptToken: ${event.usage.promptCacheHitTokens} | completionToken: ${event.usage.completionTokens}`,
          );
          if (debugToolCalls) {
            if (event.reasoning) {
              console.log(SEP);
              console.log(chalk.bold.blue("[REASONING]"));
              console.log(highlightMarkdown(event.reasoning));
            }
            if (event.content) {
              console.log(SEP);
              console.log(chalk.bold.green("[CONTENT]"));
              console.log(highlightMarkdown(event.content));
            }
            if (debugToolCalls.size > 0) {
              console.log(SEP);
              console.log(chalk.bold.cyan("[TOOL CALLS]"));
              for (const [, tc] of debugToolCalls) {
                console.log(chalk.cyan(`${tc.name}`));
                console.log(highlightJson(tc.args));
              }
            }
            debugToolCalls.clear();
          }
          break;
        }
        case "tool_result": {
          if (event.name === TOOL_NAMES.GENERATE_DIALOGUE) {
            streamingNeedsReset = true;
          }
          if (DEBUG_PRINT_LLM_GENERATIONS) {
            console.log(SEP);
            console.log(chalk.bold.yellow(`[TOOL RESULT: ${event.name}]`));
            console.log(
              detectFormat(event.result) == "markdown"
                ? highlightMarkdown(event.result)
                : highlightJson(event.result),
            );
          }
          break;
        }
        case "error": {
          hadError = true;
          events.emitError(event.error);
          break;
        }
        case "warning": {
          console.warn(`[generateTurn] ${event.content}`);
          break;
        }
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
      if (!hadError) events.emitError("Failed to generate valid dialogue");
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
      await db.flushCheckpoint();
      await db.checkpoint.save(
        turnNumber,
        async () => {
          Database.closeInstanceSync();
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
