/**
 * 验证 IndexedDB v1 → v2 结构升级：
 * 旧场次（无 source/submittedAt）在升级后自动补齐来源 local、回填 submittedAt，
 * 并作为「已确认」参与容量核算；新增候补不会挤掉它们。
 */
import './idb-setup';
import assert from 'node:assert';

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  assert(condition, `❌ ${label}${detail ? ` :: ${JSON.stringify(detail)}` : ''}`);
  console.log(`  ✓ ${label}`);
  passed += 1;
}

async function openV1(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('gbstudiotake-db');
    req.onupgradeneeded = (): void => {
      const d = req.result;
      const sessions = d.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('date', 'date', { unique: false });
      sessions.createIndex('roomNo', 'roomNo', { unique: false });
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('songs', { keyPath: 'id' });
      d.createObjectStore('takes', { keyPath: 'id' });
      d.createObjectStore('picks', { keyPath: 'id' });
      d.createObjectStore('retakes', { keyPath: 'id' });
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error);
  });
}

function seedV1(d: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = d.transaction(['sessions'], 'readwrite');
    const store = tx.objectStore('sessions');
    // v1 行：没有 source / submittedAt / revision
    store.put({
      id: 'ss-old-1',
      songId: 'sg-old',
      date: '2024-03-12',
      period: '上午',
      engineer: '赵鸣',
      roomNo: 'C 棚',
      musicians: '一、二、三、四、五、六、七',
      state: '已排期'
    });
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error);
  });
}

async function main(): Promise<void> {
  const v1db = await openV1();
  await seedV1(v1db);
  v1db.close();

  // 动态导入，确保 db 单例使用上面的 polyfill 并触发 v1→v2 upgrade
  const { db, listSessions } = await import('../src/utils/db');
  const { recomputeCapacity } = await import('../src/utils/capacity');
  const { importOfflinePackage, OFFLINE_PACKAGE_KIND } = await import('../src/utils/offlinePackage');

  await db.open();
  const rows = await listSessions();
  check('旧场次仍在', rows.length === 1);
  const old = rows[0];
  check('旧场次来源回填 local', old.source === 'local', old.source);
  check('旧场次提交时间已回填', typeof old.submittedAt === 'number' && old.submittedAt > 0);
  check('旧场次行修订号升到 2', old.revision === 2, old.revision);

  // mergePending / importDrafts 新表存在
  const tableNames = db.tables.map((t) => t.name);
  check('mergePending 表已建立', tableNames.includes('mergePending'));
  check('importDrafts 表已建立', tableNames.includes('importDrafts'));

  // 旧场次 7 席占 C 棚（容量 8）；新包来一个 3 席的 → 必须候补，不能挤掉旧场次
  await importOfflinePackage({
    kind: OFFLINE_PACKAGE_KIND,
    packageNo: 'PKG-MIG',
    origin: '迁移验证',
    exportedAt: new Date().toISOString(),
    projects: [],
    songs: [],
    sessions: [
      {
        id: 'ss-new-1',
        songId: 'sg-old',
        date: '2024-03-12',
        period: '上午',
        engineer: '赵鸣',
        roomNo: 'C 棚',
        musicians: '八、九、十',
        state: '已排期'
      }
    ],
    takes: [],
    picks: [],
    retakes: []
  });
  const after = await listSessions();
  const oldRow = after.find((s) => s.id === 'ss-old-1');
  const newRow = after.find((s) => s.id === 'ss-new-1');
  check('旧场次保持已排期（不被挤掉）', oldRow?.state === '已排期', oldRow?.state);
  check('容量不足的新场次候补', newRow?.state === '候补', newRow?.state);

  // 纯函数重算幂等：候补稳定保持候补，已确认不抖动
  const secondPass = recomputeCapacity(after);
  check('重复重算结果稳定（候补仍候补）', secondPass.get('ss-new-1') === '候补', [...secondPass.entries()]);
  check('重复重算不降级已确认', !secondPass.has('ss-old-1'));

  console.log(`\n迁移验证全部 ${passed} 项断言通过`);
  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
