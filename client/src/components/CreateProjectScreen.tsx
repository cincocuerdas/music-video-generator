import React, { useState } from 'react';
import {
    Wand2, Monitor, Smartphone, Square,
    HelpCircle, Sparkles, Youtube
} from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

interface CreateProjectScreenProps {
    onGenerate: (data: {
        title: string;
        youtubeUrl: string;
        visualStyle: string;
        aspectRatio: '16:9' | '9:16' | '1:1';
    }) => void;
}

// Visual styles with i18n keys
const VISUAL_STYLES = [
    { id: 'cinematic', labelKey: 'Cinematic', descKey: 'High Dynamic Range', icon: '🎬' },
    { id: 'anime', labelKey: 'Anime', descKey: 'Hand-drawn 2D', icon: '🎨' },
    { id: 'cyberpunk', labelKey: 'Cyberpunk', descKey: 'Neon Aesthetics', icon: '🌃' },
    { id: 'hyper', labelKey: 'Hyper-Real', descKey: 'Unreal Engine 5', icon: '💎' },
    { id: 'noir', labelKey: 'Film Noir', descKey: 'Monochrome', icon: '🕵️' },
    { id: 'fantasy', labelKey: 'Fantasy', descKey: 'Ethereal Worlds', icon: '🐉' },
];

