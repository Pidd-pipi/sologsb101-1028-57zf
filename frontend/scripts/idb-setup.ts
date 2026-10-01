/** 测试引导：在任何 db 模块加载前安装 fake-indexeddb */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

(globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
(globalThis as Record<string, unknown>).IDBKeyRange = IDBKeyRange;
