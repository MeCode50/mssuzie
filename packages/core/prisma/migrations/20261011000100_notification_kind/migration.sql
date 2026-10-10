-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('applied', 'proposal', 'confirmed', 'escalation', 'rejected');

-- Notifications are new in the previous migration and have never been written to; clear any strays.
DELETE FROM "notifications";

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "kind" "NotificationKind" NOT NULL;

-- DropIndex
DROP INDEX "notifications_request_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "notifications_request_id_to_role_kind_key" ON "notifications"("request_id", "to_role", "kind");
