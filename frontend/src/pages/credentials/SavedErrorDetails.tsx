import React from 'react';
import type { RecordValue } from './model';

export interface SavedErrorDetailsProps {
  data: Readonly<RecordValue>;
}

const SENSITIVE_NORMALIZED_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'clientsecret',
  'password',
  'apipassword',
  'panelpassword',
  'managementtoken',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'privatekey',
  'credential',
  'credentials',
]);

function normalizeKey(key: string): string {
  let decoded = key;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    // Keep raw key if decoding fails
  }
  return decoded.toLowerCase().replace(/[-_\s]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const norm = normalizeKey(key);
  if (SENSITIVE_NORMALIZED_KEYS.has(norm)) {
    return true;
  }
  if (
    norm.includes('token') ||
    norm.includes('password') ||
    norm.includes('secret') ||
    norm.includes('privatekey') ||
    norm.includes('credential') ||
    norm.includes('authorization')
  ) {
    return true;
  }
  return false;
}

function isSensitiveQueryKey(rawKey: string): boolean {
  let decoded = rawKey;
  try {
    decoded = decodeURIComponent(rawKey);
  } catch {
    // Keep raw key if decoding fails
  }
  const norm = decoded.toLowerCase().replace(/[-_\s]/g, '');
  if (norm === 'key' || norm === 'code' || norm === 'state' || norm === 'auth' || norm === 'token') {
    return true;
  }
  if (
    isSensitiveKey(rawKey) ||
    norm.includes('oauth') ||
    norm.startsWith('auth') ||
    norm.endsWith('auth') ||
    norm.endsWith('key') ||
    norm.startsWith('key') ||
    norm === 'sig' ||
    norm.includes('signature')
  ) {
    return true;
  }
  return false;
}

