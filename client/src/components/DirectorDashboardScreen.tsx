import React, { useState, useCallback, useReducer } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import {
    ArrowLeft, Play, Pause, RefreshCw, Save,
    Clock, Film, Plus, Settings,
    ZoomIn, ZoomOut
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Project } from '../types';
import { TimelineClip } from './TimelineClip';
import { LyricWaveformTrack } from './LyricWaveformTrack';
import { SceneInspector } from './SceneInspector';
import { useDirectorShortcuts } from '../hooks';

// ─── Scene selection reducer ───────────────────────────────────────────────
// selectedScene + editingPrompt always change together → one atomic update
type SceneState = { selectedScene: number; editingPrompt: string };
type SceneAction =
    | { type: 'SELECT'; index: number; prompt: string }
    | { type: 'UPDATE_PROMPT'; prompt: string }
    | { type: 'NEXT'; scenes: Array<{ prompt: string }> }
    | { type: 'PREV'; scenes: Array<{ prompt: string }> }
    | { type: 'DELETE_ADJUST'; scenes: Array<{ prompt: string }> };

function sceneReducer(state: SceneState, action: SceneAction): SceneState {
    switch (action.type) {
        case 'SELECT': return { selectedScene: action.index, editingPrompt: action.prompt };
        case 'UPDATE_PROMPT': return { ...state, editingPrompt: action.prompt };
        case 'NEXT': {
            const next = Math.min(state.selectedScene + 1, action.scenes.length - 1);
            return { selectedScene: next, editingPrompt: action.scenes[next]?.prompt || '' };
        }
        case 'PREV': {
            const prev = Math.max(state.selectedScene - 1, 0);
            return { selectedScene: prev, editingPrompt: action.scenes[prev]?.prompt || '' };
        }
        case 'DELETE_ADJUST': {
            const prev = state.selectedScene > 0 ? state.selectedScene - 1 : 0;
            return { selectedScene: prev, editingPrompt: action.scenes[prev]?.prompt || '' };
        }
    }
}

// ─── Regeneration reducer ───────────────────────────────────────────────────
// isRegenerating + regeneratingSceneId always change together
type RegenState = { isRegenerating: boolean; regeneratingSceneId: number | null };
type RegenAction = { type: 'START'; sceneId: number } | { type: 'DONE' };

function regenReducer(_state: RegenState, action: RegenAction): RegenState {
    switch (action.type) {
        case 'START': return { isRegenerating: true, regeneratingSceneId: action.sceneId };
        case 'DONE': return { isRegenerating: false, regeneratingSceneId: null };
    }
}

interface DirectorDashboardScreenProps {
    project: Project;
    onSave?: (updates: Partial<Project>) => Promise<void>;
    onRegenerateScene?: (sceneIndex: number, newPrompt: string) => Promise<void>;
    onDeleteScene?: (sceneIndex: number) => Promise<void>;
}

