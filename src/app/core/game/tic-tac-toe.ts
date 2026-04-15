export type CellValue = 'X' | 'O' | null;
export type PlayerSymbol = Exclude<CellValue, null>;
export type GameOutcome = PlayerSymbol | 'draw' | null;

export interface GameSnapshot {
  board: CellValue[];
  currentTurn: PlayerSymbol;
  winner: GameOutcome;
  winningLine: number[];
}

const WINNING_LINES: number[][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function createInitialSnapshot(): GameSnapshot {
  return {
    board: Array.from({ length: 9 }, () => null as CellValue),
    currentTurn: 'X',
    winner: null,
    winningLine: [],
  };
}

export function applyMove(
  snapshot: GameSnapshot,
  index: number,
  player: PlayerSymbol,
): GameSnapshot {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= snapshot.board.length ||
    snapshot.winner !== null ||
    snapshot.currentTurn !== player ||
    snapshot.board[index] !== null
  ) {
    return snapshot;
  }

  const board = [...snapshot.board];
  board[index] = player;

  const result = getOutcome(board);

  return {
    board,
    currentTurn: player === 'X' ? 'O' : 'X',
    winner: result.winner,
    winningLine: result.winningLine,
  };
}

function getOutcome(board: CellValue[]): Pick<GameSnapshot, 'winner' | 'winningLine'> {
  for (const line of WINNING_LINES) {
    const [first, second, third] = line;
    const value = board[first];

    if (value !== null && value === board[second] && value === board[third]) {
      return {
        winner: value,
        winningLine: line,
      };
    }
  }

  if (board.every((cell) => cell !== null)) {
    return {
      winner: 'draw',
      winningLine: [],
    };
  }

  return {
    winner: null,
    winningLine: [],
  };
}
