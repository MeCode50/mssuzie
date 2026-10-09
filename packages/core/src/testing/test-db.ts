import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPrisma, type PrismaClient } from "../db/client";

/** Set by `pnpm test:db`. DB-backed tests skip themselves when it is absent. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export interface TestDb {
  prisma: PrismaClient;
  schema: string;
  /** Extra independent client (own connection pool) on the same schema, to simulate other workers. */
  connect(max?: number): PrismaClient;
  drop(): Promise<void>;
}

const MIGRATIONS = new URL("../../prisma/migrations/", import.meta.url);

/** Create an isolated schema, apply every migration to it, and return clients bound to it. */
export async function createTestDb(url = TEST_DATABASE_URL): Promise<TestDb> {
  if (!url) throw new Error("TEST_DATABASE_URL is not set (run `pnpm test:db`)");
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    const dirs = readdirSync(fileURLToPath(MIGRATIONS), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const dir of dirs) {
      await admin.query(readFileSync(fileURLToPath(new URL(`${dir}/migration.sql`, MIGRATIONS)), "utf8"));
    }
  } finally {
    await admin.end();
  }
  const clients: PrismaClient[] = [];
  const connect = (max = 2) => {
    const c = createPrisma(url, { schema, max });
    clients.push(c);
    return c;
  };
  const prisma = connect(10);
  return {
    prisma, schema, connect,
    drop: async () => {
      await Promise.all(clients.map((c) => c.$disconnect()));
      const cleaner = new pg.Client({ connectionString: url });
      await cleaner.connect();
      await cleaner.query(`DROP SCHEMA "${schema}" CASCADE`);
      await cleaner.end();
    },
  };
}
