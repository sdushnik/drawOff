import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  playerSummarySchema,
  sessionSchema,
  type ServiceErrorCode,
  type Session,
} from "@drawoff/contracts";

export const DEFAULT_ROOM_IDLE_TTL_MS = 30 * 60 * 1000;
export const ROOM_CODE_LENGTH = 6;

const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ROOM_CODE_PATTERN = new RegExp(`^[A-Z0-9]{${ROOM_CODE_LENGTH}}$`);
const MAX_ROOM_CODE_ATTEMPTS = 64;
const MAX_PLAYER_ID_ATTEMPTS = 16;
const ROOM_NOT_FOUND_MESSAGE = "Room was not found or has expired.";

export class RoomServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomServiceError";
  }
}

export interface RoomPlayer {
  readonly id: string;
  readonly name: string;
  readonly isHost: boolean;
}

export interface RoomSnapshot {
  readonly code: string;
  readonly hostId: string;
  readonly players: readonly RoomPlayer[];
  readonly matchInProgress: boolean;
  readonly expiresAt: number;
}

export interface RoomServiceOptions {
  idleTtlMs?: number;
  now?: () => number;
  generateRoomCode?: () => string;
  generateId?: () => string;
}

interface RoomPlayerRecord extends RoomPlayer {
  sessionTokenHash: Buffer;
}

interface RoomRecord {
  code: string;
  hostId: string;
  players: RoomPlayerRecord[];
  matchInProgress: boolean;
  expiresAt: number;
}

function generateCryptographicRoomCode(): string {
  let code = "";
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function generateCryptographicToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function normalizePlayerName(name: string): string {
  if (typeof name !== "string") {
    throw new RoomServiceError("INVALID_INPUT", "Enter a valid display name.");
  }

  const normalized = name.trim().replace(/\s+/g, " ");
  if (!playerSummarySchema.shape.name.safeParse(normalized).success) {
    throw new RoomServiceError(
      "INVALID_INPUT",
      "Display names must be 2–20 characters and cannot contain < or >.",
    );
  }
  return normalized;
}

export function normalizeRoomCode(codeOrLink: string): string {
  if (typeof codeOrLink !== "string") {
    throw new RoomServiceError("INVALID_INPUT", "Enter a room code or invite link.");
  }

  const trimmed = codeOrLink.trim();
  const fromLink = trimmed.match(/\/room\/([A-Za-z0-9]+)/);
  const normalized = (fromLink?.[1] ?? trimmed).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!ROOM_CODE_PATTERN.test(normalized)) {
    throw new RoomServiceError("INVALID_INPUT", "Enter a valid room code or invite link.");
  }
  return normalized;
}

export class RoomService {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly generateRoomCode: () => string;
  private readonly generateId: () => string;

  constructor(options: RoomServiceOptions = {}) {
    const idleTtlMs = options.idleTtlMs ?? DEFAULT_ROOM_IDLE_TTL_MS;
    if (!Number.isFinite(idleTtlMs) || idleTtlMs <= 0) {
      throw new RangeError("idleTtlMs must be a positive finite number.");
    }

    this.idleTtlMs = idleTtlMs;
    this.now = options.now ?? Date.now;
    this.generateRoomCode = options.generateRoomCode ?? generateCryptographicRoomCode;
    this.generateId = options.generateId ?? randomUUID;
  }

  createRoom(name: string): Session {
    const normalizedName = normalizePlayerName(name);
    const now = this.readClock();
    const expiresAt = this.expiryFrom(now);
    const code = this.allocateRoomCode();
    const playerId = this.allocatePlayerId();
    const { session, player } = this.createSession(code, playerId, normalizedName, true);

    this.rooms.set(code, {
      code,
      hostId: playerId,
      players: [player],
      matchInProgress: false,
      expiresAt,
    });

    return session;
  }

  joinRoom(codeOrLink: string, name: string): Session {
    let code: string;
    try {
      code = normalizeRoomCode(codeOrLink);
    } catch (error) {
      if (error instanceof RoomServiceError && error.code === "INVALID_INPUT") {
        throw new RoomServiceError("ROOM_NOT_FOUND", ROOM_NOT_FOUND_MESSAGE);
      }
      throw error;
    }
    const now = this.readClock();
    const room = this.findRoom(code, now);
    if (room.matchInProgress) {
      throw new RoomServiceError(
        "MATCH_IN_PROGRESS",
        "This room is in an active match and cannot be joined.",
      );
    }

    const normalizedName = normalizePlayerName(name);
    const expiresAt = this.expiryFrom(now);
    const playerId = this.allocatePlayerId(room);
    const { session, player } = this.createSession(
      room.code,
      playerId,
      normalizedName,
      false,
    );

    room.players.push(player);
    room.expiresAt = expiresAt;
    return session;
  }

  resumeSession(session: Session): Session {
    const { room, player } = this.authenticate(session);
    return {
      roomCode: room.code,
      playerId: player.id,
      token: session.token,
    };
  }

  leaveRoom(session: Session): void {
    const { room, player } = this.authenticate(session);
    this.removePlayer(room, player.id);
  }