export function sanitizeUrl(rawUrl: string): { sanitizedUrl: string; isValidHttp: boolean } {
  const hasControls = /[\x00-\x1f\x7f]/.test(rawUrl);

  try {
    const parsed = new URL(rawUrl);
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';

    // Remove userinfo from all representations
    parsed.username = '';
    parsed.password = '';

    // Sanitize query params including duplicates and encoded keys
    if (parsed.search) {
      const params = new URLSearchParams(parsed.search);
      const entries = Array.from(params.entries());
      const newParams = new URLSearchParams();
      for (const [k, v] of entries) {
        if (isSensitiveQueryKey(k)) {
          newParams.append(k, '[REDACTED]');
        } else {
          newParams.append(k, v);
        }
      }
      const searchStr = newParams.toString();
      parsed.search = searchStr ? `?${searchStr}` : '';
    }

    // Sanitize fragment key-values; redact opaque fragments
    if (parsed.hash) {
      const hashContent = parsed.hash.replace(/^#/, '');
      if (!hashContent) {
        parsed.hash = '';
      } else if (hashContent.includes('=')) {
        const parts = hashContent.split('&');
        const sanitizedParts = parts.map((part) => {
          const eqIdx = part.indexOf('=');
          if (eqIdx === -1) return part;
          const k = part.slice(0, eqIdx);
          const v = part.slice(eqIdx + 1);
          if (isSensitiveQueryKey(k)) {
            return `${k}=%5BREDACTED%5D`;
          }
          return `${k}=${v}`;
        });
        parsed.hash = `#${sanitizedParts.join('&')}`;
      } else {
        parsed.hash = '#%5BREDACTED%5D';
      }
    }

    const sanitized = parsed.toString();
    const isValidHttp = isHttp && !hasControls && !!parsed.hostname;
    return { sanitizedUrl: sanitized, isValidHttp };
  } catch {
    // Never display rejected credential-bearing URL raw
    let fallback = rawUrl;
    fallback = fallback.replace(/\/\/[^/\s:@]+(?::[^/\s:@]+)?@/g, '//');
    fallback = fallback.replace(
      /([?&])([^=&\s]+)=([^&\s#]*)/g,
      (match, p1, p2) => {
        if (isSensitiveQueryKey(p2)) {
          return `${p1}${p2}=%5BREDACTED%5D`;
        }
        return match;
      }
    );
    if (fallback.includes('#')) {
      const hashIdx = fallback.indexOf('#');
      const hashVal = fallback.slice(hashIdx + 1);
      if (hashVal && !hashVal.includes('=')) {
        fallback = `${fallback.slice(0, hashIdx)}#%5BREDACTED%5D`;
      }
    }
    return { sanitizedUrl: fallback, isValidHttp: false };
  }
}

function redactAssignmentMatch(prefix: string, value: string): string {
  const trimmedVal = value.trim();
  if (trimmedVal.startsWith('"') && trimmedVal.endsWith('"') && trimmedVal.length >= 2) {
    return `${prefix}"[REDACTED]"`;
  }
  if (trimmedVal.startsWith("'") && trimmedVal.endsWith("'") && trimmedVal.length >= 2) {
    return `${prefix}'[REDACTED]'`;
  }
  if (/^Bearer\b/i.test(trimmedVal)) {
    return `${prefix}Bearer [REDACTED]`;
  }
  return `${prefix}[REDACTED]`;
}

export function sanitizePlainText(input: string): string {
  if (!input) return input;

  let text = input;

  // 1. Redact PEM private key blocks
  text = text.replace(/-----BEGIN[A-Z0-9_\s-]+KEY-----[\s\S]*?-----END[A-Z0-9_\s-]+KEY-----/gi, '[REDACTED]');

  // 2. Redact full cookie and authorization header lines
  text = text.replace(/((?:^|[\r\n])\s*(?:set[\\s_-]?cookie|cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]');
  text = text.replace(/((?:^|[\r\n])\s*(?:proxy[\\s_-]?authorization|authorization)\s*[:=]\s*)(?:Bearer\s+[^\r\n]+|[^\r\n]+)/gi, (match, prefix) => {
    if (/Bearer\b/i.test(match)) {
      return `${prefix}Bearer [REDACTED]`;
    }
    return `${prefix}[REDACTED]`;
  });

  // 3. Redact URLs in text
  text = text.replace(/(https?:\/\/[^\s"'<>\\]+)/gi, (matched) => {
    let urlStr = matched;
    let trailing = '';
    while (urlStr.length > 0 && /[.,;:!?)]$/.test(urlStr)) {
      if (urlStr.endsWith(')')) {
        const openCount = (urlStr.match(/\(/g) || []).length;
        const closeCount = (urlStr.match(/\)/g) || []).length;
        if (openCount >= closeCount) break;
      }
      trailing = urlStr.slice(-1) + trailing;
      urlStr = urlStr.slice(0, -1);
    }
    const { sanitizedUrl } = sanitizeUrl(urlStr);
    return sanitizedUrl + trailing;
  });

  // 4. Redact complete Bearer values
  text = text.replace(
    /\b(Bearer\s+)(?:["'][^"'\r\n]+["']|[A-Za-z0-9\-._~+/]+=*)/gi,
    '$1[REDACTED]'
  );

  // 5. Redact sensitive assignments and headers (case, camel, hyphen, underscore variants)
  const assignmentPattern = new RegExp(
    '(' +
      '(?:^|[\\s,;{(])' +
      '["\']?' +
      '(?:' +
        'access[\\s_-]?token|' +
        'refresh[\\s_-]?token|' +
        'id[\\s_-]?token|' +
        'management[\\s_-]?token|' +
        'api[\\s_-]?password|' +
        'panel[\\s_-]?password|' +
        'password|' +
        'client[\\s_-]?secret|' +
        'proxy[\\s_-]?authorization|' +
        'authorization|' +
        'set[\\s_-]?cookie|' +
        'cookie|' +
        'api[\\s_-]?key|' +
        'private[\\s_-]?key|' +
        'credentials?|' +
        'token' +
      ')' +
      '["\']?' +
      '\\s*[:=]\\s*' +
    ')' +
    '(' +
      '\\{[^}]*\\}|' +
      '\\[[^\\]]*\\]|' +
      '"[^"\\r\\n]*"|' +
      '\'[^\'\\r\\n]*\'|' +
      '[^\\s,;)}\\r\\n][^,;)}\\r\\n]*' +
    ')',
    'gi'
  );

  text = text.replace(assignmentPattern, (_match, prefix, val) => {
    return redactAssignmentMatch(prefix, val);
  });

  return text;
}

function sanitizeJsonValue(key: string | null, value: unknown): unknown {
  if (key !== null) {
    const norm = normalizeKey(key);
    if (norm === 'credential' || norm === 'credentials' || isSensitiveKey(key)) {
      return '[REDACTED]';
    }
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(null, item));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        const normK = normalizeKey(k);
        if (normK === 'credential' || normK === 'credentials' || isSensitiveKey(k)) {
          result[k] = '[REDACTED]';
        } else {
          result[k] = sanitizeJsonValue(k, (value as Record<string, unknown>)[k]);
        }
      }
    }
    return result;
  }

  if (typeof value === 'string') {
    return sanitizePlainText(value);
  }

  return value;
}

export function sanitizeBody(rawBody: string): string {
  const trimmed = rawBody.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      const sanitized = sanitizeJsonValue(null, parsed);
      return JSON.stringify(sanitized, null, 2);
    } catch {
      // If parsing fails, fall back to plain text sanitization
    }
  }
  return sanitizePlainText(rawBody);
}

