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

import { z } from "zod";
import { SKILL_NAMES } from "@/shared/constants";

export const chatStreamSchema = z.object({
  userInput: z.string().min(1),
  history: z.array(z.any()).optional(),
  check: z
    .object({
      skill: z.enum(SKILL_NAMES as unknown as [string, ...string[]]),
      difficulty: z.number(),
      difficultyText: z.string().optional(),
      diceCount: z.number().optional(),
      conditions: z.array(z.any()).optional(),
    })
    .optional(),
});
