import type { AnnotationPreset } from "../../core/annotation-presets";
import { ICON_PATHS } from "../../core/icons";
import { COLORS } from "../../core/model";
import { button, separator, svgElement } from "../view-lite";

interface SelectionColors {
  presets: readonly AnnotationPreset[];
  recentColors: readonly string[];
  color(): string;
  setColor(color: string): void;
  save(color: string, tags?: string[]): Promise<void>;
  label(cn: string, en: string): string;
}

export function appendSelectionColors(palette: HTMLElement, controls: SelectionColors): void {
  const primary = [
    ...new Set([...controls.recentColors, controls.color(), ...COLORS.slice(0, 3)]),
  ].slice(0, 4);
  const addColor = (color: string) => {
    const b = button(
      "",
      () => {
        void controls.save(color);
      },
      `${controls.label("高亮", "Highlight")} ${color}`,
    );
    b.className = "swatch";
    b.style.backgroundColor = color;
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    palette.append(b);
  };
  const addPreset = (preset: AnnotationPreset) => {
    const control = button(
      preset.label,
      () => {
        void controls.save(preset.color, [preset.label]);
      },
      `${preset.label} ${preset.color}`,
    );
    control.className = "preset";
    control.dataset.annotationPreset = preset.id;
    const swatch = document.createElement("span");
    Object.assign(swatch.style, {
      width: "10px",
      height: "10px",
      borderRadius: "50%",
      backgroundColor: preset.color,
      boxShadow: "inset 0 0 0 1px rgb(0 0 0 / 12%)",
    });
    swatch.setAttribute("aria-hidden", "true");
    control.prepend(swatch);
    control.addEventListener("pointerdown", (event) => event.preventDefault());
    palette.append(control);
  };
  controls.presets.slice(0, 5).forEach(addPreset);
  if (controls.presets.length) palette.append(separator());
  primary.forEach(addColor);
  const more = button(
    "",
    () => {
      more.remove();
      for (const color of COLORS)
        if (!primary.includes(color)) addColor(color);
      const custom = document.createElement("input");
      custom.type = "color";
      custom.value = controls.color();
      custom.title = controls.label("自定义颜色", "Custom color");
      custom.setAttribute("aria-label", custom.title);
      custom.addEventListener("input", () => {
        controls.setColor(custom.value);
      });
      const apply = button(controls.label("应用", "Apply"), () => {
        void controls.save(custom.value);
      });
      apply.addEventListener("pointerdown", (event) =>
        event.preventDefault(),
      );
      palette.append(custom, apply);
    },
    controls.label("更多颜色", "More colors"),
  );
  more.className = "more";
  more.append(glyph(ICON_PATHS.more, 3));
  palette.append(more);
}

/** Small monochrome icon used by the floating selection controls. */
function glyph(path: string, strokeWidth = 1.8) {
  const icon = svgElement("svg", {
    viewBox: "0 0 24 24",
    "aria-hidden": "true",
  });
  icon.append(
    svgElement("path", {
      d: path,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": strokeWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  return icon;
}
