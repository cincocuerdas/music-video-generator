-- Add persisted project source mode for faster observability filtering
ALTER TABLE "Project"
ADD COLUMN "sourceMode" VARCHAR(20);

-- Backfill existing records
UPDATE "Project"
SET "sourceMode" = CASE
  WHEN TRIM(COALESCE("youtubeUrl", '')) <> '' THEN 'youtube'
  WHEN TRIM(COALESCE("audioUrl", '')) <> '' AND TRIM(COALESCE("lyrics", '')) = '' THEN 'audio'
  WHEN TRIM(COALESCE("lyrics", '')) <> '' OR TRIM(COALESCE("audioUrl", '')) <> '' THEN 'lyrics'
  ELSE 'unknown'
END
WHERE "sourceMode" IS NULL;

CREATE INDEX "Project_sourceMode_idx" ON "Project"("sourceMode");
