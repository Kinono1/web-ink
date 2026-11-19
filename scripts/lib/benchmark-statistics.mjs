export const percentiles = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};
export const summary = (values) => ({ samples: values.length, ...percentiles(values) });
