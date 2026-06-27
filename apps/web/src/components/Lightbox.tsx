import { useEffect } from "react";
import { Download } from "lucide-react";
import { useStudio } from "../store";
import { api } from "../api";
import { Button, buttonVariants } from "./ui";

/** Full-size image preview overlay. Opened by clicking a node's thumbnail. */
export function Lightbox() {
  const { lightboxHash, closeLightbox } = useStudio();

  useEffect(() => {
    if (!lightboxHash) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxHash, closeLightbox]);

  if (!lightboxHash) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8 backdrop-blur-sm"
      onClick={closeLightbox}
    >
      <div
        className="flex max-h-full flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={api.assetUrl(lightboxHash)}
          alt="full preview"
          className="max-h-[78vh] max-w-[80vw] rounded-lg object-contain shadow-2xl ring-1 ring-white/10"
        />
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-faint">
            {lightboxHash.slice(0, 16)}…
          </span>
          <a
            href={api.assetUrl(lightboxHash)}
            download={`vengine-${lightboxHash.slice(0, 8)}.png`}
            className={buttonVariants({ variant: "accent", size: "lg" })}
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </a>
          <Button variant="secondary" size="lg" onClick={closeLightbox}>
            Close (Esc)
          </Button>
        </div>
      </div>
    </div>
  );
}
