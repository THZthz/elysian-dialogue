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

import * as fs from "fs";
import { LadybugClient } from "@/server/db/ladybug";
import { VectorStore } from "@/server/db/vectorstore";
import { SchemaRegistry } from "@/server/db/schema";
import { CheckpointManager } from "@/server/db/checkpoint";
import { HybridSearcher } from "@/server/search/hybridSearch";
import { getEmbedder } from "@/server/search/embedder";
import { MessageModel } from "@/server/db/models/messages";
import { EntityModel } from "@/server/db/models/entities";
import { NoteModel } from "@/server/db/models/notes";
import { PlotModel } from "@/server/db/models/plots";
import { TimeModel } from "@/server/db/models/time";

export class Database {
  readonly graph: LadybugClient;
  readonly vectors: VectorStore;
  readonly schema: SchemaRegistry;
  readonly search: HybridSearcher;
  readonly checkpoint: CheckpointManager;

  messages!: MessageModel;
  entities!: EntityModel;
  notes!: NoteModel;
  plots!: PlotModel;
  time!: TimeModel;

  private readonly graphPath: string;
  private readonly vectorPath: string;
  private readonly checkpointDir: string;

  private constructor(graphPath: string, vectorPath: string, checkpointDir: string) {
    this.graphPath = graphPath;
    this.vectorPath = vectorPath;
    this.checkpointDir = checkpointDir;
    this.graph = new LadybugClient(graphPath);
    this.vectors = new VectorStore(vectorPath);
    this.schema = SchemaRegistry.getInstance();
    this.search = new HybridSearcher(this.vectors, getEmbedder());
    this.checkpoint = new CheckpointManager(graphPath, vectorPath, checkpointDir);
  }

  async init(): Promise<void> {
    await this.graph.init();
    this.vectors.init();

    // Load JSON extension for native JSON column type
    try {
      await this.graph.query("INSTALL json");
    } catch {
      /* already installed */
    }
    try {
      await this.graph.query("LOAD EXTENSION json");
    } catch {
      /* already loaded */
    }

    // Execute all DDL for predefined types
    const nodeDDL = this.schema.allNodeDDL();
    const relDDL = this.schema.allRelDDL();
    for (const ddl of [...nodeDDL, ...relDDL]) {
      try {
        await this.graph.query(ddl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string }).code;
        if (
          code === "CATALOG_ALREADY_EXISTS" ||
          msg.toLowerCase().includes("already exists") ||
          msg.toLowerCase().includes("duplicate table")
        ) {
          continue;
        }
        throw err;
      }
    }

    // Sync GM_DEFINED types from existing DB
    await this.schema.syncFromDB(this.graph);

    // Persist predefined metadata rows
    for (const nodeDef of this.schema.getAllNodeTypes()) {
      await this.schema.persistNodeType(this.graph, nodeDef.name);
    }
    for (const relDef of this.schema.getAllRelTypes()) {
      await this.schema.persistRelType(
        this.graph,
        relDef.name,
        relDef.sourceLabel,
        relDef.targetLabel,
      );
    }

    // Wire domain models
    const embedder = getEmbedder();
    this.messages = new MessageModel(this.graph, this.vectors, embedder);
    this.entities = new EntityModel(this.graph, this.vectors, embedder);
    this.notes = new NoteModel(this.graph, this.vectors, embedder);
    this.plots = new PlotModel(this.graph, this.vectors, embedder);
    this.time = new TimeModel(this.graph);
  }

  async close(): Promise<void> {
    await this.graph.close();
    this.vectors.close();
  }

  async reset(): Promise<void> {
    await this.close();
    if (fs.existsSync(this.graphPath)) fs.unlinkSync(this.graphPath);
    if (fs.existsSync(this.vectorPath)) fs.unlinkSync(this.vectorPath);
    Database.instance = null;
    SchemaRegistry.resetInstance();
    await Database.getInstance({
      graphPath: this.graphPath,
      vectorPath: this.vectorPath,
      checkpointDir: this.checkpointDir,
    });
  }

  // ── Singleton ──

  private static instance: Database | null = null;

  static async getInstance(options?: {
    graphPath?: string;
    vectorPath?: string;
    checkpointDir?: string;
  }): Promise<Database> {
    if (Database.instance) return Database.instance;

    const graphPath = options?.graphPath ?? "data/chorus.lbug";
    const vectorPath = options?.vectorPath ?? "data/chorus_vectors.db";
    const checkpointDir = options?.checkpointDir ?? "data/checkpoints";

    Database.instance = new Database(graphPath, vectorPath, checkpointDir);
    await Database.instance.init();
    return Database.instance;
  }

  static async closeInstance(): Promise<void> {
    if (Database.instance) {
      await Database.instance.close();
      Database.instance = null;
      SchemaRegistry.resetInstance();
    }
  }

  static getExisting(): Database {
    if (!Database.instance) throw new Error("Database not initialized. Call getInstance() first.");
    return Database.instance;
  }
}
