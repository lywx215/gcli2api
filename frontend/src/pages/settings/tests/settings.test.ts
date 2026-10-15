import { describe, expect, it, vi } from 'vitest';
vi.mock('@/api/client',()=>({ApiError:class extends Error {status:number;constructor(status:number){super();this.status=status;}},requestJson:vi.fn()}));
import { readSave, readSnapshot, writeFailure } from '../api';
import { buildPatch, fields, toDraft } from '../types';
import type { Snapshot } from '../types';
const snapshot:Snapshot={config:{retry_429_max_retries:4,debug_mode:true,auto_ban_error_codes:[403],host:'localhost'},envLocked:[],capabilities:[]};
describe('settings patch contract',()=>{
 it('preserves zero, false and explicit empty arrays; omits unchanged/unknown fields',()=>{
  const draft={...toDraft(snapshot.config),retry_429_max_retries:'0',debug_mode:false,auto_ban_error_codes:''};
  expect(buildPatch(draft,snapshot.config,snapshot)).toEqual({retry_429_max_retries:0,debug_mode:false,auto_ban_error_codes:[]});
 });
 it('locks exact password and boolean keys, and removes unsupported capability parameters',()=>{
  const draft={...toDraft(snapshot.config),panel_password:'new synthetic password',debug_mode:false,antigravity_native_timeout_seconds:'600'};
  expect(buildPatch(draft,snapshot.config,{...snapshot,envLocked:['panel_password','debug_mode']})).toEqual({});
 });
 it('does not submit empty or masked passwords as keep-current semantics',()=>{
  expect(buildPatch(toDraft(snapshot.config),snapshot.config,snapshot)).toEqual({});
  expect(()=>buildPatch({...toDraft(snapshot.config),panel_password:'******'},snapshot.config,snapshot)).toThrow();
 });
 it('does not default an empty numeric input to zero',()=>{
  expect(()=>buildPatch({...toDraft(snapshot.config),retry_429_max_retries:''},snapshot.config,snapshot)).toThrow();
 });
 it('capability disappearance immediately excludes the edited field',()=>{
  const baseline={antigravity_native_timeout_seconds:480};const draft={...toDraft(baseline),antigravity_native_timeout_seconds:'600'};
  expect(buildPatch(draft,baseline,{...snapshot,capabilities:['antigravity.native.timeout']})).toEqual({antigravity_native_timeout_seconds:600});
  expect(buildPatch(draft,baseline,snapshot)).toEqual({});
 });
 it('never stores raw password responses; malformed capability arrays fail closed',()=>{
  const result=readSnapshot({config:{host:'localhost',panel_password:'synthetic secret'},capabilities:['valid',false],env_locked:['panel_password']});
  expect(result.config).toEqual({host:'localhost'});expect(result.capabilities).toEqual([]);expect(result.envLocked).toContain('panel_password');
 });
 it('distinguishes semantic rejection, partial acknowledgement and unknown responses',()=>{
  expect(readSave({success:false},{host:'a'}).kind).toBe('rejected');
  expect(readSave({saved_config:{host:'a'}},{host:'a',port:42}).kind).toBe('partial');
  expect(readSave({message:'ok'},{host:'a'}).kind).toBe('unknown');
  expect(readSave({saved_config:{host:'a'}},{host:'a'}).kind).toBe('acknowledged');
  expect(writeFailure(new TypeError('synthetic network failure'))).toBe('unknown');
 });
 it('positively covers code_assist_endpoint metadata, projection, draft, patch, and ENV lock', () => {
  const field = fields.find(f => f.key === 'code_assist_endpoint');
  expect(field).toBeDefined();
  expect(field?.key).toBe('code_assist_endpoint');
  expect(field?.label).toBe('Code Assist Endpoint');
  expect(field?.section).toBe('网络');
  expect(field?.kind).toBeUndefined();

  const snap = readSnapshot({
   config: { code_assist_endpoint: 'https://cloudcode-pa.googleapis.com', host: 'localhost' },
   env_locked: [],
   capabilities: [],
  });
  expect(snap.config.code_assist_endpoint).toBe('https://cloudcode-pa.googleapis.com');

  expect(toDraft({ code_assist_endpoint: 'https://cloudcode-pa.googleapis.com' }).code_assist_endpoint).toBe('https://cloudcode-pa.googleapis.com');
  expect(toDraft({}).code_assist_endpoint).toBe('');

  const baseline = { code_assist_endpoint: 'https://cloudcode-pa.googleapis.com' };
  const unchangedDraft = toDraft(baseline);
  expect(buildPatch(unchangedDraft, baseline, snapshot)).toEqual({});

  const changedDraft = {
   ...unchangedDraft,
   code_assist_endpoint: 'https://gcli-api.sukaka.top/cloudcode-pa',
  };
  expect(buildPatch(changedDraft, baseline, snapshot)).toEqual({
   code_assist_endpoint: 'https://gcli-api.sukaka.top/cloudcode-pa',
  });

  const lockedSnapshot: Snapshot = { ...snapshot, envLocked: ['code_assist_endpoint'] };
  expect(buildPatch(changedDraft, baseline, lockedSnapshot)).toEqual({});
 });
 it('keeps node_management_token_hash, management token/digest, and calls_per_rotation outside generic fields and patch', () => {
  expect(fields.some(f => f.key === 'node_management_token_hash')).toBe(false);
  expect(fields.some(f => f.key === 'node_management_token')).toBe(false);
  expect(fields.some(f => f.key === 'node_management_token_digest')).toBe(false);
  expect(fields.some(f => f.key === 'calls_per_rotation')).toBe(false);

  const draftWithUnknown = {
   ...toDraft(snapshot.config),
   node_management_token_hash: 'synthetic-hash',
   node_management_token: 'synthetic-token',
   node_management_token_digest: 'synthetic-digest',
   calls_per_rotation: '10',
  } as unknown as Record<string, string>;
  expect(buildPatch(draftWithUnknown, snapshot.config, snapshot)).toEqual({});
 });
 it('excludes secret plaintext from readSnapshot config while retaining intentional new-password patch validation', () => {
  const raw = {
   config: {
    host: 'localhost',
    panel_password: 'synthetic-raw-panel-password',
    api_password: 'synthetic-raw-api-password',
    password: 'synthetic-raw-generic-password',
   },
   env_locked: [],
   capabilities: [],
  };
  const snap = readSnapshot(raw);
  expect(snap.config.panel_password).toBeUndefined();
  expect(snap.config.api_password).toBeUndefined();
  expect(snap.config.password).toBeUndefined();
  expect(snap.config.host).toBe('localhost');

  const validNewPasswordDraft = { ...toDraft(snapshot.config), panel_password: 'new synthetic password' };
  expect(buildPatch(validNewPasswordDraft, snapshot.config, snapshot)).toEqual({
   panel_password: 'new synthetic password',
  });
 });
 it('projects embedPolicy with known sources, actual valid booleans, and actual locked booleans', () => {
  const envSnap = readSnapshot({
   config: { host: 'localhost' },
   env_locked: [],
   capabilities: [],
   security: {
    embed_policy: { source: 'environment', valid: true, locked: true },
   },
  });
  expect(envSnap.embedPolicy).toEqual({
   source: 'environment',
   valid: true,
   locked: true,
  });

  const storageSnap = readSnapshot({
   config: { host: 'localhost' },
   env_locked: [],
   capabilities: [],
   security: {
    embed_policy: { source: 'storage', valid: false, locked: false },
   },
  });
  expect(storageSnap.embedPolicy).toEqual({
   source: 'storage',
   valid: false,
   locked: false,
  });

  const defaultSnap = readSnapshot({
   config: { host: 'localhost' },
   env_locked: [],
   capabilities: [],
   security: {
    embed_policy: { source: 'default', valid: true, locked: false },
   },
  });
  expect(defaultSnap.embedPolicy).toEqual({
   source: 'default',
   valid: true,
   locked: false,
  });
 });
 it('projects unknown for missing, malformed, or inherited embed_policy status and excludes secret canary and unknown fields', () => {
  const missing = readSnapshot({
   config: { host: 'localhost' },
   env_locked: [],
   capabilities: [],
   security: {
    embed_policy: {},
   },
  });
  expect(missing.embedPolicy).toEqual({
   source: 'unknown',
   valid: 'unknown',
   locked: 'unknown',
  });

  const malformed = readSnapshot({
   config: { host: 'localhost' },
   env_locked: [],
   capabilities: [],
   security: {
    embed_policy: {
     source: 'redis_unknown',
     valid: 'true',
     locked: 1,
     secret_canary: 'leak-canary',
     raw_body: { foo: 'bar' },
    },
   },
  });
  expect(malformed.embedPolicy).toEqual({
   source: 'unknown',
   valid: 'unknown',
   locked: 'unknown',
  });
  expect((malformed.embedPolicy as Record<string, unknown>).secret_canary).toBeUndefined();
  expect((malformed.embedPolicy as Record<string, unknown>).raw_body).toBeUndefined();

  const noCoercion = readSnapshot({
   config: { host: 'localhost' },
   env_locked: [],
   capabilities: [],
   security: {
    embed_policy: {
     source: 'default',
     valid: 0,
     locked: 'false',
    },
   },
  });
  expect(noCoercion.embedPolicy).toEqual({
   source: 'default',
   valid: 'unknown',
   locked: 'unknown',
  });

  const inheritedFields = readSnapshot({
   config: { host: 'localhost' },
   env_locked: [],
   capabilities: [],
   security: {
    embed_policy: Object.create({ source: 'environment', valid: true, locked: true }),
   },
  });
  expect(inheritedFields.embedPolicy).toEqual({
   source: 'unknown',
   valid: 'unknown',
   locked: 'unknown',
  });

  const inheritedStatus = readSnapshot({
   config: { host: 'localhost' },
   env_locked: [],
   capabilities: [],
   security: Object.create({
    embed_policy: { source: 'environment', valid: true, locked: true },
   }),
  });
  expect(inheritedStatus.embedPolicy).toEqual({
   source: 'unknown',
   valid: 'unknown',
   locked: 'unknown',
  });

  const nonObjectStatus = readSnapshot({
   config: { host: 'localhost' },
   env_locked: [],
   capabilities: [],
   security: {
    embed_policy: null,
   },
  });
  expect(nonObjectStatus.embedPolicy).toEqual({
   source: 'unknown',
   valid: 'unknown',
   locked: 'unknown',
  });

  const absentMetadata = readSnapshot({
   config: { host: 'localhost' },
   env_locked: [],
   capabilities: [],
   security: {},
  });
  expect(absentMetadata.config.host).toBe('localhost');
  expect(absentMetadata.embedPolicy).toBeUndefined();
 });
 it('keeps embed_policy outside generic config fields and patch', () => {
  expect(fields.some(f => f.key === 'embed_policy' || f.key === 'embedPolicy')).toBe(false);
  const draftWithEmbed = {
   ...toDraft(snapshot.config),
   embed_policy: { source: 'environment', valid: true, locked: true },
   embedPolicy: { source: 'environment', valid: true, locked: true },
  } as unknown as Record<string, string>;
  expect(buildPatch(draftWithEmbed, snapshot.config, snapshot)).toEqual({});
 });
});

