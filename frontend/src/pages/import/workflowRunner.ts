import { ApiError } from '@/api/client'
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  registerSessionCleanup,
  type SessionValidationSnapshot,
} from '@/auth/session'
import {
  getPanelChannelSnapshot,
  registerChannelCleanup,
  type PanelScope,
} from '@/domain/panel'
import {
  beginImportFlowTask,
  getImportFlowSnapshot,
  stopImportFlowTask,
  subscribeImportFlow,
  type ImportFlowOwner,
  type ImportFlowTaskHandle,
} from './flowStore'
import {
  createImportApi,
  failureMessage,
  normalizeResult,
  projectPrompt,
  readEmailJobs,
} from './api'
import type {
  EmailJobObservation,
  EmailSnapshot,
  ImportItem,
  ImportResult,
  ItemReceipt,
  OAuthReceipt,
  ProjectOption,
  ProjectPrompt,
  TokenInput,
  UploadByteProgress,
  UploadProgressPhase,
} from './types'

export type ImportWorkflowReadonly<T> = T extends readonly (infer U)[]
  ? readonly ImportWorkflowReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: ImportWorkflowReadonly<T[K]> }
    : T

export type ImportWorkflowOperation = 'oauth-start' | 'oauth-complete' | 'files' | 'tokens'

export type ImportWorkflowEmailStatus = 'tracking' | 'stopped' | 'complete' | 'expired' | 'unavailable'

export type ImportWorkflowEmailJob = Readonly<{
  jobId: string
  status: ImportWorkflowEmailStatus
  snapshot: ImportWorkflowReadonly<EmailSnapshot> | null
  message: string
}>

export type ImportWorkflowSnapshot = Readonly<{
  owner: ImportFlowOwner | null
  validation: SessionValidationSnapshot | null
  revision: number
  busy: boolean
  operation: ImportWorkflowOperation | null
  result: ImportWorkflowReadonly<ImportResult> | null
  prompt: ImportWorkflowReadonly<ProjectPrompt> | null
  authUrl: string
  message: string
  emailJobs: readonly ImportWorkflowEmailJob[]
  emailWarning: string
  byteProgress: ImportWorkflowReadonly<UploadByteProgress> | null
}>

type InternalEmailJob = {
  readonly jobId: string
  status: ImportWorkflowEmailStatus
  snapshot: ImportWorkflowReadonly<EmailSnapshot> | null
  message: string
  handle: ImportFlowTaskHandle | null
  generation: number
}

type PollingRun = {
  readonly id: number
  readonly owner: ImportFlowOwner
  readonly controller: AbortController
  cancelSleep: () => void
}

const EMPTY_EMAIL_JOBS: readonly ImportWorkflowEmailJob[] = Object.freeze([])
const MAX_RETAINED_EMAIL_JOBS = 128

let currentRevision = 0
let trackedOwner: ImportFlowOwner | null = null
let trackedValidation: SessionValidationSnapshot | null = null

let currentOperation: ImportWorkflowOperation | null = null
let currentOperationGeneration = 0
let activeTaskHandle: ImportFlowTaskHandle | null = null
let activePrivateController: AbortController | null = null
let activeOperationCleanup: (() => void) | null = null

let currentResult: ImportWorkflowReadonly<ImportResult> | null = null
let currentPrompt: ImportWorkflowReadonly<ProjectPrompt> | null = null
let currentAuthUrl = ''
let currentMessage = ''
let currentByteProgress: ImportWorkflowReadonly<UploadByteProgress> | null = null

let emailJobs: InternalEmailJob[] = []
let currentEmailWarning = ''
let nextJobGeneration = 1

let activePollingRun: PollingRun | null = null
let nextPollingRunId = 1

let isTearingDown = false
let cachedSnapshot: ImportWorkflowSnapshot | null = null

const workflowSubscribers = new Set<() => void>()

function isCurrentOwnerValid(owner: ImportFlowOwner): boolean {
  if (!owner || typeof owner !== 'object') return false
  const flowSnap = getImportFlowSnapshot()
  if (flowSnap.owner !== owner) return false
  const session = getSessionSnapshot()
  const validation = getSessionValidationSnapshot()
  const channel = getPanelChannelSnapshot()
  if (
    session.token === null ||
    validation.status !== 'verified' ||
    validation.sessionEpoch !== session.sessionEpoch
  ) {
    return false
  }
  if (
    owner.mode !== channel.mode ||
    owner.channelEpoch !== channel.channelEpoch ||
    owner.sessionEpoch !== session.sessionEpoch
  ) {
    return false
  }
  return true
}

function isAdmissibleOwner(owner: unknown): owner is ImportFlowOwner {
  if (isTearingDown) return false
  if (!owner || typeof owner !== 'object') return false
  reconcileCurrentOwner()
  if (trackedOwner === null || owner !== trackedOwner) return false
  const flowSnap = getImportFlowSnapshot()
  if (flowSnap.owner !== owner) return false
  const session = getSessionSnapshot()
  const validation = getSessionValidationSnapshot()
  const channel = getPanelChannelSnapshot()
  if (
    session.token === null ||
    validation.status !== 'verified' ||
    validation.sessionEpoch !== session.sessionEpoch ||
    validation !== trackedValidation
  ) {
    return false
  }
  const o = owner as ImportFlowOwner
  if (
    o.mode !== channel.mode ||
    o.channelEpoch !== channel.channelEpoch ||
    o.sessionEpoch !== session.sessionEpoch
  ) {
    return false
  }
  return true
}

