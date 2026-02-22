import React, { useState, useEffect, useRef, useCallback } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { CheckCircle, Loader2, Circle, AlertCircle, Film } from 'lucide-react';
import type { Job } from '../types';

interface LogEntry {
    id: string;
    timestamp: string;
    level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
    message: string;
}

interface ProcessingScreenProps {
    projectTitle: string;
    jobs: Job[];
    currentProgress: number;
    statusMessage: string;
    isConnected: boolean;
    currentPreview?: string | null;
    sceneInfo?: {
        current: number;
        total: number;
    };
}

const JOB_LABELS: Record<string, { name: string; description: string }> = {
    'YOUTUBE_DOWNLOAD': { name: 'Source Retrieval', description: 'Downloading audio stream' },
    'TRANSCRIPTION': { name: 'Transcription', description: 'Analyzing audio patterns' },
    'ANALYZE_LYRICS': { name: 'Semantic Analysis', description: 'Processing lyrical content' },
    'GENERATE_IMAGES': { name: 'Visual Synthesis', description: 'Generating scene frames' },
    'RENDER_VIDEO': { name: 'Temporal Assembly', description: 'Compositing video layers' },
    'FINALIZE': { name: 'Output Encoding', description: 'Finalizing render pipeline' },
};

const JOB_ORDER = ['YOUTUBE_DOWNLOAD', 'TRANSCRIPTION', 'ANALYZE_LYRICS', 'GENERATE_IMAGES', 'RENDER_VIDEO', 'FINALIZE'];

// Mensajes atmosféricos para dar realismo técnico
const ATMOSPHERIC_LOGS = [
    { level: 'INFO', msg: 'Allocating GPU memory block (24GB)...' },
    { level: 'SUCCESS', msg: 'Connection established with remote worker #882' },
    { level: 'INFO', msg: 'Analyzing audio spectrum for sync points...' },
    { level: 'WARN', msg: 'Latency spike detected (122ms), adjusting buffer...' },
    { level: 'INFO', msg: 'Phonetic alignment in progress...' },
    { level: 'INFO', msg: 'Upscaling vector assets to 4K...' },
    { level: 'INFO', msg: 'Applying color grading LUTs...' },
    { level: 'SUCCESS', msg: 'Audio waveform synchronized' },
];

