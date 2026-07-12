-- DropForeignKey
ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_creatorId_fkey";

-- DropForeignKey
ALTER TABLE "ClipFeature" DROP CONSTRAINT "ClipFeature_campaignId_fkey";

-- DropForeignKey
ALTER TABLE "ClipFeature" DROP CONSTRAINT "ClipFeature_clipId_fkey";

-- DropForeignKey
ALTER TABLE "ClipFeature" DROP CONSTRAINT "ClipFeature_creatorId_fkey";

-- DropForeignKey
ALTER TABLE "ClipMetric" DROP CONSTRAINT "ClipMetric_publishJobId_fkey";

-- DropIndex
DROP INDEX "Campaign_creatorId_idx";

-- AlterTable
ALTER TABLE "Campaign" DROP COLUMN "creatorId",
DROP COLUMN "revenueRatePerMille";

-- AlterTable
ALTER TABLE "SocialAccount" DROP COLUMN "dailyQuota";

-- DropTable
DROP TABLE "ClipFeature";

-- DropTable
DROP TABLE "ClipMetric";

-- DropTable
DROP TABLE "Creator";
