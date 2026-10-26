// Paired measurements use one browser and workload, with relative timing budgets
// rather than an absolute wall-clock limit across different CI machines.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

function summarize(values, label) {
  if (!Array.isArray(values) || values.length < 30)
    throw Error(`${label}: at least 30 post-warmup samples required`);
  if (values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0))
    throw Error(`${label}: durations must be finite nonnegative numbers`);
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

function summarizeLibraryQuery(measurements, label) {
  if (!Array.isArray(measurements) || measurements.length < 30)
    throw Error(`${label}: at least 30 post-warmup samples required`);
  for (const measurement of measurements) {
    if (!measurement || typeof measurement !== "object" || Array.isArray(measurement))
      throw Error(`${label}: each sample must include duration, API, and count`);
    if (typeof measurement.ms !== "number" || !Number.isFinite(measurement.ms) || measurement.ms < 0)
      throw Error(`${label}: durations must be finite nonnegative numbers`);
    if (!Number.isInteger(measurement.count))
      throw Error(`${label}: record counts must be integers`);
    if (measurement.api === "annotations.query") {
      if (measurement.count !== 50)
        throw Error(`${label}: annotations.query must return exactly 50 records`);
    } else if (measurement.api === "annotations.list") {
      if (measurement.count < 5000)
        throw Error(`${label}: annotations.list must return at least 5000 records`);
    } else {
      throw Error(`${label}: API must be annotations.query or annotations.list`);
    }
  }
  return summarize(measurements.map(measurement => measurement.ms), label);
}

function measureBenchmark(report, mode) {
  if (mode === "v03") {
    if (!(report.fixture?.libraryRecords >= 5000))
      throw Error("Webpage benchmark requires at least 5000 library annotations");
    if (!(report.fixture?.annotations >= 200) || !(report.fixture?.characters >= 100000))
      throw Error("Webpage benchmark requires 200 anchors on at least 100000 characters");
    return Object.fromEntries([
      ...["restore", "captureSave", "libraryPaint"].map(key => [key, summarize(report[key], key)]),
      ["libraryQuery", summarizeLibraryQuery(report.libraryQuery, "libraryQuery")],
      ...["rare", "absent", "tag"].map(key => [`search.${key}`, summarize(report.search?.[key], `search.${key}`)]),
    ]);
  }
  if (mode !== "pdf") throw Error(`Unknown benchmark mode: ${mode}`);
  if (!Array.isArray(report.cases) || !report.cases.some(item => item.pages >= 1000))
    throw Error("PDF benchmark requires a document with at least 1000 pages");
  for (const name of ["20MiB", "50MiB", "500pages", "1000pages"])
    if (!report.cases.some(item => item.name === name)) throw Error(`Missing PDF benchmark case: ${name}`);
  return Object.fromEntries(report.cases.map(item => {
    if (!Number.isInteger(item.maxCanvas) || item.maxCanvas < 1 || item.maxCanvas > 3)
      throw Error(`${item.name}: canvas count exceeds the virtual-page resource bound`);
    if (item.maxWorkersAfterClose !== 0)
      throw Error(`${item.name}: PDF worker retained after closing the document`);
    return [item.name, {
      open: summarize(item.open, `${item.name}.open`),
      ...(item.pages > 1 ? { jump: summarize(item.jump, `${item.name}.jump`) } : {}),
      maxCanvas: item.maxCanvas,
      maxWorkersAfterClose: item.maxWorkersAfterClose,
      retainedMainHeapBytes: summarize(item.retainedMainHeapBytes, `${item.name}.retainedMainHeapBytes`),
      // Main-page backing storage excludes worker/process memory; report the
      // observation without calling it a whole-browser leak measurement.
      observedMainBackingBytes: item.observedMainBackingBytes,
    }];
  }));
}

export function validateBenchmark(report, mode, baseline) {
  const measurements = measureBenchmark(report, mode);
  if (!baseline) return measurements;
  const previous = measureBenchmark(baseline, mode);
  if (typeof report.browser !== "string" || !report.browser || report.browser !== baseline.browser)
    throw Error("Paired benchmark browser versions must match");
  if (!isDeepStrictEqual(report.fixture, baseline.fixture))
    throw Error("Paired benchmark fixture descriptions and sizes must match");
  const compare = (before, after, label) => {
    if (before.samples !== after.samples) throw Error(`${label}: paired sample counts must match`);
    const limit = before.p95 + Math.max(before.p95 * 0.2, 2);
    if (after.p95 > limit)
      throw Error(`${label}: p95 latency regression (${after.p95} ms exceeds ${limit} ms)`);
  };
  if (mode === "v03") {
    const queryWork = report => [...new Set(report.libraryQuery.map(sample => `${sample.api}:${sample.count}`))].sort();
    if (!isDeepStrictEqual(queryWork(report), queryWork(baseline)))
      throw Error("Paired query workload must use the same APIs and record counts");
    for (const key of Object.keys(previous)) compare(previous[key], measurements[key], key);
  } else {
    const inputs = report => report.cases.map(({ name, pages, bytes }) => ({ name, pages, bytes }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!isDeepStrictEqual(inputs(report), inputs(baseline)))
      throw Error("Paired PDF fixture names, page counts and byte sizes must match");
    for (const name of Object.keys(previous)) {
      compare(previous[name].open, measurements[name].open, `${name}.open`);
      if (previous[name].jump) compare(previous[name].jump, measurements[name].jump, `${name}.jump`);
    }
  }
  return measurements;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const run = (mode, build) => JSON.parse(execFileSync(process.execPath,
    [fileURLToPath(new URL("./benchmark.mjs", import.meta.url)), `--mode=${mode}`], {
      env: { ...process.env, ...(build ? { WEB_INK_BUILD: build } : {}) },
      encoding: "utf8", maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"],
    }));
  for (const mode of ["v03", "pdf"]) {
    const baseline = process.env.WEB_INK_BENCHMARK_BASELINE ? run(mode, process.env.WEB_INK_BENCHMARK_BASELINE) : undefined;
    const report = run(mode);
    console.log(JSON.stringify({ mode, browser: report.browser, units: "milliseconds",
      measurements: validateBenchmark(report, mode, baseline),
      ...(baseline ? { baseline: validateBenchmark(baseline, mode), tolerance: "P95 increase <= max(20%, 2 ms)" } : {}),
    }));
  }
}
