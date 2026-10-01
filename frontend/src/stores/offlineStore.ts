/**
 * 离线包 store：维护离线包导入、待定场次决议与草稿续跑。
 * 页面通过 useIdbTable 读取响应式数据，调用本 store 的 actions 执行变更。
 */
import { create } from 'zustand';
import type { OfflinePackage } from '@/types/offline';
import {
  discardDraft as discardDraftRow,
  findResumableDraft,
  markDraftInterrupted,
  mergeOfflinePackage,
  type MergeSummary
} from '@/utils/offlineImport';
import { resolvePendingSession } from '@/utils/db';

interface OfflineState {
  /** 最近一次合并结果（用于结果回显） */
  lastSummary: MergeSummary | null;
  /** 可续跑草稿 id（若有） */
  resumableDraftId: string | null;
  importing: boolean;
  /** 导入并合并一个离线包 */
  importPackage: (pkg: OfflinePackage) => Promise<MergeSummary>;
  /** 续跑指定草稿 */
  resumeDraft: (draftId: string) => Promise<MergeSummary>;
  /** 制作人选定待定场次：采用本地现值或离线包值 */
  resolvePending: (pendingId: string, choice: 'local' | 'package') => Promise<void>;
  /** 丢弃草稿 */
  discardDraft: (draftId: string) => Promise<void>;
  /** 刷新可续跑草稿提示 */
  refreshResumable: () => Promise<void>;
}

export const useOfflineStore = create<OfflineState>()((set, get) => ({
  lastSummary: null,
  resumableDraftId: null,
  importing: false,
  importPackage: async (pkg) => {
    set({ importing: true });
    try {
      const summary = await mergeOfflinePackage(pkg, null);
      set({ lastSummary: summary, resumableDraftId: null });
      return summary;
    } finally {
      set({ importing: false });
    }
  },
  resumeDraft: async (draftId) => {
    set({ importing: true });
    try {
      // 续跑：取出草稿数据后重新合并（幂等）
      const { db } = await import('@/utils/db');
      const draft = await db.importDrafts.get(draftId);
      if (!draft) throw new Error('草稿不存在');
      const summary = await mergeOfflinePackage(draft.packageData, draft);
      set({ lastSummary: summary, resumableDraftId: null });
      return summary;
    } finally {
      set({ importing: false });
    }
  },
  resolvePending: async (pendingId, choice) => {
    await resolvePendingSession(pendingId, choice);
  },
  discardDraft: async (draftId) => {
    await discardDraftRow(draftId);
    if (get().resumableDraftId === draftId) set({ resumableDraftId: null });
  },
  refreshResumable: async () => {
    const draft = await findResumableDraft();
    set({ resumableDraftId: draft?.id ?? null });
  }
}));

/** 标记指定草稿为已中断（页面关闭前调用，保住进度） */
export async function interruptDraft(draftId: string): Promise<void> {
  await markDraftInterrupted(draftId);
}
