import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useAuth } from '@/auth'
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  type SessionValidationSnapshot,
} from '@/auth/session'
import {
  getPanelChannelSnapshot,
  type PanelMode,
} from '@/domain/panel'
import {
  cancelWorkflowOperation,
  clearFinishedWorkflowEmailJobs,
  completeWorkflowOAuth,
  getImportWorkflowSnapshot,
  importWorkflowTokens,
  resumeWorkflowEmailJob,
  startWorkflowOAuth,
  stopWorkflowEmailJob,
  subscribeImportWorkflow,
  uploadWorkflowFiles,
  type ImportWorkflowEmailJob,
  type ImportWorkflowOperation,
  type ImportWorkflowReadonly,
} from './workflowRunner'
import type { ImportFlowOwner } from './flowStore'
import type {
  EmailSnapshot,
  ImportResult,
  ProjectPrompt,
  TokenInput,
} from './types'

export const supportedPanelModes: readonly ['antigravity', 'geminicli'] = Object.freeze([
  'antigravity',
  'geminicli',
] as const)

export type UseImportFlowResult = {
  readonly owner: ImportFlowOwner | null
  readonly validation: SessionValidationSnapshot | null
  readonly revision: number
  readonly busy: boolean
  readonly operation: ImportWorkflowOperation | null
  readonly result: ImportWorkflowReadonly<ImportResult> | null
  readonly prompt: ImportWorkflowReadonly<ProjectPrompt> | null
  readonly authUrl: string
  readonly message: string
  readonly emailJobs: readonly ImportWorkflowEmailJob[]
  readonly emailWarning: string
  readonly authenticated: boolean
  readonly sessionEpoch: number
  readonly mode: PanelMode
  readonly jobId?: string
  readonly email?: ImportWorkflowReadonly<EmailSnapshot> | null
  readonly emailMessage?: string
  isCurrent(): boolean
  startOAuth(projectId: string): boolean
  completeOAuth(callbackUrl: string | null, projectId: string): boolean
  uploadFiles(files: readonly File[]): boolean
  importTokens(input: Readonly<TokenInput>): boolean
  cancel(): boolean
  stopEmailJob(jobId: string): boolean
  resumeEmailJob(jobId: string): boolean
  clearFinishedEmailJobs(): boolean
  stopEmail(jobId?: string): boolean
}

