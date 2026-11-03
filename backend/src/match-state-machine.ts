import {
  pickSuggestions,
  applyOps,
  cloneCanvas,
  emptyCanvas,
  type CanvasSnapshot,
  type DrawOp,
  type PlayerView,
  type Session,
} from "@drawoff/contracts";
import { playerViewSchema } from "@drawoff/contracts";
import {
  getMatchRoundAssignment,
  RoomService,
  RoomServiceError,
  type RoomSnapshot,
} from "./room-service.js";

export const MATCH_PHASE_DURATIONS_MS = {
  ROLE_REVEAL: 4_000,
  WORD_SELECTION: 30_000,
  DRAWING: 60_000,
  ROUND_RESULT: 12_000,
  JUDGE_MINIMUM: 45_000,
  JUDGE_PER_ARTIST: 15_000,
} as const;

type MatchPhase =
  | "ROLE_REVEAL"
  | "WORD_SELECTION"
  | "DRAWING"
  | "JUDGING"
  | "ROUND_RESULT"
  | "FINAL_RESULT";
type TimerHandle = ReturnType<typeof setTimeout>;

interface MatchProgress {
  phase: MatchPhase;
  phaseStartedAt: number;
  deadline: number | null;
  roundIndex: number;
  suggestions: string[];
  prompt: string | null;
  usedPrompts: string[];
  canvases: Map<string, ArtistCanvas>;
  generation: number;
  timer: TimerHandle | null;
}

interface ArtistCanvas {
  canvas: CanvasSnapshot;
  locked: boolean;
}

export interface MatchStateMachineOptions {
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  onTransition?: (roomCode: string) => void;
}

export class MatchStateMachine {
  private readonly progress = new Map<string, MatchProgress>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly onTransition: (roomCode: string) => void;

  constructor(
    private readonly rooms: RoomService,
    options: MatchStateMachineOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onTransition = options.onTransition ?? (() => undefined);
  }

  startMatch(session: Session): void {
    const now = this.readClock();
    const deadline = now + MATCH_PHASE_DURATIONS_MS.ROLE_REVEAL;
    if (!Number.isFinite(deadline)) {
      throw new RoomServiceError("REQUEST_FAILED", "The match deadline could not be set.");
    }
    this.rooms.startMatch(session);
    const room = this.rooms.getRoom(session.roomCode);
    if (!room.matchSchedule) {
      throw new RoomServiceError("REQUEST_FAILED", "The match schedule could not be created.");
    }

    this.clearProgress(session.roomCode);
    const progress: MatchProgress = {
      phase: "ROLE_REVEAL",
      phaseStartedAt: now,
      deadline,
      roundIndex: 0,
      suggestions: [],
      prompt: null,
      usedPrompts: [],
      canvases: new Map(),
      generation: 0,
      timer: null,
    };
    this.progress.set(session.roomCode, progress);
    this.scheduleTimer(session.roomCode, progress);
    this.onTransition(session.roomCode);
  }

  selectPrompt(session: Session, rawPrompt: unknown): void {
    const { room, player, progress } = this.requireMatchMember(session);
    this.requirePhase(progress, "WORD_SELECTION");
    this.requireJudge(room, player.id, progress.roundIndex);
    this.requireBeforeDeadline(progress);
    const prompt = normalizePrompt(rawPrompt);
    this.finalizePrompt(session.roomCode, progress, prompt);
  }

  /** Called by rating handling after ratings have been accepted and recorded. */
  finishJudging(session: Session): void {
    const { room, player, progress } = this.requireMatchMember(session);
    this.requirePhase(progress, "JUDGING");
    this.requireJudge(room, player.id, progress.roundIndex);
    this.requireBeforeDeadline(progress);
    this.transition(
      session.roomCode,
      progress,
      "ROUND_RESULT",
      MATCH_PHASE_DURATIONS_MS.ROUND_RESULT,
    );
  }

