/**
 * 录音棚外勤离线包：解析、校验与按稳定编号合并。
 * 合并原则：
 * - 整包绝不覆盖当天安排：不同曲目 / 新增场次、新增 Take 直接接上；
 * - 同一场次（同一稳定 id）棚号 / 时段 / 乐手有两套值 → 列待定，制作人选定前不写正式排期；
 * - 容量不足的新场次按提交顺序进候补，不挤掉已确认场次；
 * - 导入中断保住草稿（importDrafts），下次按 packageNo 续写；
 * - 旧场次（结构升级后）同样参与容量核算。
 */
import type { Pick } from '@/types/pick';
import type { Project } from '@/types/project';
import type { Retake } from '@/types/retake';
import type { Session } from '@/types/session';
import type { Song } from '@/types/song';
import type { Take } from '@/types/take';
import type { MergeChoice, MergeConflictField, MergePending, OfflinePackage } from '@/types/merge';
import {
  bulkPutMergePending,
  db,
  getImportDraft,
  listMergePending,
  putImportDraft,
  putPick,
  putProject,
  putRetake,
  putSession,
  putSong,
  putTake,
  recalculateCapacities,
  removeImportDraft,
  removeMergePending,
  stampRow
} from './db';

/** 离线包标识 */
export const OFFLINE_PACKAGE_KIND = 'gbstudiotake-offline-package';

/** 生成默认稳定编号：PKG-YYYYMMDD-HHMM（外勤可手工改写） */
export function defaultPackageNo(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes()
  )}`;
  return `PKG-${stamp}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 数组字段归一化：续写片段允许只带增量数组，缺省按空数组处理 */
function normalizePackage(pkg: OfflinePackage): OfflinePackage {
  return {
    ...pkg,
    projects: pkg.projects ?? [],
    songs: pkg.songs ?? [],
    sessions: pkg.sessions ?? [],
    takes: pkg.takes ?? [],
    picks: pkg.picks ?? [],
    retakes: pkg.retakes ?? []
  };
}

function assertOptionalArrayShape(list: unknown, label: string): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) throw new Error(`离线包的 ${label} 必须是数组`);
  list.forEach((item, index) => {
    if (!isRecord(item) || typeof item.id !== 'string') {
      throw new Error(`离线包的 ${label}[${index}] 缺少稳定 id`);
    }
  });
}

/** 解析并严格校验离线包文本，失败抛可读错误（绝不覆盖本地任何数据） */
export function parseOfflinePackage(text: string): OfflinePackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文本');
  }
  if (!isRecord(parsed)) throw new Error('离线包根节点必须是对象');
  if (parsed.kind !== OFFLINE_PACKAGE_KIND) {
    throw new Error(`不是本应用的离线包（kind 应为 ${OFFLINE_PACKAGE_KIND}）`);
  }
  if (typeof parsed.packageNo !== 'string' || parsed.packageNo.trim().length === 0) {
    throw new Error('离线包缺少稳定编号 packageNo');
  }
  if (typeof parsed.exportedAt !== 'string') throw new Error('离线包缺少 exportedAt');
  const candidate = parsed as Partial<OfflinePackage>;
  assertOptionalArrayShape(candidate.projects, 'projects');
  assertOptionalArrayShape(candidate.songs, 'songs');
  assertOptionalArrayShape(candidate.sessions, 'sessions');
  assertOptionalArrayShape(candidate.takes, 'takes');
  assertOptionalArrayShape(candidate.picks, 'picks');
  assertOptionalArrayShape(candidate.retakes, 'retakes');
  return normalizePackage(candidate as OfflinePackage);
}

/** 由当前本地库组装外勤离线包（场次记录表导出的姊妹格式） */
export async function buildOfflinePackage(packageNo: string, origin: string): Promise<OfflinePackage> {
  const [projects, songs, sessions, takes, picks, retakes] = await Promise.all([
    db.projects.toArray(),
    db.songs.toArray(),
    db.sessions.toArray(),
    db.takes.toArray(),
    db.picks.toArray(),
    db.retakes.toArray()
  ]);
  const strip = <T extends object>(row: T): T => {
    const copy = { ...row } as Record<string, unknown>;
    delete copy.revision;
    delete copy.createdAt;
    delete copy.updatedAt;
    return copy as T;
  };
  return {
    kind: OFFLINE_PACKAGE_KIND,
    packageNo: packageNo.trim(),
    origin: origin.trim() || '未注明外勤',
    exportedAt: new Date().toISOString(),
    projects: projects.map(strip),
    songs: songs.map(strip),
    sessions: sessions.map(strip) as unknown as Session[],
    takes: takes.map(strip),
    picks: picks.map(strip),
    retakes: retakes.map(strip)
  };
}

