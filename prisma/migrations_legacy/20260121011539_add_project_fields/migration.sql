-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "analysisResult" JSONB,
ADD COLUMN     "aspectRatio" TEXT NOT NULL DEFAULT '16:9',
ADD COLUMN     "audioDuration" INTEGER,
ADD COLUMN     "audioUrl" VARCHAR(500),
ADD COLUMN     "colorPalette" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "lyrics" TEXT,
ADD COLUMN     "thumbnailUrl" VARCHAR(500),
ADD COLUMN     "videoUrl" VARCHAR(500),
ADD COLUMN     "visualStyle" VARCHAR(100);
