import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const btn = cva(
  "inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 min-h-11 px-5 text-sm select-none",
  {
    variants: {
      variant: {
        primary: "bg-amber text-midnight hover:bg-cream",
        line: "border border-cream/60 text-cream hover:bg-cream hover:text-midnight",
        ghost: "text-cream/85 hover:text-amber",
        quiet: "bg-muted text-cream hover:bg-ultramarine",
        danger: "border border-destructive text-cream hover:bg-destructive",
      },
      size: { md: "", sm: "min-h-9 px-3 text-xs", lg: "min-h-13 px-7 text-base" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export const Btn = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof btn>>(
  ({ className, variant, size, type = "button", ...p }, ref) => (
    <button ref={ref} type={type} className={cn(btn({ variant, size }), "ticket-btn", className)} {...p} />
  ),
);
Btn.displayName = "Btn";

export function Panel({ className, children, tone = "card", as: As = "section" }: { className?: string; children: ReactNode; tone?: "card" | "cobalt"; as?: "section" | "div" | "article" }) {
  return <As className={cn("ticket p-5 md:p-6", tone === "cobalt" && "ticket-cobalt", className)}>{children}</As>;
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("station-code text-amber", className)}>{children}</p>;
}

export type Capability = "live" | "simulation" | "practice" | "not-deployed" | "handoff" | "unavailable";
const capText: Record<Capability, string> = {
  live: "Live · onchain / API",
  simulation: "Local simulation",
  practice: "Practice data",
  "not-deployed": "Not deployed",
  handoff: "Config handoff",
  unavailable: "Unavailable",
};
export function Cap({ kind, className }: { kind: Capability; className?: string }) {
  return (
    <span
      className={cn(
        "station-code inline-flex items-center gap-1.5 border px-2 py-1 text-[0.65rem]",
        kind === "live" && "border-success text-success",
        kind === "simulation" && "border-amber text-amber",
        kind === "practice" && "border-ochre text-ochre",
        (kind === "not-deployed" || kind === "unavailable") && "border-cream/50 text-cream/80",
        kind === "handoff" && "border-cream/50 text-cream",
        className,
      )}
    >
      <span aria-hidden className="inline-block size-1.5 bg-current" />
      {capText[kind]}
    </span>
  );
}

export const Field = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: string | null; suffix?: ReactNode }>(
  ({ label, hint, error, suffix, className, id, ...p }, ref) => {
    const fid = id ?? `f-${label.replace(/\W+/g, "-").toLowerCase()}`;
    return (
      <div className={cn("flex flex-col gap-1.5", className)}>
        <label htmlFor={fid} className="station-code text-cream/80">
          {label}
        </label>
        <div className="flex items-stretch border border-input bg-midnight focus-within:border-amber">
          <input
            ref={ref}
            id={fid}
            aria-invalid={!!error}
            aria-describedby={error ? `${fid}-err` : undefined}
            className="min-h-11 w-full min-w-0 bg-transparent px-3 font-mono text-sm text-cream outline-none placeholder:text-cream/40 tabular"
            {...p}
          />
          {suffix && <span className="flex items-center px-3 station-code text-cream/70">{suffix}</span>}
        </div>
        {error ? (
          <p id={`${fid}-err`} className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : hint ? (
          <p className="text-xs text-cream/65">{hint}</p>
        ) : null}
      </div>
    );
  },
);
Field.displayName = "Field";

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap border border-line">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "min-h-10 flex-1 px-3 station-code transition-colors",
            value === o.value ? "bg-amber text-midnight" : "text-cream/80 hover:bg-muted",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-l border-line pl-3">
      <span className="station-code text-cream/65">{label}</span>
      <span className="font-mono text-lg text-cream tabular">{value}</span>
      {sub && <span className="text-xs text-cream/60">{sub}</span>}
    </div>
  );
}

export function Notice({ tone = "info", title, children, action }: { tone?: "info" | "warn" | "error"; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex flex-col gap-2 border-l-4 bg-muted px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
        tone === "info" && "border-cream/60",
        tone === "warn" && "border-amber",
        tone === "error" && "border-destructive",
      )}
    >
      <div>
        <p className="font-medium text-cream">{title}</p>
        {children && <div className="mt-1 text-sm text-cream/80">{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function PageHead({ code, title, intro, cap, children }: { code: string; title: ReactNode; intro?: ReactNode; cap?: Capability[]; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4 pb-8 pt-2 md:flex-row md:items-end md:justify-between">
      <div className="max-w-3xl">
        <Eyebrow>{code}</Eyebrow>
        <h1 className="display mt-3 text-4xl text-cream md:text-6xl">{title}</h1>
        {intro && <p className="mt-4 max-w-2xl text-base text-cream/80 md:text-lg">{intro}</p>}
        {cap && (
          <div className="mt-4 flex flex-wrap gap-2">
            {cap.map((c) => (
              <Cap key={c} kind={c} />
            ))}
          </div>
        )}
      </div>
      {children}
    </header>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 station-code text-cream/70">
      <span aria-hidden className="inline-block size-2 animate-pulse bg-amber" />
      {label}
    </span>
  );
}
