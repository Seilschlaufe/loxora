import { openDB, type DBSchema } from "idb";
interface LocalSchema extends DBSchema {
  state: { key: string; value: unknown };
}
let database: ReturnType<typeof openDB<LocalSchema>> | undefined;
function storage() {
  database ??= openDB<LocalSchema>("lexora", 1, {
    upgrade(db) {
      db.createObjectStore("state");
    },
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}
export async function readLocal<T>(key: string): Promise<T | undefined> {
  return (await storage()).get("state", key) as Promise<T | undefined>;
}
export async function writeLocal(key: string, value: unknown) {
  await (await storage()).put("state", value, key);
}
export async function clearScope(scope: string) {
  const db = await storage();
  const tx = db.transaction("state", "readwrite");
  const keys = await tx.store.getAllKeys();
  for (const key of keys)
    if (key.startsWith(scope + ":")) await tx.store.delete(key);
  await tx.done;
}
