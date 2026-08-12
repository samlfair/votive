# Current questions

Questions for the present chat exchange.

## Folder lazy-getter

Add a folder lazy-getter to avoid over-invalidation.

## Cache file naming

How much slower is hashing compared to sanitizing/encoding? I recognize that there's a risk of namespace collision with encoding for very long file names.

As an alternative, what about randomUUID? It's not replicable like a hash or an encoded string, but that might not matter if we have the cache ID indexed in the database. It would be faster than hashing and cleaner than encoding.

## URL redirect cache

Yes we should store the user-input URL as the cache key and we should *also* store the post-redirect URL AND the canonical URL, if it exists. When checking the cache for a URL, any one of those three should work.

## URL fetching QoL

- Extract opengraph and twitter card data as JSON
- Fetch oEmbed data if possible
- Implement a timeout
- Implement a size cap, but we should also be specific about what data a plugin is allowed to retrieve from a URL. We don't want to cache images, etc. We only want metadata.

Let's also get the data type. If its text, the plugin can handle it as-is. But if the response type is not text, what do we need to do?

Question: What User-Agent header would help us here?

## URL fetching error handling

We should definitely cache errored URLs with timestamp.

# Tasks

## CLAUDE.md

Summarize my code preferences and add them to this file.

## Asset helpers

For buffer readFiles, we should provide some quality-of-life helpers for reading streams and buffers so that plugin authors don't need to touch the node utilities.

## database.queries.settings.merge()

I don't like the feeling of this function. I'm not sure where its useful. Are we using it anywhere? If so, where? If not, where are we planning to use it? Could we delete it?

## Settings getByFolder()

I don't think I like how we're doing this. It feels overly-elaborate but brittle.

Here's a concept:
- Wrap each setting value in a lazy getter to track accessors
- Make ancestor settings read-only
- Make settings for the current folder writable
- Where a writable setting is a primitive, allow the plugin author to directly update the value by wrapping it in a setter that handles the database logic
- Where a writable setting is an object or array, wrap the value in a Proxy (inside the getter) and use the Proxy to handle mutations to the object/array
- Consider whether this mechanism can handle dynamic typing (can a Plugin author overwrite a number with an array, or vice versa?). If so, add that logic. If not, perhaps throw an error for type changes.

## SQLite getByFolder limit

`getByFolder` should have a limit property.

## Rename `syntax` to `extension`

Target `syntax` is actually the file `extension`. It should say so.

## More explicit syntax/extension definitions

Currently Vowel converts markdown to Hast and then converts Hast to HTML, but the implicit description is converting markdown to HTML. If someone else created an HTML plugin that didn't expect a Hast tree, it would break. How can we handle this?
- Add an intermediate syntax for abstracts (this would break the current readFile/writeFile logic, which relies on a singular "syntax/extension" property)
- Actually convert markdown to HTML and then re-parse the HTML in the transform/write steps, which would slow down the processor slightly
- Something else

## Data flow

Write a short document explaining Votive's data flow. For example, how do targets get created? Do targets get overwritten or selectively updated? What is a dependency?

## Vowel PDF plugin

Write a PDF plugin that only copies the PDF into the output directory.

## Vowel video plugin

Write a plugin that copies videos into the output directory. Consider whether the plugin should perform any optimizations.

Propose logic for how the markdown plugin should handle videos in code, similar to how the plugin handles images.

## Other vowel plugins

Make recommendations for other Vowel plugins that might be helpful, focusing on read-file plugins, but also noting any transformer or write plugins that could be useful.

## Change output to temp dir

Instead of saving `output`, `.cache`, and `.votive` in the project directory, we should save it all to the user's library/cache directory. Scope out this change.

## URL plugins

Propose a plan to read and handle URLs in Vowel.

## Social links

Propose a plan to add social media links to header and footer in Vowel.

## Source maps and stack traces

Write a proposal for source maps and stack traces in Votive, Voot, and Vowel.

## Language

Replace "destination" with "target" everywhere.

We can still say "settings" in Vowel, but we should remove the "settings" concept from Votive. That means changing the structure of the "queries" object.

Remove the "jobs" concept.

Where will these changes cascade into Voot and Vowel?

## Update types

Many types are out of date throughout the three packages. Lets update them.

## Folder metadata structure

Imagine a folder `/blog/travel`. The "metadata" for this folder should look like this:
```
{
  prettyURL: ["/", "/blog", "/blog/travel"],
  breadcrumb: ["Home", "Blog", "Travel"],
  theme: ["Default", null, null],
  accent_color: [null, null, "Blue"]
}
```

Reflect and see if this data structure works. Could it produce any namespace collisions? Is it too restrictive? In past attempts to define this interface I have overlooked edge cases.

