import { 
  type User, 
  type InsertUser,
  type GameSessionType,
  type InsertGameSession,
  type PlayerAnswerType,
  type InsertPlayerAnswer,
  type AchievementCardType,
  type InsertAchievementCard,
  users,
  gameSession,
  playerAnswer,
  achievementCard
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, sql, and, gte, or, isNull, isNotNull, lt } from "drizzle-orm";
import session from "express-session";
import connectPg from "connect-pg-simple";
import { pool } from "./db";

export interface IStorage {
  // User operations
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Game session operations
  createGameSession(session: InsertGameSession): Promise<GameSessionType>;
  updateGameSession(id: string, updates: Partial<InsertGameSession>): Promise<GameSessionType | undefined>;
  getGameSession(id: string): Promise<GameSessionType | undefined>;
  getPlayerSessions(playerEmail: string, limit?: number): Promise<GameSessionType[]>;
  getPlayerTotalScore(playerEmail: string, hoursBack?: number): Promise<number>;
  
  // Player answer operations
  createPlayerAnswer(answer: InsertPlayerAnswer): Promise<PlayerAnswerType>;
  getSessionAnswers(sessionId: string): Promise<PlayerAnswerType[]>;
  
  // Achievement card operations
  createAchievementCard(card: InsertAchievementCard): Promise<AchievementCardType>;
  hasRecentAchievementCard(email: string, hoursBack?: number): Promise<boolean>;
  
  // Data export operations
  getLeaderboardData(limit?: number): Promise<any[]>;

  // Google Sheets sync
  getSessionsPendingSheetsSync(idleMinutes: number, limit: number): Promise<GameSessionType[]>;
  markSheetsSynced(id: string, syncedUpdatedAt: Date): Promise<void>;
  
  // Session store for authentication
  sessionStore: session.Store;
}

const PostgresSessionStore = connectPg(session);

export class DatabaseStorage implements IStorage {
  sessionStore: session.Store;

  constructor() {
    this.sessionStore = new PostgresSessionStore({ 
      pool, 
      createTableIfMissing: true 
    });
  }

  // User operations
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  // Game session operations
  async createGameSession(session: InsertGameSession): Promise<GameSessionType> {
    const [gameSessionResult] = await db
      .insert(gameSession)
      .values(session)
      .returning();
    return gameSessionResult;
  }

