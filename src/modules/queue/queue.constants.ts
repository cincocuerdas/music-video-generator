export const QUEUE_NAMES = {
  YOUTUBE_DOWNLOAD: 'youtube-download',
  TRANSCRIPTION: 'transcription',
  ANALYSIS: 'analysis',
  IMAGE_GENERATION: 'image-generation',
  VIDEO_RENDER: 'video-render',
  TRAIN_LORA: 'train-lora',
  NOTIFICATION: 'notification',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