How do we handle duplicate metadata properties for a single folder? For instance, stylesheets, where we might want multiple.

## SQLite triggers

Can we outsource any of our logic to SQLite triggers?

## CLAUDE.md

At the bottom of this document, start appending any pertinent information in a new section.

## New primitives

Add `type` column to `dependencies` to differentiate `target`, `folder`, `folder_recursive`, or `url`.

Add `createURL()` and `getURL()`. Track targets that are dependent on URLs.

`settings`  should be merged into `metadata`. Each `metadata` row should have a type of either `target`, `folder`, `folder_recursive`, or `url.

Create a new step in the build process for `fetchURLs`. Fetch the URL and parse the response metadata as a JSON object.


> 1. Is the goal to replace that sledgehammer with real edges — i.e., target.create/delete walks the new/removed target's ancestor folders and stales anything with a folder dep on the immediate parent or a folder_recursive dep on any ancestor?

The new approach will be to track "folder"s and "folder_recursive"s. Instead of "getMany", we will have "getByFolder", which will create the dependency. For now, we will not worry about filters.

> 2. Where do folder-type dependency rows get created? The lazy-getter trick doesn't fit — there's no property access to hook. Should getManyWithTrackers just unconditionally write a folder/folder_recursive row (based on the recursive flag) every time it's called with a dependent?

Yes. Create a row in the dependencies table with `type` set to `folder` or `folder_recursive`. Note that we will also need the staling logic to handle these.

> 3. Should this fully replace the "%" / "${folder}/%" brute-force staling, or coexist with it for now?

Replace.

> 4. For type='url': is the row shaped (destination=<the URL>, dependent=<target path>, type='url'), i.e. keyed by the URL string as destination?

Yes.

> Found a real conflict. settings allows multiple rows per (destination, label) — UNIQUE is (destination,label,value,source) — and that's load-bearing: vowel/plugins/markdown/index.js accumulates several stylesheets settings (reset.css, typography.css, default.css) under one label, and getByFolder returns them grouped as arrays. metadata enforces UNIQUE(destination,label) — one value, replaced via INSERT OR REPLACE, not accumulated. That's exactly the invariant buildFilterQuery.js's filter engine assumes (m.destination = d.path AND m.label = ft.label as an effectively-unique lookup) — the thing we spent this whole conversation optimizing.

Let's enforce a uniqueness on settings akin to how metadata does it. I think that should be fine.

> Also: metadata already has a type column (schema at createDatabase.js:974-981), but it currently stores the JSON value's type (text/integer/array/etc, from json_each.type at :376) — I couldn't find anywhere in the codebase that reads it back. Repurposing it for target/folder/folder_recursive/url looks safe, but it's a replacement of that column's meaning, not an addition.

Instead of `type`, lets call this `class`.


> 9. If metadata needs to hold multiple values per (destination,label) for folder-scoped rows, should the filter engine's matching change (currently implicitly "the value"), or only target-typed rows keep the uniqueness and folder/recursive rows are handled separately?

Only unique to destination, label.

> 10. OK to repurpose the existing (apparently-dead) type column rather than add a new one?

No, lets keep that (and maybe start using it), and add a `class` column.

> 11. Should getByFolder's current shape ({label: {destination: [values]}}) stay as-is for callers, or is this a chance to change it (which means updating the vowel plugin call sites too)?

I think I have explained this.

> 12. Should target-level get/getMany start auto-inheriting ancestor folder/folder_recursive metadata, or does cascading stay opt-in via a getByFolder-equivalent call, like today?

We are reimagining `getMany` as `getByFolder`.

## Buffer handling

Create a system for handling buffers in `readFile`. Parse the data with a file-handling callback from the plugin, but do not cache the data in the database, since these files could be very large. Consider a possible architecture where the buffer parsing occurs outside of the build process, to avoid long builds. Potentially the build process could return all of the read-buffer processes wrapped in a function so that the user can call that voot can run those processes outside of the build.

> 5. Is "add createURL()/getURL()" just promoting the existing url.create/url.get to flat top-level methods (matching what runJobs.js already expects), or a different shape?

No if the logic is already fully written in `url.create`/`url.get`, that's all we need. But the logic needs to exist in the build process, preferably with obvious steps handled automatically (request URL, parse response).

> 6. "Track targets dependent on URLs" — via dependencies rows (type='url', per above), or a column on urls itself?

Via dependencies.

> 7. Do you want runJobs.js re-enabled (uncomment bundle.js's call) as part of this, or does the new fetchURLs step replace it? They look like the same job.

The new `fetchURLs` step can replace it. You can remove `runJobs` and replace references to `jobs` with `urls` and `running` with `fetching` wherever necessary.

> 8. Where does fetchURLs run relative to readSources → readAbstracts/readFolders → writeDestinations? Jobs are already collected (sources.flatMap(s => s.jobs), readAbstracts, readFolders) but nothing consumes them.

readSources -> readAbstracts -> readFolders -> fetchURLs -> writeDestinations

> Also more scaffolded-but-dead than blank slate. readSources.js:153-169's format === "buffer" branch already does exactly what this task says not to do: reads the file, calls processor.readFile synchronously inline, and immediately writes the parsed abstract/metadata into target.create. Meanwhile readBuffers.js — which sounds like the intended real home for this — is a near-verbatim copy-paste of readAbstracts.js (same for readFilePaths.js): neither actually reads a buffer, neither is imported by bundle.js or exported from index.js. They read like stubbed-but-unfinished pipeline stages. workerpool is a declared dependency that's used nowhere yet, which lines up with the "parsing outside the build process" idea.

You can mostly ignore the existing work on this.

> 13. Should the inline buffer handling in readSources.js be removed outright once readBuffers.js is real, or does readSources keep doing a cheap pass (stat/path only) while readBuffers does the actual deferred parse?

Removed.

> 14. "Do not cache the data" — does the parsed result never get persisted (recomputed on demand, e.g. at write time), or is it just the raw bytes that shouldn't be persisted, with parsed metadata still going into metadata/abstract as it does now?

We could potentially cache it on the filesystem. However, in principle we don't need a cache since, usually, these files only need to get processed once. But, for now, lets imagine what a filesystem cache might look like (perhaps a `.cache/` directory).

> 15. The "wrapped in a function so the user can call" handle — is that the existing bundler()/step() return value (what voot/index.js calls queue), or a separate handle returned alongside it?

Separate returned alongside.

> 16. Is worker-thread execution (via the already-present workerpool) actually in scope now, or a documented future direction while this task just gets the deferred-callback architecture right?

For now lets just do deferred callback, unless worker-thread seems important.

> 17. Is there a concrete file type driving this (images? PDFs?) so I can model the plugin callback on something real, the way VotiveProcessorText's readFile works today?

Not really. Images, PDFs, video, audio, zip. Potentially anything.

## SQLite Filters (Done)

Your first task is to flesh out the SQLite target-get-many statement to allow many different filters recursively.

Here's some pseudocode:

```sqlite
WITH
  matches AS (
    SELECT
      m.destination,
      COUNT(*) AS match_count
    FROM
      metadata m
      INNER JOIN json_each('{ "breadcrumb": "Pretty" }') j ON j.key = m.label
      AND (
        j.value = m.value
        OR (
          json_valid(m.value)
          AND (
            (
              json_type(m.value) = 'array'
              AND EXISTS (
                SELECT
                  1
                FROM
                  json_each(m.value)
                WHERE
                  value = j.value
              )
              OR (
                json_type(j.value) = 'object'
                AND EXISTS (
                  SELECT
                    *
                  FROM
                    json.each (j.value)
                )
              )
            )
          )
        )
      )
    GROUP BY
      m.destination
  ),
  filter_count AS (
    SELECT
      COUNT(*) AS total
    FROM
      json_each('{ "breadcrumb": "Pretty" }')
  )
