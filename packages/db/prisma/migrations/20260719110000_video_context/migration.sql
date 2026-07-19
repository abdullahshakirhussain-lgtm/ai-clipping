-- Contextual awareness: user-typed context + vision-derived on-screen-text context.
ALTER TABLE "SourceVideo" ADD COLUMN "context" TEXT;
ALTER TABLE "SourceVideo" ADD COLUMN "autoContext" TEXT;
