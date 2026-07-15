-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "untouched" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SocialAccount" ADD COLUMN     "passwordEnc" TEXT,
ADD COLUMN     "username" TEXT;

-- AlterTable
ALTER TABLE "SourceVideo" ADD COLUMN     "untouched" BOOLEAN NOT NULL DEFAULT false;
