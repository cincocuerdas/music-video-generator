import React, { useCallback, useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { sileo } from 'sileo';
import { projectService } from '../services/api';
import type { FeedbackData } from '../services/api';
import { useLanguage } from '../contexts/LanguageContext';

interface FeedbackButtonsProps {
  projectId: string;
  currentPrompt: string;
  currentTime?: number;
  sceneIndex?: number;
  style?: string;
  variant?: 'floating' | 'inline' | 'static';
  onFeedbackSent?: (score: number) => void;
}

type FeedbackStatus = 'idle' | 'voting';

export const FeedbackButtons: React.FC<FeedbackButtonsProps> = ({
  projectId,
  currentPrompt,
  currentTime,
  sceneIndex,
  style,
  variant = 'floating',
  onFeedbackSent,
}) => {
  const { t } = useLanguage();
  const [status, setStatus] = useState<FeedbackStatus>('idle');
  const [lastVote, setLastVote] = useState<'like' | 'dislike' | null>(null);

  const handleVote = useCallback(
    async (voteType: 'like' | 'dislike') => {
      if (status === 'voting') return;

      const score = voteType === 'like' ? 1 : -1;
      setStatus('voting');
      setLastVote(voteType);

      try {
        const feedbackData: FeedbackData = {
          score,
          prompt: currentPrompt,
          frameTime: currentTime ? Math.floor(currentTime) : undefined,
          sceneIndex,
          style,
          tags: [],
        };

        await projectService.sendFeedback(projectId, feedbackData);
        setStatus('idle');
        onFeedbackSent?.(score);

        sileo.success({
          title: voteType === 'like' ? t('feedback.savedLike') : t('feedback.savedDislike'),
        });
      } catch (error) {
        console.error('Failed to send feedback:', error);
        setStatus('idle');
        setLastVote(null);

        sileo.error({
          title: t('feedback.saveError'),
        });
      }
    },
    [projectId, currentPrompt, currentTime, sceneIndex, style, status, onFeedbackSent, t],
  );

  if (variant === 'floating') {
    return (
      <div className="absolute bottom-4 right-4 z-50 group/feedback">
        <div className="absolute bottom-full right-0 mb-2 opacity-0 group-hover/feedback:opacity-100 transition-opacity duration-300 pointer-events-none">
          <span className="text-white/50 text-xs whitespace-nowrap">{t('feedback.hintQuestion')}</span>
        </div>

        <div
          className="
            bg-black/50 backdrop-blur-md border border-white/10 p-1.5 rounded-full
            flex gap-1 shadow-2xl transition-all duration-300
            opacity-0 translate-y-2 group-hover/feedback:opacity-100 group-hover/feedback:translate-y-0
            hover:bg-black/70 hover:border-white/20
          "
        >
          <button
            onClick={() => handleVote('like')}
            disabled={status === 'voting'}
            className={`
              p-2.5 rounded-full transition-all duration-200
              hover:scale-110 active:scale-95 disabled:opacity-50
              ${
                lastVote === 'like' && status === 'voting'
                  ? 'text-green-400 bg-green-500/30 shadow-[0_0_20px_rgba(74,222,128,0.4)]'
                  : 'text-gray-300 hover:text-green-400 hover:bg-green-500/20'
              }
            `}
            title="Me gusta - Guardar este estilo"
          >
            <ThumbsUp size={20} strokeWidth={2} />
          </button>

          <div className="w-px bg-white/10 my-1" />

          <button
            onClick={() => handleVote('dislike')}
            disabled={status === 'voting'}
            className={`
              p-2.5 rounded-full transition-all duration-200
              hover:scale-110 active:scale-95 disabled:opacity-50
              ${
                lastVote === 'dislike' && status === 'voting'
                  ? 'text-red-400 bg-red-500/30 shadow-[0_0_20px_rgba(248,113,113,0.4)]'
                  : 'text-gray-300 hover:text-red-400 hover:bg-red-500/20'
              }
            `}
            title={t('feedback.dislikeTitle')}
          >
            <ThumbsDown size={20} strokeWidth={2} />
          </button>
        </div>
      </div>
    );
  }

  if (variant === 'static') {
    return (
      <div className="flex items-center gap-2 bg-gray-800/80 border border-gray-700 rounded-lg px-3 py-2">
        <button
          onClick={() => handleVote('like')}
          disabled={status === 'voting'}
          className={`
            flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all duration-200
            ${
              lastVote === 'like' && status === 'voting'
                ? 'text-green-400 bg-green-500/30 shadow-[0_0_15px_rgba(74,222,128,0.3)]'
                : 'text-gray-300 hover:text-green-400 hover:bg-green-500/20'
            }
          `}
          title={t('feedback.like')}
        >
          <ThumbsUp size={18} />
          <span className="text-sm font-medium">{t('feedback.like')}</span>
        </button>

        <div className="w-px h-6 bg-gray-600" />

        <button
          onClick={() => handleVote('dislike')}
          disabled={status === 'voting'}
          className={`
            flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all duration-200
            ${
              lastVote === 'dislike' && status === 'voting'
                ? 'text-red-400 bg-red-500/30 shadow-[0_0_15px_rgba(248,113,113,0.3)]'
                : 'text-gray-300 hover:text-red-400 hover:bg-red-500/20'
            }
          `}
          title={t('feedback.dislikeTitle')}
        >
          <ThumbsDown size={18} />
          <span className="text-sm font-medium">{t('feedback.improve')}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex gap-1 bg-black/40 backdrop-blur-sm rounded-full p-1">
      <button
        onClick={() => handleVote('like')}
        disabled={status === 'voting'}
        className={`
          p-1.5 rounded-full transition-all duration-200
          ${
            lastVote === 'like'
              ? 'text-green-400 bg-green-500/30'
              : 'text-gray-400 hover:text-green-400 hover:bg-green-500/20'
          }
        `}
      >
        <ThumbsUp size={14} />
      </button>
      <button
        onClick={() => handleVote('dislike')}
        disabled={status === 'voting'}
        className={`
          p-1.5 rounded-full transition-all duration-200
          ${
            lastVote === 'dislike'
              ? 'text-red-400 bg-red-500/30'
              : 'text-gray-400 hover:text-red-400 hover:bg-red-500/20'
          }
        `}
      >
        <ThumbsDown size={14} />
      </button>
    </div>
  );
};
