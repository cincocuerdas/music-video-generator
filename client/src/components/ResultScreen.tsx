import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ChevronLeft, Share2, Download, Settings2, Loader2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { Project } from '../types';
import { ShareModal } from './ShareModal';
import { useLanguage } from '../contexts/LanguageContext';
import { VideoPlayer, SceneGallery, VideoDetailsSidebar } from './result';
import type { VideoPlayerHandle, Scene } from './result';

interface ResultScreenProps {
    project: Project;
    onDownload: () => void;
    isDownloading?: boolean;
}

type PipelineOutcome = 'success' | 'degraded' | 'failed';

export const ResultScreen: React.FC<ResultScreenProps> = ({ project, onDownload, isDownloading = false }) => {
    const navigate = useNavigate();
    const { t } = useLanguage();
    const playerRef = useRef<VideoPlayerHandle>(null);
    const [activeSceneId, setActiveSceneId] = useState<string>('0');
    const [shareModalOpen, setShareModalOpen] = useState(false);
    const [videoDuration, setVideoDuration] = useState(0);

    const isRealVerse = (text?: string): boolean => {
        if (!text) return false;
        const words = text.toLowerCase().trim().split(/\s+/).filter(Boolean);
        if (words.length < 4) return false;
        const hookPatterns = [
            'whoa', 'yeah', 'oh', 'la', 'na', 'da', 'ooh', 'ahh', 'uuu', 'mmm', 'hey', 'uh',
            'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
        ];
        const hookWordCount = words.filter((w) => hookPatterns.some((h) => w.includes(h))).length;
        return hookWordCount <= words.length * 0.5;
    };

    // Mirror scripts/render_video.py timeline logic so scene thumbnails match actual video time.
    const scenes: Scene[] = useMemo(() => {
        const generatedImages = project.analysisResult?.generatedImages || [];
        const analysisScenes = project.analysisResult?.scenes || [];

        let firstRealVerseIdx = 0;
        let firstRealVerseStart: number | null = null;
        if (analysisScenes.length > 0) {
            for (let idx = 0; idx < analysisScenes.length; idx += 1) {
                const verseText = analysisScenes[idx]?.verseText || '';
                if (isRealVerse(verseText)) {
                    firstRealVerseIdx = idx;
                    const start = Number(analysisScenes[idx]?.startTime ?? 0);
                    firstRealVerseStart = Number.isFinite(start) ? start : 0;
                    break;
                }
            }
        }

        let introDuration = 5;
        if (analysisScenes.length > 0) {
            if (firstRealVerseStart !== null && firstRealVerseStart > 0) {
                introDuration = firstRealVerseStart;
            } else {
                const firstSceneStart = Number(analysisScenes[0]?.startTime ?? 0);
                introDuration = firstSceneStart > 0 ? firstSceneStart : 10;
            }
        }

        let hasExposedPostVerse = false;
        for (let idx = firstRealVerseIdx; idx < generatedImages.length; idx += 1) {
            const img = generatedImages[idx];
            if (!img) continue;
            if (img.exposed === false) continue;
            if (img.status === 'success' && img.imageUrl) {
                hasExposedPostVerse = true;
                break;
            }
        }
        const allowUnexposedFallback = !hasExposedPostVerse;

        let runningTimestamp = introDuration;
        let lastValidThumbnail: string | null = null;
        let lastValidPrompt = '';
        const timelineScenes: Scene[] = [];
        const totalSceneCount = Math.max(analysisScenes.length, generatedImages.length);

        for (let idx = firstRealVerseIdx; idx < totalSceneCount; idx += 1) {
            const img = generatedImages[idx];
            const rawDuration = Number(analysisScenes[idx]?.duration ?? 5);
            const sceneDuration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 5;

            let canUseImage = true;
            if (img?.exposed === false && !allowUnexposedFallback) {
                canUseImage = false;
            } else if (img && typeof img.status === 'string' && img.status !== 'success' && !img.imageUrl) {
                canUseImage = false;
            }

            let thumbnail: string | null = null;
            let prompt = '';
            let isFallback = false;

            if (canUseImage && img?.imageUrl) {
                thumbnail = img.imageUrl;
                prompt = img.prompt || analysisScenes[idx]?.visualPrompt || '';
                isFallback = Boolean(
                    img?.isFallback === true ||
                    img?.provider === 'mock' ||
                    String(img?.imageUrl || '').includes('placehold.co'),
                );
                lastValidThumbnail = thumbnail;
                lastValidPrompt = prompt;
            } else if (lastValidThumbnail) {
                thumbnail = lastValidThumbnail;
                prompt = lastValidPrompt || analysisScenes[idx]?.visualPrompt || '';
                isFallback = true;
            }

            if (thumbnail) {
                const boundedTimestamp =
                    videoDuration > 0
                        ? Math.min(runningTimestamp, Math.max(videoDuration - 0.1, 0))
                        : runningTimestamp;
                timelineScenes.push({
                    id: `slot-${idx}`,
                    sceneIndex: typeof img?.sceneIndex === 'number' ? img.sceneIndex : idx,
                    timestamp: boundedTimestamp,
                    duration: sceneDuration,
                    label: `Scene ${idx + 1}`,
                    prompt,
                    thumbnail,
                    isFallback,
                });
            }

            runningTimestamp += sceneDuration;
        }

        return timelineScenes;
    }, [project.analysisResult, videoDuration]);

    // Initialize first scene
    useEffect(() => {
        if (scenes.length === 0) return;
        if (!scenes.some((s) => s.id === activeSceneId)) {
            setActiveSceneId(scenes[0].id);
        }
    }, [scenes, activeSceneId]);

    // Auto-detect scene from video time
    const handleTimeUpdate = useCallback((time: number) => {
        const currentScene = [...scenes].reverse().find(s => time >= s.timestamp);
        if (currentScene && currentScene.id !== activeSceneId) {
            setActiveSceneId(currentScene.id);
        }
    }, [scenes, activeSceneId]);

    const jumpToScene = useCallback((scene: Scene) => {
        const totalDuration = playerRef.current?.getDuration() || videoDuration;
        const boundedTime =
            totalDuration > 0
                ? Math.min(Math.max(scene.timestamp, 0), Math.max(totalDuration - 0.1, 0))
                : scene.timestamp;
        playerRef.current?.seekTo(boundedTime);
        setActiveSceneId(scene.id);
    }, [videoDuration]);

    const activeScene = scenes.find(s => s.id === activeSceneId);

    const pipelineOutcome = useMemo<PipelineOutcome>(() => {
        const failedJob = project.jobs?.some((job) => job.status === 'FAILED');
        if (failedJob || !project.videoUrl) return 'failed';
        const analysisStatus = project.analysisResult?.status;
        if (analysisStatus === 'failed') return 'failed';
        if (analysisStatus === 'degraded') return 'degraded';
        const hasDegradedFlag = project.analysisResult?.degraded === true;
        const hasDegradedReasons = (project.analysisResult?.degradedReasons || []).length > 0;
        const hasFallbackImages = (project.analysisResult?.generatedImages || []).some((img) =>
            img?.isFallback === true ||
            img?.provider === 'mock' ||
            String(img?.imageUrl || '').includes('placehold.co')
        );
        if (hasDegradedFlag || hasDegradedReasons || hasFallbackImages) return 'degraded';
        return 'success';
    }, [project.videoUrl, project.analysisResult, project.jobs]);

    const outcomeMeta: Record<PipelineOutcome, { badge: string; badgeClass: string; panelClass: string; title: string; message: string }> = {
        success: {
            badge: 'Success',
            badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
            panelClass: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300',
            title: t('result.outcomeSuccessTitle'),
            message: t('result.outcomeSuccessMessage'),
        },
        degraded: {
            badge: 'Degraded',
            badgeClass: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
            panelClass: 'bg-amber-500/10 border-amber-500/20 text-amber-300',
            title: t('result.outcomeDegradedTitle'),
            message: t('result.outcomeDegradedMessage'),
        },
        failed: {
            badge: 'Failed',
            badgeClass: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
            panelClass: 'bg-rose-500/10 border-rose-500/20 text-rose-300',
            title: t('result.outcomeFailedTitle'),
            message: t('result.outcomeFailedMessage'),
        },
    };

    const progressFillClass: Record<PipelineOutcome, string> = {
        success: 'bg-emerald-400',
        degraded: 'bg-amber-400',
        failed: 'bg-rose-500',
    };

    return (
        <div className="min-h-screen bg-stitch-bg text-white font-sans flex flex-col p-4 md:p-6 overflow-hidden">

            {/* HEADER */}
            <header className="flex justify-between items-center mb-6 pb-4 border-b border-stitch-border/30">
                <div className="flex items-center gap-4">
                    <Link
                        to="/"
                        className="flex items-center gap-2 text-gray-400 hover:text-white transition text-sm font-medium"
                    >
                        <ChevronLeft size={16} /> Projects
                    </Link>
                    <div className="h-4 w-px bg-stitch-border/50" />
                    <h1 className="font-bold text-base md:text-lg text-white truncate max-w-[200px] md:max-w-none">
                        {project.title}
                    </h1>
                    <span className="bg-emerald-500/10 text-emerald-400 text-[9px] font-bold px-2 py-0.5 rounded border border-emerald-500/20 tracking-wider uppercase">
                        Completed
                    </span>
                    <span className={`text-[9px] font-bold px-2 py-0.5 rounded border tracking-wider uppercase ${outcomeMeta[pipelineOutcome].badgeClass}`}>
                        {outcomeMeta[pipelineOutcome].badge}
                    </span>
                </div>

                <div className="flex gap-2 md:gap-3">
                    <button
                        onClick={() => navigate(`/project/${project.id}/director`)}
                        className="flex items-center gap-2 px-3 md:px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 hover:border-stitch-cyan text-sm font-medium transition border border-white/10 group"
                    >
                        <Settings2 size={16} className="group-hover:rotate-180 transition-transform duration-500" />
                        <span className="hidden sm:inline">Director</span>
                    </button>
                    <button
                        onClick={() => setShareModalOpen(true)}
                        className="flex items-center gap-2 px-3 md:px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-sm font-medium transition border border-white/10"
                    >
                        <Share2 size={16} />
                        <span className="hidden sm:inline">Share</span>
                    </button>
                    <button
                        onClick={onDownload}
                        disabled={isDownloading}
                        className="flex items-center gap-2 px-3 md:px-4 py-2 rounded-lg bg-stitch-cyan hover:bg-stitch-cyan/80 disabled:opacity-60 text-black text-sm font-bold shadow-lg shadow-stitch-cyan/20 transition"
                    >
                        {isDownloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                        <span className="hidden sm:inline">{isDownloading ? 'Downloading...' : 'Download'}</span>
                    </button>
                </div>
            </header>

            <div className={`mb-4 rounded-xl border px-4 py-3 ${outcomeMeta[pipelineOutcome].panelClass}`}>
                <p className="text-xs font-bold uppercase tracking-wider mb-1">
                    {outcomeMeta[pipelineOutcome].title}
                </p>
                <p className="text-sm opacity-90">
                    {outcomeMeta[pipelineOutcome].message}
                </p>
            </div>

            {/* MAIN LAYOUT */}
            <div className="flex-1 flex flex-col lg:flex-row gap-6 overflow-hidden">

                {/* LEFT COLUMN: Player & Scenes */}
                <div className="flex-[3] flex flex-col gap-6 overflow-y-auto pr-0 lg:pr-2">
                    <VideoPlayer
                        ref={playerRef}
                        videoUrl={project.videoUrl}
                        progressFillClass={progressFillClass[pipelineOutcome]}
                        onTimeUpdate={handleTimeUpdate}
                        onDurationChange={setVideoDuration}
                    />
                    <SceneGallery
                        scenes={scenes}
                        activeSceneId={activeSceneId}
                        onSceneClick={jumpToScene}
                    />
                </div>

                {/* RIGHT COLUMN: Details & Feedback */}
                <VideoDetailsSidebar
                    project={project}
                    duration={videoDuration}
                    scenes={scenes}
                    activeScene={activeScene}
                />
            </div>

            {/* Share Modal */}
            <ShareModal
                isOpen={shareModalOpen}
                onClose={() => setShareModalOpen(false)}
                projectId={project.id}
                projectTitle={project.title}
                videoUrl={project.videoUrl}
            />
        </div>
    );
};
