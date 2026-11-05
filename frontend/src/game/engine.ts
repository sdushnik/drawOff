/**
 * Authoritative DrawOff game engine. Owns all room state, validates every action
 * (membership, role, phase, deadlines) and builds privacy-filtered per-player views.
 *
 * It has no I/O: time and randomness are injected, and `tick()` advances deadlines.
 * The mock service runs it in the browser; a real server can run the same code.
 */
import { applyOps, cloneCanvas, emptyCanvas } from "./canvasOps";
import {
  DRAWING_MS,
  INTERRUPTED_MS,
  JUDGE_GRACE_MS,
  MIN_PLAYERS,
  RECONNECT_WINDOW_MS,
  ROLE_REVEAL_MS,
  ROUND_RESULT_MS,
  WORD_SELECTION_MS,
} from "./constants";
import { pickSuggestions } from "./prompts";
import {
  artistsForRound,
  cycleOfRound,
  generateRoomCode,
  isValidCycles,
  judgeForRound,
  judgingSeconds,
  normalizeRoomCode,
  shuffle,
  standings,
  topIds,
  totalRounds,
  validateName,
  validatePrompt,
  validateRatings,
} from "./rules";
import type {
  CanvasSnapshot,
  Cycles,
  DrawingState,
  FinalResult,
  MatchState,
  Phase,
  PlayerSummary,
  PlayerView,
  RoundResult,
  RoomPlayer,
  RoomRound,
  RoomState,
  ServiceErrorCode,
  Session,
} from "@drawoff/contracts";

export type GameErrorCode = Exclude<ServiceErrorCode, "NETWORK">;

export class GameError extends Error {
  constructor(
    public code: GameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GameError";
  }
}

type PlayerRecord = RoomPlayer;
type DrawingRecord = DrawingState;
type RoundRecord = RoomRound;
type MatchRecord = MatchState;
export type RoomRecord = RoomState;

export interface EngineOptions {
  now?: () => number;
  random?: () => number;
}

const ACTIVE_PHASES: Phase[] = ["ROLE_REVEAL", "WORD_SELECTION", "DRAWING", "JUDGING", "ROUND_RESULT"];

export class GameEngine {
  readonly now: () => number;
  readonly random: () => number;
  private rooms = new Map<string, RoomRecord>();
  private listeners = new Map<string, Set<() => void>>();
  private idCounter = 0;

