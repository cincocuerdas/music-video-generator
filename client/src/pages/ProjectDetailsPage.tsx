import React, { lazy, Suspense, useEffect, useState, useRef } from 'react';
import { projectService } from '../services/api';
import type { Project, Job } from '../types';
import { useParams, Link } from 'react-router-dom';
import { sileo } from 'sileo';
import { ArrowLeft, Loader2, CheckCircle, XCircle, Clock, Video, PartyPopper } from 'lucide-react';
import { useProjectSocket } from '../hooks';
import { FeedbackButtons } from '../components/FeedbackButtons';
import { LazySettingsToggle } from '../components/LazySettingsToggle';

const CinematicLoader = lazy(() =>
    import('../components/CinematicLoader').then((m) => ({ default: m.CinematicLoader })),
);
const ProcessingScreen = lazy(() =>
    import('../components/ProcessingScreen').then((m) => ({ default: m.ProcessingScreen })),
);
const ResultScreen = lazy(() =>
    import('../components/ResultScreen').then((m) => ({ default: m.ResultScreen })),
);

const PIPELINE_JOB_TYPES = [
    'YOUTUBE_DOWNLOAD',
    'TRANSCRIPTION',
    'ANALYZE_LYRICS',
    'GENERATE_IMAGES',
    'RENDER_VIDEO',
    'FINALIZE',
] as const;

function normalizeJobStatus(status?: string): 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' {
    const normalized = (status || '').trim().toUpperCase();
    if (normalized === 'PROCESSING') return 'PROCESSING';
    if (normalized === 'COMPLETED') return 'COMPLETED';
    if (normalized === 'FAILED') return 'FAILED';
    return 'PENDING';
}