SELECT
  d.*,
  json_group_object(i.label, i.value) AS metadata
FROM
  destinations d
  INNER JOIN metadata i ON d.path = i.destination
  LEFT JOIN matches ON matches.destination = d.path
  CROSS JOIN filter_count f
WHERE
  (
    f.total = 0
    OR matches.match_count = f.total
  );
```

The full logic should allow for a filter like this:

```
{
  "status": "published",    // Exact match
  "deletedAt": null,    // Doesn't have this property
  "views": {
    ">": 1000  // Greater than
  },
  "author": {
        "|": [ // Or
            {
                "country": "Canada" // Property could be nested (author.country) or linked from the author property
            },
            {
                "country: "USA"
            },
            {
                "!": {  // Not
                    "theme": "Summer"
                }
            }
        ]
    }
}
```

All of the logic should be in one or two prepared SQLite statements. You should NOT prepare a new statement for every query. Use conditional and recursive logic in SQLite to make this work. If you can't do this, do not implement by preparing new statements for every query. Instead, explain why this is impossible. Then fact-check yourself, test your assumptions. Then tell me if your assumptions were correct.

# Rules

Note that "destination" is an alias for "target." "target" is the new terminology," and "destination" will eventually be updated everywhere.

# Style

The top priorities are code execution speed, readability, and maintanability. This
codebase should be light, lean, and efficient.

## Flavor

Prefer explicit functional programming.

Prefer const declarations and redeclarations over let declarations and mutations.

Good:
```
const two = 2
const four = two * 2
```

Bad:
```
let number = 2
number *= 2
```

## Declarations

Don't skip variable declarations for brevity. Declare variables before
using them.

Good:
```
const ancestors = folderAncestors(dir)
for (const ancestor of ancestors) {
  prepared.dependency.staleFolderRecursive.all(ancestor, property)
}
```

Bad:
```
for (const ancestor of folderAncestors(dir)) {
  prepared.dependency.staleFolderRecursive.all(ancestor, property)
}
```

## Conditionals

Where appropriate, use early returns instead of if/else.

Good:
```
if(!foo) return
return foo * 2
```

Bad:
```
if(foo) {
  return foo * 2
} else {
  return
}
```

# Pertinent information

Running log of settled decisions and current shape, kept up to date as work lands (per the standing instruction to append here).

## Schema (createDatabase.js)

- `dependencies`: added `type` column (`'target'` default | `'folder'` | `'folder_recursive'` | `'url'`). `destination` is polymorphic based on `type` - a target path, a folder path, or a URL string. `dependency.create` is `INSERT OR REPLACE` (not `IGNORE`), so re-registering with a different type updates it.
- `metadata`: added `class` column (same vocabulary as `dependencies.type`, default `'target'`) and `source` column (default `''`, tracks which source file wrote a folder-scoped row, for cleanup). `type` is unrelated and predates this - it's the JSON value type (text/integer/array/...) captured at write time, currently still unread by anything. Unique on `(destination, label)` regardless of class.
- `settings` table is gone. Folder-scoped settings are `metadata` rows with `class = 'folder_recursive'` - always cascading (matches legacy settings' only behavior; there's no non-cascading `class = 'folder'` settings variant yet, nothing writes one). Uniqueness on `(destination, label)` means settings no longer accumulate multiple values per label per folder (previously multiple stylesheets could stack under one label+destination) - last write wins, by explicit decision.
- `urls`: `url` (PK), `redirect`, `canonical`, `data`, `failedAt`, `failureCount`. One row can be found via any of `url`/`redirect`/`canonical` (`url.get`/`url.getStatus` query `WHERE url = :url OR redirect = :url OR canonical = :url`). A failed fetch is cached too (`data` stays NULL, `failedAt`/`failureCount` set) so it isn't retried every build - see cooldown below.
- `AFTER DELETE ON destinations` trigger (`cleanup_target_rows`) deletes `class='target'` metadata and `type='target'` dependencies for the deleted path. Not a declarative FK: `destination` is polymorphic across folder/url/target rows, and a bare FK constraint can't be conditional on `class`/`type` - it would reject every folder/url-type insert as a violation. `queries.target.delete` reads dependents (`getAllByTarget`) *before* calling the delete, since the trigger removes those rows as part of it.
- All new columns get an `ensureColumn` (PRAGMA table_info + ALTER TABLE ADD COLUMN) migration so an existing on-disk `.votive.db` picks them up.

## Dependency/staling model

- `target.getByFolder({folder, recursive, dependent})` replaces the folder-scoped part of `getManyWithTrackers` - no filter/query support. Writes one `folder`/`folder_recursive` dependency edge for membership, *and* wraps each returned target with the same per-property lazy `dependency.track()` mechanism `getWithTrackers` uses, for content. Net effect: a target appearing/disappearing in scope always stales the dependent (coarse, unavoidable - nothing to have tracked yet); a property changing only stales dependents that actually read that property (fine-grained). `target.create`'s existing-target branch no longer does a blanket "anything changed -> stale everything in this folder" call - that's what made the lazy-getter meaningful.
- Known, accepted limitation shared with the pre-existing `getWithTrackers` mechanism: a metadata key that didn't exist before can't retroactively stale a generic `for...in` iterator that previously had nothing to depend on - not new, not being solved now.
- `settings.create`/`deleteBySource` still use the coarse `staleFolderDependents` unconditionally (settings aren't wrapped in per-property tracking - different mechanism, not a target's own metadata).
- `source.create` no longer does the blanket `markDescendentsStale("%")` sweep - relies entirely on `target.create` having already staled the right things via `staleFolderDependents`, since target.create always runs first in the real call sites (readSources.js, readBuffers.js). `markDescendentsStale` prepared statement removed as dead code.

## fetchURLs.js

- Branches *before* fetching, based on whether a plugin registered `read.url` for the job's syntax - not on content-type (unknowable pre-fetch).
  - No plugin match: runs inline, automatically, as part of the normal build. Fetches with `User-Agent: VotiveBot/1.0` (override via `config.userAgent`) and a timeout (`AbortSignal.timeout`, default 10s, override via `config.urlFetchTimeout`). Non-text `Content-Type` -> header-only metadata (`{contentType, contentLength}`), body never read - this is the "only want metadata, not images" boundary. Text/HTML -> regex-based OpenGraph/Twitter Card extraction, canonical link, one-hop oEmbed discovery+fetch if advertised. Size-capped at 5MB via `Content-Length` (best-effort - doesn't protect against a body with no Content-Length that turns out huge; would need real streaming to close that gap).
  - Plugin match: fully deferred, mirroring `readBuffers.js` - nothing is fetched until the caller invokes the returned `runFetches()`. The plugin gets the raw response via `job.runner` (`response[job.runner]()`, e.g. "text"/"json"/"arrayBuffer") and decides what to do with it, including binary data (e.g. downloading+optimizing an image) - the built-in path never touches this case.
- Non-2xx responses and thrown exceptions both call `database.url.recordFailure`, which upserts `failedAt`/increments `failureCount`. Retry cooldown is exponential: `min(2^(failureCount-1), 8)` days (1/2/4/8, capped). `shouldSkip(status)` is exported from `fetchURLs.js` for testing the cooldown math directly without a server.
- `bundle()` returns `{database, runBuffers, runFetches}` from *calling* `step()` (not as properties on the `step` function itself - that changed, see "Cache staling" below). `readBuffers.js`/`fetchURLs.js` return `runBuffers`/`runFetches` as `null` (not a no-op function) when there's nothing pending - callers must check before calling, not assume a function.
- fetchURLs.js is plugin-only now: the built-in automatic OG/Twitter Card/oEmbed/canonical extraction path (for jobs with no matching plugin) was removed by explicit decision. A job is only ever fetched if some processor registered `read.url` for its syntax; everything else is silently skipped (not fetched, not cached, not failed).

## readBuffers.js

- Cache is hash-only (`sha1(sourceFilePath)` -> `<sourceFolder>/.cache/<hash>.json`), deliberately not a DB-indexed UUID: it needs to work even when `.votive.db` hasn't been persisted yet (bundle.js runs in-memory on a fresh run) - a DB-indexed scheme would orphan the cache in exactly that case.
- Renamed `BufferJob`/`jobs`/`job` -> `BufferTask`/`tasks`/`task` to avoid colliding with the (still-live, not-yet-renamed) `Job`/`Jobs` URL-fetch concept from bundle.js.
- `runBuffers()` uses `p-limit(5)`-bounded concurrency (not full serial, not unbounded) and wraps each task's `run()` in try/catch so one failing plugin doesn't abort the whole batch.
- The redundant `pendingBuffer` flag is gone - `readBuffers.js` filters on `source.readBuffer` truthiness instead (only ever set on the buffer branch in readSources.js).

## Cache staling after deferred work

Two gaps had to be closed to make runBuffers()/runFetches() actually cause a rebuild that reflects their results, not just update the database quietly:

- `queries.url.create` was creating the `type='url'` dependency edge but never marking `destination` stale. A target is normally already written once *before* its URL fetch resolves (fetching is deferred past `writeDestinations`), so without this, the edge existed but nothing ever acted on it - `url.create` now calls `target.markStale(destination)` on success.
- `bundle()` only ran `writeDestinations` inside `if (sources.length)` - so a rebuild triggered after runBuffers()/runFetches() (where no file on disk actually changed) never reached the write phase at all, regardless of what got marked stale. `writeDestinations` already checks `target.getStale()` itself, so it's now called unconditionally on every `bundle()` call instead of being gated behind whether any source files changed.
- `bundler()`'s `step()` now wraps the `runBuffers`/`runFetches` it returns so each one calls `step()` again internally right after finishing its own work (see `wrapRunner` in bundle.js) - running the deferred task and seeing it reflected in written output is one action now, not two the caller has to remember to chain. `null` passes through unwrapped (nothing to chain if there was nothing pending).
- A third gap, found via a real repro in the style-builder repo (a target logged as created, but absent from both the destinations table and the on-disk file when queried directly): `database.saveDB(sources)` also only fired inside `if (sources.length)`, and separately checked `!sources.length` internally too - same class of bug as `writeDestinations` above, just one layer deeper. A target created by `runBuffers()`/`runFetches()` on a pass where no source file changed got written into the in-memory database and even written to the output file, but the in-memory DB was never backed up to `.votive.db` - so a subsequent process (or the next `votive` invocation, which loads from the file) never saw it. `saveDB` now takes a plain `hasChanges` boolean instead of the `sources` array; `bundle()` passes `sources.length > 0 || written > 0`, where `written` is `writeDestinations`'s new return value (count of stale targets it found). Covered by `tests/bundle.js`'s "actually reaches the on-disk .votive.db" test, which reopens a fresh `DatabaseSync` against the file to verify - confirmed this test fails without the fix (checked by temporarily reverting the `saveDB` call site).
- A fourth gap, also found via a real style-builder repro (editing `home.md` never staled `index.html`, and it was missing from `writeDestinations`'s own `getStale()` results): `target.create`'s existing-target branch only ever marked *dependents* stale (via `dependency.getByTargetAndProperty`) when metadata/abstract changed - it never marked the target's own row stale. So a target whose own content changed on disk kept whatever `stale` value it was left at from the previous build (0, since `writeDestinations` calls `markFresh` after writing), and `getStale()` never saw it again on subsequent edits. Fixed by tracking a `changed` flag through the metadata/abstract diff checks and calling `prepared.target.markStale.get(relativePath)` at the end if anything changed. This is unconditional (not the folder-dependent staling from before, which was deliberately made lazy/fine-grained) - a target always needs to notice its own content changed, independent of who depends on it. Covered by three tests in `tests/dependencies.js` (own-metadata change, own-abstract change, and a no-op re-create that should stay fresh); confirmed the first two fail without the fix.

## Array/object metadata values were coming back as JSON-encoded strings

Root cause, found while investigating the vowel stylesheets regression: `metadata.value` stores arrays/objects as JSON text (e.g. `'["AI","Crypto"]'`), but every read path aggregates rows with `json_group_object`/`json_object`, and those functions treat a TEXT column value as an opaque string unless told otherwise - so `tags` came back as the *string* `"[\"AI\",\"Crypto\"]"`, not a real array, in `target.get`, `target.getAll`, `target.getStale`, both `buildFilterQuery.js` read paths, `target.getByFolder`, and `setting.getByFolder`. Confirmed this was pre-existing and unrelated to the settings work - `target.get` on plain array-valued target metadata had the exact same bug.

Scalars were never affected: numbers/booleans/null are stored as genuine SQLite INTEGER/NULL storage classes (not text) despite the `STRING`-declared column, because "STRING" doesn't match any of SQLite's affinity-triggering substrings (INT/CHAR/CLOB/TEXT/REAL/FLOA/DOUB), so the column actually gets NUMERIC affinity, not TEXT affinity - confirmed empirically, not assumed. Only `array`/`object`-typed values are TEXT under the hood, so only they needed fixing.

Fix: every `json_group_object`/`json_object` call site now wraps the value with `CASE WHEN type IN ('array', 'object') THEN json(value) ELSE value END` instead of passing the raw value, using the `type` column (already recorded at write time) as the discriminator. Six call sites fixed: `target.get`, `target.getAll`, `target.getStale`, `settings.getByFolder` (all in createDatabase.js), and both final SELECTs in buildFilterQuery.js (`buildGetManySQL`/`buildGetManyEmptySQL`). `tests/metadataTypes.js` covers all six read paths plus settings; confirmed each fails without its corresponding fix (checked by reverting one and re-running).

One nuance for settings specifically: an array-valued setting still comes back one level deeper than you might expect - `getByFolder`'s grouping wraps each row's value in an outer per-destination array (its accumulate-multiple-rows mechanism, now less relevant since settings are overwrite-only per `(destination, label)`), so `settings.stylesheets[""]` is `[["reset.css", "typography.css"]]`, not `["reset.css", "typography.css"]` directly - the caller needs `[0]`.

## Deferred for later (explicitly, not forgotten)

- **"Remove the jobs concept" rename** (`Job`/`Jobs` -> something URL-specific, `*Jobs` variables -> `*Urls`, cascades into vowel's plugin return shapes e.g. `vowel/plugins/markdown/index.js`'s `{jobs: [...]}`). Casing convention when this happens: camelCase/PascalCase, acronyms capitalized as a full unit *except* when the acronym is the first word of the identifier (which stays lowercase, standard camelCase first-word rule) - e.g. `sourcesURLs`, `allURLs`, but `urlCache`.
- **"Replace destination with target everywhere."** Votive's public JS API already says "target"; what's left is the SQL layer (`destinations` table, `destination` columns in `dependencies`/`metadata`/`sources`) plus one confirmed external consumer: `voot/index.js` reads `source.destination` directly from a `source.get()` record. Vowel's markdown plugin uses `destination` as its own parameter name extensively (`destination.path`, `destination.metadata`, etc.) - not a contract violation to leave as-is, scope of whether to rewrite that too is still open. `config.sourceFolder`/`config.destinationFolder` are a different concept (build directories) and are explicitly *not* part of this rename.
- **Folder metadata structure**: settled shape is a per-ancestor-level array (index 0 = root, last index = the folder itself), raw/unresolved - e.g. `{theme: ["Default", null, null]}`. Deliberately not resolved to "the effective value" by votive; the plugin author decides per label whether to take the last non-null (override semantics, e.g. theme), flatten all non-null entries (accumulate semantics, e.g. stylesheets), or use the sequence as-is (e.g. breadcrumb). Lives as a separate accessor from a target's own metadata, not merged/flattened into it - avoids any namespace collision between a page's own front-matter and its ancestors' cascaded values.
- **Full JSDoc type audit** across votive/voot/vowel - only fixing types as touched by other work for now, not a dedicated pass.
- ~~**`setting`/`metadata` accumulation helpers**~~ - **superseded, then built properly**: an earlier pass added standalone `setting.push(folder)`/`write(folder)`/`merge(folder)` proxy helpers (single-folder, no read tracking). Once `getByFolder` itself became a live read+write view (below), `push`/`write` became pure duplicates of what `getByFolder(folder)` (dependent omitted) already does, so they were deleted. `merge(folder)` was kept - it does something `getByFolder` doesn't (merge one field into an object value without clobbering the rest).

- **`setting.getByFolder(folder, dependent)` is now a live, lazily-tracked read+write view** - a breaking change to its shape and signature (there were no external (vowel) consumers migrated yet, decided to break it in place rather than add a parallel method). This is the write-side counterpart to `dependency.track()`'s read-tracking getters, applied to folder-scoped settings instead of target properties:
  - **Shape**: reading a label returns an array aligned to `folderAncestors(folder)` (index 0 = root, last index = `folder` itself), each slot the raw value at that level or `null` if unset - e.g. `settings.theme` for `blog/travel` is `[rootValue, blogValue, blogTravelValue]`. Matches the "Folder metadata structure" decision below exactly; nothing here resolves "the effective value" - that's still the plugin author's call per label (last-non-null for override semantics, flatten-non-null for accumulate, or use the sequence as-is).
  - **Read tracking, per ancestor level**: each numeric index has its own lazy getter (built with `Object.defineProperty` on a real array, not a `Proxy`, so `.map()`/`for...of`/spreading/`JSON.stringify` all work unmodified and naturally track every index they touch) - registers `(destination=<that ancestor>, property=<label>, dependent, type='folder')`. Reading only `settings.theme[0]` does not get stale by a change at `settings.theme[1]`'s folder; reading/iterating the whole array tracks all of them.
  - **This required making `staleFolderDependents` property-exact**, not just folder-exact: it now takes a required `property` param and the `staleFolder`/`staleFolderRecursive` SQL filters on it. Without this, any setting change at a folder would stale every `type='folder'` dependent at that destination regardless of label - including `target.getByFolder`'s membership dependents (property `''`), which have nothing to do with a settings label changing. All 5 call sites updated: `target.getByFolder`'s own registration already used `property=''`; `target.create`/`target.delete`/`source.delete`'s membership-change calls now pass `''` explicitly; `setting.create` passes the label; `setting.deleteBySource` now stales per (destination, label) pair from the deleted rows instead of per destination only.
  - **Writes always target `folder` (the folder this view was built for), never whichever ancestor index was read** - decided explicitly over "let an index-specific write reach into that ancestor's own row", to avoid a leaf-folder's build code silently mutating an ancestor's settings. Two write forms: plain assignment (`settings.theme = "x"`) overwrites `folder`'s row, mirroring `create()`. Calling a mutating array method directly on the returned array (`settings.stylesheets.push("x")`, also `pop`/`shift`/`unshift`/`splice`) is intercepted as own-instance overrides (not `Array.prototype`) that read-modify-write `folder`'s row specifically - upgrading a lone existing scalar into a one-element array first if needed - regardless of which ancestor indices were read beforehand.
  - **A value obtained via indexing is a read-only snapshot** - `settings.stylesheets[0].push(x)` mutates a local plain value and persists nothing; only calling the mutating method on the array itself (not on an indexed element) writes anything.
  - Backed by a new lean `prepared.settings.get` (single folder+label lookup) rather than the old cascading multi-destination query, which is now dead and removed.
  - Tests in `tests/settings.js` (17 cases covering shape, per-ancestor-level tracking, iteration tracking, write-always-targets-own-folder, read-only snapshots, and cross-label non-interference) plus `merge()`'s existing 2. Confirmed the property-exactness fix is load-bearing by reverting it and re-running (threw immediately - a bound-parameter-count mismatch - rather than silently passing).
  - Still not done: the actual vowel-side fix (`vowel/plugins/markdown/index.js`/`vowel/plugins/styles/index.js` switching their repeated `setting.create(folder, "stylesheets", file)` calls to `setting.getByFolder(folder).stylesheets.push(file)`) - not part of this change, still in vowel, untouched.

## getByFolder no longer uses a Proxy - real Object.defineProperty accessors instead

Triggered by finding a debug `console.log({settings})` in `vowel/plugins/markdown/index.js` that always prints `{}`. First fix was `ownKeys`/`getOwnPropertyDescriptor` traps on the existing Proxy (see git history for that iteration) - worked for `Object.keys()`/`for-in`/spread/`JSON.stringify`, but confirmed empirically that plain `console.log(settings)` *still* printed `{}` regardless, because Node's `util.inspect` bypasses Proxy traps entirely by default (`showProxy: false` - inspects the raw target directly, deliberately, to avoid firing side-effecting traps during a debug print). Explicit preference from the user: drop the Proxy altogether and go back to the same `Object.defineProperty(..., {enumerable: true, get() {...}})` pattern already used for the per-ancestor-index values (this file already did that for indices - now the top-level label→array mapping does too). This fixes `console.log` for real: a plain object's own accessor properties are never bypassed the way a Proxy's traps are - `console.log(settings)` now shows `{ title: [Getter/Setter], layout: [Getter/Setter] }` instead of `{}` (confirmed with a real run, not assumed).

That same original vowel call site turned out to be dead code sitting next to a real bug: the plugin's theme/title logic elsewhere in the same file still uses `getByFolder`'s pre-migration shape (`settings.fm_theme?.[""][0]`), which throws against the current ancestor-array shape - not fixed as part of this, still open in vowel.

- `getByFolder(folder, dependent)` now queries `prepared.settings.getLabels` **once** at call time (labels known anywhere in `folderAncestors(folder)`) and `Object.defineProperty`'s one accessor per label onto a plain object - `enumerable: true`, with both `get()` (same lazy per-ancestor-index array as before, unchanged) and `set(value)` (routes to `queries.setting.create(folder, label, value)`, same as before). The object is then `Object.preventExtensions()`-sealed.
- **Real, load-bearing behavior change from the Proxy version, explicitly chosen over keeping dynamic-key support**: a label with no row anywhere in the ancestor chain has no property on the returned object at all - not "returns nulls," genuinely `undefined`. `settings.neverSet.push(x)` throws `TypeError: Cannot read properties of undefined (reading 'push')` (plain JS, no code needed for this). `settings.neverSet = x` used to just work (Proxy's `set` trap accepted any label) - now `preventExtensions` makes that throw too (`Cannot add property neverSet, object is not extensible') instead of silently creating a local, unpersisted own property, which would otherwise have been a real silent-data-loss footgun. User's framing, confirmed twice: writing to a label that was never created should fail loudly, "the same as pushing to an array that doesn't exist" - a decision, not an oversight.
- Reads of a never-set label are also gone as a supported pattern (previously: `settings.theme?.[0]` safely returned `null` for an unset `theme`, and reading it this way still registered a forward dependency so a *future* `setting.create` of that label would correctly stale the reader). There is no way to keep this under `defineProperty` alone - unlike push-on-undefined, plain property access on a name that was never declared has no interception point without a Proxy, so there's no natural throw to lean on either; it's just gone. **What replaces it**: see below - the gap is closed a different way, not preserved.
- **`setting.create(folder, label, value)` now recursively stales folder's whole subtree the first time a label appears anywhere in `folder`'s ancestor chain.** Checked via the same `prepared.settings.getLabels` query, before writing: if `label` isn't already known across `folderAncestors(folder)`, this write is a first appearance, and every existing target under `folder` (itself and all descendants - `dir = :folder OR dir LIKE :recursivePath`, same `[folder, "%"].filter(Boolean).join("/")` idiom `buildFilterQuery.js`/`target.getByFolder` already use for recursive folder scope) gets marked stale unconditionally via the new `staleFolderSubtree` helper (mirrors `staleFolderDependents` but does a coarse path-prefix sweep instead of walking the dependency graph, since by definition nothing could have a dependency edge on a property that didn't exist yet to read). An update to an already-known label is unaffected - still goes through the existing fine-grained `staleFolderDependents` path only. This is *why* dropping unset-label reads is safe: nobody needs to defensively probe-and-track a setting that might get configured later, because its first-ever configuration now force-invalidates everything that could possibly be affected, unconditionally.
- Tests in `tests/settings.js` (23 total, up from 17): all pre-existing push/assignment tests updated to seed their label via `setting.create()` before using property syntax (previously several exercised a genuinely-first-ever write through `getByFolder(...).label.push(...)`, no longer supported); three enumeration tests from the Proxy iteration carried over unchanged (still pass - defineProperty enumerates at least as well as the trap version did); two new tests for the throw-on-unknown-label behavior (push and plain assignment); one new test for the recursive-subtree-stale-on-first-appearance behavior, covering both the coarse first-write sweep and confirming a subsequent update to the now-known label goes back to fine-grained-only staling. Full suite green, 79 tests.