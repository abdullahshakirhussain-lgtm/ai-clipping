-- DropForeignKey
ALTER TABLE "ReviewAction" DROP CONSTRAINT "ReviewAction_reviewerId_fkey";

-- AlterTable
ALTER TABLE "Campaign" ALTER COLUMN "sourceVideoUrl" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "detectionSource" TEXT,
ADD COLUMN     "hookScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "kept" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "overallScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "scoreBreakdown" JSONB,
ADD COLUMN     "viralScore" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ReviewAction" ALTER COLUMN "reviewerId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SourceVideo" ADD COLUMN     "originalFilename" TEXT,
ALTER COLUMN "originalUrl" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Clip_overallScore_idx" ON "Clip"("overallScore");

-- AddForeignKey
ALTER TABLE "ReviewAction" ADD CONSTRAINT "ReviewAction_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
