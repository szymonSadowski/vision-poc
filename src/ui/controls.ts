import {
  SEVERITY_VALUES,
  type AppState,
  type CataractSymptom,
  type SeverityPreset,
  Store,
} from "../state";
import type { MediaSourceManager } from "../input/media-source";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function section(title: string): HTMLElement {
  const s = el("div", "panel-section");
  s.appendChild(el("h2", "panel-section-title", title));
  return s;
}

function sliderRow(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  format: (v: number) => string,
  onInput: (v: number) => void,
): HTMLElement {
  const row = el("div", "control-row");
  const labelRow = el("div", "control-label-row");
  const labelEl = el("label", "control-label", label);
  const valueEl = el("span", "control-value", format(value));
  labelRow.append(labelEl, valueEl);

  const input = el("input", "slider") as HTMLInputElement;
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    valueEl.textContent = format(v);
    onInput(v);
  });

  row.append(labelRow, input);
  return row;
}

function severityButtons(
  onSet: (preset: Exclude<SeverityPreset, "custom">) => void,
): HTMLElement {
  const wrap = el("div", "severity-buttons");
  (["mild", "moderate", "severe"] as const).forEach((preset) => {
    const btn = el("button", "severity-btn", preset);
    btn.type = "button";
    btn.addEventListener("click", () => onSet(preset));
    wrap.appendChild(btn);
  });
  return wrap;
}

function cataractRow(
  store: Store,
  title: string,
  get: (s: AppState) => CataractSymptom,
  set: (s: AppState, mutate: (sym: CataractSymptom) => void) => void,
  extra?: (row: HTMLElement) => void,
): HTMLElement {
  const row = el("div", "cataract-row");
  const header = el("div", "cataract-header");

  const checkbox = el("input") as HTMLInputElement;
  checkbox.type = "checkbox";
  checkbox.checked = get(store.state).enabled;
  const label = el("label", "cataract-label", title);
  header.append(checkbox, label);

  const valueEl = el("span", "control-value", `${Math.round(get(store.state).intensity * 100)}%`);
  header.appendChild(valueEl);
  row.appendChild(header);

  checkbox.addEventListener("change", () => {
    store.update((s) => set(s, (sym) => (sym.enabled = checkbox.checked)));
  });

  const slider = el("input", "slider") as HTMLInputElement;
  slider.type = "range";
  slider.min = "0";
  slider.max = "1";
  slider.step = "0.01";
  slider.value = String(get(store.state).intensity);
  slider.addEventListener("input", () => {
    const v = parseFloat(slider.value);
    valueEl.textContent = `${Math.round(v * 100)}%`;
    store.update((s) => set(s, (sym) => (sym.intensity = v)));
  });
  row.appendChild(slider);

  const presets = severityButtons((preset) => {
    const v = SEVERITY_VALUES[preset];
    slider.value = String(v);
    valueEl.textContent = `${Math.round(v * 100)}%`;
    checkbox.checked = true;
    store.update((s) =>
      set(s, (sym) => {
        sym.enabled = true;
        sym.intensity = v;
      }),
    );
  });
  row.appendChild(presets);

  if (extra) extra(row);
  return row;
}

