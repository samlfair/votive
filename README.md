# Votive

*File processor*

- Powers [Voot](https://github.com/samlfair/voot)
- Bundles [Vowel](https://github.com/samlfair/vowel)

## Roadmap

- [ ] ReadPaths
- [ ] Flesh out job runners
- [x] Destination query filters
- [x] Setters for metadata
- [ ] Rename jobs and paths

## Project: Jobs

Jobs was originally a generic concept, but after working it's clear that there are two main categories of jobs: async writes and data fetching. We can probably handle async writes with inbuilt logic. So, instead of a "job", we should have "read uri"? That way we can cache all the uris.

## Project: ReadPaths

I don't know what readpaths might be for.

## Chore: Refactor

I can probably clean up the database logic.

## Helpers

- Read
