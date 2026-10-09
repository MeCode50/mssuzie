import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

export function createPrisma(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// Reuse one client per process (survives Next.js dev hot reloads).
const globalForPrisma = globalThis as unknown as { __mssuziePrisma?: PrismaClient };

export function getPrisma(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  globalForPrisma.__mssuziePrisma ??= createPrisma(connectionString);
  return globalForPrisma.__mssuziePrisma;
}

export type { PrismaClient };
