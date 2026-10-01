/** 时段 */
export type SessionPeriod = '上午' | '下午' | '晚上' | '通宵';
/**
 * 场次状态
 * - 已排期 / 已完成 / 已取消：正式排期状态
 * - 候补：容量不足排队中，不占用棚号时段，不计入正式排期
 */
export type SessionState = '已排期' | '已完成' | '已取消' | '候补';

/** 场次来源：本地手工建立 / 离线包按稳定编号合并 */
export type SessionSource = '本地' | '离线包';

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
  /** 来源：本地 / 离线包 */
  source: SessionSource;
  /** 离线包稳定编号（source=离线包 时有值） */
  packageNo?: string;
  /** 提交时间戳（候补按此排队，即提交顺序） */
  submittedAt?: number;
}

export const SESSION_PERIODS: SessionPeriod[] = ['上午', '下午', '晚上', '通宵'];
/** 正式排期状态（用于筛选与常规新建） */
export const SESSION_STATES: SessionState[] = ['已排期', '已完成', '已取消'];
/** 全部状态（含候补） */
export const ALL_SESSION_STATES: SessionState[] = ['已排期', '已完成', '已取消', '候补'];

export function createEmptySession(): Omit<Session, 'id'> {
  return {
    songId: '',
    date: new Date().toISOString().slice(0, 10),
    period: '上午',
    engineer: '',
    roomNo: 'A 棚',
    musicians: '',
    state: '已排期',
    source: '本地'
  };
}

/** 棚号候选 */
export const STUDIO_ROOMS = ['A 棚', 'B 棚', 'C 棚', '大排练厅'];
