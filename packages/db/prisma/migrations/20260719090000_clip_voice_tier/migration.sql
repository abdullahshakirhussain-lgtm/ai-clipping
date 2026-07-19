-- Per-clip commentary voice tier; premium (ElevenLabs) is a manual upgrade.
ALTER TABLE "Clip" ADD COLUMN "voiceTier" TEXT NOT NULL DEFAULT 'standard';
