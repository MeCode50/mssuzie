-- CreateTable
CREATE TABLE "action_tokens" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "slot_starts_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "action_tokens_request_id_idx" ON "action_tokens"("request_id");

-- AddForeignKey
ALTER TABLE "action_tokens" ADD CONSTRAINT "action_tokens_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "reschedule_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
