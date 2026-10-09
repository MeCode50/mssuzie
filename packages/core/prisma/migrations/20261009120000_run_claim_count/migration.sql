-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "claim_count" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "runs_status_locked_at_idx" ON "runs"("status", "locked_at");

