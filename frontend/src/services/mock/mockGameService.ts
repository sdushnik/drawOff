/**
 * Mock backend: runs the authoritative GameEngine in the browser, adds a
 * simulated network delay, drives timers and demo players, and keeps state in
 * sessionStorage so a page refresh reconnects to the same game.
 */
import { GameEngine, GameError, type RoomRecord } from "@/game/engine";
import type { PlayerView, Session } from "@/game/types";
import { ServiceError, type GameService } from "../gameService";
import { BOT_NAMES, BotDirector } from "./bots";

export interface MockGameServiceOptions {
  engine?: GameEngine;
  /** Simulated round-trip latency in ms. */
  latencyMs?: number;
  /** Run the timer/bot loop automatically. Disable in tests and call `step()`. */
  autoTick?: boolean;
  tickMs?: number;
  /** Where to persist state; null disables persistence. */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** Min ms between view pushes to one subscriber. */
  pushIntervalMs?: number;
}

export interface MockGameService extends GameService {
  readonly engine: GameEngine;
  /** Advance timers and demo players once. */
  step(): void;
  dispose(): void;
}

const STORAGE_KEY = "drawoff:mock-backend:v1";

export function createMockGameService(options: MockGameServiceOptions = {}): MockGameService {
  const engine = options.engine ?? new GameEngine();
  const latency = options.latencyMs ?? 80;
  const storage = options.storage === undefined ? safeSessionStorage() : options.storage;
  const pushInterval = options.pushIntervalMs ?? 60;
  const bots = new BotDirector(engine, engine.random);
  const liveSessions = new Set<string>();

  if (storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) engine.load(JSON.parse(raw) as RoomRecord[]);
    } catch {
      // Corrupt state: start fresh.
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveNow = () => {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(engine.snapshot()));
    } catch {
      // Storage full — persistence is best-effort.
    }
  };
  const scheduleSave = () => {
    if (!storage || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, 800);
  };

  const step = () => {
    engine.tick();
    for (const code of engine.roomCodes()) bots.step(code);
  };

  let interval: ReturnType<typeof setInterval> | null = null;
  if (options.autoTick ?? true) interval = setInterval(step, options.tickMs ?? 150);

  const onPageHide = () => {
    // Simulate the socket dropping; the reload will reconnect via resumeSession.
    for (const key of liveSessions) {
      const [code = "", token = ""] = key.split("|");
      engine.disconnect(code, token);
    }
    saveNow();
  };
  if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);

  const wait = () => (latency > 0 ? new Promise((r) => setTimeout(r, latency)) : Promise.resolve());

  async function call<T>(fn: () => T): Promise<T> {
    await wait();
    try {
      const result = fn();
      scheduleSave();
      return result;
    } catch (e) {
      throw toServiceError(e);
    }
  }

  const service: MockGameService = {
    engine,
    capabilities: { demoPlayers: true, label: "Offline demo" },
    step,

    createRoom: (name) => call(() => engine.createRoom(name)),
    joinRoom: (code, name) => call(() => engine.joinRoom(code, name)),
    resumeSession: (s) => call(() => engine.resume(s.roomCode, s.token)),
    leaveRoom: (s) => call(() => engine.leave(s.roomCode, s.token)),
    kickPlayer: (s, id) => call(() => engine.kick(s.roomCode, s.token, id)),
    setCycles: (s, cycles) => call(() => engine.setCycles(s.roomCode, s.token, cycles)),
    addDemoPlayer: (s) =>
      call(() => {
        const room = engine.getRoom(s.roomCode);
        if (!room) throw new GameError("ROOM_NOT_FOUND", "Room not found.");
        const me = room.players.find((p) => p.token === s.token);
        if (!me || me.id !== room.hostId) throw new GameError("FORBIDDEN", "Only the host can add demo players.");
        const taken = new Set(room.players.map((p) => p.name));
        const name = BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${room.players.length + 1}`;
        engine.joinRoom(s.roomCode, name, { isBot: true });
      }),
    startMatch: (s) => call(() => engine.startMatch(s.roomCode, s.token)),
    selectPrompt: (s, prompt) => call(() => engine.selectPrompt(s.roomCode, s.token, prompt)),
    sendDrawOps: (s, ops) =>
      call(() => {
        engine.sendOps(s.roomCode, s.token, ops);
      }),
    submitCanvas: (s) => call(() => engine.submitCanvas(s.roomCode, s.token)),
    submitRatings: (s, ratings) => call(() => engine.submitRatings(s.roomCode, s.token, ratings)),
    rematch: (s) => call(() => engine.rematch(s.roomCode, s.token)),
    returnToLobby: (s) => call(() => engine.returnToLobby(s.roomCode, s.token)),

    subscribe(session: Session, onView: (v: PlayerView) => void, onError?: (e: ServiceError) => void) {
      const key = `${session.roomCode}|${session.token}`;
      liveSessions.add(key);
      let timer: ReturnType<typeof setTimeout> | null = null;
      let last = 0;
      let closed = false;

      const push = () => {
        timer = null;
        if (closed) return;
        last = Date.now();
        try {
          onView(engine.getView(session.roomCode, session.token));
        } catch (e) {
          onError?.(toServiceError(e));
        }
      };
      const schedule = () => {
        if (timer || closed) return;
        const since = Date.now() - last;
        timer = setTimeout(push, since >= pushInterval ? 0 : pushInterval - since);
      };

      const unsub = engine.subscribe(session.roomCode, () => {
        schedule();
        scheduleSave();
      });
      push();
      return () => {
        closed = true;
        liveSessions.delete(key);
        if (timer) clearTimeout(timer);
        unsub();
      };
    },

    dispose() {
      if (interval) clearInterval(interval);
      if (saveTimer) clearTimeout(saveTimer);
      if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
    },
  };
  return service;
}

function toServiceError(e: unknown): ServiceError {
  if (e instanceof ServiceError) return e;
  if (e instanceof GameError) return new ServiceError(e.code, e.message);
  return new ServiceError("NETWORK", e instanceof Error ? e.message : "Something went wrong.");
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}
