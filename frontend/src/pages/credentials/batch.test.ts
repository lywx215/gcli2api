import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCredentialBatch,
  type BatchOperation,
  type BatchWorkers,
  type BatchReceipt,
} from './batch';
import {
  capturePanelScope,
  __invalidatePanelChannel,
  type PanelScope,
} from '@/domain/panel';
import { setSessionToken, getSessionSnapshot } from '@/auth/session';

interface ActiveOwnerContext {
  readonly scope: PanelScope;
  readonly isCurrentOwner: () => boolean;
  readonly setOwnerActive: (active: boolean) => void;
}

function createTestOwnerContext(): ActiveOwnerContext {
  setSessionToken('active-test-token');
  const sessionSnap = getSessionSnapshot();
  const scope = capturePanelScope(sessionSnap.sessionEpoch);
  let ownerActive = true;
  return {
    scope,
    isCurrentOwner: () => ownerActive,
    setOwnerActive: (active: boolean) => {
      ownerActive = active;
    },
  };
}

describe('Credential Batch Controller Regressions', () => {
  beforeEach(() => {
    setSessionToken(null);
  });

  describe('Primary regression: synchronous stop from first running notification and pre-microtask owner loss', () => {
    const testCases: readonly { readonly name: string; readonly operation: BatchOperation; readonly isQuota: boolean }[] = [
      { name: 'per-file (test)', operation: 'test', isQuota: false },
      { name: 'quota', operation: 'quota', isQuota: true },
    ];

    for (const tc of testCases) {
      it(`stops synchronously from first running-item notification for ${tc.name}: 0 worker calls, not-started rows, running false, settled once`, async () => {
        const ownerCtx = createTestOwnerContext();
        let workerCalls = 0;

        const fileWorker = vi.fn(async () => {
          workerCalls++;
          return { outcome: 'success', httpStatus: 200 };
        });

        const quotaWorker = vi.fn(async (names: readonly string[]) => {
          workerCalls++;
          return names.map((filename) => ({
            filename,
            outcome: 'success',
            httpStatus: 200,
          }));
        });

        const workers: BatchWorkers = tc.isQuota
          ? { quota: quotaWorker }
          : { test: fileWorker };

        const controller = createCredentialBatch({
          scope: ownerCtx.scope,
          isCurrentOwner: ownerCtx.isCurrentOwner,
          workers,
        });

        let stopTriggered = false;
        controller.subscribe(() => {
          const snap = controller.getSnapshot();
          if (!stopTriggered && snap.items.some((it) => it.phase === 'running')) {
            stopTriggered = true;
            controller.stop();
          }
        });

        let settledCount = 0;
        const startPromise = controller
          .start(tc.operation, ['cred-1.json', 'cred-2.json'])
          .then(() => {
            settledCount++;
          });

        await startPromise;

        expect(stopTriggered).toBe(true);
        expect(workerCalls).toBe(0);
        expect(settledCount).toBe(1);

        const finalSnap = controller.getSnapshot();
        expect(finalSnap.running).toBe(false);
        expect(finalSnap.stopped).toBe(true);
        expect(finalSnap.items).toHaveLength(2);
        for (const item of finalSnap.items) {
          expect(item.phase).toBe('not-started');
          expect(item.receipt).toBeNull();
        }
      });

      it(`invalidates real captured owner immediately after start before worker microtasks for ${tc.name}: no dispatch or stale result`, async () => {
        const ownerCtx = createTestOwnerContext();
        let workerCalls = 0;

        const fileWorker = vi.fn(async () => {
          workerCalls++;
          return { outcome: 'success', httpStatus: 200 };
        });

        const quotaWorker = vi.fn(async (names: readonly string[]) => {
          workerCalls++;
          return names.map((filename) => ({
            filename,
            outcome: 'success',
            httpStatus: 200,
          }));
        });

        const workers: BatchWorkers = tc.isQuota
          ? { quota: quotaWorker }
          : { test: fileWorker };

        const controller = createCredentialBatch({
          scope: ownerCtx.scope,
          isCurrentOwner: ownerCtx.isCurrentOwner,
          workers,
        });

        let settledCount = 0;
        const startPromise = controller
          .start(tc.operation, ['cred-1.json', 'cred-2.json'])
          .then(() => {
            settledCount++;
          });

        // Invalidate captured owner immediately after start synchronously before worker microtasks
        ownerCtx.setOwnerActive(false);

        // Bounded microtask flushing
        await Promise.resolve();
        await Promise.resolve();
        await startPromise;

        expect(workerCalls).toBe(0);
        expect(settledCount).toBe(1);

        const snap = controller.getSnapshot();
        expect(snap.running).toBe(false);
        expect(snap.stopped).toBe(true);
      });
    }
  });

  describe('A->B resolver-reentry scenario', () => {
    it('subscriber starts deferred B upon A completion; A resolves independently while B remains pending until its worker resolves', async () => {
      const ownerCtx = createTestOwnerContext();
      let resolveBWorker: (() => void) | null = null;
      const bWorkerPromise = new Promise<unknown>((resolve) => {
        resolveBWorker = () => resolve({ outcome: 'success', httpStatus: 200 });
      });

      const fileWorker = vi.fn(async (filename: string) => {
        if (filename === 'a.json') {
          return { outcome: 'success', httpStatus: 200 };
        }
        return bWorkerPromise;
      });

      const controller = createCredentialBatch({
        scope: ownerCtx.scope,
        isCurrentOwner: ownerCtx.isCurrentOwner,
        workers: { test: fileWorker },
      });

      let bStarted = false;
      let startBPromise: Promise<void> | null = null;

      controller.subscribe(() => {
        const snap = controller.getSnapshot();
        if (
          snap.attempt === 1 &&
          !snap.running &&
          snap.items.length === 1 &&
          snap.items[0]?.phase === 'completed'
        ) {
          if (!bStarted) {
            bStarted = true;
            queueMicrotask(() => {
              startBPromise = controller.start('test', ['b.json']);
            });
          }
        }
      });

      // A starts and completes
      await controller.start('test', ['a.json']);
      expect(bStarted).toBe(true);

      // Flush microtasks to allow startBPromise to be initiated
      await Promise.resolve();
      await Promise.resolve();
      expect(startBPromise).not.toBeNull();

      // Attempt B is running and pending worker resolution
      const snapBRunning = controller.getSnapshot();
      expect(snapBRunning.attempt).toBe(2);
      expect(snapBRunning.running).toBe(true);

      // Old finishing cleanup from A cannot alter B's state: B remains running
      await Promise.resolve();
      expect(controller.getSnapshot().attempt).toBe(2);
      expect(controller.getSnapshot().running).toBe(true);

      // Resolve B worker and verify completion
      resolveBWorker!();
      await startBPromise;

      const snapBCompleted = controller.getSnapshot();
      expect(snapBCompleted.attempt).toBe(2);
      expect(snapBCompleted.running).toBe(false);
      expect(snapBCompleted.items[0]?.phase).toBe('completed');
      expect(snapBCompleted.items[0]?.receipt?.outcome).toBe('success');
    });
  });

  describe('Quota chunking (small 23-name run) and active-only stop', () => {
    it('executes small 23-name quota run with chunks <= 10, peak <= 2, and unique dispatch', async () => {
      const ownerCtx = createTestOwnerContext();
      const names = Array.from({ length: 23 }, (_, i) => `cred-${String(i).padStart(2, '0')}.json`);

      let currentActive = 0;
      let peakActive = 0;
      const chunkSizes: number[] = [];
      const dispatchedNames: string[] = [];

      const quotaWorker = vi.fn(async (chunkNames: readonly string[]) => {
        currentActive++;
        peakActive = Math.max(peakActive, currentActive);
        chunkSizes.push(chunkNames.length);
        dispatchedNames.push(...chunkNames);

        await Promise.resolve();
        currentActive--;

        return chunkNames.map((filename) => ({
          filename,
          outcome: 'success',
          httpStatus: 200,
        }));
      });

      const controller = createCredentialBatch({
        scope: ownerCtx.scope,
        isCurrentOwner: ownerCtx.isCurrentOwner,
        workers: { quota: quotaWorker },
      });

      await controller.start('quota', names);

      expect(chunkSizes).toEqual([10, 10, 3]);
      expect(chunkSizes.every((sz) => sz <= 10)).toBe(true);
      expect(peakActive).toBeLessThanOrEqual(2);
      expect(dispatchedNames).toHaveLength(23);
      expect(new Set(dispatchedNames).size).toBe(23);

      const snap = controller.getSnapshot();
      expect(snap.running).toBe(false);
      expect(snap.items).toHaveLength(23);
      expect(snap.items.every((it) => it.phase === 'completed')).toBe(true);
    });

    it('active-only stop: immediate stopped:true/running:true, repeated stop inert, entered signals un-aborted, waiting until entered workers settle', async () => {
      const ownerCtx = createTestOwnerContext();
      let capturedSignal: AbortSignal | null = null;
      let resolveWorker: (() => void) | null = null;
      const workerDeferred = new Promise<unknown>((resolve) => {
        resolveWorker = () => resolve({ outcome: 'success', httpStatus: 200 });
      });

      const fileWorker = vi.fn((filename: string, signal: AbortSignal) => {
        void filename;
        capturedSignal = signal;
        return workerDeferred;
      });

      const controller = createCredentialBatch({
        scope: ownerCtx.scope,
        isCurrentOwner: ownerCtx.isCurrentOwner,
        workers: { test: fileWorker },
      });

      const startPromise = controller.start('test', ['active-file.json']);

      // Allow microtask to run so worker enters
      await Promise.resolve();
      await Promise.resolve();
      expect(fileWorker).toHaveBeenCalledTimes(1);
      expect(capturedSignal).not.toBeNull();

      // Trigger active stop
      controller.stop();

      // Immediately: stopped is true and running is true while waiting for entered worker
      const snapImmediate = controller.getSnapshot();
      expect(snapImmediate.stopped).toBe(true);
      expect(snapImmediate.running).toBe(true);

      // Repeated stop is inert
      controller.stop();
      const snapRepeated = controller.getSnapshot();
      expect(snapRepeated.stopped).toBe(true);
      expect(snapRepeated.running).toBe(true);

      // Stop does not abort workers already entered
      expect(capturedSignal!.aborted).toBe(false);

      // Now resolve the entered worker
      resolveWorker!();
      await startPromise;

      const snapFinal = controller.getSnapshot();
      expect(snapFinal.running).toBe(false);
      expect(snapFinal.stopped).toBe(true);
      expect(snapFinal.items[0]?.phase).toBe('completed');
    });
  });

  describe('Receipt safe projection and quota bijection guards', () => {
    it('projects valid own 200 success with writeback updates correctly', async () => {
      const ownerCtx = createTestOwnerContext();
      const fileWorker = vi.fn(async () => ({
        outcome: 'success',
        httpStatus: 200,
        upstreamStatus: 200,
        verifiedReply: true,
        updates: [{ name: 'quota', status: 'applied' }],
      }));

      const controller = createCredentialBatch({
        scope: ownerCtx.scope,
        isCurrentOwner: ownerCtx.isCurrentOwner,
        workers: { test: fileWorker },
      });

      await controller.start('test', ['file.json']);

      const receipt = controller.getSnapshot().items[0]?.receipt;
      expect(receipt).not.toBeNull();
      expect(receipt?.outcome).toBe('success');
      expect(receipt?.httpStatus).toBe(200);
      expect(receipt?.upstreamStatus).toBe(200);
      expect(receipt?.verifiedReply).toBe(true);
      expect(receipt?.updates).toEqual([{ name: 'quota', status: 'applied' }]);
    });

    it('retains outcome as unknown on malformed/inherited status or contradictory success', async () => {
      const ownerCtx = createTestOwnerContext();

      // Case 1: contradictory status 500 with outcome 'success'
      const contradictoryWorker = vi.fn(async () => ({
        outcome: 'success',
        httpStatus: 500,
      }));

      const controller1 = createCredentialBatch({
        scope: ownerCtx.scope,
        isCurrentOwner: ownerCtx.isCurrentOwner,
        workers: { test: contradictoryWorker },
      });

      await controller1.start('test', ['bad-1.json']);
      expect(controller1.getSnapshot().items[0]?.receipt?.outcome).toBe('unknown');

      // Case 2: malformed status 999
      const malformedWorker = vi.fn(async () => ({
        outcome: 'success',
        httpStatus: 999,
      }));

      const controller2 = createCredentialBatch({
        scope: ownerCtx.scope,
        isCurrentOwner: ownerCtx.isCurrentOwner,
        workers: { test: malformedWorker },
      });

      await controller2.start('test', ['bad-2.json']);
      expect(controller2.getSnapshot().items[0]?.receipt?.outcome).toBe('unknown');

      // Case 3: inherited status from prototype (not own property)
      interface InheritedProto {
        readonly httpStatus: number;
      }
      const proto: InheritedProto = { httpStatus: 200 };
      const inheritedWorker = vi.fn(async () => {
        const raw: Record<string, unknown> = Object.create(proto);
        raw.outcome = 'success';
        return raw;
      });

      const controller3 = createCredentialBatch({
        scope: ownerCtx.scope,
        isCurrentOwner: ownerCtx.isCurrentOwner,
        workers: { test: inheritedWorker },
      });

      await controller3.start('test', ['bad-3.json']);
      expect(controller3.getSnapshot().items[0]?.receipt?.outcome).toBe('unknown');
    });

    it('never copies unknown secret-canary fields into projected receipt', async () => {
      const ownerCtx = createTestOwnerContext();
      interface CanaryReceiptRaw {
        readonly outcome: string;
        readonly httpStatus: number;
        readonly canarySecret: string;
        readonly clientSecret: string;
        readonly privateKey: string;
      }

      const rawCanary: CanaryReceiptRaw = {
        outcome: 'success',
        httpStatus: 200,
        canarySecret: 'forbidden-canary-secret',
        clientSecret: 'forbidden-client-secret',
        privateKey: 'forbidden-private-key',
      };

      const fileWorker = vi.fn(async () => rawCanary);

      const controller = createCredentialBatch({
        scope: ownerCtx.scope,
        isCurrentOwner: ownerCtx.isCurrentOwner,
        workers: { test: fileWorker },
      });

      await controller.start('test', ['canary.json']);

      const receipt: BatchReceipt | null = controller.getSnapshot().items[0]?.receipt ?? null;
      expect(receipt).not.toBeNull();
      const keys = Object.keys(receipt!);
      expect(keys).not.toContain('canarySecret');
      expect(keys).not.toContain('clientSecret');
      expect(keys).not.toContain('privateKey');
      expect(receipt?.outcome).toBe('success');
      expect(receipt?.httpStatus).toBe(200);
    });

    it('guards against quota identity mismatch and duplicate row returned by worker', async () => {
      const ownerCtx = createTestOwnerContext();

      // Identity mismatch
      const mismatchWorker = vi.fn(async () => [
        { filename: 'wrong-file.json', outcome: 'success', httpStatus: 200 },
        { filename: 'q2.json', outcome: 'success', httpStatus: 200 },
      ]);

      const controllerMismatch = createCredentialBatch({
        scope: ownerCtx.scope,
        isCurrentOwner: ownerCtx.isCurrentOwner,
        workers: { quota: mismatchWorker },
      });

      await controllerMismatch.start('quota', ['q1.json', 'q2.json']);
      const snapMismatch = controllerMismatch.getSnapshot();
      expect(snapMismatch.stopped).toBe(true);
      expect(snapMismatch.items[0]?.receipt?.outcome).toBe('unknown');
      expect(snapMismatch.items[1]?.receipt?.outcome).toBe('unknown');

      // Duplicate row in worker output
      const duplicateWorker = vi.fn(async () => [
        { filename: 'q1.json', outcome: 'success', httpStatus: 200 },
        { filename: 'q1.json', outcome: 'success', httpStatus: 200 },
      ]);

      const controllerDup = createCredentialBatch({
        scope: ownerCtx.scope,
        isCurrentOwner: ownerCtx.isCurrentOwner,
        workers: { quota: duplicateWorker },
      });

      await controllerDup.start('quota', ['q1.json', 'q2.json']);
      const snapDup = controllerDup.getSnapshot();
      expect(snapDup.stopped).toBe(true);
      expect(snapDup.items[0]?.receipt?.outcome).toBe('unknown');
    });
  });

  describe('Real session/panel setters, owner loss invalidation and dispose', () => {
    it('disposes, aborts in-flight worker signal and settles start promise when session token is invalidated', async () => {
      const ownerCtx = createTestOwnerContext();
      let capturedSignal: AbortSignal | null = null;
      let resolveWorker: (() => void) | null = null;
      const workerPromise = new Promise<unknown>((resolve) => {
        resolveWorker = () => resolve({ outcome: 'success', httpStatus: 200 });
      });

      const fileWorker = vi.fn((filename: string, signal: AbortSignal) => {
        void filename;
        capturedSignal = signal;
        return workerPromise;
      });

      const controller = createCredentialBatch({
        scope: ownerCtx.scope,
        isCurrentOwner: ownerCtx.isCurrentOwner,
        workers: { test: fileWorker },
      });

      let startSettled = false;
      const startPromise = controller.start('test', ['file.json']).then(() => {
        startSettled = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(fileWorker).toHaveBeenCalled();
      expect(capturedSignal).not.toBeNull();
      expect(capturedSignal!.aborted).toBe(false);

      // Real session invalidation via real setter
      setSessionToken(null);

      // Controller is disposed and in-flight signal is aborted
      expect(capturedSignal!.aborted).toBe(true);
      await startPromise;
      expect(startSettled).toBe(true);

      const snap = controller.getSnapshot();
      expect(snap.running).toBe(false);
      expect(snap.stopped).toBe(true);
      expect(snap.items).toHaveLength(0);

      // Even if worker resolves later, stale publication is suppressed
      resolveWorker!();
      await Promise.resolve();
      expect(controller.getSnapshot().items).toHaveLength(0);
    });

    it('disposes and settles start promise when panel channel is invalidated', async () => {
      const ownerCtx = createTestOwnerContext();
      let capturedSignal: AbortSignal | null = null;
      const workerPromise = new Promise<unknown>(() => {});

      const fileWorker = vi.fn((filename: string, signal: AbortSignal) => {
        void filename;
        capturedSignal = signal;
        return workerPromise;
      });

      const controller = createCredentialBatch({
        scope: ownerCtx.scope,
        isCurrentOwner: ownerCtx.isCurrentOwner,
        workers: { test: fileWorker },
      });

      let startSettled = false;
      const startPromise = controller.start('test', ['file.json']).then(() => {
        startSettled = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(fileWorker).toHaveBeenCalled();

      // Channel invalidation via real setter
      __invalidatePanelChannel();

      expect(capturedSignal!.aborted).toBe(true);
      await startPromise;
      expect(startSettled).toBe(true);
      expect(controller.getSnapshot().running).toBe(false);
    });
  });
});
