# Accepted client catalog contract fixture

Logic comes from client archive PR #54, accepted head
`2c6dc171e6c7786ef5469009f593f9fa48a952e5`:

- `src/archive/catalog.js`, Git blob `7d64cd1f48ad582ed9d880896ffbbd0daf68d575`.
- `src/archive/dates.js`, Git blob `91ab7ee2285f683d400d2b87e0aad9b8843c224d`.

Only catalog's extensionless `./dates` import is changed to `./dates.js` for native
Node ESM. A test reverses that one specifier and checks the original Git blob hash;
the date module is byte-identical. No React runtime or client dependency is added
to the server. This fixture validates real default-app responses and old-server
404 classification. It does not certify browser rendering or the future combined
client tree. The actual pinned client's Jest tests are also run separately.

The old client request/response smoke follows the existing v1 MazePage/ResultsPage
contract at `ea952aa6b1eafed45143607753210abf23f60867`. Its MazePage blob is
`96a537469b0a2bedd8a989942b936126b04e0f99`, unchanged on reported client main
`afece64170a46d01c0c4123f4ffd9084d4f671db`. Server tests exercise registration,
login, profile selection, the original start body, complete UUID retries and daily
array shape; no production client or backend is contacted.