function variantSelect<V extends string>(
  options: readonly V[],
  value: V,
  onChange: (v: V) => void,
): HTMLElement {
  const select = el("select", "variant-select") as HTMLSelectElement;
  for (const opt of options) {
    const o = el("option");
    o.value = opt;
    o.textContent = opt;
    if (opt === value) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener("change", () => onChange(select.value as V));
  return select;
}

export function buildControls(
  panel: HTMLElement,
  store: Store,
  media: MediaSourceManager,
) {
  panel.innerHTML = "";

  // --- source ---------------------------------------------------------
  const sourceSection = section("Input Source");
  const sourceWrap = el("div", "source-buttons");
  (
    [
      ["webcam", "Webcam"],
      ["car", "car.mp4"],
      ["dims", "dims.apnews.jpg"],
    ] as const
  ).forEach(([kind, label]) => {
    const btn = el("button", "source-btn", label);
    btn.type = "button";
    btn.dataset.kind = kind;
    if (store.state.source === kind) btn.classList.add("active");
    btn.addEventListener("click", async () => {
      const resolved = await media.trySwitchTo(kind);
      store.update((s) => (s.source = resolved));
    });
    sourceWrap.appendChild(btn);
  });
  sourceSection.appendChild(sourceWrap);
  panel.appendChild(sourceSection);

  // Source can change from outside a button click (e.g. async webcam-denied
  // fallback on init, or the night-driving preset auto-switching to car.mp4)
  // so sync active state off the store rather than only the click handler.
  store.subscribe(() => {
    for (const b of sourceWrap.querySelectorAll("button")) {
      b.classList.toggle("active", (b as HTMLElement).dataset.kind === store.state.source);
    }
  });

  // --- view mode --------------------------------------------------------
  const viewSection = section("View Mode");
  const viewWrap = el("div", "source-buttons");
  (
    [
      ["normal", "Normal"],
      ["before-after", "Before / After"],
      ["split", "Split Screen"],
    ] as const
  ).forEach(([mode, label]) => {
    const btn = el("button", "source-btn", label);
    btn.type = "button";
    btn.dataset.mode = mode;
    if (store.state.viewMode === mode) btn.classList.add("active");
    btn.addEventListener("click", () => {
      store.update((s) => (s.viewMode = mode));
      for (const b of viewWrap.querySelectorAll("button")) {
        b.classList.toggle("active", (b as HTMLElement).dataset.mode === mode);
      }
    });
    viewWrap.appendChild(btn);
  });
  viewSection.appendChild(viewWrap);
  panel.appendChild(viewSection);

  // --- refractive errors --------------------------------------------------
  const refSection = section("Refractive Errors");

  refSection.appendChild(
    sliderRow(
      "Myopia (nearsighted)",
      0,
      10,
      0.25,
      store.state.myopia,
      (v) => `-${v.toFixed(2)} D`,
      (v) => store.update((s) => (s.myopia = v)),
    ),
  );
  refSection.appendChild(
    sliderRow(
      "Hyperopia (farsighted)",
      0,
      7,
      0.25,
      store.state.hyperopia,
      (v) => `+${v.toFixed(2)} D`,
      (v) => store.update((s) => (s.hyperopia = v)),
    ),
  );
  refSection.appendChild(
    sliderRow(
      "Astigmatism (CYL)",
      0,
      6,
      0.25,
      store.state.astigmatism,
      (v) => `${v.toFixed(2)} D`,
      (v) => store.update((s) => (s.astigmatism = v)),
    ),
  );
  refSection.appendChild(
    sliderRow(
      "Astigmatism axis",
      0,
      180,
      1,
      store.state.astigmatismAxis,
      (v) => `${v.toFixed(0)}°`,
      (v) => store.update((s) => (s.astigmatismAxis = v)),
    ),
  );
  refSection.appendChild(
    sliderRow(
      "Presbyopia (near-focus strain)",
      0,
      1,
      0.01,
      store.state.presbyopia,
      (v) => `${Math.round(v * 100)}%`,
      (v) => store.update((s) => (s.presbyopia = v)),
    ),
  );
  panel.appendChild(refSection);

  // --- depth-aware rendering ------------------------------------------------
  const depthSection = section("Depth-Aware Rendering");
  const depthRow = el("div", "cataract-header");
  const depthCheckbox = el("input") as HTMLInputElement;
  depthCheckbox.type = "checkbox";
  depthCheckbox.checked = store.state.depthEnabled;
  depthCheckbox.addEventListener("change", () => {
    store.update((s) => (s.depthEnabled = depthCheckbox.checked));
  });
  depthRow.append(depthCheckbox, el("label", "cataract-label", "Use estimated depth"));
  depthSection.appendChild(depthRow);
  depthSection.appendChild(
    el(
      "p",
      "hint",
      "Makes myopia, hyperopia, presbyopia blur, cataract fog, and low-light " +
        "darkening scale with distance instead of being flat. Astigmatism, " +
        "cataract blur, glare, halos, and yellowing are unaffected — those " +
        "aren't depth-dependent phenomena. Needs a scene with both near and " +
        "far content to be visible, and falls back to flat behavior " +
        "automatically if disabled or not yet loaded.",
    ),
  );

  const previewRow = el("div", "cataract-header");
  const previewCheckbox = el("input") as HTMLInputElement;
  previewCheckbox.type = "checkbox";
  previewCheckbox.checked = store.state.depthPreview;
  previewCheckbox.addEventListener("change", () => {
    store.update((s) => (s.depthPreview = previewCheckbox.checked));
  });
  previewRow.append(previewCheckbox, el("label", "cataract-label", "Depth-map preview"));
  depthSection.appendChild(previewRow);
  depthSection.appendChild(
    el(
      "p",
      "hint",
      "Shows the raw estimated depth map instead of the processed video — " +
        "brighter is nearer to the camera. Useful for checking the model " +
        "loaded and is reading the scene correctly.",
    ),
  );
  panel.appendChild(depthSection);

  // --- cataract ------------------------------------------------------------
  const catSection = section("Cataract Symptoms");

  catSection.appendChild(
    cataractRow(
      store,
      "Blurred vision",
      (s) => s.cataractBlur,
      (s, m) => m(s.cataractBlur),
    ),
  );

  catSection.appendChild(
    cataractRow(
      store,
      "Glare sensitivity",
      (s) => s.cataractGlare,
      (s, m) => m(s.cataractGlare),
      (row) => {
        row.appendChild(
          variantSelect(["day", "night"] as const, store.state.cataractGlare.variant, (v) =>
            store.update((s) => (s.cataractGlare.variant = v)),
          ),
        );
      },
    ),
  );

  catSection.appendChild(
    cataractRow(
      store,
      "Halos around lights",
      (s) => s.cataractHalos,
      (s, m) => m(s.cataractHalos),
    ),
  );

  catSection.appendChild(
    cataractRow(
      store,
      "Reduced contrast sensitivity",
      (s) => s.cataractContrast,
      (s, m) => m(s.cataractContrast),
      (row) => {
        row.appendChild(
          variantSelect(["fog", "low-light"] as const, store.state.cataractContrast.variant, (v) =>
            store.update((s) => (s.cataractContrast.variant = v)),
          ),
        );
      },
    ),
  );

  catSection.appendChild(
    cataractRow(
      store,
      "Yellowing of vision",
      (s) => s.cataractYellowing,
      (s, m) => m(s.cataractYellowing),
    ),
  );

  panel.appendChild(catSection);

  // --- night driving preset -------------------------------------------------
  const nightSection = section("Composite Demo");
  const nightBtn = el(
    "button",
    "night-preset-btn",
    "Night-time driving difficulties",
  );
  nightBtn.type = "button";
  const syncNightBtn = () =>
    nightBtn.classList.toggle("active", store.state.cataractNightDriving.enabled);
  syncNightBtn();
  nightBtn.addEventListener("click", async () => {
    const turningOn = !store.state.cataractNightDriving.enabled;
    store.applyNightDrivingPreset(turningOn);
    syncNightBtn();
    buildControls(panel, store, media); // re-render to reflect chained toggles
    if (turningOn) {
      const resolved = await media.trySwitchTo("car");
      store.update((s) => (s.source = resolved));
    }
  });
  nightSection.appendChild(nightBtn);
  nightSection.appendChild(
    el(
      "p",
      "hint",
      "Chains glare + halos + contrast loss + blur with night-tuned parameters against car.mp4.",
    ),
  );
  panel.appendChild(nightSection);
}