  sendDrawOps(session: Session, ops: DrawOp[]): void {
    const { player, progress } = this.requireArtistDrawing(session);
    this.requireBeforeDeadline(progress);
    const drawing = progress.canvases.get(player.id)!;
    if (drawing.locked) {
      throw new RoomServiceError("FORBIDDEN", "Your drawing is already submitted.");
    }

    const next = cloneCanvas(drawing.canvas);
    for (const op of ops) {
      const canUndo = next.actions.length > 0;
      const accepted = applyOps(next, [op]);
      if (accepted === 0 && !(op.type === "undo" && !canUndo)) {
        throw new RoomServiceError("REQUEST_FAILED", "The drawing operation could not be committed.");
      }
    }
    drawing.canvas = next;
  }

  submitCanvas(session: Session): void {
    const { player, progress } = this.requireArtistDrawing(session);
    this.requireBeforeDeadline(progress);
    const drawing = progress.canvases.get(player.id)!;
    drawing.locked = true;
  }

  getPlayerView(session: Session): PlayerView {
    const authenticated = this.rooms.resumeSession(session);
    const room = this.rooms.getRoom(authenticated.roomCode);
    const lobbyView = this.rooms.getLobbyView(authenticated);
    const progress = this.progress.get(room.code);
    if (!progress || !room.matchSchedule) return lobbyView;

    const assignment = getMatchRoundAssignment(room.matchSchedule, progress.roundIndex);
    const role =
      progress.phase === "FINAL_RESULT"
        ? null
        : assignment.judgeId === authenticated.playerId
          ? "judge"
          : assignment.artistIds.includes(authenticated.playerId)
            ? "artist"
            : null;

    return playerViewSchema.parse({
      ...lobbyView,
      serverNow: this.readClock(),
      phase: progress.phase,
      deadline: progress.deadline,
      matchStarted: true,
      role,
      prompt:
        progress.prompt !== null &&
        ["DRAWING", "JUDGING", "ROUND_RESULT", "FINAL_RESULT"].includes(progress.phase)
          ? progress.prompt
          : null,
      suggestions:
        progress.phase === "WORD_SELECTION" && role === "judge"
          ? [...progress.suggestions]
          : null,
      myCanvas:
        role === "artist" &&
        ["DRAWING", "JUDGING", "ROUND_RESULT", "FINAL_RESULT"].includes(progress.phase)
          ? (() => {
              const drawing = progress.canvases.get(authenticated.playerId);
              return drawing
                ? {
                    canvas: cloneCanvas(drawing.canvas),
                    locked:
                      drawing.locked ||
                      progress.phase !== "DRAWING" ||
                      (progress.deadline !== null && this.readClock() >= progress.deadline),
                  }
                : null;
            })()
          : null,
      match: {
        roundIndex: progress.roundIndex,
        totalRounds: room.matchSchedule.totalRounds,
        cycle: Math.floor(progress.roundIndex / room.matchSchedule.order.length) + 1,
        judgeId: assignment.judgeId,
        artistIds: [...assignment.artistIds],
        order: [...room.matchSchedule.order],
        scores: Object.fromEntries(room.matchSchedule.order.map((playerId) => [playerId, 0])),
      },
    });
  }

  /** Process due server-clock transitions; safe to call repeatedly or alongside timers. */
  tick(): void {
    const now = this.readClock();
    for (const [roomCode, progress] of this.progress) {
      if (progress.deadline !== null && now >= progress.deadline) {
        this.processDeadline(roomCode, progress.generation, now);
      }
    }
  }

  dispose(): void {
    for (const progress of this.progress.values()) {
      if (progress.timer !== null) this.clearTimer(progress.timer);
    }
    this.progress.clear();
  }