const CONFLICT_FIELDS: MergeConflictField[] = ['roomNo', 'period', 'musicians'];

function diffSession(local: Session, incoming: Session): MergeConflictField[] {
  return CONFLICT_FIELDS.filter((field) => local[field] !== incoming[field]);
}

function pendingId(packageNo: string, sessionId: string): string {
  return `mpd-${packageNo}-${sessionId}`;
}

/** 离线包内场次的提交时间：按打包时间 + 包内序号，保证同包内按顺序排队 */
function submittedAtOf(pkg: OfflinePackage, index: number): number {
  const base = Date.parse(pkg.exportedAt);
  return (Number.isFinite(base) ? base : Date.now()) + index;
}

export interface MergeStats {
  addedSongs: number;
  addedSessions: number;
  addedTakes: number;
  addedPicks: number;
  addedRetakes: number;
  pendingCount: number;
  waitlistCount: number;
}

/**
 * 按稳定编号合并一个离线包（幂等：稳定 id 已存在且非待定时不重复写入）。
 * 调用方负责先落 importDraft 保住草稿；本函数整体可安全重复执行（断点续写）。
 */
export async function mergeOfflinePackage(pkg: OfflinePackage): Promise<MergeStats> {
  const stats: MergeStats = {
    addedSongs: 0,
    addedSessions: 0,
    addedTakes: 0,
    addedPicks: 0,
    addedRetakes: 0,
    pendingCount: 0,
    waitlistCount: 0
  };

  const [existingProjects, existingSongs, existingTakes, existingPicks, existingRetakes, existingPending] =
    await Promise.all([
      db.projects.bulkGet(pkg.projects.map((item) => item.id)),
      db.songs.bulkGet(pkg.songs.map((item) => item.id)),
      db.takes.bulkGet(pkg.takes.map((item) => item.id)),
      db.picks.bulkGet(pkg.picks.map((item) => item.id)),
      db.retakes.bulkGet(pkg.retakes.map((item) => item.id)),
      listMergePending()
    ]);
  const projectIds = new Set(existingProjects.filter((row): row is NonNullable<typeof row> => row !== undefined).map((row) => row.id));
  const songIdsExisting = new Set(existingSongs.filter((row): row is NonNullable<typeof row> => row !== undefined).map((row) => row.id));
  const takeIdsExisting = new Set(existingTakes.filter((row): row is NonNullable<typeof row> => row !== undefined).map((row) => row.id));
  const pickIdsExisting = new Set(existingPicks.filter((row): row is NonNullable<typeof row> => row !== undefined).map((row) => row.id));
  const retakeIdsExisting = new Set(existingRetakes.filter((row): row is NonNullable<typeof row> => row !== undefined).map((row) => row.id));

  // 1. 项目 / 曲目：稳定 id 不存在才接上，本地已有值不被覆盖
  const newProjects = pkg.projects.filter((item) => !projectIds.has(item.id));
  const newSongs = pkg.songs.filter((item) => !songIdsExisting.has(item.id));
  await db.transaction('rw', [db.projects, db.songs], async () => {
    for (const project of newProjects) await putProject(stampRow(project as Project));
    for (const song of newSongs) await putSong(stampRow(song as Song));
  });
  stats.addedSongs = newSongs.length;

  const songIds = new Set((await db.songs.toCollection().primaryKeys()) as string[]);

  // 2. 场次：新增先以「候补」占位（容量核算后按提交顺序入座）；
  //    同 id 已存在且棚号 / 时段 / 乐手有两套值 → 列待定，不写正式排期。
  const localSessionById = new Map((await db.sessions.toArray()).map((row) => [row.id, row]));
  // 待定点按场次跟随：即使来自另一编号的包，该场次未裁决前其 Take 仍须暂挂
  const pendingBySession = new Map(existingPending.map((item) => [item.sessionId, item]));
  const pendingRecords: MergePending[] = [];
  const addedSessionIds: string[] = [];

  for (const [index, incomingRaw] of pkg.sessions.entries()) {
    const incoming: Session = { ...incomingRaw, source: 'package', submittedAt: submittedAtOf(pkg, index) };
    const local = localSessionById.get(incoming.id);
    if (local) {
      const fields = diffSession(local, incoming);
      const alreadyPending = pendingBySession.has(incoming.id);
      if (fields.length > 0 && !alreadyPending) {
        const record: MergePending = {
          id: pendingId(pkg.packageNo, incoming.id),
          packageNo: pkg.packageNo,
          packageOrigin: pkg.origin,
          sessionId: incoming.id,
          local: {
            id: local.id,
            songId: local.songId,
            date: local.date,
            period: local.period,
            engineer: local.engineer,
            roomNo: local.roomNo,
            musicians: local.musicians,
            state: local.state,
            source: local.source,
            submittedAt: local.submittedAt
          },
          incoming,
          fields,
          deferredTakes: [],
          deferredPicks: [],
          createdAt: Date.now()
        };
        pendingRecords.push(record);
        pendingBySession.set(incoming.id, record);
      }
      continue;
    }
    // 新增场次：候补占位 → 重算时按容量决定入座或排队（已确认场次不会被挤掉）
    const candidate: Session = { ...incoming, state: '候补' };
    const row = stampRow(candidate, incoming.submittedAt);
    await putSession(row);
    addedSessionIds.push(incoming.id);
    localSessionById.set(incoming.id, row);
  }
  stats.addedSessions = addedSessionIds.length;

  // 所有待定（含中断续写时已存在的）涉及的场次 id：其 Take 在裁决前不写正式数据
  const pendingSessionIds = new Set(pendingBySession.keys());
  const pendingForSession = (sessionId: string): MergePending | undefined => pendingBySession.get(sessionId);
  const appendDeferredTake = (take: Take): void => {
    const pending = pendingForSession(take.sessionId);
    if (pending && !pending.deferredTakes.some((item) => item.id === take.id)) pending.deferredTakes.push(take);
  };
  const appendDeferredPick = (pick: Pick): void => {
    const take = pkg.takes.find((item) => item.id === pick.takeId);
    const pending = take ? pendingForSession(take.sessionId) : undefined;
    if (pending && !pending.deferredPicks.some((item) => item.id === pick.id)) pending.deferredPicks.push(pick);
  };

  // 3. Take：所属场次正待定优先暂挂（即使该 Take 已随前次导入暂挂过也不进正式表）；
  //    已存在于正式表则跳过；所属场次存在直接接上；离线包不完整（场次缺失）不写孤立 Take。
  const newTakes: Take[] = [];
  for (const take of pkg.takes) {
    if (pendingSessionIds.has(take.sessionId)) {
      appendDeferredTake(take);
      continue;
    }
    if (takeIdsExisting.has(take.id)) continue;
    if (!localSessionById.has(take.sessionId)) continue;
    newTakes.push(take);
  }
  if (newTakes.length > 0) {
    await db.transaction('rw', [db.takes], async () => {
      for (const take of newTakes) await putTake(stampRow(take));
    });
  }
  stats.addedTakes = newTakes.length;

  // 4. 优选：引用的 Take 已存在或本次落库才接上；Take 随场次待定的一起暂挂
  const newTakeIds = new Set(newTakes.map((item) => item.id));
  const newPicks: Pick[] = [];
  for (const pick of pkg.picks) {
    if (pickIdsExisting.has(pick.id)) continue;
    const takeInPkg = pkg.takes.find((item) => item.id === pick.takeId);
    if (takeInPkg && pendingSessionIds.has(takeInPkg.sessionId)) {
      appendDeferredPick(pick);
      continue;
    }
    if (!takeIdsExisting.has(pick.takeId) && !newTakeIds.has(pick.takeId)) continue;
    newPicks.push(pick);
  }
  if (newPicks.length > 0) {
    await db.transaction('rw', [db.picks], async () => {
      for (const pick of newPicks) await putPick(stampRow(pick));
    });
  }
  stats.addedPicks = newPicks.length;

  // 5. 补录：曲目存在且稳定 id 不重复才接上
  const newRetakes: Retake[] = [];
  for (const retake of pkg.retakes) {
    if (retakeIdsExisting.has(retake.id)) continue;
    if (!songIds.has(retake.songId)) continue;
    newRetakes.push(retake);
  }
  if (newRetakes.length > 0) {
    await db.transaction('rw', [db.retakes], async () => {
      for (const retake of newRetakes) await putRetake(stampRow(retake));
    });
  }
  stats.addedRetakes = newRetakes.length;

  // 6. 待定落表（制作人选定前不写正式排期；暂挂的 Take / 优选跟随，按 id 去重）。
  //    续写时待定点可能已由前次导入建立：appendDeferredTake/Pick 原地写入 pendingBySession
  //    内对象（既有待定点也是同一引用），因此所有暂挂项有增长的待定点都要持久化。
  const recordsById = new Map(pendingRecords.map((item) => [item.id, item]));
  for (const previous of existingPending) {
    const record = recordsById.get(previous.id);
    if (record) {
      // 同场次待定点本次又被重建：以既有暂挂项为底，合并本次新增（按 id 去重）
      const takeIds = new Set(previous.deferredTakes.map((item) => item.id));
      const pickIds = new Set(previous.deferredPicks.map((item) => item.id));
      record.deferredTakes = [...previous.deferredTakes, ...record.deferredTakes.filter((item) => !takeIds.has(item.id))];
      record.deferredPicks = [...previous.deferredPicks, ...record.deferredPicks.filter((item) => !pickIds.has(item.id))];
      continue;
    }
    // 本次没有新差异记录，但暂挂项可能直接追加到了既有待定点
    if (previous.deferredTakes.length > 0 || previous.deferredPicks.length > 0) {
      pendingRecords.push(previous);
    }
  }
  if (pendingRecords.length > 0) await bulkPutMergePending(pendingRecords);
  stats.pendingCount = pendingRecords.filter((record) => !existingPending.some((item) => item.id === record.id)).length;

  // 7. 容量重算：旧场次与本次新增一起核算，放不下的新增场次按提交顺序候补
  await recalculateCapacities();
  if (addedSessionIds.length > 0) {
    const addedRows = await db.sessions.bulkGet(addedSessionIds);
    stats.waitlistCount = addedRows.filter((row) => row?.state === '候补').length;
  }

  return stats;
}

