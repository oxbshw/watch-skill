/**
 * Triggers: a rule that notices something, and cannot do anything about it.
 *
 * A live observation runs for a long time and the interesting second is
 * usually not the one anybody is watching. So a trigger says "tell me when the
 * deploy log says failed", or "pin the moment the stream drops", and the
 * session keeps an eye out.
 *
 * The whole design question is what a trigger is allowed to *do*, and the
 * answer here is deliberately narrow: it may pin a moment, raise a
 * notification, or ask for a snapshot. It may not act. That is not a
 * limitation waiting to be lifted — {@link TriggerEffect} has no member that
 * touches the world, because a trigger fires on observed content, and a
 * trigger that could act would be a page deciding to click something by
 * putting the right words on screen.
 *
 * The second rule is a cooldown, which sounds like ergonomics and is not. A
 * text trigger on a scrolling log fires on every line, and a thousand
 * notifications is the same as none — except that it also buries the one that
 * mattered.
 *
 * @module @watchskill/dsh-live/triggers
 */

import type { LiveEvent, LiveEventKind, LiveSessionState } from './session.js'

/**
 * What firing does.
 *
 * Three members, all of them observation. There is no `act`, and adding one
 * would mean observed content could reach the operator loop without a person
 * in between.
 */
export type TriggerEffect =
  /** Keep the moment, so it survives the buffer bound. */
  | 'pin'
  /** Tell the person watching. */
  | 'notify'
  /** Ask for a fresh snapshot, for a trigger about continuity. */
  | 'snapshot'

/** Every effect, so a UI can enumerate them and a test can check the set. */
export const TRIGGER_EFFECTS: readonly TriggerEffect[] = ['pin', 'notify', 'snapshot']

/** When a trigger fires. */
export type TriggerCondition =
  /** Any event of this kind. */
  | { readonly kind: 'event_kind'; readonly eventKind: LiveEventKind }
  /** Observed text containing a phrase. */
  | { readonly kind: 'text_contains'; readonly phrase: string; readonly caseSensitive: boolean }
  /** A capture gap longer than a threshold. */
  | { readonly kind: 'gap_longer_than'; readonly ms: number }
  /** Nothing observed for a while, which is itself information. */
  | { readonly kind: 'silence_for'; readonly ms: number }

/** One rule. */
export interface LiveTrigger {
  readonly triggerId: string
  /** What the person called it. */
  readonly label: string
  readonly when: TriggerCondition
  readonly effect: TriggerEffect
  /** How long after firing before it may fire again. */
  readonly cooldownMs: number
  readonly enabled: boolean
}

/** One firing. */
export interface TriggerFiring {
  readonly triggerId: string
  readonly effect: TriggerEffect
  /** The event that caused it, when one did. */
  readonly eventSeq: number | null
  readonly atMs: number
  /** One line for the notification. Presentation only. */
  readonly reason: string
}

/** When each trigger last fired, so a cooldown can be applied. */
export type TriggerCooldowns = ReadonlyMap<string, number>

/** Whether one event satisfies one condition. */
function matches(
  condition: TriggerCondition,
  event: LiveEvent,
): { readonly hit: boolean; readonly reason: string } {
  switch (condition.kind) {
    case 'event_kind':
      return event.kind === condition.eventKind
        ? { hit: true, reason: `a ${condition.eventKind} event` }
        : { hit: false, reason: '' }

    case 'text_contains': {
      const haystack = condition.caseSensitive ? event.text : event.text.toLowerCase()
      const needle = condition.caseSensitive ? condition.phrase : condition.phrase.toLowerCase()
      return haystack.includes(needle)
        ? { hit: true, reason: `observed text contains "${condition.phrase}"` }
        : { hit: false, reason: '' }
    }

    case 'gap_longer_than': {
      if (event.kind !== 'gap' || event.range === null) return { hit: false, reason: '' }
      const length = event.range.endMs - event.range.startMs
      return length > condition.ms
        ? { hit: true, reason: `a ${String(length)}ms capture gap` }
        : { hit: false, reason: '' }
    }

    case 'silence_for':
      // Silence is not a property of an event. Handled separately below.
      return { hit: false, reason: '' }
  }
}

/**
 * Evaluate triggers against newly arrived events.
 *
 * Pure, and takes the cooldown map rather than holding one, so the same
 * function serves the live session and a replay of it. A trigger evaluator
 * with internal state would produce different firings on replay than it did
 * live, which would make a pinned moment unreproducible.
 */
export function evaluateTriggers(
  state: LiveSessionState,
  triggers: readonly LiveTrigger[],
  newEvents: readonly LiveEvent[],
  nowMs: number,
  cooldowns: TriggerCooldowns = new Map(),
): { readonly firings: readonly TriggerFiring[]; readonly cooldowns: TriggerCooldowns } {
  const firings: TriggerFiring[] = []
  const updated = new Map(cooldowns)

  /** Whether a trigger is allowed to fire right now. */
  const ready = (trigger: LiveTrigger, atMs: number): boolean => {
    if (!trigger.enabled) return false
    const last = updated.get(trigger.triggerId)
    return last === undefined || atMs - last >= trigger.cooldownMs
  }

  for (const trigger of triggers) {
    if (trigger.when.kind === 'silence_for') {
      // A silence trigger is about the absence of events, so it is evaluated
      // against the clock rather than against a batch.
      const newest = state.events[state.events.length - 1]
      const since = newest === undefined ? nowMs - state.startedAtMs : nowMs - newest.at
      if (newEvents.length === 0 && since >= trigger.when.ms && ready(trigger, nowMs)) {
        updated.set(trigger.triggerId, nowMs)
        firings.push({
          triggerId: trigger.triggerId,
          effect: trigger.effect,
          eventSeq: null,
          atMs: nowMs,
          reason: `nothing observed for ${String(since)}ms`,
        })
      }
      continue
    }

    for (const event of newEvents) {
      if (!ready(trigger, event.at)) continue
      const result = matches(trigger.when, event)
      if (!result.hit) continue
      updated.set(trigger.triggerId, event.at)
      firings.push({
        triggerId: trigger.triggerId,
        effect: trigger.effect,
        eventSeq: event.seq,
        atMs: event.at,
        reason: result.reason,
      })
    }
  }

  return { firings, cooldowns: updated }
}

/**
 * Whether a firing may cause anything outside the session.
 *
 * Always false. Present as a function rather than as a comment so a caller
 * that is about to route a firing somewhere has something to check, and so a
 * test can assert the answer for every effect the type allows.
 */
export function mayAct(_firing: TriggerFiring): false {
  return false
}

/**
 * One line describing what a trigger will do, for the panel that creates it.
 *
 * Says the effect in the words of what it does rather than its name, because
 * "pin" is a word somebody could read as "act on".
 */
export function describeTrigger(trigger: LiveTrigger): string {
  const when = trigger.when.kind === 'event_kind'
    ? `on any ${trigger.when.eventKind} event`
    : trigger.when.kind === 'text_contains'
      ? `when observed text contains "${trigger.when.phrase}"`
      : trigger.when.kind === 'gap_longer_than'
        ? `when capture drops for more than ${String(trigger.when.ms)}ms`
        : `when nothing is observed for ${String(trigger.when.ms)}ms`

  const does = trigger.effect === 'pin'
    ? 'keep the moment'
    : trigger.effect === 'notify'
      ? 'tell you'
      : 'ask for a fresh snapshot'

  return `${when}, ${does}. A trigger never acts on what it sees.`
}
