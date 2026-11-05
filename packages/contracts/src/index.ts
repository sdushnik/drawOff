import { z } from "zod";
export {
  applyOps,
  cloneCanvas,
  emptyCanvas,
  sanitizeOp,
  MAX_ACTIONS_PER_CANVAS,
  MAX_OPS_PER_BATCH,
  MAX_POINTS_PER_OP,
  MAX_POINTS_PER_STROKE,
} from "./canvasOps.js";

export { PROMPTS, pickSuggestions } from "./prompts.js";

export const phaseSchema = z.enum([
  "LOBBY",
  "ROLE_REVEAL",
  "WORD_SELECTION",
  "DRAWING",
  "JUDGING",
  "ROUND_RESULT",
  "FINAL_RESULT",
  "MATCH_INTERRUPTED",
]);
export type Phase = z.infer<typeof phaseSchema>;

export const roleSchema = z.enum(["judge", "artist"]);
export type Role = z.infer<typeof roleSchema>;

export const cyclesSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type Cycles = z.infer<typeof cyclesSchema>;

export const ratingSchema = z.number().int().min(0).max(100);
export type Rating = z.infer<typeof ratingSchema>;

export const reactionEmojiSchema = z.enum(["👏", "😂", "🔥", "❤️", "😮", "🎨"]);
export type ReactionEmoji = z.infer<typeof reactionEmojiSchema>;

export const drawToolSchema = z.enum(["pen", "eraser", "fill"]);
export type DrawTool = z.infer<typeof drawToolSchema>;

const nonEmptyStringSchema = z.string().min(1);
const finiteNumberSchema = z.number().finite();
const scoreSchema = z.number().int().nonnegative();
const playerNameSchema = z.string().refine((value) => {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length >= 2 && normalized.length <= 20 && !/[<>]/.test(normalized);
});
const promptSchema = z.string().refine((value) => {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length >= 1 && normalized.length <= 40 && !/[<>{}]/.test(normalized);
});
const operationIdSchema = z.string().min(1).max(64);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const sessionSchema = z
  .object({
    roomCode: nonEmptyStringSchema,
    playerId: nonEmptyStringSchema,
    token: nonEmptyStringSchema,
  })
  .strict();
export type Session = z.infer<typeof sessionSchema>;

export const playerSummarySchema = z
  .object({
    id: nonEmptyStringSchema,
    name: playerNameSchema,
    isHost: z.boolean(),
    connected: z.boolean(),
    isBot: z.boolean(),
  })
  .strict();
export type PlayerSummary = z.infer<typeof playerSummarySchema>;

const strokeSchema = z
  .object({
    type: z.literal("stroke"),
    id: operationIdSchema,
    tool: z.enum(["pen", "eraser"]),
    color: colorSchema,
    size: z.number().int().min(1).max(60),
    points: z
      .array(finiteNumberSchema)
      .min(2)
      .max(600)
      .refine((points) => points.length % 2 === 0)
      .refine((points) =>
        points.every((coordinate, index) =>
          index % 2 === 0
            ? coordinate >= 0 && coordinate <= 600
            : coordinate >= 0 && coordinate <= 450,
        ),
      ),
  })
  .strict();
const fillSchema = z
  .object({
    type: z.literal("fill"),
    id: operationIdSchema,
    x: finiteNumberSchema.min(0).max(600),
    y: finiteNumberSchema.min(0).max(450),
    color: colorSchema,
  })
  .strict();
const clearSchema = z
  .object({ type: z.literal("clear"), id: operationIdSchema })
  .strict();
const undoSchema = z
  .object({ type: z.literal("undo"), id: operationIdSchema })
  .strict();

export const drawOpSchema = z.discriminatedUnion("type", [
  strokeSchema,
  fillSchema,
  clearSchema,
  undoSchema,
]);
export type DrawOp = z.infer<typeof drawOpSchema>;

export const canvasActionSchema = z.discriminatedUnion("type", [
  strokeSchema,
  fillSchema,
  clearSchema,
]);
export type CanvasAction = z.infer<typeof canvasActionSchema>;

export const canvasSnapshotSchema = z
  .object({
    actions: z.array(canvasActionSchema),
    rev: z.number().int().nonnegative(),
    resets: z.number().int().nonnegative(),
  })
  .strict();
export type CanvasSnapshot = z.infer<typeof canvasSnapshotSchema>;

export const liveCanvasSchema = z
  .object({
    label: z.string(),
    sequence: z.number().int().nonnegative(),
    canvas: canvasSnapshotSchema,
    locked: z.boolean(),
  })
  .strict();
export type LiveCanvas = z.infer<typeof liveCanvasSchema>;

export const roundResultEntrySchema = z
  .object({
    label: z.string(),
    artistId: nonEmptyStringSchema,
    rating: ratingSchema,
    canvas: canvasSnapshotSchema,
  })
  .strict();
export type RoundResultEntry = z.infer<typeof roundResultEntrySchema>;