function safeFreezeImportResult(raw: ImportResult): ImportWorkflowReadonly<ImportResult> {
  const outcome = raw.outcome
  const warnings =
    typeof raw.warnings === 'number' && Number.isSafeInteger(raw.warnings) && raw.warnings >= 0
      ? raw.warnings
      : 0

  const items = Array.isArray(raw.items)
    ? raw.items.map(it => {
        let receiptCopy: ItemReceipt | undefined = undefined
        if (it.receipt && typeof it.receipt === 'object') {
          const r: ItemReceipt = {}
          if (typeof it.receipt.project_id === 'string') r.project_id = it.receipt.project_id
          if (typeof it.receipt.subscription_tier === 'string') r.subscription_tier = it.receipt.subscription_tier
          if (typeof it.receipt.tier_raw_id === 'string') r.tier_raw_id = it.receipt.tier_raw_id
          if (typeof it.receipt.tier_raw_name === 'string') r.tier_raw_name = it.receipt.tier_raw_name
          if (typeof it.receipt.tier_detected_at === 'number') r.tier_detected_at = it.receipt.tier_detected_at
          if (typeof it.receipt.tier_detection_status === 'string') r.tier_detection_status = it.receipt.tier_detection_status
          receiptCopy = Object.freeze(r)
        }
        const failureReason =
          it.status === 'failed' &&
          (it.failureReason === 'credential_exchange_failed' ||
            it.failureReason === 'credential_store_failed' ||
            it.failureReason === 'credential_import_failed')
            ? it.failureReason
            : undefined
        return Object.freeze({
          label: String(it.label),
          status: it.status,
          ...(receiptCopy ? { receipt: receiptCopy } : {}),
          ...(failureReason ? { failureReason } : {}),
        })
      })
    : []

  let oauthReceiptCopy: OAuthReceipt | undefined = undefined
  if (raw.oauthReceipt && typeof raw.oauthReceipt === 'object') {
    const o = raw.oauthReceipt
    const built: OAuthReceipt = {
      success: true as const,
      mode: o.mode,
      filename: String(o.filename),
      project_id: o.project_id !== undefined ? (o.project_id === null ? null : String(o.project_id)) : null,
      subscription_tier:
        o.subscription_tier !== undefined
          ? (o.subscription_tier === null ? null : String(o.subscription_tier))
          : null,
      auto_detected_project: Boolean(o.auto_detected_project),
    }
    if ('tier_raw_id' in o && o.tier_raw_id !== undefined) built.tier_raw_id = o.tier_raw_id
    if ('tier_raw_name' in o && o.tier_raw_name !== undefined) built.tier_raw_name = o.tier_raw_name
    if ('tier_detected_at' in o && o.tier_detected_at !== undefined) built.tier_detected_at = o.tier_detected_at
    if ('tier_detection_status' in o && o.tier_detection_status !== undefined) built.tier_detection_status = o.tier_detection_status
    oauthReceiptCopy = Object.freeze(built)
  }

  const confirmedFilenamesCopy = Array.isArray(raw.confirmedFilenames)
    ? Object.freeze(raw.confirmedFilenames.filter((f): f is string => typeof f === 'string'))
    : undefined

  const result: ImportResult = {
    outcome,
    items: Object.freeze(items) as unknown as ImportItem[],
    warnings,
    ...(typeof raw.jobId === 'string' ? { jobId: raw.jobId } : {}),
    ...(oauthReceiptCopy ? { oauthReceipt: oauthReceiptCopy } : {}),
    ...(confirmedFilenamesCopy && confirmedFilenamesCopy.length > 0
      ? { confirmedFilenames: confirmedFilenamesCopy as unknown as string[] }
      : {}),
  }

  return Object.freeze(result) as unknown as ImportWorkflowReadonly<ImportResult>
}

function safeFreezeProjectPrompt(p: ProjectPrompt): ImportWorkflowReadonly<ProjectPrompt> {
  const manual = Boolean(p.manual)
  const projects = Array.isArray(p.projects)
    ? Object.freeze(p.projects.filter((x): x is string => typeof x === 'string'))
    : Object.freeze([])
  let projectOptions: readonly ProjectOption[] | undefined = undefined
  if (Array.isArray(p.projectOptions)) {
    projectOptions = Object.freeze(
      p.projectOptions.map(opt =>
        Object.freeze({
          projectId: String(opt.projectId),
          name: opt.name === null ? null : typeof opt.name === 'string' ? opt.name : null,
        }),
      ),
    )
  }
  return Object.freeze({
    manual,
    projects,
    ...(projectOptions ? { projectOptions } : {}),
  }) as unknown as ImportWorkflowReadonly<ProjectPrompt>
}

function safeFreezeEmailSnapshot(
  snap: EmailSnapshot | null,
): ImportWorkflowReadonly<EmailSnapshot> | null {
  if (!snap) return null
  const items = Array.isArray(snap.items)
    ? snap.items.map(item =>
        Object.freeze({
          filename: String(item.filename),
          status: item.status,
          ...(item.email ? { email: String(item.email) } : {}),
        }),
      )
    : []
  return Object.freeze({
    complete: Boolean(snap.complete),
    items: Object.freeze(items),
  })
}

function safeFreezeByteProgress(
  p: UploadByteProgress | null,
): ImportWorkflowReadonly<UploadByteProgress> | null {
  if (!p || typeof p !== 'object') return null
  const receivedBytes =
    typeof p.receivedBytes === 'number' && Number.isSafeInteger(p.receivedBytes) && p.receivedBytes >= 0
      ? p.receivedBytes
      : 0
  const totalBytes =
    typeof p.totalBytes === 'number' && Number.isSafeInteger(p.totalBytes) && p.totalBytes > 0
      ? p.totalBytes
      : null
  const phase: UploadProgressPhase =
    p.phase === 'processing' ||
    p.phase === 'finished' ||
    p.phase === 'interrupted' ||
    p.phase === 'receiving'
      ? p.phase
      : 'receiving'
  const percentage =
    typeof p.percentage === 'number' && Number.isSafeInteger(p.percentage) && p.percentage >= 0 && p.percentage <= 100
      ? p.percentage
      : null
  const available = Boolean(p.available)
  return Object.freeze({
    receivedBytes,
    totalBytes,
    phase,
    percentage,
    available,
  }) as unknown as ImportWorkflowReadonly<UploadByteProgress>
}

function produceInvalidSnapshot(rev: number): ImportWorkflowSnapshot {
  return Object.freeze({
    owner: null,
    validation: null,
    revision: rev,
    busy: false,
    operation: null,
    result: null,
    prompt: null,
    authUrl: '',
    message: '',
    emailJobs: EMPTY_EMAIL_JOBS,
    emailWarning: '',
    byteProgress: null,
  })
}

