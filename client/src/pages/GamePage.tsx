import { useState, useEffect, useCallback, useRef } from 'react';
import { SENTENCE_CHALLENGES } from '@shared/sentences';
import GameBoard from '@/components/GameBoard';
import GameControls from '@/components/GameControls';
import ScoreDisplay from '@/components/ScoreDisplay';
import SentenceChallenge from '@/components/SentenceChallenge';
import GameOverModal from '@/components/GameOverModal';
import LeaderboardModal from '@/components/LeaderboardModal';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Play, Info } from 'lucide-react';

// Mock data for the prototype
const BLOCK_COLORS = [
  'bg-blue-500',
  'bg-yellow-500', 
  'bg-purple-500',
  'bg-green-500',
  'bg-red-500',
  'bg-indigo-500',
  'bg-orange-500',
  'bg-pink-500',
  'bg-teal-500',
  'bg-lime-500',
  'bg-rose-500',
  'bg-emerald-500',
  'bg-cyan-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-slate-500'
];

const SUSTAINABILITY_KEYWORDS = [
  'protect', 'nature', 'sustain', 'care', 'green', 'earth', 'love', 'peace', 'hope', 'future',
  'respect', 'unity', 'together', 'harmony', 'balance', 'river', 'ocean', 'forest', 'clean',
  'renewable', 'recycle', 'reduce', 'reuse', 'diverse', 'inclusive', 'community', 'global',
  'citizen', 'responsibility', 'preserve', 'wildlife', 'ecosystem', 'solar', 'wind', 'organic'
];

type GamePiece = {
  blocks: { x: number; y: number; keyword: string }[];
  x: number;
  y: number;
  color: string;
};

