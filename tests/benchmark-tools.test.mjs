import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBenchmark } from "../scripts/check-benchmark.mjs";

const samples = () => Array.from({ length: 30 }, (_, i) => i + 1);
const querySamples = (api = "annotations.query", count = 50) =>
  Array.from({ length: 30 }, (_, i) => ({ ms: i + 1, api, count }));
const webpage = () => ({
  browser: "153.0.8010.12",
  fixture: { characters: 100000, annotations: 200, libraryRecords: 10000 },
  restore: samples(), captureSave: samples(), libraryQuery: querySamples(), libraryPaint: samples(),
  search: { rare: samples(), absent: samples(), tag: samples() },
});
const pdf = () => ({ browser: "153.0.8010.12", fixture: "Authored PDF workload", cases: [
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

test("paired webpage measurements reject a real p95 latency regression", () => {
  const baseline = webpage(), candidate = webpage();
  candidate.captureSave = Array(30).fill(40);
  assert.throws(() => validateBenchmark(candidate, "v03", baseline), /captureSave.*regression/i);
  assert.equal(validateBenchmark(candidate, "v03").captureSave.p95, 40);
});

test("paired latency comparisons allow twenty percent or two milliseconds of variation", () => {
  const baseline = webpage(), candidate = webpage();
  candidate.restore = Array(30).fill(34.8);
  assert.equal(validateBenchmark(candidate, "v03", baseline).restore.p95, 34.8);
  baseline.restore = Array(30).fill(0.5);
  candidate.restore = Array(30).fill(2.5);
  assert.equal(validateBenchmark(candidate, "v03", baseline).restore.p95, 2.5);
  candidate.restore = Array(30).fill(2.6);
  assert.throws(() => validateBenchmark(candidate, "v03", baseline), /restore.*regression/i);
});

test("paired comparisons cover paged queries, sparse searches, PDF startup and jumps", () => {
  const baseline = webpage(), candidate = webpage();
  candidate.libraryQuery = candidate.libraryQuery.map(sample => ({ ...sample, ms: 40 }));
  assert.throws(() => validateBenchmark(candidate, "v03", baseline), /libraryQuery.*regression/i);
  const search = webpage();
  search.search.tag = Array(30).fill(40);
  assert.throws(() => validateBenchmark(search, "v03", baseline), /search.tag.*regression/i);
  const before = pdf(), after = pdf();
  after.cases[0].open = Array(30).fill(40);
  assert.throws(() => validateBenchmark(after, "pdf", before), /20MiB.open.*regression/i);
  after.cases[0].open = samples();
  after.cases[3].jump = Array(30).fill(40);
  assert.throws(() => validateBenchmark(after, "pdf", before), /1000pages.jump.*regression/i);
});

test("paired comparisons refuse different browser, fixture, query work or sample counts", () => {
  for (const [mutate, error] of [
    [report => { report.browser = "120.0.6099.109"; }, /browser/i],
    [report => { delete report.browser; }, /browser/i],
    [report => { report.fixture.libraryRecords = 20000; }, /fixture/i],
    [report => { report.libraryQuery = querySamples("annotations.list", 10000); }, /query workload/i],
    [report => { report.restore.push(31); }, /sample count/i],
  ]) {
    const candidate = webpage();
    mutate(candidate);
    assert.throws(() => validateBenchmark(candidate, "v03", webpage()), error);
  }
  const candidate = pdf();
  candidate.cases[2].pages = 501;
  assert.throws(() => validateBenchmark(candidate, "pdf", pdf()), /fixture/i);
});
