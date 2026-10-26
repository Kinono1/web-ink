import { afterEach, expect, it } from "vitest";
import { InteractionManager } from "../../../src/content/engine/InteractionManager";
import type { AnnotationController } from "../../../src/content/engine/AnnotationController";
import { TextAnchorSession } from "../../../src/core/text-anchor";
import { DEFAULT_SETTINGS } from "../../../src/core/model";
import { createView } from "../../../src/content/view-lite";

afterEach(() => {
  getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});
it("accepts a live preset selection and leaves editable selections to the page", () => {
  const paragraph = document.createElement("p");
  paragraph.textContent = "A live selected passage";
  document.body.append(paragraph);
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  getSelection()!.addRange(range);
  const saves: Array<{ color: string; tags: string[]; text: string }> = [];
  const session = new TextAnchorSession(document);
  const engine = {
    settings: DEFAULT_SETTINGS, view: createView(), enabled: () => true,
    mode: { mode: "idle" }, render: { textSession: session },
    save: {
      pendingSave: false,
      saveSelection: (color: string, tags: string[], selected: Range) => {
        saves.push({ color, tags, text: selected.toString() });
      },
    },
  } as unknown as AnnotationController;
  const interactions = new InteractionManager(engine);
  interactions.annotationPresets = [{ id: "evidence", label: "Evidence", color: "#00ff00" }];
  const shortcut = () => new KeyboardEvent("keydown", {
    code: "Digit1", altKey: true, shiftKey: true, cancelable: true,
  });
  const event = shortcut();
  expect(interactions.applyPresetShortcut(event)).toBe(true);
  expect(event.defaultPrevented).toBe(true);
  expect(saves).toEqual([{ color: "#00ff00", tags: ["Evidence"], text: "A live selected passage" }]);
  paragraph.setAttribute("contenteditable", "true");
  expect(interactions.applyPresetShortcut(shortcut())).toBe(false);
  expect(saves).toHaveLength(1);
  session.dispose();
});
