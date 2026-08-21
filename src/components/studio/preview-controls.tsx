"use client";

import * as React from "react";

import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

/** One titled card in the preview editor grid. */
export function EditorCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-muted/30 flex flex-col gap-3 rounded-lg border p-3">
      <header className="flex items-center gap-2">
        <h3 className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
          {title}
        </h3>
        {action ? <div className="ml-auto">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

function useFieldId(label: string) {
  const generated = React.useId();
  return `${label.replace(/\W+/g, "-").toLowerCase()}-${generated}`;
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  /** `[value, label]` pairs, rendered in order. */
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  const id = useFieldId(label);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground text-[11px]">
        {label}
      </Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="border-input bg-background focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-xs focus-visible:ring-3 focus-visible:outline-hidden"
      >
        {options.map(([option, optionLabel]) => (
          <option key={option} value={option}>
            {optionLabel}
          </option>
        ))}
      </select>
    </div>
  );
}

/** How long the picker has to sit still before the colour is written to disk. */
const COLOR_COMMIT_DELAY = 250;

export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useFieldId(label);

  // `<input type="color">` fires on every frame the user drags inside the
  // picker, and each of those writes the settings file and reloads the preview.
  // The swatch follows the drag from local state; the commit is debounced, and
  // flushed on blur so closing the picker never loses the last colour.
  const [draft, setDraft] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // The server has caught up with the drag — go back to the saved value.
  if (draft !== null && draft === value) setDraft(null);

  const shown = draft ?? value;

  const schedule = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onChange(next);
    }, COLOR_COMMIT_DELAY);
  };

  // Closing the picker should not wait out the delay.
  const flush = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    if (shown !== value) onChange(shown);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground text-[11px]">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={shown}
          onChange={(event) => {
            setDraft(event.target.value);
            schedule(event.target.value);
          }}
          onBlur={flush}
          className="border-input h-8 w-full cursor-pointer rounded-md border bg-transparent p-0.5"
        />
        <span className="text-muted-foreground shrink-0 font-mono text-[10px] uppercase">
          {shown}
        </span>
      </div>
    </div>
  );
}

export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
  /** Fires on every drag frame — keep it local state only. */
  onChange: (value: number) => void;
  /** Fires once the drag ends — the right place to persist. */
  onCommit: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-muted-foreground text-[11px]">{label}</span>
        <span className="text-studio-accent ml-auto font-mono text-[11px]">
          {format ? format(value) : value}
        </span>
      </div>
      <Slider
        aria-label={label}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
        onValueCommit={([next]) => onCommit(next)}
      />
    </div>
  );
}

export function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useFieldId(label);
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-studio-accent size-3.5"
      />
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
    </div>
  );
}

/** Radio group rendered as dots — the light position grid and its intensity row. */
export function DotGroup<T extends string>({
  label,
  hint,
  value,
  options,
  columns,
  color,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: readonly (readonly [T, string])[];
  columns: number;
  /** Colour of the selected dot, so the swatch reads as the light itself. */
  color: string;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="border-input flex flex-col gap-2 rounded-md border p-2">
      <legend className="flex items-baseline gap-2 px-1">
        <span className="text-[11px] font-medium">{label}</span>
        {hint ? (
          <span className="text-muted-foreground text-[10px]">{hint}</span>
        ) : null}
      </legend>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {options.map(([option, optionLabel], index) => {
          const selected = option === value;
          return (
            <button
              key={option}
              type="button"
              title={optionLabel}
              aria-label={optionLabel}
              aria-pressed={selected}
              onClick={() => onChange(option)}
              className={cn(
                "flex h-7 items-center justify-center rounded-md border transition-colors",
                selected
                  ? "border-current"
                  : "border-input hover:bg-muted bg-transparent",
              )}
              style={selected ? { color, backgroundColor: `${color}22` } : undefined}
            >
              <span
                className="rounded-full"
                style={{
                  // Intensity rows grow the dot left-to-right; a position grid
                  // keeps every dot the same size.
                  width: columns === 3 ? 6 : 5 + index * 2,
                  height: columns === 3 ? 6 : 5 + index * 2,
                  backgroundColor: selected ? color : "currentColor",
                  opacity: selected ? 1 : 0.45,
                }}
              />
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
