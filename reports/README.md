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

Generator errors: 412 rejected reachability checks, 7 failures to find sufficiently distant endpoints, and 9 null-marker dereferences. These are single synthetic generation invocations, not the failure rate of the production seeder after its outer retries. No production data was consulted. These retained legacy results do not include the new daily engine fixes; see [the daily contract](../docs/deterministic-daily-maze.md). To reproduce a successful grid use `--seed sprint4-0`; to reproduce a generator rejection use `--seed sprint4-42`.

The refreshed Sprint 1.7A 10,000-seed performance run (`performance.json`) completed in 1.904 seconds with a 64 MiB V8 heap limit. OS peak RSS was 55,936 KiB; final heap use was 9,836,672 bytes. Maximum discovered states per grid remained 281; it solved 5,706 mazes and recorded 4,294 generator errors. Measurements are host/load dependent and do not establish performance for large custom grids. The earlier VM run took 26.807 seconds and used 201,580 KiB RSS; the extraction removes VM overhead, but these two measurements are not a controlled performance experiment.

`generatorHash` now hashes the extracted candidate and RNG source, while `legacySourceHash` retains the original seeder hash. `algorithmVersion` explicitly identifies `legacy-analyzer-v1`. Only sample provenance changed: all deterministic counts, flagged seeds, rejection messages and solution metrics match the pre-extraction report. The daily engine has separate versioned fixtures.

Validation on Node v24.19.0: `npm test` passed, and the detailed analyzer run passed all 13 named tests, including the 5,000-seed 64 MiB subprocess regression. Replayed the 1,000-seed sample and matched its summary and flagged-seed count. All existing production JavaScript and new JavaScript passed `node --check`; `git diff --check` passed. There is no server production build script or compilation step. The unchanged production generator hash is retained as `legacySourceHash` in both reports. Those original Sprint 4 checks did not start an API/database/seeder process. Current Sprint 1.7A full-suite checks use disposable synthetic MongoDB processes; see the current validation evidence.

The analyzer has no dependency on Sprint 3's completion API branch. Both add `test: node --test` in root package scripts; retain the union of scripts/tests when integrating. No other production-file overlap was found.
