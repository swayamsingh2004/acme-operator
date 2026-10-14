import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Returns a connection to `file`, reopening it when the seed script has replaced
 * the file (different inode). Lets the sandbox servers keep running across reseeds.
 */
export function dbOpener(file: string): () => DatabaseSync {
  let conn: DatabaseSync | null = null;
  let inode = -1;
  return () => {
    const ino = fs.statSync(file).ino;
    if (!conn || ino !== inode) {
      try { conn?.close(); } catch { /* already closed */ }
      conn = new DatabaseSync(file);
      inode = ino;
    }
    return conn;
  };
}

/** Write a fresh DB atomically: build at a temp path, then rename over the target. */
export function freshDb(file: string, build: (db: DatabaseSync) => void): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  build(db);
  db.close();
  fs.renameSync(tmp, file);
}

export type Row = Record<string, any>;
