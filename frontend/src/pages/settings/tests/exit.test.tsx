import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({
  auth:{authenticated:true,sessionEpoch:1,logout:vi.fn()},cleanups:new Set<()=>void>(),
  getConfig:vi.fn(),readEngine:vi.fn(),saveConfig:vi.fn(),managementToken:vi.fn(),navigate:vi.fn(),
}));
vi.mock('@/auth',()=>({useAuth:()=>mocks.auth,registerSessionCleanup:(fn:()=>void)=>{mocks.cleanups.add(fn);return()=>mocks.cleanups.delete(fn);}}));
vi.mock('../api',()=>({getConfig:mocks.getConfig,readEngine:mocks.readEngine,saveConfig:mocks.saveConfig,managementToken:mocks.managementToken,fixtureMode:false,writeFailure:()=> 'unknown'}));
vi.mock('../exitProtection',async original=>({...await original<typeof import('../exitProtection')>(),navigateFromSettings:mocks.navigate}));
import SettingsPage from '../index';
import { clearCarriedDraft } from '../hooks';
import { discardExitChanges } from '../exitProtection';

const snapshot={config:{host:'localhost',port:7861,debug_mode:false,retry_429_max_retries:0,gcli_embed_mode:'disabled',gcli_embed_allowed_origins:[]},envLocked:[],capabilities:[],token:{configured:true,locked:false}};
function warnsOnUnload(){const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}
async function mount(){const view=render(<SettingsPage/>);await waitFor(()=>expect(screen.getByLabelText('端口')).toHaveValue(7861));return view;}
function change(label:string,value:string){fireEvent.change(screen.getByLabelText(label),{target:{value}});}
// Observe our handler without asking jsdom to navigate a real document.
function clickLink(anchor:HTMLElement,options:MouseEventInit={}){
  let blocked=false;
  document.addEventListener('click',event=>{blocked=event.defaultPrevented;event.preventDefault();},{once:true});
  anchor.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0,...options}));
  return blocked;
}
beforeEach(()=>{
  clearCarriedDraft();discardExitChanges();vi.clearAllMocks();mocks.cleanups.clear();
  mocks.auth={authenticated:true,sessionEpoch:1,logout:vi.fn()};
  mocks.getConfig.mockReset().mockResolvedValue(snapshot);mocks.readEngine.mockReset().mockResolvedValue('synthetic');
  mocks.saveConfig.mockReset().mockResolvedValue({kind:'acknowledged',acknowledged:['port']});
  mocks.managementToken.mockReset().mockResolvedValue({configured:true,locked:false});
  history.replaceState(null,'','/ui/#/settings');
});
afterEach(()=>{cleanup();clearCarriedDraft();discardExitChanges();mocks.cleanups.clear();});

