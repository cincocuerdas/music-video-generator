import React, { useMemo } from 'react';

interface LyricSegment {
    text: string;
    start: number;
    end: number;
}

const EMPTY_LYRICS: LyricSegment[] = [];

interface LyricWaveformTrackProps {
    totalDuration: number;
    currentTime: number;
    zoomLevel: number; // pixelsPerSecond
    lyrics?: LyricSegment[];
    onSeek?: (time: number) => void;
}

export const LyricWaveformTrack: React.FC<LyricWaveformTrackProps> = ({
    totalDuration,
    currentTime,
    zoomLevel,
    lyrics = EMPTY_LYRICS,
    onSeek
}) => {

    // Generate aesthetic waveform bars (memoized for performance)
    const waveformBars = useMemo(() => {
        const bars = Math.floor((totalDuration * zoomLevel) / 3);
        return Array.from({ length: Math.max(bars, 50) }, (_, i) => {
            // Generate pseudo-random but consistent heights
            const seed = Math.sin(i * 12.9898) * 43758.5453;
            const height = 20 + Math.abs((seed % 1) * 80);
            return { id: `wb-${i}`, height };
        });
    }, [totalDuration, zoomLevel]);

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!onSeek) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const time = x / zoomLevel;
        onSeek(Math.max(0, Math.min(totalDuration, time)));
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (!onSeek) return;
        if (e.key === 'ArrowRight') onSeek(Math.min(totalDuration, currentTime + 5));
        if (e.key === 'ArrowLeft') onSeek(Math.max(0, currentTime - 5));
    };

    return (
        <div
            role="slider"
            aria-label="Lyric timeline"
            aria-valuenow={Math.round(currentTime)}
            aria-valuemin={0}
            aria-valuemax={Math.round(totalDuration)}
            tabIndex={0}
            className="relative h-16 bg-[#0a0a0c] border-t border-white/5 overflow-hidden select-none cursor-pointer"
            style={{ width: `${totalDuration * zoomLevel}px`, minWidth: '100%' }}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
        >

            {/* Audio Waveform Background */}
            <div className="absolute inset-0 px-2 py-2 flex items-end gap-[1px]">
                {waveformBars.map(({ id, height }, barIdx) => {
                    const barTime = (barIdx / waveformBars.length) * totalDuration;
                    const isPast = barTime <= currentTime;
                    return (
                        <div
                            key={id}
                            className={`w-[2px] rounded-t-sm transition-colors duration-100 ${isPast ? 'bg-stitch-cyan/60' : 'bg-gray-700/50'
                                }`}
                            style={{ height: `${height}%` }}
                        />
                    );
                })}
            </div>

            {/* Lyric Segments Overlay */}
            {lyrics.map((segment) => {
                const left = segment.start * zoomLevel;
                const width = Math.max((segment.end - segment.start) * zoomLevel, 40);
                const isActive = currentTime >= segment.start && currentTime <= segment.end;

                return (
                    <div
                        key={`segment-${segment.start}-${segment.end}`}
                        className={`absolute top-2 bottom-2 rounded-md border flex items-center justify-center px-2 text-[10px] font-bold transition-all truncate
                            ${isActive
                                ? 'border-stitch-cyan bg-stitch-cyan/20 text-white z-10 shadow-[0_0_10px_rgba(56,130,250,0.5)]'
                                : 'border-gray-700/50 bg-black/40 text-gray-500 hover:border-gray-500 hover:text-gray-300'}
                        `}
                        style={{ left: `${left}px`, width: `${width}px` }}
                    >
                        <span className="truncate">{segment.text}</span>
                    </div>
                );
            })}

            {/* Playhead Line */}
            <div
                className="absolute top-0 bottom-0 w-[2px] bg-rose-500 z-50 pointer-events-none transition-[left] duration-100"
                style={{ left: `${currentTime * zoomLevel}px` }}
            >
                {/* Playhead Handle */}
                <div className="w-3 h-3 bg-rose-500 rounded-full -ml-[5px] -mt-1 shadow-lg" />
            </div>

            {/* Time markers */}
            <div className="absolute bottom-0 left-0 right-0 h-4 flex items-end pointer-events-none">
                {Array.from({ length: Math.ceil(totalDuration / 5) }, (_, i) => i * 5).map((seconds) => (
                    <div
                        key={`tm-${seconds}`}
                        className="absolute text-[8px] font-mono text-gray-600"
                        style={{ left: `${seconds * zoomLevel}px` }}
                    >
                        {seconds}s
                    </div>
                ))}
            </div>
        </div>
    );
};
