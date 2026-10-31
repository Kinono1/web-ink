import type { ReactNode } from "react";
import type { Language } from "../../../core/model";
import { Icon } from "../helpers";
import { COPY } from "../copy";
import type { IconName } from "../../../core/icons";

export function Alert({ kind, text, close, closeLabel }: {
  kind: "error" | "notice"; text: string; close: () => void; closeLabel: string;
}) {
  return (
    <p className={`alert ${kind}`} role={kind === "error" ? "alert" : "status"}>
      {text}
      <button onClick={close} aria-label={closeLabel}><Icon name="close" /></button>
    </p>
  );
}
export function Empty({ title, text, action, icon }: {
  title: string; text: string; action?: ReactNode; icon?: IconName;
}) {
  return (
    <section className="empty">
      {icon ? <span className="empty-icon" aria-hidden="true"><Icon name={icon} /></span> : null}
      <h2>{title}</h2>
      {text ? <p>{text}</p> : null}
      {action ? <div>{action}</div> : null}
    </section>
  );
}
export function PageHeader({ title, host, enabled, onToggle, toggleLabel, disabled = false }: {
  title: string; host?: string; enabled: boolean; onToggle?: () => void;
  toggleLabel: string; disabled?: boolean;
}) {
  return (
    <section className="page-header">
      <strong title={title}>{title}</strong>
      <div className="page-context">
        {host ? <span>{host}</span> : null}
        {onToggle ? (
          <button className={enabled ? "page-switch on" : "page-switch"} role="switch"
            aria-checked={enabled} disabled={disabled} onClick={onToggle}>
            <span aria-hidden="true" />{toggleLabel}
          </button>
        ) : null}
      </div>
    </section>
  );
}
export function SelectionToolbarSwitch({ enabled, saving = false, onToggle, t, describe = false }: {
  enabled: boolean; saving?: boolean; onToggle: () => void;
  t: (typeof COPY)[Language]; describe?: boolean;
}) {
  return (
    <div className={describe ? "selection-toolbar-setting described" : "selection-toolbar-setting"}>
      {describe ? <strong>{t.webpageSelectionToolbar}</strong> : null}
      <button className={enabled ? "page-switch on" : "page-switch"} type="button" role="switch"
        aria-label={t.selectionToolbar} aria-checked={enabled} disabled={saving} onClick={onToggle}>
        <span aria-hidden="true" />{t.selectionToolbar}
      </button>
      {describe ? <p className="hint">{t.selectionToolbarDescription}</p> : null}
    </div>
  );
}
