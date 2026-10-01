/**
 * 离线包合并核心规则的端到端验证（node + fake-indexeddb，不启动浏览器）。
 * 覆盖：稳定编号合并不覆盖、新增曲目/Take 直接接上、两套值列待定、
 * 容量不足按提交顺序候补不挤已确认、棚号一变重算、裁决后补写暂挂、草稿续写幂等。
 */
import './idb-setup';
import assert from 'node:assert';
import {
  db,
  initDatabase,
  listMergePending,
  listSessions,
  listTakes,
  listPicks,
  getImportDraft,
  listImportDrafts,
  countAll,
  resetDatabase
} from '../src/utils/db';
import {
  importOfflinePackage,
  resolveMergePending,
  discardImportDraft,
  parseOfflinePackage,
  OFFLINE_PACKAGE_KIND,
  type MergeStats
} from '../src/utils/offlinePackage';
import { waitlistRank, slotFreeSeats, recomputeCapacity } from '../src/utils/capacity';
import type { OfflinePackage } from '../src/types/merge';
import type { Session } from '../src/types/session';

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  assert(condition, `❌ ${label}${detail ? ` :: ${JSON.stringify(detail)}` : ''}`);
  console.log(`  ✓ ${label}`);
  passed += 1;
}

const T = (n: number): string => new Date(2026, 8, 1, 9).getTime() + n * 1000;

function pkg(partial: Partial<OfflinePackage> & { packageNo: string }): OfflinePackage {
  return {
    kind: OFFLINE_PACKAGE_KIND,
    origin: '二号棚外勤组',
    exportedAt: new Date().toISOString(),
    projects: [],
    songs: [],
    sessions: [],
    takes: [],
    picks: [],
    retakes: [],
    ...partial
  };
}

