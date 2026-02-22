import React, { useEffect, useState } from 'react';
import { projectService } from '../services/api';
import type { Project } from '../types';
import { Link } from 'react-router-dom';
import { sileo } from 'sileo';
import { Plus, Loader2, Trash2, Video, User } from 'lucide-react';
import { LazySettingsToggle } from '../components/LazySettingsToggle';
import { useLanguage } from '../contexts/LanguageContext';

export const HomePage: React.FC = () => {
    const [projects, setProjects] = useState<Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [deleteState, setDeleteState] = useState<{ deleting: string | null; confirmId: string | null }>({ deleting: null, confirmId: null });
    const { t } = useLanguage();

    useEffect(() => {
        loadProjects();
    }, []);

    const loadProjects = async () => {
        try {
            const data = await projectService.getAll();
            setProjects(data);
        } catch (error) {
            console.error('Failed to load projects', error);
            sileo.error({
                title: 'Could not load projects',
                description: 'Please refresh and try again.',
            });
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteRequest = (e: React.MouseEvent, projectId: string) => {
        e.preventDefault();
        e.stopPropagation();
        setDeleteState(s => ({ ...s, confirmId: projectId }));
    };

    const handleDeleteConfirm = async (e: React.MouseEvent, projectId: string) => {
        e.preventDefault();
        e.stopPropagation();
        setDeleteState(s => ({ ...s, confirmId: null, deleting: projectId }));
        try {
            await projectService.delete(projectId);
            setProjects(projects.filter(p => p.id !== projectId));
            setDeleteState({ deleting: null, confirmId: null });
            sileo.success({
                title: 'Project deleted',
                description: 'The project was removed successfully.',
            });
        } catch (error) {
            console.error('Failed to delete project', error);
            setDeleteState({ deleting: null, confirmId: null });
            sileo.error({
                title: 'Delete failed',
                description: 'Could not delete the project. Please try again.',
            });
        }
    };

    const handleDeleteCancel = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDeleteState(s => ({ ...s, confirmId: null }));
    };

    // Soft badge styles for light/dark mode
    const getStatusBadge = (status: string) => {
        const styles: Record<string, string> = {
            'COMPLETED': 'bg-emerald-50/90 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/20',
            'PROCESSING': 'bg-sky-50/90 dark:bg-sky-500/20 text-sky-700 dark:text-sky-400 border-sky-100 dark:border-sky-500/20',
            'FAILED': 'bg-rose-50/90 dark:bg-rose-500/20 text-rose-700 dark:text-rose-400 border-rose-100 dark:border-rose-500/20',
            'DRAFT': 'bg-slate-50/90 dark:bg-gray-500/20 text-slate-600 dark:text-gray-400 border-slate-100 dark:border-gray-500/20'
        };
        return styles[status] || styles['DRAFT'];
    };

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-[#0A0A0B] text-slate-900 dark:text-white antialiased transition-colors duration-500">

            {/* Sticky Glassmorphism Header */}
            <header className="sticky top-0 z-50 w-full px-12 py-6 flex items-center justify-between bg-white/80 dark:bg-[#0A0A0B]/80 backdrop-blur-md border-b border-slate-100 dark:border-white/5">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-gradient-to-br from-sky-400 to-blue-600 rounded-xl flex items-center justify-center text-white font-bold shadow-lg shadow-sky-500/20">L</div>
                    <span className="text-2xl font-black tracking-tight">Luma</span>
                </div>
                <div className="flex items-center gap-6">
                    <LazySettingsToggle />
                    <div className="size-10 bg-slate-100 dark:bg-white/10 rounded-full flex items-center justify-center overflow-hidden border border-slate-200/60 dark:border-white/10">
                        <User size={20} className="text-slate-400" />
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="max-w-7xl mx-auto px-12 pb-24">

                {/* Hero Section - Clean & Luminous */}
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-12 mb-20 mt-12">
                    <div className="space-y-5">
                        <h2 className="text-5xl md:text-6xl font-black tracking-tight leading-tight">
                            <span className="text-slate-900 dark:text-white">{t('home.title')?.split(' ').slice(0, 2).join(' ') || 'Generador de'} </span>
                            <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-500 to-blue-600">{t('home.title')?.split(' ').slice(2).join(' ') || 'Videos Musicales'}</span>
                        </h2>
                        <p className="text-slate-500 dark:text-gray-400 text-lg max-w-xl font-medium leading-relaxed">
                            {t('home.subtitle')}
                        </p>
                    </div>

                    {/* Gradient CTA Button */}
                    <Link
                        to="/create"
                        className="flex items-center gap-2.5 bg-gradient-to-r from-sky-500 to-blue-600 text-white px-8 py-4 rounded-full font-bold text-sm shadow-xl shadow-sky-500/25 hover:shadow-2xl hover:shadow-sky-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all group shrink-0"
                    >
                        <Plus size={20} className="group-hover:rotate-90 transition-transform" />
                        {t('home.createButton')}
                    </Link>
                </div>

                {/* Project Grid */}
                {loading ? (
                    <div className="flex justify-center py-20">
                        <Loader2 className="animate-spin text-sky-500" size={40} />
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                        {projects.map((project) => (
                            <Link
                                key={project.id}
                                to={`/project/${project.id}`}
                                className="group relative bg-white dark:bg-[#181b21] rounded-[2rem] border border-slate-200/60 dark:border-gray-800 shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-none hover:shadow-xl hover:-translate-y-1 transition-all duration-300 overflow-hidden"
                            >
                                {/* Thumbnail */}
                                <div className="relative aspect-video overflow-hidden bg-slate-100 dark:bg-gray-800">
                                    {project.thumbnailUrl ? (
                                        <img
                                            src={project.thumbnailUrl}
                                            alt={project.title}
                                            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-slate-300 dark:text-gray-600">
                                            <Video size={48} strokeWidth={1} />
                                        </div>
                                    )}

                                    {/* Soft Status Badge */}
                                    <div className="absolute top-4 right-4">
                                        <span className={`backdrop-blur-sm px-3 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase border ${getStatusBadge(project.status)}`}>
                                            {project.status}
                                        </span>
                                    </div>
                                </div>

                                {/* Card Footer */}
                                <div className="p-6 flex items-center justify-between bg-white dark:bg-[#181b21]">
                                    <div className="space-y-1 min-w-0 flex-1">
                                        <h3 className="font-extrabold text-slate-900 dark:text-white text-lg tracking-tight group-hover:text-sky-500 transition-colors truncate">
                                            {project.title}
                                        </h3>
                                        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">
                                            {new Date(project.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                        </p>
                                    </div>
                                    {deleteState.confirmId === project.id ? (
                                        <div className="flex items-center gap-1.5 shrink-0 ml-4">
                                            <button
                                                onClick={(e) => handleDeleteConfirm(e, project.id)}
                                                disabled={deleteState.deleting === project.id}
                                                className="px-2.5 py-1.5 bg-rose-500 hover:bg-rose-600 text-white rounded-lg text-[10px] font-bold transition"
                                            >
                                                {deleteState.deleting === project.id ? <Loader2 className="animate-spin" size={12} /> : 'Delete'}
                                            </button>
                                            <button
                                                onClick={handleDeleteCancel}
                                                className="px-2.5 py-1.5 bg-slate-100 dark:bg-gray-700 text-slate-600 dark:text-gray-300 rounded-lg text-[10px] font-bold hover:bg-slate-200 dark:hover:bg-gray-600 transition"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={(e) => handleDeleteRequest(e, project.id)}
                                            disabled={deleteState.deleting === project.id}
                                            className="p-2.5 bg-slate-50 dark:bg-gray-800 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-xl transition-all shrink-0 ml-4"
                                            title="Eliminar proyecto"
                                        >
                                            {deleteState.deleting === project.id ? (
                                                <Loader2 className="animate-spin" size={16} />
                                            ) : (
                                                <Trash2 size={16} />
                                            )}
                                        </button>
                                    )}
                                </div>
                            </Link>
                        ))}

                        {/* New Project Card */}
                        <Link
                            to="/create"
                            className="group cursor-pointer border-2 border-dashed border-slate-200 dark:border-white/10 rounded-[2rem] aspect-video flex flex-col items-center justify-center gap-4 hover:border-sky-400 hover:bg-sky-50/50 dark:hover:bg-sky-500/5 transition-all bg-white/50 dark:bg-transparent"
                        >
                            <div className="size-16 rounded-2xl bg-slate-50 dark:bg-white/5 flex items-center justify-center text-slate-400 group-hover:text-sky-500 group-hover:scale-110 group-hover:bg-sky-50 dark:group-hover:bg-sky-500/10 transition-all border border-slate-100 dark:border-white/10">
                                <Plus size={32} />
                            </div>
                            <p className="text-base font-bold text-slate-400 group-hover:text-sky-500 transition-colors">
                                {t('home.newProject') || 'Nuevo Proyecto'}
                            </p>
                        </Link>

                        {/* Empty State */}
                        {projects.length === 0 && (
                            <div className="col-span-full text-center py-20">
                                <div className="size-24 mx-auto mb-6 rounded-3xl bg-slate-100 dark:bg-gray-800 flex items-center justify-center">
                                    <Video size={48} className="text-slate-300 dark:text-gray-600" strokeWidth={1} />
                                </div>
                                <p className="text-xl font-bold mb-2 text-slate-700 dark:text-gray-300">{t('home.noProjects') || 'No hay proyectos aún'}</p>
                                <p className="text-slate-400 dark:text-gray-500">{t('home.emptySubtitle')}</p>
                            </div>
                        )}
                    </div>
                )}
            </main>

            {/* Footer */}
            <footer className="max-w-7xl mx-auto px-12 py-12 border-t border-slate-100 dark:border-white/5 flex flex-col md:flex-row justify-between items-center text-slate-400 text-sm gap-4">
                <p>© 2024 Luma Video AI. Pro Workspace.</p>
                <div className="flex gap-8">
                    <a className="hover:text-sky-500 transition-colors" href="/terms">{t('home.terms') || 'Términos'}</a>
                    <a className="hover:text-sky-500 transition-colors" href="/privacy">{t('home.privacy') || 'Privacidad'}</a>
                    <a className="hover:text-sky-500 transition-colors" href="/support">{t('home.support') || 'Soporte'}</a>
                </div>
            </footer>
        </div>
    );
};
