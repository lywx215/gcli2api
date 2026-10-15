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

  it('5. ignores inherited fields/accessors, isolates unclosed PEM, masks nested/unclosed plain secrets, and preserves harmless multiline context', () => {
    // 1. Inherited prototype fields and own getters must never invoke accessors
    let getterInvocations = 0;
    const proto: Record<string, unknown> = {};
    Object.defineProperty(proto, 'error', {
      get() {
        getterInvocations++;
        throw new Error('FAIL: inherited error getter invoked');
      },
    });
    Object.defineProperty(proto, 'filename', {
      get() {
        getterInvocations++;
        throw new Error('FAIL: inherited filename getter invoked');
      },
    });
    Object.defineProperty(proto, 'error_codes', {
      value: ['INHERITED_CODE_CANARY_1'],
    });
    Object.defineProperty(proto, 'error_messages', {
      value: { INHERITED_CODE_CANARY_1: 'INHERITED_MSG_CANARY_1' },
    });
    Object.defineProperty(proto, 'error_classifications', {
      value: { INHERITED_CODE_CANARY_1: 'INHERITED_CLASS_CANARY_1' },
    });

    const inheritedData: RecordValue = Object.create(proto);
    // Add own root property getter
    Object.defineProperty(inheritedData, 'untrusted_own_root_getter', {
      get() {
        getterInvocations++;
        throw new Error('FAIL: own root getter invoked');
      },
    });
    // Add legitimate own filename data property
    Object.defineProperty(inheritedData, 'filename', {
      value: 'cred-own-properties.json',
      enumerable: true,
    });
    // Add own code-array with an index getter and a legitimate index data property
    const ownCodesArray: string[] = [];
    Object.defineProperty(ownCodesArray, '0', {
      value: 'ERR_SAFE_OWN_CODE',
      enumerable: true,
    });
    Object.defineProperty(ownCodesArray, '1', {
      get() {
        getterInvocations++;
        throw new Error('FAIL: code array index getter invoked');
      },
      enumerable: true,
    });
    Object.defineProperty(inheritedData, 'error_codes', {
      value: ownCodesArray,
      enumerable: true,
    });
    // Add own messages map with a getter and a legitimate message data property
    const ownMessagesMap: Record<string, unknown> = {};
    Object.defineProperty(ownMessagesMap, 'ERR_SAFE_OWN_CODE', {
      value: 'Legitimate own error message preserved',
      enumerable: true,
    });
    Object.defineProperty(ownMessagesMap, 'ERR_GETTER_CODE', {
      get() {
        getterInvocations++;
        throw new Error('FAIL: message map getter invoked');
      },
      enumerable: true,
    });
    Object.defineProperty(inheritedData, 'error_messages', {
      value: ownMessagesMap,
      enumerable: true,
    });
    // Add own classifications map with a getter and a legitimate classification data property
    const ownClassificationsMap: Record<string, unknown> = {};
    Object.defineProperty(ownClassificationsMap, 'ERR_SAFE_OWN_CODE', {
      value: 'Safe Own Category',
      enumerable: true,
    });
    Object.defineProperty(ownClassificationsMap, 'ERR_GETTER_CODE', {
      get() {
        getterInvocations++;
        throw new Error('FAIL: classification map getter invoked');
      },
      enumerable: true,
    });
    Object.defineProperty(inheritedData, 'error_classifications', {
      value: ownClassificationsMap,
      enumerable: true,
    });

    const { container: inheritedContainer } = render(<SavedErrorDetails data={inheritedData} />);

    // Zero invocations proved
    expect(getterInvocations).toBe(0);

    // Inherited values never leaked
    expect(inheritedContainer.textContent).not.toContain('INHERITED_CODE_CANARY_1');
    expect(inheritedContainer.textContent).not.toContain('INHERITED_MSG_CANARY_1');
    expect(inheritedContainer.textContent).not.toContain('INHERITED_CLASS_CANARY_1');

    // Legitimate own properties preserved and rendered
    expect(inheritedContainer.textContent).toContain('cred-own-properties.json');
    expect(inheritedContainer.textContent).toContain('ERR_SAFE_OWN_CODE');
    expect(inheritedContainer.textContent).toContain('Legitimate own error message preserved');
    expect(inheritedContainer.textContent).toContain('Safe Own Category');

    cleanup();

    // 2. Plain secrets isolation test suite
    const PLAIN_CANARIES = {
      unclosed_pem: 'CANARY_UNCLOSED_PEM_PAYLOAD_X99',
      unclosed_pem_tail: 'CANARY_UNCLOSED_PEM_TAIL_M88',
      nested_container: 'CANARY_NESTED_CONTAINER_SECRET_Y88',
      escaped_quote: 'CANARY_ESCAPED_QUOTE_SECRET_W66',
      unclosed_container: 'CANARY_UNCLOSED_CONTAINER_SECRET_Z77',
      unclosed_quote: 'CANARY_UNCLOSED_QUOTE_SECRET_V55',
      unclosed_quote_tail: 'CANARY_UNCLOSED_QUOTE_TAIL_U44',
      mismatched_container_tail: 'CANARY_MISMATCHED_CONTAINER_TAIL_T33',
      unquoted_second_word: 'CANARY_SECOND_WORD_SECRET_S22',
      nested_quote_tail: 'CANARY_NESTED_QUOTE_TAIL_R11',
      multiline_header: 'CANARY_MULTILINE_HEADER_Q00',
      newline_container: 'CANARY_NEWLINE_CONTAINER_P99',
    };

    // Body A: Independent unclosed PEM (fail-closed behavior consumes payload and uncertain tail)
    const unclosedPemBody = [
      '=== HARMLESS_PEM_START: service starting ===',
      '-----BEGIN EC PRIVATE KEY-----',
      `MHcCAQEEI${PLAIN_CANARIES.unclosed_pem}`,
      `Ambiguous unclosed PEM trailing line with secret: ${PLAIN_CANARIES.unclosed_pem_tail}`,
    ].join('\n');

    // Body B: Nested CLOSED container, real escaped quote, and harmless multiline start-middle-end
    const closedAndEscapedBody = [
      '=== HARMLESS_START: worker queue initialized ===',
      'Harmless diagnostic middle: normal service line here.',
      `credentials: {"config": {"secret_nested": "${PLAIN_CANARIES.nested_container}"}, "safe_param": 123}`,
      `api_key: "prefix_\\"with_real_backslash_quote\\"_${PLAIN_CANARIES.escaped_quote}_suffix"`,
      'Harmless diagnostic between closed assignments: all clear.',
      '=== HARMLESS_END: worker queue completed ===',
    ].join('\n');

    // Body C: Independent unclosed container
    const unclosedContainerBody = `token: {"unclosed_inner": "${PLAIN_CANARIES.unclosed_container}"`;

    // Body D: Independent unclosed quote spanning lines
    const unclosedQuoteBody = [
      'password: "first_line_of_unclosed_quote',
      `continuation line with secret: ${PLAIN_CANARIES.unclosed_quote}`,
      `ambiguous tail: ${PLAIN_CANARIES.unclosed_quote_tail}`,
    ].join('\n');

    // Body E: Independent mismatched closer
    const mismatchedCloserBody = `credentials: {"a": 1] CANARY_CONTAINER_TAIL: ${PLAIN_CANARIES.mismatched_container_tail} }\nharmless_after_mismatch: line`;

    // Body F: Unquoted sensitive assignment with spaces
    const unquotedSpacesBody = `password: alpha ${PLAIN_CANARIES.unquoted_second_word}\nharmless_after_unquoted: line`;

    // Body G: Nested quote across newline inside container
    const nestedQuoteNewlineBody = `credentials: {"field": "first\n} CANARY_NESTED_QUOTE: ${PLAIN_CANARIES.nested_quote_tail}`;

    // Body H: Multiline quoted header with closed context
    const multilineHeaderBody = [
      'Authorization: "first_header_line',
      `CANARY_AUTH_HEADER_CONT: ${PLAIN_CANARIES.multiline_header}"`,
      'harmless_after_multiline_header: line',
    ].join('\n');

    // Body I: Newline sensitive container with closed context
    const newlineContainerBody = [
      'credentials:',
      `{"secret_field": "${PLAIN_CANARIES.newline_container}"}`,
      'harmless_after_newline_container: line',
    ].join('\n');

    const data: RecordValue = {
      filename: 'cred-plain-nested.json',
      error_codes: [
        'ERR_UNCLOSED_PEM',
        'ERR_CLOSED_NESTED',
        'ERR_UNCLOSED_CONTAINER',
        'ERR_UNCLOSED_QUOTE',
        'ERR_MISMATCHED_CLOSER',
        'ERR_UNQUOTED_SPACES',
        'ERR_NESTED_QUOTE_NEWLINE',
        'ERR_MULTILINE_HEADER',
        'ERR_NEWLINE_CONTAINER',
      ],
      error_messages: {
        'ERR_UNCLOSED_PEM': unclosedPemBody,
        'ERR_CLOSED_NESTED': closedAndEscapedBody,
        'ERR_UNCLOSED_CONTAINER': unclosedContainerBody,
        'ERR_UNCLOSED_QUOTE': unclosedQuoteBody,
        'ERR_MISMATCHED_CLOSER': mismatchedCloserBody,
        'ERR_UNQUOTED_SPACES': unquotedSpacesBody,
        'ERR_NESTED_QUOTE_NEWLINE': nestedQuoteNewlineBody,
        'ERR_MULTILINE_HEADER': multilineHeaderBody,
        'ERR_NEWLINE_CONTAINER': newlineContainerBody,
      },
    };

    const { container } = render(<SavedErrorDetails data={data} />);

    // None of the plain canaries leak in innerHTML, textContent, or textarea values
    const allHtml = container.innerHTML;
    for (const [name, secret] of Object.entries(PLAIN_CANARIES)) {
      expect(allHtml, `Canary [${name}] leaked in DOM HTML`).not.toContain(secret);
      expect(container.textContent, `Canary [${name}] leaked in textContent`).not.toContain(secret);
    }

    const textareas = container.querySelectorAll('textarea');
    for (const textarea of textareas) {
      for (const [name, secret] of Object.entries(PLAIN_CANARIES)) {
        expect(textarea.value, `Canary [${name}] leaked in textarea value`).not.toContain(secret);
      }
    }

    // Harmless context in properly closed or external regions is preserved
    expect(container.textContent).toContain('=== HARMLESS_PEM_START: service starting ===');
    expect(container.textContent).toContain('=== HARMLESS_START: worker queue initialized ===');
    expect(container.textContent).toContain('Harmless diagnostic middle: normal service line here.');
    expect(container.textContent).toContain('Harmless diagnostic between closed assignments: all clear.');
    expect(container.textContent).toContain('=== HARMLESS_END: worker queue completed ===');
    expect(container.textContent).toContain('harmless_after_unquoted: line');
    expect(container.textContent).toContain('harmless_after_multiline_header: line');
    expect(container.textContent).toContain('harmless_after_newline_container: line');

    const headerTextarea = Array.from(textareas).find((t) => t.value.includes('harmless_after_multiline_header: line'));
    expect(headerTextarea).toBeDefined();
    expect(headerTextarea!.value).not.toContain(PLAIN_CANARIES.multiline_header);

    const containerTextarea = Array.from(textareas).find((t) => t.value.includes('harmless_after_newline_container: line'));
    expect(containerTextarea).toBeDefined();
    expect(containerTextarea!.value).not.toContain(PLAIN_CANARIES.newline_container);
  });

  it('6. redacts malformed URL userinfo/fragments, enforces JSON node budget, masks sensitive keys/values, and bounds depth', () => {
    const URL_CANARIES = {
      rejected_userinfo: 'CANARY_USERINFO_MULTICOLON_SECRET_123',
      rejected_query: 'CANARY_QUERY_SECRET_456',
      rejected_frag: 'CANARY_FRAG_SECRET_789',
      frag_encode_secret: 'CANARY_FRAGMENT_ENCODE_SECRET_ABC',
    };

    const JSON_CANARIES = {
      key_1: 'CANARY_SECRET_KEY_ALPHA',
      key_2: 'CANARY_SECRET_KEY_BETA',
      val_1: 'CANARY_SECRET_VAL_ALPHA',
      val_2: 'CANARY_SECRET_VAL_BETA',
      proto_val: 'CANARY_PROTO_VALUE_GAMMA',
      deep_val: 'CANARY_DEEP_SECRET_DELTA',
      wide_obj_tail: 'CANARY_WIDE_OBJ_OVER_BUDGET_EPSILON',
      wide_arr_tail: 'CANARY_WIDE_ARR_OVER_BUDGET_ZETA',
    };

    // Rejected URL: userinfo with multiple colons and invalid port 99999
    const rejectedUrl = `https://user:part:${URL_CANARIES.rejected_userinfo}@example.invalid:99999/auth/callback?token=${URL_CANARIES.rejected_query}&safe_diag=safe_code_999#access_token=${URL_CANARIES.rejected_frag}`;
    // Valid URL with malformed percent-encoded fragment component
    const malformedFragUrl = `https://example.invalid/connect?safe_diag=safe_keep_123#%61ccess_%74oken%ZZ=${URL_CANARIES.frag_encode_secret}`;

    const urlBody = [
      'Diagnostic start: testing URL handling.',
      `Rejected URL trace: ${rejectedUrl}`,
      `Malformed fragment URL trace: ${malformedFragUrl}`,
      'Diagnostic end.',
    ].join('\n');

    // JSON payload with own __proto__ key, sensitive token_* keys and values, and deep tree
    const jsonRaw = JSON.stringify({
      harmless_header: 'Harmless JSON diagnostic root context',
      [`token_${JSON_CANARIES.key_1}`]: JSON_CANARIES.val_1,
      [`token_${JSON_CANARIES.key_2}`]: JSON_CANARIES.val_2,
      ['__proto__']: JSON_CANARIES.proto_val,
      deep_tree: {
        l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { l10: JSON_CANARIES.deep_val } } } } } } } } },
      },
    });

    // Ensure fixture actually contains own '__proto__' property before use
    const parsedJsonFixture = JSON.parse(jsonRaw);
    expect(Object.prototype.hasOwnProperty.call(parsedJsonFixture, '__proto__')).toBe(true);

    // Wide object (>500 keys, sensitive key collisions, tail secret over budget)
    const wideObj: Record<string, string> = { harmless_wide_head: 'harmless_wide_val' };
    for (let i = 0; i < 505; i++) {
      wideObj[`token_${i}`] = i === 504 ? JSON_CANARIES.wide_obj_tail : `sensitive_val_${i}`;
    }
    const wideJsonBody = JSON.stringify(wideObj);

    // Wide array (>500 items, tail secret over budget)
    const wideArr: string[] = [];
    for (let i = 0; i < 505; i++) {
      wideArr.push(i === 504 ? JSON_CANARIES.wide_arr_tail : `harmless_item_${i}`);
    }
    const wideArrayBody = JSON.stringify({
      harmless_arr_head: 'harmless_arr_val',
      items: wideArr,
    });

    const data: RecordValue = {
      filename: 'cred-url-json-bounds.json',
      error_codes: ['ERR_URLS', 'ERR_JSON_KEYS_DEPTH', 'ERR_WIDE_OBJ', 'ERR_WIDE_ARR'],
      error_messages: {
        'ERR_URLS': urlBody,
        'ERR_JSON_KEYS_DEPTH': jsonRaw,
        'ERR_WIDE_OBJ': wideJsonBody,
        'ERR_WIDE_ARR': wideArrayBody,
      },
    };

    const { container, rerender, unmount } = render(<SavedErrorDetails data={data} />);

    // Zero transport check
    expect(global.fetch).not.toHaveBeenCalled();

    // 1. None of the URL or JSON canaries leak in innerHTML, textContent, or textarea values
    const allHtml = container.innerHTML;
    for (const [name, secret] of Object.entries(URL_CANARIES)) {
      expect(allHtml, `URL Canary [${name}] found in DOM`).not.toContain(secret);
      expect(container.textContent, `URL Canary [${name}] found in textContent`).not.toContain(secret);
    }
    for (const [name, secret] of Object.entries(JSON_CANARIES)) {
      expect(allHtml, `JSON Canary [${name}] found in DOM`).not.toContain(secret);
      expect(container.textContent, `JSON Canary [${name}] found in textContent`).not.toContain(secret);
    }

    const textareas = container.querySelectorAll('textarea');
    for (const textarea of textareas) {
      for (const [name, secret] of Object.entries(URL_CANARIES)) {
        expect(textarea.value, `URL Canary [${name}] found in textarea`).not.toContain(secret);
      }
      for (const [name, secret] of Object.entries(JSON_CANARIES)) {
        expect(textarea.value, `JSON Canary [${name}] found in textarea`).not.toContain(secret);
      }
    }

    // 2. Rejected URL never becomes an anchor
    const anchors = container.querySelectorAll('a');
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';
      expect(href).not.toContain('99999');
      expect(href).not.toContain('user:part:');
      for (const [name, secret] of Object.entries(URL_CANARIES)) {
        expect(href, `URL Canary [${name}] found in anchor href`).not.toContain(secret);
      }
    }

    // Valid URL with malformed fragment becomes a safe anchor
    const validAnchor = Array.from(anchors).find((a) => a.getAttribute('href')?.includes('example.invalid/connect'));
    expect(validAnchor).toBeDefined();
    expect(validAnchor!.getAttribute('target')).toBe('_blank');
    expect(validAnchor!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(validAnchor!.getAttribute('href')).toContain('%5BREDACTED%5D');
    expect(validAnchor!.getAttribute('href')).not.toContain(URL_CANARIES.frag_encode_secret);
    expect(validAnchor!.textContent).toBe(validAnchor!.getAttribute('href'));

    // 3. Harmless diagnostic query parameters preserved
    expect(container.textContent).toContain('safe_diag=safe_code_999');
    expect(container.textContent).toContain('safe_diag=safe_keep_123');

    // 4. Harmless JSON fields preserved with explicit positive value checks
    const jsonTextarea = Array.from(textareas).find((t) => t.value.includes('Harmless JSON diagnostic root context'));
    expect(jsonTextarea).toBeDefined();
    expect(jsonTextarea!.value).toContain('"harmless_header": "Harmless JSON diagnostic root context"');

    // Sensitive token_* keys and their values are masked
    expect(jsonTextarea!.value).not.toContain(JSON_CANARIES.val_1);
    expect(jsonTextarea!.value).not.toContain(JSON_CANARIES.val_2);
    expect(jsonTextarea!.value).toContain('"[REDACTED]"');
    expect(jsonTextarea!.value).toContain('"[REDACTED]_1"');

    // 5. Prototype pollution check: Object.prototype remains clean
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, JSON_CANARIES.proto_val)).toBe(false);
    expect((Object.prototype as Record<string, unknown>)[JSON_CANARIES.proto_val]).toBeUndefined();

    // 6. Excessive depth replaced with controlled marker
    expect(jsonTextarea!.value).toContain('[DEPTH_EXCEEDED]');

    // 7. Wide object budget enforcement
    const wideObjTextarea = Array.from(textareas).find((t) => t.value.includes('harmless_wide_val'));
    expect(wideObjTextarea).toBeDefined();
    expect(wideObjTextarea!.value).toContain('[NODE_LIMIT_EXCEEDED]');
    const parsedWideObj = JSON.parse(wideObjTextarea!.value);
    expect(Object.keys(parsedWideObj).length).toBeLessThanOrEqual(501);
    expect(wideObjTextarea!.value).not.toContain(JSON_CANARIES.wide_obj_tail);

    // 8. Wide array budget enforcement
    const wideArrTextarea = Array.from(textareas).find((t) => t.value.includes('harmless_arr_val'));
    expect(wideArrTextarea).toBeDefined();
    expect(wideArrTextarea!.value).toContain('[NODE_LIMIT_EXCEEDED]');
    const parsedWideArr = JSON.parse(wideArrTextarea!.value);
    expect(parsedWideArr.items.length).toBeLessThanOrEqual(501);
    expect(wideArrTextarea!.value).not.toContain(JSON_CANARIES.wide_arr_tail);

    // 9. Rerender removes previous content
    const replacementData: RecordValue = {
      filename: 'cred-final-parity.json',
      error_codes: ['ERR_PARITY_COMPLETE'],
      error_messages: {
        'ERR_PARITY_COMPLETE': 'Parity verification clean replacement.',
      },
    };
    rerender(<SavedErrorDetails data={replacementData} />);

    expect(container.textContent).toContain('cred-final-parity.json');
    expect(container.textContent).toContain('ERR_PARITY_COMPLETE');
    expect(container.textContent).toContain('Parity verification clean replacement.');
    expect(container.textContent).not.toContain('cred-url-json-bounds.json');
    expect(container.textContent).not.toContain('Harmless JSON diagnostic root context');

    // 10. Unmount removes DOM cleanly
    unmount();
    expect(container.innerHTML).toBe('');

    // Ensure zero transport throughout the test lifecycle
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
