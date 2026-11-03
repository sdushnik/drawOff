/**
 * THE services layer. Every backend call the app makes goes through this
 * interface — components never talk to a transport directly.
 *
 * Implementations:
 *  - mock/mockGameService.ts — in-browser authoritative engine + demo players (default)
 *  - a real implementation (e.g. Socket.IO client) can be dropped in via services/index.ts
 */
import type { Cycles, DrawOp, PlayerView, Session } from "@/game/types";

export type ServiceErrorCode =
  | "INVALID_INPUT"
  | "ROOM_NOT_FOUND"
  | "MATCH_IN_PROGRESS"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "WRONG_PHASE"
  | "NOT_ENOUGH_PLAYERS"
  | "PAUSED"
  | "DEADLINE_PASSED"
  | "NETWORK";

export class ServiceError extends Error {
  constructor(
    public code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export type Unsubscribe = () => void;

export interface GameService {
  readonly capabilities: {
    /** Backend can add simulated players (mock only). */
    demoPlayers: boolean;
    /** Short human label shown in the UI, e.g. "Offline demo". */
    label: string;
  };

  createRoom(name: string): Promise<Session>;
  joinRoom(code: string, name: string): Promise<Session>;
  /** Re-attach after refresh. Rejects with ROOM_NOT_FOUND / UNAUTHORIZED if gone. */
  resumeSession(session: Session): Promise<Session>;
  leaveRoom(session: Session): Promise<void>;

  kickPlayer(session: Session, playerId: string): Promise<void>;
  setCycles(session: Session, cycles: Cycles): Promise<void>;
  addDemoPlayer(session: Session): Promise<void>;
  startMatch(session: Session): Promise<void>;

  selectPrompt(session: Session, prompt: string): Promise<void>;
  sendDrawOps(session: Session, ops: DrawOp[]): Promise<void>;
  submitCanvas(session: Session): Promise<void>;
  submitRatings(session: Session, ratings: Record<string, number>): Promise<void>;

  rematch(session: Session): Promise<void>;
  returnToLobby(session: Session): Promise<void>;

  /** Push-based, privacy-filtered state for this player. Fires immediately once. */
  subscribe(
    session: Session,
    onView: (view: PlayerView) => void,
    onError?: (error: ServiceError) => void,
  ): Unsubscribe;
}
