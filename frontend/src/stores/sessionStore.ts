/**
 * 场次 store：维护场次排期、棚号占用校验、容量重算与筛选条件。
 * - 新增场次提交后参与容量核算：容量不足按提交顺序进候补，不能挤掉已确认场次
 * - 棚号 / 时段 / 乐手变更后容量冲突立即重算
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Session, SessionInput } from '@/types/session';
import {
  putSession,
  recalculateCapacities,
  removeSession,
  updateSession
} from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';

export const SESSION_FILTER_KEYS = ['rooms', 'periods', 'states'];

interface SessionState {
  filters: FilterModel;
  currentSessionId: string | null;
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  selectSession: (id: string | null) => void;
  createSession: (payload: SessionInput) => Promise<string>;
  editSession: (id: string, patch: Partial<Session>) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  filters: { keyword: '', rooms: [], periods: [], states: [] },
  currentSessionId: null,
  setFilters: (next) => set({ filters: next }),
  resetFilters: () => set({ filters: { keyword: '', rooms: [], periods: [], states: [] } }),
  selectSession: (id) => set({ currentSessionId: id }),
  createSession: async (payload) => {
    // 先落库再统一重算容量：放不下时自动按提交顺序候补，已确认场次不受影响
    const row = buildRow(
      { ...payload, source: 'local' as const, submittedAt: Date.now() },
      'session'
    );
    await putSession(row);
    await recalculateCapacities();
    set({ currentSessionId: row.id });
    return row.id;
  },
  editSession: async (id, patch) => {
    await updateSession(id, patch);
    // 棚号 / 时段 / 乐手一变，容量冲突立即重算
    if (patch.roomNo !== undefined || patch.period !== undefined || patch.musicians !== undefined || patch.date !== undefined) {
      await recalculateCapacities();
    }
  },
  deleteSession: async (id) => {
    await removeSession(id);
    await recalculateCapacities();
    if (get().currentSessionId === id) set({ currentSessionId: null });
  }
}));
