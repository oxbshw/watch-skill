/**
 * The one selection every Watch surface reads and writes.
 *
 * DSH's Trajectory selection is documented as local to Trajectory, with no
 * anchor deep links. This is the smallest additive extension around that: a
 * Watch-owned service holding the canonical selection for Watch-related
 * records, which surfaces subscribe to. Nothing upstream is replaced — DSH
 * keeps its own local selection, and Watch drives it from here.
 *
 * A store rather than a value, because several panels need to observe the same
 * change; but the value it holds is the pure `WatchSelection` from
 * `@watchskill/dsh-trajectory`, so every rule about what a selection means
 * stays testable without a browser.
 *
 * @module @watchskill/dsh-trajectory/selection-store
 */

import type { WatchSelection } from './selection.js'
import type { WatchProjection } from './projection.js'
import { emptySelection, fromDeepLink, toDeepLink } from './selection.js'

/** Notified whenever the selection changes. */
export type SelectionListener = (selection: WatchSelection) => void

/**
 * Holds the canonical Watch selection for one workspace.
 *
 * Deliberately has no knowledge of panels. A panel subscribes and renders; it
 * never asks another panel what is selected, which is what stops the panels
 * from disagreeing.
 */
export class WatchSelectionStore {
  private current: WatchSelection
  private readonly listeners = new Set<SelectionListener>()
  /** The latest projection, so a deep link can resolve without a round trip. */
  private projection: WatchProjection | null = null

  constructor(workspaceId: string, sessionId: string) {
    this.current = emptySelection(workspaceId, sessionId)
  }

  /** The current selection. Always a value; never undefined. */
  get(): WatchSelection {
    return this.current
  }

  /**
   * Replace the selection.
   *
   * A selection identical to the current one is dropped rather than
   * broadcast. Panels both read and write this store, so an echo would loop:
   * a panel reacts to its own change, re-selects, and notifies again.
   */
  set(selection: WatchSelection): void {
    if (isSame(this.current, selection)) return
    this.current = selection
    for (const listener of this.listeners) listener(selection)
  }

  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: SelectionListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Publish the projection a deep link should resolve against. */
  setProjection(projection: WatchProjection): void {
    this.projection = projection
  }

  /** The current projection, or null before the session has loaded. */
  getProjection(): WatchProjection | null {
    return this.projection
  }

  /** A link that restores the current selection. */
  link(): string {
    return toDeepLink(this.current)
  }

  /**
   * Restore a selection from a link.
   *
   * @returns whether the fragment was a Watch link that named a session. A
   * fragment that is not one leaves the selection alone rather than clearing
   * it to a half-restored state.
   */
  restore(fragment: string): boolean {
    const restored = fromDeepLink(fragment)
    if (restored === null) return false
    this.set(restored)
    return true
  }

  /** Release every subscriber. Called when the plugin unloads. */
  dispose(): void {
    this.listeners.clear()
    this.projection = null
  }
}

/**
 * Whether two selections point at the same thing.
 *
 * `origin` is excluded on purpose: it records which surface moved, not what is
 * selected, and including it would make every panel's echo look like a change.
 */
function isSame(left: WatchSelection, right: WatchSelection): boolean {
  return left.workspaceId === right.workspaceId
    && left.sessionId === right.sessionId
    && left.recordId === right.recordId
    && left.evidenceId === right.evidenceId
    && left.sourceId === right.sourceId
    && left.sourceRevisionId === right.sourceRevisionId
    && left.verificationId === right.verificationId
    && left.receiptId === right.receiptId
    && left.memoryId === right.memoryId
    && left.atMs === right.atMs
    && left.endMs === right.endMs
    && left.inspectorTab === right.inspectorTab
}
