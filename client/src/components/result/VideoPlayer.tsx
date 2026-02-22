import { useRef, useReducer, useEffect, forwardRef, useImperativeHandle } from 'react';
import { m } from 'framer-motion';
import {
    Play, Pause, SkipBack, SkipForward,
    Volume2, VolumeX, Maximize
} from 'lucide-react';

type VideoState = { isPlaying: boolean; currentTime: number; duration: number; isMuted: boolean };
type VideoAction =
    | { type: 'PLAY' } | { type: 'PAUSE' } | { type: 'TOGGLE_PLAY' }
    | { type: 'SET_TIME'; time: number }
    | { type: 'SET_DURATION'; duration: number }
    | { type: 'TOGGLE_MUTE' }
    | { type: 'SEEK'; time: number };

function videoReducer(state: VideoState, action: VideoAction): VideoState {
    switch (action.type) {
        case 'PLAY': return { ...state, isPlaying: true };
        case 'PAUSE': return { ...state, isPlaying: false };
        case 'TOGGLE_PLAY': return { ...state, isPlaying: !state.isPlaying };
        case 'SET_TIME': return { ...state, currentTime: action.time };
        case 'SET_DURATION': return { ...state, duration: action.duration };
        case 'TOGGLE_MUTE': return { ...state, isMuted: !state.isMuted };
        case 'SEEK': return { ...state, currentTime: action.time };
    }
}

function formatTime(time: number) {
    const min = Math.floor(time / 60);
    const sec = Math.floor(time % 60);
    return `${min}:${sec < 10 ? '0' + sec : sec}`;
}

export interface VideoPlayerHandle {
    getCurrentTime: () => number;
    getDuration: () => number;
    seekTo: (time: number) => void;
    play: () => void;
}

interface VideoPlayerProps {
    videoUrl?: string;
    progressFillClass: string;
    onTimeUpdate?: (time: number) => void;
    onDurationChange?: (duration: number) => void;
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(({
    videoUrl,
    progressFillClass,
    onTimeUpdate,
    onDurationChange,
}, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [{ isPlaying, currentTime, duration, isMuted }, dispatch] = useReducer(videoReducer, {
        isPlaying: false, currentTime: 0, duration: 0, isMuted: false,
    });

    useImperativeHandle(ref, () => ({
        getCurrentTime: () => currentTime,
        getDuration: () => duration,
        seekTo: (time: number) => {
            if (videoRef.current) {
                videoRef.current.currentTime = time;
                videoRef.current.play();
                dispatch({ type: 'PLAY' });
            }
        },
        play: () => {
            videoRef.current?.play();
            dispatch({ type: 'PLAY' });
        },
    }));

    useEffect(() => {
        onDurationChange?.(duration);
    }, [duration, onDurationChange]);

    const togglePlay = () => {
        if (!videoRef.current) return;
        if (isPlaying) videoRef.current.pause();
        else videoRef.current.play();
        dispatch({ type: 'TOGGLE_PLAY' });
    };

    const handleTimeUpdate = () => {
        if (!videoRef.current) return;
        const time = videoRef.current.currentTime;
        dispatch({ type: 'SET_TIME', time });
        onTimeUpdate?.(time);
    };

    const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!videoRef.current || duration === 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        const newTime = percent * duration;
        videoRef.current.currentTime = newTime;
        dispatch({ type: 'SEEK', time: newTime });
    };

    const handleSeekKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (!videoRef.current || duration === 0) return;
        if (e.key === 'ArrowRight') {
            const t = Math.min(currentTime + 5, duration);
            videoRef.current.currentTime = t;
            dispatch({ type: 'SEEK', time: t });
        } else if (e.key === 'ArrowLeft') {
            const t = Math.max(currentTime - 5, 0);
            videoRef.current.currentTime = t;
            dispatch({ type: 'SEEK', time: t });
        }
    };

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

    return (
        <m.div
            layoutId="shared-video-player"
            className="relative aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl border border-stitch-border/30 group"
        >
            {videoUrl ? (
                <video
                    ref={videoRef}
                    src={videoUrl}
                    className="w-full h-full object-contain"
                    onClick={togglePlay}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={() => videoRef.current && dispatch({ type: 'SET_DURATION', duration: videoRef.current.duration })}
                    onPlay={() => dispatch({ type: 'PLAY' })}
                    onPause={() => dispatch({ type: 'PAUSE' })}
                    muted={isMuted}
                />
            ) : (
                <div className="w-full h-full flex items-center justify-center">
                    <p className="text-gray-500">Video not available</p>
                </div>
            )}

            {/* Play Overlay */}
            <div className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity duration-300 ${isPlaying ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}>
                <button
                    onClick={togglePlay}
                    className="w-16 h-16 md:w-20 md:h-20 bg-white/10 backdrop-blur-sm rounded-full flex items-center justify-center hover:bg-white/20 transition hover:scale-105"
                >
                    {isPlaying ? (
                        <Pause size={32} fill="white" className="text-white" />
                    ) : (
                        <Play size={32} fill="white" className="text-white ml-1" />
                    )}
                </button>
            </div>

            {/* Bottom Controls Bar */}
            <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/90 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="flex items-center justify-between text-xs font-mono text-gray-300 mb-2">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                </div>

                <div
                    className="w-full h-1.5 bg-gray-600 rounded-full cursor-pointer overflow-hidden mb-3"
                    role="slider"
                    aria-label="Video progress"
                    aria-valuenow={Math.round(progress)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    tabIndex={0}
                    onClick={handleSeek}
                    onKeyDown={handleSeekKeyDown}
                >
                    <m.div
                        className={`h-full ${progressFillClass}`}
                        style={{ width: `${progress}%` }}
                        transition={{ duration: 0.1 }}
                    />
                </div>

                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <button onClick={togglePlay} className="text-white hover:text-stitch-cyan transition">
                            {isPlaying ? <Pause size={20} /> : <Play size={20} />}
                        </button>
                        <button
                            onClick={() => videoRef.current && (videoRef.current.currentTime -= 10)}
                            className="text-white/60 hover:text-white transition"
                        >
                            <SkipBack size={18} />
                        </button>
                        <button
                            onClick={() => videoRef.current && (videoRef.current.currentTime += 10)}
                            className="text-white/60 hover:text-white transition"
                        >
                            <SkipForward size={18} />
                        </button>
                    </div>
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => dispatch({ type: 'TOGGLE_MUTE' })}
                            className="text-white/60 hover:text-white transition"
                        >
                            {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                        </button>
                        <button
                            onClick={() => videoRef.current?.requestFullscreen()}
                            className="text-white/60 hover:text-white transition"
                        >
                            <Maximize size={18} />
                        </button>
                    </div>
                </div>
            </div>
        </m.div>
    );
});

VideoPlayer.displayName = 'VideoPlayer';