/**
 * 制作人裁决一条待定：
 * @param choice local=保留本地值；package=采用离线包值
 * 选定后该场次才写正式排期，并补写暂挂的 Take / 优选，随后重算容量。
 */
export async function resolveMergePending(pendingIdValue: string, choice: MergeChoice): Promise<void> {
  const pending = (await listMergePending()).find((item) => item.id === pendingIdValue);
  if (!pending) throw new Error('待定记录不存在或已被处理');
  const chosen: Session = choice === 'local' ? pending.local : pending.incoming;

  await db.transaction('rw', [db.sessions, db.takes, db.picks, db.mergePending], async () => {
    const existing = await db.sessions.get(pending.sessionId);
    const merged: Session = existing
      ? {
          ...existing,
          songId: chosen.songId,
          date: chosen.date,
          period: chosen.period,
          engineer: chosen.engineer,
          roomNo: chosen.roomNo,
          musicians: chosen.musicians
        }
      : { ...chosen, state: '候补' };
    // 采用本地值时保留本地来源与提交时间；采用离线包值时沿用包内来源与提交时间
    merged.source = choice === 'local' ? merged.source : 'package';
    merged.submittedAt = choice === 'local' ? merged.submittedAt : chosen.submittedAt;
    await putSession(stampRow(merged, merged.submittedAt));
    for (const take of pending.deferredTakes) {
      const exists = await db.takes.get(take.id);
      if (!exists) await putTake(stampRow(take, pending.createdAt));
    }
    for (const pick of pending.deferredPicks) {
      const exists = await db.picks.get(pick.id);
      if (!exists) await putPick(stampRow(pick, pending.createdAt));
    }
    await removeMergePending(pending.id);
  });

  await recalculateCapacities();
}

