# Votive's data flow

Votive builds a site in stages. Each stage reads what the last stage wrote.

1. Scan sources
2. Read changed files
3. Create or update targets
4. Stale dependents
5. Transform targets
6. Read folders
7. Defer buffers and URLs
8. Write stale targets
9. Save the database
10. Run deferred work, then repeat from step 8

## 1. Scan sources

Votive reads every file under the source folder, on every run. It skips
hidden files and the destination folder.

## 2. Read changed files

For each file, Votive checks its modified time against the time it
recorded last run. If the file has not changed, Votive skips it.

If the file has changed, the matching plugin's `readFile` function reads
it. `readFile` returns `data` — the target's content, which for a text
target is the text it is made from — and `metadata` (front matter and
the like). A copy-through target such as an image or a font has no
`data`; its bytes come from `target.buffer()`.

**An abstract is a metadata convention, not a Votive concept.** A plugin
may keep a parsed form of the file under a namespaced metadata key —
`metadata.hastAbstract` is the name Vowel uses for a Hast tree — as a
convenience. Votive neither creates nor validates one, because its
structure is defined by the plugin and unknowable here: a Markdown
abstract could be mdast, hast, or something else entirely.

**A consumer unsure of an abstract's structure should read `data`.** If
the expected abstract key is absent, parse `data`. And **a plugin that
changes one must keep the other in sync** — the duplication is accepted
deliberately, and nothing enforces it.

## 3. Create or update targets

A target is one row in Votive's database, holding one output file's
`data` and metadata. Votive does not overwrite this row blindly. It
compares the new metadata to the old, field by field, and writes only
the fields that changed. A target with no changes is left untouched.

## 4. Stale dependents

A dependency is a record that one thing depends on one property of
another. Votive creates this record the moment a plugin reads that
property — not before. Nothing is a dependency until something has
actually asked for it.

When a field changes in step 3, Votive looks up everything that depends
on that field and marks it stale, so it gets rebuilt in step 8.

A dependency can point at:
- one target's one property
- a folder, or a folder and everything under it (for plugins that list
  many targets at once)
- a URL (for plugins that fetch one)

## 5. Transform targets

Every matching plugin's `transformFile` runs over the stored target, in
sequence — several transformers registered for one extension all apply,
each seeing the previous one's output. A transformer may rewrite `data`
or `metadata`, and may also scan for work to do later: finding image or
URL references inside a document, for instance. That work becomes a
deferred task, collected for step 7.

## 6. Read folders

Some plugins build targets from a whole folder at once, not from a
single file — a tag index or a sitemap, for instance.

## 7. Defer buffers and URLs

Large files (images, video) and remote URLs are not read here. Reading
them now would block the whole build on one slow file. Instead, Votive
hands back a deferred task and moves on. Nothing is written to the
database until that task runs.

## 8. Write stale targets

Votive finds every target still marked stale and asks the matching
plugin to write it. The plugin's `writeFile` function reads the target's
stored `data` and metadata and returns the finished output. Votive saves
that output to disk, **stores it back on the target as its `data`**, and
marks the target fresh.

That write-back is why a page's `data` is its rendered HTML after the
first write rather than the Markdown it started as. It is what gives the
dev server's live-reload message a body without reading the file back
off disk. A `writeFile` must not assume `data` is still its input
format.

## 9. Save the database

Votive saves its database to disk, so the next run can skip unchanged
files again.

## 10. Run deferred work, then repeat from step 8

When the caller runs a deferred buffer or URL task, Votive marks
whatever it touched stale, then writes again — step 8, once more. This
is the only way a deferred task's result reaches the output; running the
task and seeing it written are one action, not two the caller must
remember to chain.
