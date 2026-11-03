import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

const db = vi.hoisted(() => ({ session: null as any, created: null as any, updates: [] as any[], synced: [] as string[] }));

vi.mock("./storage", () => ({
  storage: {
    createGameSession: async (d: any) => (db.created = db.session = { id: "s1", createdAt: new Date(Date.now() - 90_000), endedAt: null, ...d }),
    getGameSession: async () => db.session,
    updateGameSession: async (_id: string, u: any) => { db.updates.push(u); return (db.session = { ...db.session, ...u }); },
  },
}));
vi.mock("./auth", () => ({ setupAuth: () => {} }));
vi.mock("./sendgrid", () => ({ sendAchievementCard: async () => true }));
vi.mock("./sheetsSync", () => ({ syncSession: (id: string) => db.synced.push(id) }));

import { registerRoutes } from "./routes";

let base: string, server: any;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  server = await registerRoutes(app);
  await new Promise<void>(r => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => { db.session = null; db.updates.length = 0; db.synced.length = 0; });

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("anonymous session routes", () => {
  it("creates a session using server-derived device/browser, ignoring client-claimed values", async () => {
    const res = await send("POST", "/api/anonymous-session", { playerEmail: "p@x.com" }, { "user-agent": "Mozilla/5.0 (iPhone) Mobile" });
    expect(res.status).toBe(201);
    expect(db.created).toMatchObject({ playerEmail: "p@x.com", deviceType: "mobile", browserInfo: "Mozilla/5.0 (iPhone) Mobile" });
    expect((await send("POST", "/api/anonymous-session", { playerEmail: "nope" })).status).toBe(400);
  });

  it("ignores forged fields and rejects out-of-range numbers", async () => {
    await send("POST", "/api/anonymous-session", {});
    // client-supplied end time / location / duration are never applied
    const forged = await send("PATCH", "/api/anonymous-session/s1", { endedAt: "1999-01-01", country: "XX", sessionDuration: 5 });
    expect(forged.status).toBe(200);
    expect((await send("PATCH", "/api/anonymous-session/s1", { score: -1 })).status).toBe(400);
    expect((await send("PATCH", "/api/anonymous-session/s1", { score: 1e12 })).status).toBe(400);
    expect(db.updates).toHaveLength(0);
  });

  it("server computes end time, duration and persona cards", async () => {
    await send("POST", "/api/anonymous-session", {});
    const res = await send("PATCH", "/api/anonymous-session/s1", { score: 130, level: 2, endReason: "game_over" });
    expect(res.status).toBe(200);
    const u = db.updates[0];
    expect(u.personaCardsEarned).toBe(2);
    expect(u.sessionDuration).toBeGreaterThanOrEqual(90);
    expect(u.endedAt).toBeInstanceOf(Date);
    expect(db.synced).toEqual(["s1"]);
  });

  it("first end wins: after the game ended only the email can be attached", async () => {
    await send("POST", "/api/anonymous-session", {});
    await send("PATCH", "/api/anonymous-session/s1", { score: 130, endReason: "game_over" });
    db.updates.length = 0;
    await send("PATCH", "/api/anonymous-session/s1", { score: 9999, endReason: "left", playerEmail: "late@x.com" });
    expect(db.updates).toEqual([{ playerEmail: "late@x.com" }]);
    expect(db.synced).toEqual(["s1", "s1"]);
  });

  it("accepts the sendBeacon POST /end and 404s unknown sessions", async () => {
    await send("POST", "/api/anonymous-session", {});
    expect((await send("POST", "/api/anonymous-session/s1/end", { score: 40, endReason: "left" })).status).toBe(200);
    expect(db.session.endReason).toBe("left");
    db.session = null;
    expect((await send("POST", "/api/anonymous-session/nope/end", { endReason: "left" })).status).toBe(404);
  });
});