/** 放弃一条待定：离线包的该场次与暂挂 Take / 优选一律不写入 */
export async function discardMergePending(pendingIdValue: string): Promise<void> {
  await removeMergePending(pendingIdValue);
  await recalculateCapacities();
}

/** 导入入口：先保草稿再合并；中断后凭 packageNo 续写（合并按稳定 id 幂等） */
export async function importOfflinePackage(
  rawPkg: OfflinePackage
): Promise<{ stats: MergeStats; resumed: boolean }> {
  const pkg = normalizePackage(rawPkg);
  const now = Date.now();
  const existingDraft = await getImportDraft(pkg.packageNo);
  if (!existingDraft) {
    await putImportDraft({
      id: pkg.packageNo,
      packageNo: pkg.packageNo,
      origin: pkg.origin,
      exportedAt: pkg.exportedAt,
      payload: pkg,
      processedBatches: 0,
      totalBatches: 1,
      pendingResolved: false,
      createdAt: now,
      updatedAt: now
    });
  }
  // 始终合并本次传入的包（可能是同编号的续写片段）；草稿仅作为「曾中断」标记。
  // 待定点独立持久化在 mergePending，等制作人裁决。
  const stats = await mergeOfflinePackage(pkg);
  await removeImportDraft(pkg.packageNo);
  return { stats, resumed: Boolean(existingDraft) };
}

/** 放弃未完成的导入草稿（整次离线包作废，已合并的稳定数据保留） */
export async function discardImportDraft(packageNo: string): Promise<void> {
  await removeImportDraft(packageNo);
}
