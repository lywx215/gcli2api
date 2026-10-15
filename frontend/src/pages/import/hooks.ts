import { useEffect, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import { useAuth } from '@/auth'
import { failureMessage, normalizeResult, projectPrompt, readEmailJob } from './api'
import type { EmailSnapshot, ImportResult, ProjectPrompt } from './types'

export function useImportFlow() {
  const { authenticated, sessionEpoch } = useAuth()
  const identity = useRef({ authenticated, sessionEpoch })
  identity.current = { authenticated, sessionEpoch }
  const sequence = useRef(0)
  const emailSequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [message, setMessage] = useState('')
  const [prompt, setPrompt] = useState<ProjectPrompt | null>(null)
  const [authUrl, setAuthUrl] = useState('')
  const [jobId, setJobId] = useState<string>()
  const [email, setEmail] = useState<EmailSnapshot | null>(null)
  const [emailMessage, setEmailMessage] = useState('')
  useEffect(() => {
    sequence.current++
    emailSequence.current++
    controller.current?.abort(); controller.current = null
    setBusy(false); setResult(null); setMessage(''); setPrompt(null); setAuthUrl(''); setJobId(undefined); setEmail(null); setEmailMessage('')
    return () => { sequence.current++; controller.current?.abort() }
  }, [sessionEpoch, authenticated])

  async function run(action: (signal: AbortSignal) => Promise<ImportResult | string>, onSuccess?: () => void) {
    if (!identity.current.authenticated || controller.current) return
    const seq = ++sequence.current, epoch = identity.current.sessionEpoch
    // A new submission owns the result panel; an earlier job must not update it.
    emailSequence.current++
    setJobId(undefined); setEmail(null); setEmailMessage('')
    const abort = new AbortController()
    controller.current = abort
    const current = () => seq === sequence.current && epoch === identity.current.sessionEpoch && identity.current.authenticated
    setBusy(true); setMessage(''); setPrompt(null); setResult(null)
    try {
      const next = await action(abort.signal)
      if (!current()) return
      if (typeof next === 'string') setAuthUrl(next)
      else { setResult(next); setAuthUrl(''); setJobId(next.jobId); setEmail(null); setEmailMessage('') }
      onSuccess?.()
    } catch (error) {
      if (!current()) return
      const selection = projectPrompt(error)
      if (selection) { setPrompt(selection); setMessage('请选择或输入项目 ID，然后明确点击完成授权继续。') }
      else {
        if (error instanceof ApiError && error.status === 400 && Array.isArray((error.payload as { results?: unknown } | null)?.results)) {
          const next = normalizeResult(error.payload); setResult(next); setJobId(next.jobId)
        }
        setMessage(failureMessage(error))
      }
    } finally {
      if (current()) { controller.current = null; setBusy(false) }
    }
  }
  function cancel() {
    sequence.current++; controller.current?.abort(); controller.current = null
    setBusy(false); setAuthUrl(''); setPrompt(null)
    setMessage('已停止等待。服务器可能已保存凭证；此操作不会撤销导入。请到凭证页确认。')
  }
  useEffect(() => {
    if (!jobId || !authenticated) return
    const abort = new AbortController(), epoch = sessionEpoch, emailSeq = emailSequence.current
    let live = true, timer: ReturnType<typeof setTimeout> | undefined
    const current = () => live && emailSeq === emailSequence.current && identity.current.authenticated && identity.current.sessionEpoch === epoch
    async function poll() {
      try {
        const snapshot = await readEmailJob(jobId!, abort.signal)
        if (!current()) return
        setEmail(snapshot)
        if (!snapshot.complete) timer = setTimeout(poll, 2000)
        else setEmailMessage('邮箱补全任务已结束；失败或跳过项可在旧 AG 控制面板手动获取邮箱。')
      } catch (error) {
        if (!current()) return
        setEmailMessage(error instanceof ApiError && error.status === 404 ? '邮箱任务已过期或服务已重启，请到旧 AG 控制面板手动获取邮箱。' : '无法确认邮箱补全进度，已停止轮询。请到凭证页查看。')
      }
    }
    void poll()
    return () => { live = false; abort.abort(); if (timer) clearTimeout(timer) }
  }, [jobId, authenticated, sessionEpoch])
  return { authenticated, sessionEpoch, busy, result, message, prompt, authUrl, email, emailMessage, jobId, run, cancel,
    stopEmail: () => { emailSequence.current++; setJobId(undefined); setEmailMessage('已停止跟踪邮箱进度；服务器任务和已保存凭证不会撤销。') } }
}
