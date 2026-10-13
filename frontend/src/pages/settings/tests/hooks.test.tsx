import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({auth:{authenticated:true,sessionEpoch:1,logout:vi.fn()},cleanups:new Set<()=>void>(),getConfig:vi.fn(),readEngine:vi.fn(),saveConfig:vi.fn()}));
vi.mock('@/auth',()=>({useAuth:()=>mocks.auth,registerSessionCleanup:(fn:()=>void)=>{mocks.cleanups.add(fn);return()=>mocks.cleanups.delete(fn);}}));
vi.mock('../api',()=>({getConfig:mocks.getConfig,readEngine:mocks.readEngine,saveConfig:mocks.saveConfig,writeFailure:()=> 'unknown'}));
import { clearCarriedDraft, useSettings } from '../hooks';
const snapshot={config:{host:'initial',port:7861,debug_mode:false,retry_429_max_retries:4},envLocked:[],capabilities:[]};
function changeSession(authenticated:boolean){mocks.auth={...mocks.auth,authenticated,sessionEpoch:mocks.auth.sessionEpoch+1};for(const fn of mocks.cleanups)fn();}
beforeEach(()=>{clearCarriedDraft();mocks.auth={authenticated:true,sessionEpoch:1,logout:vi.fn()};mocks.getConfig.mockReset().mockResolvedValue(snapshot);mocks.readEngine.mockReset().mockResolvedValue('synthetic');mocks.saveConfig.mockReset();});
afterEach(()=>{cleanup();mocks.cleanups.clear();clearCarriedDraft();});
describe('Settings session and uncertainty',()=>{
 it('keeps safe submission evidence across password reauthentication and removes credential-bearing URLs',async()=>{
  mocks.saveConfig.mockRejectedValue(new TypeError('offline'));
  const {result,rerender}=renderHook(()=>useSettings());await waitFor(()=>expect(result.current.snapshot).toBeDefined());
  act(()=>{result.current.form.setValue('port','8765');result.current.form.setValue('proxy','https://synthetic:secret@proxy.example.invalid');result.current.form.setValue('panel_password','synthetic-new-secret');});
  await act(()=>result.current.save(result.current.form.getValues()));
  expect(mocks.auth.logout).toHaveBeenCalledOnce();
  act(()=>{changeSession(false);rerender();});
  expect(result.current.sent).toEqual({port:8765});expect(result.current.baseline).toEqual({port:7861});
  expect(result.current.form.getValues('proxy')).toBe('');expect(result.current.form.getValues('panel_password')).toBe('');
  act(()=>{changeSession(true);rerender();});await act(()=>result.current.refresh());
  expect(result.current.baseline.port).toBe(7861);expect(result.current.form.getValues('port')).toBe('8765');
  mocks.saveConfig.mockResolvedValue({kind:'acknowledged',acknowledged:['port'],restartRequired:false});
  await act(()=>result.current.save(result.current.form.getValues()));expect(mocks.saveConfig).toHaveBeenLastCalledWith({port:8765});
 });
 it('retains draft, sent values and baseline after a network failure; does not replay on observation',async()=>{
  mocks.saveConfig.mockRejectedValue(new TypeError('offline'));
  const {result}=renderHook(()=>useSettings());await waitFor(()=>expect(result.current.snapshot).toBeDefined());
  act(()=>result.current.form.setValue('port','8765'));
  await act(()=>result.current.save(result.current.form.getValues()));
  expect(result.current.form.getValues('port')).toBe('8765');expect(result.current.baseline.port).toBe(7861);expect(result.current.sent).toEqual({port:8765});expect(result.current.needsRead).toBe(true);
  mocks.getConfig.mockResolvedValue({...snapshot,config:{...snapshot.config,port:8765}});
  await act(()=>result.current.refresh());
  expect(result.current.observed?.port).toBe(8765);expect(result.current.baseline.port).toBe(7861);expect(result.current.form.getValues('port')).toBe('8765');expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
 });
 it('discards an old session read even when its promise ignores cancellation',async()=>{
  let finish!:(value:typeof snapshot)=>void;mocks.getConfig.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const {result,rerender}=renderHook(()=>useSettings());
  act(()=>{changeSession(false);rerender();});
  await act(async()=>{finish(snapshot);});
  expect(result.current.snapshot).toBeUndefined();expect(result.current.observed).toBeUndefined();expect(result.current.engine).toBe('未知');
 });
 it('clears secrets and read state while retaining dirty input; relogin performs no implicit GET or write',async()=>{
  const {result,rerender}=renderHook(()=>useSettings());await waitFor(()=>expect(result.current.snapshot).toBeDefined());
  act(()=>{result.current.form.setValue('port','8765');result.current.form.setValue('panel_password','synthetic-new-password');});
  act(()=>{changeSession(false);rerender();});
  expect(result.current.form.getValues('panel_password')).toBe('');expect(result.current.form.getValues('port')).toBe('8765');expect(result.current.snapshot).toBeUndefined();
  const calls=mocks.getConfig.mock.calls.length;
  act(()=>{changeSession(true);rerender();});
  expect(mocks.getConfig).toHaveBeenCalledTimes(calls);expect(mocks.saveConfig).not.toHaveBeenCalled();
  await act(()=>result.current.refresh());expect(result.current.form.getValues('port')).toBe('8765');
 });
 it('preserves dirty non-secret fields across route unmount and requires explicit read',async()=>{
  const first=renderHook(()=>useSettings());await waitFor(()=>expect(first.result.current.snapshot).toBeDefined());
  act(()=>{first.result.current.form.setValue('port','9876');first.result.current.form.setValue('panel_password','synthetic-secret');});first.unmount();
  const second=renderHook(()=>useSettings());expect(second.result.current.form.getValues('port')).toBe('9876');expect(second.result.current.form.getValues('panel_password')).toBe('');expect(second.result.current.needsRead).toBe(true);
 });
});
