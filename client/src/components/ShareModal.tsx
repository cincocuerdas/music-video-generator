import React, { useState, useEffect } from 'react';
import { X, Copy, Check, Twitter, Facebook, Link2, Mail, MessageCircle } from 'lucide-react';
import { m, AnimatePresence } from 'framer-motion';

interface ShareModalProps {
    isOpen: boolean;
    onClose: () => void;
    projectId: string;
    projectTitle: string;
    videoUrl?: string;
}

export const ShareModal: React.FC<ShareModalProps> = ({
    isOpen,
    onClose,
    projectId,
    projectTitle,
    videoUrl,
}) => {
    const [copied, setCopied] = useState(false);
    const shareUrl = `${window.location.origin}/project/${projectId}`;

    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        if (isOpen) {
            document.addEventListener('keydown', handleEscape);
            document.body.style.overflow = 'hidden';
        }
        return () => {
            document.removeEventListener('keydown', handleEscape);
            document.body.style.overflow = '';
        };
    }, [isOpen, onClose]);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(shareUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    const shareLinks = [
        {
            name: 'Twitter',
            icon: Twitter,
            color: 'hover:bg-sky-500/20 hover:text-sky-400',
            url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(`Check out "${projectTitle}" - AI Music Video`)}&url=${encodeURIComponent(shareUrl)}`,
        },
        {
            name: 'Facebook',
            icon: Facebook,
            color: 'hover:bg-blue-500/20 hover:text-blue-400',
            url: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`,
        },
        {
            name: 'WhatsApp',
            icon: MessageCircle,
            color: 'hover:bg-emerald-500/20 hover:text-emerald-400',
            url: `https://wa.me/?text=${encodeURIComponent(`${projectTitle} - ${shareUrl}`)}`,
        },
        {
            name: 'Email',
            icon: Mail,
            color: 'hover:bg-orange-500/20 hover:text-orange-400',
            url: `mailto:?subject=${encodeURIComponent(`Check out: ${projectTitle}`)}&body=${encodeURIComponent(`I created this AI music video:\n\n${shareUrl}`)}`,
        },
    ];

    return (
        <AnimatePresence>
            {isOpen && (
                <m.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="fixed inset-0 z-50 flex items-center justify-center p-4"
                >
                    {/* Backdrop */}
                    <m.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-black/70 backdrop-blur-xl"
                        onClick={onClose}
                    />

                    {/* Modal */}
                    <m.div
                        initial={{ opacity: 0, scale: 0.95, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 20 }}
                        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                        className="relative w-full max-w-md"
                    >
                        <div className="glass-stitch rounded-3xl overflow-hidden shadow-2xl border border-stitch-border/50">
                            {/* Header */}
                            <div className="p-8 pb-0">
                                <div className="flex justify-between items-start">
                                    <div className="space-y-2">
                                        <h2 className="text-xl font-bold text-white">Share Video</h2>
                                        <p className="text-gray-500 text-sm">Anyone with the link can view this.</p>
                                    </div>
                                    <button
                                        onClick={onClose}
                                        className="text-gray-500 hover:text-white transition-colors p-1 hover:bg-white/10 rounded-lg"
                                    >
                                        <X size={20} />
                                    </button>
                                </div>
                            </div>

                            {/* Content */}
                            <div className="p-8 space-y-8">
                                {/* Share Link */}
                                <div className="space-y-3">
                                    <label htmlFor="share-link-input" className="text-[10px] font-bold uppercase tracking-widest text-gray-500 flex items-center gap-2">
                                        <Link2 size={12} />
                                        Share Link
                                    </label>
                                    <div className="flex bg-black/40 border border-stitch-border/50 rounded-xl overflow-hidden group focus-within:border-stitch-cyan/50 transition-colors">
                                        <input
                                            id="share-link-input"
                                            type="text"
                                            readOnly
                                            value={shareUrl}
                                            className="bg-transparent border-none flex-1 px-4 py-3 text-sm text-gray-300 focus:ring-0 focus:outline-none font-mono"
                                        />
                                        <button
                                            onClick={handleCopy}
                                            className={`px-5 py-3 font-bold text-sm transition-all duration-300 flex items-center gap-2 ${copied
                                                    ? 'bg-emerald-500 text-white'
                                                    : 'bg-stitch-cyan text-black hover:bg-stitch-cyan/80'
                                                }`}
                                        >
                                            {copied ? (
                                                <>
                                                    <Check size={16} />
                                                    Copied
                                                </>
                                            ) : (
                                                <>
                                                    <Copy size={16} />
                                                    Copy
                                                </>
                                            )}
                                        </button>
                                    </div>
                                </div>

                                {/* Social Share */}
                                <div className="space-y-4">
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
                                        Share on Social
                                    </span>
                                    <div className="flex justify-between">
                                        {shareLinks.map((social) => (
                                            <a
                                                key={social.name}
                                                href={social.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className={`flex flex-col items-center gap-2 group cursor-pointer transition-all duration-300`}
                                            >
                                                <div className={`w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center transition-all duration-300 ${social.color}`}>
                                                    <social.icon size={22} className="text-gray-400 group-hover:scale-110 transition-transform" />
                                                </div>
                                                <span className="text-[10px] text-gray-500 font-medium group-hover:text-gray-300 transition-colors">
                                                    {social.name}
                                                </span>
                                            </a>
                                        ))}
                                    </div>
                                </div>

                                {/* Download hint */}
                                {videoUrl && (
                                    <div className="pt-4 border-t border-stitch-border/30">
                                        <p className="text-[11px] text-gray-600 text-center">
                                            Video URL is included • Recipients can watch directly
                                        </p>
                                    </div>
                                )}
                            </div>

                            {/* Footer */}
                            <button
                                onClick={onClose}
                                className="w-full py-4 text-gray-500 hover:text-white text-sm font-medium border-t border-stitch-border/30 hover:bg-white/5 transition-all"
                            >
                                Done
                            </button>
                        </div>
                    </m.div>
                </m.div>
            )}
        </AnimatePresence>
    );
};