describe('settings exit protection',()=>{
  it('warns only for dirty edits and stops when reverted or explicitly discarded',async()=>{
    await mount();expect(warnsOnUnload()).toBe(false);
    change('端口','8765');expect(warnsOnUnload()).toBe(true);
    change('端口','7861');expect(warnsOnUnload()).toBe(false);
    change('端口','8765');fireEvent.click(screen.getByRole('button',{name:'放弃草稿并采用观察值'}));
    expect(warnsOnUnload()).toBe(false);expect(screen.getByLabelText('端口')).toHaveValue(7861);
  });
  it('does not flag acknowledged values, but flags later edits and unknown saves',async()=>{
    await mount();change('端口','8765');fireEvent.click(screen.getByRole('button',{name:'保存已修改字段'}));
    await screen.findByText('服务已确认接收保存；请重新读取对照实际值。');
    expect(warnsOnUnload()).toBe(false);
    change('端口','8766');expect(warnsOnUnload()).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'重新读取并对照'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'保存已修改字段'})).toBeEnabled());
    mocks.saveConfig.mockRejectedValueOnce(new TypeError('synthetic offline'));
    fireEvent.click(screen.getByRole('button',{name:'保存已修改字段'}));
    await screen.findByText(/保存结果未知；保留草稿/);
    expect(warnsOnUnload()).toBe(true);expect(mocks.saveConfig).toHaveBeenCalledTimes(2);
  });
  it('allows internal hash navigation, retains safe drafts and protects later document exits',async()=>{
    const view=await mount();change('端口','8765');
    const anchor=document.createElement('a');anchor.href='#/overview';document.body.append(anchor);
    expect(clickLink(anchor)).toBe(false);expect(screen.queryByRole('alertdialog')).toBeNull();
    view.unmount();anchor.remove();
    expect(warnsOnUnload()).toBe(true);
    const next=render(<SettingsPage/>);
    expect(screen.getByLabelText('端口')).toHaveValue(8765);
    expect(mocks.getConfig).toHaveBeenCalledTimes(1);
    next.unmount();expect(warnsOnUnload()).toBe(true);
  });
  it('allows clean whole-document links and asks before dirty old-panel links',async()=>{
    await mount();const link=screen.getByRole('link',{name:'旧配置页：存储预览与切换'});
    expect(clickLink(link)).toBe(false);
    change('端口','8765');act(()=>{expect(clickLink(link)).toBe(true);});
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('离开设置页面？');
    fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));
    await waitFor(()=>expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(()=>expect(link).toHaveFocus());
    expect(mocks.navigate).not.toHaveBeenCalled();expect(warnsOnUnload()).toBe(true);
    act(()=>{clickLink(link);});fireEvent.click(await screen.findByRole('button',{name:'放弃并离开'}));
    expect(mocks.navigate).toHaveBeenCalledWith(link.getAttribute('href'));
    expect(warnsOnUnload()).toBe(false);
  });
  it('warns about secret loss on internal switching without discarding safe drafts',async()=>{
    await mount();change('端口','8765');change('面板密码','synthetic-private-input');
    const link=document.createElement('a');link.href='#/logs';document.body.append(link);
    act(()=>{expect(clickLink(link)).toBe(true);});
    const dialog=await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('清除秘密输入后切换页面？');expect(dialog.textContent).not.toContain('synthetic-private-input');
    fireEvent.click(screen.getByRole('button',{name:'清除秘密输入并切换'}));
    expect(screen.getByLabelText('面板密码')).toHaveValue('');expect(screen.getByLabelText('端口')).toHaveValue(8765);
    expect(warnsOnUnload()).toBe(true);expect(mocks.navigate).toHaveBeenCalledWith(link.href);link.remove();
  });
  it.each(['removed','hidden','disabled'])('restores cancellation focus when the original mobile link is %s',async state=>{
    await mount();change('面板密码','synthetic-private-input');
    const link=document.createElement('a');link.href='#/logs';link.textContent='temporary mobile navigation';document.body.append(link);
    act(()=>{clickLink(link);});await screen.findByRole('alertdialog');
    if(state==='removed')link.remove();else if(state==='hidden')link.hidden=true;else link.setAttribute('aria-disabled','true');
    fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'重新读取并对照'})).toHaveFocus());
    expect(screen.getByLabelText('面板密码')).toHaveValue('synthetic-private-input');expect(mocks.navigate).not.toHaveBeenCalled();link.remove();
  });
  it.each(['unknown','partial','network'])('retains a non-secret reminder for a secret-only %s save across GET and route unmount',async outcome=>{
    if(outcome==='network')mocks.saveConfig.mockRejectedValueOnce(new TypeError('synthetic network failure'));
    else mocks.saveConfig.mockResolvedValueOnce({kind:outcome,acknowledged:[]});
    const view=await mount();change('API 密码','synthetic-unconfirmed-api-secret');
    fireEvent.click(screen.getByRole('button',{name:'保存已修改字段'}));
    await waitFor(()=>expect(screen.getByLabelText('API 密码')).toHaveValue(''));
    expect(mocks.auth.logout).not.toHaveBeenCalled();expect(warnsOnUnload()).toBe(true);
    expect(document.body.textContent).not.toContain('synthetic-unconfirmed-api-secret');
    view.unmount();expect(warnsOnUnload()).toBe(true);
    const reads=mocks.getConfig.mock.calls.length;render(<SettingsPage/>);
    expect(screen.getByLabelText('API 密码')).toHaveValue('');expect(mocks.getConfig).toHaveBeenCalledTimes(reads);
    fireEvent.click(screen.getByRole('button',{name:'重新读取并对照'}));
    await waitFor(()=>expect(screen.getByLabelText('端口')).toHaveValue(7861));
    expect(warnsOnUnload()).toBe(true);expect(screen.getByText(/存在尚未确认的配置提交/)).toBeInTheDocument();
    expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
    act(()=>{clickLink(screen.getByRole('link',{name:'模型路由编辑器'}));});
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('尚未确认的提交');
    fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));
    await waitFor(()=>expect(screen.queryByRole('alertdialog')).toBeNull());
    fireEvent.click(screen.getByRole('button',{name:'放弃草稿并采用观察值'}));
    expect(warnsOnUnload()).toBe(false);
  });
  it('clears a secret-only confirmed save but preserves an earlier unknown write after an unrelated acknowledgement',async()=>{
    mocks.saveConfig.mockResolvedValueOnce({kind:'acknowledged',acknowledged:['api_password']});
    await mount();change('API 密码','synthetic-confirmed-api-secret');fireEvent.click(screen.getByRole('button',{name:'保存已修改字段'}));
    await screen.findByText('服务已确认接收保存；请重新读取对照实际值。');expect(warnsOnUnload()).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'重新读取并对照'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'重新读取并对照'})).toBeEnabled());
    mocks.saveConfig.mockResolvedValueOnce({kind:'unknown',acknowledged:[]});
    change('API 密码','synthetic-unknown-api-secret');fireEvent.click(screen.getByRole('button',{name:'保存已修改字段'}));
    await screen.findByText('保存结果未知；请重新读取对照，勿直接重复提交。');
    fireEvent.click(screen.getByRole('button',{name:'重新读取并对照'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'重新读取并对照'})).toBeEnabled());
    change('端口','8765');fireEvent.click(screen.getByRole('button',{name:'保存已修改字段'}));
    await screen.findByText('服务已确认接收保存；请重新读取对照实际值。');expect(warnsOnUnload()).toBe(true);
    act(()=>{clickLink(screen.getByRole('link',{name:'模型路由编辑器'}));});
    fireEvent.click(await screen.findByRole('button',{name:'放弃并离开'}));expect(warnsOnUnload()).toBe(false);
  });
  it('does not block opening a separate tab or modified link clicks',async()=>{
    await mount();change('面板密码','synthetic-private-input');
    const link=screen.getByRole('link',{name:'模型路由编辑器'});
    expect(clickLink(link,{ctrlKey:true})).toBe(false);
    link.setAttribute('target','_blank');expect(clickLink(link)).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();expect(warnsOnUnload()).toBe(true);
  });
  it('closes the exit portal and removes secret-only guards on session change',async()=>{
    const view=await mount();change('面板密码','synthetic-private-input');
    act(()=>{clickLink(screen.getByRole('link',{name:'模型路由编辑器'}));});
    await screen.findByRole('alertdialog');
    act(()=>{mocks.auth={...mocks.auth,authenticated:false,sessionEpoch:2};mocks.cleanups.forEach(fn=>fn());view.rerender(<SettingsPage/>);});
    expect(screen.queryByRole('alertdialog')).toBeNull();expect(screen.getByLabelText('面板密码')).toHaveValue('');
    expect(warnsOnUnload()).toBe(false);expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it('does not retain secret-only guards when the page unmounts',async()=>{
    const view=await mount();change('面板密码','synthetic-private-input');expect(warnsOnUnload()).toBe(true);
    view.unmount();expect(warnsOnUnload()).toBe(false);
  });
});

