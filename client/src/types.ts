export interface Project {
    id: string;
    title: string;
    status: 'DRAFT' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
    youtubeUrl: string;
    thumbnailUrl?: string;
    videoUrl?: string;
    visualStyle?: string;
    createdAt: string;
    jobs?: Job[];
    analysisResult?: AnalysisResult;
}

export interface GeneratedImage {
    sceneIndex: number;
    imageUrl: string;
    prompt: string;
    status: string;
    provider?: string;
    exposed?: boolean;
    isFallback?: boolean;
}

export interface AnalysisScene {
    verseText: string;
    visualPrompt: string;
    duration: number;
    startTime?: number;
}

export interface AnalysisResult {
    status?: 'success' | 'degraded' | 'failed';
    degraded?: boolean;
    degradedReasons?: string[];
    generatedImages?: GeneratedImage[];
    scenes?: AnalysisScene[];
}

export interface Job {
    id: string;
    type: 'YOUTUBE_DOWNLOAD' | 'TRANSCRIPTION' | 'ANALYZE_LYRICS' | 'GENERATE_IMAGES' | 'RENDER_VIDEO' | 'FINALIZE';
    status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
    progress: number;
}