  constructor(options: EngineOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  // ---------- persistence ----------

  snapshot(): RoomRecord[] {
    return [...this.rooms.values()].map((r) => structuredClone(r));
  }

  load(rooms: RoomRecord[]) {
    this.rooms = new Map(rooms.map((r) => [r.code, structuredClone(r)]));
  }

  roomCodes(): string[] {
    return [...this.rooms.keys()];
  }

  /** Read-only peek (used by bots and tests). */
  getRoom(code: string): Readonly<RoomRecord> | undefined {
    return this.rooms.get(normalizeRoomCode(code));
  }

  // ---------- subscriptions ----------

  subscribe(code: string, fn: () => void): () => void {
    const key = normalizeRoomCode(code);
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(room: RoomRecord) {
    this.listeners.get(room.code)?.forEach((fn) => fn());
  }

  // ---------- room lifecycle ----------

  createRoom(rawName: string): Session {
    const name = this.requireName(rawName);
    let code = generateRoomCode(this.random);
    while (this.rooms.has(code)) code = generateRoomCode(this.random);
    const host = this.newPlayer(name, false);
    const room: RoomRecord = {
      code,
      hostId: host.id,
      players: [host],
      cycles: 1,
      phase: "LOBBY",
      phaseStartedAt: this.now(),
      deadline: null,
      pause: null,
      match: null,
      interruptedReason: null,
      notice: null,
    };
    this.rooms.set(code, room);
    return { roomCode: code, playerId: host.id, token: host.token };
  }

  joinRoom(rawCode: string, rawName: string, opts: { isBot?: boolean } = {}): Session {
    const room = this.requireRoom(rawCode);
    const name = this.requireName(rawName);
    if (room.phase !== "LOBBY") {
      throw new GameError(
        "MATCH_IN_PROGRESS",
        "A match is in progress. You can join when the room is back in the lobby.",
      );
    }
    const player = this.newPlayer(this.uniqueName(room, name), !!opts.isBot);
    room.players.push(player);
    this.emit(room);
    return { roomCode: room.code, playerId: player.id, token: player.token };
  }

  /** Re-attach an existing session (e.g. after a refresh). */
  resume(rawCode: string, token: string): Session {
    const room = this.requireRoom(rawCode);
    const player = this.requirePlayer(room, token);
    if (!player.connected) {
      player.connected = true;
      this.maybeResume(room);
      this.emit(room);
    }
    return { roomCode: room.code, playerId: player.id, token };
  }

  disconnect(rawCode: string, token: string) {
    const room = this.rooms.get(normalizeRoomCode(rawCode));
    if (!room) return;
    const player = room.players.find((p) => p.token === token);
    if (!player || !player.connected) return;
    player.connected = false;
    if (room.hostId === player.id) this.reassignHost(room);
    this.maybePause(room);
    this.emit(room);
  }

  leave(rawCode: string, token: string) {
    const room = this.requireRoom(rawCode);
    const player = this.requirePlayer(room, token);
    this.removePlayer(room, player.id, `${player.name} left the match.`);
  }

  kick(rawCode: string, token: string, playerId: string) {
    const room = this.requireRoom(rawCode);
    this.requireHost(room, token);
    if (room.phase !== "LOBBY") throw new GameError("WRONG_PHASE", "Players can only be removed in the lobby.");
    if (playerId === room.hostId) throw new GameError("FORBIDDEN", "The host can't remove themselves.");
    if (!room.players.some((p) => p.id === playerId)) throw new GameError("INVALID_INPUT", "Player not found.");
    this.removePlayer(room, playerId, null);
  }

  setCycles(rawCode: string, token: string, cycles: number) {
    const room = this.requireRoom(rawCode);
    this.requireHost(room, token);
    if (room.phase !== "LOBBY") throw new GameError("WRONG_PHASE", "Settings can only change in the lobby.");
    if (!isValidCycles(cycles)) throw new GameError("INVALID_INPUT", "Cycles must be 1, 2 or 3.");
    room.cycles = cycles;
    this.emit(room);
  }

  startMatch(rawCode: string, token: string) {
    const room = this.requireRoom(rawCode);
    this.requireHost(room, token);
    if (room.phase !== "LOBBY") throw new GameError("WRONG_PHASE", "The match has already started.");
    const order = room.players.filter((p) => p.connected).map((p) => p.id);
    if (order.length < MIN_PLAYERS) {
      throw new GameError("NOT_ENOUGH_PLAYERS", `At least ${MIN_PLAYERS} connected players are needed.`);
    }
    room.match = {
      order,
      cycles: room.cycles,
      roundIndex: 0,
      totalRounds: totalRounds(order.length, room.cycles),
      scores: Object.fromEntries(order.map((id) => [id, 0])),
      round: this.newRound(order, 0, []),
      usedPrompts: [],
      final: null,
    };
    room.interruptedReason = null;
    room.notice = null;
    this.setPhase(room, "ROLE_REVEAL", ROLE_REVEAL_MS);
    this.maybePause(room);
    this.emit(room);
  }

  selectPrompt(rawCode: string, token: string, rawPrompt: string) {
    const room = this.requireRoom(rawCode);
    const player = this.requirePlayer(room, token);
    this.requireActive(room, "WORD_SELECTION");
    const round = room.match!.round;
    if (round.judgeId !== player.id) throw new GameError("FORBIDDEN", "Only the judge picks the word.");
    const result = validatePrompt(rawPrompt);
    if (!result.ok) throw new GameError("INVALID_INPUT", result.error);
    this.beginDrawing(room, result.value);
    this.emit(room);
  }

  sendOps(rawCode: string, token: string, ops: unknown[]): number {
    const room = this.requireRoom(rawCode);
    const player = this.requirePlayer(room, token);
    this.requireActive(room, "DRAWING");
    if (!Array.isArray(ops)) throw new GameError("INVALID_INPUT", "Ops must be an array.");
    if (room.deadline !== null && this.now() >= room.deadline) {
      throw new GameError("DEADLINE_PASSED", "Time's up!");
    }
    const drawing = room.match!.round.drawings.find((d) => d.artistId === player.id);
    if (!drawing) throw new GameError("FORBIDDEN", "Only artists can draw.");
    if (drawing.locked) throw new GameError("FORBIDDEN", "Your drawing is already submitted.");
    const accepted = applyOps(drawing.canvas, ops);
    if (accepted > 0) this.emit(room);
    return accepted;
  }

  submitCanvas(rawCode: string, token: string) {
    const room = this.requireRoom(rawCode);
    const player = this.requirePlayer(room, token);
    this.requireActive(room, "DRAWING");
    const drawing = room.match!.round.drawings.find((d) => d.artistId === player.id);
    if (!drawing) throw new GameError("FORBIDDEN", "Only artists can submit.");
    if (room.deadline !== null && this.now() >= room.deadline) {
      throw new GameError("DEADLINE_PASSED", "Time's up!");
    }
    drawing.locked = !drawing.locked;
    if (room.match!.round.drawings.every((candidate) => candidate.locked)) {
      this.finishDrawing(room);
    }
    this.emit(room);
  }

  submitRatings(rawCode: string, token: string, ratings: Record<string, unknown>) {
    const room = this.requireRoom(rawCode);
    const player = this.requirePlayer(room, token);
    this.requireActive(room, "JUDGING");
    const match = room.match!;
    const round = match.round;
    if (round.judgeId !== player.id) throw new GameError("FORBIDDEN", "Only the judge can rate.");
    const labels = round.drawings.map((d) => d.label);
    const result = validateRatings(labels, ratings ?? {});
    if (!result.ok) throw new GameError("INVALID_INPUT", result.error);

    const entries = round.drawings.map((d) => ({
      label: d.label,
      artistId: d.artistId,
      rating: result.value[d.label] ?? 0,
      canvas: cloneCanvas(d.canvas),
    }));
    for (const e of entries) match.scores[e.artistId] = (match.scores[e.artistId] ?? 0) + e.rating;
    round.result = {
      roundIndex: match.roundIndex,
      prompt: round.prompt!,
      judgeId: round.judgeId,
      entries,
      winners: topIds(Object.fromEntries(entries.map((e) => [e.artistId, e.rating]))),
    };
    room.notice = null;
    this.setPhase(room, "ROUND_RESULT", ROUND_RESULT_MS);
    this.emit(room);
  }

  /** Host: from final results back to a fresh lobby (scores reset). */
  rematch(rawCode: string, token: string) {
    const room = this.requireRoom(rawCode);
    this.requireHost(room, token);
    if (room.phase !== "FINAL_RESULT") throw new GameError("WRONG_PHASE", "The match isn't over yet.");
    this.toLobby(room);
    this.emit(room);
  }

  /** Any member: leave an interrupted match screen. */
  returnToLobby(rawCode: string, token: string) {
    const room = this.requireRoom(rawCode);
    this.requirePlayer(room, token);
    if (room.phase !== "MATCH_INTERRUPTED") throw new GameError("WRONG_PHASE", "Nothing to return from.");
    this.toLobby(room);
    this.emit(room);
  }

  // ---------- time ----------

  /** Advance all deadlines. Safe to call as often as you like. */
  tick() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      if (room.pause) {
        if (now >= room.pause.until) {
          const who = room.players.find((p) => p.id === room.pause!.playerId);
          this.interrupt(room, `${who?.name ?? "A player"} didn't reconnect in time.`);
          this.emit(room);
        }
        continue;
      }
      if (room.deadline !== null && now >= room.deadline) {
        this.onDeadline(room);
        this.emit(room);
      }
    }
  }

