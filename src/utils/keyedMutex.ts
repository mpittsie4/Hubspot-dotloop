/**
 * Serializes async callbacks that share a key, within this process.
 *
 * Why this exists: every sync entry point in syncEngine.ts follows a
 * check-then-act pattern -- look up this record's mapping, and if none
 * exists yet, create a brand new record on the other side (see
 * syncLoopFromDotloop / syncDealFromHubSpot / syncContactFrom* in
 * dealLoopSync.ts and contactSync.ts). Dotloop (and HubSpot) can deliver
 * more than one event for the same record close together -- e.g.
 * LOOP_CREATED followed almost immediately by LOOP_UPDATED, or several
 * LOOP_PARTICIPANT_UPDATED events from one "save" in the Dotloop UI --
 * and the webhook handlers fire these off with `void queueXFromY(...)`
 * (fire-and-forget, never awaited -- see dotloopWebhook.ts's comment on
 * why: Dotloop needs a response within 5 seconds, so verification and
 * queuing happen synchronously but the actual sync work does not). Two
 * such calls for the same loop/deal/contact can then run concurrently,
 * both see "no mapping yet" before either has written one, and both
 * create a duplicate record on the other side -- confirmed live on
 * 2026-09-16 (Mason: updating a Dotloop loop shortly after creating it
 * produced two HubSpot deals for one loop). object_mappings' unique
 * constraint on (tenant_id, entity_type, dotloop_id) stops the second
 * mapping *row* from being written, but by then the duplicate remote
 * record has already been created via the API -- a caught DB error
 * can't undo that API call after the fact.
 *
 * withKeyedLock serializes same-key work so a second call's mapping
 * lookup always runs after the first call's mapping write has landed,
 * closing the race at its source instead of cleaning up afterward.
 *
 * This only serializes within a single process/instance. Fine today --
 * the connector runs as a single Render "Starter" instance (see
 * dashboard.render.com service settings) -- but if this connector is
 * ever scaled to more than one instance, this needs to become a
 * Postgres advisory lock (pg_advisory_xact_lock, keyed the same way)
 * instead, since an in-memory map can't coordinate across processes.
 */
const tails = new Map<string, Promise<void>>();

export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = tails.get(key) ?? Promise.resolve();
  const result = tail.then(fn);
  // Track completion (success or failure) so the next caller for this key
  // waits for this one to finish either way -- a rejection must not let
  // later callers race ahead as if nothing were in flight.
  const nextTail = result.then(
    () => undefined,
    () => undefined
  );
  tails.set(key, nextTail);
  nextTail.finally(() => {
    // Only clean up if no newer call has replaced our entry in the
    // meantime -- avoids the map growing unbounded over the process
    // lifetime once a key goes quiet.
    if (tails.get(key) === nextTail) tails.delete(key);
  });
  return result;
}
