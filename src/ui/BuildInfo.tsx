import { useEffect, useState } from "react";
import type { Language } from "../core/model";
type Build = { version: string; commit: string; builtAt: string; dirty: boolean };
export function BuildInfo({ language }: { language: Language }) {
  const [build, setBuild] = useState<Build>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(chrome.runtime.getURL("build-info.json"), { signal: controller.signal })
      .then((response) => { if (!response.ok) throw Error("Build identity unavailable"); return response.json(); })
      .then(setBuild).catch(() => undefined);
    return () => controller.abort();
  }, []);
  const zh = language === "zh-CN";
  return <section className="settings-group build-info" aria-label={zh ? "版本信息" : "Version information"}>
    <h2>Web Ink</h2>
    <p>{build ? `v${build.version} · ${build.commit.slice(0, 7)}${build.dirty ? (zh ? " · 本地修改" : " · Local changes") : ""}` : (zh ? "构建信息暂不可用" : "Build information unavailable")}</p>
    {build ? <small>{zh ? "构建基准时间：" : "Build epoch: "}{new Date(build.builtAt).toLocaleString(language)}</small> : null}
  </section>;
}