  private onDeadline(room: RoomRecord) {
    const match = room.match;
    switch (room.phase) {
      case "ROLE_REVEAL": {
        this.setPhase(room, "WORD_SELECTION", WORD_SELECTION_MS);
        break;
      }
      case "WORD_SELECTION": {
        const s = match!.round.suggestions;
        this.beginDrawing(room, s[Math.floor(this.random() * s.length)] ?? s[0] ?? "doodle");
        break;
      }
      case "DRAWING": {
        this.finishDrawing(room);
        break;
      }
      case "JUDGING": {
        const round = match!.round;
        if (!round.overtime) {
          round.overtime = true;
          room.deadline = this.now() + JUDGE_GRACE_MS;
        } else {
          // Judge couldn't finish: cancel and retry the unscored round.
          match!.round = this.newRound(match!.order, match!.roundIndex, match!.usedPrompts);
          room.notice = "The judge ran out of time, so the round is being replayed.";
          this.setPhase(room, "ROLE_REVEAL", ROLE_REVEAL_MS);
        }
        break;
      }
      case "ROUND_RESULT": {
        if (match!.roundIndex + 1 >= match!.totalRounds) {
          match!.final = {
            winners: topIds(match!.scores),
            standings: standings(match!.scores, match!.order),
            rounds: match!.totalRounds,
            cycles: match!.cycles,
          };
          room.phase = "FINAL_RESULT";
          room.phaseStartedAt = this.now();
          room.deadline = null;
        } else {
          match!.roundIndex++;
          match!.round = this.newRound(match!.order, match!.roundIndex, match!.usedPrompts);
          this.setPhase(room, "ROLE_REVEAL", ROLE_REVEAL_MS);
        }
        break;
      }
      case "MATCH_INTERRUPTED": {
        this.toLobby(room);
        break;
      }
      default:
        room.deadline = null;
    }
    this.maybePause(room);
  }

