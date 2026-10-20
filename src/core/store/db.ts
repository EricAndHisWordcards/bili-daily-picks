/**
 * 极简 IndexedDB 封装（无依赖）。
 *
 * 所有业务表都通过 keyPath 主键访问；快照表额外建 bvid / ts 索引，用于按视频和
 * 时间窗口查询。
 */

export const DB_NAME = 'bili-daily-picks';
export const DB_VERSION = 2;

export type StoreName =
  | 'kv'
  | 'history'
  | 'snapshots'
  | 'daily'
  | 'profile'
  | 'dismissed'
  | 'pipeline'
  | 'weekly';

interface StoreDef {
  keyPath: string;
  indexes?: Array<{ name: string; keyPath: string | string[] }>;
}

const STORES: Record<StoreName, StoreDef> = {
  kv: { keyPath: 'key' },
  history: { keyPath: 'bvid' },
  snapshots: {
    keyPath: 'id',
    indexes: [
      { name: 'bvid', keyPath: 'bvid' },
      { name: 'ts', keyPath: 'ts' },
    ],
  },
  daily: { keyPath: 'id' },
  profile: { keyPath: 'id' },
  dismissed: { keyPath: 'bvid' },
  pipeline: { keyPath: 'id' },
  weekly: { keyPath: 'weekKey' },
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, def] of Object.entries(STORES) as Array<[StoreName, StoreDef]>) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: def.keyPath });
          for (const index of def.indexes ?? []) {
            store.createIndex(index.name, index.keyPath, { unique: false });
          }
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'));
    request.onblocked = () => reject(new Error('IndexedDB 被其他标签页阻塞'));
  });
  return dbPromise;
}

function runRequest<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let request: IDBRequest<T>;
        const tx = db.transaction(store, mode);
        try {
          request = operation(tx.objectStore(store));
        } catch (error) {
          reject(error);
          return;
        }
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error ?? request.error ?? new Error('IndexedDB 事务失败'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
      }),
  );
}

export function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return runRequest<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return runRequest<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export function idbGetAllByIndex<T>(store: StoreName, indexName: string, key: IDBValidKey): Promise<T[]> {
  return runRequest<T[]>(store, 'readonly', (s) =>
    s.index(indexName).getAll(key) as IDBRequest<T[]>,
  );
}

export function idbPut<T>(store: StoreName, value: T): Promise<void> {
  return runRequest(store, 'readwrite', (s) => s.put(value as unknown as object) as IDBRequest<IDBValidKey>).then(
    () => undefined,
  );
}

export function idbBulkPut<T>(store: StoreName, values: T[]): Promise<void> {
  if (values.length === 0) return Promise.resolve();
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const objectStore = tx.objectStore(store);
        for (const value of values) objectStore.put(value as unknown as object);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('批量写入失败'));
        tx.onabort = () => reject(tx.error ?? new Error('批量写入中止'));
      }),
  );
}

export function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  return runRequest(store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>).then(
    () => undefined,
  );
}

export function idbClear(store: StoreName): Promise<void> {
  return runRequest(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>).then(
    () => undefined,
  );
}

export function idbDeleteRange(store: StoreName, range: IDBKeyRange, indexName?: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const objectStore = tx.objectStore(store);
        const source = indexName
          ? (objectStore.index(indexName) as unknown as IDBObjectStore)
          : objectStore;
        const cursorRequest = source.openCursor(range);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('删除区间失败'));
        tx.onabort = () => reject(tx.error ?? new Error('删除区间中止'));
      }),
  );
}

/** 按主键取最后一条（主键是日期字符串时即最新一天） */
export function idbGetLast<T>(store: StoreName): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const request = tx.objectStore(store).openCursor(null, 'prev');
        let result: T | undefined;
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) result = cursor.value as T;
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error ?? new Error('读取最新记录失败'));
      }),
  );
}
