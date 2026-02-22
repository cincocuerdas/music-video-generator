import { m } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export interface Scene {
    id: string;
    sceneIndex: number;
    timestamp: number;
    duration: number;
    label: string;
    prompt: string;
    thumbnail: string;
    isFallback?: boolean;
}

function formatTime(time: number) {
    const min = Math.floor(time / 60);
    const sec = Math.floor(time % 60);
    return `${min}:${sec < 10 ? '0' + sec : sec}`;
}

interface SceneGalleryProps {
    scenes: Scene[];
    activeSceneId: string;
    onSceneClick: (scene: Scene) => void;
}

export const SceneGallery: React.FC<SceneGalleryProps> = ({ scenes, activeSceneId, onSceneClick }) => {
    if (scenes.length === 0) return null;

    return (
        <div>
            <div className="flex justify-between items-center mb-3">
                <h3 className="text-[10px] md:text-xs font-bold uppercase tracking-widest text-gray-500">
                    Generated Scenes ({scenes.length})
                </h3>
                <div className="flex gap-1">
                    <button
                        onClick={() => {
                            const container = document.getElementById('scenes-scroll');
                            container?.scrollBy({ left: -200, behavior: 'smooth' });
                        }}
                        className="p-1.5 hover:bg-white/5 rounded border border-stitch-border/30"
                    >
                        <ChevronLeft size={14} />
                    </button>
                    <button
                        onClick={() => {
                            const container = document.getElementById('scenes-scroll');
                            container?.scrollBy({ left: 200, behavior: 'smooth' });
                        }}
                        className="p-1.5 hover:bg-white/5 rounded border border-stitch-border/30"
                    >
                        <ChevronRight size={14} />
                    </button>
                </div>
            </div>

            <div
                id="scenes-scroll"
                className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide"
                style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
            >
                {scenes.map((scene) => (
                    <m.div
                        key={scene.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => onSceneClick(scene)}
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSceneClick(scene)}
                        className={`
                            flex-shrink-0 w-44 md:w-48 cursor-pointer group rounded-xl overflow-hidden border-2 transition-all duration-200
                            ${activeSceneId === scene.id
                                ? 'border-stitch-cyan ring-2 ring-stitch-cyan/20 opacity-100'
                                : 'border-transparent opacity-60 hover:opacity-100'
                            }
                        `}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                    >
                        <div className="relative aspect-video">
                            <img
                                src={scene.thumbnail}
                                alt={scene.label}
                                className="w-full h-full object-cover"
                            />
                            <span className="absolute top-2 left-2 bg-black/70 text-[10px] font-mono text-white px-1.5 py-0.5 rounded">
                                {formatTime(scene.timestamp)}
                            </span>
                            {scene.isFallback && (
                                <span className="absolute top-2 right-2 bg-amber-500/80 text-[9px] font-bold text-black px-1.5 py-0.5 rounded uppercase tracking-wider">
                                    Fallback
                                </span>
                            )}
                            {activeSceneId === scene.id && (
                                <div className="absolute inset-0 bg-stitch-cyan/10" />
                            )}
                        </div>
                        <div className="p-3 bg-stitch-surface">
                            <h4 className={`text-xs font-bold mb-1 truncate ${activeSceneId === scene.id ? 'text-stitch-cyan' : 'text-gray-300'}`}>
                                {scene.label}
                            </h4>
                            <p className="text-[9px] text-gray-500 uppercase truncate">
                                {scene.prompt.slice(0, 30)}...
                            </p>
                        </div>
                    </m.div>
                ))}
            </div>
        </div>
    );
};
