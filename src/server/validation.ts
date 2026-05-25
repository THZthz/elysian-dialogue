import { z } from "zod";
import { SKILL_NAMES } from "@/shared/constants";

export const chatStreamSchema = z.object({
  userInput: z.string().min(1),
  history: z.array(z.any()).optional(),
  check: z.object({
    skill: z.enum(SKILL_NAMES as unknown as [string, ...string[]]),
    difficulty: z.number(),
    difficultyText: z.string().optional(),
    diceCount: z.number().optional(),
    conditions: z.array(z.any()).optional(),
  }).optional(),
});