export const CreateProjectScreen: React.FC<CreateProjectScreenProps> = ({ onGenerate }) => {
    const [selectedStyle, setSelectedStyle] = useState('cinematic');
    const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9');
    const [projectTitle, setProjectTitle] = useState('');
    const [youtubeUrl, setYoutubeUrl] = useState('');
    const { t } = useLanguage();

    // Calculated cost (simulated)
    const creditCost = aspectRatio === '16:9' ? 24 : 18;

    const handleGenerate = () => {
        if (!projectTitle.trim() || !youtubeUrl.trim()) return;
        onGenerate({
            title: projectTitle,
            youtubeUrl,
            visualStyle: selectedStyle,
            aspectRatio,
        });
    };

    const isValid = projectTitle.trim() && youtubeUrl.trim();

    return (
        <div className="min-h-screen bg-slate-50/50 dark:bg-[#0f1723] font-sans text-slate-900 dark:text-white p-6 md:p-12 transition-colors duration-500">

            {/* Header */}
            <header className="flex justify-between items-center mb-10 max-w-7xl mx-auto">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-sky-500 rounded-lg flex items-center justify-center text-white font-bold">L</div>
                    <span className="text-xl font-black tracking-tight">Luma</span>
                </div>
                <div className="flex gap-6 text-sm font-medium text-slate-400 dark:text-gray-500">
                    <button className="hover:text-sky-500 transition-colors">{t('create.library') || 'Library'}</button>
                    <button className="text-sky-500 font-bold">{t('create.create') || 'Create'}</button>
                    <button className="hover:text-sky-500 transition-colors">{t('settings.theme') || 'Settings'}</button>
                </div>
            </header>

            <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-12">

                {/* LEFT COLUMN: Configuration (Span 7) */}
                <div className="lg:col-span-7 space-y-8">
                    {/* Main Config Card */}
                    <div className="bg-white dark:bg-[#181b21] p-8 rounded-[2rem] border border-slate-200/60 dark:border-gray-800 shadow-sm dark:shadow-none">
                        <h1 className="text-4xl font-black mb-2 tracking-tight text-slate-900 dark:text-white">{t('create.title')}</h1>
                        <p className="text-slate-500 dark:text-gray-500 mb-8">{t('create.subtitle') || 'Configure your cinematic AI generation pipeline.'}</p>

                        {/* Main Inputs */}
                        <div className="space-y-6">
                            <div className="space-y-2">
                                <label htmlFor="project-title" className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-gray-500">{t('create.projectTitle') || 'Project Title'}</label>
                                <input
                                    id="project-title"
                                    type="text"
                                    placeholder={t('create.placeholder')}
                                    className="w-full bg-white dark:bg-[#0f1723] border border-slate-200/80 dark:border-gray-700 rounded-xl p-4 outline-none focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10 transition-all text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-600"
                                    value={projectTitle}
                                    onChange={(e) => setProjectTitle(e.target.value)}
                                />
                            </div>

                            <div className="space-y-2">
                                <label htmlFor="youtube-url" className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-gray-500">{t('create.sourceUrl') || 'Source URL'}</label>
                                <div className="relative group">
                                    <Youtube className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-gray-500 group-focus-within:text-red-500 transition-colors" size={20} />
                                    <input
                                        id="youtube-url"
                                        type="text"
                                        placeholder={t('create.urlPlaceholder') || 'YouTube or Soundcloud URL'}
                                        className="w-full bg-white dark:bg-[#0f1723] border border-slate-200/80 dark:border-gray-700 rounded-xl p-4 pl-12 outline-none focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10 transition-all text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-600"
                                        value={youtubeUrl}
                                        onChange={(e) => setYoutubeUrl(e.target.value)}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Visual Styles Card */}
                    <div className="bg-white dark:bg-[#181b21] p-8 rounded-[2rem] border border-slate-200/60 dark:border-gray-800 shadow-sm dark:shadow-none">
                        <div className="flex justify-between items-end mb-4">
                            <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-gray-500">{t('create.visualStyles') || 'Visual Styles'}</span>
                            <span className="text-xs text-sky-500 cursor-pointer hover:underline">{t('create.viewAll') || 'View all styles'}</span>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                            {VISUAL_STYLES.map((style) => (
                                <button
                                    key={style.id}
                                    onClick={() => setSelectedStyle(style.id)}
                                    className={`p-4 rounded-xl border text-left transition-all duration-200 relative overflow-hidden
                                        ${selectedStyle === style.id
                                            ? 'bg-sky-50/50 dark:bg-sky-500/10 text-slate-900 dark:text-white border-sky-500 border-2 shadow-lg scale-[1.02]'
                                            : 'bg-slate-50 dark:bg-[#0f1723] border-slate-200/60 dark:border-gray-700 hover:border-sky-300 dark:hover:border-sky-500/50 text-slate-700 dark:text-gray-300'
                                        }
                                    `}
                                >
                                    <div className="text-2xl mb-2">{style.icon}</div>
                                    <div className="font-bold text-sm">{style.labelKey}</div>
                                    <div className={`text-[10px] uppercase font-bold mt-1 ${selectedStyle === style.id ? 'text-sky-600 dark:text-sky-400' : 'text-slate-400 dark:text-gray-500'}`}>
                                        {style.descKey}
                                    </div>
                                    {selectedStyle === style.id && (
                                        <div className="absolute top-2 right-2">
                                            <Sparkles size={14} className="animate-pulse text-sky-500" />
                                        </div>
                                    )}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Aspect Ratio Card */}
                    <div className="bg-white dark:bg-[#181b21] p-8 rounded-[2rem] border border-slate-200/60 dark:border-gray-800 shadow-sm dark:shadow-none">
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-gray-500 block mb-4">{t('create.aspectRatio') || 'Aspect Ratio'}</span>
                        <div className="grid grid-cols-3 gap-4">
                            <button
                                onClick={() => setAspectRatio('16:9')}
                                className={`p-6 rounded-xl border flex flex-col items-center gap-3 transition-all ${aspectRatio === '16:9'
                                    ? 'border-sky-500 bg-sky-50/50 dark:bg-sky-500/10 ring-1 ring-sky-500'
                                    : 'bg-slate-50 dark:bg-[#0f1723] border-slate-200/60 dark:border-gray-700 hover:border-sky-300 dark:hover:border-sky-500/50'}`}
                            >
                                <Monitor size={24} className={aspectRatio === '16:9' ? 'text-sky-500' : 'text-slate-400 dark:text-gray-500'} />
                                <span className={`text-xs font-bold ${aspectRatio === '16:9' ? 'text-sky-600 dark:text-sky-400' : 'text-slate-600 dark:text-gray-400'}`}>{t('create.landscape') || '16:9 Landscape'}</span>
                            </button>
                            <button
                                onClick={() => setAspectRatio('9:16')}
                                className={`p-6 rounded-xl border flex flex-col items-center gap-3 transition-all ${aspectRatio === '9:16'
                                    ? 'border-sky-500 bg-sky-50/50 dark:bg-sky-500/10 ring-1 ring-sky-500'
                                    : 'bg-slate-50 dark:bg-[#0f1723] border-slate-200/60 dark:border-gray-700 hover:border-sky-300 dark:hover:border-sky-500/50'}`}
                            >
                                <Smartphone size={24} className={aspectRatio === '9:16' ? 'text-sky-500' : 'text-slate-400 dark:text-gray-500'} />
                                <span className={`text-xs font-bold ${aspectRatio === '9:16' ? 'text-sky-600 dark:text-sky-400' : 'text-slate-600 dark:text-gray-400'}`}>{t('create.portrait') || '9:16 Portrait'}</span>
                            </button>
                            <button
                                onClick={() => setAspectRatio('1:1')}
                                className={`p-6 rounded-xl border flex flex-col items-center gap-3 transition-all ${aspectRatio === '1:1'
                                    ? 'border-sky-500 bg-sky-50/50 dark:bg-sky-500/10 ring-1 ring-sky-500'
                                    : 'bg-slate-50 dark:bg-[#0f1723] border-slate-200/60 dark:border-gray-700 hover:border-sky-300 dark:hover:border-sky-500/50'}`}
                            >
                                <Square size={24} className={aspectRatio === '1:1' ? 'text-sky-500' : 'text-slate-400 dark:text-gray-500'} />
                                <span className={`text-xs font-bold ${aspectRatio === '1:1' ? 'text-sky-600 dark:text-sky-400' : 'text-slate-600 dark:text-gray-400'}`}>{t('create.square') || '1:1 Square'}</span>
                            </button>
                        </div>
                    </div>

                    {/* CTA Mobile Only */}
                    <button
                        onClick={handleGenerate}
                        disabled={!isValid}
                        className={`lg:hidden w-full py-4 rounded-xl font-bold text-lg shadow-xl transition-all ${isValid
                            ? 'bg-gradient-to-b from-slate-800 to-slate-950 text-white hover:from-slate-700 hover:to-slate-800'
                            : 'bg-slate-200 dark:bg-gray-700 text-slate-400 dark:text-gray-400 cursor-not-allowed'}`}
                    >
                        {t('create.generate')}
                    </button>
                </div>

                {/* RIGHT COLUMN: Preview & Summary (Span 5) */}
                <aside className="lg:col-span-5 relative hidden lg:block">
                    <div className="sticky top-10 space-y-6">

                        {/* Preview Card - Premium elevated */}
                        <div className="bg-white dark:bg-[#181b21] rounded-[2.5rem] p-4 border border-slate-200/50 dark:border-gray-800 shadow-[0_20px_50px_rgba(0,0,0,0.04)] dark:shadow-none overflow-hidden">

                            {/* The Preview Canvas */}
                            <div className={`w-full bg-slate-100 dark:bg-black/40 rounded-[2rem] flex items-center justify-center relative overflow-hidden transition-all duration-500 border border-slate-200/50 dark:border-transparent
                                ${aspectRatio === '16:9' ? 'aspect-video' : aspectRatio === '9:16' ? 'aspect-[9/16]' : 'aspect-square'}`}
                            >
                                <Wand2 className="text-slate-300 dark:text-gray-700 w-16 h-16" />
                                <div className="absolute inset-x-0 bottom-0 p-6 bg-gradient-to-t from-slate-200/80 dark:from-black/50 to-transparent">
                                    <div className="h-2 w-2/3 bg-slate-300/50 dark:bg-white/20 rounded mb-2"></div>
                                    <div className="h-2 w-1/2 bg-slate-300/50 dark:bg-white/20 rounded"></div>
                                </div>
                            </div>

                            <div className="p-6 space-y-6">
                                {/* Header */}
                                <div className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-gray-700">
                                    <span className="text-sm font-bold text-slate-500 dark:text-gray-500">{t('create.livePreview') || 'Live Preview'}</span>
                                    <span className="text-[10px] font-bold bg-slate-100 dark:bg-gray-800 px-2 py-1 rounded text-slate-500 dark:text-gray-500">{t('create.draft') || 'DRAFT'}</span>
                                </div>

                                {/* Stats */}
                                <div className="space-y-3 text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-slate-500 dark:text-gray-500">{t('create.visualStyle') || 'Visual Style'}</span>
                                        <span className="font-bold text-slate-900 dark:text-white capitalize">{selectedStyle.replace('-', ' ')}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500 dark:text-gray-500">{t('create.aspectRatio') || 'Aspect Ratio'}</span>
                                        <span className="font-bold text-slate-900 dark:text-white">{aspectRatio}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500 dark:text-gray-500">{t('create.estimatedTime') || 'Estimated Time'}</span>
                                        <span className="font-bold text-emerald-500">~2.5 mins</span>
                                    </div>
                                </div>

                                {/* Info Card with Glassmorphism */}
                                <div className="bg-blue-50/50 dark:bg-blue-500/5 border border-blue-100 dark:border-blue-500/20 rounded-2xl p-4 flex gap-4 items-start">
                                    <div className="p-2 bg-white dark:bg-blue-500/20 rounded-lg shadow-sm">
                                        <HelpCircle className="text-blue-500" size={18} />
                                    </div>
                                    <p className="text-xs text-slate-600 dark:text-gray-300 leading-relaxed">
                                        {t('create.creditsInfo')} <strong className="text-blue-600 dark:text-blue-400">{creditCost} {t('create.creditsDeducted')}</strong>
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Status Bar */}
                        <div className="flex justify-between items-center px-6">
                            <div className="text-center">
                                <div className="text-2xl font-black text-slate-900 dark:text-white">{creditCost}</div>
                                <div className="text-[10px] font-bold text-slate-400 dark:text-gray-500 uppercase tracking-wider">{t('create.creditsCost') || 'Credits Cost'}</div>
                            </div>
                            <div className="h-8 w-px bg-slate-200 dark:bg-gray-700"></div>
                            <div className="text-center">
                                <div className="text-sm font-bold text-emerald-500">{t('create.online') || 'Online'}</div>
                                <div className="text-[10px] font-bold text-slate-400 dark:text-gray-500 uppercase tracking-wider">{t('create.engineStatus') || 'Engine Status'}</div>
                            </div>
                        </div>

                        {/* Big CTA Button with Gradient */}
                        <button
                            onClick={handleGenerate}
                            disabled={!isValid}
                            className={`w-full py-5 rounded-2xl font-black text-lg transition-all flex items-center justify-center gap-3 ${isValid
                                ? 'bg-gradient-to-b from-slate-800 to-slate-950 dark:from-white dark:to-slate-200 text-white dark:text-black shadow-xl shadow-slate-200/50 dark:shadow-none hover:scale-[1.01] active:scale-[0.98]'
                                : 'bg-slate-200 dark:bg-gray-700 text-slate-400 dark:text-gray-400 cursor-not-allowed'}`}
                        >
                            <Sparkles className={isValid ? 'animate-pulse' : ''} size={20} />
                            {t('create.generate')}
                        </button>
                    </div>
                </aside>

            </main>
        </div>
    );
};
