-- Keep pgvector extension available for vector column operations.
CREATE EXTENSION IF NOT EXISTS vector;

-- Replace the less selective style/score index with one that also supports recency ordering.
DROP INDEX IF EXISTS "GenerationFeedback_style_score_idx";
CREATE INDEX IF NOT EXISTS "GenerationFeedback_style_score_createdAt_idx"
ON "GenerationFeedback" ("style", "score", "createdAt" DESC);

-- Enforce fixed dimensions so pgvector ANN indexes can be created.
ALTER TABLE "GenerationFeedback"
ALTER COLUMN "embedding" TYPE vector(768)
USING CASE
  WHEN "embedding" IS NULL THEN NULL
  ELSE "embedding"::vector(768)
END;

-- Build ANN index for cosine similarity lookup on scored feedback.
-- `lists=100` is a conservative default; tune after observing recall/latency in production.
CREATE INDEX IF NOT EXISTS "GenerationFeedback_embedding_ivfflat_cosine_idx"
ON "GenerationFeedback" USING ivfflat ("embedding" vector_cosine_ops)
WITH (lists = 100)
WHERE "embedding" IS NOT NULL
  AND "score" IN (1, -1);

ANALYZE "GenerationFeedback";
