import { getNodeManager } from "@/server/nodeManager";
import { RelationshipManager } from "@/server/relationshipManager";

export function checkLabelRegistered(label: string): string | null {
  const nodeManager = getNodeManager();
  const def = nodeManager.get(label);
  if (!def) {
    const available = [...new Set(
      nodeManager
        .getAll()
        .filter((n) => n.type !== "INTERNAL")
        .map((n) => n.name),
    )].join(", ");
    return `ERROR: Node label "${label}" is not registered. Use manageSchema to register it first. Available: ${available}.`;
  }
  return null;
}

export function checkRelTypeRegistered(relType: string): string | null {
  const relManager = RelationshipManager.getCachedInstance();
  const all = relManager.getAll();
  const found = all.some((r) => r.name === relType);
  if (!found) {
    const available = [...new Set(
      all
        .filter((r) => r.type !== "INTERNAL")
        .map((r) => r.name),
    )].join(", ");
    return `ERROR: Relationship type "${relType}" is not registered. Use manageSchema to register it first. Available: ${available}.`;
  }
  return null;
}