async function main(): Promise<void> {
  await initDatabase();
  await resetDatabase();

  // --- 场景 1：全新曲目 + 场次 + Take 直接接上，容量足够 → 正式排期 ---
  console.log('场景 1：新增数据直接接上');
  const p1 = pkg({
    packageNo: 'PKG-T1',
    projects: [{ id: 'prj-x1', name: '外勤项目', client: '测试方', startDate: '2026-09-01', deliverDate: '2026-10-01', state: '录制中' }],
    songs: [{ id: 'sg-x1', projectId: 'prj-x1', title: '外勤曲一', durationSec: 200, arrangement: '乐队', state: '待录' }],
    sessions: [
      {
        id: 'ss-x1',
        songId: 'sg-x1',
        date: '2026-09-10',
        period: '上午',
        engineer: '何笙',
        roomNo: 'C 棚',
        musicians: '吉他：阿甲、贝斯：阿乙',
        state: '已排期'
      } as Session
    ],
    takes: [
      { id: 'tk-x1', sessionId: 'ss-x1', takeNo: 'T01', startTc: '00:00:01:00', endTc: '00:01:00:00', grade: '可用', issues: ['无'] }
    ]
  });
  const r1 = await importOfflinePackage(p1);
  check('新增曲目计数', r1.stats.addedSongs === 1, r1.stats);
  check('新增场次计数', r1.stats.addedSessions === 1);
  check('新增 Take 计数', r1.stats.addedTakes === 1);
  check('无待定', r1.stats.pendingCount === 0);
  const s1 = (await listSessions()).find((s) => s.id === 'ss-x1');
  check('容量足够 → 已排期', s1?.state === '已排期', s1?.state);
  check('来源标记为离线包', s1?.source === 'package');
  check('草稿已清除（无中断）', (await listImportDrafts()).length === 0);

  // --- 场景 2：同一稳定编号重导，幂等不重复 ---
  console.log('场景 2：同编号重导幂等');
  const r2 = await importOfflinePackage(p1);
  check('重导无新增场次', r2.stats.addedSessions === 0);
  check('重导无新增 Take', r2.stats.addedTakes === 0);

  // --- 场景 3：同场次棚号/乐手两套值 → 待定，不写正式排期 ---
  console.log('场景 3：两套值列待定');
  const p3 = pkg({
    packageNo: 'PKG-T3',
    sessions: [
      {
        id: 'ss-x1',
        songId: 'sg-x1',
        date: '2026-09-10',
        period: '上午',
        engineer: '何笙',
        roomNo: 'B 棚',
        musicians: '吉他：阿甲、贝斯：阿乙、键盘：阿丙',
        state: '已排期'
      } as Session
    ],
    takes: [
      { id: 'tk-x2', sessionId: 'ss-x1', takeNo: 'T02', startTc: '00:01:01:00', endTc: '00:02:00:00', grade: '待定', issues: ['噪声'] }
    ]
  });
  const r3 = await importOfflinePackage(p3);
  check('待定计数为 1', r3.stats.pendingCount === 1, r3.stats);
  const pendings = await listMergePending();
  check('待定记录挂在 mergePending', pendings.length === 1 && pendings[0].sessionId === 'ss-x1');
  check('待定字段含棚号+乐手', pendings[0].fields.includes('roomNo') && pendings[0].fields.includes('musicians'));
  check('待定场次的新 Take 被暂挂', pendings[0].deferredTakes.some((t) => t.id === 'tk-x2'));
  check('正式排期未被覆盖（仍是 C 棚）', (await listSessions()).find((s) => s.id === 'ss-x1')?.roomNo === 'C 棚');
  check('暂挂 Take 未写入 takes', (await listTakes()).every((t) => t.id !== 'tk-x2'));

  // 裁决采用本地 → 仍 C 棚，暂挂 Take 补写
  await resolveMergePending(pendings[0].id, 'local');
  check('裁决后待定清空', (await listMergePending()).length === 0);
  check('采用本地 → 棚号仍 C 棚', (await listSessions()).find((s) => s.id === 'ss-x1')?.roomNo === 'C 棚');
  check('暂挂 Take 已补写', (await listTakes()).some((t) => t.id === 'tk-x2'));

  // --- 场景 4：容量不足 → 按提交顺序候补，不挤已确认 ---
  console.log('场景 4：容量候补排队');
  await resetDatabase();
  // C 棚容量 8：先放一个 7 席的已确认（本地，最早提交）
  const p4 = pkg({
    packageNo: 'PKG-T4',
    projects: [{ id: 'prj-c', name: '容量项目', client: 'c', startDate: '2026-09-01', deliverDate: '2026-10-01', state: '录制中' }],
    songs: [
      { id: 'sg-c1', projectId: 'prj-c', title: '曲一', durationSec: 100, arrangement: '乐队', state: '待录' },
      { id: 'sg-c2', projectId: 'prj-c', title: '曲二', durationSec: 100, arrangement: '乐队', state: '待录' },
      { id: 'sg-c3', projectId: 'prj-c', title: '曲三', durationSec: 100, arrangement: '乐队', state: '待录' }
    ],
    sessions: [
      { id: 'ss-c1', songId: 'sg-c1', date: '2026-09-15', period: '上午', engineer: 'a', roomNo: 'C 棚', musicians: '一、二、三、四、五、六、七', state: '已排期' } as Session,
      // 需要 3 席，只剩 1 → 候补（先提交）
      { id: 'ss-c2', songId: 'sg-c2', date: '2026-09-15', period: '上午', engineer: 'a', roomNo: 'C 棚', musicians: '八、九、十', state: '已排期' } as Session,
      // 需要 1 席，剩 1 → 可入座（后提交，但放得下）
      { id: 'ss-c3', songId: 'sg-c3', date: '2026-09-15', period: '上午', engineer: 'a', roomNo: 'C 棚', musicians: '十一', state: '已排期' } as Session
    ]
  });
  await importOfflinePackage(p4);
  const all = await listSessions();
  const c1 = all.find((s) => s.id === 'ss-c1')!;
  const c2 = all.find((s) => s.id === 'ss-c2')!;
  const c3 = all.find((s) => s.id === 'ss-c3')!;
  check('7 席已确认锁定', c1.state === '已排期', c1.state);
  check('放不下的场次候补', c2.state === '候补', c2.state);
  check('候补按提交顺序排第 1', waitlistRank(all, c2) === 1);
  check('后提交但放得下 → 入座', c3.state === '已排期', c3.state);
  check('槽位余席显示 0', slotFreeSeats(all, c2) === 0);

  // 棚号一变（大排练厅 60 席）→ 重算，候补应自动入座
  c2.roomNo = '大排练厅';
  const nextStates = recomputeCapacity(all.map((s) => (s.id === 'ss-c2' ? c2 : s)) as Session[]);
  check('换大棚后候补可入座', nextStates.get('ss-c2') === '已排期', [...nextStates.entries()]);

  // 乐手变少（c1 从 7 席变 1 席）→ c2 回到 C 棚也能入座
  const slimmed = all.map((s) => (s.id === 'ss-c1' ? { ...s, musicians: '一' } : s)) as Session[];
  const next2 = recomputeCapacity(slimmed);
  check('乐手变少后重算 → 候补递补', next2.get('ss-c2') === '已排期');

  // --- 场景 5：解析坏包不改动数据 ---
  console.log('场景 5：坏包拒绝');
  let threw = false;
  try {
    parseOfflinePackage('{ not json');
  } catch {
    threw = true;
  }
  check('非法 JSON 拒绝', threw);
  threw = false;
  try {
    parseOfflinePackage(JSON.stringify({ hello: 1 }));
  } catch {
    threw = true;
  }
  check('非离线包格式拒绝', threw);

  // --- 场景 6：草稿续写（模拟 importDrafts 中残留草稿）---
  console.log('场景 6：中断草稿续写');
  const resumePkg = pkg({
    packageNo: 'PKG-T6',
    songs: [{ id: 'sg-r1', projectId: 'prj-c', title: '续写曲', durationSec: 50, arrangement: '合唱', state: '待录' }],
    sessions: [{ id: 'ss-r1', songId: 'sg-r1', date: '2026-09-20', period: '通宵', engineer: 'z', roomNo: 'A 棚', musicians: '独奏：续', state: '已排期' } as Session]
  });
  // 手工制造一个中断草稿
  await db.importDrafts.put({
    id: 'PKG-T6',
    packageNo: 'PKG-T6',
    origin: resumePkg.origin,
    exportedAt: resumePkg.exportedAt,
    payload: resumePkg,
    processedBatches: 0,
    totalBatches: 1,
    pendingResolved: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  check('草稿存在', (await getImportDraft('PKG-T6')) !== undefined);
  const r6 = await importOfflinePackage(resumePkg);
  check('续写标记 resumed', r6.resumed === true);
  check('续写场次正常落库', (await listSessions()).some((s) => s.id === 'ss-r1'));
  check('续写完成草稿清除', (await getImportDraft('PKG-T6')) === undefined);
  await discardImportDraft('PKG-T6'); // 幂等调用不应抛错
  check('放弃不存在的草稿不报错', true);

  // --- 场景 7：优选随待定暂挂，裁决后补写 ---
  console.log('场景 7：优选暂挂与补写');
  const p7 = pkg({
    packageNo: 'PKG-T7',
    sessions: [
      { id: 'ss-c1', songId: 'sg-c1', date: '2026-09-15', period: '下午', engineer: 'a', roomNo: 'A 棚', musicians: '改时段', state: '已排期' } as Session
    ],
    takes: [
      { id: 'tk-c1', sessionId: 'ss-c1', takeNo: 'T99', startTc: '00:00:01:00', endTc: '00:00:10:00', grade: '可用', issues: ['无'] }
    ],
    picks: [{ id: 'pk-c1', takeId: 'tk-c1', usage: '全曲', order: 999, note: '离线包优选' }]
  });
  await importOfflinePackage(p7);
  const mp = (await listMergePending()).find((m) => m.sessionId === 'ss-c1');
  check('优选随待定暂挂', mp?.deferredPicks.some((p) => p.id === 'pk-c1') === true);
  check('暂挂优选未写入', (await listPicks()).every((p) => p.id !== 'pk-c1'));
  await resolveMergePending(mp!.id, 'package');
  check('裁决后优选补写', (await listPicks()).some((p) => p.id === 'pk-c1'));

  // --- 场景 8：本地场次已处于待定时，同编号包再来新 Take 也必须暂挂，不直接落库 ---
  console.log('场景 8：待定期间新增 Take 继续暂挂');
  const p8a = pkg({
    packageNo: 'PKG-T8',
    sessions: [
      { id: 'ss-c2', songId: 'sg-c2', date: '2026-09-15', period: '上午', engineer: 'a', roomNo: 'A 棚', musicians: '换棚', state: '已排期' } as Session
    ]
  });
  await importOfflinePackage(p8a);
  check('制造一条待定', (await listMergePending()).some((m) => m.sessionId === 'ss-c2'));
  const p8b = pkg({
    packageNo: 'PKG-T8',
    takes: [
      { id: 'tk-pending-late', sessionId: 'ss-c2', takeNo: 'T50', startTc: '00:00:01:00', endTc: '00:00:09:00', grade: '可用', issues: ['无'] }
    ]
  });
  await importOfflinePackage(p8b);
  const mp2 = (await listMergePending()).find((m) => m.sessionId === 'ss-c2');
  check('待定期间的新 Take 挂到既有待定点', mp2?.deferredTakes.some((t) => t.id === 'tk-pending-late') === true);
  check('该 Take 在裁决前不落正式表', (await listTakes()).every((t) => t.id !== 'tk-pending-late'));

  const counts = await countAll();
  console.log('\n最终表行数:', counts);
  console.log(`\n全部 ${passed} 项断言通过`);
  await db.close();
  void T;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
