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
 it('has no management token or Gemini CLI exclusive config in generic payload fields',()=>{
  expect(fields.some(f=>f.key==='node_management_token_hash'||f.key==='code_assist_endpoint')).toBe(false);
 });
});
