/**
 * 离线包合并相关类型
 *
 * 录音棚外勤带回的离线包按「稳定编号」合并，而不是整包覆盖当天安排：
 * - 不同曲目 / 新增 Take 直接接上
 * - 同一场次的棚号、时段、乐手有两套值时先列「待定」，制作人选定前不写正式排期
 * - 容量不足的场次进「候补」，按提交顺序排队，不挤掉已确认场次
 * - 导入中断保住草稿，下次接着处理
 */
import type { Project } from './project';
import type { Song } from './song';
import type { Session } from './session';
import type { Take } from './take';

/** 离线包：外勤从棚内工程导出、带回统筹台合并的数据包 */
export interface OfflinePackage {
  /** 稳定编号：合并与去重的依据 */
  packageNo: string;
  /** 导出时间 ISO */
  exportedAt: string;
  /** 外勤来源描述（如：外勤-小王-20240312） */
  source?: string;
  projects?: Project[];
  songs?: Song[];
  sessions?: Session[];
  takes?: Take[];
}

/** 待定场次的一套值（棚号 / 时段 / 乐手） */
export interface PendingValueSet {
  roomNo: string;
  period: string;
  musicians: string;
}

/** 待定场次：同一场次本地与离线包有两套值，制作人选定前不写正式排期 */
export interface PendingSession {
  id: string;
  /** 对应场次的稳定编号 */
  sessionStableId: string;
  /** 来源离线包稳定编号 */
  packageNo: string;
  /** 本地现值 */
  local: PendingValueSet;
  /** 离线包带来的值 */
  pkg: PendingValueSet;
  status: '待定' | '已采用本地' | '已采用离线';
  createdAt: number;
  resolvedAt?: number;
}

/** 单场次合并结果（用于草稿进度与结果回显） */
export type SessionMergeResult = 'added' | 'waitlisted' | 'pending' | 'skipped';

/** 导入草稿：保住进度，中断后可接着处理 */
export interface ImportDraft {
  id: string;
  /** 离线包稳定编号 */
  packageNo: string;
  fileName?: string;
  /** 原始离线包数据（中断后接着处理的依据） */
  packageData: OfflinePackage;
  /** 草稿 / 处理中 / 已中断 均可在下次打开时续跑；已完成 表示合并结束 */
  status: '草稿' | '处理中' | '已完成' | '已中断';
  /** 每个场次稳定编号的合并结果 */
  sessionResults: Record<string, SessionMergeResult>;
  /** 进度统计 */
  progress: { total: number; processed: number };
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/** 解析后的离线包元信息（用于导入前确认） */
export interface OfflinePackageMeta {
  packageNo: string;
  exportedAt: string;
  source?: string;
  projectCount: number;
  songCount: number;
  sessionCount: number;
  takeCount: number;
}

/** 从离线包文本解析出元信息，失败抛出可读错误 */
export function parseOfflinePackage(text: string): OfflinePackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文本');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('根节点必须是对象');
  }
  const candidate = parsed as Partial<OfflinePackage>;
  if (typeof candidate.packageNo !== 'string' || candidate.packageNo.trim() === '') {
    throw new Error('缺少 packageNo（稳定编号）字段');
  }
  if (candidate.exportedAt !== undefined && typeof candidate.exportedAt !== 'string') {
    throw new Error('exportedAt 必须是字符串');
  }
  const arrayFields: Array<keyof OfflinePackage> = ['projects', 'songs', 'sessions', 'takes'];
  for (const field of arrayFields) {
    if (candidate[field] !== undefined && !Array.isArray(candidate[field])) {
      throw new Error(`${field} 必须是数组`);
    }
  }
  return candidate as OfflinePackage;
}

/** 提取离线包元信息 */
export function packageMeta(pkg: OfflinePackage): OfflinePackageMeta {
  return {
    packageNo: pkg.packageNo,
    exportedAt: pkg.exportedAt,
    source: pkg.source,
    projectCount: pkg.projects?.length ?? 0,
    songCount: pkg.songs?.length ?? 0,
    sessionCount: pkg.sessions?.length ?? 0,
    takeCount: pkg.takes?.length ?? 0
  };
}
