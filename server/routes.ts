import type { Express, RequestHandler } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth } from "./auth";
import { sendAchievementCard } from "./sendgrid";
import geoip from "geoip-lite";
import { z } from "zod";
import { 
  insertGameSessionSchema,
  insertPlayerAnswerSchema,
  insertAchievementCardSchema,
  calculatePersonaCards,
  getDeviceType,
  type InsertGameSession
} from "@shared/schema";
import { syncSession } from "./sheetsSync";

const counter = (max: number) => z.number().int().min(0).max(max);

// The only fields a browser may send about a play session. Everything else is set by the server.
const sessionUpdateSchema = z.object({
  score: counter(1_000_000),
  level: z.number().int().min(1).max(1000),
  linesCleared: counter(100_000),
  piecesPlaced: counter(100_000),
  sentencesAttempted: counter(100_000),
  sentencesCompleted: counter(100_000),
  endReason: z.enum(["game_over", "left"]),
  playerEmail: z.string().trim().email().max(254),
}).partial(); // unknown fields (e.g. endedAt from an older cached client) are dropped, never applied

export async function registerRoutes(app: Express): Promise<Server> {
  // Setup authentication routes: /api/register, /api/login, /api/logout, /api/user
  setupAuth(app);

  // Game session routes
  app.post("/api/game-session", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }
      
      const sessionData = insertGameSessionSchema.parse({
        ...req.body,
        playerEmail: req.user.email
      });
      
      const session = await storage.createGameSession(sessionData);
      
      res.status(201).json(session);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Anonymous game session routes
  app.post("/api/anonymous-session", async (req, res) => {
    try {
      const body = sessionUpdateSchema.pick({ playerEmail: true }).parse(req.body ?? {});
      const userAgent = req.get("user-agent") ?? "";
      const geo = req.ip ? geoip.lookup(req.ip) : null; // IP is used for lookup only, never stored

      const sessionData: InsertGameSession = {
        playerEmail: body.playerEmail ?? null,
        deviceType: getDeviceType(userAgent),
        browserInfo: userAgent,
        country: geo?.country ?? "Unknown",
        region: geo?.region || "Unknown",
      };

      const session = await storage.createGameSession(sessionData);
      res.status(201).json(session);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Update a play session. POST /end exists because navigator.sendBeacon can only POST.
  const updateAnonymousSession: RequestHandler = async (req, res) => {
    try {
      const sessionId = req.params.id;
      const existing = await storage.getGameSession(sessionId);
      if (!existing) {
        return res.status(404).json({ message: "Session not found" });
      }

      const parsed = sessionUpdateSchema.parse(req.body ?? {});
      let updates: Partial<InsertGameSession> = {};

      if (existing.endedAt) {
        // First end wins. After the game is over, the only allowed change is attaching an email.
        if (parsed.playerEmail) updates.playerEmail = parsed.playerEmail;
      } else {
        updates = { ...parsed };
        if (parsed.score !== undefined) {
          updates.personaCardsEarned = calculatePersonaCards(parsed.score);
        }
        if (parsed.endReason) {
          const now = new Date();
          updates.endedAt = now;
          updates.sessionDuration = Math.floor((now.getTime() - existing.createdAt.getTime()) / 1000);
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.json(existing);
      }

      const session = await storage.updateGameSession(sessionId, updates);
      if (session?.endedAt) syncSession(sessionId);
      res.json(session);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unknown error' });
    }
  };
  app.patch("/api/anonymous-session/:id", updateAnonymousSession);
  app.post("/api/anonymous-session/:id/end", updateAnonymousSession);

  app.patch("/api/game-session/:id", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }
      
      const sessionId = req.params.id;
      
      // Check ownership first
      const existingSession = await storage.getGameSession(sessionId);
      if (!existingSession) {
        return res.status(404).json({ message: "Session not found" });
      }
      if (existingSession.playerEmail !== req.user.email) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      // Validate and restrict updates - only allow score, level, and completedSentences
      const allowedFields = ['score', 'level', 'completedSentences'] as const;
      const allowedUpdates: any = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          allowedUpdates[field] = req.body[field];
        }
      }
      
      const session = await storage.updateGameSession(sessionId, allowedUpdates);
      
      res.json(session);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.get("/api/game-session/:id", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }
      
      const sessionId = req.params.id;
      const session = await storage.getGameSession(sessionId);
      
      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }
      
      // Check ownership
      if (session.playerEmail !== req.user.email) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      res.json(session);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.get("/api/player/sessions", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }
      
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
      const sessions = await storage.getPlayerSessions(req.user.email, limit);
      
      res.json(sessions);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.get("/api/player/total-score", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }
      
      const hoursBack = req.query.hours ? parseInt(req.query.hours as string) : 24;
      const totalScore = await storage.getPlayerTotalScore(req.user.email, hoursBack);
      
      res.json({ totalScore, hoursBack });
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Player answer routes
  app.post("/api/player-answer", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }
      
      const answerData = insertPlayerAnswerSchema.parse(req.body);
      
      // Check session ownership before creating answer
      const session = await storage.getGameSession(answerData.sessionId);
      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }
      if (session.playerEmail !== req.user.email) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const answer = await storage.createPlayerAnswer(answerData);
      res.status(201).json(answer);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Anonymous player answer route
  app.post("/api/anonymous-answer", async (req, res) => {
    try {
      const answerData = insertPlayerAnswerSchema.parse(req.body);
      
      // Check session exists before creating answer
      const session = await storage.getGameSession(answerData.sessionId);
      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }
      
      const answer = await storage.createPlayerAnswer(answerData);
      res.status(201).json(answer);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.get("/api/session/:sessionId/answers", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }
      
      const sessionId = req.params.sessionId;
      
      // Check session ownership first
      const session = await storage.getGameSession(sessionId);
      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }
      if (session.playerEmail !== req.user.email) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const answers = await storage.getSessionAnswers(sessionId);
      res.json(answers);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Achievement card route
  app.post("/api/achievement-card", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }
      
      // Security: Only allow sending to authenticated user's email
      const email = req.user.email;
      
      // Check if user already has a recent achievement card
      const hasRecent = await storage.hasRecentAchievementCard(email, 24);
      if (hasRecent) {
        return res.status(400).json({ message: "Achievement card already sent in the last 24 hours" });
      }
      
      // Get player's total score for the last 24 hours
      const totalScore = await storage.getPlayerTotalScore(req.user.email, 24);
      
      if (totalScore < 50) {
        return res.status(400).json({ message: "Minimum score of 50 points required for achievement card" });
      }
      
      // Send email
      const emailSent = await sendAchievementCard(email, totalScore);
      
      if (!emailSent) {
        return res.status(500).json({ message: "Failed to send achievement card email" });
      }
      
      // Record the achievement card
      const card = await storage.createAchievementCard({
        email,
        totalScore
      });
      
      res.status(201).json({ message: "Achievement card sent successfully", card });
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Leaderboard route - public endpoint for game feature
  app.get("/api/leaderboard", async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
      const leaderboardData = await storage.getLeaderboardData(limit);
      
      res.json({
        leaderboard: leaderboardData,
        lastUpdated: new Date().toISOString()
      });
    } catch (error) {
      console.error('Leaderboard Error:', error);
      res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to load leaderboard' });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
