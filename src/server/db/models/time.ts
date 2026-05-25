import { v4 as uuidv4 } from "uuid";
import type { LadybugClient } from "@/server/db/ladybug";

export interface TimePoint {
  _id: string;
  day: number;
  hour: number;
  label: string;
  _created_at: string;
}

export class TimeModel {
  constructor(private readonly graph: LadybugClient) {}

  async getCurrentTimePoint(): Promise<TimePoint | null> {
    const result = await this.graph.query(
      `MATCH (a:TimeAnchor {_id: 'anchor'})-[:CURRENT_TIMEPOINT]->(tp:TimePoint)
       RETURN tp`
    );
    if (result.rows.length === 0) return null;
    const tp = (result.rows[0].tp || result.rows[0]) as Record<string, unknown>;
    return { _id: tp._id as string, day: tp.day as number, hour: tp.hour as number, label: tp.label as string };
  }

  async setInitialTime(day: number, hour: number, label: string): Promise<void> {
    const _id = uuidv4();
    const now = new Date().toISOString();
    await this.graph.query(
      `MERGE (a:TimeAnchor {_id: 'anchor'})
       CREATE (new:TimePoint {_id: $_id, day: $day, hour: $hour, label: $label, _created_at: $now})
       CREATE (a)-[r:CURRENT_TIMEPOINT {_created_at: $now}]->(new)`,
      { _id, day, hour, label, now },
    );
  }

  async advanceGameTime(halfHours: number, reason?: string): Promise<TimePoint> {
    const current = await this.getCurrentTimePoint();
    if (!current) throw new Error("TimePoint not initialized");

    const totalHalfHours = Math.round(current.day * 48 + current.hour * 2 + halfHours);
    const newDay = Math.floor(totalHalfHours / 48);
    const newHour = (totalHalfHours % 48) / 2;

    const SEGMENT_LABELS = ["Midnight", "Late Night", "Early Morning", "Morning", "Late Morning", "Noon", "Afternoon", "Late Afternoon", "Evening", "Night", "Late Night", "Midnight"];
    const segmentIdx = Math.floor(newHour / 2);
    const newLabel = SEGMENT_LABELS[Math.min(segmentIdx, SEGMENT_LABELS.length - 1)];

    const _id = uuidv4();
    const now = new Date().toISOString();

    await this.graph.query(
      `MATCH (a:TimeAnchor {_id: 'anchor'})
       MATCH (old:TimePoint {_id: $oldId})
       MATCH (a)-[r_del:CURRENT_TIMEPOINT]->(old)
       CREATE (new:TimePoint {_id: $_id, day: $newDay, hour: $newHour, label: $newLabel, _created_at: $now})
       CREATE (old)-[r1:NEXT_TIMEPOINT]->(new)
       DELETE r_del
       CREATE (a)-[r2:CURRENT_TIMEPOINT {_created_at: $now}]->(new)`,
      { oldId: current._id, _id, newDay, newHour, newLabel, now },
    );

    if (reason) {
      await this.graph.query(
        `MATCH (old:TimePoint {_id: $oldId})-[r:NEXT_TIMEPOINT]->(new:TimePoint {_id: $_id})
         SET r.reason = $reason`,
        { oldId: current._id, _id, reason },
      );
    }

    return { _id, day: newDay, hour: newHour, label: newLabel };
  }
}