  async updateGameSession(id: string, updates: Partial<Omit<InsertGameSession, 'id' | 'createdAt'>>): Promise<GameSessionType | undefined> {
    const [updated] = await db
      .update(gameSession)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(gameSession.id, id))
      .returning();
    return updated || undefined;
  }

  async getGameSession(id: string): Promise<GameSessionType | undefined> {
    const [session] = await db.select().from(gameSession).where(eq(gameSession.id, id));
    return session || undefined;
  }

  async getPlayerSessions(playerEmail: string, limit: number = 10): Promise<GameSessionType[]> {
    return await db
      .select()
      .from(gameSession)
      .where(eq(gameSession.playerEmail, playerEmail))
      .orderBy(desc(gameSession.createdAt))
      .limit(limit);
  }

  async getPlayerTotalScore(playerEmail: string, hoursBack: number = 24): Promise<number> {
    const cutoffDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const sessions = await db
      .select({ score: gameSession.score })
      .from(gameSession)
      .where(and(
        eq(gameSession.playerEmail, playerEmail),
        gte(gameSession.createdAt, cutoffDate)
      ))
      .execute();
    
    return sessions.reduce((total, session) => total + session.score, 0);
  }

  // Player answer operations
  async createPlayerAnswer(answer: InsertPlayerAnswer): Promise<PlayerAnswerType> {
    const [answerResult] = await db
      .insert(playerAnswer)
      .values(answer)
      .returning();
    // Make the session re-sync so the new answer reaches the sheet
    await db.update(gameSession).set({ updatedAt: new Date() }).where(eq(gameSession.id, answer.sessionId));
    return answerResult;
  }

  async getSessionAnswers(sessionId: string): Promise<PlayerAnswerType[]> {
    return await db
      .select()
      .from(playerAnswer)
      .where(eq(playerAnswer.sessionId, sessionId))
      .orderBy(desc(playerAnswer.createdAt));
  }

  // Achievement card operations
  async createAchievementCard(card: InsertAchievementCard): Promise<AchievementCardType> {
    const [cardResult] = await db
      .insert(achievementCard)
      .values(card)
      .returning();
    return cardResult;
  }

  async hasRecentAchievementCard(email: string, hoursBack: number = 24): Promise<boolean> {
    const cutoffDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const [recent] = await db
      .select({ id: achievementCard.id })
      .from(achievementCard)
      .where(and(
        eq(achievementCard.email, email),
        gte(achievementCard.sentAt, cutoffDate)
      ))
      .limit(1);
    
    return !!recent;
  }

  // Leaderboard operations
  async getLeaderboardData(limit: number = 20): Promise<any[]> {
    // Get aggregated player statistics
    const playerStats = await db
      .select({
        playerEmail: gameSession.playerEmail,
        totalScore: sql<number>`sum(${gameSession.score})`.as('total_score'),
        totalPlays: sql<number>`count(*)`.as('total_plays'),
        totalSentencesCompleted: sql<number>`sum(${gameSession.sentencesCompleted})`.as('total_sentences_completed'),
        lastActiveDate: sql<Date>`max(${gameSession.createdAt})`.as('last_active_date'),
        firstPlayDate: sql<Date>`min(${gameSession.createdAt})`.as('first_play_date')
      })
      .from(gameSession)
      .where(sql`${gameSession.playerEmail} IS NOT NULL`)
      .groupBy(gameSession.playerEmail)
      .orderBy(sql`sum(${gameSession.score}) DESC`)
      .limit(limit);

    // Calculate derived statistics for each player
    const leaderboardData = playerStats.map(player => {
      const now = new Date();
      const lastActive = new Date(player.lastActiveDate);
      const firstPlay = new Date(player.firstPlayDate);
      
      // Calculate time since last active
      const hoursAgo = Math.floor((now.getTime() - lastActive.getTime()) / (1000 * 60 * 60));
      const daysAgo = Math.floor(hoursAgo / 24);
      
      let lastActiveDisplay;
      if (hoursAgo < 1) {
        lastActiveDisplay = 'Just now';
      } else if (hoursAgo < 24) {
        lastActiveDisplay = `${hoursAgo}h ago`;
      } else {
        lastActiveDisplay = `${daysAgo}d ago`;
      }
      
      // Calculate days streak (simplified - consecutive days)
      // For now, we'll calculate total days played as an approximation
      const totalDaysPlayed = Math.max(1, Math.ceil((lastActive.getTime() - firstPlay.getTime()) / (1000 * 60 * 60 * 24)));
      const averagePlaysPerDay = Math.round(player.totalPlays / totalDaysPlayed * 10) / 10;
      
      // Calculate achievement cards (50 points = 1 card)
      const achievementCards = Math.floor(player.totalScore / 50);
      
      // Mask email (show first 5 characters)
      const maskedEmail = player.playerEmail ? 
        player.playerEmail.substring(0, 5) + '*'.repeat(Math.max(0, player.playerEmail.length - 5)) 
        : 'Anon*****';
      
      return {
        playerEmail: maskedEmail,
        fullEmail: player.playerEmail, // Keep for internal use
        totalScore: player.totalScore,
        totalPlays: player.totalPlays,
        completedSentences: player.totalSentencesCompleted,
        achievementCards,
        daysStreak: Math.min(totalDaysPlayed, player.totalPlays), // Simple approximation
        lastActive: lastActiveDisplay,
        lastActiveDate: player.lastActiveDate,
        averagePlaysPerDay
      };
    });

    return leaderboardData;
  }

  // Google Sheets sync operations
  async getSessionsPendingSheetsSync(idleMinutes: number, limit: number): Promise<GameSessionType[]> {
    const idleCutoff = new Date(Date.now() - idleMinutes * 60 * 1000);
    return await db
      .select()
      .from(gameSession)
      .where(and(
        // Ended sessions, or sessions that never sent an end signal and have gone quiet
        or(isNotNull(gameSession.endedAt), lt(gameSession.createdAt, idleCutoff)),
        or(isNull(gameSession.sheetsSyncedAt), lt(gameSession.sheetsSyncedAt, gameSession.updatedAt))
      ))
      .orderBy(gameSession.updatedAt)
      .limit(limit);
  }

  async markSheetsSynced(id: string, syncedUpdatedAt: Date): Promise<void> {
    await db.update(gameSession).set({ sheetsSyncedAt: syncedUpdatedAt }).where(eq(gameSession.id, id));
  }
}

export const storage = new DatabaseStorage();
