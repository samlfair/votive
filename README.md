# Votive

*File processor*

- Powers [Voot](https://github.com/samlfair/voot)
- Bundles [Vowel](https://github.com/samlfair/vowel)

## Roadmap

- [ ] Flesh out job runners
- [ ] Rename jobs and paths
- [ ] Better dependency tracking
- [ ] Better query filters
- [x] File deletion handling

## Project: Jobs

Jobs was originally a generic concept, but after working it's clear that there are two main categories of jobs: async writes and data fetching. We can probably handle async writes with inbuilt logic. So, instead of a "job", we should have "read uri"? That way we can cache all the uris.