function produceSnapshot(): ImportWorkflowSnapshot {
  if (trackedOwner === null || trackedValidation === null) {
    return produceInvalidSnapshot(currentRevision)
  }
  const publicEmailJobs: readonly ImportWorkflowEmailJob[] =
    emailJobs.length === 0
      ? EMPTY_EMAIL_JOBS
      : Object.freeze(
          emailJobs.map(j =>
            Object.freeze({
              jobId: j.jobId,
              status: j.status,
              snapshot: j.snapshot,
              message: j.message,
            }),
          ),
        )

  return Object.freeze({
    owner: trackedOwner,
    validation: trackedValidation,
    revision: currentRevision,
    busy: currentOperation !== null,
    operation: currentOperation,
    result: currentResult,
    prompt: currentPrompt,
    authUrl: currentAuthUrl,
    message: currentMessage,
    emailJobs: publicEmailJobs,
    emailWarning: currentEmailWarning,
    byteProgress: currentByteProgress,
  })
}

function notifyWorkflowSubscribers(): void {
  for (const listener of Array.from(workflowSubscribers)) {
    try {
      listener()
    } catch {
      // Isolate subscriber exceptions
    }
  }
}

function establishOwnerDomain(
  owner: ImportFlowOwner,
  validation: SessionValidationSnapshot,
): void {
  trackedOwner = owner
  trackedValidation = validation
  currentOperation = null
  activeTaskHandle = null
  activePrivateController = null
  activeOperationCleanup = null
  currentResult = null
  currentPrompt = null
  currentAuthUrl = ''
  currentMessage = ''
  emailJobs = []
  currentEmailWarning = ''
  currentByteProgress = null
  cachedSnapshot = produceSnapshot()
}

function handleOwnerLoss(): void {
  if (isTearingDown) return
  isTearingDown = true
  try {
    const lostOwner = trackedOwner
    const lostHandle = activeTaskHandle
    const lostController = activePrivateController
    const lostEmailJobs = emailJobs
    const lostCleanup = activeOperationCleanup
    const lostPollingRun = activePollingRun

    currentOperationGeneration++

    // 1. Retire old polling run immediately: cancel sleep and retire
    if (lostPollingRun) {
      lostPollingRun.cancelSleep()
      activePollingRun = null
    }

    // 2. Clear runner-owned transient inputs
    if (lostCleanup) {
      try {
        lostCleanup()
      } catch {
        // Isolate
      }
      activeOperationCleanup = null
    }

    // 3. Clear public state before abort / listener callbacks
    trackedOwner = null
    trackedValidation = null
    currentOperation = null
    activeTaskHandle = null
    activePrivateController = null
    currentResult = null
    currentPrompt = null
    currentAuthUrl = ''
    currentMessage = ''
    emailJobs = []
    currentEmailWarning = ''
    currentByteProgress = null

    currentRevision++
    cachedSnapshot = produceInvalidSnapshot(currentRevision)

    // 4. Retire private work: abort after public clearing
    if (lostPollingRun) {
      try {
        lostPollingRun.controller.abort()
      } catch {
        // Isolate
      }
    }

    if (lostOwner && lostHandle) {
      try {
        stopImportFlowTask(lostOwner, lostHandle)
      } catch {
        // Isolate
      }
    }
    if (lostController) {
      try {
        lostController.abort()
      } catch {
        // Isolate
      }
    }
    if (lostOwner) {
      for (const job of lostEmailJobs) {
        if (job.handle) {
          try {
            stopImportFlowTask(lostOwner, job.handle)
          } catch {
            // Isolate
          }
        }
      }
    }
  } finally {
    isTearingDown = false
  }

  notifyWorkflowSubscribers()
}

function reconcileCurrentOwner(): void {
  const flowSnap = getImportFlowSnapshot()
  const currentFlowOwner = flowSnap.owner
  const currentValidation = getSessionValidationSnapshot()
  const isVerified =
    currentFlowOwner !== null &&
    isCurrentOwnerValid(currentFlowOwner) &&
    currentValidation.status === 'verified'

  if (trackedOwner !== null) {
    if (!isVerified || trackedOwner !== currentFlowOwner) {
      handleOwnerLoss()
      if (isVerified && currentFlowOwner !== null) {
        establishOwnerDomain(currentFlowOwner, currentValidation)
      }
    }
  } else {
    if (isVerified && currentFlowOwner !== null) {
      establishOwnerDomain(currentFlowOwner, currentValidation)
    } else {
      if (cachedSnapshot === null || cachedSnapshot.owner !== null) {
        cachedSnapshot = produceInvalidSnapshot(currentRevision)
      }
    }
  }
}

function handleEmailJobRegistration(owner: ImportFlowOwner, rawJobId: unknown): void {
  if (isTearingDown) return
  if (trackedOwner !== owner || trackedValidation === null || !isCurrentOwnerValid(owner)) return
  if (owner.mode !== 'antigravity') return
  if (typeof rawJobId !== 'string' || !/^[0-9a-f]{32}$/.test(rawJobId)) return

  const existing = emailJobs.find(j => j.jobId === rawJobId)
  if (existing) {
    // Deduplicate: do not add duplicate, do not silently resume stopped
    return
  }

  if (emailJobs.length >= MAX_RETAINED_EMAIL_JOBS) {
    currentEmailWarning = '后台邮箱任务已达上限（最多 128 项），未能跟踪新任务。'
    return
  }

  const handle = beginImportFlowTask(owner, 'email', rawJobId)
  if (!handle) {
    currentEmailWarning = '后台邮箱任务注册失败，未能启动跟踪。'
    return
  }

  currentEmailWarning = ''
  const newJob: InternalEmailJob = {
    jobId: rawJobId,
    status: 'tracking',
    snapshot: null,
    message: '正在跟踪邮箱导入进度...',
    handle,
    generation: ++nextJobGeneration,
  }
  emailJobs.push(newJob)
  ensurePollingLoop(owner)
}

