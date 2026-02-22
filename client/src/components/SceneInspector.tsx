import React, { useState, useEffect } from 'react';
import {
    Sparkles, RefreshCw, Type, Image as ImageIcon,
    AlertCircle, Lock, Unlock
} from 'lucide-react';
import { mockAiService } from '../services/mockAiService';

interface SceneData {
    id: string;
    lyric: string;
    visualPrompt: string;
    styleModel: string;
    isLocked?: boolean;
}

interface SceneInspectorProps {
    scene: SceneData;
    onUpdate: (id: string, updates: Partial<SceneData>) => void;
    onRegenerate: (id: string) => void;
    isRegenerating?: boolean;
}

export const SceneInspector: React.FC<SceneInspectorProps> = ({
    scene,
    onUpdate,
    onRegenerate,
    isRegenerating = false
}) => {
    const [formState, setFormState] = useState({ lyric: scene.lyric, prompt: scene.visualPrompt, isDirty: false });
    const [isEnhancing, setIsEnhancing] = useState(false);

    // Sync when selected scene changes
    useEffect(() => {
        setFormState({ lyric: scene.lyric, prompt: scene.visualPrompt, isDirty: false });
    }, [scene.id, scene.lyric, scene.visualPrompt]);

    const handleSave = () => {
        onUpdate(scene.id, { lyric: formState.lyric, visualPrompt: formState.prompt });
        setFormState(s => ({ ...s, isDirty: false }));
    };

    const handleEnhancePrompt = async () => {
        setIsEnhancing(true);
        try {
            const enhanced = await mockAiService.enhancePrompt(formState.prompt, scene.styleModel);
            setFormState(s => ({ ...s, prompt: enhanced, isDirty: true }));
        } finally {
            setIsEnhancing(false);
        }
    };

    return (
        <div className="h-full flex flex-col bg-[#0c0c0e] border-l border-white/5 text-white w-80">

            {/* Header */}
            <div className="p-4 border-b border-white/5 flex justify-between items-center">
                <h3 className="font-bold text-[10px] uppercase tracking-widest text-gray-500">Scene Inspector</h3>
                <span className="text-[9px] bg-stitch-surface px-2 py-1 rounded font-mono text-gray-600">
                    #{scene.id}
                </span>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-6">

                {/* Lyric Editor */}
                <div className="space-y-2">
                    <div className="flex items-center gap-2 text-stitch-cyan">
                        <Type size={12} />
                        <label htmlFor="lyric-editor" className="text-[10px] font-bold uppercase tracking-widest">Lyric Transcript</label>
                    </div>
                    <textarea
                        id="lyric-editor"
                        className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-sm text-gray-200 focus:border-stitch-cyan focus:ring-1 focus:ring-stitch-cyan outline-none transition-all resize-none"
                        rows={3}
                        value={formState.lyric}
                        onChange={(e) => setFormState(s => ({ ...s, lyric: e.target.value, isDirty: true }))}
                        placeholder="Edit the lyrics here..."
                    />
                    <p className="text-[9px] text-gray-600">
                        Changing lyrics adjusts lip-sync timing on regeneration.
                    </p>
                </div>

                {/* Visual Prompt Editor */}
                <div className="space-y-2">
                    <div className="flex items-center gap-2 text-purple-400">
                        <ImageIcon size={12} />
                        <label htmlFor="prompt-editor" className="text-[10px] font-bold uppercase tracking-widest">AI Visual Prompt</label>
                    </div>
                    <div className="relative">
                        <textarea
                            id="prompt-editor"
                            className="w-full bg-black/40 border border-white/10 rounded-xl p-3 pr-12 text-sm text-gray-200 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none transition-all h-32 resize-none"
                            value={formState.prompt}
                            onChange={(e) => setFormState(s => ({ ...s, prompt: e.target.value, isDirty: true }))}
                            placeholder="Describe the visual for this scene..."
                        />
                        <button
                            onClick={handleEnhancePrompt}
                            disabled={isEnhancing}
                            className={`absolute bottom-3 right-3 p-2 rounded-lg transition-all ${isEnhancing
                                    ? 'bg-purple-500 text-white animate-pulse'
                                    : 'bg-purple-500/20 text-purple-400 hover:bg-purple-500 hover:text-white'
                                }`}
                            title="Enhance Prompt with AI ✨"
                        >
                            <Sparkles size={14} className={isEnhancing ? 'animate-spin' : ''} />
                        </button>
                    </div>
                </div>

                {/* Style Model Info */}
                <div className="bg-stitch-surface rounded-xl p-4 border border-white/5 space-y-3">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Model Style</span>
                        <span className="text-xs font-bold text-white capitalize">{scene.styleModel}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Lock Scene</span>
                        <button
                            onClick={() => onUpdate(scene.id, { isLocked: !scene.isLocked })}
                            className={`p-1.5 rounded-lg transition-all ${scene.isLocked
                                ? 'bg-amber-500/20 text-amber-400'
                                : 'bg-white/5 text-gray-500 hover:text-white'
                                }`}
                        >
                            {scene.isLocked ? <Lock size={14} /> : <Unlock size={14} />}
                        </button>
                    </div>
                </div>

            </div>

            {/* Footer Actions */}
            <div className="p-4 border-t border-white/5 space-y-3">

                {/* Save Changes Warning */}
                {formState.isDirty && (
                    <div className="flex items-center gap-2 text-amber-500 text-[10px] animate-pulse bg-amber-500/10 p-2 rounded-lg">
                        <AlertCircle size={12} />
                        <span>Unsaved changes</span>
                        <button
                            onClick={handleSave}
                            className="ml-auto px-2 py-1 bg-amber-500/20 rounded font-bold hover:bg-amber-500/40 transition-colors"
                        >
                            Save
                        </button>
                    </div>
                )}

                {/* Regenerate Button */}
                <button
                    onClick={() => onRegenerate(scene.id)}
                    disabled={isRegenerating}
                    className="w-full flex items-center justify-center gap-2 bg-stitch-cyan hover:bg-stitch-cyan/80 text-black py-3 rounded-xl font-bold text-xs shadow-lg shadow-stitch-cyan/20 transition-all active:scale-95 group disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <RefreshCw size={14} className={`transition-transform duration-700 ${isRegenerating ? 'animate-spin' : 'group-hover:rotate-180'}`} />
                    {isRegenerating ? 'REGENERATING...' : 'REGENERATE SCENE'}
                </button>
            </div>

        </div>
    );
};
