import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({getConfig:vi.fn(),readEngine:vi.fn().mockResolvedValue('synthetic'),saveConfig:vi.fn().mockResolvedValue({kind:'acknowledged',acknowledged:['debug_mode'],restartRequired:false})}));
vi.mock('@/auth',()=>({useAuth:()=>({authenticated:true,sessionEpoch:1,logout:vi.fn()}),registerSessionCleanup:()=>()=>{}}));
vi.mock('../api',()=>({...mocks,fixtureMode:false,writeFailure:()=> 'unknown',managementToken:vi.fn()}));
import SettingsPage from '../index';
import { clearCarriedDraft } from '../hooks';
afterEach(()=>{cleanup();clearCarriedDraft();});
describe('Settings form integration',()=>{
 it('renders actual service URLs and submits a boolean edit when untouched numeric values are loaded',async()=>{
  mocks.getConfig.mockResolvedValue({config:{host:'localhost',port:7861,debug_mode:false,retry_429_max_retries:0},envLocked:[],capabilities:[]});
  render(<SettingsPage/>);
  await waitFor(()=>expect(screen.getByLabelText('端口')).toHaveValue(7861));
  expect(screen.getByRole('link',{name:'旧配置页：存储预览与切换'}).getAttribute('href')).toMatch(/\/#config$/);
  expect(screen.getByRole('link',{name:'模型路由编辑器'}).getAttribute('href')).toMatch(/\/model-routing$/);
  fireEvent.click(screen.getByLabelText('调试模式'));
  fireEvent.click(screen.getByRole('button',{name:'保存已修改字段'}));
  await waitFor(()=>expect(mocks.saveConfig).toHaveBeenCalledWith({debug_mode:true}));
 });
});
