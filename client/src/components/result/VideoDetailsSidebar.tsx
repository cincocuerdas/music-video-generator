import { useReducer } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { ThumbsUp, ThumbsDown, Zap, Film, Loader2 } from 'lucide-react';
import type { Project } from '../../types';
import { projectService } from '../../services/api';
import { FeedbackButtons } from '../FeedbackButtons';

import type { Scene } from './SceneGallery';

type FeedbackState = {
    projectFeedback: 'perfect' | 'needs_work' | null;
    feedbackText: string;
    isSubmitting: boolean;
    submitted: boolean;
};
type FeedbackAction =
    | { type: 'SET_RATING'; value: 'perfect' | 'needs_work' | null }
    | { type: 'SET_TEXT'; text: string }
    | { type: 'SUBMIT_START' }
    | { type: 'SUBMIT_DONE' };

function feedbackReducer(state: FeedbackState, action: FeedbackAction): FeedbackState {
    switch (action.type) {
        case 'SET_RATING': return { ...state, projectFeedback: action.value, submitted: false };
        case 'SET_TEXT': return { ...state, feedbackText: action.text };
        case 'SUBMIT_START': return { ...state, isSubmitting: true };
        case 'SUBMIT_DONE': return { ...state, isSubmitting: false, submitted: true };
    }
}

function formatTime(time: number) {
    const min = Math.floor(time / 60);
    const sec = Math.floor(time % 60);
    return `${min}:${sec < 10 ? '0' + sec : sec}`;
}

interface VideoDetailsSidebarProps {
    project: Project;
    duration: number;
    scenes: Scene[];
    activeScene?: Scene;
}

export const VideoDetailsSidebar: React.FC<VideoDetailsSidebarProps> = ({
    project,
    duration,
    scenes,
    activeScene,
}) => {

    const [{ projectFeedback, feedbackText, isSubmitting, submitted }, dispatch] = useReducer(feedbackReducer, {
        projectFeedback: null, feedbackText: '', isSubmitting: false, submitted: false,
    });

    const handleSubmitFeedback = async () => {
        if (!projectFeedback || isSubmitting || submitted) return;
        dispatch({ type: 'SUBMIT_START' });
        try {
            await projectService.sendFeedback(project.id, {
                score: projectFeedback === 'perfect' ? 1 : -1,
                prompt: feedbackText || 'project-level-feedback',
            });
        } catch (error) {
            console.error('Failed to submit feedback', error);
        } finally {
            dispatch({ type: 'SUBMIT_DONE' });
        }
    };

    return (
        <aside className="flex-1 flex flex-col gap-4 md:gap-6 min-w-0 lg:min-w-[280px] overflow-y-auto">
            {/* Video Details Card */}
            <div className="glass-stitch p-5 rounded-2xl">
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-4 flex items-center gap-2">
                    <Film size={14} /> Video Details
                </h3>
                <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Duration</span>
                        <span className="font-mono text-white">{formatTime(duration)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Scenes</span>
                        <span className="text-white">{scenes.length}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Style</span>
                        <span className="text-white capitalize">{project.visualStyle || 'Default'}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Created</span>
                        <span className="text-white">{new Date(project.createdAt).toLocaleDateString()}</span>
                    </div>
                </div>
            </div>

            {/* Quality Feedback */}
            <div className="glass-stitch p-5 rounded-2xl">
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-4">
                    Rate this Result
                </h3>
                <div className="flex gap-3 mb-4">
                    <button
                        onClick={() => dispatch({ type: 'SET_RATING', value: 'perfect' })}
                        className={`flex-1 py-3 rounded-xl border text-xs font-bold flex flex-col items-center gap-1 transition
                            ${projectFeedback === 'perfect'
                                ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400'
                                : 'bg-white/5 border-white/10 text-gray-400 hover:bg-white/10'
                            }
                        `}
                    >
                        <ThumbsUp size={18} /> PERFECT
                    </button>
                    <button
                        onClick={() => dispatch({ type: 'SET_RATING', value: 'needs_work' })}
                        className={`flex-1 py-3 rounded-xl border text-xs font-bold flex flex-col items-center gap-1 transition
                            ${projectFeedback === 'needs_work'
                                ? 'bg-rose-500/20 border-rose-500 text-rose-400'
                                : 'bg-white/5 border-white/10 text-gray-400 hover:bg-white/10'
                            }
                        `}
                    >
                        <ThumbsDown size={18} /> NEEDS WORK
                    </button>
                </div>

                <AnimatePresence>
                    {projectFeedback === 'needs_work' && (
                        <m.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                        >
                            <textarea
                                value={feedbackText}
                                onChange={(e) => dispatch({ type: 'SET_TEXT', text: e.target.value })}
                                className="w-full bg-black/30 border border-stitch-border/50 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-stitch-cyan resize-none"
                                placeholder="What went wrong? (Blurry, bad transition, etc.)"
                                rows={3}
                            />
                            <button
                                onClick={handleSubmitFeedback}
                                disabled={isSubmitting || submitted}
                                className="w-full mt-3 bg-white/10 hover:bg-white/20 disabled:opacity-50 py-2 rounded-lg text-xs font-bold transition flex items-center justify-center gap-2"
                            >
                                {isSubmitting && <Loader2 size={12} className="animate-spin" />}
                                {submitted ? 'Submitted!' : isSubmitting ? 'Submitting...' : 'Submit Feedback'}
                            </button>
                        </m.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Scene Specific Feedback */}
            {activeScene && (
                <div className="glass-stitch p-5 rounded-2xl">
                    <div className="flex justify-between items-center mb-3">
                        <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
                            Scene Feedback
                        </h3>
                        <span className="text-[10px] bg-stitch-cyan/20 text-stitch-cyan px-2 py-0.5 rounded font-bold">
                            #{activeScene.sceneIndex + 1}
                        </span>
                    </div>
                    <p className="text-xs text-gray-400 mb-4">Is this scene generated correctly?</p>
                    <FeedbackButtons
                        projectId={project.id}
                        currentPrompt={activeScene.prompt}
                        sceneIndex={activeScene.sceneIndex}
                        style={project.visualStyle}
                        variant="static"
                    />
                </div>
            )}

            {/* Pro Upgrade CTA */}
            <div className="mt-auto bg-gradient-to-br from-stitch-cyan to-stitch-blue p-5 rounded-2xl text-white shadow-lg relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                    <Zap size={64} />
                </div>
                <div className="relative z-10">
                    <div className="flex items-center gap-2 mb-2">
                        <div className="bg-white/20 p-1.5 rounded">
                            <Zap size={14} fill="white" />
                        </div>
                        <span className="text-[9px] font-bold bg-white/20 px-2 py-0.5 rounded-full uppercase tracking-wider">
                            Pro Plan
                        </span>
                    </div>
                    <h4 className="font-bold text-sm mb-1">Unlock Pro Pipeline</h4>
                    <p className="text-[11px] text-white/80 mb-3">Faster renders & unlimited 4K exports.</p>
                    <button className="w-full bg-white text-stitch-blue py-2 rounded-lg text-xs font-bold hover:bg-gray-100 transition">
                        Upgrade Account
                    </button>
                </div>
            </div>
        </aside>
    );
};
