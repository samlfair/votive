# Votive's data flow

Votive builds a site in stages. Each stage reads what the last stage wrote.

1. Scan sources
2. Read changed files
3. Enumerate stubs
4. Create or update targets
5. Stale dependents
6. Transform targets
7. Defer buffers and URLs
8. Write stale targets
9. Save the database
10. Run deferred work, then repeat from step 3

Steps 1 through 8 run inside one database transaction; step 9 is
outside it.

## 1. Scan sources

Votive reads every file under the source folder. It skips hidden files
and the target folder. A build given `{changed, deleted}` skips the
scan and stats only the named files; the first build after startup is
always a full scan.

## 2. Read changed files

For each file, Votive checks its modified time against the time it
recorded last run. If the file has not changed, Votive skips it.

If the file has changed, the matching processor's `readFile` (or
`readBuffer`) reads it and returns any of `data`, `metadata`, `settings`
and `write`, every key optional. `data` is the target's content — for a
text target, the text it is made from. A copy-through target such as an
image or a font has no `data`; its bytes come from `target.buffer()`.
`settings` are recorded against the folder the target lands in and
cascade to everything beneath it.

**An abstract is a metadata convention, not a Votive concept.** A plugin
may keep a parsed form of the file under a namespaced metadata key —
`metadata.hastAbstract` is the name Vowel uses for a Hast tree — as a
convenience. Votive neither creates nor validates one, because its
structure is defined by the plugin and unknowable here.

**A consumer unsure of an abstract's structure should read `data`.** If
the expected abstract key is absent, parse `data`. And **a plugin that
changes one must keep the other in sync** — the duplication is accepted
deliberately, and nothing enforces it.

## 3. Enumerate stubs

A stub is a source a plugin declares rather than the author writes: a
tag index, a sitemap, a default 404, a generated stylesheet. Every
processor's `createStubs` runs on every pass — after the files, so it
sees this pass's settings, and outside the "anything changed?" gate, so
the follow-up build after deferred work still enumerates. It returns
`{path, params}` pairs; a stub whose `params` string changed, or that is
new, is produced by `expandStubs` and then read exactly like a file
(step 2). One whose params are unchanged is skipped. One no longer
declared is deleted with its target. A real file at a stub's path wins
over the stub.

## 4. Create or update targets

A target is one row in Votive's database, holding one output file's
`data` and metadata. Votive does not overwrite this row blindly. It
compares the new metadata to the old, field by field, and writes only
the fields that changed. A target with no changes is left untouched.

## 5. Stale dependents

A dependency is a record that one thing depends on one property of
another. Votive creates this record the moment a plugin reads that
property — not before. Nothing is a dependency until something has
actually asked for it.

When a field changes in step 4, Votive looks up everything that depends
on that field and marks it stale, so it gets rebuilt in step 8.

A dependency can point at:
- one target's one property
- a folder, or a folder and everything under it (for plugins that list
  many targets at once), including the labels a listing filtered on
- a folder's setting
- a URL (for plugins that fetch one)

## 6. Transform targets

Every matching processor's `transformFile` runs over the stored target,
in sequence — several transformers registered for one extension all
apply, each seeing the previous one's output. A transformer may rewrite
`data` or `metadata`. It runs once every target from this pass exists,
so it is where cross-page resolution belongs.

## 7. Defer buffers and URLs

Large files (images, video) and remote URLs are not read here. Reading
them now would block the whole build on one slow file. Instead, Votive
collects them for later: buffer sources go to `readBuffer` on the next
tick, and every url a hook asked for through `api.url()` is fetched,
parsed by a `readURL` hook, and filed in the URL store. Nothing is
written to the database until that work runs.

## 8. Write stale targets

Votive finds every target still marked stale and asks the matching
processor to write it. The `writeFile` hook reads the target's stored
`data` and metadata and returns the finished output. Votive saves that
output to disk, **stores it back on the target as its `data`**, and
marks the target fresh.

That write-back is why a page's `data` is its rendered HTML after the
first write rather than the Markdown it started as. It is what gives the
dev server's live-reload message a body without reading the file back
off disk. A `writeFile` must not assume `data` is still its input
format.

## 9. Save the database

An on-disk database is already saved (WAL, one transaction per build).
An in-memory one is backed up to disk here so the next run can skip
unchanged files again.

## 10. Run deferred work, then repeat from step 3

`build()` returns `{deferred}`: a promise that resolves once the
buffers and fetches have run *and* the follow-up build has finished.
That follow-up marks whatever the deferred work touched stale, then
runs the pipeline again from stub enumeration. This is the only way a
deferred result reaches the output; running the work and seeing it
written are one action, not two the caller must remember to chain.
