-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding vector (768 dims) for feedback learning
ALTER TABLE "GenerationFeedback"
ADD COLUMN IF NOT EXISTS "embedding" vector(768);