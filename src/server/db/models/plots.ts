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

import type { LadybugClient } from "@/server/db/ladybug";
import type { VectorStore } from "@/server/db/vectorstore";
import type { Embedder } from "@/server/search/embedder";
import { getSchemaRegistry } from "@/server/db/schema";
import { encodeSparse } from "@/server/search/sparseEncoder";

export type PlotStatus = "PENDING" | "ACTIVE" | "COMPLETED" | "ABANDONED";
export const PLOT_STATUSES = ["PENDING", "ACTIVE", "COMPLETED", "ABANDONED"] as const;

export interface PlotFlag {
  flagId: string;
  description: string;
}

export interface Plot {
  name: string;
  description: string;
  brief: string;
  status: PlotStatus;
  trigger_condition: string;
  flags: PlotFlag[];
  children: string[];
}

export class PlotModel {
  constructor(
    private readonly graph: LadybugClient,
    private readonly vectors: VectorStore,
    private readonly embedder: Embedder,
  ) {}

  async create(
    name: string,
    description: string,
    brief: string,
    status: PlotStatus,
    trigger_condition?: string,
  ): Promise<void> {
    const registry = getSchemaRegistry();

    const now = new Date().toISOString();
    await this.graph.query(
      `CREATE (p:Plot {name: $name, description: $ddesc, _created_at: $now, _updated_at: $now})`,
      { name, ddesc: description, now },
    );
    await this.graph.query(`MATCH (p:Plot {name: $name}) SET p.brief = $brief`, { name, brief });
    await this.graph.query(`MATCH (p:Plot {name: $name}) SET p.status = $status`, { name, status });
    await this.graph.query(`MATCH (p:Plot {name: $name}) SET p.trigger_condition = $trigger`, {
      name,
      trigger: trigger_condition ?? "",
    });
    await this.graph.query(`MATCH (p:Plot {name: $name}) SET p.flags = $flags`, {
      name,
      flags: "[]",
    });

    const contentText = registry.getEmbeddingText("Plot", {
      name,
      description,
      brief,
    });
    const contentVec = await this.embedder.embed(contentText || `${name} ${brief} ${description}`);
    this.vectors.upsert(
      `Plot:${name}`,
      "Plot",
      "node",
      new Float32Array(contentVec),
      encodeSparse(contentText || name),
      {
        node_type: "Plot",
        kind: "node",
        object_id: `Plot:${name}`,
        text: contentText,
        name,
        description,
        brief,
        status,
        trigger_condition: trigger_condition ?? "",
        flags: "[]",
      },
    );
  }

  async getByName(name: string): Promise<Plot | null> {
    const r = await this.graph.query("MATCH (p:Plot {name: $name}) RETURN p", { name });
    if (r.rows.length === 0) return null;
    const p = (r.rows[0].p || r.rows[0]) as Record<string, unknown>;
    const children = await this.getChildren(name);
    return {
      name: p.name as string,
      description: (p.description as string) ?? "",
      brief: (p.brief as string) ?? "",
      status: (p.status as PlotStatus) ?? "PENDING",
      trigger_condition: (p.trigger_condition as string) ?? "",
      flags: (p.flags as PlotFlag[]) ?? [],
      children,
    };
  }

  async update(
    name: string,
    props: {
      description?: string;
      brief?: string;
      status?: PlotStatus;
      trigger_condition?: string;
    },
  ): Promise<void> {
    const setClauses: string[] = ["p._updated_at = $now"];
    const params: Record<string, unknown> = { name, now: new Date().toISOString() };
    for (const [k, v] of Object.entries(props)) {
      if (v !== undefined) {
        setClauses.push(`p.\`${k}\` = $p_${k}`);
        params[`p_${k}`] = v;
      }
    }
    await this.graph.query(`MATCH (p:Plot {name: $name}) SET ${setClauses.join(", ")}`, params);
  }

  async delete(name: string): Promise<void> {
    this.vectors.delete(`Plot:${name}`);
    await this.graph.query("MATCH (p:Plot {name: $name}) DETACH DELETE p", { name });
  }

  async setFlags(name: string, flags: string[]): Promise<void> {
    const plotFlags: PlotFlag[] = flags.map((f) => ({ flagId: f, description: "" }));
    await this.graph.query(
      "MATCH (p:Plot {name: $name}) SET p.flags = $flags, p._updated_at = $now",
      { name, flags: JSON.stringify(plotFlags), now: new Date().toISOString() },
    );
  }

  async branch(parentName: string, childName: string): Promise<void> {
    await this.graph.mergeRelationship(
      "Plot",
      "name",
      parentName,
      "Plot",
      "name",
      childName,
      "BRANCHES_TO",
    );
  }

  async unbranch(parentName: string, childName: string): Promise<void> {
    await this.graph.deleteRelationship(
      "Plot",
      "name",
      parentName,
      "Plot",
      "name",
      childName,
      "BRANCHES_TO",
    );
  }

  async getChildren(name: string): Promise<string[]> {
    const r = await this.graph.query(
      "MATCH (p:Plot {name: $name})-[:BRANCHES_TO]->(child:Plot) RETURN child.name AS name",
      { name },
    );
    return r.rows.map((row) => row.name as string);
  }

  async markPlotTimeRel(name: string, relType: string): Promise<void> {
    await this.graph.query(
      `MATCH (s:Scene) WHERE s.end_time IS NULL
       MATCH (p:Plot {name: $name})
       MERGE (p)-[r:\`${relType}\`]->(s)
       ON CREATE SET r._created_at = current_timestamp()`,
      { name },
    );
  }
}
