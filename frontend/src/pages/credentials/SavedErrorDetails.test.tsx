import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SavedErrorDetails } from './SavedErrorDetails';
import type { RecordValue } from './model';

describe('SavedErrorDetails Component', () => {
  it('1. renders complete long multiline and JSON body with extra-key and empty distinctions without truncation', () => {
    // Generate long multiline body (harmless start, 50 middle lines, harmless end)
    const longLines = [
      '=== HARMLESS_START: Operation failed in worker queue ===',
      ...Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: processing step diagnostic status=running harmless_metric=42`),
      '=== HARMLESS_END: Execution stopped successfully ===',
    ];
    const longBody = longLines.join('\n');

    const jsonExtraBody = JSON.stringify({
      error: 'Forbidden access',
      detail: {
        reason: 'tier_restricted',
        harmless_tier: 'tier_free',
      },
      count: 10,
    });

    const data: RecordValue = {
      filename: 'cred-prod-01.json',
      error_codes: ['500', '429'],
      error_messages: {
        '500': longBody,
        '429': '', // empty string body
        '403': jsonExtraBody, // extra key absent from error_codes
      },
      error_classifications: {
        '500': 'Server Internal Error',
        '429': 'Rate Limit Exceeded',
        '403': 'Permission Denied',
      },
    };

    const { container } = render(<SavedErrorDetails data={data} />);

    // Filename displayed
    expect(screen.getByText('cred-prod-01.json')).toBeInTheDocument();

    // Preserve code order ('500' then '429') and append extra key ('403')
    const codeBadges = container.querySelectorAll('article span.font-mono');
    const codeTexts = Array.from(codeBadges).map((el) => el.textContent || '');
    expect(codeTexts.some((t) => t.includes('500'))).toBe(true);
    expect(codeTexts.some((t) => t.includes('429'))).toBe(true);
    expect(codeTexts.some((t) => t.includes('403'))).toBe(true);

    const index500 = codeTexts.findIndex((t) => t.includes('500'));
    const index429 = codeTexts.findIndex((t) => t.includes('429'));
    const index403 = codeTexts.findIndex((t) => t.includes('403'));
    expect(index500).toBeLessThan(index429);
    expect(index429).toBeLessThan(index403);

    // Full harmless start and end preserved without truncation
    expect(container.textContent).toContain('=== HARMLESS_START: Operation failed in worker queue ===');
    expect(container.textContent).toContain('=== HARMLESS_END: Execution stopped successfully ===');

    // Textarea selectable value has full long body from start to end
    const textareas = container.querySelectorAll('textarea');
    expect(textareas.length).toBeGreaterThanOrEqual(2);
    const textarea500 = Array.from(textareas).find((t) => t.value.includes('HARMLESS_START'));
    expect(textarea500).toBeDefined();
    expect(textarea500!.value).toContain('=== HARMLESS_START: Operation failed in worker queue ===');
    expect(textarea500!.value).toContain('Line 25: processing step diagnostic status=running harmless_metric=42');
    expect(textarea500!.value).toContain('=== HARMLESS_END: Execution stopped successfully ===');

    // Extra key '403' formatted JSON is displayed with full keys
    const textarea403 = Array.from(textareas).find((t) => t.value.includes('tier_restricted'));
    expect(textarea403).toBeDefined();
    expect(textarea403!.value).toContain('"harmless_tier": "tier_free"');

    // Empty body for '429' is explicitly distinguished from missing body
    expect(screen.getByText('（正文为空）')).toBeInTheDocument();

    cleanup();

    // Subcase: explicit empty history means no saved entries, never healthy
    const emptyData: RecordValue = {
      filename: 'cred-empty.json',
      error_codes: [],
      error_messages: {},
    };
    const { container: emptyContainer } = render(<SavedErrorDetails data={emptyData} />);
    expect(emptyContainer.textContent).toContain('无已保存错误记录');
    expect(emptyContainer.textContent).not.toContain('健康');
    expect(emptyContainer.textContent).not.toContain('正常');
  });

  it('2. handles malformed error map, object bodies, and HTTP 200 error with fixed explanation', () => {
    // Inherited prototype fields must be ignored ("Read only own fields")
    const protoMap = {
      inherited_proto_key: 'INHERITED_SECRET_VALUE',
    };
    const ownMessages = Object.create(protoMap);
    ownMessages['ERR_MALFORMED_OBJ'] = { internal_obj_key: 'RAW_OBJECT_DATA' }; // Malformed body (object)
    ownMessages['ERR_EMPTY'] = ''; // Empty string
    // 'ERR_MISSING' is in error_codes but absent from ownMessages

    const data: RecordValue = {
      filename: 'cred-http200-err.json',
      error: 'CRITICAL_RAW_BACKEND_TRACE: sqlite3.OperationalError database locked at /var/run/secrets/creds.db',
      error_codes: ['ERR_MALFORMED_OBJ', 'ERR_EMPTY', 'ERR_MISSING'],
      error_messages: ownMessages,
      error_classifications: null, // missing classifications map
    };

    const { container } = render(<SavedErrorDetails data={data} />);

    // Top-level error produces fixed explanation, never raw error text
    expect(container.textContent).toContain('错误记录不完整或暂时不可用，请重新读取状态；请勿盲目重试。');
    expect(container.textContent).not.toContain('CRITICAL_RAW_BACKEND_TRACE');
    expect(container.textContent).not.toContain('/var/run/secrets/creds.db');

    // Retain legitimate entries
    expect(container.textContent).toContain('ERR_MALFORMED_OBJ');
    expect(container.textContent).toContain('ERR_EMPTY');
    expect(container.textContent).toContain('ERR_MISSING');

    // Inherited prototype key must not be read or rendered
    expect(container.textContent).not.toContain('inherited_proto_key');
    expect(container.textContent).not.toContain('INHERITED_SECRET_VALUE');

    // Object body is NOT stringified ("do not stringify objects")
    expect(container.textContent).not.toContain('[object Object]');
    expect(container.textContent).not.toContain('RAW_OBJECT_DATA');
    expect(screen.getByText('错误正文格式异常（非文本）')).toBeInTheDocument();

    // Empty string body vs missing body distinction
    expect(screen.getByText('（正文为空）')).toBeInTheDocument();
    expect(screen.getByText('未记录错误正文')).toBeInTheDocument();

    // Missing classifications does not invent "code0" or fake default classification
    expect(container.textContent).not.toContain('code0');
    expect(container.textContent).not.toContain('分类 0');
  });

  it('3. redacts nested JSON and plain labelled secret canaries while preserving harmless diagnostic context', () => {
    const CANARIES = {
      bearer: 'CANARY_BEARER_TOKEN_998877',
      access_token: 'CANARY_ACCESS_TOKEN_112233',
      refresh_token: 'CANARY_REFRESH_TOKEN_445566',
      id_token: 'CANARY_ID_TOKEN_778899',
      password: 'CANARY_PASSWORD_SECRET_VAL',
      api_key_spaces: 'CANARY API KEY WITH SPACES',
      client_secret: 'CANARY CLIENT SECRET WITH SPACES',
      mgmt_token: 'CANARY_MANAGEMENT_TOKEN_ABC',
      proxy_auth: 'CANARY_PROXY_AUTH_XYZ',
      cookie: 'CANARY_COOKIE_SESSION_VAL',
      set_cookie: 'CANARY_SET_COOKIE_SEC_VAL',
      private_key: 'CANARY_PRIVATE_KEY_PAYLOAD_HERE',
      credentials_container: 'CANARY_CREDENTIALS_CONTAINER_SECRET',
    };

    const plainBody = [
      'Harmless start prefix: service failed to connect to upstream worker.',
      'Harmless diagnostic: token expired at 15:30:00 UTC.',
      'Harmless diagnostic: invalid refresh token received from proxy.',
      `Authorization: Bearer ${CANARIES.bearer}`,
      `api_key: "${CANARIES.api_key_spaces}"`,
      `client_secret: '${CANARIES.client_secret}'`,
      `password: ${CANARIES.password}`,
      `management_token: ${CANARIES.mgmt_token}`,
      `proxy-authorization: Basic ${CANARIES.proxy_auth}`,
      `Cookie: session_id=${CANARIES.cookie}; path=/`,
      `Set-Cookie: auth_token=${CANARIES.set_cookie}; Secure; HttpOnly`,
      `private_key: ${CANARIES.private_key}`,
      `credentials: {"secret_id": "${CANARIES.credentials_container}"}`,
      `access_token: ${CANARIES.access_token}`,
      `refresh_token: ${CANARIES.refresh_token}`,
      `id_token: ${CANARIES.id_token}`,
      'Harmless end suffix: retry budget exhausted; no success keyword used.',
    ].join('\n');

    const jsonNestedBody = JSON.stringify({
      status: 'failed',
      diagnostic: 'Harmless JSON diagnostic: token refresh returned malformed payload',
      auth: {
        access_token: CANARIES.access_token,
        nested: {
          password: CANARIES.password,
          refresh_token: CANARIES.refresh_token,
        },
      },
      credentials: {
        api_key: CANARIES.api_key_spaces,
        client_secret: CANARIES.client_secret,
      },
    });

    const data: RecordValue = {
      filename: 'cred-secrets.json',
      error_codes: ['ERR_PLAIN_SECRETS', 'ERR_JSON_SECRETS'],
      error_messages: {
        'ERR_PLAIN_SECRETS': plainBody,
        'ERR_JSON_SECRETS': jsonNestedBody,
      },
      error_classifications: {
        'ERR_PLAIN_SECRETS': 'Auth Redaction Test',
        'ERR_JSON_SECRETS': 'JSON Redaction Test',
      },
    };

    const { container } = render(<SavedErrorDetails data={data} />);

    // None of the canary secrets must exist in container HTML, text, or textarea values
    const allHtml = container.innerHTML;
    for (const [name, secret] of Object.entries(CANARIES)) {
      expect(allHtml, `Canary [${name}] leaked in innerHTML`).not.toContain(secret);
    }

    const textareas = container.querySelectorAll('textarea');
    for (const textarea of textareas) {
      for (const [name, secret] of Object.entries(CANARIES)) {
        expect(textarea.value, `Canary [${name}] leaked in textarea value`).not.toContain(secret);
      }
    }

    // Harmless diagnostic text mentioning token remains readable
    expect(container.textContent).toContain('Harmless start prefix: service failed to connect to upstream worker.');
    expect(container.textContent).toContain('Harmless diagnostic: token expired at 15:30:00 UTC.');
    expect(container.textContent).toContain('Harmless diagnostic: invalid refresh token received from proxy.');
    expect(container.textContent).toContain('Harmless end suffix: retry budget exhausted; no success keyword used.');
    expect(container.textContent).toContain('Harmless JSON diagnostic: token refresh returned malformed payload');

    // Redaction marker is displayed
    expect(container.textContent).toContain('[REDACTED]');
  });

  it('4. sanitizes safe URLs, renders inert XSS attacks, handles prop replacement and unmount with zero transport', () => {
    const URL_CANARIES = {
      userinfo_pass: 'SECRET_USERINFO_PASSWORD_123',
      query_token: 'SECRET_QUERY_TOKEN_456',
      query_code: 'SECRET_QUERY_CODE_789',
      query_state: 'SECRET_QUERY_STATE_ABC',
      query_apikey: 'SECRET_QUERY_APIKEY_DEF',
      encoded_key: 'SECRET_ENCODED_KEY_GHI',
      dup_token: 'SECRET_DUP_TOKEN_JKL',
      opaque_fragment: 'SECRET_OPAQUE_FRAGMENT_MNO',
      frag_token: 'SECRET_FRAG_KEYVAL_TOKEN_PQR',
    };

    const urlWithCanaries = `https://admin:${URL_CANARIES.userinfo_pass}@api.example.com/oauth/callback?token=${URL_CANARIES.query_token}&code=${URL_CANARIES.query_code}&state=${URL_CANARIES.query_state}&api_key=${URL_CANARIES.query_apikey}&api%5Fkey=${URL_CANARIES.encoded_key}&token=${URL_CANARIES.dup_token}&harmless_param=keep_me#${URL_CANARIES.opaque_fragment}`;
    const urlFragKeyVal = `https://api.example.com/connect?harmless_id=safe_123#access_token=${URL_CANARIES.frag_token}&token_type=bearer`;

    const xssPayloads = [
      '<script>window.__XSS_TRIGGERED__ = true;</script>',
      '<img src="x" onerror="window.__XSS_IMG__ = true" />',
      '<iframe src="javascript:alert(1)"></iframe>',
      'javascript:alert("XSS_PROTOCOL")',
      'data:text/html,<script>alert("XSS_DATA")</script>',
      'file:///etc/passwd',
      '//evil.example.com/phish',
    ].join('\n');

    const bodyText = [
      'Harmless URL diagnostics start.',
      `OAuth authorization callback URL: ${urlWithCanaries}`,
      `Fragment token URL: ${urlFragKeyVal}`,
      'XSS attack test strings follow:',
      xssPayloads,
      'Harmless URL diagnostics end.',
    ].join('\n');

    const data1: RecordValue = {
      filename: 'cred-url-xss.json',
      error_codes: ['ERR_URL_XSS'],
      error_messages: {
        'ERR_URL_XSS': bodyText,
      },
    };

    const { container, rerender, unmount } = render(<SavedErrorDetails data={data1} />);

    // Zero transport check: global.fetch was never invoked
    expect(global.fetch).not.toHaveBeenCalled();

    // Check all URL secret canaries are completely redacted
    const allHtml = container.innerHTML;
    for (const [name, secret] of Object.entries(URL_CANARIES)) {
      expect(allHtml, `URL canary [${name}] found in DOM`).not.toContain(secret);
    }
    expect(allHtml).not.toContain('admin:');

    // Only validated absolute http(s) without userinfo becomes anchor
    const anchors = container.querySelectorAll('a');
    expect(anchors.length).toBeGreaterThanOrEqual(1);

    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';
      expect(href).toMatch(/^https?:\/\//);
      expect(anchor.getAttribute('target')).toBe('_blank');
      expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
      expect(href).not.toContain(URL_CANARIES.userinfo_pass);
      expect(href).not.toContain(URL_CANARIES.query_token);
      expect(href).not.toContain(URL_CANARIES.opaque_fragment);
      // Consistent sanitized text/href
      expect(anchor.textContent).toBe(href);
    }

    // Inactive XSS check: no executable elements created in DOM
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();

    // Dangerous protocols (javascript:, data:, file:, protocol-relative //) NEVER become anchors
    const anchorHrefs = Array.from(anchors).map((a) => a.getAttribute('href') || '');
    expect(anchorHrefs.some((h) => h.startsWith('javascript:'))).toBe(false);
    expect(anchorHrefs.some((h) => h.startsWith('data:'))).toBe(false);
    expect(anchorHrefs.some((h) => h.startsWith('file:'))).toBe(false);
    expect(anchorHrefs.some((h) => h.startsWith('//'))).toBe(false);

    // Prop replacement removes old content
    const data2: RecordValue = {
      filename: 'cred-replacement.json',
      error_codes: ['ERR_REPLACED'],
      error_messages: {
        'ERR_REPLACED': 'Replaced error body content completely without retaining old raw state.',
      },
    };
    rerender(<SavedErrorDetails data={data2} />);

    expect(container.textContent).toContain('cred-replacement.json');
    expect(container.textContent).toContain('ERR_REPLACED');
    expect(container.textContent).toContain('Replaced error body content completely');
    expect(container.textContent).not.toContain('cred-url-xss.json');
    expect(container.textContent).not.toContain('ERR_URL_XSS');
    expect(container.textContent).not.toContain('Harmless URL diagnostics start');

    // Unmount removes content cleanly
    unmount();
    expect(container.innerHTML).toBe('');

    // Ensure zero transport throughout the test lifecycle
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
