-- CreateEnum
CREATE TYPE "ClipOutcome" AS ENUM ('FLOP', 'OK', 'HIT');

-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "outcome" "ClipOutcome";

-- CreateTable
CREATE TABLE "Calibration" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "weights" JSONB NOT NULL,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "insights" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Calibration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Clip_outcome_idx" ON "Clip"("outcome");