describe('management token and accessible validation',()=>{
  it('protects token input and clears the guard after explicit discard or acknowledged save',async()=>{
    await mount();change('新 Token（独立保存）','synthetic-token-with-at-least-32-characters');expect(warnsOnUnload()).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'放弃 Token 输入'}));expect(warnsOnUnload()).toBe(false);
    change('新 Token（独立保存）','synthetic-token-with-at-least-32-characters');fireEvent.click(screen.getByRole('button',{name:'保存 Token'}));
    await screen.findByText('独立 Token 操作已确认。');expect(warnsOnUnload()).toBe(false);
    expect(screen.getByLabelText('新 Token（独立保存）')).toHaveValue('');
  });
  it('clears token input when the backend reports an environment lock',async()=>{
    await mount();change('新 Token（独立保存）','synthetic-token-with-at-least-32-characters');
    mocks.getConfig.mockResolvedValueOnce({...snapshot,token:{configured:true,locked:true}});
    fireEvent.click(screen.getByRole('button',{name:'重新读取并对照'}));
    await waitFor(()=>expect(screen.getByLabelText('新 Token（独立保存）')).toBeDisabled());
    expect(screen.getByLabelText('新 Token（独立保存）')).toHaveValue('');expect(warnsOnUnload()).toBe(false);
  });
  it('links a safe token error to the field and focuses it',async()=>{
    await mount();change('新 Token（独立保存）','synthetic-short');fireEvent.click(screen.getByRole('button',{name:'保存 Token'}));
    const input=screen.getByLabelText('新 Token（独立保存）');
    expect(input).toHaveAttribute('aria-invalid','true');expect(input).toHaveAttribute('aria-describedby','management-token-error');expect(input).toHaveFocus();
    expect(document.getElementById('management-token-error')).not.toHaveTextContent('synthetic-short');
    expect(mocks.managementToken).not.toHaveBeenCalled();
  });
  it('does not let a late token acknowledgement remove a newly observed environment lock',async()=>{
    let finish!:(value:{configured:boolean;locked:boolean})=>void;
    mocks.managementToken.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    await mount();change('新 Token（独立保存）','synthetic-token-with-at-least-32-characters');
    fireEvent.click(screen.getByRole('button',{name:'保存 Token'}));
    mocks.getConfig.mockResolvedValueOnce({...snapshot,token:{configured:true,locked:true}});
    fireEvent.click(screen.getByRole('button',{name:'重新读取并对照'}));
    await screen.findByText('已配置 · 环境变量锁定');
    await act(async()=>{finish({configured:true,locked:false});});
    expect(screen.getByLabelText('新 Token（独立保存）')).toBeDisabled();
    expect(screen.getByLabelText('新 Token（独立保存）')).toHaveValue('');expect(warnsOnUnload()).toBe(false);
  });
  it('associates schema errors and focuses the first invalid config field without exposing secrets',async()=>{
    await mount();change('端口','0');change('面板密码','******');fireEvent.click(screen.getByRole('button',{name:'保存已修改字段'}));
    const input=screen.getByLabelText('端口');await waitFor(()=>expect(input).toHaveAttribute('aria-invalid','true'));
    expect(input).toHaveAttribute('aria-describedby','port-help port-error');expect(input).toHaveFocus();
    expect(document.getElementById('port-error')).toHaveAttribute('role','alert');
    expect(screen.getByLabelText('面板密码')).toHaveAttribute('aria-describedby','panel_password-help panel_password-error');
    expect(document.getElementById('panel_password-error')).not.toHaveTextContent('******');expect(mocks.saveConfig).not.toHaveBeenCalled();
  });
  it('locates the existing cross-field Origin requirement on an editable field',async()=>{
    await mount();change('嵌入策略','exact');fireEvent.click(screen.getByRole('button',{name:'保存已修改字段'}));
    const input=screen.getByLabelText('允许的 HTTPS Origin（每行一个）');
    await waitFor(()=>expect(input).toHaveAttribute('aria-invalid','true'));expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-describedby','gcli_embed_allowed_origins-help gcli_embed_allowed_origins-error');expect(mocks.saveConfig).not.toHaveBeenCalled();
  });
});