function ensurePollingLoop(owner: ImportFlowOwner): void {
  if (isTearingDown) return
  if (!emailJobs.some(j => j.status === 'tracking')) return
  if (activePollingRun !== null && activePollingRun.owner === owner) {
    return
  }
  if (activePollingRun !== null) {
    activePollingRun.cancelSleep()
    activePollingRun.controller.abort()
    activePollingRun = null
  }

  const run: PollingRun = {
    id: nextPollingRunId++,
    owner,
    controller: new AbortController(),
    cancelSleep: () => {},
  }
  activePollingRun = run
  void runPollingLoop(run)
}

async function runPollingLoop(run: PollingRun): Promise<void> {
  const { id: runId, owner, controller } = run
  try {
    while (true) {
      if (
        isTearingDown ||
        activePollingRun?.id !== runId ||
        trackedOwner !== owner ||
        !isCurrentOwnerValid(owner) ||
        controller.signal.aborted
      ) {
        break
      }

      const trackingJobs = emailJobs.filter(j => j.status === 'tracking')
      if (trackingJobs.length === 0) {
        break
      }

      const chunkSize = 4
      for (let i = 0; i < trackingJobs.length; i += chunkSize) {
        if (
          isTearingDown ||
          activePollingRun?.id !== runId ||
          trackedOwner !== owner ||
          !isCurrentOwnerValid(owner) ||
          controller.signal.aborted
        ) {
          return
        }

        const chunkSlice = trackingJobs.slice(i, i + chunkSize)
        const activeInChunk = chunkSlice.filter(j => j.status === 'tracking')
        if (activeInChunk.length === 0) {
          continue
        }

        const chunkItems = activeInChunk.map(j => ({ job: j, generation: j.generation }))
        const chunkIds = chunkItems.map(c => c.job.jobId)

        const scope: PanelScope = Object.freeze({
          mode: owner.mode,
          channelEpoch: owner.channelEpoch,
          sessionEpoch: owner.sessionEpoch,
        })

        let observations: readonly EmailJobObservation[] = []
        let chunkFailed = false

        try {
          observations = await readEmailJobs(chunkIds, controller.signal, {
            mode: owner.mode,
            scope,
          })
        } catch {
          if (
            controller.signal.aborted ||
            isTearingDown ||
            activePollingRun?.id !== runId ||
            trackedOwner !== owner ||
            !isCurrentOwnerValid(owner)
          ) {
            return
          }
          chunkFailed = true
        }

        if (
          isTearingDown ||
          activePollingRun?.id !== runId ||
          trackedOwner !== owner ||
          !isCurrentOwnerValid(owner) ||
          controller.signal.aborted
        ) {
          return
        }

        let stateChanged = false

        if (chunkFailed) {
          for (const item of chunkItems) {
            if (item.job.status === 'tracking' && item.job.generation === item.generation) {
              item.job.status = 'unavailable'
              item.job.message = '任务状态暂时无法获取'
              const h = item.job.handle
              item.job.handle = null
              if (h) {
                try {
                  stopImportFlowTask(owner, h)
                } catch {
                  // Isolate
                }
              }
              stateChanged = true
            }
          }
        } else {
          for (const obs of observations) {
            const match = chunkItems.find(c => c.job.jobId === obs.jobId)
            if (!match) continue
            const { job, generation } = match
            if (job.status !== 'tracking' || job.generation !== generation) {
              continue
            }

            if (obs.status === 'observed') {
              job.snapshot = safeFreezeEmailSnapshot(obs.snapshot)
              if (obs.snapshot?.complete) {
                job.status = 'complete'
                job.message = '邮箱导入已完成'
                const h = job.handle
                job.handle = null
                if (h) {
                  try {
                    stopImportFlowTask(owner, h)
                  } catch {
                    // Isolate
                  }
                }
              } else {
                job.status = 'tracking'
                job.message = '正在导入...'
              }
              stateChanged = true
            } else if (obs.status === 'expired') {
              job.status = 'expired'
              job.snapshot = null
              job.message = '邮箱导入任务已过期'
              const h = job.handle
              job.handle = null
              if (h) {
                try {
                  stopImportFlowTask(owner, h)
                } catch {
                  // Isolate
                }
              }
              stateChanged = true
            } else if (obs.status === 'unavailable') {
              job.status = 'unavailable'
              job.message = '任务状态暂时无法获取'
              const h = job.handle
              job.handle = null
              if (h) {
                try {
                  stopImportFlowTask(owner, h)
                } catch {
                  // Isolate
                }
              }
              stateChanged = true
            }
          }
        }

        if (stateChanged) {
          currentRevision++
          cachedSnapshot = produceSnapshot()
          notifyWorkflowSubscribers()
        }
      }

      if (
        isTearingDown ||
        activePollingRun?.id !== runId ||
        trackedOwner !== owner ||
        !isCurrentOwnerValid(owner) ||
        controller.signal.aborted
      ) {
        break
      }

      const remaining = emailJobs.filter(j => j.status === 'tracking')
      if (remaining.length === 0) {
        break
      }

      // Cancellable sleep: approx 2000ms after prior collection
      await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | null = null
        let resolved = false
        const finish = () => {
          if (resolved) return
          resolved = true
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          if (run.cancelSleep === finish) {
            run.cancelSleep = () => {}
          }
          resolve()
        }
        run.cancelSleep = finish
        timer = setTimeout(finish, 2000)
      })

      run.cancelSleep = () => {}
    }
  } finally {
    run.cancelSleep()
    if (activePollingRun?.id === runId) {
      activePollingRun = null
    }
  }
}

// Module-level store/session/channel subscribers
subscribeImportFlow(() => {
  reconcileCurrentOwner()
})

registerChannelCleanup(() => {
  handleOwnerLoss()
})

registerSessionCleanup(() => {
  handleOwnerLoss()
})

export function getImportWorkflowSnapshot(): ImportWorkflowSnapshot {
  reconcileCurrentOwner()
  if (cachedSnapshot === null) {
    cachedSnapshot = produceSnapshot()
  }
  return cachedSnapshot
}