export const ProjectDetailsPage: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const [project, setProject] = useState<Project | null>(null);
    const [loading, setLoading] = useState(true);
    const [justCompleted, setJustCompleted] = useState(false);
    const [download, setDownload] = useState<{ isDownloading: boolean }>({ isDownloading: false });
    const videoRef = useRef<HTMLDivElement>(null);
    const prevStatusRef = useRef<string | null>(null);

    const { images: liveImages, jobUpdate, isConnected, videoUrl } = useProjectSocket({
        projectId: id || '',
        enabled: !!id && project?.status === 'PROCESSING',
    });

    useEffect(() => {
        const newStatus = project?.status || null;
        if (prevStatusRef.current === 'PROCESSING' && newStatus === 'COMPLETED') {
            setJustCompleted(true);
            videoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        prevStatusRef.current = newStatus;
    }, [project?.status]);

    useEffect(() => {
        if (!justCompleted) return;
        const timer = setTimeout(() => setJustCompleted(false), 5000);
        return () => clearTimeout(timer);
    }, [justCompleted]);

    useEffect(() => {
        if (!id) return;

        // Initial fetch is always required to bootstrap page state.
        loadProject();
    }, [id]);

    useEffect(() => {
        if (!id || !project || project.status !== 'PROCESSING') return;

        // Keep polling as safety net even when socket is connected.
        // This prevents UI drift if websocket events are dropped.
        const interval = setInterval(() => {
            loadProject(false);
        }, 3000);

        return () => clearInterval(interval);
    }, [id, project?.status]);

    useEffect(() => {
        if (!id || !isConnected) return;
        // Re-sync once after connection recovery to avoid state drift.
        loadProject(false);
    }, [id, isConnected]);

    useEffect(() => {
        if (!jobUpdate) return;

        const normalizedStatus = normalizeJobStatus(jobUpdate.status);
        const normalizedType = (jobUpdate.jobType || '').trim().toUpperCase();
        if (!PIPELINE_JOB_TYPES.includes(normalizedType as (typeof PIPELINE_JOB_TYPES)[number])) {
            return;
        }

        setProject((prev) => {
            if (!prev) return prev;
            if ((prev.status === 'COMPLETED' || prev.status === 'FAILED') && normalizedStatus !== 'FAILED') {
                return prev;
            }

            const prevJobs = prev.jobs || [];
            let matched = false;
            const mergedJobs = prevJobs.map((job) => {
                if (job.type !== normalizedType) return job;
                matched = true;
                return {
                    ...job,
                    status: normalizedStatus,
                    progress: typeof jobUpdate.progress === 'number' ? jobUpdate.progress : job.progress,
                };
            });

            if (!matched) {
                mergedJobs.push({
                    id: `live-${normalizedType}`,
                    type: normalizedType as Job['type'],
                    status: normalizedStatus,
                    progress: typeof jobUpdate.progress === 'number' ? jobUpdate.progress : 0,
                });
            }

            const hasFailed = mergedJobs.some((job) => job.status === 'FAILED');
            const isAnyProcessing = mergedJobs.some((job) => job.status === 'PROCESSING');
            const isAllCompleted =
                PIPELINE_JOB_TYPES.every((type) =>
                    mergedJobs.some((job) => job.type === type && job.status === 'COMPLETED'),
                ) && mergedJobs.length >= PIPELINE_JOB_TYPES.length;

            const status = hasFailed
                ? 'FAILED'
                : isAllCompleted
                    ? 'COMPLETED'
                    : isAnyProcessing
                        ? 'PROCESSING'
                        : prev.status;

            return {
                ...prev,
                status,
                jobs: mergedJobs,
            };
        });
    }, [jobUpdate]);

    useEffect(() => {
        if (!videoUrl) return;
        setProject((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                status: 'COMPLETED',
                videoUrl,
            };
        });
    }, [videoUrl]);

    const loadProject = async (showLoading = true) => {
        try {
            if (showLoading) setLoading(true);
            const data = await projectService.getOne(id!);
            setProject(data);
        } catch (error) {
            console.error('Failed to load project', error);
            if (showLoading) {
                sileo.error({
                    title: 'Could not load project',
                    description: 'Please refresh and try again.',
                });
            }
        } finally {
            if (showLoading) setLoading(false);
        }
    };

    const handleDownload = async () => {
        if (!project?.videoUrl || download.isDownloading) return;
        setDownload({ isDownloading: true });
        try {
            const response = await fetch(project.videoUrl);
            if (!response.ok) throw new Error('Network response was not ok');
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${project.title || 'video'}.mp4`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            setDownload({ isDownloading: false });
            sileo.success({
                title: 'Download started',
                description: 'Your video file is being downloaded.',
            });
        } catch (error) {
            console.error('Download failed:', error);
            setDownload({ isDownloading: false });
            sileo.error({
                title: 'Download failed',
                description: 'Please try again in a moment.',
            });
        }
    };

    const getStatusMessage = (): string => {
        const failedJob = project?.jobs?.find(j => j.status === 'FAILED');
        if (failedJob) return `Error: ${failedJob.type.replace('_', ' ').toLowerCase()} failed`;

        const processingJob = project?.jobs?.find(j => j.status === 'PROCESSING');
        if (processingJob) {
            const stepNames: Record<string, string> = {
                'YOUTUBE_DOWNLOAD': 'Downloading audio...',
                'TRANSCRIPTION': 'Transcribing lyrics...',
                'ANALYZE_LYRICS': 'Analyzing with AI...',
                'GENERATE_IMAGES': `Generating scene ${liveImages.length + 1}...`,
                'RENDER_VIDEO': 'Rendering video...',
                'FINALIZE': 'Finalizing...'
            };
            return stepNames[processingJob.type] || 'Processing...';
        }
        return 'Preparing...';
    };

    const hasError = project?.jobs?.some(j => j.status === 'FAILED');

    const getJobIcon = (status: string) => {
        switch (status) {
            case 'COMPLETED': return <CheckCircle className="text-emerald-500" size={18} />;
            case 'FAILED': return <XCircle className="text-rose-500" size={18} />;
            case 'PROCESSING': return <Loader2 className="animate-spin text-stitch-cyan" size={18} />;
            default: return <Clock className="text-gray-600" size={18} />;
        }
    };

    const displayImages = liveImages.length > 0 ? liveImages : (project?.analysisResult?.generatedImages || [])
        .map((img: any, idx: number) => ({ img, idx }))
        .filter(({ img }) => {
            if (!img?.imageUrl) return false;
            if (img?.exposed === false) return false;
            if (typeof img?.status === 'string' && img.status !== 'success') return false;
            return true;
        })
        .map(({ img, idx }) => ({
            sceneIndex: typeof img.sceneIndex === 'number' ? img.sceneIndex : idx,
            totalScenes: (project?.analysisResult?.generatedImages || []).length,
            imageUrl: img.imageUrl,
            prompt: img.prompt,
        }));

    const pipelineProgress = React.useMemo(() => {
        const jobs = project?.jobs || [];
        if (jobs.length === 0) return 0;

        const mergedJobs = jobs.map((job) => {
            if (!jobUpdate || job.type !== jobUpdate.jobType) {
                return job;
            }

            return {
                ...job,
                status: (jobUpdate.status?.toUpperCase() as typeof job.status) || job.status,
                progress: typeof jobUpdate.progress === 'number' ? jobUpdate.progress : job.progress,
            };
        });

        const total = mergedJobs.reduce((sum, job) => {
            const value = Number.isFinite(job.progress) ? job.progress : 0;
            return sum + Math.max(0, Math.min(100, value));
        }, 0);

        return Math.round(total / mergedJobs.length);
    }, [project?.jobs, jobUpdate]);

    const isGeneratingImages = project?.status === 'PROCESSING' &&
        project?.jobs?.some(j => j.type === 'GENERATE_IMAGES' && j.status === 'PROCESSING');

    // Global Settings Toggle - always visible
    const settingsToggle = (
        <div className="fixed top-6 right-6 z-50">
            <LazySettingsToggle />
        </div>
    );

    if (loading) return (
        <>
            {settingsToggle}
            <div className="min-h-screen bg-stitch-bg flex items-center justify-center">
                <Loader2 className="animate-spin text-stitch-cyan" size={48} />
            </div>
        </>
    );

    if (!project) return (
        <>
            {settingsToggle}
            <div className="min-h-screen bg-stitch-bg flex items-center justify-center text-gray-500">Project not found</div>
        </>
    );

    // Show full-screen processing view only while no job has failed.
    if (project.status === 'PROCESSING' && !hasError) {
        return (
            <>
                {settingsToggle}
                <Suspense fallback={<div className="min-h-screen bg-stitch-bg flex items-center justify-center"><Loader2 className="animate-spin text-stitch-cyan" size={48} /></div>}>
                    <ProcessingScreen
                        projectTitle={project.title}
                        jobs={project.jobs || []}
                        currentProgress={pipelineProgress}
                        statusMessage={getStatusMessage()}
                        isConnected={isConnected}
                        currentPreview={liveImages[liveImages.length - 1]?.imageUrl}
                        sceneInfo={liveImages.length > 0 ? {
                            current: liveImages[liveImages.length - 1]?.sceneIndex + 1 || 1,
                            total: liveImages[liveImages.length - 1]?.totalScenes || 0
                        } : undefined}
                    />
                </Suspense>
            </>
        );
    }

    // Show result screen when project is completed
    if (project.status === 'COMPLETED') {
        return (
            <>
                {settingsToggle}
                <Suspense fallback={<div className="min-h-screen bg-stitch-bg flex items-center justify-center"><Loader2 className="animate-spin text-stitch-cyan" size={48} /></div>}>
                    <ResultScreen
                        project={project}
                        onDownload={handleDownload}
                        isDownloading={download.isDownloading}
                    />
                </Suspense>
            </>
        );
    }

    // Fallback view for DRAFT or FAILED status
    return (
        <div className="min-h-screen bg-stitch-bg text-white p-12">
            <div className="max-w-6xl mx-auto animate-stitch-in">
                <Link to="/" className="inline-flex items-center text-gray-500 hover:text-stitch-cyan mb-12 transition-colors font-medium">
                    <ArrowLeft size={18} className="mr-2" />
                    Back to Projects
                </Link>

                <div className="grid grid-cols-1 lg:grid-cols-4 gap-12">
                    <div className="lg:col-span-3 space-y-12">
                        {justCompleted && (
                            <div className="glass-stitch bg-emerald-500/10 border-emerald-500/20 rounded-2xl p-6 flex items-center gap-4 animate-stitch-in">
                                <PartyPopper className="text-emerald-400" size={24} />
                                <span className="text-emerald-400 font-bold uppercase tracking-widest text-xs">Video Complete</span>
                            </div>
                        )}

                        <div ref={videoRef} className="glass-stitch rounded-3xl overflow-hidden shadow-2xl animate-stitch-in">
                            <div className="aspect-video bg-black flex items-center justify-center relative group">
                                {hasError ? (
                                    <div className="text-center p-12">
                                        <XCircle className="text-rose-500 mx-auto mb-6 opacity-50" size={64} />
                                        <p className="text-rose-500 font-bold uppercase tracking-widest text-xs mb-2">Failure</p>
                                        <p className="text-gray-500 text-sm max-w-xs mx-auto">{getStatusMessage()}</p>
                                    </div>
                                ) : (
                                    <Suspense fallback={<div className="w-full h-full flex items-center justify-center"><Loader2 className="animate-spin text-stitch-cyan" size={24} /></div>}>
                                        <CinematicLoader
                                            progress={0}
                                            statusMessage={project.status === 'DRAFT' ? 'READY TO PROCESS' : 'PREPARING...'}
                                            isExposing={false}
                                            coverImage={project.thumbnailUrl}
                                        />
                                    </Suspense>
                                )}
                            </div>
                            <div className="p-10 border-t border-stitch-border/30">
                                <div className="flex items-start justify-between">
                                    <div className="space-y-3">
                                        <h1 className="text-3xl font-extrabold tracking-tight">{project.title}</h1>
                                        <div className="flex items-center gap-4">
                                            <a
                                                href={project.youtubeUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-gray-500 hover:text-stitch-cyan text-xs font-bold uppercase tracking-widest flex items-center gap-2 transition-colors"
                                            >
                                                <Video size={14} /> YouTube Source
                                            </a>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {displayImages.length > 0 && (
                            <div className="space-y-8 animate-stitch-in">
                                <div className="flex items-center justify-between">
                                    <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-gray-500">
                                        Generated Scenes ({displayImages.length})
                                    </h2>
                                    {isGeneratingImages && (
                                        <span className="text-[10px] font-bold text-stitch-cyan animate-pulse tracking-widest uppercase">
                                            Synthesizing stage {liveImages.length + 1}...
                                        </span>
                                    )}
                                </div>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                                    {displayImages.map((img: any, idx: number) => (
                                        <div
                                            key={img.sceneIndex ?? `img-${idx}`}
                                            className="glass-stitch rounded-2xl overflow-hidden relative group aspect-video"
                                        >
                                            <img
                                                src={img.imageUrl}
                                                alt={`Scene ${img.sceneIndex + 1}`}
                                                className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-all duration-500 group-hover:scale-110"
                                                loading="lazy"
                                            />
                                            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-4">
                                                <p className="text-[10px] text-gray-400 font-medium line-clamp-2 mb-2 italic">"{img.prompt}"</p>
                                                <FeedbackButtons
                                                    projectId={project.id}
                                                    currentPrompt={img.prompt || ''}
                                                    sceneIndex={img.sceneIndex}
                                                    style={project.visualStyle}
                                                    variant="inline"
                                                />
                                            </div>
                                            <span className="absolute top-2 left-2 bg-black/60 backdrop-blur-md text-[10px] font-bold text-white px-2 py-1 rounded-lg">
                                                {String(img.sceneIndex + 1).padStart(2, '0')}
                                            </span>
                                        </div>
                                    ))}
                                    {isGeneratingImages && (
                                        <div className="aspect-video glass-stitch rounded-2xl flex items-center justify-center">
                                            <Loader2 className="animate-spin text-stitch-border/50" size={24} />
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="space-y-8">
                        <div className="glass-stitch rounded-3xl p-8 space-y-8 sticky top-12">
                            <div className="space-y-1">
                                <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-gray-500 mb-6">Pipeline Logic</h2>
                                <div className="space-y-3">
                                    {['YOUTUBE_DOWNLOAD', 'TRANSCRIPTION', 'ANALYZE_LYRICS', 'GENERATE_IMAGES', 'RENDER_VIDEO', 'FINALIZE'].map((type) => {
                                        const job = project.jobs?.find(j => j.type === type);
                                        const status = job?.status || 'PENDING';
                                        return (
                                            <div key={type} className="flex items-center justify-between px-4 py-3 rounded-2xl bg-white/5 border border-white/5 group hover:bg-white/10 transition-colors">
                                                <span className={`text-[10px] font-bold uppercase tracking-widest ${status === 'PROCESSING' ? 'text-stitch-cyan' : 'text-gray-500 group-hover:text-gray-300'}`}>
                                                    {type.split('_').join(' ')}
                                                </span>
                                                {getJobIcon(status)}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="pt-6">
                                <span className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest ${isConnected ? 'text-emerald-500' : 'text-gray-600'}`}>
                                    <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-gray-700'}`} />
                                    {isConnected ? 'Stream Active' : 'Offline'}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
