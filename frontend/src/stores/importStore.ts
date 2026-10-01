/**
 * 离线包导入 store：维护导入弹窗动作与最近合并结果。
 * 待定裁决面板的开合由页面本地 state 管理；跨页共享的只有动作与结果。
 */
import { create } from 'zustand';
import type { MergeResult } from '@/types/merge';
import {
  discardImportDraft,
  discardMergePending,
  importOfflinePackage,
  parseOfflinePackage,
  resolveMergePending,
  type MergeStats
} from '@/utils/offlinePackage';
import type { MergeChoice, OfflinePackage } from '@/types/merge';

function toResult(pkg: OfflinePackage, stats: MergeStats, resumed: boolean): MergeResult {
  return {
    packageNo: pkg.packageNo,
    origin: pkg.origin,
    addedSongs: stats.addedSongs,
    addedSessions: stats.addedSessions,
    addedTakes: stats.addedTakes,
    addedPicks: stats.addedPicks,
    addedRetakes: stats.addedRetakes,
    pendingCount: stats.pendingCount,
    waitlistCount: stats.waitlistCount,
    resumed
  };
}

interface ImportState {
  /** 最近一次合并结果（页面顶部展示来源 / 待定 / 候补数量） */
  lastResult: MergeResult | null;
  busy: boolean;
  /** 解析并按稳定编号合并离线包文本；失败抛错且不改动任何本地数据 */
  mergeText: (text: string) => Promise<MergeResult>;
  /** 制作人对一条待定二选一 */
  resolvePending: (pendingId: string, choice: MergeChoice) => Promise<void>;
  /** 放弃一条待定 */
  dropPending: (pendingId: string) => Promise<void>;
  /** 放弃中断草稿 */
  dropDraft: (packageNo: string) => Promise<void>;
}

export const useImportStore = create<ImportState>()((set) => ({
  lastResult: null,
  busy: false,
  mergeText: async (text) => {
    set({ busy: true });
    try {
      const pkg = parseOfflinePackage(text);
      const { stats, resumed } = await importOfflinePackage(pkg);
      const result = toResult(pkg, stats, resumed);
      set({ lastResult: result });
      return result;
    } finally {
      set({ busy: false });
    }
  },
  resolvePending: async (pendingId, choice) => {
    await resolveMergePending(pendingId, choice);
  },
  dropPending: async (pendingId) => {
    await discardMergePending(pendingId);
  },
  dropDraft: async (packageNo) => {
    await discardImportDraft(packageNo);
  }
}));