export function subscribeImportWorkflow(listener: () => void): () => void {
  if (typeof listener !== 'function') return () => {}
  workflowSubscribers.add(listener)
  return () => {
    workflowSubscribers.delete(listener)
  }
}

export function startWorkflowOAuth(owner: ImportFlowOwner, projectId: string): boolean {
  if (isTearingDown) return false
  if (!isAdmissibleOwner(owner)) return false
  if (typeof projectId !== 'string') return false
  if (currentOperation !== null) return false

  const reservationGen = ++currentOperationGeneration
  const capturedOwner = owner
  const capturedValidation = trackedValidation!

  let opCleaned = false
  const opCleanup = () => {
    if (opCleaned) return
    opCleaned = true
  }
  activeOperationCleanup = opCleanup

  // Reserve mutation admission before calling beginImportFlowTask so reentrant subscribers cannot admit
  currentOperation = 'oauth-start'
  currentResult = null
  currentPrompt = null
  currentMessage = ''
  currentAuthUrl = ''

  currentRevision++
  cachedSnapshot = produceSnapshot()

  let handle: ImportFlowTaskHandle | null = null
  try {
    handle = beginImportFlowTask(owner, 'oauth')
  } catch {
    handle = null
  }

  if (!handle) {
    if (
      currentOperationGeneration === reservationGen &&
      currentOperation === 'oauth-start' &&
      trackedOwner === capturedOwner
    ) {
      currentOperation = null
      if (activeOperationCleanup === opCleanup) {
        activeOperationCleanup = null
      }
      currentRevision++
      cachedSnapshot = produceSnapshot()
      notifyWorkflowSubscribers()
    }
    opCleanup()
    return false
  }

  // Recheck captured reservation, owner, validation after callbacks before transport
  const isStillCurrentReservation =
    !isTearingDown &&
    currentOperationGeneration === reservationGen &&
    currentOperation === 'oauth-start' &&
    trackedOwner === capturedOwner &&
    trackedValidation === capturedValidation &&
    isCurrentOwnerValid(capturedOwner) &&
    !handle.signal.aborted

  if (!isStillCurrentReservation) {
    try {
      stopImportFlowTask(capturedOwner, handle)
    } catch {
      // Isolate
    }
    if (
      currentOperationGeneration === reservationGen &&
      currentOperation === 'oauth-start' &&
      trackedOwner === capturedOwner
    ) {
      currentOperation = null
      if (activeOperationCleanup === opCleanup) {
        activeOperationCleanup = null
      }
      currentRevision++
      cachedSnapshot = produceSnapshot()
      notifyWorkflowSubscribers()
    }
    opCleanup()
    return false
  }

  activeTaskHandle = handle
  currentRevision++
  cachedSnapshot = produceSnapshot()
  notifyWorkflowSubscribers()

  void (async () => {
    try {
      if (
        isTearingDown ||
        currentOperationGeneration !== reservationGen ||
        trackedOwner !== capturedOwner ||
        trackedValidation !== capturedValidation ||
        !isCurrentOwnerValid(capturedOwner)
      ) {
        return
      }

      const scope: PanelScope = Object.freeze({
        mode: capturedOwner.mode,
        channelEpoch: capturedOwner.channelEpoch,
        sessionEpoch: capturedOwner.sessionEpoch,
      })
      const api = createImportApi({ mode: capturedOwner.mode, scope })
      const authUrlRes = await api.startOAuth(projectId, handle.signal)

      if (
        isTearingDown ||
        currentOperationGeneration !== reservationGen ||
        trackedOwner !== capturedOwner ||
        trackedValidation !== capturedValidation ||
        !isCurrentOwnerValid(capturedOwner)
      ) {
        return
      }

      activeTaskHandle = null
      currentOperation = null

      let validUrl = ''
      if (authUrlRes === '') {
        validUrl = ''
      } else {
        try {
          const u = new URL(authUrlRes)
          if (
            u.protocol === 'https:' &&
            u.hostname === 'accounts.google.com' &&
            !u.username &&
            !u.password
          ) {
            validUrl = u.href
          } else {
            currentMessage = '授权服务地址无效。'
          }
        } catch {
          currentMessage = '授权服务地址无效。'
        }
      }

      currentAuthUrl = validUrl
      currentRevision++
      cachedSnapshot = produceSnapshot()

      try {
        stopImportFlowTask(capturedOwner, handle)
      } catch {
        // Isolate
      }

      notifyWorkflowSubscribers()
    } catch (err) {
      if (
        isTearingDown ||
        currentOperationGeneration !== reservationGen ||
        trackedOwner !== capturedOwner ||
        trackedValidation !== capturedValidation ||
        !isCurrentOwnerValid(capturedOwner)
      ) {
        return
      }

      activeTaskHandle = null
      currentOperation = null
      currentMessage = failureMessage(err)
      currentRevision++
      cachedSnapshot = produceSnapshot()

      try {
        stopImportFlowTask(capturedOwner, handle)
      } catch {
        // Isolate
      }

      notifyWorkflowSubscribers()
    } finally {
      opCleanup()
      if (activeOperationCleanup === opCleanup) {
        activeOperationCleanup = null
      }
    }
  })()

  return true
}