function sanitizeLabel(text: string): string {
  if (!text) return text;
  return sanitizePlainText(text);
}

function renderSanitizedContent(text: string): React.ReactNode[] {
  const urlRegex = /(https?:\/\/[^\s"'<>\\]+)/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(text)) !== null) {
    const rawMatch = match[1];
    const startIndex = match.index;
    const endIndex = startIndex + rawMatch.length;

    if (startIndex > lastIndex) {
      nodes.push(text.slice(lastIndex, startIndex));
    }

    let urlCandidate = rawMatch;
    let trailing = '';
    while (urlCandidate.length > 0 && /[.,;:!?)]$/.test(urlCandidate)) {
      if (urlCandidate.endsWith(')')) {
        const openCount = (urlCandidate.match(/\(/g) || []).length;
        const closeCount = (urlCandidate.match(/\)/g) || []).length;
        if (openCount >= closeCount) break;
      }
      trailing = urlCandidate.slice(-1) + trailing;
      urlCandidate = urlCandidate.slice(0, -1);
    }

    const { sanitizedUrl, isValidHttp } = sanitizeUrl(urlCandidate);

    if (isValidHttp) {
      nodes.push(
        <a
          key={`link-${startIndex}-${sanitizedUrl}`}
          href={sanitizedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline hover:opacity-80 break-all"
        >
          {sanitizedUrl}
        </a>
      );
      if (trailing) {
        nodes.push(trailing);
      }
    } else {
      nodes.push(sanitizedUrl + trailing);
    }

    lastIndex = endIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

type BodyStatus = 'valid' | 'empty_string' | 'missing_body' | 'malformed_body' | 'missing_map';

interface ProcessedErrorEntry {
  code: string;
  sanitizedCode: string;
  classification: string | null;
  bodyStatus: BodyStatus;
  sanitizedBody: string;
}

export function SavedErrorDetails({ data }: Readonly<{ data: Readonly<RecordValue> }>) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return (
      <section className="space-y-3 rounded-xl border border-border bg-card p-4 text-card-foreground text-sm" aria-label="已保存错误详情">
        <h4 className="font-semibold text-base">已保存错误详情</h4>
        <p className="text-muted-foreground">错误记录不可用</p>
      </section>
    );
  }

  // Read only own fields
  const filename = typeof data.filename === 'string' && data.filename.trim() ? sanitizeLabel(data.filename.trim()) : null;

  // HTTP200 may additionally contain error. Own top-level error means incomplete/unavailable with fixed explanation, never raw error text
  const hasTopLevelError = typeof data.error === 'string' && data.error.trim().length > 0;

  const rawCodes = Array.isArray(data.error_codes) ? data.error_codes : null;
  const hasMessagesMap = data.error_messages !== null && typeof data.error_messages === 'object' && !Array.isArray(data.error_messages);
  const rawMessages = hasMessagesMap ? (data.error_messages as Record<string, unknown>) : null;

  const hasClassificationsMap = data.error_classifications !== null && typeof data.error_classifications === 'object' && !Array.isArray(data.error_classifications);
  const rawClassifications = hasClassificationsMap ? (data.error_classifications as Record<string, unknown>) : null;

  // Preserve code order/dedup and append own message keys absent from codes; do not stringify objects or invent code0/classification
  const orderedCodes: string[] = [];
  const seenCodes = new Set<string>();

  if (rawCodes) {
    for (const c of rawCodes) {
      if (typeof c === 'string' || typeof c === 'number') {
        const sc = String(c).trim();
        if (sc !== '' && !seenCodes.has(sc)) {
          seenCodes.add(sc);
          orderedCodes.push(sc);
        }
      }
    }
  }

  if (rawMessages) {
    for (const k of Object.keys(rawMessages)) {
      if (Object.prototype.hasOwnProperty.call(rawMessages, k)) {
        const sk = String(k).trim();
        if (sk !== '' && !seenCodes.has(sk)) {
          seenCodes.add(sk);
          orderedCodes.push(sk);
        }
      }
    }
  }

  // Explicit empty history means no saved entries, never healthy
  const isExplicitEmpty = rawCodes !== null && rawCodes.length === 0 && (!rawMessages || Object.keys(rawMessages).length === 0);
  const isUnavailable = !rawCodes && !rawMessages && orderedCodes.length === 0;

  const entries: ProcessedErrorEntry[] = orderedCodes.map((code) => {
    const sanitizedCode = sanitizeLabel(code);

    let classification: string | null = null;
    if (rawClassifications && Object.prototype.hasOwnProperty.call(rawClassifications, code)) {
      const val = rawClassifications[code];
      if (typeof val === 'string') {
        classification = sanitizeLabel(val);
      } else if (val !== undefined && val !== null) {
        classification = '分类格式异常';
      }
    }

    let bodyStatus: BodyStatus;
    let sanitizedBody = '';

    if (!rawMessages) {
      bodyStatus = 'missing_map';
    } else if (!Object.prototype.hasOwnProperty.call(rawMessages, code)) {
      bodyStatus = 'missing_body';
    } else {
      const val = rawMessages[code];
      if (typeof val === 'string') {
        if (val === '') {
          bodyStatus = 'empty_string';
        } else {
          bodyStatus = 'valid';
          sanitizedBody = sanitizeBody(val);
        }
      } else {
        // do not stringify objects
        bodyStatus = 'malformed_body';
      }
    }

    return {
      code,
      sanitizedCode,
      classification,
      bodyStatus,
      sanitizedBody,
    };
  });

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4 text-card-foreground text-sm" aria-label="已保存错误详情">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <div>
          <h4 className="font-semibold text-base text-foreground">已保存错误详情</h4>
          {filename && (
            <p className="text-xs text-muted-foreground mt-0.5">
              凭证标识：<span className="font-mono text-foreground">{filename}</span>
            </p>
          )}
        </div>
      </div>

      {hasTopLevelError && (
        <div
          role="alert"
          className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning font-medium"
        >
          错误记录不完整或暂时不可用，请重新读取状态；请勿盲目重试。
        </div>
      )}

      {isExplicitEmpty ? (
        <p className="text-muted-foreground py-2 text-sm">无已保存错误记录</p>
      ) : isUnavailable ? (
        <p className="text-muted-foreground py-2 text-sm">错误记录不可用</p>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <article
              key={entry.code}
              className="rounded-lg border border-border bg-card/60 p-3 space-y-2 text-card-foreground shadow-xs"
              aria-label={`错误记录 ${entry.sanitizedCode}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold text-sm text-foreground">
                    错误码：{entry.sanitizedCode}
                  </span>
                  {entry.classification && (
                    <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      分类：{entry.classification}
                    </span>
                  )}
                </div>
              </div>

              {entry.bodyStatus === 'valid' && (
                <details
                  open
                  className="space-y-2 rounded border border-border/60 bg-muted/20 p-2.5"
                >
                  <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
                    错误正文详情（可选择复制）
                  </summary>
                  <div className="mt-2 space-y-2">
                    <div
                      className="max-h-80 overflow-auto rounded border border-border/40 bg-background/80 p-2.5 font-mono text-xs whitespace-pre-wrap break-all select-text"
                      tabIndex={0}
                      aria-label={`错误正文视图 ${entry.sanitizedCode}`}
                    >
                      {renderSanitizedContent(entry.sanitizedBody)}
                    </div>
                    <textarea
                      readOnly
                      value={entry.sanitizedBody}
                      rows={Math.min(10, Math.max(3, entry.sanitizedBody.split('\n').length))}
                      className="w-full resize-y rounded border border-border/40 bg-background/60 p-2 font-mono text-xs select-text whitespace-pre-wrap break-all focus:outline-none"
                      aria-label={`错误正文文本 ${entry.sanitizedCode}`}
                    />
                  </div>
                </details>
              )}

              {entry.bodyStatus === 'empty_string' && (
                <p className="text-xs text-muted-foreground italic">（正文为空）</p>
              )}

              {entry.bodyStatus === 'missing_body' && (
                <p className="text-xs text-muted-foreground italic">未记录错误正文</p>
              )}

              {entry.bodyStatus === 'malformed_body' && (
                <p className="text-xs text-destructive">错误正文格式异常（非文本）</p>
              )}

              {entry.bodyStatus === 'missing_map' && (
                <p className="text-xs text-destructive">错误正文映射缺失</p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
