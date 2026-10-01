/**
 * 棚容量核算（纯函数）
 * - 一个槽位 = 棚号 + 日期 + 时段；槽位内已确认场次的乐手席位合计不得超过棚容量
 * - 「已完成 / 已排期」视为已确认，锁定不动，候补永远不能挤掉它们
 * - 容量不足的场次按提交顺序（submittedAt，相同则按稳定 id）排队进候补
 * - 棚号或乐手一变就重算：先让所有已确认场次占座，再按提交顺序尝试放回其余场次
 */
import { CONFIRMED_SESSION_STATES, countMusicians, roomCapacityOf, type Session } from '@/types/session';

/** 槽位键：棚号 + 日期 + 时段 */
export function slotKey(session: Pick<Session, 'roomNo' | 'date' | 'period'>): string {
  return `${session.roomNo}|${session.date}|${session.period}`;
}

/** 已确认（锁定）场次判定 */
export function isConfirmed(session: Pick<Session, 'state'>): boolean {
  return CONFIRMED_SESSION_STATES.includes(session.state);
}

/** 参与容量核算的场次：已取消的排除（旧场次升级后同样参与核算） */
export function isActive(session: Pick<Session, 'state'>): boolean {
  return session.state !== '已取消';
}

/** 候补排队顺序：先提交先排，时间相同按稳定 id 兜底保证稳定排序 */
export function compareSubmittedAt(a: Session, b: Session): number {
  return a.submittedAt - b.submittedAt || a.id.localeCompare(b.id);
}

/**
 * 重算容量，返回每场次的新状态（只返回发生变化的 id → state）。
 * 规则：
 * 1. 已确认场次先占座，锁定不降级；
 * 2. 其余活跃场次（含候补）按提交顺序依次尝试放入对应槽位；
 * 3. 放得下 → 已排期；放不下（席位超容）→ 候补；
 * 4. 已取消不参与。
 */
export function recomputeCapacity(sessions: Session[]): Map<string, Session['state']> {
  const usedSeats = new Map<string, number>();
  const next = new Map<string, Session['state']>();

  // 1. 已确认场次锁定占座
  for (const session of sessions) {
    if (!isActive(session)) continue;
    if (!isConfirmed(session)) continue;
    const key = slotKey(session);
    usedSeats.set(key, (usedSeats.get(key) ?? 0) + countMusicians(session.musicians));
  }

  // 2. 其余场次按提交顺序尝试入座
  const candidates = sessions.filter((session) => isActive(session) && !isConfirmed(session)).sort(compareSubmittedAt);
  for (const session of candidates) {
    const key = slotKey(session);
    const capacity = roomCapacityOf(session.roomNo);
    const need = countMusicians(session.musicians);
    const used = usedSeats.get(key) ?? 0;
    if (used + need <= capacity) {
      usedSeats.set(key, used + need);
      next.set(session.id, '已排期');
    } else {
      next.set(session.id, '候补');
    }
  }

  return next;
}

/** 槽位内候补队列（按提交顺序），用于页面展示「第几位候补」 */
export function waitlistRank(sessions: Session[], target: Session): number {
  if (target.state !== '候补') return 0;
  const key = slotKey(target);
  const queue = sessions
    .filter((session) => session.state === '候补' && slotKey(session) === key)
    .sort(compareSubmittedAt);
  return queue.findIndex((session) => session.id === target.id) + 1;
}

/** 槽位剩余席位（用于提示候补场次还缺多少座） */
export function slotFreeSeats(sessions: Session[], target: Pick<Session, 'roomNo' | 'date' | 'period'>): number {
  const key = slotKey(target);
  const used = sessions
    .filter((session) => slotKey(session) === key && isActive(session) && isConfirmed(session))
    .reduce((sum, session) => sum + countMusicians(session.musicians), 0);
  return Math.max(0, roomCapacityOf(target.roomNo) - used);
}