export function useImportFlow(): UseImportFlowResult {
  const auth = useAuth()
  const snapshot = useSyncExternalStore(
    subscribeImportWorkflow,
    getImportWorkflowSnapshot,
    getImportWorkflowSnapshot,
  )

  const actorRef = useRef<{ id: number; mounted: boolean }>({ id: 1, mounted: true })
  useEffect(() => {
    actorRef.current.mounted = true
    return () => {
      actorRef.current.mounted = false
    }
  }, [])

  const isGuardValid = useCallback(
    (capturedOwner: ImportFlowOwner | null, capturedValidation: SessionValidationSnapshot | null): capturedOwner is ImportFlowOwner => {
      if (!actorRef.current.mounted) return false
      if (!auth.authenticated) return false
      if (!capturedOwner || !capturedValidation) return false
      if (snapshot.owner !== capturedOwner || snapshot.validation !== capturedValidation) return false

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

      return true
    },
    [auth.authenticated, snapshot.owner, snapshot.validation],
  )

  const isCurrent = useCallback((): boolean => {
    return isGuardValid(snapshot.owner, snapshot.validation)
  }, [isGuardValid, snapshot.owner, snapshot.validation])

  const startOAuth = useCallback(
    (projectId: string): boolean => {
      const owner = snapshot.owner
      const validation = snapshot.validation
      if (!isGuardValid(owner, validation)) return false
      return startWorkflowOAuth(owner, projectId)
    },
    [isGuardValid, snapshot.owner, snapshot.validation],
  )

  const completeOAuth = useCallback(
    (callbackUrl: string | null, projectId: string): boolean => {
      const owner = snapshot.owner
      const validation = snapshot.validation
      if (!isGuardValid(owner, validation)) return false
      return completeWorkflowOAuth(owner, callbackUrl, projectId)
    },
    [isGuardValid, snapshot.owner, snapshot.validation],
  )

  const uploadFiles = useCallback(
    (files: readonly File[]): boolean => {
      const owner = snapshot.owner
      const validation = snapshot.validation
      if (!isGuardValid(owner, validation)) return false
      return uploadWorkflowFiles(owner, files)
    },
    [isGuardValid, snapshot.owner, snapshot.validation],
  )

  const importTokens = useCallback(
    (input: Readonly<TokenInput>): boolean => {
      const owner = snapshot.owner
      const validation = snapshot.validation
      if (!isGuardValid(owner, validation)) return false
      return importWorkflowTokens(owner, input)
    },
    [isGuardValid, snapshot.owner, snapshot.validation],
  )

  const cancel = useCallback((): boolean => {
    const owner = snapshot.owner
    const validation = snapshot.validation
    if (!isGuardValid(owner, validation)) return false
    return cancelWorkflowOperation(owner)
  }, [isGuardValid, snapshot.owner, snapshot.validation])

  const stopEmailJob = useCallback(
    (jobId: string): boolean => {
      const owner = snapshot.owner
      const validation = snapshot.validation
      if (!isGuardValid(owner, validation)) return false
      return stopWorkflowEmailJob(owner, jobId)
    },
    [isGuardValid, snapshot.owner, snapshot.validation],
  )

  const resumeEmailJob = useCallback(
    (jobId: string): boolean => {
      const owner = snapshot.owner
      const validation = snapshot.validation
      if (!isGuardValid(owner, validation)) return false
      return resumeWorkflowEmailJob(owner, jobId)
    },
    [isGuardValid, snapshot.owner, snapshot.validation],
  )

  const clearFinishedEmailJobs = useCallback((): boolean => {
    const owner = snapshot.owner
    const validation = snapshot.validation
    if (!isGuardValid(owner, validation)) return false
    return clearFinishedWorkflowEmailJobs(owner)
  }, [isGuardValid, snapshot.owner, snapshot.validation])

  const stopEmail = useCallback(
    (jobId?: string): boolean => {
      const targetId =
        jobId ??
        (snapshot.emailJobs.length > 0
          ? snapshot.emailJobs[snapshot.emailJobs.length - 1].jobId
          : undefined)
      if (typeof targetId === 'string') {
        return stopEmailJob(targetId)
      }
      return false
    },
    [snapshot.emailJobs, stopEmailJob],
  )

  const latestEmailJob =
    snapshot.emailJobs.length > 0
      ? snapshot.emailJobs[snapshot.emailJobs.length - 1]
      : undefined
  const jobId = latestEmailJob?.jobId ?? snapshot.result?.jobId
  const email = latestEmailJob?.snapshot ?? null
  const emailMessage = latestEmailJob?.message ?? snapshot.emailWarning

  const channelSnapshot = getPanelChannelSnapshot()
  const mode = snapshot.owner?.mode ?? channelSnapshot.mode

  return {
    owner: snapshot.owner,
    validation: snapshot.validation,
    revision: snapshot.revision,
    busy: snapshot.busy,
    operation: snapshot.operation,
    result: snapshot.result,
    prompt: snapshot.prompt,
    authUrl: snapshot.authUrl,
    message: snapshot.message,
    emailJobs: snapshot.emailJobs,
    emailWarning: snapshot.emailWarning,
    authenticated: auth.authenticated,
    sessionEpoch: auth.sessionEpoch,
    mode,
    jobId,
    email,
    emailMessage,
    isCurrent,
    startOAuth,
    completeOAuth,
    uploadFiles,
    importTokens,
    cancel,
    stopEmailJob,
    resumeEmailJob,
    clearFinishedEmailJobs,
    stopEmail,
  }
}
