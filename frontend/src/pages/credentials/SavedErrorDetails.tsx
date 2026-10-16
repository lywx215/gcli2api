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

function hasMalformedPercentEncoding(str: string): boolean {
  try {
    decodeURIComponent(str);
    return false;
  } catch {
    return true;
  }
}

function partiallyDecode(str: string): string {
  return str.replace(/%([0-9a-fA-F]{2})/g, (_, hex) => {
    const code = parseInt(hex, 16);
    return String.fromCharCode(code);
  });
}

function normalizeKey(key: string): string {
  let decoded = key;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    decoded = partiallyDecode(key);
  }
  return decoded.toLowerCase().replace(/[-_\s]/g, '');
}

function isSensitiveKey(key: string): boolean {
  if (hasMalformedPercentEncoding(key)) {
    return true;
  }
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
    norm.includes('authorization') ||
    norm.includes('cookie') ||
    norm.includes('apikey')
  ) {
    return true;
  }
  return false;
}

function isSensitiveQueryKey(rawKey: string): boolean {
  if (hasMalformedPercentEncoding(rawKey)) {
    return true;
  }
  let decoded = rawKey;
  try {
    decoded = decodeURIComponent(rawKey);
  } catch {
    decoded = partiallyDecode(rawKey);
  }
  const norm = decoded.toLowerCase().replace(/[-_\s]/g, '');
  if (norm === 'key' || norm === 'code' || norm === 'state' || norm === 'auth' || norm === 'token' || norm === 'sig' || norm === 'signature') {
    return true;
  }
  if (
    isSensitiveKey(rawKey) ||
    norm.includes('oauth') ||
    norm.startsWith('auth') ||
    norm.endsWith('auth') ||
    norm.endsWith('key') ||
    norm.startsWith('key') ||
    norm.includes('signature')
  ) {
    return true;
  }
  return false;
}

