import { describe, it, expect, beforeEach } from "vitest";
import { TurnStateMachine, TurnPhase } from "@/server/turnState";

describe("TurnStateMachine", () => {
  let sm: TurnStateMachine;

  beforeEach(() => {
    sm = new TurnStateMachine();
  });

  describe("initial state", () => {
    it("starts in START phase", () => {
      expect(sm.phase).toBe(TurnPhase.START);
    });

    it("has no tool calls", () => {
      expect(sm.getToolCallsForAssistant(false)).toEqual([]);
      expect(sm.getToolCallsForAssistant(true)).toEqual([]);
    });

    it("has no dialogue params", () => {
      expect(sm.getDialogueParams()).toBeNull();
    });
  });

  describe("recordToolCall", () => {
    it("transitions from START to GM_DRAFTING on editNote", () => {
      sm.recordToolCall("editNote");
      expect(sm.phase).toBe(TurnPhase.GM_DRAFTING);
    });

    it("transitions from START to GM_DELEGATING on delegateToAssistant", () => {
      sm.recordToolCall("delegateToAssistant");
      expect(sm.phase).toBe(TurnPhase.GM_DELEGATING);
    });

    it("transitions to DIALOGUE_SENDING on generateDialogueStep", () => {
      sm.recordToolCall("editNote");
      sm.recordToolCall("generateDialogueStep");
      expect(sm.phase).toBe(TurnPhase.DIALOGUE_SENDING);
    });

    it("switches between GM_DELEGATING and GM_DRAFTING", () => {
      sm.recordToolCall("delegateToAssistant");
      expect(sm.phase).toBe(TurnPhase.GM_DELEGATING);
      sm.recordToolCall("editPlot");
      expect(sm.phase).toBe(TurnPhase.GM_DRAFTING);
      sm.recordToolCall("delegateToAssistant");
      expect(sm.phase).toBe(TurnPhase.GM_DELEGATING);
    });

    it("does not change phase for same-type tool calls", () => {
      sm.recordToolCall("editNote");
      expect(sm.phase).toBe(TurnPhase.GM_DRAFTING);
      sm.recordToolCall("editPlot");
      expect(sm.phase).toBe(TurnPhase.GM_DRAFTING);
    });

    it("does not change phase from DIALOGUE_SENDING on non-dialogue tools", () => {
      sm.recordToolCall("generateDialogueStep");
      sm.recordToolCall("editNote");
      expect(sm.phase).toBe(TurnPhase.DIALOGUE_SENDING);
    });

    it("rejects tool calls after PERSISTING", () => {
      sm.startPersist();
      sm.recordToolCall("editNote");
      expect(sm.getToolCallsForAssistant(true)).toHaveLength(0);
    });

    it("rejects tool calls after COMPLETE", () => {
      sm.complete();
      sm.recordToolCall("editNote");
      expect(sm.getToolCallsForAssistant(true)).toHaveLength(0);
    });

    it("stores tool name without params when includeParams is false", () => {
      sm.recordToolCall("editNote", { title: "test" });
      const calls = sm.getToolCallsForAssistant(false);
      expect(calls).toEqual([{ name: "editNote" }]);
    });

    it("stores tool name with params when includeParams is true", () => {
      sm.recordToolCall("editNote", { title: "test" });
      const calls = sm.getToolCallsForAssistant(true);
      expect(calls).toEqual([{ name: "editNote", params: { title: "test" } }]);
    });

    it("advanceTime maps to GM_DRAFTING", () => {
      sm.recordToolCall("advanceTime");
      expect(sm.phase).toBe(TurnPhase.GM_DRAFTING);
    });

    it("searchWorld maps to GM_DRAFTING", () => {
      sm.recordToolCall("searchWorld");
      expect(sm.phase).toBe(TurnPhase.GM_DRAFTING);
    });
  });

  describe("dialogueValidated", () => {
    it("stores dialogue params", () => {
      const params = {
        messages: [{ speaker: "NARRATOR", type: "SYSTEM" as const, text: "Hello." }],
        options: [{ text: "Go" }, { text: "Stay" }],
      };
      sm.dialogueValidated(params);
      expect(sm.getDialogueParams()).toEqual(params);
    });

    it("does not change phase", () => {
      sm.recordToolCall("generateDialogueStep");
      const phaseBefore = sm.phase;
      sm.dialogueValidated({
        messages: [{ speaker: "N", type: "SYSTEM" as const, text: "Hi." }],
        options: [{ text: "A" }, { text: "B" }],
      });
      expect(sm.phase).toBe(phaseBefore);
    });
  });

  describe("phase transitions", () => {
    it("startPersist transitions to PERSISTING", () => {
      sm.startPersist();
      expect(sm.phase).toBe(TurnPhase.PERSISTING);
    });

    it("complete transitions to COMPLETE", () => {
      sm.complete();
      expect(sm.phase).toBe(TurnPhase.COMPLETE);
    });
  });

  describe("events", () => {
    it("emits phaseChange on transition", () => {
      const events: Array<{ phase: TurnPhase; prevPhase: TurnPhase }> = [];
      sm.on("phaseChange", (e) => events.push(e));

      sm.recordToolCall("editNote");
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ phase: TurnPhase.GM_DRAFTING, prevPhase: TurnPhase.START });
    });

    it("does not emit when phase does not change", () => {
      const events: Array<{ phase: TurnPhase; prevPhase: TurnPhase }> = [];
      sm.on("phaseChange", (e) => events.push(e));

      sm.recordToolCall("editNote");
      sm.recordToolCall("editPlot");
      expect(events).toHaveLength(1);
    });

    it("unsubscribe works", () => {
      const events: string[] = [];
      const unsub = sm.on("phaseChange", (e) => events.push(e.phase));
      unsub();
      sm.recordToolCall("editNote");
      expect(events).toHaveLength(0);
    });

    it("emits on startPersist", () => {
      const events: Array<{ phase: TurnPhase; prevPhase: TurnPhase }> = [];
      sm.on("phaseChange", (e) => events.push(e));
      sm.startPersist();
      expect(events).toHaveLength(1);
      expect(events[0].phase).toBe(TurnPhase.PERSISTING);
    });

    it("emits on complete", () => {
      const events: Array<{ phase: TurnPhase; prevPhase: TurnPhase }> = [];
      sm.on("phaseChange", (e) => events.push(e));
      sm.complete();
      expect(events).toHaveLength(1);
      expect(events[0].phase).toBe(TurnPhase.COMPLETE);
    });
  });
});
