/**
 * 离线包合并相关类型
 * - 离线包按 packageNo（稳定编号）合并，绝不整包覆盖当天安排
 * - 同一场次（同一稳定 id）的棚号 / 时段 / 乐手存在两套值时进入「待定」，制作人选定前不写正式排期
 */
import type { Project } from './project';
import type { Song } from './song';
import type { Session, SessionSource } from './session';
import type { Take } from './take';
import type { Pick } from './pick';
import type { Retake } from './retake';

/** 待定的差异维度：同一场次在本地与离线包中给出两套值 */
export type MergeConflictField = 'roomNo' | 'period' | 'musicians';

/** 制作人的二选一选择 */
export type MergeChoice = 'local' | 'package';

/** 数据来源：本地手工录入或离线包 */
export type { SessionSource };

/** 录音棚外勤带回的离线包（按稳定编号合并，不覆盖） */
export interface OfflinePackage {
  kind: 'gbstudiotake-offline-package';
  /** 稳定编号：同一编号的包重复导入不会产生重复数据，用于断点续写 */
  packageNo: string;
  /** 外勤录音棚 / 提交人说明 */
  origin: string;
  /** 打包时间 ISO */
  exportedAt: string;
  projects: Project[];
  songs: Song[];
  sessions: Session[];
  takes: Take[];
  picks: Pick[];
  retakes: Retake[];
}

/** 一条场次待定：两套棚号 / 时段 / 乐手值，等制作人拍板 */
export interface MergePending {
  id: string;
  /** 稳定编号：离线包编号 + 场次稳定 id */
  packageNo: string;
  packageOrigin: string;
  sessionId: string;
  /** 本地既有场次值 */
  local: Session;
  /** 离线包带来的场次值 */
  incoming: Session;
  /** 存在两套值的字段 */
  fields: MergeConflictField[];
  /** 尚未写正式排期的新 Take（其 sessionId 即本场次） */
  deferredTakes: Take[];
  /** 尚未写入的优选（引用待定场次下的 Take） */
  deferredPicks: Pick[];
  createdAt: number;
}

/** 导入中断后保住的草稿（IndexedDB 表 importDrafts，按 packageNo 续写） */
export interface ImportDraft {
  /** 即 packageNo，主键 */
  id: string;
  packageNo: string;
  origin: string;
  exportedAt: string;
  payload: OfflinePackage;
  /** 已处理到的实体批次序号（每批在独立事务内落库，天然幂等可续写） */
  processedBatches: number;
  /** 总批次数 */
  totalBatches: number;
  /** 是否还有待定未裁决（裁决完才允许收尾） */
  pendingResolved: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 合并一次离线包的结果统计，用于页面展示来源 / 待定 / 候补数量 */
export interface MergeResult {
  packageNo: string;
  origin: string;
  addedSongs: number;
  addedSessions: number;
  addedTakes: number;
  addedPicks: number;
  addedRetakes: number;
  /** 新增待定条数 */
  pendingCount: number;
  /** 容量核算后进入候补的场次数 */
  waitlistCount: number;
  /** 是否复用了中断草稿续写 */
  resumed: boolean;
}
