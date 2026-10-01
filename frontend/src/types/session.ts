/** 时段 */
export type SessionPeriod = '上午' | '下午' | '晚上' | '通宵';
/** 场次状态：候补 = 容量不足时按提交顺序排队，不占正式排期，不会挤掉已确认场次 */
export type SessionState = '已排期' | '已完成' | '已取消' | '候补';

/** 录制场次：某曲目某天的录制安排 */
export interface Session {
  id: string;
  /** 所属曲目 */
  songId: string;
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 时段 */
  period: SessionPeriod;
  /** 录音师 */
  engineer: string;
  /** 棚号 */
  roomNo: string;
  /** 参与乐手（顿号分隔） */
  musicians: string;
  /** 场次状态 */
  state: SessionState;
  /** 来源：本地录入或离线包（页面显示来源） */
  source: SessionSource;
  /** 提交时间戳：容量不足时候补按提交顺序排队；旧场次在结构升级时回填 */
  submittedAt: number;
}

/** 数据来源 */
export type SessionSource = 'local' | 'package';

/** 表单录入结构（source / submittedAt 由系统补） */
export type SessionInput = Omit<Session, 'id' | 'source' | 'submittedAt'>;

export const SESSION_PERIODS: SessionPeriod[] = ['上午', '下午', '晚上', '通宵'];
export const SESSION_STATES: SessionState[] = ['已排期', '已完成', '已取消', '候补'];

/** 可正式排期的状态（候补与已取消不占容量） */
export const CONFIRMED_SESSION_STATES: SessionState[] = ['已排期', '已完成'];

export function createEmptySession(): SessionInput {
  return {
    songId: '',
    date: new Date().toISOString().slice(0, 10),
    period: '上午',
    engineer: '',
    roomNo: 'A 棚',
    musicians: '',
    state: '已排期'
  };
}

/** 棚号候选 */
export const STUDIO_ROOMS = ['A 棚', 'B 棚', 'C 棚', '大排练厅'];

/**
 * 各棚乐手容量（席位）：同一棚号同一天同一时段内，
 * 已确认场次的乐手数合计不得超过该棚容量；超出的场次按提交顺序进候补。
 */
export const ROOM_CAPACITIES: Record<string, number> = {
  'A 棚': 25,
  'B 棚': 25,
  'C 棚': 8,
  大排练厅: 60
};

/** 未知棚号的默认容量 */
export const DEFAULT_ROOM_CAPACITY = 25;

/** 棚容量查询（未知棚号回退默认容量） */
export function roomCapacityOf(roomNo: string): number {
  return ROOM_CAPACITIES[roomNo] ?? DEFAULT_ROOM_CAPACITY;
}

/** 按顿号 / 逗号拆分乐手清单得到席位需求 */
export function countMusicians(musicians: string): number {
  return musicians
    .split(/[、,，]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0).length;
}
