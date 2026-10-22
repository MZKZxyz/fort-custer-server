# Sprint 4 sample findings

Reproduce the raw report with:

```sh
node tools/maze-analyzer/cli.js --batch 1000 --prefix sprint4 > /tmp/sprint4.json
```

The committed compact report retains every flagged seed. For `sprint4-0` through `sprint4-999`:

| Measurement | Result |
| --- | ---: |
| Solved generated grids | 572 |
| Generator/validation errors | 428 |
| Proven unsolvable valid grids | 0 |
| Search limits | 0 |
| Inaccessible pickup flags | 33 |
| Short solutions (24 inputs) | 13 |
| Long solution flags / difficulty outliers | 0 / 0 |
| Minimum / mean / maximum solution inputs | 24 / 46.233 / 126 |

Generator errors: 412 rejected reachability checks, 7 failures to find sufficiently distant endpoints, and 9 null-marker dereferences. These are single synthetic generation invocations, not the failure rate of the production seeder after its outer retries. No production data was consulted. No generator fix is included. To reproduce a successful grid use `--seed sprint4-0`; to reproduce a generator rejection use `--seed sprint4-42`.

The 10,000-seed performance run (`performance.json`) completed in 26.807 seconds, approximately 373 seeds/second, with a 64 MiB V8 heap limit. OS peak RSS was 201,580 KiB (about 197 MiB); final heap use was 16,921,648 bytes. Maximum discovered states per grid was 281. It solved 5,706 mazes and recorded 4,294 generator errors. RSS includes VM/runtime memory beyond the V8 heap. Measurements are host/load dependent; automated tests were also running on the shared host. These numbers do not establish performance for large custom grids with exponential item/fire state spaces.

Validation on Node v24.19.0: `npm test` passed, and the detailed analyzer run passed all 13 named tests, including the 5,000-seed 64 MiB subprocess regression. Replayed the 1,000-seed sample and matched its summary and flagged-seed count. All existing production JavaScript and new JavaScript passed `node --check`; `git diff --check` passed. There is no server production build script or compilation step. The unchanged production generator hash is recorded in both reports. No API/database/seeder process was started by this work.

The analyzer has no dependency on Sprint 3's completion API branch. Both add `test: node --test` in root package scripts; retain the union of scripts/tests when integrating. No other production-file overlap was found.
