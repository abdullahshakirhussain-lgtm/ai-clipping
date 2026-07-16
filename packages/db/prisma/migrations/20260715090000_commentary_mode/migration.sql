-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "commentaryMode" TEXT NOT NULL DEFAULT 'off';

-- AlterTable
ALTER TABLE "SourceVideo" ADD COLUMN     "commentaryMode" TEXT NOT NULL DEFAULT 'off';
