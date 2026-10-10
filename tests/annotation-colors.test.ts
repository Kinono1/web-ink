import { expect, it } from "vitest";
import { COLORS, DEFAULT_SETTINGS } from "../src/core/model";

it("uses the five verified Apple AnnotationKit highlighter colors", () => {
  expect(COLORS).toEqual(["#facd5a", "#7cc868", "#69b0f1", "#fb5c89", "#c885da"]);
  expect(DEFAULT_SETTINGS.defaultColor).toBe("#facd5a");
});