  private requireMatchMember(session: Session): {
    room: RoomSnapshot;
    player: RoomSnapshot["players"][number];
    progress: MatchProgress;
  } {
    const authenticated = this.rooms.resumeSession(session);
    const room = this.rooms.getRoom(authenticated.roomCode);
    const player = room.players.find(({ id }) => id === authenticated.playerId);
    if (!player) {
      throw new RoomServiceError("UNAUTHORIZED", "Your session is no longer valid. Rejoin the room.");
    }
    if (!room.matchSchedule?.order.includes(player.id)) {
      throw new RoomServiceError("FORBIDDEN", "Only players in the active match can act.");
    }
    const progress = this.progress.get(room.code);
    if (!progress) {
      throw new RoomServiceError("WRONG_PHASE", "There is no active match phase.");
    }
    return { room, player, progress };
  }

  private requirePhase(progress: MatchProgress, phase: MatchPhase): void {
    if (progress.phase !== phase) {
      throw new RoomServiceError("WRONG_PHASE", "That action is not allowed in the current phase.");
    }
  }

  private requireJudge(room: RoomSnapshot, playerId: string, roundIndex: number): void {
    if (!room.matchSchedule || getMatchRoundAssignment(room.matchSchedule, roundIndex).judgeId !== playerId) {
      throw new RoomServiceError("FORBIDDEN", "Only the current judge can advance this phase.");
    }
  }

  private requireArtistDrawing(
    session: Session,
  ): {
    player: RoomSnapshot["players"][number];
    progress: MatchProgress;
  } {
    const { room, player, progress } = this.requireMatchMember(session);
    this.requirePhase(progress, "DRAWING");
    const assignment = getMatchRoundAssignment(room.matchSchedule!, progress.roundIndex);
    if (!assignment.artistIds.includes(player.id)) {
      throw new RoomServiceError("FORBIDDEN", "Only an Artist can edit a drawing.");
    }
    const drawing = progress.canvases.get(player.id);
    if (!drawing) {
      throw new RoomServiceError("WRONG_PHASE", "The Artist drawing is not available.");
    }
    return { player, progress };
  }

  private requireBeforeDeadline(progress: MatchProgress): void {
    if (progress.deadline !== null && this.readClock() >= progress.deadline) {
      throw new RoomServiceError("DEADLINE_PASSED", "The phase deadline has passed.");
    }
  }

  private processDeadline(roomCode: string, generation: number, now: number): void {
    const progress = this.progress.get(roomCode);
    if (
      !progress ||
      progress.generation !== generation ||
      progress.deadline === null ||
      now < progress.deadline
    ) {
      return;
    }

    switch (progress.phase) {
      case "ROLE_REVEAL":
        progress.suggestions = pickSuggestions(
          this.random,
          3,
          new Set(progress.usedPrompts),
        );
        progress.prompt = null;
        this.transition(
          roomCode,
          progress,
          "WORD_SELECTION",
          MATCH_PHASE_DURATIONS_MS.WORD_SELECTION,
          progress.deadline,
        );
        break;
      case "WORD_SELECTION": {
        const prompt = progress.suggestions[this.randomIndex(progress.suggestions.length)]!;
        this.finalizePrompt(roomCode, progress, prompt, progress.deadline);
        break;
      }
      case "DRAWING": {
        const room = this.rooms.getRoom(roomCode);
        const artistCount = room.matchSchedule?.order.length
          ? room.matchSchedule.order.length - 1
          : 0;
        const judgingDuration = Math.max(
          MATCH_PHASE_DURATIONS_MS.JUDGE_MINIMUM,
          MATCH_PHASE_DURATIONS_MS.JUDGE_PER_ARTIST * artistCount,
        );
        this.transition(
          roomCode,
          progress,
          "JUDGING",
          judgingDuration,
          progress.deadline,
        );
        break;
      }
      case "ROUND_RESULT": {
        const room = this.rooms.getRoom(roomCode);
        const nextRound = progress.roundIndex + 1;
        if (room.matchSchedule && nextRound >= room.matchSchedule.totalRounds) {
          this.transition(roomCode, progress, "FINAL_RESULT", null, progress.deadline);
        } else {
          progress.roundIndex = nextRound;
          this.transition(
            roomCode,
            progress,
            "ROLE_REVEAL",
            MATCH_PHASE_DURATIONS_MS.ROLE_REVEAL,
            progress.deadline,
          );
        }
        break;
      }
      case "JUDGING":
      case "FINAL_RESULT":
        break;
    }
  }