export function completeWorkflowOAuth(
  owner: ImportFlowOwner,
  callbackUrl: string | null,
  projectId: string,
): boolean {
  if (isTearingDown) return false
  if (!isAdmissibleOwner(owner)) return false
  if (callbackUrl !== null && typeof callbackUrl !== 'string') return false
  if (typeof projectId !== 'string') return false
  if (currentOperation !== null) return false

  const reservationGen = ++currentOperationGeneration
  const capturedOwner = owner
  const capturedValidation = trackedValidation!

  const callbackHolder = {
    value: callbackUrl,
  }

  let opCleaned = false
  const opCleanup = () => {
    if (opCleaned) return
    opCleaned = true
    callbackHolder.value = null
  }
  activeOperationCleanup = opCleanup

  // Reserve mutation admission before calling beginImportFlowTask
  currentOperation = 'oauth-complete'
  currentResult = null
  currentPrompt = null
  currentMessage = ''

  currentRevision++
  cachedSnapshot = produceSnapshot()

  let handle: ImportFlowTaskHandle | null = null
  try {
    handle = beginImportFlowTask(owner, 'oauth')
  } catch {
    handle = null
  }

  if (!handle) {
    if (
      currentOperationGeneration === reservationGen &&
      currentOperation === 'oauth-complete' &&
      trackedOwner === capturedOwner
    ) {
      currentOperation = null
      if (activeOperationCleanup === opCleanup) {
        activeOperationCleanup = null
      }
      currentRevision++
      cachedSnapshot = produceSnapshot()
      notifyWorkflowSubscribers()
    }
    opCleanup()
    return false
  }

  // Recheck captured reservation, owner, validation after callbacks before transport
  const isStillCurrentReservation =
    !isTearingDown &&
    currentOperationGeneration === reservationGen &&
    currentOperation === 'oauth-complete' &&
    trackedOwner === capturedOwner &&
    trackedValidation === capturedValidation &&
    isCurrentOwnerValid(capturedOwner) &&
    !handle.signal.aborted

  if (!isStillCurrentReservation) {
    try {
      stopImportFlowTask(capturedOwner, handle)
    } catch {
      // Isolate
    }
    if (
      currentOperationGeneration === reservationGen &&
      currentOperation === 'oauth-complete' &&
      trackedOwner === capturedOwner
    ) {
      currentOperation = null
      if (activeOperationCleanup === opCleanup) {
        activeOperationCleanup = null
      }
      currentRevision++
      cachedSnapshot = produceSnapshot()
      notifyWorkflowSubscribers()
    }
    opCleanup()
    return false
  }

  activeTaskHandle = handle
  currentRevision++
  cachedSnapshot = produceSnapshot()
  notifyWorkflowSubscribers()

  void (async () => {
    try {
      if (
        isTearingDown ||
        currentOperationGeneration !== reservationGen ||
        trackedOwner !== capturedOwner ||
        trackedValidation !== capturedValidation ||
        !isCurrentOwnerValid(capturedOwner)
      ) {
        return
      }

      const scope: PanelScope = Object.freeze({
        mode: capturedOwner.mode,
        channelEpoch: capturedOwner.channelEpoch,
        sessionEpoch: capturedOwner.sessionEpoch,
      })
      const api = createImportApi({ mode: capturedOwner.mode, scope })
      const res = await api.completeOAuth(callbackHolder.value, projectId, handle.signal)

      // Clear runner-owned references on settlement
      opCleanup()

      if (
        isTearingDown ||
        currentOperationGeneration !== reservationGen ||
        trackedOwner !== capturedOwner ||
        trackedValidation !== capturedValidation ||
        !isCurrentOwnerValid(capturedOwner)
      ) {
        return
      }

      activeTaskHandle = null
      currentOperation = null
      currentAuthUrl = ''
      currentResult = safeFreezeImportResult(res)
      currentPrompt = null
      currentMessage = ''

      if (capturedOwner.mode === 'antigravity' && res.jobId) {
        handleEmailJobRegistration(capturedOwner, res.jobId)
      }

      currentRevision++
      cachedSnapshot = produceSnapshot()

      try {
        stopImportFlowTask(capturedOwner, handle)
      } catch {
        // Isolate
      }

      notifyWorkflowSubscribers()
    } catch (err) {
      opCleanup()

      if (
        isTearingDown ||
        currentOperationGeneration !== reservationGen ||
        trackedOwner !== capturedOwner ||
        trackedValidation !== capturedValidation ||
        !isCurrentOwnerValid(capturedOwner)
      ) {
        return
      }

      activeTaskHandle = null
      currentOperation = null

      const prompt = projectPrompt(err)
      if (prompt !== null) {
        currentPrompt = safeFreezeProjectPrompt(prompt)
        currentResult = null
        currentMessage = '请选择或输入关联项目。'
      } else {
        let partial: ImportResult | null = null
        if (err instanceof ApiError && err.payload) {
          try {
            partial = normalizeResult(err.payload, false, capturedOwner.mode)
          } catch {
            partial = null
          }
        }
        if (partial !== null) {
          currentResult = safeFreezeImportResult(partial)
          currentPrompt = null
          currentMessage = failureMessage(err)
          if (
            err instanceof ApiError &&
            err.status === 400 &&
            capturedOwner.mode === 'antigravity' &&
            typeof partial.jobId === 'string' &&
            /^[0-9a-f]{32}$/.test(partial.jobId)
          ) {
            handleEmailJobRegistration(capturedOwner, partial.jobId)
          }
        } else {
          currentResult = null
          currentPrompt = null
          currentMessage = failureMessage(err)
        }
      }

      currentRevision++
      cachedSnapshot = produceSnapshot()

      try {
        stopImportFlowTask(capturedOwner, handle)
      } catch {
        // Isolate
      }

      notifyWorkflowSubscribers()
    } finally {
      opCleanup()
      if (activeOperationCleanup === opCleanup) {
        activeOperationCleanup = null
      }
    }
  })()

  return true
}

