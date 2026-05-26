import { v4 as uuidv4 } from "uuid";
import type { LadybugClient } from "@/server/db/ladybug";

export interface SceneData {
  _uid: string;
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
  start_time: number;
  location_name: string;
  characters: string[];
  reason: string;
}

export interface ModifySceneInput {
  add_characters?: string[];
  end_time?: number;
  reason?: string;
}

export class SceneModel {
  constructor(private readonly graph: LadybugClient) {}

  async getActive(): Promise<SceneData | null> {
    const result = await this.graph.query(
      "MATCH (s:Scene) WHERE s.end_time IS NULL RETURN s",
    );
    if (result.rows.length === 0) return null;
    const s = (result.rows[0].s || result.rows[0]) as Record<string, unknown>;
    if (!s.location_name) return null; // placeholder — treat as no active scene
    return this.parseScene(s);
  }

  async create(input: CreateSceneInput): Promise<SceneData> {
    const now = new Date().toISOString();
    const _uid = uuidv4();

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
        "MATCH (s:Scene {_uid: $_uid}) SET s.end_time = $end_time, s._updated_at = $now",
        { _uid: oldScene._uid, end_time: input.start_time, now },
      );
    }

    if (isPlaceholder && oldScene) {
      // Populate the placeholder
      await this.graph.query(
        `MATCH (s:Scene {_uid: $_uid})
         SET s.start_time = $start_time, s.location_name = $loc, s.characters = $chars,
             s._updated_at = $now`,
        {
          _uid: oldScene._uid,
          start_time: input.start_time,
          loc: input.location_name,
          chars: JSON.stringify(input.characters),
          now,
        },
      );

      // Update the reason on the NEXT_SCENE relationship
      await this.graph.query(
        `MATCH (:Scene)-[r:NEXT_SCENE]->(:Scene {_uid: $_uid})
         SET r.reason = $reason, r._updated_at = $now`,
        { _uid: oldScene._uid, reason: input.reason, now },
      );

      return this.getByUid(oldScene._uid);
    }

    // Create brand new scene
    await this.graph.query(
      `CREATE (s:Scene {
         _uid: $_uid, start_time: $start_time, end_time: NULL,
         location_name: $loc, characters: $chars, log: $log,
         options: NULL, _updated_at: $now
       })`,
      {
        _uid,
        start_time: input.start_time,
        loc: input.location_name,
        chars: JSON.stringify(input.characters),
        log: JSON.stringify([]),
        now,
      },
    );

    if (oldScene) {
      await this.graph.mergeRelationship(
        "Scene", "_uid", oldScene._uid,
        "Scene", "_uid", _uid,
        "NEXT_SCENE",
        { reason: input.reason },
      );
    }

    return this.getByUid(_uid);
  }

  async modify(input: ModifySceneInput): Promise<SceneData | null> {
    const active = await this.getActiveRaw();
    if (!active) return null;

    const now = new Date().toISOString();

    if (input.add_characters && input.add_characters.length > 0) {
      const merged = [...new Set([...active.characters, ...input.add_characters])];
      await this.graph.query(
        "MATCH (s:Scene {_uid: $_uid}) SET s.characters = $chars, s._updated_at = $now",
        { _uid: active._uid, chars: JSON.stringify(merged), now },
      );
    }

    if (input.end_time !== undefined) {
      // Close the current scene
      await this.graph.query(
        "MATCH (s:Scene {_uid: $_uid}) SET s.end_time = $end_time, s._updated_at = $now",
        { _uid: active._uid, end_time: input.end_time, now },
      );

      // Create placeholder
      const phUid = uuidv4();
      await this.graph.query(
        `CREATE (s:Scene {
           _uid: $_uid, start_time: $end_time, end_time: NULL,
           location_name: NULL, characters: $emptyArr, log: $emptyArr,
           options: NULL, _updated_at: $now
         })`,
        {
          _uid: phUid,
          end_time: input.end_time,
          emptyArr: JSON.stringify([]),
          now,
        },
      );

      await this.graph.mergeRelationship(
        "Scene", "_uid", active._uid,
        "Scene", "_uid", phUid,
        "NEXT_SCENE",
        { reason: input.reason ?? "" },
      );

      return this.getByUid(phUid);
    }

    return this.getActive();
  }

  async appendPlayerLog(sceneUid: string, userInput: string): Promise<void> {
    const entry: SceneLogEntry = { type: "player", content: userInput };
    const result = await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) RETURN s.log AS log",
      { _uid: sceneUid },
    );
    const currentLog: SceneLogEntry[] = result.rows[0]?.log
      ? (JSON.parse(result.rows[0].log as string) as SceneLogEntry[])
      : [];
    currentLog.push(entry);
    await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) SET s.log = $log, s._updated_at = $now",
      { _uid: sceneUid, log: JSON.stringify(currentLog), now: new Date().toISOString() },
    );
  }

  async appendGMLog(
    sceneUid: string,
    messages: SceneMessageContent[],
    options?: Record<string, unknown>,
  ): Promise<void> {
    const entry: SceneLogEntry = { type: "gm", content: messages, options };
    const result = await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) RETURN s.log AS log",
      { _uid: sceneUid },
    );
    const currentLog: SceneLogEntry[] = result.rows[0]?.log
      ? (JSON.parse(result.rows[0].log as string) as SceneLogEntry[])
      : [];
    currentLog.push(entry);
    const now = new Date().toISOString();
    await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) SET s.log = $log, s.options = $opts, s._updated_at = $now",
      { _uid: sceneUid, log: JSON.stringify(currentLog), opts: options ? JSON.stringify(options) : null, now },
    );
  }

  async appendRollLog(sceneUid: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    const entry: SceneLogEntry = { type: "roll", content, metadata };
    const result = await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) RETURN s.log AS log", { _uid: sceneUid },
    );
    const currentLog: SceneLogEntry[] = result.rows[0]?.log
      ? (JSON.parse(result.rows[0].log as string) as SceneLogEntry[])
      : [];
    currentLog.push(entry);
    await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) SET s.log = $log, s._updated_at = $now",
      { _uid: sceneUid, log: JSON.stringify(currentLog), now: new Date().toISOString() },
    );
  }

  async saveOptions(sceneUid: string, options: unknown): Promise<void> {
    await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) SET s.options = $options, s._updated_at = $now",
      { _uid: sceneUid, options: JSON.stringify(options), now: new Date().toISOString() },
    );
  }

  async getHistory(): Promise<SceneLogEntry[]> {
    const result = await this.graph.query(
      "MATCH (s:Scene) WHERE s.log IS NOT NULL RETURN s.log AS log ORDER BY s.start_time",
    );
    const allEntries: SceneLogEntry[] = [];
    for (const row of result.rows) {
      const log = row.log as string;
      if (log) {
        try {
          const entries = JSON.parse(log) as SceneLogEntry[];
          allEntries.push(...entries);
        } catch { /* skip unparseable */ }
      }
    }
    return allEntries;
  }

  async getChain(): Promise<SceneData[]> {
    const result = await this.graph.query(
      "MATCH (s:Scene) RETURN s ORDER BY s.start_time",
    );
    return result.rows.map((row) => {
      const s = (row.s || row) as Record<string, unknown>;
      return this.parseScene(s);
    });
  }

  private async getActiveRaw(): Promise<SceneData | null> {
    const result = await this.graph.query(
      "MATCH (s:Scene) WHERE s.end_time IS NULL RETURN s",
    );
    if (result.rows.length === 0) return null;
    const s = (result.rows[0].s || result.rows[0]) as Record<string, unknown>;
    return {
      _uid: s._uid as string,
      start_time: s.start_time as number,
      end_time: (s.end_time as number) ?? null,
      location_name: (s.location_name as string) ?? null,
      characters: (s.characters ? JSON.parse(s.characters as string) : []) as string[],
      log: (s.log ? JSON.parse(s.log as string) : []) as SceneLogEntry[],
      options: (s.options ? JSON.parse(s.options as string) : null) as Record<string, unknown> | null,
      _updated_at: (s._updated_at as string) ?? "",
    };
  }

  private async getByUid(_uid: string): Promise<SceneData> {
    const result = await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) RETURN s", { _uid },
    );
    const s = (result.rows[0].s || result.rows[0]) as Record<string, unknown>;
    return this.parseScene(s);
  }

  private parseScene(s: Record<string, unknown>): SceneData {
    return {
      _uid: s._uid as string,
      start_time: s.start_time as number,
      end_time: (s.end_time as number) ?? null,
      location_name: (s.location_name as string) ?? null,
      characters: (s.characters ? JSON.parse(s.characters as string) : []) as string[],
      log: (s.log ? JSON.parse(s.log as string) : []) as SceneLogEntry[],
      options: (s.options ? JSON.parse(s.options as string) : null) as Record<string, unknown> | null,
      _updated_at: (s._updated_at as string) ?? "",
    };
  }
}
