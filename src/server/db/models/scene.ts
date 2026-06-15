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

import { nextId } from "@/server/db/idGenerator";
import type { LadybugClient } from "@/server/db/ladybug";
import type Database from "better-sqlite3";

export interface SceneData {
  name: string;
  start_time: number;
  end_time: number | null;
  location_name: string | null;
  characters: string[];
  log: SceneLogEntry[];
  options: Record<string, unknown> | null;
  _updated_at: string;
}

export type SceneLogEntry =
  | { type: "gm"; content: SceneMessageContent[]; options?: Record<string, unknown> }
  | { type: "player"; content: string }
  | { type: "roll"; content: string; metadata?: Record<string, unknown> };

export interface SceneMessageContent {
  speaker: string;
  type: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface CreateSceneInput {
  scene_name: string;
  start_time: number;
  location_name: string;
  characters: string[];
  reason: string;
}

export interface ModifySceneInput {
  scene_name?: string;
  add_characters?: string[];
  end_time?: number;
  reason?: string;
}

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value) || (typeof value === "object" && value !== null))
    return value as unknown as T;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export class SceneModel {
  constructor(
    private readonly graph: LadybugClient,
    private readonly sqlite: Database.Database,
  ) {}

  async getActive(): Promise<SceneData | null> {
    const result = await this.graph.query("MATCH (s:Scene) WHERE s.end_time IS NULL RETURN s");
    if (result.rows.length === 0) return null;
    const s = (result.rows[0].s || result.rows[0]) as Record<string, unknown>;
    if (!s.location_name) return null; // placeholder — treat as no active scene
    return this.parseScene(s);
  }

  async checkCharacterLocations(
    locationName: string,
    characterNames: string[],
  ): Promise<{ missingFromLocation: string[]; extraAtLocation: string[] }> {
    // Which specified characters are already at this location?
    const atLocationResult = await this.graph.query(
      `MATCH (c:Character)-[r:CHARACTER_AT]->(l:Location {name: $loc})
       WHERE r.valid_at IS NULL AND c.name IN $names
       RETURN c.name AS name`,
      { loc: locationName, names: characterNames },
    );
    const alreadyThere = new Set(atLocationResult.rows.map((r) => r.name as string));

    // Which characters are at this location but NOT in the GM's list?
    const extraResult = await this.graph.query(
      `MATCH (c:Character)-[r:CHARACTER_AT]->(l:Location {name: $loc})
       WHERE r.valid_at IS NULL AND NOT c.name IN $names
       RETURN c.name AS name`,
      { loc: locationName, names: characterNames },
    );
    const extraAtLocation = extraResult.rows.map((r) => r.name as string);

    // Specified characters not at this location
    const missingFromLocation = characterNames.filter((n) => !alreadyThere.has(n));

    return { missingFromLocation, extraAtLocation };
  }

  async syncCharacterLocations(
    locationName: string,
    characterNames: string[],
    atTime: number,
  ): Promise<{ fixed: string[]; extraAtLocation: string[] }> {
    const now = new Date().toISOString();

    // Which specified characters are already at this location?
    const atLocationResult = await this.graph.query(
      `MATCH (c:Character)-[r:CHARACTER_AT]->(l:Location {name: $loc})
       WHERE r.valid_at IS NULL AND c.name IN $names
       RETURN c.name AS name`,
      { loc: locationName, names: characterNames },
    );
    const alreadyThere = new Set(atLocationResult.rows.map((r) => r.name as string));

    // Which characters are at this location but NOT in the GM's list?
    const extraResult = await this.graph.query(
      `MATCH (c:Character)-[r:CHARACTER_AT]->(l:Location {name: $loc})
       WHERE r.valid_at IS NULL AND NOT c.name IN $names
       RETURN c.name AS name`,
      { loc: locationName, names: characterNames },
    );
    const extraAtLocation = extraResult.rows.map((r) => r.name as string);

    // Fix characters that need moving
    const fixed: string[] = [];
    for (const name of characterNames) {
      if (alreadyThere.has(name)) continue;

      // End any current CHARACTER_AT for this character
      await this.graph.query(
        `MATCH (c:Character {name: $name})-[r:CHARACTER_AT]->(:Location)
         WHERE r.valid_at IS NULL
         SET r.valid_at = $time, r._updated_at = $now`,
        { name, time: atTime, now },
      );

      // Create new CHARACTER_AT to the target location
      await this.graph.query(
        `MATCH (c:Character {name: $name})
         MATCH (l:Location {name: $loc})
         CREATE (c)-[r:CHARACTER_AT {created_at: $time, valid_at: NULL, brief: '', _updated_at: $now}]->(l)`,
        { name, loc: locationName, time: atTime, now },
      );

      fixed.push(name);
    }

    return { fixed, extraAtLocation };
  }

  async create(
    input: CreateSceneInput,
  ): Promise<{ scene: SceneData; timeMismatchWarning?: string }> {
    const now = new Date().toISOString();
    const name = input.scene_name;

    // Check if active scene exists
    const existingResult = await this.graph.query(
      "MATCH (s:Scene) WHERE s.end_time IS NULL RETURN s",
    );

    let oldScene: SceneData | null = null;
    let isPlaceholder = false;

    if (existingResult.rows.length > 0) {
      const s = (existingResult.rows[0].s || existingResult.rows[0]) as Record<string, unknown>;
      if (s.location_name) {
        oldScene = this.parseScene(s);
        isPlaceholder = false;
      } else {
        isPlaceholder = true;
        oldScene = { ...this.parseScene(s), location_name: null };
      }
    }

    if (oldScene && !isPlaceholder) {
      // Close the old scene
      await this.graph.query(
        "MATCH (s:Scene {name: $oldName}) SET s.end_time = $end_time, s._updated_at = $now",
        { oldName: oldScene.name, end_time: input.start_time, now },
      );
    }

    if (isPlaceholder && oldScene) {
      // Check if previous scene's end_time matches new start_time
      let timeMismatchWarning: string | undefined;
      const prevResult = await this.graph.query(
        `MATCH (prev:Scene)-[r:NEXT_SCENE]->(:Scene {name: $name})
         RETURN prev.end_time AS prev_end_time, prev.location_name AS prev_loc`,
        { name: oldScene.name },
      );
      if (prevResult.rows.length > 0) {
        const prevEndTime = prevResult.rows[0].prev_end_time as number | null;
        if (prevEndTime !== null && prevEndTime !== input.start_time) {
          const prevLoc = (prevResult.rows[0].prev_loc as string) ?? "(unknown)";
          timeMismatchWarning = `Time mismatch: previous scene "${prevLoc}" ended at ${prevEndTime} but new scene starts at ${input.start_time}.`;
        }
      }

      // Populate the placeholder
      await this.graph.query(
        `MATCH (s:Scene {name: $name})
         SET s.start_time = $start_time, s.location_name = $loc, s.characters = $chars,
             s._updated_at = $now`,
        {
          name: oldScene.name,
          start_time: input.start_time,
          loc: input.location_name,
          chars: JSON.stringify(input.characters),
          now,
        },
      );

      // Update the reason on the NEXT_SCENE relationship
      await this.graph.query(
        `MATCH (:Scene)-[r:NEXT_SCENE]->(:Scene {name: $name})
         SET r.reason = $reason, r._updated_at = $now`,
        { name: oldScene.name, reason: input.reason, now },
      );

      const scene = await this.getByNameOrThrow(oldScene.name);
      return { scene, timeMismatchWarning };
    }

    // Create brand-new scene
    await this.graph.query(
      `CREATE (s:Scene {
         name: $name, start_time: $start_time, end_time: NULL,
         location_name: $loc, characters: $chars, log: $log,
         options: NULL, _updated_at: $now
       })`,
      {
        name,
        start_time: input.start_time,
        loc: input.location_name,
        chars: JSON.stringify(input.characters),
        log: JSON.stringify([]),
        now,
      },
    );

    if (oldScene) {
      await this.graph.mergeRelationship(
        "Scene",
        "name",
        oldScene.name,
        "Scene",
        "name",
        name,
        "NEXT_SCENE",
        { reason: input.reason },
      );
    }

    const scene = await this.getByNameOrThrow(name);
    return { scene };
  }

  async modify(input: ModifySceneInput): Promise<SceneData | null> {
    const scene = input.scene_name
      ? await this.getByName(input.scene_name)
      : await this.getActiveRaw();
    if (!scene) return null;

    const now = new Date().toISOString();

    if (input.add_characters && input.add_characters.length > 0) {
      const merged = [...new Set([...scene.characters, ...input.add_characters])];
      await this.graph.query(
        "MATCH (s:Scene {name: $name}) SET s.characters = $chars, s._updated_at = $now",
        { name: scene.name, chars: JSON.stringify(merged), now },
      );
    }

    if (input.end_time !== undefined) {
      // Close the scene
      await this.graph.query(
        "MATCH (s:Scene {name: $name}) SET s.end_time = $end_time, s._updated_at = $now",
        { name: scene.name, end_time: input.end_time, now },
      );

      // Create placeholder
      const phName = `scene_${await nextId(this.sqlite)}`;
      await this.graph.query(
        `CREATE (s:Scene {
           name: $name, start_time: $end_time, end_time: NULL,
           location_name: NULL, characters: $emptyArr, log: $emptyArr,
           options: NULL, _updated_at: $now
         })`,
        {
          name: phName,
          end_time: input.end_time,
          emptyArr: JSON.stringify([]),
          now,
        },
      );

      await this.graph.mergeRelationship(
        "Scene",
        "name",
        scene.name,
        "Scene",
        "name",
        phName,
        "NEXT_SCENE",
        { reason: input.reason ?? "" },
      );

      return this.getByName(phName);
    }

    return this.getByName(scene.name);
  }

  async appendPlayerLog(sceneName: string, userInput: string): Promise<void> {
    const entry: SceneLogEntry = { type: "player", content: userInput };
    const result = await this.graph.query("MATCH (s:Scene {name: $name}) RETURN s.log AS log", {
      name: sceneName,
    });
    const currentLog: SceneLogEntry[] = parseJsonField<SceneLogEntry[]>(result.rows[0]?.log, []);
    currentLog.push(entry);
    await this.graph.query("MATCH (s:Scene {name: $name}) SET s.log = $log, s._updated_at = $now", {
      name: sceneName,
      log: JSON.stringify(currentLog),
      now: new Date().toISOString(),
    });
  }

  async appendGMLog(
    sceneName: string,
    messages: SceneMessageContent[],
    options?: Record<string, unknown>,
  ): Promise<void> {
    const entry: SceneLogEntry = { type: "gm", content: messages, options };
    const result = await this.graph.query("MATCH (s:Scene {name: $name}) RETURN s.log AS log", {
      name: sceneName,
    });
    const currentLog: SceneLogEntry[] = parseJsonField<SceneLogEntry[]>(result.rows[0]?.log, []);
    currentLog.push(entry);
    const now = new Date().toISOString();
    await this.graph.query(
      "MATCH (s:Scene {name: $name}) SET s.log = $log, s.options = $opts, s._updated_at = $now",
      {
        name: sceneName,
        log: JSON.stringify(currentLog),
        opts: options ? JSON.stringify(options) : null,
        now,
      },
    );
  }

  async appendRollLog(
    sceneName: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const entry: SceneLogEntry = { type: "roll", content, metadata };
    const result = await this.graph.query("MATCH (s:Scene {name: $name}) RETURN s.log AS log", {
      name: sceneName,
    });
    const currentLog: SceneLogEntry[] = parseJsonField<SceneLogEntry[]>(result.rows[0]?.log, []);
    currentLog.push(entry);
    await this.graph.query("MATCH (s:Scene {name: $name}) SET s.log = $log, s._updated_at = $now", {
      name: sceneName,
      log: JSON.stringify(currentLog),
      now: new Date().toISOString(),
    });
  }

  async saveOptions(sceneName: string, options: unknown): Promise<void> {
    await this.graph.query(
      "MATCH (s:Scene {name: $name}) SET s.options = $options, s._updated_at = $now",
      { name: sceneName, options: JSON.stringify(options), now: new Date().toISOString() },
    );
  }

  async getHistory(): Promise<SceneLogEntry[]> {
    const result = await this.graph.query(
      "MATCH (s:Scene) WHERE s.log IS NOT NULL RETURN s.log AS log ORDER BY s.start_time",
    );
    const allEntries: SceneLogEntry[] = [];
    for (const row of result.rows) {
      const entries = parseJsonField<SceneLogEntry[]>(row.log, []);
      allEntries.push(...entries);
    }
    return allEntries;
  }

  async getChain(): Promise<{ scenes: SceneData[]; warnings: string[] }> {
    const result = await this.graph.query("MATCH (s:Scene) RETURN s ORDER BY s.start_time");
    const scenes = result.rows.map((row) => {
      const s = (row.s || row) as Record<string, unknown>;
      return this.parseScene(s);
    });

    const warnings: string[] = [];
    for (let i = 0; i < scenes.length - 1; i++) {
      const prev = scenes[i];
      const curr = scenes[i + 1];
      if (prev.end_time !== null && prev.end_time !== curr.start_time) {
        warnings.push(
          `Scene "${prev.location_name ?? "(placeholder)"}" (${prev.name}) end_time=${prev.end_time} but next scene "${curr.location_name ?? "(placeholder)"}" (${curr.name}) start_time=${curr.start_time}`,
        );
      }
    }

    return { scenes, warnings };
  }

  private async getActiveRaw(): Promise<SceneData | null> {
    const result = await this.graph.query("MATCH (s:Scene) WHERE s.end_time IS NULL RETURN s");
    if (result.rows.length === 0) return null;
    const s = (result.rows[0].s || result.rows[0]) as Record<string, unknown>;
    return {
      name: s.name as string,
      start_time: s.start_time as number,
      end_time: (s.end_time as number) ?? null,
      location_name: (s.location_name as string) ?? null,
      characters: parseJsonField<string[]>(s.characters, []),
      log: parseJsonField<SceneLogEntry[]>(s.log, []),
      options: parseJsonField<Record<string, unknown> | null>(s.options, null),
      _updated_at: (s._updated_at as string) ?? "",
    };
  }

  async getByName(name: string): Promise<SceneData | null> {
    const result = await this.graph.query("MATCH (s:Scene {name: $name}) RETURN s", { name });
    if (result.rows.length === 0) return null;
    const s = (result.rows[0].s || result.rows[0]) as Record<string, unknown>;
    return this.parseScene(s);
  }

  private async getByNameOrThrow(name: string): Promise<SceneData> {
    const result = await this.graph.query("MATCH (s:Scene {name: $name}) RETURN s", { name });
    const s = (result.rows[0].s || result.rows[0]) as Record<string, unknown>;
    return this.parseScene(s);
  }

  private parseScene(s: Record<string, unknown>): SceneData {
    return {
      name: s.name as string,
      start_time: s.start_time as number,
      end_time: (s.end_time as number) ?? null,
      location_name: (s.location_name as string) ?? null,
      characters: parseJsonField<string[]>(s.characters, []),
      log: parseJsonField<SceneLogEntry[]>(s.log, []),
      options: parseJsonField<Record<string, unknown> | null>(s.options, null),
      _updated_at: (s._updated_at as string) ?? "",
    };
  }
}