export const ProcessingScreen: React.FC<ProcessingScreenProps> = ({
    projectTitle,
    jobs,
    currentProgress,
    statusMessage,
    isConnected,
    currentPreview,
    sceneInfo,
}) => {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [displayProgress, setDisplayProgress] = useState(0);
    const logsEndRef = useRef<HTMLDivElement>(null);
    const prevJobsRef = useRef<string>('');
    const lastAtmosphericLogRef = useRef(-1);
    const targetProgressRef = useRef(0);
    const logCounterRef = useRef(0);

    // Generar timestamp
    const getTimestamp = useCallback(() => {
        const now = new Date();
        return `[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}]`;
    }, []);

    // Agregar log entry
    const addLog = useCallback((level: LogEntry['level'], message: string) => {
        setLogs(prev => {
            if (prev[prev.length - 1]?.message === message) return prev;
            logCounterRef.current += 1;
            return [
                ...prev.slice(-12),
                {
                    id: `${Date.now()}-${logCounterRef.current}`,
                    timestamp: getTimestamp(),
                    level,
                    message,
                },
            ];
        });
    }, [getTimestamp]);

    // Animación de progreso no-lineal: se ralentiza en procesos pesados
    useEffect(() => {
        targetProgressRef.current = currentProgress;

        const interval = setInterval(() => {
            setDisplayProgress(prev => {
                const target = targetProgressRef.current;
                if (prev >= target) return prev;

                // Incremento base con easing
                let increment = (target - prev) * 0.08;

                // Ralentizar en etapas pesadas para realismo
                if (prev > 25 && prev < 40) increment *= 0.4;  // Transcripción
                if (prev > 60 && prev < 75) increment *= 0.5;  // Generación imágenes
                if (prev > 85 && prev < 95) increment *= 0.3;  // Renderizado

                increment = Math.max(increment, 0.15);
                const next = Math.min(prev + increment, target);
                return Math.round(next * 10) / 10;
            });
        }, 50);

        return () => clearInterval(interval);
    }, [currentProgress]);

    // Inyección de logs atmosféricos según progreso
    useEffect(() => {
        const logIndex = Math.floor((displayProgress / 100) * ATMOSPHERIC_LOGS.length);

        if (logIndex > lastAtmosphericLogRef.current && logIndex < ATMOSPHERIC_LOGS.length) {
            if (Math.random() > 0.6) {
                const log = ATMOSPHERIC_LOGS[logIndex];
                addLog(log.level as LogEntry['level'], log.msg);
            }
            lastAtmosphericLogRef.current = logIndex;
        }
    }, [displayProgress, addLog]);

    // Logs basados en cambios reales de jobs
    useEffect(() => {
        const currentJobsState = JSON.stringify(jobs.map(j => ({ type: j.type, status: j.status })));
        if (currentJobsState === prevJobsRef.current) return;
        prevJobsRef.current = currentJobsState;

        jobs.forEach(job => {
            const label = JOB_LABELS[job.type]?.name || job.type;

            if (job.status === 'PROCESSING') {
                addLog('INFO', `Starting ${label.toLowerCase()} module...`);
            } else if (job.status === 'COMPLETED') {
                addLog('SUCCESS', `${label} completed successfully`);
            } else if (job.status === 'FAILED') {
                addLog('ERROR', `${label} failed - check system logs`);
            }
        });
    }, [jobs, addLog]);

    // Logs iniciales
    useEffect(() => {
        addLog('INFO', 'Initializing Luma processing engine...');
        addLog('INFO', `Project loaded: "${projectTitle}"`);
        addLog('SUCCESS', 'Neural architecture initialized');

        const timer = setTimeout(() => {
            addLog('INFO', 'Establishing connection with render cluster...');
        }, 1500);

        return () => clearTimeout(timer);
    }, [projectTitle, addLog]);

    // Logs de generación de escenas
    useEffect(() => {
        if (sceneInfo && sceneInfo.current > 0) {
            addLog('INFO', `Synthesizing scene ${sceneInfo.current}/${sceneInfo.total}...`);
        }
    }, [sceneInfo?.current, sceneInfo?.total, addLog]);

    // Auto-scroll de logs
    useEffect(() => {
        logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    // Cálculos SVG
    const CIRCUMFERENCE = 691;
    const strokeDashoffset = CIRCUMFERENCE - (displayProgress / 100) * CIRCUMFERENCE;

    // Job actual en procesamiento
    const currentJob = jobs.find(j => j.status === 'PROCESSING');
    const currentJobLabel = currentJob ? JOB_LABELS[currentJob.type] : null;

    return (
        <div className="fixed inset-0 z-50 bg-stitch-bg flex flex-col p-6 md:p-12 overflow-hidden font-sans">

            {/* Header */}
            <header className="flex justify-between items-center mb-8">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-stitch-cyan rounded-lg flex items-center justify-center">
                        <Film size={16} className="text-black" />
                    </div>
                    <span className="text-xl font-black text-white tracking-tight">Luma</span>
                </div>
                <div className={`flex items-center gap-2 text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-full border ${
                    isConnected
                        ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                        : 'text-gray-500 bg-gray-500/10 border-gray-500/20'
                }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-gray-600'}`} />
                    {isConnected ? 'System Operational' : 'Connecting...'}
                </div>
            </header>

            {/* Main Content */}
            <div className="flex-1 flex flex-col lg:flex-row gap-8 max-w-7xl mx-auto w-full overflow-hidden">

                {/* Izquierda: Círculo de Progreso */}
                <div className="flex-[2] glass-stitch rounded-3xl flex flex-col items-center justify-center p-8 md:p-12 text-center relative overflow-hidden">

                    {/* Background Preview */}
                    <AnimatePresence>
                        {currentPreview && (
                            <m.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 0.15 }}
                                exit={{ opacity: 0 }}
                                className="absolute inset-0"
                            >
                                <img
                                    src={currentPreview}
                                    alt="Preview"
                                    className="w-full h-full object-cover blur-2xl scale-110"
                                />
                            </m.div>
                        )}
                    </AnimatePresence>

                    {/* SVG Círculo Animado */}
                    <div className="relative w-56 h-56 md:w-64 md:h-64 mb-10 z-10">
                        <svg className="w-full h-full transform -rotate-90 drop-shadow-2xl">
                            <circle
                                cx="50%"
                                cy="50%"
                                r="110"
                                stroke="currentColor"
                                strokeWidth="8"
                                fill="transparent"
                                className="text-white/10"
                            />
                            <m.circle
                                cx="50%"
                                cy="50%"
                                r="110"
                                stroke="currentColor"
                                strokeWidth="8"
                                fill="transparent"
                                strokeLinecap="round"
                                className="text-stitch-cyan"
                                strokeDasharray={CIRCUMFERENCE}
                                initial={{ strokeDashoffset: CIRCUMFERENCE }}
                                animate={{ strokeDashoffset }}
                                transition={{ duration: 0.3, ease: 'easeOut' }}
                            />
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <m.span
                                key={Math.round(displayProgress)}
                                initial={{ scale: 1.05, opacity: 0.8 }}
                                animate={{ scale: 1, opacity: 1 }}
                                transition={{ duration: 0.15 }}
                                className="text-5xl md:text-6xl font-black text-white tracking-tighter"
                            >
                                {Math.round(displayProgress)}%
                            </m.span>
                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em] mt-2">
                                Processing
                            </span>
                        </div>
                    </div>

                    {/* Status Text */}
                    <div className="z-10 space-y-3">
                        <h2 className="text-xl md:text-2xl font-bold text-white animate-pulse">
                            {currentJobLabel?.name || 'Processing'}
                        </h2>
                        <p className="text-gray-500 max-w-sm text-sm">
                            {currentJobLabel?.description || statusMessage}
                        </p>

                        {sceneInfo && sceneInfo.total > 0 && (
                            <div className="mt-4">
                                <span className="text-xs font-bold text-stitch-cyan uppercase tracking-widest">
                                    Scene {sceneInfo.current} / {sceneInfo.total}
                                </span>
                            </div>
                        )}
                    </div>

                    {/* Mini Preview Flotante */}
                    <AnimatePresence>
                        {currentPreview && (
                            <m.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -20 }}
                                className="absolute bottom-6 right-6 z-10"
                            >
                                <div className="w-32 h-20 rounded-xl overflow-hidden border-2 border-stitch-cyan/50 shadow-lg">
                                    <img
                                        src={currentPreview}
                                        alt="Current scene"
                                        className="w-full h-full object-cover"
                                    />
                                </div>
                                <span className="absolute -top-2 -right-2 bg-stitch-cyan text-black text-[9px] font-bold px-2 py-0.5 rounded-full">
                                    LIVE
                                </span>
                            </m.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Derecha: Pipeline & Consola */}
                <div className="flex-1 flex flex-col gap-6 overflow-hidden min-w-0 lg:min-w-[320px]">

                    {/* Pipeline Visual */}
                    <div className="glass-stitch rounded-3xl p-6 flex-shrink-0">
                        <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-5">
                            Pipeline Logic
                        </h3>
                        <div className="space-y-4">
                            {JOB_ORDER.map((type) => {
                                const job = jobs.find(j => j.type === type);
                                const status = job?.status || 'PENDING';
                                const label = JOB_LABELS[type];
                                const isActive = status === 'PROCESSING';
                                const isCompleted = status === 'COMPLETED';
                                const isFailed = status === 'FAILED';

                                return (
                                    <div
                                        key={type}
                                        className={`flex items-center gap-4 transition-all duration-300 ${
                                            isCompleted ? 'text-emerald-500' :
                                            isActive ? 'text-stitch-cyan' :
                                            isFailed ? 'text-rose-500' :
                                            'text-gray-600 opacity-40'
                                        }`}
                                    >
                                        {isCompleted ? (
                                            <CheckCircle size={20} />
                                        ) : isActive ? (
                                            <Loader2 size={20} className="animate-spin" />
                                        ) : isFailed ? (
                                            <AlertCircle size={20} />
                                        ) : (
                                            <Circle size={20} />
                                        )}
                                        <div>
                                            <span className={`text-sm font-bold block ${isActive ? 'text-stitch-cyan' : ''}`}>
                                                {label.name}
                                            </span>
                                            {(isActive || isCompleted || isFailed) && (
                                                <span className="text-[10px] uppercase tracking-wider opacity-70">
                                                    {isCompleted ? 'Completed' :
                                                     isActive ? label.description :
                                                     isFailed ? 'Failed' : ''}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Consola Estilo Terminal */}
                    <div className="flex-1 bg-[#0A0A0A] rounded-3xl p-4 md:p-6 font-mono text-[11px] overflow-hidden flex flex-col border border-white/5 shadow-inner min-h-0">
                        <div className="flex justify-between items-center mb-4 text-gray-500 border-b border-gray-800 pb-2 flex-shrink-0">
                            <span className="uppercase tracking-wider">System Console</span>
                            <span className="bg-gray-800 px-1.5 py-0.5 rounded text-[9px]">v2.4.0</span>
                        </div>
                        <div className="flex-1 overflow-y-auto space-y-1.5 pr-2 min-h-0">
                            {logs.map((log) => (
                                <m.p
                                    key={log.id}
                                    initial={{ opacity: 0, x: -10 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    transition={{ duration: 0.2 }}
                                    className="leading-relaxed break-words"
                                >
                                    <span className="text-gray-600 opacity-60 mr-2 select-none">{log.timestamp}</span>
                                    <span className={`font-bold mr-2 ${
                                        log.level === 'SUCCESS' ? 'text-emerald-400' :
                                        log.level === 'WARN' ? 'text-amber-400' :
                                        log.level === 'ERROR' ? 'text-rose-400' :
                                        'text-sky-400'
                                    }`}>
                                        [{log.level}]
                                    </span>
                                    <span className="text-gray-300">{log.message}</span>
                                </m.p>
                            ))}
                            <div ref={logsEndRef} />

                            {/* Cursor parpadeante */}
                            {displayProgress < 100 && (
                                <div className="flex items-center gap-1 mt-2 text-stitch-cyan animate-pulse">
                                    <span>_</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