export default function GamePage() {

  // Game state
  const [gameStarted, setGameStarted] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [score, setScore] = useState(0);
  const [level, setLevel] = useState(1);
  const [lines, setLines] = useState(0);
  const [board, setBoard] = useState<({ keyword: string; color: string } | null)[][]>(
    Array(17).fill(null).map(() => Array(10).fill(null))
  );
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  
  // Pieces
  const [currentPiece, setCurrentPiece] = useState<GamePiece | null>(null);
  const [nextPiece, setNextPiece] = useState<GamePiece | null>(null);
  
  // Challenge state
  const [showChallenge, setShowChallenge] = useState(false);
  const [currentChallenge, setCurrentChallenge] = useState(SENTENCE_CHALLENGES[0]);
  
  // Local storage for demo (no authentication required)
  const [totalAccumulatedScore, setTotalAccumulatedScore] = useState(() => {
    return parseInt(localStorage.getItem('ecoBlocks_totalScore') || '0');
  });

  // Persistent email storage
  const [storedEmail, setStoredEmail] = useState(() => {
    return localStorage.getItem('ecoBlocks_playerEmail') || '';
  });

  // Email storage utilities
  const saveEmailToStorage = (email: string) => {
    localStorage.setItem('ecoBlocks_playerEmail', email);
    setStoredEmail(email);
  };

  const clearStoredEmail = () => {
    localStorage.removeItem('ecoBlocks_playerEmail');
    setStoredEmail('');
  };

  // Session analytics tracking
  const [sessionStartTime, setSessionStartTime] = useState<Date | null>(null);
  const [piecesPlaced, setPiecesPlaced] = useState(0);
  const [sentencesAttempted, setSentencesAttempted] = useState(0);
  const [sentencesCompleted, setSentencesCompleted] = useState(0);

  // Session management functions
  const createSession = useCallback(async () => {
    try {
      const response = await fetch('/api/anonymous-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // Device, browser and location are derived server-side
        body: JSON.stringify({
          ...(storedEmail && { playerEmail: storedEmail }), // Use stored email if available
        }),
      });
      
      if (response.ok) {
        const session = await response.json();
        setCurrentSessionId(session.id);
        console.log('Session created:', session.id, storedEmail ? `with stored email: ${storedEmail}` : 'anonymously');
        return session.id;
      }
    } catch (error) {
      console.error('Failed to create session:', error);
    }
    return null;
  }, [storedEmail]);

  const updateSession = useCallback(async (sessionId: string, updates: any) => {
    try {
      const response = await fetch(`/api/anonymous-session/${sessionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
        keepalive: true, // let the final update finish even if the tab is closing
      });
      
      if (response.ok) {
        const session = await response.json();
        console.log('Session updated:', sessionId);
        return session;
      }
    } catch (error) {
      console.error('Failed to update session:', error);
    }
    return null;
  }, []);

  const endSession = useCallback(async (sessionId: string, finalScore: number, playerEmail?: string) => {
    if (!sessionStartTime) return;
    
    // Duration, end time and persona cards are computed server-side
    const updates = {
      score: finalScore,
      level,
      linesCleared: lines,
      piecesPlaced,
      sentencesAttempted,
      sentencesCompleted,
      endReason: 'game_over',
      ...(playerEmail && { playerEmail })
    };
    
    await updateSession(sessionId, updates);
  }, [sessionStartTime, level, lines, piecesPlaced, sentencesAttempted, sentencesCompleted, updateSession]);

  // If the player leaves mid-game, record the session with its current stats
  const liveSession = useRef({ sessionId: null as string | null, gameStarted: false, gameOver: false, stats: {} as Record<string, number> });
  liveSession.current = {
    sessionId: currentSessionId,
    gameStarted,
    gameOver,
    stats: { score, level, linesCleared: lines, piecesPlaced, sentencesAttempted, sentencesCompleted },
  };

  useEffect(() => {
    const handlePageHide = () => {
      const { sessionId, gameStarted, gameOver, stats } = liveSession.current;
      if (!sessionId || !gameStarted || gameOver) return;
      navigator.sendBeacon(
        `/api/anonymous-session/${sessionId}/end`,
        new Blob([JSON.stringify({ ...stats, endReason: 'left' })], { type: 'application/json' })
      );
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, []);

  // Collision detection
  const isValidPosition = useCallback((piece: GamePiece, board: ({ keyword: string; color: string } | null)[][]) => {
    for (const block of piece.blocks) {
      const x = piece.x + block.x;
      const y = piece.y + block.y;
      
      // Check boundaries
      if (x < 0 || x >= 10 || y >= 17) {
        return false;
      }
      
      // Check collision with placed pieces
      if (y >= 0 && board[y] && board[y][x]) {
        return false;
      }
    }
    return true;
  }, []);

  // Generate a random piece
  const generatePiece = useCallback((): GamePiece => {
    const pieces = [
      // I piece
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }],
      // O piece  
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
      // T piece
      [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
      // S piece
      [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
      // Z piece
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
      // J piece
      [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
      // L piece
      [{ x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }]
    ];
    
    const shape = pieces[Math.floor(Math.random() * pieces.length)];
    const blocks = shape.map(pos => ({
      ...pos,
      keyword: SUSTAINABILITY_KEYWORDS[Math.floor(Math.random() * SUSTAINABILITY_KEYWORDS.length)]
    }));

    const color = BLOCK_COLORS[Math.floor(Math.random() * BLOCK_COLORS.length)];
    return {
      blocks,
      x: 3,
      y: 0,
      color
    };
  }, []);

  // Place piece on board
  const placePiece = useCallback((piece: GamePiece, board: ({ keyword: string; color: string } | null)[][]) => {
    const newBoard = board.map(row => [...row]);
    
    for (const block of piece.blocks) {
      const x = piece.x + block.x;
      const y = piece.y + block.y;
      if (y >= 0 && y < 17 && x >= 0 && x < 10) {
        newBoard[y][x] = { keyword: block.keyword, color: piece.color };
      }
    }
    
    return newBoard;
  }, []);

  // Clear completed lines
  const clearLines = useCallback((board: ({ keyword: string; color: string } | null)[][]) => {
    const newBoard = [...board];
    let linesCleared = 0;
    const clearedKeywords: string[] = [];
    
    for (let y = 16; y >= 0; y--) {
      if (newBoard[y].every(cell => cell !== null)) {
        // Collect keywords from cleared line
        newBoard[y].forEach(cell => {
          if (cell) clearedKeywords.push(cell.keyword);
        });
        
        newBoard.splice(y, 1);
        newBoard.unshift(Array(10).fill(null));
        linesCleared++;
        y++; // Check the same row again
      }
    }
    
    return { newBoard, linesCleared, clearedKeywords };
  }, []);

  // Start new game
  const startGame = async () => {
    setGameStarted(true);
    setGameOver(false);
    setScore(0);
    setLevel(1);
    setLines(0);
    const newBoard = Array(17).fill(null).map(() => Array(10).fill(null));
    setBoard(newBoard);
    const firstPiece = generatePiece();
    const secondPiece = generatePiece();
    setCurrentPiece(firstPiece);
    setNextPiece(secondPiece);
    setShowChallenge(false);
    
    // Reset session analytics
    setSessionStartTime(new Date());
    setPiecesPlaced(0);
    setSentencesAttempted(0);
    setSentencesCompleted(0);
    
    // Create new database session
    await createSession();
  };

  // Game controls
  const moveLeft = useCallback(() => {
    if (currentPiece && !gameOver) {
      const newPiece = { ...currentPiece, x: currentPiece.x - 1 };
      if (isValidPosition(newPiece, board)) {
        setCurrentPiece(newPiece);
      }
    }
  }, [currentPiece, gameOver, board, isValidPosition]);

  const moveRight = useCallback(() => {
    if (currentPiece && !gameOver) {
      const newPiece = { ...currentPiece, x: currentPiece.x + 1 };
      if (isValidPosition(newPiece, board)) {
        setCurrentPiece(newPiece);
      }
    }
  }, [currentPiece, gameOver, board, isValidPosition]);

  const moveDown = useCallback(() => {
    if (currentPiece && !gameOver) {
      const newPiece = { ...currentPiece, y: currentPiece.y + 1 };
      if (isValidPosition(newPiece, board)) {
        setCurrentPiece(newPiece);
      } else {
        // Place the piece and spawn new one
        const newBoard = placePiece(currentPiece, board);
        const { newBoard: clearedBoard, linesCleared, clearedKeywords } = clearLines(newBoard);
        
        // Track piece placement
        setPiecesPlaced(prev => prev + 1);
        
        setBoard(clearedBoard);
        
        if (linesCleared > 0) {
          const points = linesCleared * 100 * level;
          setScore(prev => prev + points);
          setLines(prev => {
            const newLines = prev + linesCleared;
            // Level up every 10 lines
            setLevel(1 + Math.floor(newLines / 10));
            return newLines;
          });
          
          // Select challenge based on cleared keywords
          const randomChallenge = SENTENCE_CHALLENGES[Math.floor(Math.random() * SENTENCE_CHALLENGES.length)];
          setCurrentChallenge(randomChallenge);
          setShowChallenge(true);
          setSentencesAttempted(prev => prev + 1);
          console.log(`${linesCleared} lines cleared! Challenge triggered.`);
        }
        
        // Spawn next piece
        if (nextPiece && isValidPosition(nextPiece, clearedBoard)) {
          setCurrentPiece(nextPiece);
          setNextPiece(generatePiece());
        } else {
          // Game over - can't place new piece
          setGameOver(true);
          console.log('Game Over - No room for new piece');
          
          // End session when game is over
          if (currentSessionId) {
            endSession(currentSessionId, score);
          }
        }
      }
    }
  }, [currentPiece, gameOver, board, isValidPosition, placePiece, clearLines, level, nextPiece, generatePiece, score, currentSessionId, endSession]);

  const rotatePiece = useCallback(() => {
    if (currentPiece && !gameOver) {
      // Rotate blocks 90 degrees clockwise around origin
      const rotatedBlocks = currentPiece.blocks.map(block => ({
        ...block,
        x: -block.y,
        y: block.x
      }));
      
      const rotatedPiece = { ...currentPiece, blocks: rotatedBlocks };
      
      // Try rotation at current position first
      if (isValidPosition(rotatedPiece, board)) {
        setCurrentPiece(rotatedPiece);
        return;
      }
      
      // Try wall kicks (shift left/right if rotation fails)
      const wallKicks = [-1, 1, -2, 2];
      for (const kick of wallKicks) {
        const kickedPiece = { ...rotatedPiece, x: rotatedPiece.x + kick };
        if (isValidPosition(kickedPiece, board)) {
          setCurrentPiece(kickedPiece);
          return;
        }
      }
    }
  }, [currentPiece, gameOver, board, isValidPosition]);


  // Simulate line completion and challenge trigger
  const triggerLineCompletion = () => {
    setLines(prev => prev + 1);
    setScore(prev => prev + 100 * level);
    setShowChallenge(true);
    console.log('Line completed! Challenge triggered.');
  };

  // Handle sentence challenge
  const handleChallengeSubmit = async (answer: string, points: number) => {
    setScore(prev => prev + points);
    setTotalAccumulatedScore(prev => {
      const newTotal = prev + points;
      localStorage.setItem('ecoBlocks_totalScore', newTotal.toString());
      return newTotal;
    });
    setSentencesCompleted(prev => prev + 1);
    setShowChallenge(false);
    
    // Save player answer to database
    if (currentSessionId) {
      try {
        await fetch('/api/anonymous-answer', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            sessionId: currentSessionId,
            sentenceId: currentChallenge.id,
            answer: answer,
            score: points,
          }),
        });
        console.log('Answer saved to database');
      } catch (error) {
        console.error('Failed to save answer:', error);
      }
    }
    
    console.log('Challenge completed:', answer, 'Points earned:', points);
  };

  const handleChallengeSkip = useCallback(() => {
    setShowChallenge(false);
    console.log('Challenge skipped');
  }, []);

  // Auto-falling blocks
  useEffect(() => {
    if (gameStarted && !gameOver && currentPiece) {
      const fallSpeed = Math.max(150, 1000 - (level - 1) * 80); // Smoother difficulty curve
      const timer = setInterval(() => {
        moveDown();
      }, fallSpeed);
      
      return () => clearInterval(timer);
    }
  }, [gameStarted, gameOver, currentPiece, level, moveDown]);

  // Keyboard controls
  useEffect(() => {
    if (!gameStarted || gameOver) return;

    const handleKeyPress = (event: KeyboardEvent) => {
      // Don't handle game controls if user is typing in a text input
      const activeElement = document.activeElement;
      const isTyping = activeElement && (
        activeElement.tagName === 'INPUT' || 
        activeElement.tagName === 'TEXTAREA' ||
        (activeElement as HTMLElement).contentEditable === 'true'
      );
      
      if (isTyping) return;
      
      switch (event.code) {
        case 'ArrowLeft':
        case 'KeyA':
          event.preventDefault();
          moveLeft();
          break;
        case 'ArrowRight':
        case 'KeyD':
          event.preventDefault();
          moveRight();
          break;
        case 'ArrowDown':
        case 'KeyS':
          event.preventDefault();
          moveDown();
          break;
        case 'ArrowUp':
        case 'KeyW':
        case 'Space':
          event.preventDefault();
          rotatePiece();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [gameStarted, gameOver, moveLeft, moveRight, moveDown, rotatePiece]);

  // Handle email submission for score saving and dashboard access
  const handleEmailSubmit = async (email: string) => {
    console.log('Email submitted for saving game session:', email);
    
    // Save email to localStorage for future sessions
    saveEmailToStorage(email);
    
    // Save complete session data with email to database
    if (currentSessionId) {
      try {
        await endSession(currentSessionId, score, email);
        console.log('Game session saved with email:', email);
      } catch (error) {
        console.error('Failed to save game session with email:', error);
      }
    }
  };

  if (!gameStarted) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md p-8 text-center space-y-6">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold text-primary">EcoBlocks</h1>
            <p className="text-muted-foreground">
              Learn about global citizenship and sustainability while playing!
            </p>
          </div>
          
          <div className="space-y-4 text-left text-sm">
            <div className="p-4 bg-muted rounded-lg space-y-2">
              <h3 className="font-semibold flex items-center gap-2">
                <Info className="w-4 h-4" />
                How to Play
              </h3>
              <ul className="space-y-1 text-muted-foreground">
                <li>• Stack blocks with sustainability keywords</li>
                <li>• Complete sentences when you clear lines</li>
                <li>• Use block keywords for bonus points</li>
                <li>• Reach 50 points to unlock achievement card</li>
              </ul>
            </div>
          </div>
          
          <Button onClick={startGame} size="lg" className="w-full" data-testid="button-start-game">
            <Play className="w-5 h-5 mr-2" />
            Start Playing
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-1">
      <div className="max-w-4xl mx-auto">
        {/* Header with Score - Compact */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="text-base font-bold text-primary">EcoBlocks</h1>
              <p className="text-[9px] text-muted-foreground">Learn • Play • Impact</p>
            </div>
            <LeaderboardModal />
          </div>
          
          <ScoreDisplay 
            score={score}
            level={level}
            lines={lines}
            totalAccumulatedScore={totalAccumulatedScore}
          />
        </div>

        {/* Game Layout - Mobile Optimized */}
        <div className="space-y-1">
          {/* Game Board */}
          <div className="flex justify-center">
            <GameBoard board={board} currentPiece={currentPiece} />
          </div>

          {/* Controls - Bottom */}
          <div className="flex justify-center">
            <GameControls
              onMoveLeft={moveLeft}
              onMoveRight={moveRight}
              onMoveDown={moveDown}
              onRotate={rotatePiece}
              disabled={gameOver}
            />
          </div>
          
          {/* Keyboard hint - Compact */}
          <div className="text-center text-[8px] text-muted-foreground">
            Arrow keys/WASD • Space to rotate
          </div>
        </div>

        {/* Game Over Modal */}
        <GameOverModal
          isVisible={gameOver}
          finalScore={score}
          totalAccumulatedScore={totalAccumulatedScore}
          level={level}
          linesCleared={lines}
          storedEmail={storedEmail}
          onRestart={startGame}
          onEmailSubmit={handleEmailSubmit}
          onClearEmail={clearStoredEmail}
          onClose={() => setGameStarted(false)}
        />

        {/* Sentence Challenge Modal */}
        <SentenceChallenge
          sentence={currentChallenge}
          availableKeywords={SUSTAINABILITY_KEYWORDS.slice(0, 10)}
          onSubmit={handleChallengeSubmit}
          onSkip={handleChallengeSkip}
          isVisible={showChallenge}
        />
      </div>
    </div>
  );
}