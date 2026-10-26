import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateBenchmarkReports, runBenchmarkChecks, validateBenchmark } from "../scripts/check-benchmark.mjs";

const samples = () => Array.from({ length: 30 }, (_, i) => i + 1);
const querySamples = (api = "annotations.query", count = 50) =>
  Array.from({ length: 30 }, (_, i) => ({ ms: i + 1, api, count }));
const jumpInitialStates = targetPage => Array.from({ length: 30 }, () => ({
  page: 1, page1Ready: true, targetPage, targetMounted: false, targetReady: false,
}));
const webpage = () => ({
  browser: "153.0.8010.12",
  fixture: { characters: 100000, annotations: 200, libraryRecords: 10000 },
  restore: samples(), captureSave: samples(), libraryQuery: querySamples(), libraryPaint: samples(),
  search: { rare: samples(), absent: samples(), tag: samples() },
});
const pdf = () => ({ browser: "153.0.8010.12", fixture: "Authored PDF workload", cases: [
  { name: "20MiB", bytes: 20 * 1024 * 1024, pages: 1, open: samples(), maxCanvas: 1, maxWorkersAfterClose: 0, retainedMainHeapBytes: samples(), observedMainBackingBytes: 100 },
  { name: "50MiB", bytes: 50 * 1024 * 1024, pages: 1, open: samples(), maxCanvas: 1, maxWorkersAfterClose: 0, retainedMainHeapBytes: samples(), observedMainBackingBytes: 100 },
  { name: "500pages", bytes: 50000, pages: 500, open: samples(), jump: samples(), jumpInitialStates: jumpInitialStates(500), maxCanvas: 3, maxWorkersAfterClose: 0, retainedMainHeapBytes: samples(), observedMainBackingBytes: 100 },
  { name: "1000pages", bytes: 100000, pages: 1000, open: samples(), jump: samples(), jumpInitialStates: jumpInitialStates(1000), maxCanvas: 3, maxWorkersAfterClose: 0, retainedMainHeapBytes: samples(), observedMainBackingBytes: 100 },
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

test("pools every round's raw samples and recomputes all webpage percentiles", () => {
  const first = webpage(), second = webpage();
  for (const key of ["restore", "captureSave", "libraryPaint"])
    second[key] = Array(30).fill(100);
  second.libraryQuery = querySamples().map(sample => ({ ...sample, ms: 100 }));
  for (const key of ["rare", "absent", "tag"]) second.search[key] = Array(30).fill(100);
  first.restoreSummary = { samples: 30, p95: 0 };
  const pooled = aggregateBenchmarkReports([first, second], "v03");
  assert.deepEqual(pooled.restore, [...samples(), ...Array(30).fill(100)]);
  for (const metric of Object.values(validateBenchmark(pooled, "v03"))) {
    assert.equal(metric.samples, 60);
    assert.equal(metric.p95, 100);
  }
  assert.equal(first.restore.length, 30, "aggregation must not mutate producer evidence");
});

test("rejects round metadata drift and incomplete independent rounds before pooling", () => {
  for (const [mutate, error] of [
    [report => { report.browser = "other"; }, /browser/i],
    [report => { report.fixture.characters++; }, /fixture/i],
    [report => { report.libraryQuery[0] = { ms: 1, api: "annotations.list", count: 10000 }; }, /query workload/i],
    [report => { report.restore.pop(); }, /30/],
    [report => { report.restore.push(31); }, /30/],
  ]) {
    const second = webpage();
    mutate(second);
    assert.throws(() => aggregateBenchmarkReports([webpage(), second], "v03"), error);
  }
  assert.throws(() => aggregateBenchmarkReports([webpage()], "v03"), /two|2/i);
  const first = webpage(), second = webpage();
  first.libraryQuery[0] = { ms: 1, api: "annotations.list", count: 10000 };
  second.libraryQuery[0] = { ms: 1, api: "annotations.list", count: 10000 };
  second.libraryQuery[1] = { ms: 2, api: "annotations.list", count: 10000 };
  assert.throws(() => aggregateBenchmarkReports([first, second], "v03"), /query workload/i);
});

test("pools PDF samples by case name and keeps conservative resource maxima", () => {
  const first = pdf(), second = pdf();
  first.cases[0].observedMainBackingBytes = 100;
  second.cases[0].observedMainBackingBytes = 200;
  second.cases[0].maxCanvas = 3;
  for (const item of second.cases) {
    item.open = Array(30).fill(80);
    item.retainedMainHeapBytes = Array(30).fill(90);
    if (item.pages > 1) item.jump = Array(30).fill(70);
  }
  second.cases.reverse();
  const pooled = aggregateBenchmarkReports([first, second], "pdf");
  const measured = validateBenchmark(pooled, "pdf");
  assert.deepEqual(pooled.cases[0].open, [...samples(), ...Array(30).fill(80)]);
  for (const item of Object.values(measured)) {
    assert.equal(item.open.samples, 60);
    assert.equal(item.open.p95, 80);
    assert.equal(item.retainedMainHeapBytes.samples, 60);
    assert.equal(item.retainedMainHeapBytes.p95, 90);
    if (item.jump) assert.deepEqual(item.jump, { samples: 60, p50: 70, p95: 70 });
  }
  assert.equal(measured["20MiB"].maxCanvas, 3);
  assert.equal(measured["20MiB"].maxWorkersAfterClose, 0);
  assert.equal(measured["20MiB"].observedMainBackingBytes, 200);
  for (const [mutate, error] of [
    [report => { report.cases[0].maxCanvas = 4; }, /canvas/i],
    [report => { report.cases[0].maxWorkersAfterClose = 1; }, /worker/i],
    [report => { report.cases[0].pages = 2; }, /fixture/i],
    [report => { report.cases[0].bytes = 200; }, /fixture/i],
    [report => { report.cases[0].name = "other"; }, /case|fixture/i],
  ]) {
    const changed = pdf();
    mutate(changed);
    assert.throws(() => aggregateBenchmarkReports([pdf(), changed], "pdf"), error);
  }
});

test("pooled p95 rejects a slow second round without trimming or choosing the first round", () => {
  const slow = webpage();
  slow.captureSave = [...Array(26).fill(1), 100, 100, 100, 100];
  const baseline = aggregateBenchmarkReports([webpage(), webpage()], "v03");
  const candidate = aggregateBenchmarkReports([webpage(), slow], "v03");
  assert.equal(validateBenchmark(candidate, "v03").captureSave.p95, 100);
  assert.throws(() => validateBenchmark(candidate, "v03", baseline), /captureSave.*regression/i);
});

function producerRunner(reports) {
  const calls = [], output = [];
  return {
    calls, output,
    options: {
      env: { WEB_INK_BENCHMARK_BASELINE: "/baseline", WEB_INK_BUILD: "/candidate" },
      execute(executable, args, options) {
        calls.push({ mode: args[1], build: options.env.WEB_INK_BUILD });
        return reports[calls.length - 1];
      },
      log(value) { output.push(value); },
    },
  };
}

test("paired CLI executes serial ABBA for each mode and reports sixty-sample comparisons", () => {
  const reports = [webpage(), webpage(), webpage(), webpage(), pdf(), pdf(), pdf(), pdf()]
    .map(report => JSON.stringify(report));
  const runner = producerRunner(reports);
  runBenchmarkChecks(runner.options);
  assert.deepEqual(runner.calls, [
    { mode: "--mode=v03", build: "/baseline" },
    { mode: "--mode=v03", build: "/candidate" },
    { mode: "--mode=v03", build: "/candidate" },
    { mode: "--mode=v03", build: "/baseline" },
    { mode: "--mode=pdf", build: "/baseline" },
    { mode: "--mode=pdf", build: "/candidate" },
    { mode: "--mode=pdf", build: "/candidate" },
    { mode: "--mode=pdf", build: "/baseline" },
  ]);
  const summaries = runner.output.map(value => JSON.parse(value)).filter(value => value.measurements);
  assert.equal(summaries.length, 2);
  for (const summary of summaries) {
    assert.deepEqual(summary.schedule, ["baseline", "candidate", "candidate", "baseline"]);
    assert.equal(summary.samplesPerMetric, 60);
  }
  assert.equal(summaries[0].measurements.restore.samples, 60);
  assert.equal(summaries[0].baseline.restore.samples, 60);
  assert.equal(summaries[1].measurements["1000pages"].jump.samples, 60);
});

test("CLI emits every complete original producer report before validation can fail", () => {
  const bad = webpage();
  bad.restore = [];
  const reports = [bad, webpage(), webpage(), webpage(), pdf(), pdf(), pdf(), pdf()]
    .map((report, index) => JSON.stringify({ ...report, evidenceMarker: index }, null, 2));
  const runner = producerRunner(reports);
  assert.throws(() => runBenchmarkChecks(runner.options), /30/);
  assert.equal(runner.calls.length, 8, "a rejected report must not discard later rounds or the PDF evidence");
  for (const report of reports) assert.ok(runner.output.includes(report));
});

test("CLI rejects workload drift between builds after all raw evidence is emitted", () => {
  const changed = webpage();
  changed.fixture.libraryRecords = 20000;
  const reports = [webpage(), changed, changed, webpage(), pdf(), pdf(), pdf(), pdf()]
    .map(report => JSON.stringify(report));
  const runner = producerRunner(reports);
  assert.throws(() => runBenchmarkChecks(runner.options), /fixture/i);
  assert.equal(runner.calls.length, 8);
});

test("unpaired CLI retains one producer run and the existing summary per mode", () => {
  const runner = producerRunner([JSON.stringify(webpage()), JSON.stringify(pdf())]);
  delete runner.options.env.WEB_INK_BENCHMARK_BASELINE;
  runBenchmarkChecks(runner.options);
  assert.deepEqual(runner.calls, [
    { mode: "--mode=v03", build: "/candidate" },
    { mode: "--mode=pdf", build: "/candidate" },
  ]);
  const summaries = runner.output.map(value => JSON.parse(value)).filter(value => value.measurements);
  assert.equal(summaries[0].measurements.restore.samples, 30);
  assert.equal(summaries[0].baseline, undefined);
  assert.equal(summaries[1].measurements["1000pages"].open.samples, 30);
});

test("rejects ambiguous PDF case names instead of silently selecting one sample array", () => {
  const first = pdf(), second = pdf();
  for (const report of [first, second])
    report.cases.push({ ...report.cases[0], open: Array(30).fill(100) });
  assert.throws(() => aggregateBenchmarkReports([first, second], "pdf"), /unique|duplicate/i);
});

test("rejects PDF jump samples starting from a restored page instead of ready page one", () => {
  for (const mutate of [
    state => { state.page = 500; },
    state => { state.page1Ready = false; },
    state => { state.page = "1"; },
  ]) {
    const report = pdf();
    mutate(report.cases[2].jumpInitialStates[29]);
    assert.throws(() => validateBenchmark(report, "pdf"), /initial|page 1/i);
    assert.throws(() => aggregateBenchmarkReports([pdf(), report], "pdf"), /initial|page 1/i);
  }
});

test("rejects a ready or mounted PDF jump target and a mismatched target page", () => {
  for (const mutate of [
    state => { state.targetReady = true; },
    state => { state.targetMounted = true; },
    state => { state.targetPage = 500; },
    state => { delete state.targetReady; },
  ]) {
    const report = pdf();
    mutate(report.cases[3].jumpInitialStates[0]);
    assert.throws(() => aggregateBenchmarkReports([pdf(), report], "pdf"), /initial|target/i);
  }
});

test("ABBA requires every PDF jump initial state while legacy standalone reports remain readable", () => {
  for (const mutate of [
    item => { delete item.jumpInitialStates; },
    item => { item.jumpInitialStates.pop(); },
    item => { item.jumpInitialStates.push({ ...item.jumpInitialStates[0] }); },
  ]) {
    const report = pdf();
    mutate(report.cases[2]);
    assert.throws(() => aggregateBenchmarkReports([report, pdf()], "pdf"), /initial.*(30|sample)|30.*initial/i);
  }
  const legacy = pdf();
  for (const item of legacy.cases) delete item.jumpInitialStates;
  assert.equal(validateBenchmark(legacy, "pdf")["500pages"].jump.samples, 30);
});

test("PDF pooling preserves all sixty initial-state observations in round order", () => {
  const first = pdf(), second = pdf();
  first.cases[2].jumpInitialStates[0].evidenceMarker = "first";
  second.cases[2].jumpInitialStates[29].evidenceMarker = "last";
  const pooled = aggregateBenchmarkReports([first, second], "pdf");
  const states = pooled.cases[2].jumpInitialStates;
  assert.equal(states.length, 60);
  assert.equal(states[0].evidenceMarker, "first");
  assert.equal(states[59].evidenceMarker, "last");
  for (const state of states) {
    assert.equal(state.page, 1);
    assert.equal(state.page1Ready, true);
    assert.equal(state.targetPage, 500);
    assert.equal(state.targetMounted, false);
    assert.equal(state.targetReady, false);
  }
  assert.deepEqual(validateBenchmark(pooled, "pdf")["500pages"].jumpInitialStates, states);
  assert.equal(first.cases[2].jumpInitialStates.length, 30);
  assert.equal(second.cases[2].jumpInitialStates.length, 30);
});
