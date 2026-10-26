import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBenchmark } from "../scripts/check-benchmark.mjs";

const samples = () => Array.from({ length: 30 }, (_, i) => i + 1);
const querySamples = (api = "annotations.query", count = 50) =>
  Array.from({ length: 30 }, (_, i) => ({ ms: i + 1, api, count }));
const webpage = () => ({
  fixture: { characters: 100000, annotations: 200, libraryRecords: 10000 },
  restore: samples(), captureSave: samples(), libraryQuery: querySamples(), libraryPaint: samples(),
  search: { rare: samples(), absent: samples(), tag: samples() },
});
const pdf = () => ({ cases: [
  { name: "20MiB", pages: 1, open: samples(), maxCanvas: 1, maxWorkersAfterClose: 0, retainedMainHeapBytes: samples() },
  { name: "50MiB", pages: 1, open: samples(), maxCanvas: 1, maxWorkersAfterClose: 0, retainedMainHeapBytes: samples() },
  { name: "500pages", pages: 500, open: samples(), jump: samples(), maxCanvas: 3, maxWorkersAfterClose: 0, retainedMainHeapBytes: samples() },
  { name: "1000pages", pages: 1000, open: samples(), jump: samples(), maxCanvas: 3, maxWorkersAfterClose: 0, retainedMainHeapBytes: samples() },
] });

test("accepts complete large-document measurements and summarizes measured durations", () => {
  assert.equal(validateBenchmark(webpage(), "v03").restore.p95, 29);
  assert.equal(validateBenchmark(webpage(), "v03").libraryQuery.p50, 16);
  const fallback = webpage();
  fallback.libraryQuery = querySamples("annotations.list", 5000);
  assert.equal(validateBenchmark(fallback, "v03").libraryQuery.p50, 16);
  assert.equal(validateBenchmark(pdf(), "pdf")["1000pages"].open.p50, 16);
});
test("rejects malformed library query measurements and counts", () => {
  const malformed = [
    ["missing duration", sample => { delete sample.ms; }, /durations/],
    ["invalid duration", sample => { sample.ms = Infinity; }, /durations/],
    ["negative duration", sample => { sample.ms = -1; }, /durations/],
    ["missing API", sample => { delete sample.api; }, /API/],
    ["unknown API", sample => { sample.api = "annotations.other"; }, /API/],
    ["missing count", sample => { delete sample.count; }, /counts/],
    ["non-integer count", sample => { sample.count = 50.5; }, /integers/],
    ["wrong query count", sample => { sample.count = 49; }, /exactly 50/],
    ["undersized fallback count", sample => { sample.api = "annotations.list"; sample.count = 4999; }, /at least 5000/],
  ];
  for (const [label, mutate, message] of malformed) {
    const report = webpage();
    mutate(report.libraryQuery[0]);
    assert.throws(() => validateBenchmark(report, "v03"), message, label);
  }
  const short = webpage();
  short.libraryQuery.pop();
  assert.throws(() => validateBenchmark(short, "v03"), /30/);
});
test("rejects insufficient samples and invalid durations rather than reporting a pass", () => {
  const report = webpage();
  report.restore.pop();
  assert.throws(() => validateBenchmark(report, "v03"), /30/);
  report.restore.push(NaN);
  assert.throws(() => validateBenchmark(report, "v03"), /finite/);
});
test("rejects reduced stress fixtures and lost virtualization", () => {
  const small = webpage();
  small.fixture.libraryRecords = 4999;
  assert.throws(() => validateBenchmark(small, "v03"), /5000/);
  const unbounded = pdf();
  unbounded.cases[3].maxCanvas = 4;
  assert.throws(() => validateBenchmark(unbounded, "pdf"), /canvas/i);
  const short = pdf();
  short.cases.pop();
  assert.throws(() => validateBenchmark(short, "pdf"), /1000/);
});

test("detects PDF workers retained after document teardown", () => {
  const retained = pdf();
  retained.cases[3].maxWorkersAfterClose = 1;
  assert.throws(() => validateBenchmark(retained, "pdf"), /worker/i);
});
