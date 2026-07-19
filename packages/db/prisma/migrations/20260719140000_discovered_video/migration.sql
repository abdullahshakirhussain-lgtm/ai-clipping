-- Finder: velocity-ranked source-platform discovery candidates.
CREATE TYPE "DiscoveredVideoStatus" AS ENUM ('NEW', 'INGESTED', 'HIDDEN');

CREATE TABLE "DiscoveredVideo" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "permalink" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "author" TEXT,
    "source" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sourceCreatedAt" TIMESTAMP(3) NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenScore" INTEGER NOT NULL DEFAULT 0,
    "peakScore" INTEGER NOT NULL DEFAULT 0,
    "lastPolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "velocity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "DiscoveredVideoStatus" NOT NULL DEFAULT 'NEW',
    "ingestedVideoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveredVideo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscoveredVideo_platform_externalId_key" ON "DiscoveredVideo"("platform", "externalId");
CREATE INDEX "DiscoveredVideo_status_velocity_idx" ON "DiscoveredVideo"("status", "velocity");
