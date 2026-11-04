import {
  pickSuggestions,
  applyOps,
  cloneCanvas,
  emptyCanvas,
  type CanvasSnapshot,
  type DrawOp,
  type FinalResult,
  type PlayerView,
  type RoundResult,
  type Session,
} from "@drawoff/contracts";
import { playerViewSchema, roundResultSchema } from "@drawoff/contracts";
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
export const RECONNECT_WINDOW_MS = 30_000;

export type MatchPhaseDurations = {
  [Phase in keyof typeof MATCH_PHASE_DURATIONS_MS]: number;
};

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
  scores: Record<string, number>;
  judgeRatings: Record<string, number> | null;
  roundResult: RoundResult | null;
  pause: {
    playerId: string;
    until: number;
    remainingMs: number | null;
  } | null;
  generation: number;
  timer: TimerHandle | null;
}

interface ArtistCanvas {
  canvas: CanvasSnapshot;
  locked: boolean;
  sequence: number;
  operations: Map<string, { type: DrawOp["type"]; fingerprints: Set<string>; strokeStyle?: string }>;
}

export interface MatchStateMachineOptions {
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  onTransition?: (roomCode: string) => void;
  maxCanvasActionsPerRoom?: number;
  phaseDurationsMs?: Partial<MatchPhaseDurations>;
  reconnectWindowMs?: number;
}

export class MatchStateMachine {
  private readonly progress = new Map<string, MatchProgress>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly onTransition: (roomCode: string) => void;
  private readonly maxCanvasActionsPerRoom: number;
  private readonly phaseDurations: MatchPhaseDurations;
  private readonly reconnectWindowMs: number;

  constructor(
    private readonly rooms: RoomService,
    options: MatchStateMachineOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onTransition = options.onTransition ?? (() => undefined);
    this.maxCanvasActionsPerRoom = options.maxCanvasActionsPerRoom ?? 50_000;
    this.phaseDurations = {
      ...MATCH_PHASE_DURATIONS_MS,
      ...options.phaseDurationsMs,
    };
    this.reconnectWindowMs = options.reconnectWindowMs ?? RECONNECT_WINDOW_MS;
    if (!Number.isSafeInteger(this.maxCanvasActionsPerRoom) || this.maxCanvasActionsPerRoom <= 0) {
      throw new RangeError("maxCanvasActionsPerRoom must be a positive safe integer.");
    }
    for (const [phase, duration] of Object.entries(this.phaseDurations)) {
      if (!Number.isSafeInteger(duration) || duration <= 0) {
        throw new RangeError(`${phase} duration must be a positive safe integer.`);
      }
    }
    if (!Number.isSafeInteger(this.reconnectWindowMs) || this.reconnectWindowMs <= 0) {
      throw new RangeError("reconnectWindowMs must be a positive safe integer.");
    }
  }