export const roundResultSchema = z
  .object({
    roundIndex: z.number().int().nonnegative(),
    prompt: promptSchema,
    judgeId: nonEmptyStringSchema,
    entries: z.array(roundResultEntrySchema),
    winners: z.array(nonEmptyStringSchema),
  })
  .strict();
export type RoundResult = z.infer<typeof roundResultSchema>;

export const standingSchema = z
  .object({ playerId: nonEmptyStringSchema, score: scoreSchema })
  .strict();
export type Standing = z.infer<typeof standingSchema>;

export const finalResultSchema = z
  .object({
    winners: z.array(nonEmptyStringSchema),
    standings: z.array(standingSchema),
    rounds: z.number().int().nonnegative(),
    cycles: cyclesSchema,
  })
  .strict();
export type FinalResult = z.infer<typeof finalResultSchema>;

export const reactionSchema = z
  .object({
    id: nonEmptyStringSchema,
    playerId: nonEmptyStringSchema,
    playerName: playerNameSchema,
    emoji: reactionEmojiSchema,
    sentAt: finiteNumberSchema,
  })
  .strict();
export type Reaction = z.infer<typeof reactionSchema>;

export const playerViewSchema = z
  .object({
    roomCode: nonEmptyStringSchema,
    serverNow: finiteNumberSchema,
    me: playerSummarySchema,
    players: z.array(playerSummarySchema),
    hostId: nonEmptyStringSchema,
    cycles: cyclesSchema,
    matchStarted: z.boolean().default(false),
    phase: phaseSchema,
    deadline: finiteNumberSchema.nullable(),
    pause: z
      .object({ playerName: z.string(), until: finiteNumberSchema })
      .strict()
      .nullable(),
    notice: z.string().nullable(),
    match: z
      .object({
        roundIndex: z.number().int().nonnegative(),
        totalRounds: z.number().int().nonnegative(),
        cycle: z.number().int().min(1).max(3),
        judgeId: nonEmptyStringSchema,
        artistIds: z.array(nonEmptyStringSchema),
        order: z.array(nonEmptyStringSchema),
        scores: z.record(z.string(), scoreSchema),
      })
      .strict()
      .nullable(),
    role: roleSchema.nullable(),
    prompt: promptSchema.nullable(),
    suggestions: z.array(z.string()).nullable(),
    drawingStatus: z
      .object({
        ready: z.number().int().nonnegative(),
        total: z.number().int().positive(),
      })
      .strict()
      .refine(({ ready, total }) => ready <= total, "Ready Artists cannot exceed the total.")
      .nullable()
      .default(null),
    myCanvas: z
      .object({ canvas: canvasSnapshotSchema, locked: z.boolean() })
      .strict()
      .nullable(),
    liveCanvases: z.array(liveCanvasSchema).nullable(),
    gallery: z
      .array(z.object({ label: z.string(), canvas: canvasSnapshotSchema }).strict())
      .nullable(),
    judgingOvertime: z.boolean(),
    roundResult: roundResultSchema.nullable(),
    finalResult: finalResultSchema.nullable(),
    interruptedReason: z.string().nullable(),
  })
  .strict();
export type PlayerView = z.infer<typeof playerViewSchema>;

export const roomPlayerSchema = z
  .object({
    id: nonEmptyStringSchema,
    name: playerNameSchema,
    token: nonEmptyStringSchema,
    connected: z.boolean(),
    isBot: z.boolean(),
  })
  .strict();
export type RoomPlayer = z.infer<typeof roomPlayerSchema>;

export const drawingStateSchema = z
  .object({
    label: z.string(),
    artistId: nonEmptyStringSchema,
    canvas: canvasSnapshotSchema,
    locked: z.boolean(),
  })
  .strict();
export type DrawingState = z.infer<typeof drawingStateSchema>;

export const roomRoundSchema = z
  .object({
    judgeId: nonEmptyStringSchema,
    artistIds: z.array(nonEmptyStringSchema),
    suggestions: z.array(z.string()),
    prompt: promptSchema.nullable(),
    drawings: z.array(drawingStateSchema),
    overtime: z.boolean(),
    result: roundResultSchema.nullable(),
  })
  .strict();
export type RoomRound = z.infer<typeof roomRoundSchema>;

export const matchStateSchema = z
  .object({
    order: z.array(nonEmptyStringSchema),
    cycles: cyclesSchema,
    roundIndex: z.number().int().nonnegative(),
    totalRounds: z.number().int().nonnegative(),
    scores: z.record(z.string(), scoreSchema),
    round: roomRoundSchema,
    usedPrompts: z.array(z.string()),
    final: finalResultSchema.nullable(),
  })
  .strict();
export type MatchState = z.infer<typeof matchStateSchema>;

