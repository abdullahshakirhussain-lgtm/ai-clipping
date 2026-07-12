-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "autoEnhance" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "edl" JSONB;

-- AlterTable
ALTER TABLE "SourceVideo" ADD COLUMN     "autoEnhance" BOOLEAN NOT NULL DEFAULT false;

