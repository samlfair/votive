# Votive

A file processor. Votive watches a folder of sources, hands each one to
a plugin, and writes what comes back into a target folder — rebuilding
only what changed, because it remembers what every output depended on.
It ships a dev server with live reload, and it is what
[Vowel](https://github.com/samlfair/vowel) is built on.

```js
import votive from "votive"

const site = await votive({ sourceFolder, targetFolder, plugins })
await site.build()
await site.close()
```

## Five concepts

- **Source** — a file under `sourceFolder`, or a *stub*: a source a
  plugin declares rather than the author writes (a tag index, a
  sitemap). A source is read by the processor that claims its
  extension.
- **Target** — one output file, with `data` (its content) and
  `metadata`. A source routes to at most one target; a source that
  routes nowhere has none.
- **Folder** — the scope of a *setting*. A setting written for
  `blog/` cascades to everything beneath it; a plugin resolves a label
  through `settings.last()`, `settings.flat()` or `settings.raw()`.
- **URL** — something a plugin asked for with `api.url()`. Fetched
  after the build, parsed by a `readURL` hook, kept in a project-owned
  store, and never refetched until the entry is deleted.
- **Dependency** — recorded the moment a hook *reads* a target
  property, a folder listing, a setting or a URL. When that thing
  changes, every target that read it is marked stale and rewritten.
  Nothing is a dependency until something asked.

## A plugin

A plugin is a list of processors. A processor owns some extensions and
says how a source of those becomes a target:

```js
export default {
  name: "text",
  processors: [{
    extensions: [".txt"],
    router: ({ dir, name }) => `${dir}/${name}.html`,
    readFile: (source) => ({
      data: source.text,
      metadata: { title: source.text.split("\n")[0] }
    }),
    writeFile: (target, { api }) => {
      const others = api.targets({ folder: "" })   // tracked: a new .txt stales this page
      return { data: `<h1>${target.metadata.title}</h1><p>${others.length} pages</p>` }
    }
  }]
}
```

`readFile` parses; `writeFile` renders. Between them `transformFile`
may rewrite `data`/`metadata` once every target exists, and
`createStubs`/`expandStubs` declare and produce synthetic sources. The
whole contract — every hook, what it receives and what it may return —
is the typedef block at the top of `lib/bundle.js`.

## Reading further

- [`DATA_FLOW.md`](./DATA_FLOW.md) — the build, stage by stage.
- `startServer` (`lib/serve.js`) — the dev server: watcher, live
  reload, the loopback-only write endpoint and plugin commands.
