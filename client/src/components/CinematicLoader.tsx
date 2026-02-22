import React, { useReducer, useState, useRef, useCallback, useEffect } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { Film, Clapperboard, ThumbsUp, ThumbsDown, Check, Zap, Activity } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

type FeedbackType = 'boost' | 'correct';
type FeedbackStatus = 'idle' | 'charging' | 'sending' | 'received' | 'applied';

type FeedbackState = { status: FeedbackStatus; lastType: FeedbackType | null };
type FeedbackAction =
  | { type: 'SET_STATUS'; status: FeedbackStatus }
  | { type: 'SEND'; lastType: FeedbackType }
  | { type: 'RESET' };

function feedbackReducer(state: FeedbackState, action: FeedbackAction): FeedbackState {
  switch (action.type) {
    case 'SET_STATUS': return { ...state, status: action.status };
    case 'SEND': return { status: 'sending', lastType: action.lastType };
    case 'RESET': return { status: 'idle', lastType: null };
    default: return state;
  }
}

interface CinematicLoaderProps {
  progress: number;
  statusMessage: string;
  isExposing: boolean;
  coverImage?: string;
  currentPreview?: string | null;
  sceneInfo?: {
    current: number;
    total: number;
  };
  // 🎬 LIVE STEERING
  onLiveFeedback?: (type: FeedbackType, sceneIndex: number, intensity: number) => Promise<void>;
  isGeneratingImages?: boolean;
  // WebSocket status updates (optional, from parent)
  steeringStatus?: {
    status: FeedbackStatus;
    message?: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const MIN_INTENSITY = 1.0;
const MAX_INTENSITY = 2.0;
const INTENSITY_INCREMENT = 0.05;
const CHARGE_INTERVAL_MS = 50;
const FEEDBACK_RESET_MS = 2500;

const FILM_STRIP_FRAMES = Array.from({ length: 20 }, (_, i) => `frame-${i}`);

export const CinematicLoader: React.FC<CinematicLoaderProps> = ({
  progress,
  statusMessage,
  isExposing,
  coverImage,
  currentPreview,
  sceneInfo,
  onLiveFeedback,
  isGeneratingImages = false,
  steeringStatus
}) => {
  const { t } = useLanguage();
  // ═══════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════

  const [feedback, dispatch] = useReducer(feedbackReducer, { status: 'idle', lastType: null });

  // Long press intensity state
  const [intensity, setIntensity] = useState(MIN_INTENSITY);
  const [activeButton, setActiveButton] = useState<FeedbackType | null>(null);
  const chargeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isPressingRef = useRef(false);

  // Derived state
  const displayImage = currentPreview || coverImage;
  const isLive = !!currentPreview && isExposing;
  const currentScene = sceneInfo?.current || 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // SYNC WITH PARENT'S WEBSOCKET STATUS
  // ═══════════════════════════════════════════════════════════════════════════

  useEffect(() => {
    if (!steeringStatus?.status) return;
    dispatch({ type: 'SET_STATUS', status: steeringStatus.status });

    if (steeringStatus.status === 'applied') {
      const timer = setTimeout(() => dispatch({ type: 'RESET' }), FEEDBACK_RESET_MS);
      return () => clearTimeout(timer);
    }
  }, [steeringStatus]);

  // ═══════════════════════════════════════════════════════════════════════════
  // LONG PRESS HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════

  const startCharging = useCallback((type: FeedbackType) => {
    if (feedback.status === 'sending') return;

    isPressingRef.current = true;
    setActiveButton(type);
    setIntensity(MIN_INTENSITY);
    dispatch({ type: 'SET_STATUS', status: 'charging' });

    // Increment intensity every 50ms
    chargeTimerRef.current = setInterval(() => {
      if (!isPressingRef.current) return;

      setIntensity(prev => {
        const next = prev + INTENSITY_INCREMENT;
        return next >= MAX_INTENSITY ? MAX_INTENSITY : next;
      });
    }, CHARGE_INTERVAL_MS);
  }, [feedback.status]);

  const stopCharging = useCallback(async (type: FeedbackType) => {
    // Clear the charging timer
    if (chargeTimerRef.current) {
      clearInterval(chargeTimerRef.current);
      chargeTimerRef.current = null;
    }

    // Only send if we were actually pressing this button
    if (!isPressingRef.current || activeButton !== type) {
      setActiveButton(null);
      setIntensity(MIN_INTENSITY);
      dispatch({ type: 'SET_STATUS', status: 'idle' });
      return;
    }

    isPressingRef.current = false;
    const finalIntensity = intensity;

    // Send the feedback
    if (onLiveFeedback) {
      dispatch({ type: 'SEND', lastType: type });

      try {
        await onLiveFeedback(type, currentScene, finalIntensity);
        // Status will be updated by WebSocket events from parent
        // But if no WebSocket, fallback to local status
        if (!steeringStatus) {
          dispatch({ type: 'SET_STATUS', status: 'received' });
          setTimeout(() => dispatch({ type: 'RESET' }), FEEDBACK_RESET_MS);
        }
      } catch (error) {
        console.error('Failed to send feedback:', error);
        dispatch({ type: 'RESET' });
      }
    }

    // Reset
    setActiveButton(null);
    setIntensity(MIN_INTENSITY);
  }, [intensity, activeButton, currentScene, onLiveFeedback, steeringStatus]);

  const cancelCharging = useCallback(() => {
    if (chargeTimerRef.current) {
      clearInterval(chargeTimerRef.current);
      chargeTimerRef.current = null;
    }
    isPressingRef.current = false;
    setActiveButton(null);
    setIntensity(MIN_INTENSITY);
    if (feedback.status === 'charging') {
      dispatch({ type: 'SET_STATUS', status: 'idle' });
    }
  }, [feedback.status]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (chargeTimerRef.current) {
        clearInterval(chargeTimerRef.current);
      }
    };
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER: Calculate visual intensity percentage (0-100%)
  // ═══════════════════════════════════════════════════════════════════════════

  const intensityPercent = ((intensity - MIN_INTENSITY) / (MAX_INTENSITY - MIN_INTENSITY)) * 100;

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden bg-gradient-to-b from-gray-900 via-gray-950 to-black">

      {/* ═══════════════════════════════════════════════════════════════════════════ */}
      {/* 1. FILM STRIP ANIMADO */}
      {/* ═══════════════════════════════════════════════════════════════════════════ */}
      <div className="absolute top-0 left-0 w-full h-8 opacity-30 overflow-hidden">
        <m.div
          className="flex"
          animate={{ x: isExposing ? [-0, -192] : 0 }}
          transition={{ repeat: Infinity, duration: 0.5, ease: "linear" }}
        >
          {FILM_STRIP_FRAMES.map((id) => (
            <div key={id} className="flex-shrink-0 w-12 h-8 border-x border-gray-700 bg-gray-900 flex items-center justify-center">
              <div className="w-6 h-4 bg-gray-800 rounded-sm" />
            </div>
          ))}
        </m.div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════════ */}
      {/* 2. MONITOR DE RODAJE */}
      {/* ═══════════════════════════════════════════════════════════════════════════ */}
      <div className="relative z-10 flex flex-col items-center">

        <div className="relative">
          {/* Monitor bezel */}
          <div className="relative w-72 h-44 bg-gray-900 rounded-lg border-4 border-gray-700 shadow-2xl overflow-hidden">

            {/* Screen */}
            <div className="absolute inset-1 bg-black rounded overflow-hidden">
              <AnimatePresence mode="wait">
                {displayImage ? (
                  <m.img
                    key={displayImage}
                    src={displayImage}
                    initial={{ opacity: 0, scale: 1.1 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.4 }}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <m.div
                    className="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-900 to-black"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                  >
                    <Film className="text-gray-700 animate-pulse" size={48} />
                  </m.div>
                )}
              </AnimatePresence>

              {/* Scanlines */}
              <div className="absolute inset-0 pointer-events-none bg-[repeating-linear-gradient(0deg,transparent,transparent_2px,rgba(0,0,0,0.1)_2px,rgba(0,0,0,0.1)_4px)]" />

              {/* Vignette */}
              <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle,transparent_50%,rgba(0,0,0,0.4)_100%)]" />

              {/* Feedback flash overlay */}
              <AnimatePresence>
                {feedback.lastType && feedback.status !== 'idle' && (
                  <m.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className={`absolute inset-0 pointer-events-none ${feedback.lastType === 'boost'
                        ? 'bg-green-500/20 border-2 border-green-400'
                        : 'bg-amber-500/20 border-2 border-amber-400'
                      }`}
                  />
                )}
              </AnimatePresence>
            </div>

            {/* 🔴 LIVE Indicator */}
            {isLive && (
              <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-black/70 px-2 py-0.5 rounded">
                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
                <span className="text-red-400 text-xs font-bold tracking-wider">REC</span>
              </div>
            )}

            {/* Scene Counter */}
            {sceneInfo && sceneInfo.total > 0 && (
              <div className="absolute top-3 right-3 bg-black/70 px-2 py-0.5 rounded">
                <span className="text-amber-400 text-xs font-mono">
                  {String(sceneInfo.current).padStart(2, '0')}/{String(sceneInfo.total).padStart(2, '0')}
                </span>
              </div>
            )}

            {/* Feedback status badge */}
            <AnimatePresence>
              {feedback.status !== 'idle' && feedback.status !== 'charging' && (
                <m.div
                  initial={{ opacity: 0, scale: 0.8, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className={`absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1 rounded-full ${feedback.lastType === 'boost'
                      ? 'bg-green-500/80 text-white'
                      : 'bg-amber-500/80 text-white'
                    }`}
                >
                  {feedback.status === 'sending' && <Activity size={14} className="animate-pulse" />}
                  {feedback.status === 'received' && <Check size={14} />}
                  {feedback.status === 'applied' && <Zap size={14} />}
                  <span className="text-xs font-bold">
                    {feedback.status === 'sending' && 'TRANSMITTING...'}
                    {feedback.status === 'received' && 'RECEIVED'}
                    {feedback.status === 'applied' && (feedback.lastType === 'boost' ? 'LOCKED IN' : 'ADJUSTING')}
                  </span>
                </m.div>
              )}
            </AnimatePresence>

            {/* Timecode */}
            <div className="absolute bottom-2 left-3 right-3 flex justify-between text-[10px] font-mono text-gray-500">
              <span>CAM A</span>
              <span>{new Date().toLocaleTimeString('en-US', { hour12: false })}</span>
            </div>
          </div>

          {/* Monitor stand */}
          <div className="w-16 h-3 bg-gray-700 mx-auto rounded-b-lg" />
          <div className="w-24 h-2 bg-gray-600 mx-auto rounded-b-lg" />
        </div>

        {/* ═══════════════════════════════════════════════════════════════════════════ */}
        {/* 3. DIRECTOR CONTROLS (Live Steering with Long Press) */}
        {/* ═══════════════════════════════════════════════════════════════════════════ */}
        {isGeneratingImages && currentPreview && onLiveFeedback && (
          <m.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-6 flex flex-col items-center gap-3"
          >
            {/* Intensity indicator when charging */}
            <AnimatePresence>
              {activeButton && (
                <m.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-mono ${activeButton === 'boost'
                      ? 'bg-green-900/50 text-green-300 border border-green-500/30'
                      : 'bg-amber-900/50 text-amber-300 border border-amber-500/30'
                    }`}
                >
                  <Activity size={12} className="animate-pulse" />
                  <span>INTENSITY: {Math.round(intensity * 100)}%</span>
                </m.div>
              )}
            </AnimatePresence>

            <div className="flex items-center gap-4">
              {/* ─── BOOST BUTTON ─── */}
              <button
                // Mouse events
                onMouseDown={() => startCharging('boost')}
                onMouseUp={() => stopCharging('boost')}
                onMouseLeave={cancelCharging}
                // Touch events (mobile)
                onTouchStart={() => startCharging('boost')}
                onTouchEnd={() => stopCharging('boost')}
                onTouchCancel={cancelCharging}
                disabled={feedback.status === 'sending'}
                className={`
                  relative overflow-hidden flex items-center gap-2 px-5 py-2.5 rounded-full
                  transition-all duration-200 group select-none
                  ${activeButton === 'boost' || feedback.lastType === 'boost'
                    ? 'bg-green-500 text-white'
                    : 'bg-green-500/10 border border-green-500/30 text-green-400 hover:bg-green-500/20'
                  }
                  disabled:opacity-50 disabled:cursor-not-allowed
                `}
                style={{
                  transform: activeButton === 'boost'
                    ? `scale(${1 + intensityPercent * 0.001})`
                    : 'scale(1)'
                }}
              >
                {/* Charging fill indicator */}
                {activeButton === 'boost' && (
                  <m.div
                    className="absolute inset-0 bg-green-400/30"
                    initial={{ width: 0 }}
                    animate={{ width: `${intensityPercent}%` }}
                    transition={{ duration: 0.05 }}
                  />
                )}
                <ThumbsUp size={18} className="group-hover:rotate-12 transition-transform z-10" />
                <div className="flex flex-col items-start leading-none z-10">
                  <span className="text-xs font-bold tracking-wider uppercase">Good Take</span>
                  <span className="text-[10px] opacity-60">
                    {activeButton === 'boost' ? 'Hold for power...' : t('loader.keepStyle')}
                  </span>
                </div>
              </button>

              {/* ─── CORRECT BUTTON ─── */}
              <button
                // Mouse events
                onMouseDown={() => startCharging('correct')}
                onMouseUp={() => stopCharging('correct')}
                onMouseLeave={cancelCharging}
                // Touch events (mobile)
                onTouchStart={() => startCharging('correct')}
                onTouchEnd={() => stopCharging('correct')}
                onTouchCancel={cancelCharging}
                disabled={feedback.status === 'sending'}
                className={`
                  relative overflow-hidden flex items-center gap-2 px-5 py-2.5 rounded-full
                  transition-all duration-200 group select-none
                  ${activeButton === 'correct' || feedback.lastType === 'correct'
                    ? 'bg-amber-500 text-white'
                    : 'bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20'
                  }
                  disabled:opacity-50 disabled:cursor-not-allowed
                `}
                style={{
                  transform: activeButton === 'correct'
                    ? `scale(${1 + intensityPercent * 0.001})`
                    : 'scale(1)'
                }}
              >
                {/* Charging fill indicator */}
                {activeButton === 'correct' && (
                  <m.div
                    className="absolute inset-0 bg-amber-400/30"
                    initial={{ width: 0 }}
                    animate={{ width: `${intensityPercent}%` }}
                    transition={{ duration: 0.05 }}
                  />
                )}
                <ThumbsDown size={18} className="group-hover:-rotate-12 transition-transform z-10" />
                <div className="flex flex-col items-start leading-none z-10">
                  <span className="text-xs font-bold tracking-wider uppercase">Adjust</span>
                  <span className="text-[10px] opacity-60">
                    {activeButton === 'correct' ? 'Hold for power...' : t('loader.changeDirection')}
                  </span>
                </div>
              </button>
            </div>
          </m.div>
        )}

        {/* Hint text */}
        {isGeneratingImages && currentPreview && onLiveFeedback && feedback.status === 'idle' && (
          <p className="mt-2 text-gray-500 text-xs text-center">
            {t('loader.holdForIntensity')}
          </p>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════════ */}
        {/* 4. STATUS & PROGRESS */}
        {/* ═══════════════════════════════════════════════════════════════════════════ */}
        <div className="mt-6 text-center">
          <div className="flex items-center justify-center gap-2 mb-3">
            <Clapperboard className={`text-gray-500 ${isExposing ? 'animate-pulse' : ''}`} size={20} />
            <span className="text-gray-400 text-xs uppercase tracking-[0.2em] font-medium">
              {isExposing ? 'Recording' : 'Standby'}
            </span>
          </div>

          <m.p
            key={statusMessage}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-lg text-white font-medium mb-4 min-h-[1.5rem]"
          >
            {statusMessage}
          </m.p>

          <div className="w-64 mx-auto">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Progress</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <m.div
                className="h-full bg-gradient-to-r from-blue-600 to-blue-400 rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════════ */}
      {/* 5. AMBIENT EFFECTS */}
      {/* ═══════════════════════════════════════════════════════════════════════════ */}
      {isLive && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-48 bg-blue-500/5 blur-3xl rounded-full" />
        </div>
      )}

      {/* Feedback glow effect */}
      <AnimatePresence>
        {feedback.lastType && feedback.status !== 'idle' && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 pointer-events-none"
          >
            <div className={`absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-48 blur-3xl rounded-full ${feedback.lastType === 'boost' ? 'bg-green-500/10' : 'bg-amber-500/10'
              }`} />
          </m.div>
        )}
      </AnimatePresence>

      {/* Charging glow effect */}
      <AnimatePresence>
        {activeButton && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: intensityPercent / 100 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 pointer-events-none"
          >
            <div className={`absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-48 blur-3xl rounded-full ${activeButton === 'boost' ? 'bg-green-500/20' : 'bg-amber-500/20'
              }`} />
          </m.div>
        )}
      </AnimatePresence>

      {/* Bottom film strip */}
      <div className="absolute bottom-0 left-0 w-full h-8 opacity-30 overflow-hidden">
        <m.div
          className="flex"
          animate={{ x: isExposing ? [0, -192] : 0 }}
          transition={{ repeat: Infinity, duration: 0.5, ease: "linear" }}
        >
          {FILM_STRIP_FRAMES.map((id) => (
            <div key={id} className="flex-shrink-0 w-12 h-8 border-x border-gray-700 bg-gray-900 flex items-center justify-center">
              <div className="w-6 h-4 bg-gray-800 rounded-sm" />
            </div>
          ))}
        </m.div>
      </div>
    </div>
  );
};