export function uploadWorkflowFiles(owner: ImportFlowOwner, files: readonly File[]): boolean {
  if (isTearingDown) return false
  if (!isAdmissibleOwner(owner)) return false
  if (!Array.isArray(files) || files.length === 0 || !files.every(f => f instanceof File)) {
    return false
  }
  if (currentOperation !== null) return false

  const controller = new AbortController()
  currentOperation = 'files'
  activePrivateController = controller
  currentByteProgress = null
  currentResult = null
  currentPrompt = null
  currentMessage = ''

  const opGen = ++currentOperationGeneration
  const capturedOwner = owner
  const capturedValidation = trackedValidation!
  const safeFiles = Array.from(files)

  let opCleaned = false
  const opCleanup = () => {
    if (opCleaned) return
    opCleaned = true
    safeFiles.length = 0
  }
  activeOperationCleanup = opCleanup

  currentRevision++
  cachedSnapshot = produceSnapshot()
  notifyWorkflowSubscribers()

  void (async () => {
    try {
      if (
        isTearingDown ||
        currentOperationGeneration !== opGen ||
        trackedOwner !== capturedOwner ||
        trackedValidation !== capturedValidation ||
        !isCurrentOwnerValid(capturedOwner)
      ) {
        return
      }

      const scope: PanelScope = Object.freeze({
        mode: capturedOwner.mode,
        channelEpoch: capturedOwner.channelEpoch,
        sessionEpoch: capturedOwner.sessionEpoch,
      })
      const api = createImportApi({ mode: capturedOwner.mode, scope })
      const onProgress = (progress: UploadByteProgress) => {
        if (
          isTearingDown ||
          currentOperationGeneration !== opGen ||
          trackedOwner !== capturedOwner ||
          trackedValidation !== capturedValidation ||
          !isCurrentOwnerValid(capturedOwner)
        ) {
          return
        }
        currentByteProgress = safeFreezeByteProgress(progress)
        currentRevision++
        cachedSnapshot = produceSnapshot()
        notifyWorkflowSubscribers()
      }
      const res = await api.uploadFiles(safeFiles, controller.signal, onProgress)

      if (
        isTearingDown ||
        currentOperationGeneration !== opGen ||
        trackedOwner !== capturedOwner ||
        trackedValidation !== capturedValidation ||
        !isCurrentOwnerValid(capturedOwner)
      ) {
        return
      }

      activePrivateController = null
      currentOperation = null
      currentByteProgress = null
      currentResult = safeFreezeImportResult(res)
      currentPrompt = null
      currentMessage = ''

      if (capturedOwner.mode === 'antigravity' && res.jobId) {
        handleEmailJobRegistration(capturedOwner, res.jobId)
      }

      currentRevision++
      cachedSnapshot = produceSnapshot()
      notifyWorkflowSubscribers()
    } catch (err) {
      if (
        isTearingDown ||
        currentOperationGeneration !== opGen ||
        trackedOwner !== capturedOwner ||
        trackedValidation !== capturedValidation ||
        !isCurrentOwnerValid(capturedOwner)
      ) {
        return
      }

      activePrivateController = null
      currentOperation = null
      currentByteProgress = null

      const prompt = projectPrompt(err)
      if (prompt !== null) {
        currentPrompt = safeFreezeProjectPrompt(prompt)
        currentResult = null
        currentMessage = '请选择或输入关联项目。'
      } else {
        let partial: ImportResult | null = null
        if (err instanceof ApiError && err.payload) {
          try {
            partial = normalizeResult(err.payload, false, capturedOwner.mode)
          } catch {
            partial = null
          }
        }
        if (partial !== null) {
          currentResult = safeFreezeImportResult(partial)
          currentPrompt = null
          currentMessage = failureMessage(err)
          if (
            err instanceof ApiError &&
            err.status === 400 &&
            capturedOwner.mode === 'antigravity' &&
            typeof partial.jobId === 'string' &&
            /^[0-9a-f]{32}$/.test(partial.jobId)
          ) {
            handleEmailJobRegistration(capturedOwner, partial.jobId)
          }
        } else {
          currentResult = null
          currentPrompt = null
          currentMessage = failureMessage(err)
        }
      }

      currentRevision++
      cachedSnapshot = produceSnapshot()
      notifyWorkflowSubscribers()
    } finally {
      opCleanup()
      if (activeOperationCleanup === opCleanup) {
        activeOperationCleanup = null
      }
    }
  })()

  return true
}

export function importWorkflowTokens(owner: ImportFlowOwner, input: Readonly<TokenInput>): boolean {
  if (isTearingDown) return false
  if (!isAdmissibleOwner(owner)) return false
  if (!input || typeof input !== 'object') return false
  if (
    !Array.isArray(input.tokens) ||
    input.tokens.length < 1 ||
    input.tokens.length > 200 ||
    !input.tokens.every(t => typeof t === 'string')
  ) {
    return false
  }
  if (
    typeof input.clientId !== 'string' ||
    typeof input.clientSecret !== 'string' ||
    typeof input.projectId !== 'string' ||
    typeof input.filename !== 'string'
  ) {
    return false
  }
  if (currentOperation !== null) return false

  const controller = new AbortController()
  currentOperation = 'tokens'
  activePrivateController = controller
  currentResult = null
  currentPrompt = null
  currentMessage = ''

  const opGen = ++currentOperationGeneration
  const capturedOwner = owner
  const capturedValidation = trackedValidation!
  const safeTokens = Array.from(input.tokens)
  const safeInput: TokenInput = {
    tokens: safeTokens,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    projectId: input.projectId,
    filename: input.filename,
  }

  let opCleaned = false
  const opCleanup = () => {
    if (opCleaned) return
    opCleaned = true
    safeTokens.length = 0
    safeInput.tokens = []
    safeInput.clientId = ''
    safeInput.clientSecret = ''
    safeInput.projectId = ''
    safeInput.filename = ''
  }
  activeOperationCleanup = opCleanup

  currentRevision++
  cachedSnapshot = produceSnapshot()
  notifyWorkflowSubscribers()

  void (async () => {
    try {
      if (
        isTearingDown ||
        currentOperationGeneration !== opGen ||
        trackedOwner !== capturedOwner ||
        trackedValidation !== capturedValidation ||
        !isCurrentOwnerValid(capturedOwner)
      ) {
        return
      }

      const scope: PanelScope = Object.freeze({
        mode: capturedOwner.mode,
        channelEpoch: capturedOwner.channelEpoch,
        sessionEpoch: capturedOwner.sessionEpoch,
      })
      const api = createImportApi({ mode: capturedOwner.mode, scope })
      const res = await api.importTokens(safeInput, controller.signal)

      // Clear transient copies immediately after successful transport
      opCleanup()

      if (
        isTearingDown ||
        currentOperationGeneration !== opGen ||
        trackedOwner !== capturedOwner ||
        trackedValidation !== capturedValidation ||
        !isCurrentOwnerValid(capturedOwner)
      ) {
        return
      }

      activePrivateController = null
      currentOperation = null
      currentResult = safeFreezeImportResult(res)
      currentPrompt = null
      currentMessage = ''

      if (capturedOwner.mode === 'antigravity' && res.jobId) {
        handleEmailJobRegistration(capturedOwner, res.jobId)
      }

      currentRevision++
      cachedSnapshot = produceSnapshot()
      notifyWorkflowSubscribers()
    } catch (err) {
      opCleanup()

      if (
        isTearingDown ||
        currentOperationGeneration !== opGen ||
        trackedOwner !== capturedOwner ||
        trackedValidation !== capturedValidation ||
        !isCurrentOwnerValid(capturedOwner)
      ) {
        return
      }

      activePrivateController = null
      currentOperation = null

      const prompt = projectPrompt(err)
      if (prompt !== null) {
        currentPrompt = safeFreezeProjectPrompt(prompt)
        currentResult = null
        currentMessage = '请选择或输入关联项目。'
      } else {
        let partial: ImportResult | null = null
        if (err instanceof ApiError && err.payload) {
          try {
            partial = normalizeResult(err.payload, false, capturedOwner.mode)
          } catch {
            partial = null
          }
        }
        if (partial !== null) {
          currentResult = safeFreezeImportResult(partial)
          currentPrompt = null
          currentMessage = failureMessage(err)
          if (
            err instanceof ApiError &&
            err.status === 400 &&
            capturedOwner.mode === 'antigravity' &&
            typeof partial.jobId === 'string' &&
            /^[0-9a-f]{32}$/.test(partial.jobId)
          ) {
            handleEmailJobRegistration(capturedOwner, partial.jobId)
          }
        } else {
          currentResult = null
          currentPrompt = null
          currentMessage = failureMessage(err)
        }
      }

      currentRevision++
      cachedSnapshot = produceSnapshot()
      notifyWorkflowSubscribers()
    } finally {
      opCleanup()
      if (activeOperationCleanup === opCleanup) {
        activeOperationCleanup = null
      }
    }
  })()

  return true
}

