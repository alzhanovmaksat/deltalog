/**
 * The review workflow.
 *
 * The acknowledgement is the part auditors actually want. A diff proves the vendor
 * changed something; a named person accepting or escalating it on a timestamp proves
 * *your* control operated. This module records that decision and assembles the view a
 * reviewer needs to make it in forty seconds.
 */

import { diffClauses, type ClauseChange } from './clauses.ts';
import { diffEntities, type EntityDiff } from './entities.ts';
import type { PageSnapshot } from './materiality.ts';

export type Decision = 'accepted' | 'escalated';

export interface AlertRecord {
  id: string;
  workspaceId: string;
  watchId: string;
  vendor: string;
  url: string;
  kind: string;
  severity: 'high' | 'low';
  summary: string;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  decision?: Decision;
  note?: string;
}

export interface QueueItem extends AlertRecord {}

export interface ReviewView extends AlertRecord {
  entityDiff?: EntityDiff;
  clauseChanges?: ClauseChange[];
  comparedFrom?: string;
  comparedTo?: string;
}

export interface ReviewStore {
  alert(alertId: string, workspaceId: string): Promise<AlertRecord | null>;
  queue(workspaceId: string, limit: number): Promise<QueueItem[]>;
  /** The two revisions bracketing an alert: the state before it, and the state it reported. */
  revisionsAround(watchId: string, at: string): Promise<{ previous: PageSnapshot | null; current: PageSnapshot | null }>;
  /** Must only apply when no decision has been recorded yet. Returns rows affected. */
  recordDecision(input: {
    alertId: string;
    workspaceId: string;
    decision: Decision;
    reviewer: string;
    note: string;
    at: string;
  }): Promise<number>;
}

export type ReviewOutcome = 'recorded' | 'already_reviewed' | 'not_found';

/**
 * Records a decision, once.
 *
 * `reviewer` comes from the caller's *session*, never from the submitted form — a
 * form field would let anyone write any colleague's name into an audit record, which
 * turns the acknowledgement from evidence into decoration.
 *
 * Decisions are final by design. Letting someone overwrite "escalated" with
 * "accepted" three months later would be editing the audit trail; the way to change
 * position is a new escalation, which leaves the original on the record.
 */
export async function recordDecision(
  store: ReviewStore,
  input: { alertId: string; workspaceId: string; decision: Decision; reviewer: string; note: string; at: string },
): Promise<ReviewOutcome> {
  const alert = await store.alert(input.alertId, input.workspaceId);
  if (!alert) return 'not_found';
  if (alert.decision) return 'already_reviewed';

  // The store's UPDATE is guarded on `decision IS NULL`, so two reviewers clicking at
  // once resolve to one winner rather than a last-write-wins race.
  const applied = await store.recordDecision({ ...input, note: input.note.slice(0, 2000) });
  return applied > 0 ? 'recorded' : 'already_reviewed';
}

/**
 * Builds the detail view, re-deriving the diff from the stored revisions with the same
 * functions that produced the alert. Nothing about the change is cached in the alert
 * row beyond its summary, so there is no way for the page to disagree with the email.
 */
export async function buildReviewView(store: ReviewStore, alert: AlertRecord): Promise<ReviewView> {
  const { previous, current } = await store.revisionsAround(alert.watchId, alert.createdAt);
  if (!previous || !current) return alert;

  const view: ReviewView = {
    ...alert,
    comparedFrom: previous.fetchedAt,
    comparedTo: current.fetchedAt,
  };

  if (previous.entities.length && current.entities.length) {
    view.entityDiff = diffEntities(previous.entities, current.entities);
  }
  if (previous.clauses?.length && current.clauses?.length) {
    view.clauseChanges = diffClauses(previous.clauses, current.clauses);
  }
  return view;
}

/** Unreviewed first, then most recent — the queue is a to-do list, not a feed. */
export function sortQueue(items: QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => {
    if (!a.decision !== !b.decision) return a.decision ? 1 : -1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}