export const DirectorDashboardScreen: React.FC<DirectorDashboardScreenProps> = ({
    project,
    onSave,
    onRegenerateScene,
    onDeleteScene,
}) => {
    const [{ selectedScene, editingPrompt }, dispatchScene] = useReducer(sceneReducer, { selectedScene: 0, editingPrompt: '' });
    const [{ isRegenerating, regeneratingSceneId }, dispatchRegen] = useReducer(regenReducer, { isRegenerating: false, regeneratingSceneId: null });
    const [isPlaying, setIsPlaying] = useState(false);
    const [hasChanges, setHasChanges] = useState(false);

    // Extract scenes from project
    const scenes = (project.analysisResult?.generatedImages || []).map((img, idx) => ({
        sceneIndex: idx,
        imageUrl: img.imageUrl,
        prompt: img.prompt || '',
        duration: project.analysisResult?.scenes?.[idx]?.duration || 5,
        verseText: project.analysisResult?.scenes?.[idx]?.verseText || '',
    }));

    const currentScene = scenes[selectedScene];

    // Keyboard shortcut handlers
    const togglePlay = useCallback(() => {
        setIsPlaying(prev => !prev);
        // TODO: Add actual video/audio control if available
    }, []);

    const handleSeek = useCallback((offset: number) => {
        if (offset > 0) {
            dispatchScene({ type: 'NEXT', scenes });
        } else {
            dispatchScene({ type: 'PREV', scenes });
        }
    }, [scenes]);

    const toggleMute = useCallback(() => {
        // Mute functionality - to be connected to audio player
    }, []);

    const handleDelete = useCallback(() => {
        if (onDeleteScene && scenes.length > 1) {
            onDeleteScene(selectedScene);
            dispatchScene({ type: 'DELETE_ADJUST', scenes });
        }
    }, [onDeleteScene, selectedScene, scenes]);

    const goToNextScene = useCallback(() => {
        dispatchScene({ type: 'NEXT', scenes });
    }, [scenes]);

    const goToPrevScene = useCallback(() => {
        dispatchScene({ type: 'PREV', scenes });
    }, [scenes]);

    // 🔥 Activate keyboard shortcuts
    useDirectorShortcuts({
        onPlayPause: togglePlay,
        onSeek: handleSeek,
        onToggleMute: toggleMute,
        onDeleteScene: handleDelete,
        onNextScene: goToNextScene,
        onPrevScene: goToPrevScene
    });

    const handleRegenerateScene = async () => {
        if (!onRegenerateScene || !editingPrompt.trim()) return;
        dispatchRegen({ type: 'START', sceneId: selectedScene });
        try {
            await onRegenerateScene(selectedScene, editingPrompt);
        } finally {
            dispatchRegen({ type: 'DONE' });
        }
    };

    const handleSave = async () => {
        if (!onSave) return;
        await onSave({});
        setHasChanges(false);
    };

    return (
        <div className="min-h-screen bg-[#0a0a0c] text-white font-sans flex flex-col">

            {/* Top Header Bar */}
            <header className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-[#0f0f12]">
                <div className="flex items-center gap-4">
                    <Link
                        to={`/project/${project.id}`}
                        className="flex items-center gap-2 text-gray-500 hover:text-white transition text-sm"
                    >
                        <ArrowLeft size={18} />
                        <span className="hidden sm:inline">Back to Result</span>
                    </Link>
                    <div className="h-5 w-px bg-white/10" />
                    <div className="flex items-center gap-2">
                        <Settings size={16} className="text-stitch-cyan" />
                        <span className="font-bold">Director Mode</span>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <span className={`text-xs font-bold px-2 py-1 rounded ${hasChanges ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
                        {hasChanges ? 'Unsaved Changes' : 'All Saved'}
                    </span>
                    <button
                        onClick={handleSave}
                        disabled={!hasChanges}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition ${hasChanges
                            ? 'bg-stitch-cyan text-black hover:bg-stitch-cyan/80'
                            : 'bg-white/5 text-gray-500 cursor-not-allowed'}`}
                    >
                        <Save size={16} />
                        Save Changes
                    </button>
                </div>
            </header>

            {/* Main Content */}
            <div className="flex-1 flex overflow-hidden">

                {/* Left Sidebar - Scene List */}
                <aside className="w-72 border-r border-white/5 bg-[#0c0c0e] flex flex-col">
                    {/* Panel Header */}
                    <div className="p-4 border-b border-white/5">
                        <div className="flex items-center justify-between">
                            <h2 className="text-xs font-bold uppercase tracking-widest text-gray-500">
                                Scenes ({scenes.length})
                            </h2>
                            <button className="text-stitch-cyan hover:text-white transition">
                                <Plus size={16} />
                            </button>
                        </div>
                    </div>

                    {/* Scene List */}
                    <div className="flex-1 overflow-y-auto p-3 space-y-2">
                        {scenes.map((scene, idx) => (
                            <m.button
                                key={`scene-${scene.sceneIndex}`}
                                onClick={() => dispatchScene({ type: 'SELECT', index: idx, prompt: scene.prompt })}
                                className={`w-full p-2 rounded-xl text-left transition-all ${selectedScene === idx
                                    ? 'bg-stitch-cyan/10 border border-stitch-cyan/30'
                                    : 'bg-white/5 border border-transparent hover:bg-white/10'}`}
                                whileHover={{ scale: 1.02 }}
                                whileTap={{ scale: 0.98 }}
                            >
                                <div className="flex gap-3">
                                    <div className="w-20 h-12 rounded-lg overflow-hidden bg-black flex-shrink-0 relative">
                                        <img
                                            src={scene.imageUrl}
                                            alt={`Scene ${idx + 1}`}
                                            className={`w-full h-full object-cover transition-all duration-300 ${regeneratingSceneId === idx ? 'opacity-30 blur-sm scale-105' : 'opacity-100'
                                                }`}
                                        />
                                        {/* Regeneration Shimmer Overlay */}
                                        {regeneratingSceneId === idx && (
                                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40">
                                                <div className="w-4 h-4 border-2 border-stitch-cyan border-t-transparent rounded-full animate-spin mb-1" />
                                                <span className="text-[8px] font-bold text-stitch-cyan uppercase tracking-wider animate-pulse">AI</span>
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between mb-1">
                                            <span className={`text-xs font-bold ${selectedScene === idx ? 'text-stitch-cyan' : 'text-white'}`}>
                                                Scene {String(idx + 1).padStart(2, '0')}
                                            </span>
                                            <span className="text-[10px] text-gray-500 font-mono">
                                                {scene.duration}s
                                            </span>
                                        </div>
                                        <p className="text-[10px] text-gray-500 truncate">
                                            {scene.prompt.slice(0, 40)}...
                                        </p>
                                    </div>
                                </div>
                            </m.button>
                        ))}
                    </div>

                    {/* Timeline Mini */}
                    <div className="p-4 border-t border-white/5">
                        <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                            <Clock size={12} />
                            <span>Total Duration</span>
                        </div>
                        <div className="text-lg font-bold font-mono">
                            {scenes.reduce((acc, s) => acc + s.duration, 0)}s
                        </div>
                    </div>
                </aside>

                {/* Center - Preview */}
                <main className="flex-1 flex flex-col bg-[#08080a]">
                    {/* Preview Header */}
                    <div className="flex items-center justify-between px-6 py-3 border-b border-white/5">
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => setIsPlaying(!isPlaying)}
                                className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition"
                            >
                                {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                            </button>
                            <span className="text-sm font-medium text-gray-400">
                                Scene {selectedScene + 1} of {scenes.length}
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <button className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition text-gray-400">
                                <ZoomOut size={16} />
                            </button>
                            <span className="text-xs text-gray-500 font-mono">100%</span>
                            <button className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition text-gray-400">
                                <ZoomIn size={16} />
                            </button>
                        </div>
                    </div>

                    {/* Preview Area */}
                    <div className="flex-1 flex items-center justify-center p-8">
                        <AnimatePresence mode="wait">
                            <m.div
                                key={selectedScene}
                                layoutId="shared-video-player"
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.95 }}
                                transition={{ duration: 0.2 }}
                                className="relative rounded-2xl overflow-hidden shadow-2xl border border-white/10 max-w-4xl w-full aspect-video"
                            >
                                {currentScene ? (
                                    <img
                                        src={currentScene.imageUrl}
                                        alt={`Scene ${selectedScene + 1}`}
                                        className="w-full h-full object-cover"
                                    />
                                ) : (
                                    <div className="w-full h-full bg-gray-900 flex items-center justify-center">
                                        <Film size={48} className="text-gray-700" />
                                    </div>
                                )}

                                {/* Regenerating Overlay */}
                                {isRegenerating && (
                                    <div className="absolute inset-0 bg-black/80 flex items-center justify-center">
                                        <div className="text-center space-y-3">
                                            <RefreshCw size={32} className="animate-spin text-stitch-cyan mx-auto" />
                                            <p className="text-sm font-bold">Regenerating Scene...</p>
                                        </div>
                                    </div>
                                )}

                                {/* Scene Badge */}
                                <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-sm px-3 py-1.5 rounded-lg text-xs font-bold">
                                    Scene {String(selectedScene + 1).padStart(2, '0')}
                                </div>
                            </m.div>
                        </AnimatePresence>
                    </div>

                    {/* Interactive Timeline */}
                    <div className="px-6 py-4 border-t border-white/5">
                        <div className="flex items-center gap-2 mb-3">
                            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Timeline</span>
                            <div className="flex-1 h-px bg-white/5" />
                            <span className="text-[10px] font-mono text-gray-600">
                                {scenes.reduce((a, s) => a + s.duration, 0)}s total
                            </span>
                        </div>
                        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                            {scenes.map((scene, idx) => (
                                <TimelineClip
                                    key={`clip-${scene.sceneIndex}`}
                                    scene={{
                                        id: String(idx),
                                        thumbnail: scene.imageUrl,
                                        label: `Scene ${String(idx + 1).padStart(2, '0')}`,
                                        duration: scene.duration
                                    }}
                                    isActive={selectedScene === idx}
                                    onClick={() => dispatchScene({ type: 'SELECT', index: idx, prompt: scene.prompt })}
                                    pixelsPerSecond={12}
                                />
                            ))}
                        </div>

                        {/* Lyric Waveform Track */}
                        <div className="mt-2 overflow-x-auto scrollbar-hide rounded-lg">
                            <LyricWaveformTrack
                                totalDuration={scenes.reduce((a, s) => a + s.duration, 0)}
                                currentTime={scenes.slice(0, selectedScene).reduce((a, s) => a + s.duration, 0)}
                                zoomLevel={12}
                                lyrics={scenes.map((scene, idx) => {
                                    const start = scenes.slice(0, idx).reduce((a, s) => a + s.duration, 0);
                                    return {
                                        text: scene.verseText || `Scene ${idx + 1}`,
                                        start,
                                        end: start + scene.duration
                                    };
                                })}
                                onSeek={(time) => {
                                    let accumulated = 0;
                                    for (let i = 0; i < scenes.length; i++) {
                                        if (time < accumulated + scenes[i].duration) {
                                            dispatchScene({ type: 'SELECT', index: i, prompt: scenes[i].prompt });
                                            break;
                                        }
                                        accumulated += scenes[i].duration;
                                    }
                                }}
                            />
                        </div>
                    </div>
                </main>

                {/* Right Sidebar - Scene Inspector */}
                {currentScene && (
                    <SceneInspector
                        scene={{
                            id: String(selectedScene),
                            lyric: currentScene.verseText || '',
                            visualPrompt: editingPrompt || currentScene.prompt,
                            styleModel: project.visualStyle || 'cinematic',
                            isLocked: false
                        }}
                        onUpdate={(_id, updates) => {
                            if (updates.visualPrompt) {
                                dispatchScene({ type: 'UPDATE_PROMPT', prompt: updates.visualPrompt });
                            }
                            setHasChanges(true);
                        }}
                        onRegenerate={() => handleRegenerateScene()}
                        isRegenerating={isRegenerating}
                    />
                )}
            </div>
        </div>
    );
};
