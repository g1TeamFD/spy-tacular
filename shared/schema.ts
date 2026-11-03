import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
});

// Player profiles (email-based, no authentication)
export const playerProfile = pgTable("player_profile", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  totalScore: integer("total_score").notNull().default(0),
  highestSessionScore: integer("highest_session_score").notNull().default(0),
  totalPlays: integer("total_plays").notNull().default(0),
  completedSentencesCount: integer("completed_sentences_count").notNull().default(0),
  currentStreak: integer("current_streak").notNull().default(0),
  longestStreak: integer("longest_streak").notNull().default(0),
  lastPlayDate: timestamp("last_play_date"),
  personaCardsUnlocked: integer("persona_cards_unlocked").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const gameSession = pgTable("game_session", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  playerEmail: text("player_email"), // nullable for anonymous sessions
  score: integer("score").notNull().default(0),
  level: integer("level").notNull().default(1),
  completedSentences: json("completed_sentences").$type<string[]>().notNull().default(sql`'[]'::json`),
  sessionDuration: integer("session_duration"), // in seconds
  linesCleared: integer("lines_cleared").notNull().default(0),
  piecesPlaced: integer("pieces_placed").notNull().default(0),
  sentencesAttempted: integer("sentences_attempted").notNull().default(0),
  sentencesCompleted: integer("sentences_completed").notNull().default(0),
  deviceType: text("device_type"), // mobile/desktop/tablet
  browserInfo: text("browser_info"), // user agent string
  ipAddress: text("ip_address"),
  country: text("country"),
  region: text("region"),
  personaCardsEarned: integer("persona_cards_earned").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  endReason: text("end_reason"), // game_over | left (tab closed); null = no end signal received
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  // Value of updated_at that was last written to Google Sheets. Pending sync = null or < updated_at.
  sheetsSyncedAt: timestamp("sheets_synced_at"),
});

export const playerAnswer = pgTable("player_answer", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: text("session_id").notNull(),
  sentenceId: text("sentence_id").notNull(),
  answer: text("answer").notNull(),
  score: integer("score").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Completed sentences tracking
export const completedSentence = pgTable("completed_sentence", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  playerEmail: text("player_email").notNull(),
  sentenceId: text("sentence_id").notNull(),
  playerAnswer: text("player_answer").notNull(),
  score: integer("score").notNull(),
  sessionId: text("session_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const achievementCard = pgTable("achievement_card", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  totalScore: integer("total_score").notNull(),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
});

// Game types
export type GamePiece = {
  id: string;
  type: 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
  blocks: { x: number; y: number; keyword: string }[];
  x: number;
  y: number;
  rotation: number;
};

export type GameState = {
  board: (string | null)[][];
  currentPiece: GamePiece | null;
  nextPiece: GamePiece | null;
  score: number;
  level: number;
  lines: number;
  gameOver: boolean;
  paused: boolean;
};

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  email: true,
  password: true,
});

export const insertPlayerProfileSchema = createInsertSchema(playerProfile).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertGameSessionSchema = createInsertSchema(gameSession).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  sheetsSyncedAt: true,
}).extend({
  completedSentences: z.array(z.string()).optional(),
});

export const insertPlayerAnswerSchema = createInsertSchema(playerAnswer).omit({
  id: true,
  createdAt: true,
});

export const insertCompletedSentenceSchema = createInsertSchema(completedSentence).omit({
  id: true,
  createdAt: true,
});

export const insertAchievementCardSchema = createInsertSchema(achievementCard).omit({
  id: true,
  sentAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertPlayerProfile = z.infer<typeof insertPlayerProfileSchema>;
export type PlayerProfile = typeof playerProfile.$inferSelect;
export type InsertGameSession = z.infer<typeof insertGameSessionSchema>;
export type GameSessionType = typeof gameSession.$inferSelect;
export type InsertPlayerAnswer = z.infer<typeof insertPlayerAnswerSchema>;
export type PlayerAnswerType = typeof playerAnswer.$inferSelect;
export type InsertCompletedSentence = z.infer<typeof insertCompletedSentenceSchema>;
export type CompletedSentenceType = typeof completedSentence.$inferSelect;
export type InsertAchievementCard = z.infer<typeof insertAchievementCardSchema>;
export type AchievementCardType = typeof achievementCard.$inferSelect;

// Utility functions
export const calculatePersonaCards = (totalScore: number): number => {
  return Math.floor(totalScore / 50);
};

export const getDeviceType = (userAgent: string): string => {
  if (/mobile/i.test(userAgent)) return 'mobile';
  if (/tablet|ipad/i.test(userAgent)) return 'tablet';
  return 'desktop';
};