export const roomStateSchema = z
  .object({
    code: nonEmptyStringSchema,
    hostId: nonEmptyStringSchema,
    players: z.array(roomPlayerSchema),
    cycles: cyclesSchema,
    phase: phaseSchema,
    phaseStartedAt: finiteNumberSchema,
    deadline: finiteNumberSchema.nullable(),
    pause: z
      .object({
        playerId: nonEmptyStringSchema,
        until: finiteNumberSchema,
        remainingMs: finiteNumberSchema.nullable(),
      })
      .strict()
      .nullable(),
    match: matchStateSchema.nullable(),
    interruptedReason: z.string().nullable(),
    notice: z.string().nullable(),
  })
  .strict();
export type RoomState = z.infer<typeof roomStateSchema>;

export const serverOwnedStateSchema = z.array(roomStateSchema);
export type ServerOwnedState = z.infer<typeof serverOwnedStateSchema>;

export const serviceErrorCodeSchema = z.enum([
  "INVALID_INPUT",
  "ROOM_NOT_FOUND",
  "MATCH_IN_PROGRESS",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "WRONG_PHASE",
  "NOT_ENOUGH_PLAYERS",
  "PAUSED",
  "DEADLINE_PASSED",
  "NETWORK",
  "REQUEST_FAILED",
  "NOT_FOUND",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_SERVER_ERROR",
]);
export type ServiceErrorCode = z.infer<typeof serviceErrorCodeSchema>;

export const serviceErrorPayloadSchema = z
  .object({ code: serviceErrorCodeSchema, message: z.string() })
  .strict();
export type ServiceErrorPayload = z.infer<typeof serviceErrorPayloadSchema>;

export const healthResponseSchema = z.object({ status: z.literal("ready") }).strict();
export type HealthResponse = z.infer<typeof healthResponseSchema>;

const sessionPayload = z.object({ session: sessionSchema }).strict();
const namePayload = z.object({ name: playerNameSchema }).strict();
const roomNamePayload = z
  .object({ code: nonEmptyStringSchema, name: playerNameSchema })
  .strict();
const playerActionPayload = z
  .object({ session: sessionSchema, playerId: nonEmptyStringSchema })
  .strict();
const cyclesPayload = z
  .object({ session: sessionSchema, cycles: cyclesSchema })
  .strict();
const promptPayload = z
  .object({ session: sessionSchema, prompt: promptSchema })
  .strict();
const drawOpsPayload = z
  .object({ session: sessionSchema, ops: z.array(drawOpSchema).max(60) })
  .strict();
const ratingsPayload = z
  .object({
    session: sessionSchema,
    ratings: z.record(z.string(), ratingSchema),
  })
  .strict();
const reactionPayload = z
  .object({ session: sessionSchema, emoji: reactionEmojiSchema })
  .strict();
const emptyResponseSchema = z.object({}).strict();
const sessionResponseSchema = z
  .object({ session: sessionSchema })
  .strict();

export const clientToServerPayloadSchemas = {
  "room:create": namePayload,
  "room:join": roomNamePayload,
  "session:resume": sessionPayload,
  "room:leave": sessionPayload,
  "player:kick": playerActionPayload,
  "match:set-cycles": cyclesPayload,
  "match:start": sessionPayload,
  "prompt:select": promptPayload,
  "drawing:ops": drawOpsPayload,
  "drawing:submit": sessionPayload,
  "ratings:submit": ratingsPayload,
  "reaction:send": reactionPayload,
  "match:rematch": sessionPayload,
  "room:return-to-lobby": sessionPayload,
  "state:subscribe": sessionPayload,
} as const;
export type ClientToServerPayloads = {
  [Event in keyof typeof clientToServerPayloadSchemas]: z.infer<
    (typeof clientToServerPayloadSchemas)[Event]
  >;
};

export const clientToServerResponseSchemas = {
  "room:create": sessionResponseSchema,
  "room:join": sessionResponseSchema,
  "session:resume": sessionResponseSchema,
  "room:leave": emptyResponseSchema,
  "player:kick": emptyResponseSchema,
  "match:set-cycles": emptyResponseSchema,
  "match:start": emptyResponseSchema,
  "prompt:select": emptyResponseSchema,
  "drawing:ops": emptyResponseSchema,
  "drawing:submit": emptyResponseSchema,
  "ratings:submit": emptyResponseSchema,
  "reaction:send": emptyResponseSchema,
  "match:rematch": emptyResponseSchema,
  "room:return-to-lobby": emptyResponseSchema,
  "state:subscribe": emptyResponseSchema,
} as const;
export type ClientToServerResponses = {
  [Event in keyof typeof clientToServerResponseSchemas]: z.infer<
    (typeof clientToServerResponseSchemas)[Event]
  >;
};

export const serverToClientPayloadSchemas = {
  "state:update": playerViewSchema,
  "reaction:new": reactionSchema,
  error: serviceErrorPayloadSchema,
} as const;
export type ServerToClientPayloads = {
  [Event in keyof typeof serverToClientPayloadSchemas]: z.infer<
    (typeof serverToClientPayloadSchemas)[Event]
  >;
};
