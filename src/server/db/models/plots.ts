import type { LadybugClient } from "@/server/db/ladybug";
import type { VectorStore } from "@/server/db/vectorstore";
import type { Embedder } from "@/server/search/embedder";
import { getNodeManager } from "@/server/db/schema";
import { encodeSparse } from "@/server/search/sparseEncoder";

export type PlotStatus = "PENDING" | "ACTIVE" | "COMPLETED" | "ABANDONED";
export const PLOT_STATUSES = ["PENDING", "ACTIVE", "COMPLETED", "ABANDONED"] as const;

export interface PlotFlag {
  flagId: string;
  description: string;
}

export interface MemoryPlot {
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

  async create(name: string, description: string, brief: string, status: PlotStatus, trigger_condition?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.graph.query(
      `MERGE (p:Plot {name: $name})
       ON CREATE SET p.description = $desc, p.brief = $brief, p.status = $status, p.trigger_condition = $trigger, p.flags = '[]', p._created_at = $now, p._updated_at = $now
       ON MATCH SET p.description = $desc, p.brief = $brief, p.status = $status, p.trigger_condition = $trigger, p._updated_at = $now`,
      { name, desc: description, brief, status, trigger: trigger_condition ?? "", now },
    );

    const contentText = getNodeManager().getEmbeddingContentText("Plot", { name, description, brief });
    const [nameVec, contentVec] = await Promise.all([
      this.embedder.embed(name),
      this.embedder.embed(contentText || `${name} ${brief} ${description}`),
    ]);
    this.vectors.upsert(`Plot:${name}`, "Plot", "node", new Float32Array(nameVec), new Float32Array(contentVec),
      encodeSparse(contentText || name), { node_type: "Plot", kind: "node", object_id: `Plot:${name}`, text: contentText, name, description, brief, status, trigger_condition: trigger_condition ?? "", flags: "[]" });
  }

  async getByName(name: string): Promise<MemoryPlot | null> {
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
      flags: typeof p.flags === "string" ? JSON.parse(p.flags) as PlotFlag[] : (p.flags as PlotFlag[]) ?? [],
      children,
    };
  }

  async update(name: string, props: { description?: string; brief?: string; status?: PlotStatus; trigger_condition?: string }): Promise<void> {
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
    const plotFlags: PlotFlag[] = flags.map(f => ({ flagId: f, description: "" }));
    await this.graph.query("MATCH (p:Plot {name: $name}) SET p.flags = $flags, p._updated_at = $now",
      { name, flags: JSON.stringify(plotFlags), now: new Date().toISOString() });
  }

  async branch(parentName: string, childName: string): Promise<void> {
    await this.graph.mergeRelationship("Plot", "name", parentName, "Plot", "name", childName, "BRANCHES_TO");
  }

  async unbranch(parentName: string, childName: string): Promise<void> {
    await this.graph.deleteRelationship("Plot", "name", parentName, "Plot", "name", childName, "BRANCHES_TO");
  }

  async getChildren(name: string): Promise<string[]> {
    const r = await this.graph.query("MATCH (p:Plot {name: $name})-[:BRANCHES_TO]->(child:Plot) RETURN child.name AS name", { name });
    return r.rows.map((row) => row.name as string);
  }

  async markPlotTimeRel(name: string, relType: string): Promise<void> {
    await this.graph.query(
      `MATCH (a:TimeAnchor {_id: 'anchor'})-[:CURRENT_TIMEPOINT]->(tp:TimePoint)
       MATCH (p:Plot {name: $name})
       MERGE (p)-[r:\`${relType}\`]->(tp)
       ON CREATE SET r._created_at = current_timestamp()`,
      { name },
    );
  }
}
