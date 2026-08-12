# Votive's data flow

Votive builds a site in stages. Each stage reads what the last stage wrote.

1. Scan sources
2. Read changed files
3. Create or update targets
4. Stale dependents
5. Scan abstracts for jobs
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

If the file has changed, the matching plugin's `readFile` function parses
it. `readFile` returns two things: an abstract (a parsed form of the
file — for Markdown, this is a Hast tree) and metadata (front matter and
the like).

## 3. Create or update targets

A target is one row in Votive's database, holding one output file's
abstract and metadata. Votive does not overwrite this row blindly. It
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

## 5. Scan abstracts for jobs

Some plugins scan a target's abstract again here — not to change it, but
to find work for later. An example: finding image or URL references
inside a Markdown document. This work becomes a job, collected for step
7.

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
stored abstract and returns the finished output. Votive saves that
output to disk and marks the target fresh.

## 9. Save the database

Votive saves its database to disk, so the next run can skip unchanged
files again.

## 10. Run deferred work, then repeat from step 8

When the caller runs a deferred buffer or URL task, Votive marks
whatever it touched stale, then writes again — step 8, once more. This
is the only way a deferred task's result reaches the output; running the
task and seeing it written are one action, not two the caller must
remember to chain.