  private finishDrawing(room: RoomRecord) {
    for (const drawing of room.match!.round.drawings) drawing.locked = true;
    const artists = room.match!.round.drawings.length;
    this.setPhase(room, "JUDGING", judgingSeconds(artists) * 1000);
  }

  // ---------- views ----------

  getView(rawCode: string, token: string): PlayerView {
    const room = this.requireRoom(rawCode);
    const me = this.requirePlayer(room, token);
    const match = room.match;
    const round = match?.round ?? null;
    const inMatch = !!match && ACTIVE_PHASES.includes(room.phase);
    const role: PlayerView["role"] =
      inMatch && round ? (round.judgeId === me.id ? "judge" : round.artistIds.includes(me.id) ? "artist" : null) : null;
    const myDrawing = round?.drawings.find((d) => d.artistId === me.id) ?? null;

    const promptVisible =
      role === "judge" ? round?.prompt ?? null : role === "artist" && room.phase !== "WORD_SELECTION" ? round?.prompt ?? null : null;

    const pausedPlayer = room.pause ? room.players.find((p) => p.id === room.pause!.playerId) : null;

    return {
      roomCode: room.code,
      serverNow: this.now(),
      me: this.summary(room, me),
      players: room.players.map((p) => this.summary(room, p)),
      hostId: room.hostId,
      cycles: room.cycles,
      phase: room.phase,
      deadline: room.deadline,
      pause: room.pause ? { playerName: pausedPlayer?.name ?? "A player", until: room.pause.until } : null,
      notice: room.notice,
      match: match
        ? {
            roundIndex: match.roundIndex,
            totalRounds: match.totalRounds,
            cycle: cycleOfRound(match.order.length, match.roundIndex),
            judgeId: match.round.judgeId,
            artistIds: [...match.round.artistIds],
            order: [...match.order],
            scores: { ...match.scores },
          }
        : null,
      role,
      prompt: inMatch || room.phase === "ROUND_RESULT" ? promptVisible : null,
      suggestions: role === "judge" && room.phase === "WORD_SELECTION" ? [...round!.suggestions] : null,
      myCanvas:
        role === "artist" && myDrawing && (room.phase === "DRAWING" || room.phase === "JUDGING")
          ? { canvas: cloneCanvas(myDrawing.canvas), locked: myDrawing.locked }
          : null,
      // Judge only, anonymous labels only — never artist ids.
      liveCanvases:
        role === "judge" && room.phase === "DRAWING"
          ? this.byLabel(round!.drawings).map((d) => ({
              label: d.label,
              sequence: d.canvas.rev,
              canvas: cloneCanvas(d.canvas),
              locked: d.locked,
            }))
          : null,
      gallery:
        role === "judge" && room.phase === "JUDGING"
          ? this.byLabel(round!.drawings).map((d) => ({ label: d.label, canvas: cloneCanvas(d.canvas) }))
          : null,
      judgingOvertime: room.phase === "JUDGING" && !!round?.overtime,
      roundResult: room.phase === "ROUND_RESULT" && round?.result ? structuredClone(round.result) : null,
      finalResult: room.phase === "FINAL_RESULT" && match?.final ? structuredClone(match.final) : null,
      interruptedReason: room.phase === "MATCH_INTERRUPTED" ? room.interruptedReason : null,
    };
  }

