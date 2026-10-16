/**
 * Migration intent gate utility.
 *
 * Provides a synchronous, single-use gate for tracking local migration intent tickets.
 * Each gate manages independent opaque local identities with zero external side effects.
 */

export interface MigrationIntentTicket {
  readonly id: string;
}

export interface MigrationIntentGate {
  issue(): MigrationIntentTicket;
  consume(ticket?: unknown): boolean;
  cancel(ticket?: unknown): void;
  clear(): void;
}

/**
 * Creates an independent migration intent gate.
 *
 * Guarantees:
 * - Each gate owns independent local identity tickets.
 * - Successive `issue()` invalidates earlier tickets.
 * - `consume(ticket)` synchronously returns true only once for the current live ticket;
 *   repeats, stale, foreign, or invalid tickets return false.
 * - `cancel(ticket)` invalidates only its matching ticket; stale cancellations cannot
 *   revoke a newer issue.
 * - `clear()` revokes any outstanding live ticket.
 * - No global state, transport, timers, React, or module side effects.
 */
export function createMigrationIntentGate(): MigrationIntentGate {
  let counter = 0;
  let currentTicket: MigrationIntentTicket | null = null;

  return {
    issue(): MigrationIntentTicket {
      counter += 1;
      const ticket: MigrationIntentTicket = Object.freeze({
        id: `mig_intent_${counter}_${Math.random().toString(36).slice(2, 10)}`,
      });
      currentTicket = ticket;
      return ticket;
    },

    consume(ticket?: unknown): boolean {
      if (currentTicket !== null && ticket === currentTicket) {
        currentTicket = null;
        return true;
      }
      return false;
    },

    cancel(ticket?: unknown): void {
      if (currentTicket !== null && ticket === currentTicket) {
        currentTicket = null;
      }
    },

    clear(): void {
      currentTicket = null;
    },
  };
}

export default createMigrationIntentGate;
