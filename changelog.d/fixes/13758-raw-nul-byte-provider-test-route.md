Replaced the raw control bytes that #13758 left inside the `sanitizeUpstreamBodyText`
character class in `src/app/api/providers/[id]/test/route.ts` with their `\x00-\x1f`
escapes. The range was byte-identical at runtime, but the literal NUL in the source broke
`tests/unit/source-no-raw-nul-bytes.test.ts` — which fails the `Unit Tests fast-path (1/4)`
shard on every open pull request against `release/v3.8.51`.
