import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getNodeManager } from "@/server/nodeManager";
import { RelationshipManager } from "@/server/relationshipManager";
import { checkLabelRegistered, checkRelTypeRegistered } from "@/server/shared/schemaValidation";

describe("checkLabelRegistered", () => {
  // Singletons may carry state from other tests. Reset only clears GM_DEFINED.
  // We test against manually registered labels to be independent of seed state.

  it("returns null for a registered node label", () => {
    getNodeManager().register("TestLabel", "A test label", [], "GM_DEFINED");
    const result = checkLabelRegistered("TestLabel");
    expect(result).toBeNull();
  });

  it("returns error for an unregistered node label", () => {
    const result = checkLabelRegistered("DefinitelyNotRegisteredLabel_12345");
    expect(result).not.toBeNull();
    expect(result!).toContain("DefinitelyNotRegisteredLabel_12345");
    expect(result!).toContain("not registered");
    expect(result!).toContain("manageSchema");
  });

  it("returns null for a registered PREDEFINED label", () => {
    getNodeManager().register("TestChar", "desc", [], "PREDEFINED");
    const result = checkLabelRegistered("TestChar");
    expect(result).toBeNull();
  });

  it("excludes INTERNAL types from the available list in error message", () => {
    getNodeManager().register("_TestInternal", "hidden", [], "INTERNAL");
    const result = checkLabelRegistered("DefinitelyNotRegisteredLabel_12345");
    expect(result).not.toBeNull();
    expect(result!).not.toContain("_TestInternal");
  });
});

describe("checkRelTypeRegistered", () => {
  // RelationshipManager singleton may carry PREDEFINED types from seed/other tests.
  // reset() only clears GM_DEFINED. We register unique test types and clean up after.

  const testRelName = "ZZ_TestRel_Unique";

  afterEach(() => {
    // Clean up any GM_DEFINED registrations we made.
    RelationshipManager.getCachedInstance().unregister(testRelName, "", "");
    RelationshipManager.getCachedInstance().unregister(testRelName, "Character", "Location");
  });

  it("returns null for a registered relationship type", () => {
    RelationshipManager.getCachedInstance().register(
      testRelName, "Character", "Location", [], "GM_DEFINED",
    );
    const result = checkRelTypeRegistered(testRelName);
    expect(result).toBeNull();
  });

  it("returns null for wildcard-registered relationship type", () => {
    RelationshipManager.getCachedInstance().register(
      testRelName, "", "", [], "GM_DEFINED",
    );
    const result = checkRelTypeRegistered(testRelName);
    expect(result).toBeNull();
  });

  it("returns error for an unregistered relationship type", () => {
    const result = checkRelTypeRegistered("DefinitelyNotRegisteredRel_12345");
    expect(result).not.toBeNull();
    expect(result!).toContain("DefinitelyNotRegisteredRel_12345");
    expect(result!).toContain("not registered");
    expect(result!).toContain("manageSchema");
  });

  it("deduplicates relationship type names in the available list", () => {
    // The available list should not contain duplicate names.
    // (Same relationship name can be registered for multiple source/target combos.)
    const result = checkRelTypeRegistered("DefinitelyNotRegisteredRel_12345");
    expect(result).not.toBeNull();
    // Extract the "Available: ..." portion and verify no duplicates
    const match = result!.match(/Available: (.+)$/);
    expect(match).not.toBeNull();
    const names = match![1].split(", ");
    expect(new Set(names).size).toBe(names.length);
  });
});
