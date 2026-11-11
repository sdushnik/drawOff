import type { Page } from "@playwright/test";
import type { Cycles, DrawOp, Session } from "@drawoff/contracts";
import { createSocketGameService } from "../src/services/socketGameService";

type ServiceMethod =
  "kickPlayer" | "setCycles" | "startMatch" | "sendDrawOps" | "submitCanvas" | "submitRatings";

export type ServiceCallResult = { ok: true } | { ok: false; code: string; message: string };

export async function frontendServiceCall(
  page: Page,
  method: ServiceMethod,
  args: unknown[] = [],
): Promise<ServiceCallResult> {
  const session = await storedSession(page);
  const service = createSocketGameService(serverUrl());
  let unsubscribe = () => undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      unsubscribe = service.subscribe(session, () => resolve(), reject);
    });
    if (method === "kickPlayer") await service.kickPlayer(session, args[0] as string);
    if (method === "setCycles") await service.setCycles(session, args[0] as Cycles);
    if (method === "startMatch") await service.startMatch(session);
    if (method === "sendDrawOps") await service.sendDrawOps(session, args[0] as DrawOp[]);
    if (method === "submitCanvas") await service.submitCanvas(session);
    if (method === "submitRatings") {
      await service.submitRatings(session, args[0] as Record<string, number>);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: typeof error === "object" && error && "code" in error ? String(error.code) : "UNKNOWN",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    unsubscribe();
  }
}

export async function storedSession(page: Page): Promise<Session> {
  return page.evaluate(() => {
    const code = location.pathname.split("/").at(-1)!.toUpperCase();
    const raw = sessionStorage.getItem(`drawoff:session:${code}`);
    if (!raw) throw new Error("The browser session was not stored.");
    return JSON.parse(raw) as Session;
  });
}

export function serverUrl(): string {
  return process.env["DRAWOFF_E2E_BASE_URL"] ?? "http://127.0.0.1:8080";
}
