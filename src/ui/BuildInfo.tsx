import { useEffect, useState } from "react";
import { request } from "../core/client";
import type { Language, RuntimeHealth } from "../core/model";

function isRuntimeHealth(value: unknown): value is RuntimeHealth {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as RuntimeHealth).generation === "string" &&
      typeof (value as RuntimeHealth).version === "string" &&
      typeof (value as RuntimeHealth).commit === "string" &&
      typeof (value as RuntimeHealth).dirty === "boolean",
  );
}

export function BuildInfo({ language }: { language: Language }) {
  const [health, setHealth] = useState<RuntimeHealth>();
  useEffect(() => {
    void request<RuntimeHealth>({ type: "runtime.health" })
      .then((value) => {
        if (isRuntimeHealth(value)) setHealth(value);
      })
      .catch(() => undefined);
  }, []);
  const zh = language === "zh-CN";
  return <section className="settings-group build-info" aria-label={zh ? "版本信息" : "Version information"}>
    <h2>Web Ink</h2>
    <p>{health ? `v${health.version} · ${health.commit.slice(0, 7)}${health.dirty ? (zh ? " · 本地修改" : " · Local changes") : ""}` : (zh ? "运行身份暂不可用" : "Running identity unavailable")}</p>
    {health ? <small>{zh ? "当前运行代次：" : "Running generation: "}{health.generation}</small> : null}
  </section>;
}