  startMatch(session: Session): void {
    const now = this.readClock();
    const deadline = now + this.phaseDurations.ROLE_REVEAL;
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
      scores: Object.fromEntries(room.matchSchedule.order.map((playerId) => [playerId, 0])),
      judgeRatings: null,
      roundResult: null,
      pause: null,
      generation: 0,
      timer: null,
    };
    this.progress.set(session.roomCode, progress);
    this.scheduleTimer(session.roomCode, progress);
    this.onTransition(session.roomCode);
  }

  rematch(session: Session): void {
    const { room, player, progress } = this.requireMatchMember(session);
    this.requirePhase(progress, "FINAL_RESULT");
    if (player.id !== room.hostId) {
      throw new RoomServiceError("FORBIDDEN", "Only the host can start a rematch.");
    }

    this.rooms.resetMatchForRematch(session);
    this.clearProgress(room.code);
    this.onTransition(room.code);
  }

  playerDisconnected(session: Session): void {
    const authenticated = this.rooms.resumeSession(session);
    this.rooms.reassignDisconnectedHost(authenticated.roomCode);
    const room = this.rooms.getRoom(authenticated.roomCode);
    const progress = this.progress.get(room.code);
    if (!progress || progress.pause) return;

    const missingPlayerId = this.requiredPlayerIds(room, progress)
      .find((playerId) => !room.players.find((player) => player.id === playerId)?.connected);
    if (!missingPlayerId) return;

    const now = this.readClock();
    const until = now + this.reconnectWindowMs;
    if (!Number.isFinite(until)) {
      throw new RoomServiceError("REQUEST_FAILED", "The reconnect deadline could not be set.");
    }
    if (progress.timer !== null) this.clearTimer(progress.timer);
    progress.timer = null;
    progress.pause = {
      playerId: missingPlayerId,
      until,
      remainingMs:
        progress.deadline === null ? null : Math.max(0, progress.deadline - now),
    };
    progress.generation += 1;
    this.schedulePauseTimer(room.code, progress);
    this.onTransition(room.code);
  }

  playerLeft(session: Session): void {
    const authenticated = this.rooms.resumeSession(session);
    const room = this.rooms.getRoom(authenticated.roomCode);
    const progress = this.progress.get(room.code);
    const playerName = room.players.find(({ id }) => id === authenticated.playerId)?.name;
    const incompleteMatch = progress !== undefined && progress.phase !== "FINAL_RESULT";

    this.rooms.leaveRoom(authenticated);
    if (!incompleteMatch) {
      try {
        this.rooms.getRoom(room.code);
        this.onTransition(room.code);
      } catch (error) {
        if (!(error instanceof RoomServiceError) || error.code !== "ROOM_NOT_FOUND") throw error;
        this.clearProgress(room.code);
      }
      return;
    }

    this.clearProgress(room.code);
    try {
      const remainingRoom = this.rooms.getRoom(room.code);
      this.rooms.cancelActiveMatch(
        room.code,
        this.interruptionNotice(
          remainingRoom,
          `The match was canceled because ${playerName ?? "a required player"} left.`,
        ),
      );
      this.onTransition(room.code);
    } catch (error) {
      if (!(error instanceof RoomServiceError) || error.code !== "ROOM_NOT_FOUND") throw error;
    }
  }

  playerReconnected(session: Session): void {
    const authenticated = this.rooms.resumeSession(session);
    this.rooms.reassignDisconnectedHost(authenticated.roomCode);
    const room = this.rooms.getRoom(authenticated.roomCode);
    const progress = this.progress.get(room.code);
    if (!progress?.pause) return;

    const nextMissingPlayerId = this.requiredPlayerIds(room, progress)
      .find((playerId) => !room.players.find((player) => player.id === playerId)?.connected);
    if (nextMissingPlayerId) {
      if (progress.pause.playerId !== nextMissingPlayerId) {
        progress.pause.playerId = nextMissingPlayerId;
        this.onTransition(room.code);
      }
      return;
    }

    const now = this.readClock();
    const remainingMs = progress.pause.remainingMs;
    if (progress.timer !== null) this.clearTimer(progress.timer);
    progress.timer = null;
    progress.pause = null;
    progress.generation += 1;
    progress.phaseStartedAt = now;
    progress.deadline = remainingMs === null ? null : now + remainingMs;
    if (progress.deadline !== null && !Number.isFinite(progress.deadline)) {
      throw new RoomServiceError("REQUEST_FAILED", "The match deadline could not be restored.");
    }
    if (progress.deadline !== null) this.scheduleTimer(room.code, progress);
    this.onTransition(room.code);
  }

  selectPrompt(session: Session, rawPrompt: unknown): void {
    const { room, player, progress } = this.requireMatchMember(session);
    this.requireNotPaused(progress);
    this.requirePhase(progress, "WORD_SELECTION");
    this.requireJudge(room, player.id, progress.roundIndex);
    this.requireBeforeDeadline(progress);
    const prompt = normalizePrompt(rawPrompt);
    this.finalizePrompt(session.roomCode, progress, prompt);
  }

  submitRatings(session: Session, rawRatings: unknown): void {
    const { room, player, progress } = this.requireMatchMember(session);
    this.requireNotPaused(progress);
    this.requireJudge(room, player.id, progress.roundIndex);

    const assignment = getMatchRoundAssignment(room.matchSchedule!, progress.roundIndex);
    const labels = assignment.artistIds.map((_, index) => `Drawing ${index + 1}`);
    if (
      typeof rawRatings !== "object" ||
      rawRatings === null ||
      Array.isArray(rawRatings)
    ) {
      throw new RoomServiceError("INVALID_INPUT", "Submit one rating for every drawing.");
    }
    const submittedRatings = rawRatings as Record<string, unknown>;
    const keys = Object.keys(submittedRatings);
    if (
      keys.length !== labels.length ||
      labels.some((label) => !Object.hasOwn(submittedRatings, label)) ||
      keys.some((label) => !labels.includes(label))
    ) {
      throw new RoomServiceError("INVALID_INPUT", "Submit one rating for every drawing.");
    }
    for (const label of labels) {
      const rating = submittedRatings[label];
      if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 0 || rating > 100) {
        throw new RoomServiceError("INVALID_INPUT", "Ratings must be whole numbers from 0 to 100.");
      }
    }

    const normalizedRatings = Object.fromEntries(
      labels.map((label) => [label, submittedRatings[label] as number]),
    );
    if (
      ["ROUND_RESULT", "FINAL_RESULT"].includes(progress.phase) &&
      progress.judgeRatings !== null
    ) {
      if (labels.every((label) => progress.judgeRatings?.[label] === normalizedRatings[label])) {
        return;
      }
      throw new RoomServiceError("WRONG_PHASE", "This round's ratings have already been submitted.");
    }

    this.requirePhase(progress, "JUDGING");
    const now = this.requireBeforeDeadline(progress);
    if (!Number.isFinite(now + this.phaseDurations.ROUND_RESULT)) {
      throw new RoomServiceError("REQUEST_FAILED", "The match deadline could not be set.");
    }

    if (progress.prompt === null) {
      throw new RoomServiceError("WRONG_PHASE", "The round prompt is not available.");
    }
    const entries = assignment.artistIds.map((artistId, index) => {
      const drawing = progress.canvases.get(artistId);
      if (!drawing) {
        throw new RoomServiceError("WRONG_PHASE", "A drawing is not available for rating.");
      }
      return {
        label: labels[index]!,
        artistId,
        rating: normalizedRatings[labels[index]!]!,
        canvas: cloneCanvas(drawing.canvas),
      };
    });
    const scores = { ...progress.scores };
    for (const entry of entries) {
      scores[entry.artistId] = (scores[entry.artistId] ?? 0) + entry.rating;
    }
    const highestRating = Math.max(...entries.map(({ rating }) => rating));
    const result = roundResultSchema.parse({
      roundIndex: progress.roundIndex,
      prompt: progress.prompt,
      judgeId: player.id,
      entries,
      winners: entries
        .filter(({ rating }) => rating === highestRating)
        .map(({ artistId }) => artistId),
    });

    progress.scores = scores;
    progress.judgeRatings = normalizedRatings;
    progress.roundResult = result;
    this.transition(
      session.roomCode,
      progress,
      "ROUND_RESULT",
      this.phaseDurations.ROUND_RESULT,
      now,
    );
  }

  sendDrawOps(session: Session, ops: DrawOp[]): boolean {
    const { player, progress } = this.requireArtistDrawing(session);
    this.requireBeforeDeadline(progress);
    const drawing = progress.canvases.get(player.id)!;
    if (drawing.locked) {
      throw new RoomServiceError("FORBIDDEN", "Your drawing is already submitted.");
    }

    const next = cloneCanvas(drawing.canvas);
    const previousSequence = drawing.sequence;
    let sequence = previousSequence;
    const operations = new Map(
      [...drawing.operations].map(([id, entry]) => [
        id,
        { ...entry, fingerprints: new Set(entry.fingerprints) },
      ]),
    );
    let roomActionCount = [...progress.canvases.values()]
      .reduce((total, canvas) => total + canvas.canvas.actions.length, 0);
    for (const op of ops) {
      const fingerprint = JSON.stringify(op);
      const previous = operations.get(op.id);
      if (previous) {
        if (previous.fingerprints.has(fingerprint)) continue;
        const strokeStyle =
          op.type === "stroke"
            ? JSON.stringify({ tool: op.tool, color: op.color, size: op.size })
            : null;
        if (
          op.type !== "stroke" ||
          previous.type !== "stroke" ||
          previous.strokeStyle !== strokeStyle
        ) {
          throw new RoomServiceError("INVALID_INPUT", "The operation ID has already been used.");
        }
        previous.fingerprints.add(fingerprint);
      } else {
        operations.set(op.id, {
          type: op.type,
          fingerprints: new Set([fingerprint]),
          ...(op.type === "stroke"
            ? { strokeStyle: JSON.stringify({ tool: op.tool, color: op.color, size: op.size }) }
            : {}),
        });
      }

      const canUndo = next.actions.length > 0;
      const previousRevision = next.rev;
      const previousActionCount = next.actions.length;
      const accepted = applyOps(next, [op]);
      if (accepted === 0 && !(op.type === "undo" && !canUndo)) {
        throw new RoomServiceError(
          "INVALID_INPUT",
          "The drawing operation exceeds a configured canvas operation limit.",
        );
      }
      roomActionCount += next.actions.length - previousActionCount;
      if (roomActionCount > this.maxCanvasActionsPerRoom) {
        throw new RoomServiceError(
          "INVALID_INPUT",
          "The drawing operation exceeds the configured room canvas history limit.",
        );
      }
      if (next.rev !== previousRevision) sequence += 1;
    }
    drawing.canvas = next;
    drawing.sequence = sequence;
    drawing.operations = operations;
    return sequence !== previousSequence;
  }

  submitCanvas(session: Session): void {
    const { player, progress } = this.requireArtistDrawing(session);
    this.requireBeforeDeadline(progress);
    const drawing = progress.canvases.get(player.id)!;
    if (drawing.locked) {
      throw new RoomServiceError("FORBIDDEN", "Your drawing is already submitted.");
    }
    drawing.locked = true;
    drawing.sequence += 1;
  }

  getPlayerView(session: Session): PlayerView {
    const authenticated = this.rooms.resumeSession(session);
    const room = this.rooms.getRoom(authenticated.roomCode);
    const lobbyView = this.rooms.getLobbyView(authenticated);
    const progress = this.progress.get(room.code);
    if (!progress || !room.matchSchedule) return lobbyView;

    const serverNow = this.readClock();
    const assignment = getMatchRoundAssignment(room.matchSchedule, progress.roundIndex);
    const role =
      progress.phase === "FINAL_RESULT"
        ? null
        : assignment.judgeId === authenticated.playerId
          ? "judge"
          : assignment.artistIds.includes(authenticated.playerId)
            ? "artist"
            : null;
    const hideArtistIdentities =
      role === "judge" && ["DRAWING", "JUDGING"].includes(progress.phase);
    // Keep roster and schedule slots usable without exposing real Artist identities beside canvases.
    const anonymousArtistIds = new Map(
      assignment.artistIds.map((playerId, index) => [
        playerId,
        {
          id: `anonymous-player-${room.code}-${progress.roundIndex}-${index + 1}`,
          name: `Anonymous player ${index + 1}`,
        },
      ]),
    );
    const publicPlayerId = (playerId: string) =>
      hideArtistIdentities
        ? anonymousArtistIds.get(playerId)?.id ?? playerId
        : playerId;
    const finalResult: FinalResult | null = progress.phase === "FINAL_RESULT"
      ? (() => {
          const order = room.matchSchedule!.order;
          const standings = order
            .map((playerId, index) => ({
              playerId,
              score: progress.scores[playerId] ?? 0,
              index,
            }))
            .sort((left, right) => right.score - left.score || left.index - right.index)
            .map(({ playerId, score }) => ({ playerId, score }));
          const topScore = standings[0]?.score ?? 0;
          return {
            winners: standings
              .filter(({ score }) => score === topScore)
              .map(({ playerId }) => playerId),
            standings,
            rounds: room.matchSchedule!.totalRounds,
            cycles: room.matchSchedule!.cycles,
          };
        })()
      : null;

    return playerViewSchema.parse({
      ...lobbyView,
      players: hideArtistIdentities
        ? lobbyView.players.map((player) => {
            const anonymousPlayer = anonymousArtistIds.get(player.id);
            if (!anonymousPlayer) return player;
            return {
              ...player,
              ...anonymousPlayer,
            };
          })
        : lobbyView.players,
      hostId: publicPlayerId(lobbyView.hostId),
      serverNow,
      phase: progress.phase,
      deadline: progress.deadline,
      pause: progress.pause
        ? {
            playerName:
              room.players.find(({ id }) => id === progress.pause!.playerId)?.name ?? "A player",
            until: progress.pause.until,
          }
        : null,
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
                      (!progress.pause && progress.deadline !== null && serverNow >= progress.deadline),
                  }
                : null;
            })()
          : null,
      liveCanvases:
        role === "judge" && ["DRAWING", "JUDGING"].includes(progress.phase)
          ? assignment.artistIds.map((playerId, index) => {
              const drawing = progress.canvases.get(playerId)!;
              return {
                label: `Drawing ${index + 1}`,
                sequence: drawing.sequence,
                canvas: cloneCanvas(drawing.canvas),
                locked:
                  drawing.locked ||
                  progress.phase !== "DRAWING" ||
                  (!progress.pause && progress.deadline !== null && serverNow >= progress.deadline),
              };
            })
            : null,
      gallery:
        role === "judge" && progress.phase === "JUDGING"
            ? assignment.artistIds.map((playerId, index) => ({
                label: `Drawing ${index + 1}`,
                canvas: cloneCanvas(progress.canvases.get(playerId)!.canvas),
              }))
            : null,
      roundResult:
        ["ROUND_RESULT", "FINAL_RESULT"].includes(progress.phase)
          ? progress.roundResult
          : null,
      finalResult,
      match: {
        roundIndex: progress.roundIndex,
        totalRounds: room.matchSchedule.totalRounds,
        cycle: Math.floor(progress.roundIndex / room.matchSchedule.order.length) + 1,
        judgeId: assignment.judgeId,
        artistIds: assignment.artistIds.map(publicPlayerId),
        order: room.matchSchedule.order.map(publicPlayerId),
        scores: Object.fromEntries(
          room.matchSchedule.order.map((playerId) => [
            publicPlayerId(playerId),
            progress.scores[playerId] ?? 0,
          ]),
        ),
      },
    });
  }

  /** Process due server-clock transitions; safe to call repeatedly or alongside timers. */
  tick(): void {
    const now = this.readClock();
    for (const [roomCode, progress] of this.progress) {
      if (progress.pause && now >= progress.pause.until) {
        this.cancelInterruptedMatch(roomCode, progress);
      } else if (!progress.pause && progress.deadline !== null && now >= progress.deadline) {
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
    this.requireNotPaused(progress);
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

  private requireBeforeDeadline(progress: MatchProgress): number {
    const now = this.readClock();
    if (progress.deadline !== null && now >= progress.deadline) {
      throw new RoomServiceError("DEADLINE_PASSED", "The phase deadline has passed.");
    }
    return now;
  }

  private requireNotPaused(progress: MatchProgress): void {
    if (progress.pause) {
      throw new RoomServiceError("PAUSED", "The game is paused while a player reconnects.");
    }
  }

  private requiredPlayerIds(room: RoomSnapshot, progress: MatchProgress): string[] {
    if (!room.matchSchedule) return [];
    const assignment = getMatchRoundAssignment(room.matchSchedule, progress.roundIndex);
    switch (progress.phase) {
      case "ROLE_REVEAL":
      case "WORD_SELECTION":
        return [assignment.judgeId, ...assignment.artistIds];
      case "DRAWING":
        return [
          assignment.judgeId,
          ...assignment.artistIds.filter(
            (artistId) => !progress.canvases.get(artistId)?.locked,
          ),
        ];
      case "JUDGING":
        return [assignment.judgeId];
      case "ROUND_RESULT":
      case "FINAL_RESULT":
        return [];
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
          this.phaseDurations.WORD_SELECTION,
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
        for (const drawing of progress.canvases.values()) {
          if (drawing.locked) continue;
          drawing.locked = true;
          drawing.sequence += 1;
        }
        const artistCount = room.matchSchedule?.order.length
          ? room.matchSchedule.order.length - 1
          : 0;
        const judgingDuration = Math.max(
          this.phaseDurations.JUDGE_MINIMUM,
          this.phaseDurations.JUDGE_PER_ARTIST * artistCount,
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
          progress.judgeRatings = null;
          progress.roundResult = null;
          this.transition(
            roomCode,
            progress,
            "ROLE_REVEAL",
            this.phaseDurations.ROLE_REVEAL,
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

  private schedulePauseTimer(roomCode: string, progress: MatchProgress): void {
    if (!progress.pause) return;
    const generation = progress.generation;
    const delay = Math.max(0, progress.pause.until - this.readClock());
    const timer = this.setTimer(() => {
      const current = this.progress.get(roomCode);
      if (current?.generation !== generation || !current.pause) return;
      current.timer = null;
      const now = this.readClock();
      if (now < current.pause.until) {
        this.schedulePauseTimer(roomCode, current);
        return;
      }
      this.cancelInterruptedMatch(roomCode, current);
    }, delay);
    progress.timer = timer;
    if (typeof timer === "object" && timer !== null) timer.unref();
  }

  private cancelInterruptedMatch(roomCode: string, progress: MatchProgress): void {
    if (progress.timer !== null) this.clearTimer(progress.timer);
    progress.timer = null;
    this.progress.delete(roomCode);
    const room = this.rooms.getRoom(roomCode);
    this.rooms.cancelActiveMatch(
      roomCode,
      this.interruptionNotice(
        room,
        "The match was canceled because a required player did not reconnect in time.",
      ),
    );
    this.onTransition(roomCode);
  }

  private interruptionNotice(room: RoomSnapshot, reason: string): string {
    const connectedCount = room.players.filter(({ connected }) => connected).length;
    return connectedCount >= 3
      ? `${reason} No winner was declared. The room is ready to start a new match.`
      : `${reason} No winner was declared. At least 3 connected players are needed to start a new match.`;
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
        { canvas: emptyCanvas(), locked: false, sequence: 0, operations: new Map() },
      ]),
    );
    this.transition(
      roomCode,
      progress,
      "DRAWING",
      this.phaseDurations.DRAWING,
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
