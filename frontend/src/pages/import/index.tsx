import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getServiceBase } from '@/api/client'
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  type SessionValidationSnapshot,
} from '@/auth/session'
import {
  getPanelChannelSnapshot,
  type PanelMode,
  type PanelScope,
} from '@/domain/panel'
import { panelRouteHref } from '@/app/routes'
import { createCredentialApi } from '@/pages/credentials/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ImportFilePicker } from './ImportFilePicker'
import { EmailJobCard, getEligibleExportFilenames, ImportResults } from './components'
import { useImportFlow } from './hooks'
import { getImportWorkflowSnapshot } from './workflowRunner'
import type { TokenInput } from './types'
import type { ImportFlowOwner } from './flowStore'
import type { ImportResult } from './types'
import type { ImportWorkflowReadonly } from './workflowRunner'

export { supportedPanelModes } from './hooks'

type ExportConfirmationTicket = {
  readonly id: number
  readonly actorId: number
  readonly owner: ImportFlowOwner
  readonly validation: SessionValidationSnapshot
  readonly result: ImportWorkflowReadonly<ImportResult>
  readonly filenames: readonly string[]
  readonly channelMode: PanelMode
  consumed: boolean
  retired: boolean
}

type ActiveExportTask = {
  readonly id: number
  readonly actorId: number
  readonly owner: ImportFlowOwner
  readonly validation: SessionValidationSnapshot
  readonly result: ImportWorkflowReadonly<ImportResult>
  readonly filenames: readonly string[]
  readonly controller: AbortController
}

