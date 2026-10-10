import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createServer, type Server } from "node:https";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixturePdf } from "../pdf-fixture";

test("PDF HTTP cache revalidates, isolates changed bytes and rejects failed validation", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "web-ink-pdf-cache-"));
  let context: BrowserContext | undefined;
  let server: Server | undefined;
  try {
    const key = path.join(folder, "key.pem"), cert = path.join(folder, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-days", "1"], { stdio: "ignore" });
    const publicKey = execFileSync("openssl", ["x509", "-in", cert, "-pubkey", "-noout"]);
    const spki = execFileSync("openssl", ["pkey", "-pubin", "-outform", "DER"], { input: publicKey });
    const allowedKey = createHash("sha256").update(spki).digest("base64");
    const original = fixturePdf();
    const bodies = [original, Buffer.concat([original, Buffer.from("\n% changed version\n")])];
    let version = 1, unavailable = false;
    const requests: { status: number; validator?: string; cookie?: string }[] = [];
    server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
      const etag = `"v${version}"`;
      const status = unavailable ? 503 : request.headers["if-none-match"] === etag ? 304 : 200;
      requests.push({ status, validator: request.headers["if-none-match"], cookie: request.headers.cookie });
      response.writeHead(status, { "Content-Type": "application/pdf", ETag: etag, "Cache-Control": "public, max-age=3600" });
      response.end(status === 200 ? bodies[version - 1] : undefined);
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing fixture server port");
    const source = `https://127.0.0.1:${address.port}/paper.pdf`;
    const extension = path.join(folder, "extension");
    await cp(path.resolve(process.env.WEB_INK_BUILD || ".build-output/chrome-mv3"), extension, { recursive: true });
    const manifestPath = path.join(extension, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.host_permissions = ["https://*/*"];
    await writeFile(manifestPath, JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(path.join(folder, "profile"), {
      channel: "chromium", headless: true,
      ...(process.env.WEB_INK_TEST_BROWSER_PATH ? { executablePath: process.env.WEB_INK_TEST_BROWSER_PATH } : {}),
      // Trust only this disposable server key. Ignoring all certificate errors
      // disables HTTP caching and would invalidate the 304 assertion.
      args: ["--headless=new", `--ignore-certificate-errors-spki-list=${allowedKey}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await context.addCookies([{ name: "fixture-login", value: "must-not-be-forwarded", url: source, secure: true }]);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    const hashes: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      if (i === 2) version = 2;
      await page.goto(`chrome-extension://${id}/pdf.html?source=${encodeURIComponent(source)}`);
      await expect(page.locator(".pdf-page[data-ready=true]").first()).toBeVisible();
      hashes.push(new URL(page.url()).searchParams.get("document"));
    }
    const expectedHashes = bodies.map(bytes => createHash("sha256").update(bytes).digest("hex"));
    expect(hashes).toEqual([expectedHashes[0], expectedHashes[0], expectedHashes[1]]);
    expect(requests.map(request => request.status)).toEqual([200, 304, 200]);
    expect(requests[1]?.validator).toBe('"v1"');
    expect(requests[2]?.validator).toBe('"v1"');
    unavailable = true;
    await page.goto(`chrome-extension://${id}/pdf.html?source=${encodeURIComponent(source)}`);
    await expect(page.getByRole("alert").filter({ hasText: "503" })).toBeVisible();
    await expect(page.locator(".pdf-page[data-ready=true]")).toHaveCount(0);
    expect(requests.map(request => request.status)).toEqual([200, 304, 200, 503]);
    expect(requests.every(request => !request.cookie)).toBe(true);
  } finally {
    await context?.close();
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    await rm(folder, { recursive: true, force: true });
  }
});
