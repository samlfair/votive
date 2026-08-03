# Votive

*File processor*

- Powers [Voot](https://github.com/samlfair/voot)
- Bundles [Vowel](https://github.com/samlfair/vowel)

## Roadmap

### Priorities

- [ ] Improve buffer handling
- [ ] Flesh out get-many targets logic
- [ ] Add get-url logic

### More

- [ ] Rename jobs and paths
- [ ] Folders (see spec below)
- [x] File deletion handling

## Project: Folders

Add a `folders` table so folders are first-class entities, like targets. Merge `settings` into `metadata` by adding a `type` column (`target` | `folder`) — a setting is just metadata scoped to a folder instead of a target.

`dependencies` gets its own `type` column: `target | folder | folder_recursive`. A dependency can point at a specific target (as today), at a folder (invalidated by direct children only), or at a folder recursively (invalidated by anything in that folder or its subfolders). No filters for now — depending on a folder means depending on everything in its scope.

This replaces today's `markDescendentsStale("%")` fallback in `source.create`, which invalidates every target in the site whenever a new file is added, because there's currently no way to express "this page list depends on this folder" — only edges between two already-existing targets.

## Project: Jobs

Jobs was originally a generic concept, but after working it's clear that there are two main categories of jobs: async writes and data fetching. We can probably handle async writes with inbuilt logic. So, instead of a "job", we should have "read uri"? That way we can cache all the uris.