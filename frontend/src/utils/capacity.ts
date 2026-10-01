/**
 * 容量核算：棚号容量 vs 乐手人数
 *
 * 棚号或乐手一变就重算：乐手人数超过棚号容量 → 容量不足，场次进候补。
 * 候补按提交顺序排队，不挤掉已确认场次。
 */

/** 各棚号容量（可容纳乐手人数） */
export const ROOM_CAPACITIES: Record<string, number> = {
  'A 棚': 8,
  'B 棚': 5,
  'C 棚': 3,
  大排练厅: 12
};

/** 未登记棚号的兜底容量 */
export const DEFAULT_ROOM_CAPACITY = 6;

/** 取棚号容量 */
export function roomCapacity(roomNo: string): number {
  return ROOM_CAPACITIES[roomNo] ?? DEFAULT_ROOM_CAPACITY;
}

/**
 * 从乐手字符串解析人数（顿号 / 逗号 / 斜杠分隔，忽略空项与「等」「待定」等占位）
 * 形如「鼓：许峰、贝斯：黎川、吉他：程野」→ 3
 */
export function parseMusicianCount(musicians: string): number {
  if (!musicians) return 0;
  const parts = musicians
    .split(/[、,，/／;；\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !/^(等|待定|未定|多人|未知)$/.test(item));
  return parts.length;
}

export interface CapacityResult {
  /** 乐手人数 */
  count: number;
  /** 棚号容量 */
  capacity: number;
  /** 是否超容 */
  over: boolean;
  /** 可读说明 */
  reason: string;
}

/** 核算容量：乐手人数 vs 棚号容量 */
export function evaluateCapacity(musicians: string, roomNo: string): CapacityResult {
  const count = parseMusicianCount(musicians);
  const capacity = roomCapacity(roomNo);
  const over = count > capacity;
  return {
    count,
    capacity,
    over,
    reason: over ? `容量不足：乐手 ${count} 人 > ${roomNo} 容量 ${capacity} 人` : `容量正常：乐手 ${count} 人 ≤ ${roomNo} 容量 ${capacity} 人`
  };
}
