import { GoogleAuth } from "google-auth-library";
import type { GameSessionType, PlayerAnswerType } from "@shared/schema";
import { getSentenceTemplate } from "@shared/sentences";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
export const SESSIONS_TAB = "Sessions";
export const ANSWERS_TAB = "Answers";

export const SESSION_HEADERS = [
  "Play ID", "Player Email", "Started (UTC)", "Ended (UTC)", "Duration (s)", "End Reason",
  "Score", "Level", "Lines Cleared", "Pieces Placed", "Sentences Attempted", "Sentences Completed",
  "Persona Cards Earned", "Device Type", "Country", "Region", "Browser",
];

export const ANSWER_HEADERS = [
  "Answer ID", "Play ID", "Player Email", "Sentence ID", "Sentence Template",
  "Player Answer", "Answer Score", "Answered At (UTC)",
];

type Cell = string | number;

export const sessionRow = (s: GameSessionType): Cell[] => {
  const duration = s.endedAt
    ? Math.floor((s.endedAt.getTime() - s.createdAt.getTime()) / 1000)
    : s.sessionDuration ?? 0;
  return [
    s.id, s.playerEmail ?? "Anonymous", s.createdAt.toISOString(), s.endedAt?.toISOString() ?? "",
    duration, s.endReason ?? "no_end_signal",
    s.score, s.level, s.linesCleared, s.piecesPlaced, s.sentencesAttempted, s.sentencesCompleted,
    s.personaCardsEarned, s.deviceType ?? "Unknown", s.country ?? "Unknown", s.region ?? "Unknown",
    s.browserInfo ?? "Unknown",
  ];
};

export const answerRow = (a: PlayerAnswerType, playerEmail: string | null): Cell[] => [
  a.id, a.sessionId, playerEmail ?? "Anonymous", a.sentenceId, getSentenceTemplate(a.sentenceId),
  a.answer, a.score, a.createdAt.toISOString(),
];

export const sheetsEnabled = () =>
  !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_SHEET_ID);

let authClient: ReturnType<GoogleAuth["getClient"]> | null = null;
function client() {
  if (!authClient) {
    const auth = new GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    authClient = auth.getClient();
  }
  return authClient;
}

async function call<T = any>(path: string, opts: { method?: string; params?: Record<string, string>; data?: unknown } = {}): Promise<T> {
  const c = await client();
  const res = await c.request<T>({
    url: `${API}/${process.env.GOOGLE_SHEET_ID}${path}`,
    method: (opts.method ?? "GET") as "GET" | "POST" | "PUT",
    params: opts.params,
    data: opts.data,
  });
  return res.data;
}

// Quote tab names for A1 notation
const a1 = (tab: string, range: string) => `'${tab}'!${range}`;

// All writes go through one queue: keeps row lookups consistent and stays under Sheets rate limits.
let queue: Promise<unknown> = Promise.resolve();
const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
};

let tabsReady: Promise<void> | null = null;
function ensureTabs(): Promise<void> {
  if (!tabsReady) {
    tabsReady = (async () => {
      const meta = await call<{ sheets: { properties: { sheetId: number; title: string } }[] }>("", {
        params: { fields: "sheets.properties(sheetId,title)" },
      });
      const titles = meta.sheets.map(s => s.properties.title);
      const requests: unknown[] = [];

      // A brand-new spreadsheet has one default tab: reuse it as "Sessions"
      if (!titles.includes(SESSIONS_TAB) && meta.sheets.length === 1) {
        requests.push({
          updateSheetProperties: {
            properties: { sheetId: meta.sheets[0].properties.sheetId, title: SESSIONS_TAB, gridProperties: { frozenRowCount: 1 } },
            fields: "title,gridProperties.frozenRowCount",
          },
        });
      } else if (!titles.includes(SESSIONS_TAB)) {
        requests.push({ addSheet: { properties: { title: SESSIONS_TAB, gridProperties: { frozenRowCount: 1 } } } });
      }
      if (!titles.includes(ANSWERS_TAB)) {
        requests.push({ addSheet: { properties: { title: ANSWERS_TAB, gridProperties: { frozenRowCount: 1 } } } });
      }
      if (requests.length) await call(":batchUpdate", { method: "POST", data: { requests } });

      for (const [tab, headers] of [[SESSIONS_TAB, SESSION_HEADERS], [ANSWERS_TAB, ANSWER_HEADERS]] as const) {
        const first = await call<{ values?: string[][] }>(`/values/${encodeURIComponent(a1(tab, "A1"))}`);
        if (!first.values?.length) {
          await call(`/values/${encodeURIComponent(a1(tab, "A1"))}`, {
            method: "PUT", params: { valueInputOption: "RAW" }, data: { values: [headers] },
          });
        }
      }
    })().catch(err => { tabsReady = null; throw err; });
  }
  return tabsReady;
}

/** Insert or update rows keyed by the first column (the ID). */
export function upsertRows(tab: string, rows: Cell[][]): Promise<void> {
  if (!rows.length) return Promise.resolve();
  return enqueue(async () => {
    await ensureTabs();
    const col = await call<{ values?: string[][] }>(`/values/${encodeURIComponent(a1(tab, "A:A"))}`);
    const rowByKey = new Map<string, number>();
    (col.values ?? []).forEach((v, i) => { if (i > 0 && v[0]) rowByKey.set(v[0], i + 1); });

    const updates: { range: string; values: Cell[][] }[] = [];
    const appends: Cell[][] = [];
    for (const row of rows) {
      const n = rowByKey.get(String(row[0]));
      if (n) updates.push({ range: a1(tab, `A${n}`), values: [row] });
      else appends.push(row);
    }
    if (updates.length) {
      await call("/values:batchUpdate", { method: "POST", data: { valueInputOption: "RAW", data: updates } });
    }
    if (appends.length) {
      await call(`/values/${encodeURIComponent(a1(tab, "A1"))}:append`, {
        method: "POST",
        params: { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
        data: { values: appends },
      });
    }
  }).catch(err => {
    tabsReady = null; // e.g. a tab was deleted by hand: re-check tabs and headers on the next attempt
    throw err;
  });
}
