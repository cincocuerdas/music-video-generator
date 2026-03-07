/**
 * Typed output interfaces for each Python script in the pipeline.
 * These replace the `any` return type from PythonRunnerService.
 */

export interface LyricsAnalysisResult {
  scenes: Array<{
    text: string;
    startTime: number;
    endTime: number;
    mood: string;
    visualPrompt: string;
  }>;
  totalDuration: number;
  language?: string;
}

export interface YouTubeDownloadResult {
  audioPath: string;
  title?: string;
  duration?: number;
  thumbnailPath?: string;
}

export interface TranscriptionResult {
  text: string;
  segments: Array<{
    start: number;
    end: number;
    text: string;
  }>;
  language?: string;
  duration?: number;
}

export interface ImageGenerationResult {
  images: Array<{
    path: string;
    sceneIndex: number;
    prompt: string;
    seed?: number;
  }>;
  totalGenerated: number;
  failedCount?: number;
}

export interface VideoRenderResult {
  videoPath: string;
  duration: number;
  resolution?: string;
  fps?: number;
}

export interface TrainLoraResult {
  loraPath: string;
  loraFilename: string;
  epochs: number;
  loss?: number;
  likesCount?: number;
}

export interface PythonScriptRawOutput {
  rawOutput: string;
}

export interface PythonScriptNoOutput {
  message: string;
}

export type PythonScriptResult =
  | LyricsAnalysisResult
  | YouTubeDownloadResult
  | TranscriptionResult
  | ImageGenerationResult
  | VideoRenderResult
  | TrainLoraResult
  | PythonScriptRawOutput
  | PythonScriptNoOutput;
