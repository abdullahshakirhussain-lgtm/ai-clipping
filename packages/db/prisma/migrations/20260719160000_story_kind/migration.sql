-- Story Studio: mark generated videos and hold their generation spec.
ALTER TABLE "SourceVideo" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'clip';
ALTER TABLE "SourceVideo" ADD COLUMN "storySpec" JSONB;
