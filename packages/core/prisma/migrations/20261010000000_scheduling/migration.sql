-- CreateEnum
CREATE TYPE "RunPipeline" AS ENUM ('session_copilot', 'reschedule');

-- CreateEnum
CREATE TYPE "StepKind" AS ENUM ('agent', 'tool');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('scheduled', 'rescheduled', 'cancelled');

-- CreateEnum
CREATE TYPE "RequestChannel" AS ENUM ('simulator', 'email');

-- CreateEnum
CREATE TYPE "RescheduleDecision" AS ENUM ('auto_applied', 'proposed', 'escalated', 'confirmed', 'rejected');

-- CreateEnum
CREATE TYPE "NotificationRole" AS ENUM ('parent', 'tutor', 'ops');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('sent', 'failed', 'dry_run');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentName" ADD VALUE 'intake_agent';
ALTER TYPE "AgentName" ADD VALUE 'scheduler_agent';
ALTER TYPE "AgentName" ADD VALUE 'policy_check';
ALTER TYPE "AgentName" ADD VALUE 'calendar_step';
ALTER TYPE "AgentName" ADD VALUE 'notifier_agent';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos';

-- AlterTable
ALTER TABLE "guardians" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Europe/London';

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "pipeline" "RunPipeline" NOT NULL DEFAULT 'session_copilot',
ALTER COLUMN "session_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "run_steps" ADD COLUMN     "input_json" JSONB,
ADD COLUMN     "kind" "StepKind" NOT NULL DEFAULT 'agent',
ADD COLUMN     "tool_name" TEXT;

-- CreateTable
CREATE TABLE "tutor_availability" (
    "id" TEXT NOT NULL,
    "tutor_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_time" VARCHAR(5) NOT NULL,
    "end_time" VARCHAR(5) NOT NULL,

    CONSTRAINT "tutor_availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "learner_id" TEXT NOT NULL,
    "tutor_id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'scheduled',
    "calendar_event_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "last_moved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reschedule_requests" (
    "id" TEXT NOT NULL,
    "guardian_id" TEXT NOT NULL,
    "learner_id" TEXT,
    "booking_id" TEXT,
    "channel" "RequestChannel" NOT NULL DEFAULT 'simulator',
    "raw_message_enc" TEXT NOT NULL,
    "parsed_json" JSONB,
    "decision" "RescheduleDecision",
    "reason" TEXT,
    "proposed_slots_json" JSONB,
    "decided_by" TEXT,
    "applied_from_at" TIMESTAMP(3),
    "applied_to_at" TIMESTAMP(3),
    "run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reschedule_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "to_role" "NotificationRole" NOT NULL,
    "to_email" TEXT,
    "intended_email" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL,
    "provider_message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tutor_availability_tutor_id_weekday_idx" ON "tutor_availability"("tutor_id", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "tutor_availability_tutor_id_weekday_start_time_key" ON "tutor_availability"("tutor_id", "weekday", "start_time");

-- CreateIndex
CREATE INDEX "bookings_tutor_id_starts_at_idx" ON "bookings"("tutor_id", "starts_at");

-- CreateIndex
CREATE INDEX "bookings_learner_id_starts_at_idx" ON "bookings"("learner_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "reschedule_requests_run_id_key" ON "reschedule_requests"("run_id");

-- CreateIndex
CREATE INDEX "reschedule_requests_guardian_id_created_at_idx" ON "reschedule_requests"("guardian_id", "created_at");

-- CreateIndex
CREATE INDEX "reschedule_requests_decision_created_at_idx" ON "reschedule_requests"("decision", "created_at");

-- CreateIndex
CREATE INDEX "notifications_request_id_idx" ON "notifications"("request_id");

-- AddForeignKey
ALTER TABLE "tutor_availability" ADD CONSTRAINT "tutor_availability_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_learner_id_fkey" FOREIGN KEY ("learner_id") REFERENCES "learners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "guardians"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_learner_id_fkey" FOREIGN KEY ("learner_id") REFERENCES "learners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "reschedule_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────── Database-level guarantees (Prisma does not model these) ─────────────

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A tutor, and a learner, can never be booked for overlapping times. Back-to-back classes
-- (one ending exactly when the next starts) are fine; cancelled bookings are ignored. Because the
-- database enforces this, two simultaneous reschedules to the same slot cannot both succeed.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tutor_no_overlap" EXCLUDE USING gist (
  "tutor_id" WITH =,
  (tsrange("starts_at", "starts_at" + make_interval(mins => "duration_min"))) WITH &&
) WHERE ("status" <> 'cancelled');

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_learner_no_overlap" EXCLUDE USING gist (
  "learner_id" WITH =,
  (tsrange("starts_at", "starts_at" + make_interval(mins => "duration_min"))) WITH &&
) WHERE ("status" <> 'cancelled');

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_duration_check" CHECK ("duration_min" BETWEEN 15 AND 240);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_version_check" CHECK ("version" >= 1);

ALTER TABLE "tutor_availability" ADD CONSTRAINT "tutor_availability_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7);
ALTER TABLE "tutor_availability" ADD CONSTRAINT "tutor_availability_time_format_check" CHECK (
  "start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
);
ALTER TABLE "tutor_availability" ADD CONSTRAINT "tutor_availability_order_check" CHECK ("end_time" > "start_time");
