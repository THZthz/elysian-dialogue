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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";
import { getActiveSeedStory } from "@/server/stories";
import { TOOL_NAMES, type ToolsPreset } from "@/shared/constants";

export const MAX_GM_STEPS = 15;

const templatePath = fileURLToPath(new URL("templates/system-prompt.njk", import.meta.url));
const templateSrc = readFileSync(templatePath, "utf-8");

const nunjucksEnv = nunjucks.configure({ autoescape: false });
const compiledTemplate = nunjucks.compile(templateSrc, nunjucksEnv);

export async function buildSystemPrompt(preset: ToolsPreset): Promise<string> {
  const seedStory = getActiveSeedStory();
  return compiledTemplate.render({
    preset,
    tools: TOOL_NAMES,
    setting_description: seedStory.settingDescription,
    tone_description: seedStory.toneDescription,
  });
}