  kickPlayer(session: Session, playerId: string): void {
    const { room, player } = this.authenticate(session);
    if (player.id !== room.hostId) {
      throw new RoomServiceError("FORBIDDEN", "Only the host can remove players.");
    }
    if (room.matchInProgress) {
      throw new RoomServiceError("WRONG_PHASE", "Players can only be removed in the lobby.");
    }
    if (playerId === room.hostId) {
      throw new RoomServiceError("FORBIDDEN", "The host cannot remove themselves.");
    }
    if (!room.players.some((candidate) => candidate.id === playerId)) {
      throw new RoomServiceError("INVALID_INPUT", "Player not found.");
    }
    this.removePlayer(room, playerId);
  }

  getRoom(codeOrLink: string): RoomSnapshot {
    const code = normalizeRoomCode(codeOrLink);
    return this.toSnapshot(this.findRoom(code, this.readClock()));
  }

  setMatchInProgress(codeOrLink: string, matchInProgress: boolean): void {
    const code = normalizeRoomCode(codeOrLink);
    const room = this.findRoom(code, this.readClock());
    room.matchInProgress = matchInProgress;
  }

  private allocateRoomCode(): string {
    for (let attempt = 0; attempt < MAX_ROOM_CODE_ATTEMPTS; attempt += 1) {
      const generated = this.generateRoomCode();
      const code = typeof generated === "string" ? generated.toUpperCase() : "";
      if (!ROOM_CODE_PATTERN.test(code)) {
        throw new RoomServiceError("REQUEST_FAILED", "Unable to generate a valid room code.");
      }
      if (!this.rooms.has(code)) {
        return code;
      }
    }

    throw new RoomServiceError("REQUEST_FAILED", "Unable to allocate a unique room code.");
  }

  private allocatePlayerId(room?: RoomRecord): string {
    for (let attempt = 0; attempt < MAX_PLAYER_ID_ATTEMPTS; attempt += 1) {
      const id = this.generateId();
      if (
        typeof id === "string" &&
        id.length > 0 &&
        !room?.players.some((player) => player.id === id)
      ) {
        return id;
      }
    }

    throw new RoomServiceError("REQUEST_FAILED", "Unable to allocate a unique player ID.");
  }

  private createSession(
    roomCode: string,
    playerId: string,
    name: string,
    isHost: boolean,
  ): { session: Session; player: RoomPlayerRecord } {
    const token = generateCryptographicToken();
    const session = sessionSchema.parse({
      roomCode,
      playerId,
      token,
    });
    return {
      session,
      player: {
        id: playerId,
        name,
        isHost,
        sessionTokenHash: hashSessionToken(token),
      },
    };
  }

  private authenticate(session: Session): {
    room: RoomRecord;
    player: RoomPlayerRecord;
  } {
    try {
      sessionSchema.parse(session);
    } catch {
      throw new RoomServiceError("UNAUTHORIZED", "Your saved session is invalid. Rejoin the room.");
    }
    const now = this.readClock();
    let roomCode: string;
    try {
      roomCode = normalizeRoomCode(session.roomCode);
    } catch {
      throw new RoomServiceError("UNAUTHORIZED", "Your saved session is invalid. Rejoin the room.");
    }
    const room = this.findRoom(roomCode, now);
    const player = room.players.find((candidate) => candidate.id === session.playerId);
    if (player === undefined || !this.matchesSessionToken(player, session.token)) {
      throw new RoomServiceError("UNAUTHORIZED", "Your session is no longer valid. Rejoin the room.");
    }
    return { room, player };
  }

  private matchesSessionToken(player: RoomPlayerRecord, token: string): boolean {
    const candidateHash = hashSessionToken(token);
    return timingSafeEqual(player.sessionTokenHash, candidateHash);
  }

  private removePlayer(room: RoomRecord, playerId: string): void {
    room.players = room.players.filter((player) => player.id !== playerId);
    if (room.players.length === 0) {
      this.rooms.delete(room.code);
      return;
    }
    if (room.hostId === playerId) {
      room.hostId = room.players[0]!.id;
      room.players = room.players.map((player) => ({
        ...player,
        isHost: player.id === room.hostId,
      }));
    }
  }

  private findRoom(code: string, now: number): RoomRecord {
    const room = this.rooms.get(code);
    if (room === undefined || now >= room.expiresAt) {
      if (room !== undefined) this.rooms.delete(code);
      throw new RoomServiceError("ROOM_NOT_FOUND", ROOM_NOT_FOUND_MESSAGE);
    }
    return room;
  }

  private expiryFrom(now: number): number {
    const expiresAt = now + this.idleTtlMs;
    if (!Number.isFinite(expiresAt)) {
      throw new RoomServiceError("REQUEST_FAILED", "Unable to set the room idle expiry.");
    }
    return expiresAt;
  }

  private readClock(): number {
    const now = this.now();
    if (!Number.isFinite(now)) {
      throw new RoomServiceError("REQUEST_FAILED", "The room service clock is unavailable.");
    }
    return now;
  }

  private toSnapshot(room: RoomRecord): RoomSnapshot {
    return {
      code: room.code,
      hostId: room.hostId,
      players: room.players.map(({ id, name, isHost }) => ({ id, name, isHost })),
      matchInProgress: room.matchInProgress,
      expiresAt: room.expiresAt,
    };
  }
}

export function createRoomService(options: RoomServiceOptions = {}): RoomService {
  return new RoomService(options);
}
