import { expect, it } from "vitest";
import { createIeeePdfDiagnostic } from "../src/pdf/ieee-diagnostics";

it("keeps only approved IEEE diagnostic fields from an HTTP failure", () => {
  const diagnostic = createIeeePdfDiagnostic({
    id: "00000000-0000-4000-8000-000000000001",
    phase: "file",
    startedAt: 100,
    now: 142,
    status: 403,
    mime: "text/html; charset=utf-8",
    sourceKind: "wrapper",
  });

  expect(diagnostic).toEqual({
    id: "00000000-0000-4000-8000-000000000001",
    version: 1,
    phase: "file",
    elapsedMs: 42,
    status: 403,
    mime: "text/html",
    sourceKind: "wrapper",
  });
});

it("omits unrecognized response details and retains unknown source state", () => {
  const diagnostic = createIeeePdfDiagnostic({
    id: "00000000-0000-4000-8000-000000000002",
    phase: "validate",
    startedAt: 100,
    now: 90,
    status: 0,
    mime: "application/private; ticket=secret",
    sourceKind: "redirected" as never,
  });

  expect(diagnostic).toEqual({
    id: "00000000-0000-4000-8000-000000000002",
    version: 1,
    phase: "validate",
    elapsedMs: 0,
    sourceKind: "unknown",
  });
});
