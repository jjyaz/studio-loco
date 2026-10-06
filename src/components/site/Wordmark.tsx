import { cn } from "@/lib/utils";

/** Pixel wordmark echoing the original Studio Loco logo: cream pixel letters with a hard offset shadow. */
export function Wordmark({ className, size = "md" }: { className?: string; size?: "sm" | "md" | "xl" }) {
  return (
    <span
      className={cn(
        "pixel inline-block font-bold uppercase text-cream",
        size === "sm" && "text-base",
        size === "md" && "text-xl",
        size === "xl" && "text-5xl md:text-7xl",
        className,
      )}
      style={{ textShadow: "2px 2px 0 var(--midnight)" }}
    >
      Studio Loco
    </span>
  );
}

/** Small custom rail icons (SVG, crisp). */
export function RailIcon({ kind, className }: { kind: "train" | "station" | "signal" | "lab" | "switch" | "ticket" | "rail"; className?: string }) {
  const common = { className: cn("size-6", className), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, "aria-hidden": true } as const;
  switch (kind) {
    case "train":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="12" />
          <path d="M4 10h16M8 16l-2 4M16 16l2 4M7 7h3M14 7h3" />
        </svg>
      );
    case "station":
      return (
        <svg {...common}>
          <path d="M3 9l9-5 9 5M5 9v11h14V9M9 20v-6h6v6" />
        </svg>
      );
    case "signal":
      return (
        <svg {...common}>
          <rect x="8" y="2" width="8" height="14" />
          <circle cx="12" cy="6" r="1.6" />
          <circle cx="12" cy="11.5" r="1.6" />
          <path d="M12 16v6M8 22h8" />
        </svg>
      );
    case "lab":
      return (
        <svg {...common}>
          <path d="M9 3h6M10 3v6l-5 10h14l-5-10V3M7.5 15h9" />
        </svg>
      );
    case "switch":
      return (
        <svg {...common}>
          <path d="M3 18h7l7-12h4M3 6h7l2 3.5M14.5 14l2.5 4h4" />
        </svg>
      );
    case "ticket":
      return (
        <svg {...common}>
          <path d="M3 7h18v3a2 2 0 000 4v3H3v-3a2 2 0 000-4z" />
          <path d="M14 7v10" strokeDasharray="2 2" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M2 9h20M2 15h20M5 6v12M10 6v12M14 6v12M19 6v12" />
        </svg>
      );
  }
}