export function cancelWorkflowOperation(owner: ImportFlowOwner): boolean {
  if (isTearingDown) return false
  if (!isAdmissibleOwner(owner)) return false
  if (currentOperation === null) return false

  const prevOp = currentOperation
  const handleToStop = activeTaskHandle
  const controllerToAbort = activePrivateController

  // Clean up transient inputs immediately upon cancellation
  if (activeOperationCleanup) {
    try {
      activeOperationCleanup()
    } catch {
      // Isolate
    }
    activeOperationCleanup = null
  }

  currentOperationGeneration++
  currentOperation = null
  activeTaskHandle = null
  activePrivateController = null
  currentByteProgress = null

  if (prevOp === 'oauth-start' || prevOp === 'oauth-complete') {
    currentAuthUrl = ''
  }
  currentMessage = '已停止等待。服务器可能已保存凭证；此操作不会撤销导入。请到凭证页确认。'

  currentRevision++
  cachedSnapshot = produceSnapshot()
  notifyWorkflowSubscribers()

  if (handleToStop) {
    try {
      stopImportFlowTask(owner, handleToStop)
    } catch {
      // Isolate
    }
  }
  if (controllerToAbort) {
    try {
      controllerToAbort.abort()
    } catch {
      // Isolate
    }
  }

  return true
}

export function stopWorkflowEmailJob(owner: ImportFlowOwner, jobId: string): boolean {
  if (isTearingDown) return false
  if (!isAdmissibleOwner(owner)) return false
  if (typeof jobId !== 'string') return false

  const job = emailJobs.find(j => j.jobId === jobId)
  if (!job || job.status !== 'tracking') return false

  job.status = 'stopped'
  job.generation = ++nextJobGeneration
  job.message = '已停止跟踪'

  const handleToStop = job.handle
  job.handle = null

  if (!emailJobs.some(j => j.status === 'tracking')) {
    activePollingRun?.cancelSleep()
  }

  currentRevision++
  cachedSnapshot = produceSnapshot()
  notifyWorkflowSubscribers()

  if (handleToStop) {
    try {
      stopImportFlowTask(owner, handleToStop)
    } catch {
      // Isolate
    }
  }

  return true
}

export function resumeWorkflowEmailJob(owner: ImportFlowOwner, jobId: string): boolean {
  if (isTearingDown) return false
  if (!isAdmissibleOwner(owner)) return false
  if (typeof jobId !== 'string') return false

  const job = emailJobs.find(j => j.jobId === jobId)
  if (!job || (job.status !== 'stopped' && job.status !== 'unavailable')) return false

  const handle = beginImportFlowTask(owner, 'email', jobId)
  if (!handle) {
    currentEmailWarning = '后台邮箱任务注册失败，未能恢复跟踪。'
    currentRevision++
    cachedSnapshot = produceSnapshot()
    notifyWorkflowSubscribers()
    return false
  }

  job.status = 'tracking'
  job.handle = handle
  job.generation = ++nextJobGeneration
  job.message = '正在跟踪邮箱导入进度...'
  currentEmailWarning = ''

  currentRevision++
  cachedSnapshot = produceSnapshot()
  notifyWorkflowSubscribers()

  ensurePollingLoop(owner)
  return true
}

export function clearFinishedWorkflowEmailJobs(owner: ImportFlowOwner): boolean {
  if (isTearingDown) return false
  if (!isAdmissibleOwner(owner)) return false

  const hasFinished = emailJobs.some(j => j.status === 'complete' || j.status === 'expired')
  if (!hasFinished) return false

  emailJobs = emailJobs.filter(j => j.status !== 'complete' && j.status !== 'expired')
  if (emailJobs.length < MAX_RETAINED_EMAIL_JOBS && currentEmailWarning.includes('上限')) {
    currentEmailWarning = ''
  }

  currentRevision++
  cachedSnapshot = produceSnapshot()
  notifyWorkflowSubscribers()

  return true
}
