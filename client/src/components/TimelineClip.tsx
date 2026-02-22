import React from 'react';

interface TimelineClipProps {
    scene: {
        id: string;
        thumbnail: string;
        label: string;
        duration: number;
    };
    isActive: boolean;
    onClick: () => void;
    pixelsPerSecond?: number;
}

export const TimelineClip: React.FC<TimelineClipProps> = ({
    scene,
    isActive,
    onClick,
    pixelsPerSecond = 10
}) => {
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}
            className={`relative h-16 rounded-md cursor-pointer transition-all border-2 overflow-hidden group flex-shrink-0
                ${isActive
                    ? 'border-stitch-cyan ring-2 ring-stitch-cyan/30 z-10'
                    : 'border-gray-700 hover:border-gray-500'
                }
            `}
            style={{ width: `${Math.max(scene.duration * pixelsPerSecond, 60)}px` }}
        >
            {/* Filmstrip Background Effect */}
            <div className="absolute inset-0 flex opacity-50 grayscale group-hover:grayscale-0 transition-all">
                {Array.from({ length: Math.ceil(scene.duration / 2) }, (_, i) => i).map((frameIdx) => (
                    <img
                        key={frameIdx}
                        src={scene.thumbnail}
                        alt=""
                        className="h-full object-cover flex-1"
                        draggable={false}
                    />
                ))}
            </div>

            {/* Gradient Overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />

            {/* Trim Handles (appear on hover) */}
            <div className="absolute left-0 top-0 bottom-0 w-2 bg-white/20 hover:bg-stitch-cyan cursor-ew-resize opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <div className="w-0.5 h-6 bg-white/50 rounded-full" />
            </div>
            <div className="absolute right-0 top-0 bottom-0 w-2 bg-white/20 hover:bg-stitch-cyan cursor-ew-resize opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <div className="w-0.5 h-6 bg-white/50 rounded-full" />
            </div>

            {/* Scene Label */}
            <span className="absolute bottom-1 left-2 text-[9px] font-bold text-white drop-shadow-md bg-black/50 px-1.5 py-0.5 rounded">
                {scene.label}
            </span>

            {/* Duration Badge */}
            <span className="absolute bottom-1 right-2 text-[8px] font-mono text-white/70 bg-black/50 px-1 py-0.5 rounded">
                {scene.duration}s
            </span>

            {/* Active Indicator */}
            {isActive && (
                <div className="absolute top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-stitch-cyan rounded-full animate-pulse" />
            )}
        </div>
    );
};