  // ---------- internals ----------

  private byLabel(drawings: DrawingRecord[]) {
    return [...drawings].sort((a, b) => labelNumber(a.label) - labelNumber(b.label));
  }

  private summary(room: RoomRecord, p: PlayerRecord): PlayerSummary {
    return { id: p.id, name: p.name, isHost: p.id === room.hostId, connected: p.connected, isBot: p.isBot };
  }

  private newRound(order: string[], roundIndex: number, usedPrompts: string[]): RoundRecord {
    return {
      judgeId: judgeForRound(order, roundIndex),
      artistIds: artistsForRound(order, roundIndex),
      suggestions: pickSuggestions(this.random, 3, new Set(usedPrompts)),
      prompt: null,
      drawings: [],
      overtime: false,
      result: null,
    };
  }

  private beginDrawing(room: RoomRecord, prompt: string) {
    const match = room.match!;
    const round = match.round;
    round.prompt = prompt;
    match.usedPrompts.push(prompt);
    // Fresh anonymous labels every round, independent of roster order.
    round.drawings = shuffle(round.artistIds, this.random).map((artistId, i) => ({
      label: `Drawing ${i + 1}`,
      artistId,
      canvas: emptyCanvas(),
      locked: false,
    }));
    this.setPhase(room, "DRAWING", DRAWING_MS);
  }

  private setPhase(room: RoomRecord, phase: Phase, durationMs: number | null) {
    room.phase = phase;
    room.phaseStartedAt = this.now();
    room.deadline = durationMs === null ? null : this.now() + durationMs;
  }

  private toLobby(room: RoomRecord) {
    room.match = null;
    room.pause = null;
    room.interruptedReason = null;
    room.notice = null;
    this.setPhase(room, "LOBBY", null);
  }

  private interrupt(room: RoomRecord, reason: string) {
    room.match = null;
    room.pause = null;
    room.interruptedReason = reason;
    room.notice = null;
    this.setPhase(room, "MATCH_INTERRUPTED", INTERRUPTED_MS);
  }

  /** Players whose presence is required for the current phase to continue. */
  private requiredPlayers(room: RoomRecord): string[] {
    const round = room.match?.round;
    if (!round) return [];
    switch (room.phase) {
      case "ROLE_REVEAL":
      case "WORD_SELECTION":
        return [round.judgeId, ...round.artistIds];
      case "DRAWING":
        return [round.judgeId, ...round.drawings.filter((d) => !d.locked).map((d) => d.artistId)];
      case "JUDGING":
        return [round.judgeId];
      default:
        return [];
    }
  }

