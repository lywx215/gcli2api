import { useEffect, useRef, useState } from 'react';
import { registerSessionCleanup, useAuth } from '@/auth';
import { canRecover, getRouting, putRouting } from './api';
import { affectedRows, copy, equal, object, rowChannel } from './types';
import type { Issue, RoutingChannel, Snapshot } from './types';

export function useModelRouting() {
  const auth = useAuth();
  const [channel, setChannel] = useState<RoutingChannel>('antigravity');
  const [rows, setRows] = useState<unknown[]>([]);
  const [baseline, setBaseline] = useState<unknown[] | null>(null);
  const [observed, setObserved] = useState<Snapshot | null>(null);
  const [sent, setSent] = useState<unknown[] | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState<'read' | 'save' | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [status, setStatus] = useState('正在读取模型路由…');
  const [focusRequest, setFocusRequest] = useState<{ row: number; field?: string; nonce: number }>();
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [supported, setSupported] = useState(false);
  const serial = useRef(0);
  const mounted = useRef(false);
  const epoch = useRef(auth.sessionEpoch); epoch.current = auth.sessionEpoch;
  const controller = useRef<AbortController | null>(null);
  const dirty = repairing || (baseline !== null && !equal(rows, baseline));
  const protect = dirty || unknown || busy !== null;
  const ready = baseline !== null || repairing;
  const supports = (snapshot: Snapshot) => snapshot.capabilities.includes('model.routing.aliases') && ['antigravity', 'geminicli'].every(channel => snapshot.supportedChannels.includes(channel));
  const writeSupported = supported && (!observed || supports(observed));
  const editable = ready && writeSupported && auth.authenticated && !busy;
  const current = (e: number, n: number) => mounted.current && epoch.current === e && serial.current === n;

  function reset() {
    ++serial.current; controller.current?.abort(); controller.current = null;
    setRows([]); setBaseline(null); setObserved(null); setSent(null); setIssues([]);
    setUnknown(false); setRecovery(false); setRepairing(false); setBusy(null);
    setCapabilities([]); setSupported(false); setFocusRequest(undefined); setChannel('antigravity');
    setStatus('会话已变更，请重新登录后读取配置。');
  }
  function apply(snapshot: Snapshot) {
    setRows(copy(snapshot.routes)); setBaseline(copy(snapshot.routes)); setIssues(snapshot.issues);
    setCapabilities(snapshot.capabilities); setSupported(supports(snapshot)); setObserved(null); setSent(null); setUnknown(false);
    setRecovery(false); setRepairing(false); setFocusRequest(undefined);
  }
  function focusIssues(next: Issue[], table: unknown[]) {
    for (const issue of next) {
      const row = affectedRows(issue).find(index => index >= 0 && index < table.length && rowChannel(table[index]));
      if (row === undefined) continue;
      setChannel(rowChannel(table[row])!);
      setFocusRequest({ row, field: issue.field ?? undefined, nonce: Date.now() + serial.current });
      return;
    }
    document.getElementById('routing-diagnostics')?.focus();
  }
  async function read(initial = false) {
    if (!auth.authenticated || (!initial && busy)) return;
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    const e = epoch.current, n = ++serial.current;
    setBusy('read'); setStatus('正在读取完整路由表…');
    try {
      const snapshot = await getRouting(request.signal);
      if (!current(e, n)) return;
      if (initial) {
        apply(snapshot);
        setStatus(snapshot.issues.length ? '已读取历史配置；请修正服务端标出的校验问题。' : '已读取两个渠道的完整路由表。');
      } else {
        setObserved(snapshot);
        setStatus('已读回观察值，当前草稿保持原样。请对照后明确选择采用观察值或继续编辑草稿。');
      }
    } catch (error) {
      if (!current(e, n)) return;
      if (initial) setRecovery(canRecover(error));
      setStatus(initial && canRecover(error)
        ? '路由配置无法读取。可再次读取；只有明确确认后，才能用空表重新编辑并保存修复。'
        : '读取失败，当前草稿和提交结果仍保留。可手动重新读取。');
    } finally {
      if (current(e, n)) { setBusy(null); controller.current = null; }
    }
  }
  useEffect(() => {
    mounted.current = true;
    const release = registerSessionCleanup(reset);
    return () => { mounted.current = false; ++serial.current; controller.current?.abort(); release(); };
  }, []);
  useEffect(() => {
    reset();
    if (auth.authenticated) void read(true);
  }, [auth.authenticated, auth.sessionEpoch]);

  function changed() { setIssues([]); setFocusRequest(undefined); setStatus('草稿已修改；保存会提交两个渠道的完整表。'); }
  function changeRow(index: number, patch: Record<string, unknown>) {
    if (!editable || !object(rows[index]) || !rowChannel(rows[index])) return;
    setRows(previous => previous.map((row, i) => i === index && object(row) ? { ...row, ...patch } : row)); changed();
  }
  function addRow() {
    if (!editable) return;
    setRows(previous => [...previous, { channel, public_name: '', upstream_name: '', enabled: true }]); changed();
  }
  function removeRow(index: number) {
    if (!editable) return;
    setRows(previous => previous.filter((_, i) => i !== index)); changed();
  }
  function startRepair() {
    if (!recovery || busy || !auth.authenticated) return;
    setRows([]); setBaseline(null); setIssues([]); setObserved(null); setSent(null);
    setRepairing(true); setSupported(true); setUnknown(false); setStatus('空表修复草稿已建立。保存将替换两个渠道的完整配置；也可以重新读取。');
  }
  function adoptObserved() {
    if (!observed || busy || !auth.authenticated) return;
    apply(observed); setStatus('已明确放弃本页草稿并采用观察值。');
  }
  function retainAfterComparison() {
    if (!observed || busy || !auth.authenticated) return;
    setUnknown(false); setSent(null); setStatus('已按您的选择结束本次结果跟踪，草稿继续保留；后续提交需手动操作。');
  }
  async function save() {
    if (!editable || !dirty || unknown) return;
    const submitted = copy(rows);
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    const e = epoch.current, n = ++serial.current;
    setBusy('save'); setSent(submitted); setObserved(null); setStatus('正在保存两个渠道的完整路由表…');
    try {
      const result = await putRouting(submitted, request.signal);
      if (!current(e, n)) return;
      if (result.kind === 'acknowledged' && result.snapshot) {
        apply(result.snapshot); setStatus('服务已确认保存完整路由表。');
      } else if (result.kind === 'rejected') {
        setIssues(result.issues ?? []); setSent(null);
        setStatus('服务明确拒绝保存，两个渠道的草稿均已保留。请修正校验问题后手动提交。');
        focusIssues(result.issues ?? [], submitted);
      } else {
        setUnknown(true); setStatus('保存结果未知；草稿和本次提交值已保留。请手动读回对照，不会自动重试。');
      }
    } catch {
      if (!current(e, n)) return;
      setUnknown(true); setStatus('保存结果未知；草稿和本次提交值已保留。请手动读回对照，不会自动重试。');
    } finally {
      if (current(e, n)) { setBusy(null); controller.current = null; }
    }
  }
  return { auth, channel, setChannel, rows, baseline, observed, sent, issues, busy, dirty, unknown, recovery, repairing,
    status, capabilities, supported: writeSupported, ready, editable, protect, focusRequest, changeRow, addRow, removeRow, read, save,
    startRepair, adoptObserved, retainAfterComparison, discard: reset };
}
