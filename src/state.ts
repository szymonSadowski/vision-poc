// Central app state. Every UI control reads/writes here; the renderer reads
// this each frame to derive shader uniforms. Kept as one flat-ish object per
// requirements §10: a single continuous intensity (0-1) per effect, with
// mild/moderate/severe UI presets mapping onto it.

export type SeverityPreset = "mild" | "moderate" | "severe" | "custom";

export const SEVERITY_VALUES: Record<Exclude<SeverityPreset, "custom">, number> = {
  mild: 0.33,
  moderate: 0.66,
  severe: 1.0,
};

export type GlareVariant = "day" | "night";
export type ContrastVariant = "fog" | "low-light";
export type ViewMode = "normal" | "before-after" | "split";
export type SourceKind = "webcam" | "car" | "dims";

export interface CataractSymptom {
  enabled: boolean;
  intensity: number; // 0-1
}

export interface AppState {
  // Refractive errors
  myopia: number; // 0 to -10 D, stored as positive magnitude 0-10
  hyperopia: number; // 0 to 7 D
  astigmatism: number; // 0 to 6 D
  astigmatismAxis: number; // 0-180 degrees
  presbyopia: number; // 0-1, near-focus strain param (no diopter table)

  // Cataract — six independently toggleable + combinable symptoms
  cataractBlur: CataractSymptom;
  cataractGlare: CataractSymptom & { variant: GlareVariant };
  cataractHalos: CataractSymptom;
  cataractContrast: CataractSymptom & { variant: ContrastVariant };
  cataractYellowing: CataractSymptom;
  cataractNightDriving: CataractSymptom; // composite preset toggle

  // View / interaction
  viewMode: ViewMode;
  splitPos: number; // 0-1, before/after slider or split divider position
  source: SourceKind;
}

export function defaultState(): AppState {
  return {
    myopia: 0,
    hyperopia: 0,
    astigmatism: 0,
    astigmatismAxis: 90,
    presbyopia: 0,

    cataractBlur: { enabled: false, intensity: 0.5 },
    cataractGlare: { enabled: false, intensity: 0.5, variant: "day" },
    cataractHalos: { enabled: false, intensity: 0.5 },
    cataractContrast: { enabled: false, intensity: 0.5, variant: "fog" },
    cataractYellowing: { enabled: false, intensity: 0.5 },
    cataractNightDriving: { enabled: false, intensity: 1.0 },

    viewMode: "normal",
    splitPos: 0.5,
    source: "webcam",
  };
}

type Listener = () => void;

export class Store {
  state: AppState;
  private listeners = new Set<Listener>();

  constructor(initial: AppState) {
    this.state = initial;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(mutator: (s: AppState) => void) {
    mutator(this.state);
    for (const fn of this.listeners) fn();
  }

  /** Applies the night-driving composite preset: chains the other cataract
   * passes with night-tuned parameters. Does not force the media source —
   * caller decides whether to auto-switch to car.mp4. */
  applyNightDrivingPreset(on: boolean) {
    this.update((s) => {
      s.cataractNightDriving.enabled = on;
      if (on) {
        s.cataractBlur = { enabled: true, intensity: 0.55 };
        s.cataractGlare = { enabled: true, intensity: 0.85, variant: "night" };
        s.cataractHalos = { enabled: true, intensity: 0.9 };
        s.cataractContrast = { enabled: true, intensity: 0.7, variant: "low-light" };
        s.cataractYellowing = { enabled: true, intensity: 0.4 };
      }
    });
  }
}
