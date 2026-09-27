export function IntroVideo() {
  return (
    <video
      className="relative aspect-video w-full rounded-2xl border border-white/10 bg-[#0b1622] object-cover shadow-[0_30px_100px_rgba(0,0,0,.45)]"
      src="/media/handsel-explainer.mp4"
      poster="/media/handsel-explainer-poster.jpg"
      muted
      playsInline
      controls
      preload="metadata"
      aria-label="58-second film introducing Handsel's x402 payment, escrow, independent review, and work proof flow"
    >
      Your browser does not support video. The task, review, and payment process is described next to this video.
    </video>
  )
}