  private maybePause(room: RoomRecord) {
    if (room.pause) return;
    const missing = this.requiredPlayers(room).find((id) => !room.players.find((p) => p.id === id)?.connected);
    if (!missing) return;
    room.pause = {
      playerId: missing,
      until: this.now() + RECONNECT_WINDOW_MS,
      remainingMs: room.deadline === null ? null : Math.max(0, room.deadline - this.now()),
    };
  }

  private maybeResume(room: RoomRecord) {
    if (!room.pause) return;
    const stillMissing = this.requiredPlayers(room).some((id) => !room.players.find((p) => p.id === id)?.connected);
    if (stillMissing) {
      const next = this.requiredPlayers(room).find((id) => !room.players.find((p) => p.id === id)?.connected)!;
      room.pause.playerId = next;
      return;
    }
    if (room.pause.remainingMs !== null) room.deadline = this.now() + room.pause.remainingMs;
    room.pause = null;
  }

  private removePlayer(room: RoomRecord, playerId: string, interruptReason: string | null) {
    const inMatch = !!room.match && ACTIVE_PHASES.includes(room.phase) && room.match.order.includes(playerId);
    if (inMatch && interruptReason) this.interrupt(room, interruptReason);
    room.players = room.players.filter((p) => p.id !== playerId);
    if (!room.players.some((p) => !p.isBot)) {
      this.rooms.delete(room.code);
      this.emit(room);
      return;
    }
    if (room.hostId === playerId) this.reassignHost(room);
    this.emit(room);
  }

  private reassignHost(room: RoomRecord) {
    const candidates = room.players.filter((p) => p.connected && p.id !== room.hostId);
    const next = candidates.find((p) => !p.isBot) ?? candidates[0] ?? room.players.find((p) => p.id !== room.hostId);
    if (next) room.hostId = next.id;
  }

  private uniqueName(room: RoomRecord, name: string): string {
    const taken = new Set(room.players.map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name.slice(0, 17)} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  private newPlayer(name: string, isBot: boolean): PlayerRecord {
    return { id: this.newId("p"), name, token: this.newToken(), connected: true, isBot };
  }

  private newId(prefix: string) {
    this.idCounter++;
    return `${prefix}_${this.idCounter.toString(36)}${Math.floor(this.random() * 1e8).toString(36)}`;
  }

  private newToken(): string {
    const c = globalThis.crypto;
    if (c?.randomUUID) return c.randomUUID();
    return `${Date.now().toString(36)}-${Math.floor(this.random() * 1e12).toString(36)}`;
  }

  private requireName(raw: string): string {
    const r = validateName(typeof raw === "string" ? raw : "");
    if (!r.ok) throw new GameError("INVALID_INPUT", r.error);
    return r.value;
  }

  private requireRoom(rawCode: string): RoomRecord {
    const room = this.rooms.get(normalizeRoomCode(typeof rawCode === "string" ? rawCode : ""));
    if (!room) throw new GameError("ROOM_NOT_FOUND", "That room doesn't exist. Check the code and try again.");
    return room;
  }

  private requirePlayer(room: RoomRecord, token: string): PlayerRecord {
    const p = room.players.find((x) => x.token === token);
    if (!p) throw new GameError("UNAUTHORIZED", "You're not in this room.");
    return p;
  }

  private requireHost(room: RoomRecord, token: string): PlayerRecord {
    const p = this.requirePlayer(room, token);
    if (p.id !== room.hostId) throw new GameError("FORBIDDEN", "Only the host can do that.");
    return p;
  }

  private requireActive(room: RoomRecord, phase: Phase) {
    if (room.phase !== phase || !room.match) throw new GameError("WRONG_PHASE", "That's not possible right now.");
    if (room.pause) throw new GameError("PAUSED", "The game is paused while a player reconnects.");
  }
}

function labelNumber(label: string): number {
  return Number(label.replace(/\D/g, "")) || 0;
}
