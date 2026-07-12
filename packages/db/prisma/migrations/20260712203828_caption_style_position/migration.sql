-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "captionPosition" TEXT NOT NULL DEFAULT 'bottom';

-- AlterTable
ALTER TABLE "SourceVideo" ADD COLUMN     "captionPosition" TEXT NOT NULL DEFAULT 'bottom',
ADD COLUMN     "captionStyle" TEXT NOT NULL DEFAULT 'bold-center';

