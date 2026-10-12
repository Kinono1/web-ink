import type { IeeePdfDiagnostic } from './ieee-diagnostics';

export function pdfPreparationLabel(phase: string | undefined, language: string): string {
  const labels: Record<string, [string, string]> = {
    identify: ['正在识别来源…', 'Identifying source…'],
    wrapper: ['正在读取来源页面…', 'Reading source page…'],
    file: ['正在读取 PDF…', 'Reading PDF…'],
    validate: ['正在校验 PDF…', 'Checking PDF…'],
    opening: ['正在打开阅读器…', 'Opening reader…'],
  };
  return (labels[phase ?? 'identify'] ?? labels.identify)![language === 'zh-CN' ? 0 : 1];
}

export function ieeeFailureMessage(code: string | undefined, language: string): string | undefined {
  const messages: Record<string, [string, string]> = {
    'source-hidden': ['没有找到 PDF 全文来源，原页面已保留。请从 IEEE 论文页重新打开全文。', 'Full-text PDF source not found. Original page retained. Open the full text from the IEEE paper page.'],
    'site-permission': ['需要允许访问 IEEE 后重试。', 'Allow access to IEEE, then retry.'],
    'login-required': ['登录状态不可用，原 PDF 已保留。请回论文页登录后重试。', 'Sign-in is unavailable. Original PDF retained. Sign in on the paper page, then retry.'],
    'access-restricted': ['IEEE 拒绝访问，原 PDF 已保留。请在论文页确认访问权限。', 'IEEE denied access. Original PDF retained. Check access on the paper page.'],
    'redirect-blocked': ['读取过程中需要跳转，原 PDF 已保留。请回论文页重新打开全文。', 'Reading requires a redirect. Original PDF retained. Reopen full text from the paper page.'],
    'not-pdf': ['没有取得有效的 PDF 全文，原页面已保留。请回论文页重新打开全文。', 'No valid full-text PDF was received. Original page retained. Reopen full text from the paper page.'],
    network: ['读取未完成，原因尚未确认。原 PDF 已保留，可以重试或查看诊断详情。', 'Reading did not finish; the cause is not confirmed. Original PDF retained. Retry or view diagnostic details.'],
  };
  const reason = code?.startsWith('IEEE_') ? code.slice(5) : undefined;
  const message = reason ? messages[reason] : undefined;
  return message?.[language === 'zh-CN' ? 0 : 1];
}

export function formatIeeeDiagnostic(diagnostic: IeeePdfDiagnostic, version: string): string {
  return JSON.stringify({ extensionVersion: version, id: diagnostic.id, schemaVersion: 1,
    phase: diagnostic.phase, elapsedMs: diagnostic.elapsedMs, sourceKind: diagnostic.sourceKind,
    ...(diagnostic.status !== undefined ? { status: diagnostic.status } : {}),
    ...(diagnostic.mime ? { mime: diagnostic.mime } : {}),
  }, null, 2);
}
