import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for the Google Sheets REST API (only the calls sheets.ts makes)
const book = vi.hoisted(() => ({ tabs: new Map<string, string[][]>(), calls: [] as string[], init: () => {} }));

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return {
        async request({ url, method = "GET", params, data }: any) {
          const path = decodeURIComponent(url.split("/spreadsheets/sheet")[1] ?? "");
          book.calls.push(`${method} ${path}`);
          const rowsOf = (tab: string) => book.tabs.get(tab)!;
          const tabOf = (p: string) => /^\/values\/'(.+?)'!/.exec(p)![1];

          if (method === "GET" && path === "") {
            return { data: { sheets: [...book.tabs.keys()].map((title, i) => ({ properties: { sheetId: i, title } })) } };
          }
          if (path === ":batchUpdate") {
            for (const r of data.requests) {
              if (r.addSheet) book.tabs.set(r.addSheet.properties.title, []);
              if (r.updateSheetProperties) {
                const old = [...book.tabs.keys()][r.updateSheetProperties.properties.sheetId];
                book.tabs.set(r.updateSheetProperties.properties.title, book.tabs.get(old)!);
                if (old !== r.updateSheetProperties.properties.title) book.tabs.delete(old);
              }
            }
            return { data: {} };
          }
          if (method === "GET") {
            const tab = tabOf(path);
            const range = path.split("!")[1];
            const rows = rowsOf(tab);
            if (range === "A1") return { data: { values: rows[0] ? [rows[0]] : undefined } };
            return { data: { values: rows.map(r => [r[0]]) } };
          }
          if (method === "PUT") { rowsOf(tabOf(path))[0] = data.values[0]; return { data: {} }; }
          if (path === "/values:batchUpdate") {
            expect(data.valueInputOption).toBe("RAW");
            for (const u of data.data) {
              const tab = /^'(.+?)'!A(\d+)$/.exec(u.range)!;
              rowsOf(tab[1])[Number(tab[2]) - 1] = u.values[0];
            }
            return { data: {} };
          }
          if (path.endsWith(":append")) {
            expect(params.valueInputOption).toBe("RAW");
            rowsOf(tabOf(path)).push(...data.values);
            return { data: {} };
          }
          throw new Error(`unhandled ${method} ${path}`);
        },
      };
    }
  },
}));

process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "{}";
process.env.GOOGLE_SHEET_ID = "sheet";

import type * as SheetsModule from "./sheets";

const session: any = {
  id: "s1", playerEmail: null, score: 120, level: 2, completedSentences: [], sessionDuration: null,
  linesCleared: 4, piecesPlaced: 30, sentencesAttempted: 2, sentencesCompleted: 1, deviceType: "desktop",
  browserInfo: "UA", ipAddress: null, country: "VN", region: "SG", personaCardsEarned: 2,
  createdAt: new Date("2026-01-01T00:00:00Z"), endedAt: new Date("2026-01-01T00:01:30Z"), endReason: "game_over",
  updatedAt: new Date(), sheetsSyncedAt: null,
};

let upsertRows: typeof SheetsModule.upsertRows, sessionRow: typeof SheetsModule.sessionRow, answerRow: typeof SheetsModule.answerRow;
let SESSIONS_TAB: string, ANSWERS_TAB: string, SESSION_HEADERS: string[], ANSWER_HEADERS: string[];

describe("Google Sheets sync", () => {
  beforeEach(async () => {
    book.tabs.clear(); book.tabs.set("Sheet1", []); book.calls.length = 0;
    vi.resetModules(); // fresh module = fresh "tabs ready" cache
    ({ upsertRows, sessionRow, answerRow, SESSIONS_TAB, ANSWERS_TAB, SESSION_HEADERS, ANSWER_HEADERS } = await import("./sheets"));
  });

  it("recovers when a tab is deleted while running", async () => {
    await upsertRows(SESSIONS_TAB, [sessionRow(session)]);
    book.tabs.delete(ANSWERS_TAB);
    await expect(upsertRows(ANSWERS_TAB, [["a1", "s1", "x", "1", "t", "ans", 5, "d"]])).rejects.toThrow();
    await upsertRows(ANSWERS_TAB, [["a1", "s1", "x", "1", "t", "ans", 5, "d"]]); // retry re-creates it
    expect(book.tabs.get(ANSWERS_TAB)).toHaveLength(2);
  });

  it("maps a session to a row with one cell per header", () => {
    const row = sessionRow(session);
    expect(row).toHaveLength(SESSION_HEADERS.length);
    expect(row[1]).toBe("Anonymous");
    expect(row[4]).toBe(90); // duration derived from start/end
    expect(row[5]).toBe("game_over");
    expect(sessionRow({ ...session, endedAt: null, endReason: null })[5]).toBe("no_end_signal");
  });

  it("maps an answer with its sentence template", () => {
    const row = answerRow({ id: "a1", sessionId: "s1", sentenceId: "2", answer: "sustainable", score: 50, createdAt: new Date() } as any, "p@x.com");
    expect(row).toHaveLength(ANSWER_HEADERS.length);
    expect(row[4]).toBe("Together we can create a more _____ world.");
  });

  it("renames the default tab, creates Answers and writes headers", async () => {
    await upsertRows(SESSIONS_TAB, [sessionRow(session)]);
    expect([...book.tabs.keys()].sort()).toEqual([ANSWERS_TAB, SESSIONS_TAB]);
    expect(book.tabs.get(SESSIONS_TAB)![0]).toEqual(SESSION_HEADERS);
    expect(book.tabs.get(ANSWERS_TAB)![0]).toEqual(ANSWER_HEADERS);
    expect(book.tabs.get(SESSIONS_TAB)).toHaveLength(2);
  });

  it("is idempotent: syncing the same session twice updates in place", async () => {
    await upsertRows(SESSIONS_TAB, [sessionRow(session)]);
    await upsertRows(SESSIONS_TAB, [sessionRow({ ...session, playerEmail: "a@b.com" })]);
    const rows = book.tabs.get(SESSIONS_TAB)!;
    expect(rows).toHaveLength(2);
    expect(rows[1][1]).toBe("a@b.com");
  });

  it("keeps concurrent upserts of different sessions on separate rows", async () => {
    await Promise.all([
      upsertRows(SESSIONS_TAB, [sessionRow({ ...session, id: "s2" })]),
      upsertRows(SESSIONS_TAB, [sessionRow({ ...session, id: "s3" })]),
      upsertRows(SESSIONS_TAB, [sessionRow({ ...session, id: "s2", score: 999 })]),
    ]);
    const rows = book.tabs.get(SESSIONS_TAB)!;
    expect(rows.map(r => r[0])).toEqual(["Play ID", "s2", "s3"]);
    expect(rows[1][6]).toBe(999);
  });
});