export default function ImportPage() {
  const flow = useImportFlow()

  const [method, setMethod] = useState<'oauth' | 'files' | 'tokens'>(() => {
    return flow.busy &&
      flow.operation === 'files' &&
      flow.owner !== null &&
      flow.validation?.status === 'verified'
      ? 'files'
      : 'oauth'
  })

  useEffect(() => {
    if (
      flow.busy &&
      flow.operation === 'files' &&
      flow.owner !== null &&
      flow.validation?.status === 'verified'
    ) {
      setMethod('files')
    }
  }, [flow.busy, flow.operation, flow.owner, flow.validation])
  const [files, setFiles] = useState<readonly File[]>([])
  const [tokens, setTokens] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [projectId, setProjectId] = useState('')
  const [filename, setFilename] = useState('')
  const [callbackUrl, setCallbackUrl] = useState('')

  const [isExporting, setIsExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState('')
  const [exportConfirm, setExportConfirm] = useState<ExportConfirmationTicket | null>(null)

  const actorRef = useRef<{ id: number; mounted: boolean }>({ id: 1, mounted: true })
  const nextConfirmIdRef = useRef(1)
  const activeConfirmTicketRef = useRef<ExportConfirmationTicket | null>(null)

  const nextExportTaskIdRef = useRef(1)
  const activeExportTaskRef = useRef<ActiveExportTask | null>(null)
  const trackedRevocationsRef = useRef<Set<() => void>>(new Set())

  const lastOwnerRef = useRef<ImportFlowOwner | null>(flow.owner)
  const lastValidationRef = useRef<SessionValidationSnapshot | null>(flow.validation)

  const draftsRef = useRef({
    files: [] as readonly File[],
    tokens: '',
    clientSecret: '',
    callbackUrl: '',
    clientId: '',
    projectId: '',
    filename: '',
  })
  draftsRef.current = {
    files,
    tokens,
    clientSecret,
    callbackUrl,
    clientId,
    projectId,
    filename,
  }

  const clearSensitiveDrafts = useCallback(() => {
    draftsRef.current.files = []
    draftsRef.current.tokens = ''
    draftsRef.current.clientSecret = ''
    draftsRef.current.callbackUrl = ''
    if (actorRef.current.mounted) {
      setFiles([])
      setTokens('')
      setClientSecret('')
      setCallbackUrl('')
    }
  }, [])

  const clearAllDrafts = useCallback(() => {
    draftsRef.current.files = []
    draftsRef.current.tokens = ''
    draftsRef.current.clientSecret = ''
    draftsRef.current.callbackUrl = ''
    draftsRef.current.clientId = ''
    draftsRef.current.projectId = ''
    draftsRef.current.filename = ''
    if (actorRef.current.mounted) {
      setFiles([])
      setTokens('')
      setClientSecret('')
      setCallbackUrl('')
      setClientId('')
      setProjectId('')
      setFilename('')
    }
  }, [])

  useEffect(() => {
    actorRef.current.mounted = true
    return () => {
      actorRef.current.mounted = false
      draftsRef.current.files = []
      draftsRef.current.tokens = ''
      draftsRef.current.clientSecret = ''
      draftsRef.current.callbackUrl = ''
      draftsRef.current.clientId = ''
      draftsRef.current.projectId = ''
      draftsRef.current.filename = ''

      if (activeConfirmTicketRef.current) {
        activeConfirmTicketRef.current.retired = true
        activeConfirmTicketRef.current = null
      }

      if (activeExportTaskRef.current) {
        activeExportTaskRef.current.controller.abort()
        activeExportTaskRef.current = null
      }

      for (const cleanup of trackedRevocationsRef.current) {
        try {
          cleanup()
        } catch {
          // Isolate
        }
      }
      trackedRevocationsRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const prevOwner = lastOwnerRef.current
    const prevValidation = lastValidationRef.current
    const currentOwner = flow.owner
    const currentValidation = flow.validation

    lastOwnerRef.current = currentOwner
    lastValidationRef.current = currentValidation

    if (!flow.authenticated) {
      clearAllDrafts()
      return
    }

    if (prevOwner !== null || prevValidation !== null) {
      if (
        currentOwner !== prevOwner ||
        currentValidation !== prevValidation ||
        currentValidation?.status !== 'verified' ||
        currentOwner === null
      ) {
        clearAllDrafts()
      }
    }
  }, [flow.authenticated, flow.owner, flow.validation, clearAllDrafts])

  useEffect(() => {
    if (exportConfirm !== null) {
      if (
        flow.owner !== exportConfirm.owner ||
        flow.validation !== exportConfirm.validation ||
        flow.result !== exportConfirm.result ||
        flow.busy
      ) {
        if (activeConfirmTicketRef.current?.id === exportConfirm.id) {
          activeConfirmTicketRef.current.retired = true
          activeConfirmTicketRef.current = null
        }
        exportConfirm.retired = true
        setExportConfirm(prev => (prev?.id === exportConfirm.id ? null : prev))
      }
    }
  }, [exportConfirm, flow.owner, flow.validation, flow.result, flow.busy])

  useEffect(() => {
    const activeExport = activeExportTaskRef.current
    if (!activeExport) return

    if (
      flow.owner !== activeExport.owner ||
      flow.validation !== activeExport.validation ||
      flow.result !== activeExport.result ||
      flow.busy
    ) {
      activeExport.controller.abort()
      activeExportTaskRef.current = null
      if (actorRef.current.mounted) {
        setIsExporting(false)
      }
    }
  }, [flow.owner, flow.validation, flow.result, flow.busy])

  const channel = getPanelChannelSnapshot()
  const mode: PanelMode = flow.owner?.mode ?? channel.mode

  const preview = import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true'
  const legacy = new URL(getServiceBase())
  legacy.hash = mode === 'geminicli' ? 'manage' : 'antigravity-manage'
  const legacyLinkText =
    mode === 'geminicli' ? '旧 GCLI 面板：高级工具' : '旧 AG 面板：手动获取邮箱与高级工具'

  const tokenList = useMemo(() => {
    return Array.from(
      new Set(tokens.split(/\r?\n/).map(value => value.trim()).filter(Boolean)),
    )
  }, [tokens])

  const disabled = flow.busy || !flow.authenticated || isExporting

  const isDomainValid = useCallback(
    (
      capturedActorId: number,
      capturedOwner: ImportFlowOwner | null,
      capturedValidation: SessionValidationSnapshot | null,
    ): boolean => {
      if (!actorRef.current.mounted || actorRef.current.id !== capturedActorId) {
        return false
      }
      if (!flow.authenticated) {
        return false
      }
      if (flow.owner !== capturedOwner || flow.validation !== capturedValidation) {
        return false
      }
      if (capturedOwner !== null && capturedValidation !== null) {
        const curSession = getSessionSnapshot()
        const curValidation = getSessionValidationSnapshot()
        const curChannel = getPanelChannelSnapshot()

        if (
          curSession.token === null ||
          curValidation.status !== 'verified' ||
          curValidation.sessionEpoch !== curSession.sessionEpoch ||
          curValidation !== capturedValidation ||
          capturedOwner.mode !== curChannel.mode ||
          capturedOwner.channelEpoch !== curChannel.channelEpoch ||
          capturedOwner.sessionEpoch !== curSession.sessionEpoch
        ) {
          return false
        }
      }
      return true
    },
    [flow.authenticated, flow.owner, flow.validation],
  )

  const capturedActorId = actorRef.current.id
  const capturedOwner = flow.owner
  const capturedValidation = flow.validation

  const isPickerCurrent = useCallback((): boolean => {
    if (!actorRef.current.mounted) return false
    return flow.isCurrent()
  }, [flow.isCurrent])

  const handleTokensChange = useCallback(
    (value: string) => {
      if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
      draftsRef.current.tokens = value
      setTokens(value)
    },
    [capturedActorId, capturedOwner, capturedValidation, isDomainValid],
  )

  const handleClientIdChange = useCallback(
    (value: string) => {
      if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
      draftsRef.current.clientId = value
      setClientId(value)
    },
    [capturedActorId, capturedOwner, capturedValidation, isDomainValid],
  )

  const handleClientSecretChange = useCallback(
    (value: string) => {
      if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
      draftsRef.current.clientSecret = value
      setClientSecret(value)
    },
    [capturedActorId, capturedOwner, capturedValidation, isDomainValid],
  )

  const handleProjectIdChange = useCallback(
    (value: string) => {
      if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
      draftsRef.current.projectId = value
      setProjectId(value)
    },
    [capturedActorId, capturedOwner, capturedValidation, isDomainValid],
  )

  const handleFilenameChange = useCallback(
    (value: string) => {
      if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
      draftsRef.current.filename = value
      setFilename(value)
    },
    [capturedActorId, capturedOwner, capturedValidation, isDomainValid],
  )

  const handleCallbackUrlChange = useCallback(
    (value: string) => {
      if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
      draftsRef.current.callbackUrl = value
      setCallbackUrl(value)
    },
    [capturedActorId, capturedOwner, capturedValidation, isDomainValid],
  )

  const handleFilesChange = useCallback(
    (incomingFiles: readonly File[]) => {
      if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
      draftsRef.current.files = incomingFiles
      setFiles(incomingFiles)
    },
    [capturedActorId, capturedOwner, capturedValidation, isDomainValid],
  )

  const handleSelectProject = useCallback(
    (pid: string) => {
      if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
      draftsRef.current.projectId = pid
      setProjectId(pid)
    },
    [capturedActorId, capturedOwner, capturedValidation, isDomainValid],
  )

  const handleStartOAuth = useCallback(() => {
    if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
    flow.startOAuth(projectId.trim())
  }, [capturedActorId, capturedOwner, capturedValidation, isDomainValid, flow, projectId])

  const handleCompleteOAuth = useCallback(() => {
    if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
    const cb = callbackUrl.trim() || null
    const pid = projectId.trim()
    const admitted = flow.completeOAuth(cb, pid)
    if (admitted) {
      clearSensitiveDrafts()
    }
  }, [
    capturedActorId,
    capturedOwner,
    capturedValidation,
    isDomainValid,
    flow,
    callbackUrl,
    projectId,
    clearSensitiveDrafts,
  ])

  const handleUploadFiles = useCallback(() => {
    if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
    if (files.length === 0) return
    const filesToUpload = [...files]
    const admitted = flow.uploadFiles(filesToUpload)
    if (admitted) {
      clearSensitiveDrafts()
    }
  }, [
    capturedActorId,
    capturedOwner,
    capturedValidation,
    isDomainValid,
    files,
    flow,
    clearSensitiveDrafts,
  ])

  const handleImportTokens = useCallback(() => {
    if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
    if (tokenList.length === 0 || tokenList.length > 200) return
    const payload: Readonly<TokenInput> = Object.freeze({
      tokens: [...tokenList],
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      projectId: projectId.trim(),
      filename: filename.trim(),
    })
    const admitted = flow.importTokens(payload)
    if (admitted) {
      clearSensitiveDrafts()
    }
  }, [
    capturedActorId,
    capturedOwner,
    capturedValidation,
    isDomainValid,
    tokenList,
    clientId,
    clientSecret,
    projectId,
    filename,
    flow,
    clearSensitiveDrafts,
  ])

  const handleCancel = useCallback(() => {
    if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
    const admitted = flow.cancel()
    if (admitted) {
      clearSensitiveDrafts()
    }
  }, [
    capturedActorId,
    capturedOwner,
    capturedValidation,
    isDomainValid,
    flow,
    clearSensitiveDrafts,
  ])

  const exportEligibility = useMemo(() => {
    return getEligibleExportFilenames(flow.result)
  }, [flow.result])

  const canExport =
    exportEligibility.filenames.length > 0 &&
    !flow.busy &&
    !isExporting &&
    flow.owner !== null &&
    flow.validation !== null

  const capturedResult = flow.result
  const capturedFilenames = exportEligibility.filenames

  const handleOpenExportDialog = useCallback(() => {
    if (!actorRef.current.mounted || actorRef.current.id !== capturedActorId) return
    if (isExporting || activeExportTaskRef.current !== null) return
    if (!capturedOwner || !capturedValidation || !capturedResult) return
    if (capturedFilenames.length === 0) return

    const live = getImportWorkflowSnapshot()
    if (live.busy) return
    if (live.owner !== capturedOwner) return
    if (live.validation !== capturedValidation) return
    if (live.result !== capturedResult) return

    const curSession = getSessionSnapshot()
    const curValidation = getSessionValidationSnapshot()
    const curChannel = getPanelChannelSnapshot()

    if (
      curSession.token === null ||
      curValidation.status !== 'verified' ||
      curValidation.sessionEpoch !== curSession.sessionEpoch ||
      curValidation !== capturedValidation ||
      capturedOwner.mode !== curChannel.mode ||
      capturedOwner.channelEpoch !== curChannel.channelEpoch ||
      capturedOwner.sessionEpoch !== curSession.sessionEpoch
    ) {
      return
    }

    if (activeConfirmTicketRef.current) {
      activeConfirmTicketRef.current.retired = true
      activeConfirmTicketRef.current = null
    }

    const ticketId = nextConfirmIdRef.current++
    const ticket: ExportConfirmationTicket = {
      id: ticketId,
      actorId: capturedActorId,
      owner: capturedOwner,
      validation: capturedValidation,
      result: capturedResult,
      filenames: capturedFilenames,
      channelMode: capturedOwner.mode,
      consumed: false,
      retired: false,
    }
    activeConfirmTicketRef.current = ticket
    setExportConfirm(ticket)
  }, [
    capturedActorId,
    capturedOwner,
    capturedValidation,
    capturedResult,
    capturedFilenames,
    isExporting,
  ])

  const handleCancelExport = useCallback(
    (ticketToCancel: ExportConfirmationTicket | null | undefined) => {
      if (!ticketToCancel) return
      if (ticketToCancel.retired || ticketToCancel.consumed) return
      const currentTicket = activeConfirmTicketRef.current
      if (!currentTicket || currentTicket.id !== ticketToCancel.id) return
      if (currentTicket.retired || currentTicket.consumed) return

      ticketToCancel.retired = true
      currentTicket.retired = true
      activeConfirmTicketRef.current = null
      setExportConfirm(prev => (prev?.id === ticketToCancel.id ? null : prev))
    },
    [],
  )

  const isExportStillValid = useCallback((exportTask: ActiveExportTask): boolean => {
    if (!actorRef.current.mounted || actorRef.current.id !== exportTask.actorId) return false
    if (exportTask.controller.signal.aborted) return false
    if (activeExportTaskRef.current?.id !== exportTask.id) return false

    const live = getImportWorkflowSnapshot()
    if (live.busy) return false
    if (live.owner !== exportTask.owner) return false
    if (live.validation !== exportTask.validation) return false
    if (live.result !== exportTask.result) return false

    const curSession = getSessionSnapshot()
    const curValidation = getSessionValidationSnapshot()
    const curChannel = getPanelChannelSnapshot()

    if (
      curSession.token === null ||
      curValidation.status !== 'verified' ||
      curValidation.sessionEpoch !== curSession.sessionEpoch ||
      curValidation !== exportTask.validation ||
      exportTask.owner.mode !== curChannel.mode ||
      exportTask.owner.channelEpoch !== curChannel.channelEpoch ||
      exportTask.owner.sessionEpoch !== curSession.sessionEpoch
    ) {
      return false
    }

    return true
  }, [])

  const handleExecuteExport = useCallback(
    async (ticket: ExportConfirmationTicket | null | undefined) => {
      if (!ticket) return
      if (ticket.consumed || ticket.retired) return
      const currentTicket = activeConfirmTicketRef.current
      if (!currentTicket || currentTicket.id !== ticket.id) return
      if (currentTicket.consumed || currentTicket.retired) return

      ticket.consumed = true
      currentTicket.consumed = true
      activeConfirmTicketRef.current = null
      setExportConfirm(prev => (prev?.id === ticket.id ? null : prev))

      if (!actorRef.current.mounted || actorRef.current.id !== ticket.actorId) return

      const exportId = nextExportTaskIdRef.current++
      const exportController = new AbortController()
      const exportTask: ActiveExportTask = {
        id: exportId,
        actorId: ticket.actorId,
        owner: ticket.owner,
        validation: ticket.validation,
        result: ticket.result,
        filenames: ticket.filenames,
        controller: exportController,
      }

      activeExportTaskRef.current = exportTask
      setIsExporting(true)
      setExportMessage('')

      if (!isExportStillValid(exportTask)) {
        exportController.abort()
        if (activeExportTaskRef.current?.id === exportId) {
          activeExportTaskRef.current = null
          if (actorRef.current.mounted) {
            setIsExporting(false)
          }
        }
        return
      }

      const scope: PanelScope = Object.freeze({
        mode: ticket.owner.mode,
        channelEpoch: ticket.owner.channelEpoch,
        sessionEpoch: ticket.owner.sessionEpoch,
      })

      try {
        const credApi = createCredentialApi(ticket.owner.mode, scope)
        let blob: Blob
        let downloadFilename: string
        let statusText: string

        if (ticket.filenames.length === 1) {
          const targetFilename = ticket.filenames[0]
          const res = await credApi.downloadOne(targetFilename, exportController.signal)

          if (!isExportStillValid(exportTask)) {
            exportController.abort()
            return
          }

          blob = res.blob
          downloadFilename = targetFilename
          statusText = `已开始下载凭证文件：${targetFilename}。`
        } else {
          const res = await credApi.download([...ticket.filenames], exportController.signal)

          if (!isExportStillValid(exportTask)) {
            exportController.abort()
            return
          }

          blob = res.blob
          downloadFilename = `${ticket.owner.mode}-credentials.zip`
          const sel = res.selected !== null ? `${res.selected}` : '未知'
          const mis = res.missing !== null ? `${res.missing}` : '未知'
          statusText = `已生成并开始下载凭证压缩包（选中 ${sel} 项，缺失 ${mis} 项）。`
        }

        if (!isExportStillValid(exportTask)) {
          exportController.abort()
          return
        }

        const url = URL.createObjectURL(blob)
        let revoked = false
        let timer: ReturnType<typeof setTimeout> | null = null

        const cleanup = () => {
          if (revoked) return
          revoked = true
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          trackedRevocationsRef.current.delete(cleanup)
          try {
            URL.revokeObjectURL(url)
          } catch {
            // Isolate
          }
        }

        trackedRevocationsRef.current.add(cleanup)
        timer = setTimeout(cleanup, 60000)

        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = downloadFilename
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        try {
          anchor.click()
        } finally {
          if (anchor.parentNode) {
            anchor.parentNode.removeChild(anchor)
          }
        }

        if (isExportStillValid(exportTask)) {
          setExportMessage(statusText)
        }
      } catch {
        if (isExportStillValid(exportTask)) {
          setExportMessage('导出未完成，请稍后重试。')
        }
      } finally {
        if (activeExportTaskRef.current?.id === exportId) {
          activeExportTaskRef.current = null
          if (actorRef.current.mounted) {
            setIsExporting(false)
          }
        }
      }
    },
    [isExportStillValid],
  )

  const handleStopEmailJob = useCallback(
    (jobId: string) => {
      if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
      flow.stopEmailJob(jobId)
    },
    [capturedActorId, capturedOwner, capturedValidation, isDomainValid, flow],
  )

  const handleResumeEmailJob = useCallback(
    (jobId: string) => {
      if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
      flow.resumeEmailJob(jobId)
    },
    [capturedActorId, capturedOwner, capturedValidation, isDomainValid, flow],
  )

  const handleClearFinishedEmailJobs = useCallback(() => {
    if (!isDomainValid(capturedActorId, capturedOwner, capturedValidation)) return
    flow.clearFinishedEmailJobs()
  }, [capturedActorId, capturedOwner, capturedValidation, isDomainValid, flow])

  const hasFinishedEmailJobs = useMemo(() => {
    return flow.emailJobs.some(j => j.status === 'complete' || j.status === 'expired')
  }, [flow.emailJobs])

  const dialogTicket = exportConfirm

  return (
    <section className="mx-auto max-w-4xl space-y-6 text-sm text-foreground">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">
          {mode === 'geminicli' ? '导入 Gemini CLI 凭证' : '导入凭证'}
        </h1>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {mode === 'geminicli'
            ? '添加 Gemini CLI 账号。操作只在提交后开始，结果按每项显示。'
            : '添加 Antigravity 账号。操作只在提交后开始，结果按每项显示。'}
        </p>
      </header>

      {preview && (
        <p role="status" className="rounded-lg border border-border bg-info-bg p-3 text-sm text-info">
          合成预览：不会调用后台或打开真实 OAuth。点击完成授权可查看示例结果。
        </p>
      )}

      {!flow.authenticated && (
        <p role="status" className="text-sm text-warning">
          请先登录。
        </p>
      )}

      <div className="flex flex-wrap gap-2" aria-label="导入方式">
        {(['oauth', 'files', 'tokens'] as const).map(value => (
          <Button
            key={value}
            variant={method === value ? 'secondary' : 'outline'}
            className="aria-pressed:shadow-selected"
            disabled={flow.busy}
            aria-pressed={method === value}
            onClick={() => setMethod(value)}
          >
            {{ oauth: 'OAuth 授权', files: 'JSON / ZIP 文件', tokens: 'Refresh token' }[value]}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {method === 'oauth'
              ? 'Google OAuth 授权'
              : method === 'files'
                ? '导入凭证文件'
                : '通过 Refresh token 添加'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {method === 'oauth' && (
            <>
              <label className="block space-y-2">
                <span className="font-medium">项目 ID（可选，留空自动检测）</span>
                <Input
                  className="shadow-control"
                  value={projectId}
                  onChange={event => handleProjectIdChange(event.target.value)}
                  disabled={disabled}
                />
              </label>

              {flow.prompt && (
                <div
                  role="status"
                  className="rounded-lg border border-warning/30 bg-warning-bg p-3 text-warning"
                >
                  <p>{flow.prompt.manual ? '需要手动填写项目 ID' : '请选择项目后继续授权'}</p>
                  {flow.prompt.projects.map(project => (
                    <Button
                      key={project}
                      variant="outline"
                      className="m-1"
                      onClick={() => handleSelectProject(project)}
                    >
                      {project}
                    </Button>
                  ))}
                  {flow.prompt.projectOptions &&
                    flow.prompt.projectOptions.map(opt => (
                      <Button
                        key={opt.projectId}
                        variant="outline"
                        className="m-1"
                        onClick={() => handleSelectProject(opt.projectId)}
                      >
                        {opt.name ? `${opt.name} (${opt.projectId})` : opt.projectId}
                      </Button>
                    ))}
                </div>
              )}

              <Button disabled={disabled} onClick={handleStartOAuth}>
                生成授权链接
              </Button>

              {flow.authUrl && (
                <p>
                  <a
                    className="rounded-md text-primary underline underline-offset-4 hover:text-primary-hover"
                    href={flow.authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                  >
                    打开 Google 授权页面
                  </a>
                </p>
              )}

              <p className="text-xs leading-5 text-muted-foreground">
                在授权页面完成操作后，点击完成授权。若浏览器显示无法连接本地回调地址，可粘贴完整回调 URL。
              </p>

              <label className="block space-y-2">
                <span className="font-medium">回调 URL（可选，含敏感授权码）</span>
                <Input
                  className="shadow-control"
                  type="password"
                  autoComplete="off"
                  value={callbackUrl}
                  onChange={event => handleCallbackUrlChange(event.target.value)}
                  disabled={disabled}
                />
              </label>

              <Button
                disabled={disabled || (!preview && !flow.authUrl && !callbackUrl)}
                onClick={handleCompleteOAuth}
              >
                完成授权
              </Button>
            </>
          )}

          {method === 'files' && (
            <>
              <ImportFilePicker
                files={files}
                onFilesChange={handleFilesChange}
                disabled={disabled}
                isCurrent={isPickerCurrent}
                progress={null}
                byteProgress={flow.byteProgress}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                ZIP 不递归解压；文件数量和解压预算由服务器校验。
              </p>
              <Button disabled={disabled || files.length === 0} onClick={handleUploadFiles}>
                上传并导入
              </Button>
            </>
          )}

          {method === 'tokens' && (
            <>
              <label className="block space-y-2">
                <span className="font-medium">Refresh token（每行一个）</span>
                <Textarea
                  className="shadow-control"
                  autoComplete="off"
                  spellCheck={false}
                  rows={5}
                  value={tokens}
                  onChange={event => handleTokensChange(event.target.value)}
                  disabled={disabled}
                />
              </label>
              <p className="text-xs leading-5 text-muted-foreground">
                共 {tokenList.length} 个去重后 token，每批最多 200 个；输入仅保留在本页内存中。
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2">
                  <span className="font-medium">Client ID（可选）</span>
                  <Input
                    className="shadow-control"
                    value={clientId}
                    disabled={disabled}
                    onChange={event => handleClientIdChange(event.target.value)}
                  />
                </label>
                <label className="space-y-2">
                  <span className="font-medium">Client secret（可选）</span>
                  <Input
                    className="shadow-control"
                    type="password"
                    autoComplete="off"
                    value={clientSecret}
                    disabled={disabled}
                    onChange={event => handleClientSecretChange(event.target.value)}
                  />
                </label>
                <label className="space-y-2">
                  <span className="font-medium">
                    {tokenList.length > 1 ? '文件名前缀（可选）' : '文件名（可选）'}
                  </span>
                  <Input
                    className="shadow-control"
                    value={filename}
                    disabled={disabled}
                    onChange={event => handleFilenameChange(event.target.value)}
                  />
                </label>
                {tokenList.length <= 1 && (
                  <label className="space-y-2">
                    <span className="font-medium">项目 ID（可选）</span>
                    <Input
                      className="shadow-control"
                      value={projectId}
                      disabled={disabled}
                      onChange={event => handleProjectIdChange(event.target.value)}
                    />
                  </label>
                )}
              </div>
              <Button
                disabled={disabled || !tokenList.length || tokenList.length > 200}
                onClick={handleImportTokens}
              >
                添加 {tokenList.length > 1 ? '批量凭证' : '凭证'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {flow.busy && (
        <div role="status" className="flex items-center gap-3 text-info">
          <p>请求处理中…</p>
          <Button variant="outline" onClick={handleCancel}>
            停止等待
          </Button>
        </div>
      )}

      {flow.message && (
        <p role="status" className="rounded-lg border border-border bg-info-bg p-3 text-sm text-info">
          {flow.message}
        </p>
      )}

      {flow.result && (
        <ImportResults
          result={flow.result}
          onExport={handleOpenExportDialog}
          exportDisabled={!canExport}
          exportReason={!canExport && flow.result ? exportEligibility.reason : undefined}
          isExporting={isExporting}
          exportMessage={exportMessage}
        />
      )}

      {mode === 'antigravity' && (flow.emailJobs.length > 0 || flow.emailWarning) && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-foreground">邮箱补全</h2>
            {hasFinishedEmailJobs && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearFinishedEmailJobs}
              >
                清除已完成任务
              </Button>
            )}
          </div>

          {flow.emailWarning && (
            <p
              role="status"
              className="rounded-lg border border-border bg-warning-bg p-3 text-sm text-warning"
            >
              {flow.emailWarning}
            </p>
          )}

          <div className="space-y-3">
            {flow.emailJobs.map(job => (
              <EmailJobCard
                key={job.jobId}
                job={job}
                onStop={handleStopEmailJob}
                onResume={handleResumeEmailJob}
                disabled={!flow.authenticated}
              />
            ))}
          </div>
        </div>
      )}

      <AlertDialog
        open={dialogTicket !== null}
        onOpenChange={open => {
          if (!open && dialogTicket) handleCancelExport(dialogTicket)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认导出敏感凭证</AlertDialogTitle>
            <AlertDialogDescription>
              将导出通道{' '}
              <strong>
                {dialogTicket?.channelMode === 'geminicli' ? 'Gemini CLI' : 'Antigravity'}
              </strong>{' '}
              下已确认的 {dialogTicket?.filenames.length} 个凭证文件。完整的敏感凭证文件将被下载到本地，请妥善保管。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-48 overflow-y-auto rounded border border-border p-2 text-xs space-y-1">
            <p className="font-medium text-foreground">包含的文件：</p>
            {dialogTicket?.filenames.map(name => (
              <p key={name} className="break-all text-muted-foreground">
                {name}
              </p>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (dialogTicket) handleCancelExport(dialogTicket)
              }}
            >
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (dialogTicket) {
                  void handleExecuteExport(dialogTicket)
                }
              }}
              disabled={flow.busy || isExporting}
            >
              确认下载
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex flex-wrap gap-4">
        <a
          href={panelRouteHref('credentials', mode)}
          className="rounded-md text-primary underline underline-offset-4 hover:text-primary-hover"
        >
          查看凭证列表
        </a>
        {!preview && (
          <a
            href={legacy.href}
            className="rounded-md text-primary underline underline-offset-4 hover:text-primary-hover"
          >
            {legacyLinkText}
          </a>
        )}
      </div>
    </section>
  )
}
