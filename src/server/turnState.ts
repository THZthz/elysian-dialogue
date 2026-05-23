import { EventEmitter } from "node:events";
import type { DialogueArgs } from "@/server/tools/generateDialogueStep";

export enum TurnPhase {
  START = "START",
  GM_DELEGATING = "GM_DELEGATING",
  GM_DRAFTING = "GM_DRAFTING",
  DIALOGUE_SENDING = "DIALOGUE_SENDING",
  PERSISTING = "PERSISTING",
  COMPLETE = "COMPLETE",
}

export interface PhaseChangeEvent {
  phase: TurnPhase;
  prevPhase: TurnPhase;
}

interface RecordedToolCall {
  name: string;
  params?: Record<string, unknown>;
}

export class TurnStateMachine {
  private _phase: TurnPhase = TurnPhase.START;
  private toolCalls: RecordedToolCall[] = [];
  private dialogueArgs: DialogueArgs | null = null;
  private emitter = new EventEmitter();

  get phase(): TurnPhase {
    return this._phase;
  }

  on(event: "phaseChange", listener: (data: PhaseChangeEvent) => void): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  recordToolCall(name: string, params?: Record<string, unknown>): void {
    if (this._phase === TurnPhase.PERSISTING || this._phase === TurnPhase.COMPLETE) {
      return;
    }

    this.toolCalls.push({ name, params });

    const prevPhase = this._phase;

    if (name === "generateDialogueStep") {
      if (this._phase !== TurnPhase.DIALOGUE_SENDING) {
        this._phase = TurnPhase.DIALOGUE_SENDING;
        this.emitter.emit("phaseChange", { phase: this._phase, prevPhase });
      }
      return;
    }

    const newPhase = this.toolToPhase(name);

    if (this._phase === TurnPhase.START && newPhase !== TurnPhase.START) {
      this._phase = newPhase;
      this.emitter.emit("phaseChange", { phase: this._phase, prevPhase });
      return;
    }

    if (
      this._phase !== TurnPhase.START &&
      this._phase !== TurnPhase.DIALOGUE_SENDING &&
      newPhase !== this._phase
    ) {
      this._phase = newPhase;
      this.emitter.emit("phaseChange", { phase: this._phase, prevPhase });
    }
  }

  dialogueValidated(params: DialogueArgs): void {
    this.dialogueArgs = params;
  }

  startPersist(): void {
    const prevPhase = this._phase;
    this._phase = TurnPhase.PERSISTING;
    this.emitter.emit("phaseChange", { phase: this._phase, prevPhase });
  }

  complete(): void {
    const prevPhase = this._phase;
    this._phase = TurnPhase.COMPLETE;
    this.emitter.emit("phaseChange", { phase: this._phase, prevPhase });
  }

  getToolCallsForAssistant(includeParams: boolean): Array<{ name: string; params?: Record<string, unknown> }> {
    if (includeParams) {
      return [...this.toolCalls];
    }
    return this.toolCalls.map((tc) => ({ name: tc.name }));
  }

  getDialogueParams(): DialogueArgs | null {
    return this.dialogueArgs;
  }

  private toolToPhase(name: string): TurnPhase {
    switch (name) {
      case "delegateToAssistant":
        return TurnPhase.GM_DELEGATING;
      case "editNote":
      case "editPlot":
      case "searchWorld":
      case "advanceTime":
        return TurnPhase.GM_DRAFTING;
      default:
        return TurnPhase.START;
    }
  }
}
