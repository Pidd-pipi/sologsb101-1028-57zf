/**
 * 离线包合并：按稳定编号合并，不整包覆盖当天安排。
 *
 * - 不同曲目 / 新增 Take 直接接上（本地不存在则追加）
 * - 同一场次棚号 / 时段 / 乐手有两套值 → 列待定，不写正式排期
 * - 新场次按棚号容量核算：超容进候补（按提交顺序排队），不挤掉已确认场次
 * - 进度写入导入草稿，中断后可续跑（幂等：已追加的不重复、已待定的不重复生成）
 */
import type { Table } from 'dexie';
import type { Revisioned } from './db';
import type { OfflinePackage, SessionMergeResult } from '../types/offline';
import {
  db,
  findPendingSession,
  findRoomConflict,
  putImportDraft,
  putPendingSession,
  putSession,
  recalcSessionCapacity,
  type ImportDraftRow,
  type SessionRow
} from './db';
import type { Session } from '../types/session';
import { createId } from './uuid';
import { ROW_REVISION } from './revision';

/** 带上稳定 id 与修订戳（导入行保留离线包中的稳定编号） */
function stampWithId<T extends { id: string }>(row: T): T & Revisioned {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

/** 从离线包数据组装一场新场次（来源标记为离线包） */
function buildImportedSession(session: Session, packageNo: string): SessionRow {
  const now = Date.now();
  return stampWithId({
    ...session,
    source: '离线包',
    packageNo,
    submittedAt: now
  });
}

/** 合并结果汇总 */
export interface MergeSummary {
  draftId: string;
  packageNo: string;
  added: number;
  waitlisted: number;
  pending: number;
  skipped: number;
  total: number;
}

/**
 * 合并一个离线包。
 * @param pkg 离线包
 * @param existingDraft 已有草稿（续跑时传入）；不传则新建草稿
 */
export async function mergeOfflinePackage(
  pkg: OfflinePackage,
  existingDraft?: ImportDraftRow | null
): Promise<MergeSummary> {
  const now = Date.now();
  const draftId = existingDraft?.id ?? createId('draft');
  const draft: ImportDraftRow =
    existingDraft ??
    stampWithId({
      id: draftId,
      packageNo: pkg.packageNo,
      packageData: pkg,
      status: '处理中',
      sessionResults: {},
      progress: { total: pkg.sessions?.length ?? 0, processed: 0 }
    });
  // 续跑时重置进度与结果（幂等重跑，重建结果）
  draft.status = '处理中';
  draft.packageData = pkg;
  draft.sessionResults = {};
  draft.progress = { total: pkg.sessions?.length ?? 0, processed: 0 };
  draft.updatedAt = now;
  await putImportDraft(draft);

  // 1. 项目：不存在则接上
  await appendIfMissing(db.projects, pkg.projects ?? []);
  // 2. 曲目：不存在则接上
  await appendIfMissing(db.songs, pkg.songs ?? []);

  // 3. 场次：按稳定编号匹配，分情形处理
  const sessions = pkg.sessions ?? [];
  const summary: MergeSummary = {
    draftId,
    packageNo: pkg.packageNo,
    added: 0,
    waitlisted: 0,
    pending: 0,
    skipped: 0,
    total: sessions.length
  };

  for (const pkgSession of sessions) {
    const result = await mergeOneSession(pkgSession, pkg.packageNo);
    draft.sessionResults[pkgSession.id] = result;
    draft.progress.processed += 1;
    draft.updatedAt = Date.now();
    await putImportDraft(draft);
    if (result === 'added') summary.added += 1;
    else if (result === 'waitlisted') summary.waitlisted += 1;
    else if (result === 'pending') summary.pending += 1;
    else summary.skipped += 1;
  }

  // 4. Take：不存在则接上
  await appendIfMissing(db.takes, pkg.takes ?? []);

  draft.status = '已完成';
  draft.completedAt = Date.now();
  draft.updatedAt = Date.now();
  await putImportDraft(draft);

  return summary;
}

/** 追加本地不存在的行（按稳定 id 去重） */
async function appendIfMissing<Entity extends { id: string }>(
  table: Table<Entity & Revisioned, string>,
  rows: Entity[]
): Promise<void> {
  if (rows.length === 0) return;
  const existingIds = new Set((await table.toArray()).map((row) => row.id));
  const fresh = rows.filter((row) => !existingIds.has(row.id));
  if (fresh.length > 0) {
    await table.bulkPut(fresh.map((row) => stampWithId(row)));
  }
}

/**
 * 合并单场次：
 * - 本地不存在 → 追加（容量核算后可能为候补）
 * - 本地存在且棚号/时段/乐手一致 → 跳过
 * - 本地存在但有两套值 → 列待定
 */
async function mergeOneSession(pkgSession: Session, packageNo: string): Promise<SessionMergeResult> {
  const local = await db.sessions.get(pkgSession.id);

  if (!local) {
    // 新场次：追加并核算容量
    const row = buildImportedSession(pkgSession, packageNo);
    await putSession(row);
    const { session } = await recalcSessionCapacity(row.id);
    // 容量不足 → 候补；棚号时段冲突 → 也无法确认（不挤掉已确认场次）
    const slotConflict =
      session.state !== '候补'
        ? await findRoomConflict(session.roomNo, session.date, session.period, session.id)
        : null;
    if (session.state === '候补' || slotConflict) {
      if (slotConflict && session.state !== '候补') {
        // 容量够但时段被占：同样候补，不挤掉已确认场次
        await db.sessions.update(session.id, { state: '候补', updatedAt: Date.now() } as never);
      }
      return 'waitlisted';
    }
    return 'added';
  }

  // 已存在：比较棚号 / 时段 / 乐手
  const sameValues =
    local.roomNo === pkgSession.roomNo &&
    local.period === pkgSession.period &&
    local.musicians === pkgSession.musicians;
  if (sameValues) return 'skipped';

  // 两套值：列待定（幂等：同场次同包已有待定记录则跳过）
  const existing = await findPendingSession(pkgSession.id, packageNo);
  if (existing) return 'pending';

  const pending = stampWithId({
    id: createId('pending'),
    sessionStableId: pkgSession.id,
    packageNo,
    local: { roomNo: local.roomNo, period: local.period, musicians: local.musicians },
    pkg: { roomNo: pkgSession.roomNo, period: pkgSession.period, musicians: pkgSession.musicians },
    status: '待定' as const
  });
  await putPendingSession(pending);
  return 'pending';
}

/** 取可续跑的草稿（草稿 / 处理中 / 已中断） */
export async function findResumableDraft(): Promise<ImportDraftRow | null> {
  const drafts = await db.importDrafts.toArray();
  const active = drafts
    .filter((item) => item.status === '草稿' || item.status === '处理中' || item.status === '已中断')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return active[0] ?? null;
}

/** 标记草稿为已中断（页面关闭前调用） */
export async function markDraftInterrupted(draftId: string): Promise<void> {
  await db.importDrafts.update(draftId, { status: '已中断', updatedAt: Date.now() } as never);
}

/** 丢弃草稿 */
export async function discardDraft(draftId: string): Promise<void> {
  await db.importDrafts.delete(draftId);
}

/** 从离线包文本解析（复用类型层校验） */
export { parseOfflinePackage } from '../types/offline';
