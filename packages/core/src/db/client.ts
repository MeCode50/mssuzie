import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

export interface CreatePrismaOptions {
  /** Postgres schema to use (tests isolate themselves in their own schema). */
  schema?: string;
  /** Max pooled connections for this client. */
  max?: number;
}

export function createPrisma(connectionString: string, options: CreatePrismaOptions = {}): PrismaClient {
  const { schema, max } = options;
  return new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString,
        ...(max ? { max } : {}),
        // Raw SQL (the queue) resolves unqualified tables through search_path, so set it as well.
        ...(schema ? { options: `-c search_path="${schema}"` } : {}),
      },
      schema ? { schema } : undefined,
    ),
  });
}

// Reuse one client per process (survives Next.js dev hot reloads).
const globalForPrisma = globalThis as unknown as { __mssuziePrisma?: PrismaClient };

export function getPrisma(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  globalForPrisma.__mssuziePrisma ??= createPrisma(connectionString);
  return globalForPrisma.__mssuziePrisma;
}

export type { PrismaClient };
