# Three ways handlers go wrong

Writing handler tests across the catalog turned up seventeen defects in the first
five apps. They were not seventeen different mistakes. They were three, repeated.

Every one is the same underlying error: **reporting a conclusion the handler did
not actually reach.** A guard that could not check says "safe". A drift detector
that could not look says "in sync". A deploy that half-failed says "nothing to
roll back". In each case the handler is confident about something it does not
know, and the platform believes it.

If you are writing or reviewing a handler, these are the three to look for.

---

## 1. Guards must fail closed

A check that decides whether to do something destructive must treat "I could not
tell" as "do not".

```ts
// WRONG — a 403 or a 5xx reads as "not a system policy", and the DELETE proceeds
async function isSystemPolicy(client, id) {
  const res = await client.request('GET', `/policies/${id}`)
  if (!res.ok) return false
  return parse(res.body)?.system === true
}
```

```ts
// RIGHT — unreadable means "assume protected"
async function isSystemPolicy(client, id) {
  const res = await client.request('GET', `/policies/${id}`)
  if (res.status === 404) return false   // already gone: nothing to protect
  if (!res.ok) return true               // unknown: refuse
  return parse(res.body)?.system === true
}
```

Note the 404. "Gone" is a known answer, not an unknown one — treat it as such, or
your rollback can never clean up after itself.

Ask which direction is recoverable. Leaving an object behind is visible and
removable by hand. Deleting an identity provider's system policy breaks
authentication for a whole organisation and cannot be undone from here. The
asymmetry decides the default.

## 2. Record rollback state BEFORE the risky call, not after

Rollback can only undo what deploy wrote down. If the state is pushed after the
operation, a partial failure leaves nothing to undo.

```ts
// WRONG — the create succeeded, so this object now exists in the vendor with
// no record of it. The next two calls can fail and the entry is never pushed.
const created = await client.request('POST', '/groups', { body })
await reconcileMembers(client, created.id, spec.members)
rollbackState.push({ name: spec.name, existed: false, id: created.id })
```

```ts
// RIGHT — as soon as the object exists, it is recoverable
const created = await client.request('POST', '/groups', { body })
if (!created.ok) throw new Error(...)
rollbackState.push({ name: spec.name, existed: false, id: created.id })
await reconcileMembers(client, created.id, spec.members)
```

Two related traps:

- **Do not throw between the create and the push.** Several handlers validate
  that the response carried an id and throw if not — before recording anything.
  The object exists either way.
- **Return `rollbackData` on the failure path too.** A `catch` that returns
  `{ success: false, message }` and nothing else discards everything deploy had
  captured, including the prior state it read before writing.

For updates, capture the **live prior state** before the write, never the desired
canvas values. Rollback restores what was there, not what you wanted.

## 3. Drift must distinguish "no drift" from "could not look"

`hasDrift: false` is a positive assurance. The platform acts on it: it marks any
outstanding drift record for that component resolved, with
`resolvedAction: 'drift_cleared'`.

So a handler that cannot read the live state must not return a bare
`hasDrift: false` — that is a claim it checked and found nothing, and it will
clear real drift recorded by other means.

```ts
// RIGHT — the vendor exposes no read for this resource
return { hasDrift: false, diffs: [], checked: false }
```

`checked` is optional and absent means checked, so existing handlers are
unaffected. If your comment says *"always reports no drift to avoid false
positives"*, it wants `checked: false`.

The same error runs the other way, and it is worse because somebody acts on it:

```ts
// WRONG — a 500 on this read means "I don't know", not "there are none"
async function listGroups(client, safe) {
  const res = await client.request('GET', `/AccountGroups?Safe=${safe}`)
  if (!res.ok) return []
  return parse(res.body)
}
```

Consumed by drift, that empty array becomes `severity: 'critical', actual:
'missing'` — the handler reports resources as deleted when the vendor merely
returned an error. One app reported the vendor reachable *and* the group missing
in the same run.

A failed read should stop the handler, or mark the result unchecked. It should
never become an empty list that flows into a comparison.

**Drift must also never write.** If you determined the object differs, emit a
diff for it. Two handlers entered the drift branch, emitted zero diffs, and
reported in sync — for a data forwarder repointed at a different storage bucket,
which is exactly the case drift detection exists to catch.

---

## The one-line version

Before returning, ask: **did I actually establish this?**

- A guard that could not read → refuse, do not permit.
- A deploy that got partway → record what exists, then continue.
- A drift check that could not look → `checked: false`, not "in sync".
- A read that failed → stop, do not substitute an empty list.

See [TESTING-HANDLERS.md](TESTING-HANDLERS.md) for how to prove each of these
with a fake vendor, and `node scripts/handler-coverage.mjs <app>` for where your
app stands.
