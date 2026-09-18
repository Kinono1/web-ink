import { cp, mkdir, copyFile, rm } from "node:fs/promises";
const source = "node_modules/pdfjs-dist";
const destination = "public/pdfjs";
// Generated package-owned assets only; never cache a user's document here.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await copyFile(
  `${source}/legacy/build/pdf.worker.min.mjs`,
  `${destination}/pdf.worker.min.mjs`,
);
for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  await cp(`${source}/${directory}`, `${destination}/${directory}`, {
    recursive: true,
  });
}
await copyFile(`${source}/LICENSE`, `${destination}/LICENSE`);