  private transition(
    roomCode: string,
    progress: MatchProgress,
    phase: MatchPhase,
    durationMs: number | null,
    startedAt = this.readClock(),
  ): void {
    const deadline = durationMs === null ? null : startedAt + durationMs;
    if (deadline !== null && !Number.isFinite(deadline)) {
      throw new RoomServiceError("REQUEST_FAILED", "The match deadline could not be set.");
    }
    if (progress.timer !== null) this.clearTimer(progress.timer);
    progress.timer = null;
    progress.phase = phase;
    progress.phaseStartedAt = startedAt;
    progress.deadline = deadline;
    progress.generation += 1;
    if (
      phase === "ROLE_REVEAL" ||
      phase === "WORD_SELECTION" ||
      phase === "DRAWING" ||
      phase === "ROUND_RESULT"
    ) {
      this.scheduleTimer(roomCode, progress);
    }
    this.onTransition(roomCode);
  }

  private scheduleTimer(roomCode: string, progress: MatchProgress): void {
    if (progress.deadline === null) return;
    const generation = progress.generation;
    const delay = Math.max(0, progress.deadline - this.readClock());
    const timer = this.setTimer(() => {
      const current = this.progress.get(roomCode);
      if (current?.generation !== generation) return;
      current.timer = null;
      const now = this.readClock();
      if (current.deadline !== null && now < current.deadline) {
        this.scheduleTimer(roomCode, current);
        return;
      }
      this.processDeadline(roomCode, generation, now);
    }, delay);
    progress.timer = timer;
    if (typeof timer === "object" && timer !== null) timer.unref();
  }

  private clearProgress(roomCode: string): void {
    const previous = this.progress.get(roomCode);
    if (previous?.timer !== null && previous?.timer !== undefined) {
      this.clearTimer(previous.timer);
    }
    this.progress.delete(roomCode);
  }

  private finalizePrompt(
    roomCode: string,
    progress: MatchProgress,
    prompt: string,
    startedAt?: number,
  ): void {
    progress.prompt = prompt;
    progress.usedPrompts.push(prompt);
    const room = this.rooms.getRoom(roomCode);
    if (!room.matchSchedule) {
      throw new RoomServiceError("WRONG_PHASE", "There is no active match.");
    }
    const assignment = getMatchRoundAssignment(room.matchSchedule, progress.roundIndex);
    progress.canvases = new Map(
      assignment.artistIds.map((playerId) => [
        playerId,
        { canvas: emptyCanvas(), locked: false },
      ]),
    );
    this.transition(
      roomCode,
      progress,
      "DRAWING",
      MATCH_PHASE_DURATIONS_MS.DRAWING,
      startedAt,
    );
  }

  private randomIndex(length: number): number {
    const sample = this.random();
    if (length <= 0) {
      throw new RoomServiceError("REQUEST_FAILED", "No prompt suggestions are available.");
    }
    return Number.isFinite(sample)
      ? Math.min(length - 1, Math.max(0, Math.floor(sample * length)))
      : 0;
  }

  private readClock(): number {
    const now = this.now();
    if (!Number.isFinite(now)) {
      throw new RoomServiceError("REQUEST_FAILED", "The match clock is unavailable.");
    }
    return now;
  }
}

function normalizePrompt(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new RoomServiceError("INVALID_INPUT", "Enter a valid prompt.");
  }
  const prompt = raw.trim().replace(/\s+/g, " ");
  if (prompt.length < 1 || prompt.length > 40 || /[<>{}]/.test(prompt)) {
    throw new RoomServiceError(
      "INVALID_INPUT",
      "Prompts must be 1–40 characters and cannot contain markup.",
    );
  }
  return prompt;
}
