import { z } from "zod";

export const chatStreamSchema = z.object({
  userInput: z.string().min(1),
  history: z.array(z.any()).optional(),
  check: z.object({
    skill: z.string(),
    difficulty: z.number(),
    difficultyText: z.string().optional(),
    diceCount: z.number().optional(),
    conditions: z.array(z.any()).optional(),
  }).optional(),
});
