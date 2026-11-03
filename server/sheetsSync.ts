import { storage } from "./storage";
import { ANSWERS_TAB, SESSIONS_TAB, answerRow, sessionRow, sheetsEnabled, upsertRows } from "./sheets";
import type { GameSessionType } from "@shared/schema";

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BATCH = 10;
// A session with no end signal this long after it started is treated as abandoned and synced as-is
const ABANDONED_AFTER_MINUTES = 60;

async function syncSessionRecord(session: GameSessionType): Promise<void> {
  const answers = await storage.getSessionAnswers(session.id);
  await upsertRows(SESSIONS_TAB, [sessionRow(session)]);
  await upsertRows(ANSWERS_TAB, answers.map(a => answerRow(a, session.playerEmail)));
  // Record the updated_at we synced, so any change made mid-sync is picked up by the next sweep
  await storage.markSheetsSynced(session.id, session.updatedAt);
}

/** Fire-and-forget sync of one session. Failures are retried by the sweep. */
export function syncSession(id: string): void {
  if (!sheetsEnabled()) return;
  storage.getGameSession(id)
    .then(s => s && syncSessionRecord(s))
    .catch(err => console.error(`[sheets] sync failed for ${id}:`, err?.message ?? err));
}

async function sweep(): Promise<void> {
  const pending = await storage.getSessionsPendingSheetsSync(ABANDONED_AFTER_MINUTES, SWEEP_BATCH);
  for (const session of pending) {
    try {
      await syncSessionRecord(session);
    } catch (err: any) {
      console.error(`[sheets] sweep failed for ${session.id}:`, err?.message ?? err);
      return; // Stop this round (likely quota/auth); retry on the next tick
    }
  }
  if (pending.length) console.log(`[sheets] synced ${pending.length} session(s)`);
}

export function startSheetsSweep(): void {
  if (!sheetsEnabled()) {
    console.warn("[sheets] GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_SHEET_ID not set - Google Sheets sync is disabled");
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await sweep(); } catch (err: any) { console.error("[sheets] sweep error:", err?.message ?? err); }
    finally { running = false; }
  };
  setInterval(tick, SWEEP_INTERVAL_MS);
  void tick();
  console.log("[sheets] Google Sheets sync enabled");
}
