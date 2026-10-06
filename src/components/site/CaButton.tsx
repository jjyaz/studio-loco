import { useRef, useState } from "react";
import { CA_ADDRESS } from "@/lib/ca";

export function CaButton({ compact = false }: { compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(CA_ADDRESS);
      ok = true;
    } catch {
      // Clipboard API can be blocked (e.g. older browsers); fall back to a hidden textarea.
      const ta = document.createElement("textarea");
      ta.value = CA_ADDRESS;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    if (ok) {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={CA_ADDRESS}
      aria-label={`Copy contract address ${CA_ADDRESS}`}
      className={`station-code border border-line px-3 text-cream transition-colors hover:border-amber hover:text-amber ${
        compact ? "min-h-9 text-xs" : "min-h-11"
      }`}
    >
      {copied ? "CA copied" : "CA"}
    </button>
  );
}