function sanitizeHash(hash: string): string {
  const content = hash.replace(/^#/, '');
  if (!content) return '';

  let prefix = '';
  let queryLike = content;
  const qIdx = content.indexOf('?');
  if (qIdx !== -1) {
    prefix = '%5BREDACTED%5D?';
    queryLike = content.slice(qIdx + 1);
  }

  const delimiter = queryLike.includes('&') ? '&' : (queryLike.includes(';') ? ';' : '&');
  const parts = queryLike.split(/[&;]/);
  const sanitizedParts: string[] = [];

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx !== -1) {
      const k = part.slice(0, eqIdx);
      const v = part.slice(eqIdx + 1);
      if (hasMalformedPercentEncoding(k) || isSensitiveQueryKey(k) || isSensitiveKey(k)) {
        sanitizedParts.push(`${k}=%5BREDACTED%5D`);
      } else {
        sanitizedParts.push(`${k}=${v}`);
      }
    } else {
      sanitizedParts.push('%5BREDACTED%5D');
    }
  }

  return `#${prefix}${sanitizedParts.join(delimiter)}`;
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
        if (hasMalformedPercentEncoding(k) || isSensitiveQueryKey(k) || isSensitiveKey(k)) {
          newParams.append(k, '[REDACTED]');
        } else {
          newParams.append(k, v);
        }
      }
      const searchStr = newParams.toString();
      parsed.search = searchStr ? `?${searchStr}` : '';
    }

    // Sanitize fragment key-values; conservatively redact opaque/ambiguous fragments
    if (parsed.hash) {
      parsed.hash = sanitizeHash(parsed.hash);
    }

    const sanitized = parsed.toString();
    const isValidHttp = isHttp && !hasControls && !!parsed.hostname;
    return { sanitizedUrl: sanitized, isValidHttp };
  } catch {
    // Never display rejected credential-bearing URL raw
    let fallback = rawUrl;
    // Strip complete userinfo from authority (including multicolon credentials)
    fallback = fallback.replace(/(\/\/[^\/\s?#]*)@/g, '//');

    // If authority still contains '@' before path/query/hash, redact authority
    const schemeMatch = /^https?:\/\//i.exec(fallback);
    if (schemeMatch) {
      const rest = fallback.slice(schemeMatch[0].length);
      const authEnd = rest.search(/[\/\?#]/);
      const authority = authEnd === -1 ? rest : rest.slice(0, authEnd);
      if (authority.includes('@')) {
        fallback = `${schemeMatch[0]}[REDACTED]${authEnd === -1 ? '' : rest.slice(authEnd)}`;
      }
    }

    fallback = fallback.replace(
      /([?&])([^=&\s#]+)=([^&\s#]*)/g,
      (match, p1, p2) => {
        if (hasMalformedPercentEncoding(p2) || isSensitiveQueryKey(p2) || isSensitiveKey(p2)) {
          return `${p1}${p2}=%5BREDACTED%5D`;
        }
        return match;
      }
    );
    if (fallback.includes('#')) {
      const hashIdx = fallback.indexOf('#');
      const basePart = fallback.slice(0, hashIdx);
      const hashPart = fallback.slice(hashIdx);
      fallback = `${basePart}${sanitizeHash(hashPart)}`;
    }
    return { sanitizedUrl: fallback, isValidHttp: false };
  }
}

function redactSensitiveAssignments(text: string): string {
  // Use [^\S\r\n]* instead of \s* to prevent consuming newlines
  const prefixRegex = /(?:^|[\s,;{(])(["']?)(?:access[\s_-]?token|refresh[\s_-]?token|id[\s_-]?token|management[\s_-]?token|api[\s_-]?password|panel[\s_-]?password|password|client[\s_-]?secret|proxy[\s_-]?authorization|authorization|set[\s_-]?cookie|cookie|api[\s_-]?key|private[\s_-]?key|credentials?|token)\1[^\S\r\n]*[:=][^\S\r\n]*/gi;

  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = prefixRegex.exec(text)) !== null) {
    const matchStart = match.index;
    const prefix = match[0];
    const valStart = matchStart + prefix.length;

    result += text.slice(lastIndex, valStart);

    if (valStart >= text.length) {
      lastIndex = valStart;
      break;
    }

    const rawValChar = text[valStart];
    let actualStart = valStart;

    // Empty assignment guard: if followed immediately by newline or carriage return,
    // check whether the next line contains a quoted/container/spaced secret or is a safe empty assignment boundary.
    if (rawValChar === '\r' || rawValChar === '\n') {
      let nextContentIdx = actualStart;
      if (text[nextContentIdx] === '\r' && text[nextContentIdx + 1] === '\n') {
        nextContentIdx += 2;
      } else {
        nextContentIdx += 1;
      }
      while (nextContentIdx < text.length && (text[nextContentIdx] === ' ' || text[nextContentIdx] === '\t')) {
        nextContentIdx++;
      }

      const nextLineStr = text.slice(nextContentIdx);
      const isBlankOrEof = nextContentIdx >= text.length || text[nextContentIdx] === '\r' || text[nextContentIdx] === '\n';
      const isBoundaryMarker = /^(?:===|---|###)/.test(nextLineStr);
      const isIndependentKeyOrHeader = /^[A-Za-z0-9_.-]+(?:[^\S\r\n]+[A-Za-z0-9_.-]+)*[^\S\r\n]*[:=]/.test(nextLineStr);

      if (isBlankOrEof || isBoundaryMarker || isIndependentKeyOrHeader) {
        lastIndex = valStart;
        prefixRegex.lastIndex = Math.max(valStart, match.index + 1);
        continue;
      }

      actualStart = nextContentIdx;
    }

    if (actualStart > valStart) {
      result += text.slice(valStart, actualStart);
    }

    const firstChar = text[actualStart];
    let valEnd = actualStart;
    let redacted = '[REDACTED]';

    if (firstChar === '"' || firstChar === "'") {
      const quote = firstChar;
      let idx = actualStart + 1;
      let closed = false;
      while (idx < text.length) {
        if (text[idx] === '\\') {
          idx += 2;
          continue;
        }
        if (text[idx] === quote) {
          idx++;
          closed = true;
          break;
        }
        idx++;
      }
      if (!closed) {
        // Unclosed quoted value fails closed to end
        valEnd = text.length;
      } else {
        valEnd = idx;
      }
      redacted = quote === '"' ? '"[REDACTED]"' : "'[REDACTED]'";
    } else if (firstChar === '{' || firstChar === '[') {
      const stack: string[] = [firstChar];
      let idx = actualStart + 1;
      let malformed = false;
      const MAX_CONTAINER_DEPTH = 32;

      while (idx < text.length && stack.length > 0) {
        const c = text[idx];
        if (c === '"' || c === "'") {
          const q = c;
          idx++;
          let strClosed = false;
          while (idx < text.length) {
            if (text[idx] === '\\') {
              idx += 2;
              continue;
            }
            if (text[idx] === q) {
              idx++;
              strClosed = true;
              break;
            }
            idx++;
          }
          if (!strClosed) {
            // Unclosed inner string in container fails closed
            malformed = true;
            break;
          }
          continue;
        }
        if (c === '{' || c === '[') {
          if (stack.length >= MAX_CONTAINER_DEPTH) {
            malformed = true;
            break;
          }
          stack.push(c);
          idx++;
          continue;
        }
        if (c === '}' || c === ']') {
          const top = stack[stack.length - 1];
          if ((top === '{' && c === '}') || (top === '[' && c === ']')) {
            stack.pop();
            idx++;
            if (stack.length === 0) {
              break;
            }
            continue;
          } else {
            // Mismatched closing bracket/brace
            malformed = true;
            break;
          }
        }
        idx++;
      }

      if (malformed || stack.length > 0) {
        // Conservative remainder masking for malformed/unclosed container
        valEnd = text.length;
      } else {
        valEnd = idx;
      }
      redacted = '[REDACTED]';
    } else {
      const remaining = text.slice(actualStart);
      const bearerMatch = /^Bearer\s+/i.exec(remaining);
      if (bearerMatch) {
        let idx = actualStart + bearerMatch[0].length;
        if (idx < text.length && (text[idx] === '"' || text[idx] === "'")) {
          const q = text[idx];
          idx++;
          let closed = false;
          while (idx < text.length) {
            if (text[idx] === '\\') {
              idx += 2;
              continue;
            }
            if (text[idx] === q) {
              idx++;
              closed = true;
              break;
            }
            idx++;
          }
          if (!closed) {
            valEnd = text.length;
          } else {
            valEnd = idx;
          }
        } else {
          while (idx < text.length && !/[\r\n,;})\]]/.test(text[idx])) {
            idx++;
          }
          valEnd = idx;
        }
        redacted = 'Bearer [REDACTED]';
      } else {
        let idx = actualStart;
        // Redact unquoted sensitive assignment until newline or structural delimiter
        while (idx < text.length && !/[\r\n,;})\]]/.test(text[idx])) {
          idx++;
        }
        valEnd = idx;
        redacted = '[REDACTED]';
      }
    }

    result += redacted;
    lastIndex = valEnd;
    if (valEnd >= text.length) {
      break;
    }
    prefixRegex.lastIndex = Math.max(valEnd, match.index + 1);
  }

  result += text.slice(lastIndex);
  return result;
}

function redactHeaderLines(text: string): string {
  const headerPrefixRegex = /(?:^|[\r\n])[^\S\r\n]*(?:set[\s_-]?cookie|cookie|proxy[\s_-]?authorization|authorization)[^\S\r\n]*[:=][^\S\r\n]*/gi;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = headerPrefixRegex.exec(text)) !== null) {
    const matchStart = match.index;
    const prefix = match[0];
    const valStart = matchStart + prefix.length;

    result += text.slice(lastIndex, valStart);

    if (valStart >= text.length) {
      lastIndex = valStart;
      break;
    }

    let actualStart = valStart;
    if (text[actualStart] === '\r' || text[actualStart] === '\n') {
      let nextContentIdx = actualStart;
      if (text[nextContentIdx] === '\r' && text[nextContentIdx + 1] === '\n') {
        nextContentIdx += 2;
      } else {
        nextContentIdx += 1;
      }
      while (nextContentIdx < text.length && (text[nextContentIdx] === ' ' || text[nextContentIdx] === '\t')) {
        nextContentIdx++;
      }

      const nextLineStr = text.slice(nextContentIdx);
      const isBlankOrEof = nextContentIdx >= text.length || text[nextContentIdx] === '\r' || text[nextContentIdx] === '\n';
      const isBoundaryMarker = /^(?:===|---|###)/.test(nextLineStr);
      const isIndependentKeyOrHeader = /^[A-Za-z0-9_.-]+(?:[^\S\r\n]+[A-Za-z0-9_.-]+)*[^\S\r\n]*[:=]/.test(nextLineStr);

      if (isBlankOrEof || isBoundaryMarker || isIndependentKeyOrHeader) {
        lastIndex = actualStart;
        headerPrefixRegex.lastIndex = Math.max(actualStart, match.index + 1);
        continue;
      }

      actualStart = nextContentIdx;
    }

    if (actualStart > valStart) {
      result += text.slice(valStart, actualStart);
    }

    const remaining = text.slice(actualStart);
    const bearerMatch = /^Bearer\s+/i.exec(remaining);
    const isBearer = !!bearerMatch;
    const valContentStart = bearerMatch ? actualStart + bearerMatch[0].length : actualStart;

    if (valContentStart >= text.length) {
      result += isBearer ? 'Bearer [REDACTED]' : '[REDACTED]';
      lastIndex = text.length;
      break;
    }

    const firstChar = text[valContentStart];
    let valEnd = valContentStart;

    if (firstChar === '"' || firstChar === "'") {
      const quote = firstChar;
      let idx = valContentStart + 1;
      let closed = false;
      while (idx < text.length) {
        if (text[idx] === '\\') {
          idx += 2;
          continue;
        }
        if (text[idx] === quote) {
          idx++;
          closed = true;
          break;
        }
        idx++;
      }
      if (!closed) {
        valEnd = text.length;
      } else {
        valEnd = idx;
      }
    } else {
      let idx = valContentStart;
      while (idx < text.length && text[idx] !== '\r' && text[idx] !== '\n') {
        idx++;
      }
      valEnd = idx;
    }

    result += isBearer ? 'Bearer [REDACTED]' : '[REDACTED]';
    lastIndex = valEnd;

    headerPrefixRegex.lastIndex = Math.max(valEnd, match.index + 1);
  }

  result += text.slice(lastIndex);
  return result;
}

export function sanitizePlainText(input: string): string {
  if (!input) return input;

  let text = input;

  // 1. Redact PEM private key blocks (both closed and unclosed)
  text = text.replace(
    /-----BEGIN[A-Z0-9_\s-]+KEY-----(?:[\s\S]*?-----END[A-Z0-9_\s-]+KEY-----|[\s\S]*$)/gi,
    '[REDACTED]'
  );

  // 2. Redact full cookie and authorization header lines
  text = redactHeaderLines(text);

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

  // 5. Redact sensitive assignments with bounded safe scanning
  text = redactSensitiveAssignments(text);

  return text;
}

const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 500;

function getUniqueKey(targetObj: Record<string, unknown>, baseKey: string): string {
  if (!Object.prototype.hasOwnProperty.call(targetObj, baseKey)) {
    return baseKey;
  }
  let index = 1;
  while (Object.prototype.hasOwnProperty.call(targetObj, `${baseKey}_${index}`)) {
    index++;
  }
  return `${baseKey}_${index}`;
}

function sanitizeJsonValue(
  key: string | null,
  value: unknown,
  depth: number,
  nodeCounter: { count: number }
): unknown {
  nodeCounter.count++;
  if (nodeCounter.count > MAX_JSON_NODES) {
    return '[NODE_LIMIT_EXCEEDED]';
  }

  if (depth > MAX_JSON_DEPTH) {
    return '[DEPTH_EXCEEDED]';
  }

  if (key !== null) {
    const norm = normalizeKey(key);
    if (norm === 'credential' || norm === 'credentials' || isSensitiveKey(key) || key === '__proto__') {
      return '[REDACTED]';
    }
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizePlainText(value);
  }

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      if (nodeCounter.count >= MAX_JSON_NODES) {
        result.push('[NODE_LIMIT_EXCEEDED]');
        break;
      }
      result.push(sanitizeJsonValue(null, value[i], depth + 1, nodeCounter));
    }
    return result;
  }

  if (typeof value === 'object') {
    const result = Object.create(null) as Record<string, unknown>;
    const keys = Object.getOwnPropertyNames(value);

    for (const rawKey of keys) {
      if (nodeCounter.count >= MAX_JSON_NODES) {
        const markerKey = getUniqueKey(result, '[NODE_LIMIT_EXCEEDED]');
        Object.defineProperty(result, markerKey, {
          value: '[NODE_LIMIT_EXCEEDED]',
          enumerable: true,
          writable: true,
          configurable: true,
        });
        break;
      }

      const desc = Object.getOwnPropertyDescriptor(value, rawKey);
      if (!desc || desc.get || desc.set || !('value' in desc)) {
        continue;
      }

      const val = desc.value;
      const isKeySensitive =
        rawKey === '__proto__' ||
        rawKey === 'constructor' ||
        rawKey === 'prototype' ||
        isSensitiveKey(rawKey);

      let safeKey: string;
      if (isKeySensitive) {
        safeKey = '[REDACTED]';
      } else {
        safeKey = sanitizePlainText(rawKey);
      }

      safeKey = getUniqueKey(result, safeKey);

      let sanitizedChild: unknown;
      if (isKeySensitive) {
        nodeCounter.count++;
        sanitizedChild = '[REDACTED]';
      } else {
        sanitizedChild = sanitizeJsonValue(rawKey, val, depth + 1, nodeCounter);
      }

      Object.defineProperty(result, safeKey, {
        value: sanitizedChild,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }

  return '[REDACTED]';
}

export function sanitizeBody(rawBody: string): string {
  const trimmed = rawBody.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      const sanitized = sanitizeJsonValue(null, parsed, 0, { count: 0 });
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

function getOwnDataProperty(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc && !desc.get && !desc.set && Object.prototype.hasOwnProperty.call(desc, 'value')) {
      return desc.value;
    }
  } catch {
    // Keep undefined on error
  }
  return undefined;
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

  // Read only own fields using property descriptors to avoid invoking accessors
  const rawFilename = getOwnDataProperty(data, 'filename');
  const filename = typeof rawFilename === 'string' && rawFilename.trim() ? sanitizeLabel(rawFilename.trim()) : null;

  // HTTP200 may additionally contain error. Own top-level error means incomplete/unavailable with fixed explanation, never raw error text
  const rawError = getOwnDataProperty(data, 'error');
  const hasTopLevelError = rawError !== undefined && rawError !== null && (typeof rawError !== 'string' || rawError.trim().length > 0);

  const rawCodesVal = getOwnDataProperty(data, 'error_codes');
  const rawCodes = Array.isArray(rawCodesVal) ? rawCodesVal : null;

  const rawMessagesVal = getOwnDataProperty(data, 'error_messages');
  const hasMessagesMap = rawMessagesVal !== null && typeof rawMessagesVal === 'object' && !Array.isArray(rawMessagesVal);
  const rawMessages = hasMessagesMap ? (rawMessagesVal as Record<string, unknown>) : null;

  const rawClassificationsVal = getOwnDataProperty(data, 'error_classifications');
  const hasClassificationsMap = rawClassificationsVal !== null && typeof rawClassificationsVal === 'object' && !Array.isArray(rawClassificationsVal);
  const rawClassifications = hasClassificationsMap ? (rawClassificationsVal as Record<string, unknown>) : null;

  // Preserve code order/dedup and append own message keys absent from codes; do not stringify objects or invent code0/classification
  const orderedCodes: string[] = [];
  const seenCodes = new Set<string>();

  if (rawCodes) {
    for (let i = 0; i < rawCodes.length; i++) {
      const codeVal = getOwnDataProperty(rawCodes, String(i));
      if (typeof codeVal === 'string' || typeof codeVal === 'number') {
        const sc = String(codeVal).trim();
        if (sc !== '' && !seenCodes.has(sc)) {
          seenCodes.add(sc);
          orderedCodes.push(sc);
        }
      }
    }
  }

  if (rawMessages) {
    const ownKeys = Object.getOwnPropertyNames(rawMessages);
    for (const k of ownKeys) {
      const msgVal = getOwnDataProperty(rawMessages, k);
      if (msgVal !== undefined) {
        const sk = String(k).trim();
        if (sk !== '' && !seenCodes.has(sk)) {
          seenCodes.add(sk);
          orderedCodes.push(sk);
        }
      }
    }
  }

  // Explicit empty history means no saved entries, never healthy
  const ownMessageKeysCount = rawMessages ? Object.getOwnPropertyNames(rawMessages).filter((k) => getOwnDataProperty(rawMessages, k) !== undefined).length : 0;
  const isExplicitEmpty = rawCodes !== null && rawCodes.length === 0 && (!rawMessages || ownMessageKeysCount === 0);
  const isUnavailable = !rawCodes && !rawMessages && orderedCodes.length === 0;

  const entries: ProcessedErrorEntry[] = orderedCodes.map((code) => {
    let sanitizedCode = sanitizeLabel(code);
    if (isSensitiveKey(code)) {
      sanitizedCode = '[REDACTED]';
    }

    let classification: string | null = null;
    if (rawClassifications) {
      const classDesc = Object.getOwnPropertyDescriptor(rawClassifications, code);
      if (classDesc && !classDesc.get && !classDesc.set && 'value' in classDesc) {
        const val = classDesc.value;
        if (typeof val === 'string') {
          classification = sanitizeLabel(val);
        } else if (val !== undefined && val !== null) {
          classification = '分类格式异常';
        }
      }
    }

    let bodyStatus: BodyStatus;
    let sanitizedBody = '';

    if (!rawMessages) {
      bodyStatus = 'missing_map';
    } else {
      const msgDesc = Object.getOwnPropertyDescriptor(rawMessages, code);
      if (!msgDesc || msgDesc.get || msgDesc.set || !('value' in msgDesc)) {
        bodyStatus = 'missing_body';
      } else {
        const val = msgDesc.value;
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
