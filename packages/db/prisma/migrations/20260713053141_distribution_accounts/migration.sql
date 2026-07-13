-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "category" TEXT;

-- AlterTable
ALTER TABLE "SocialAccount" ADD COLUMN     "activeEndHour" INTEGER NOT NULL DEFAULT 21,
ADD COLUMN     "activeStartHour" INTEGER NOT NULL DEFAULT 9,
ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'general',
ADD COLUMN     "postsPerDay" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- AlterTable
ALTER TABLE "SourceVideo" ADD COLUMN     "category" TEXT;

-- CreateIndex
CREATE INDEX "Clip_category_idx" ON "Clip"("category");

-- CreateIndex
CREATE UNIQUE INDEX "PublishJob_clipId_socialAccountId_key" ON "PublishJob"("clipId", "socialAccountId");

-- CreateIndex
CREATE INDEX "SocialAccount_category_idx" ON "SocialAccount"("category");

