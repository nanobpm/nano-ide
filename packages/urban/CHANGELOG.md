# Changelog

## [0.92.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.92.0...@nanobpm/urban-0.92.1) (2026-09-04)


### Bug Fixes

* **urban:** read engine truth in urban_debug_instance_state ([#561](https://github.com/nanobpm/nano-ide/issues/561)) ([87b30c2](https://github.com/nanobpm/nano-ide/commit/87b30c2a4fb0105bbb454fca9d727f0a23f13faa)), closes [#560](https://github.com/nanobpm/nano-ide/issues/560)

## [0.92.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.91.0...@nanobpm/urban-0.92.0) (2026-09-04)


### Features

* **urban:** re-extend wait-state emulation to USER_TASK now nbpm[#1042](https://github.com/nanobpm/nano-ide/issues/1042) shipped ([#555](https://github.com/nanobpm/nano-ide/issues/555)) ([7e9136b](https://github.com/nanobpm/nano-ide/commit/7e9136b87506af18573731762a47827e6a46e090))

## [0.91.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.90.2...@nanobpm/urban-0.91.0) (2026-09-04)


### Features

* **urban:** add optional completePath to detail.engineForm ([#553](https://github.com/nanobpm/nano-ide/issues/553)) ([3e47671](https://github.com/nanobpm/nano-ide/commit/3e476711fee747143d059e8cb4739102f9b991f5))

## [0.90.2](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.90.1...@nanobpm/urban-0.90.2) (2026-09-04)


### Bug Fixes

* **urban:** drain stdio before process.exit so large `urban data` replies aren't truncated ([#550](https://github.com/nanobpm/nano-ide/issues/550)) ([de3d07c](https://github.com/nanobpm/nano-ide/commit/de3d07c81e3d05bd137705945bc4cdd1b5ec0f90))

## [0.90.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.90.0...@nanobpm/urban-0.90.1) (2026-09-01)


### Bug Fixes

* **urban/mcp:** return 404 (not 400) for an unknown/stale mcp-session-id so clients auto-reconnect after a restart ([#539](https://github.com/nanobpm/nano-ide/issues/539)) ([3d0a5b3](https://github.com/nanobpm/nano-ide/commit/3d0a5b31df7e832c0f852a86ccc9746461bc9bbd))

## [0.90.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.89.0...@nanobpm/urban-0.90.0) (2026-08-31)


### Features

* **urban:** surface parent/root process-instance keys on the typed EngineClient seam ([#533](https://github.com/nanobpm/nano-ide/issues/533)) ([95943de](https://github.com/nanobpm/nano-ide/commit/95943de4208350263a0fafd8bfaa9e3da935c6ef))

## [0.89.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.88.1...@nanobpm/urban-0.89.0) (2026-08-31)


### Features

* add urban_debug engine-truth reads for variables, jobs, and process-definition XML ([#529](https://github.com/nanobpm/nano-ide/issues/529)) ([fb6b0e1](https://github.com/nanobpm/nano-ide/commit/fb6b0e1055c126044770873fc6125522d8eafa84))

## [0.88.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.88.0...@nanobpm/urban-0.88.1) (2026-08-31)


### Bug Fixes

* **urban:** relay nested App-View postMessages (host-up + sibling-across bridge) ([#519](https://github.com/nanobpm/nano-ide/issues/519)) ([20b4665](https://github.com/nanobpm/nano-ide/commit/20b46653052a2fbdec086353ca4f6e70b4f71123))
* **urban:** relay nested App-View postMessages (host-up + sibling-across) ([20b4665](https://github.com/nanobpm/nano-ide/commit/20b46653052a2fbdec086353ca4f6e70b4f71123)), closes [#518](https://github.com/nanobpm/nano-ide/issues/518)

## [0.88.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.87.1...@nanobpm/urban-0.88.0) (2026-08-29)


### Features

* **urban:** real-spec MCP projection conformance guard (P2 [#504](https://github.com/nanobpm/nano-ide/issues/504)) ([#509](https://github.com/nanobpm/nano-ide/issues/509)) ([9964785](https://github.com/nanobpm/nano-ide/commit/9964785a058809fa3517dab7272cd6aa7d87aac6))

## [0.87.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.87.0...@nanobpm/urban-0.87.1) (2026-08-29)


### Bug Fixes

* **urban:** faithful object-body MCP tool transport, never double-encode ([#507](https://github.com/nanobpm/nano-ide/issues/507)) ([5df575f](https://github.com/nanobpm/nano-ide/commit/5df575ff107089138dd8bd4e16bb232eceb55bf8))

## [0.87.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.86.1...@nanobpm/urban-0.87.0) (2026-08-29)


### Features

* **urban:** self-contained MCP tool input schemas — resolve component $refs ([#502](https://github.com/nanobpm/nano-ide/issues/502)) ([#505](https://github.com/nanobpm/nano-ide/issues/505)) ([23ea4de](https://github.com/nanobpm/nano-ide/commit/23ea4de7cefe222709ba76cb56ade69c02051d39))

## [0.86.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.86.0...@nanobpm/urban-0.86.1) (2026-08-28)


### Bug Fixes

* **urban:** pin wait-state parity to the deployed JOB|MESSAGE floor ([#499](https://github.com/nanobpm/nano-ide/issues/499)) ([0a92e65](https://github.com/nanobpm/nano-ide/commit/0a92e65a59662a0aa17a6af4e27e8b420f92be44))

## [0.86.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.85.0...@nanobpm/urban-0.86.0) (2026-08-27)


### Features

* **urban:** mutating MCP tools with shared-secret guard, x-mcp exclusion, and CI parity gate ([#494](https://github.com/nanobpm/nano-ide/issues/494)) ([ea362c6](https://github.com/nanobpm/nano-ide/commit/ea362c6fc0192b8c0b7620c9beaa601993bfceb5))

## [0.85.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.84.0...@nanobpm/urban-0.85.0) (2026-08-27)


### Features

* **urban:** serve a read-only MCP surface at /app/mcp (ADR 0067) ([#491](https://github.com/nanobpm/nano-ide/issues/491)) ([904fb21](https://github.com/nanobpm/nano-ide/commit/904fb21363724c3921893754fed8c6fedaa8ea50))

## [0.84.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.83.0...@nanobpm/urban-0.84.0) (2026-08-27)


### Features

* **urban:** extend EngineClient seam with incidents, resolve/retry, and setVariables ([#490](https://github.com/nanobpm/nano-ide/issues/490)) ([b7c0d48](https://github.com/nanobpm/nano-ide/commit/b7c0d48a6b81477e7cf68697a566b7db24ff8c96))

## [0.83.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.82.1...@nanobpm/urban-0.83.0) (2026-08-25)


### Features

* **urban:** surface element-instance queries on EngineClient ([#477](https://github.com/nanobpm/nano-ide/issues/477)) ([d80eddb](https://github.com/nanobpm/nano-ide/commit/d80eddb6501fd19724a9a9099eea39558fe91ba4))

## [0.82.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.82.0...@nanobpm/urban-0.82.1) (2026-08-24)


### Bug Fixes

* **urban:** emit appView title as an &lt;h2&gt; so collapsible panels don't double-render it ([#472](https://github.com/nanobpm/nano-ide/issues/472)) ([8354b8c](https://github.com/nanobpm/nano-ide/commit/8354b8c0de9b66f02e041db4f5b9877b8896b1e1))

## [0.82.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.81.0...@nanobpm/urban-0.82.0) (2026-08-24)


### Features

* **urban:** add defineRollup GROUP-BY primitive + read-model rollup lookup ([#469](https://github.com/nanobpm/nano-ide/issues/469)) ([d6c6d91](https://github.com/nanobpm/nano-ide/commit/d6c6d91e497602b115017b6e1aaa881764d94cc0))

## [0.81.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.80.0...@nanobpm/urban-0.81.0) (2026-08-23)


### Features

* **urban:** invert instanceTracking reconciler from writer to source (ADR 0065) ([#462](https://github.com/nanobpm/nano-ide/issues/462)) ([912c16a](https://github.com/nanobpm/nano-ide/commit/912c16a08314d5db43d414398196d0d00a972e56))

## [0.80.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.79.0...@nanobpm/urban-0.80.0) (2026-08-23)


### Features

* **urban:** render engine-declared forms in a pages dataGrid detail ([#463](https://github.com/nanobpm/nano-ide/issues/463)) ([cdef0df](https://github.com/nanobpm/nano-ide/commit/cdef0df435209614a0980cba12e79cbdbb235c42))

## [0.79.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.78.0...@nanobpm/urban-0.79.0) (2026-08-22)


### Features

* **urban:** canonical engine-truth projection sidecars — urban_open_user_tasks + urban_instance_state (ADR 0065 [#1](https://github.com/nanobpm/nano-ide/issues/1)) ([#460](https://github.com/nanobpm/nano-ide/issues/460)) ([ddafa47](https://github.com/nanobpm/nano-ide/commit/ddafa471cb939845fc953e0cc4681348c700ac43))

## [0.78.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.77.4...@nanobpm/urban-0.78.0) (2026-08-22)


### Features

* **urban:** defineReadModel — declare-once, compile-to-both derived read models (ADR 0065) ([#455](https://github.com/nanobpm/nano-ide/issues/455)) ([277b162](https://github.com/nanobpm/nano-ide/commit/277b16272eb71a439a7d7648c97141b28e31ec92))

## [0.77.4](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.77.3...@nanobpm/urban-0.77.4) (2026-08-22)


### Bug Fixes

* **create-urban-app:** scaffolded app is lint-green out of the box ([#454](https://github.com/nanobpm/nano-ide/issues/454)) ([945fabf](https://github.com/nanobpm/nano-ide/commit/945fabfafda7acd1dfac5d34c02dbd441e01aa51))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * create-urban-app bumped from ^0.15.1 to ^0.15.2

## [0.77.3](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.77.2...@nanobpm/urban-0.77.3) (2026-08-22)


### Bug Fixes

* **urban-testkit:** close() awaits in-flight handlers before free() (use-after-free) ([#447](https://github.com/nanobpm/nano-ide/issues/447)) ([eadca4e](https://github.com/nanobpm/nano-ide/commit/eadca4e8d73b00c2717f0a7523ec38f5d868d29c))

## [0.77.2](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.77.1...@nanobpm/urban-0.77.2) (2026-08-22)


### Bug Fixes

* **urban:** emit lint-clean nano-generated code; lint it in the scaffold ([#448](https://github.com/nanobpm/nano-ide/issues/448)) ([a19485d](https://github.com/nanobpm/nano-ide/commit/a19485d1730cdf27ae56d4e27c10acf215adb293))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * create-urban-app bumped from ^0.15.0 to ^0.15.1

## [0.77.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.77.0...@nanobpm/urban-0.77.1) (2026-08-22)


### Bug Fixes

* **urban:** serve nested multi-appView sidecars from the pages tree ([#442](https://github.com/nanobpm/nano-ide/issues/442)) ([#443](https://github.com/nanobpm/nano-ide/issues/443)) ([538e864](https://github.com/nanobpm/nano-ide/commit/538e8649c788f6ab358590cdcfa25657c8ccf99f))

## [0.77.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.76.0...@nanobpm/urban-0.77.0) (2026-08-22)


### Features

* **urban:** allow relative same-origin cross-surface nav links ([#437](https://github.com/nanobpm/nano-ide/issues/437)) ([6fd6961](https://github.com/nanobpm/nano-ide/commit/6fd69619e5458254fc04812046695a25ed9101f9))

## [0.76.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.75.1...@nanobpm/urban-0.76.0) (2026-08-22)


### Features

* **urban:** scope taskInbox by assignee / candidateGroup ([#439](https://github.com/nanobpm/nano-ide/issues/439)) ([45e8b6e](https://github.com/nanobpm/nano-ide/commit/45e8b6e70535bdef59b43681ee530ad3b8d17f34))

## [0.75.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.75.0...@nanobpm/urban-0.75.1) (2026-08-22)


### Bug Fixes

* **urban:** repair taskInbox client-script backslash collapse ([#434](https://github.com/nanobpm/nano-ide/issues/434)) ([7095cd0](https://github.com/nanobpm/nano-ide/commit/7095cd0112f090fdcfab215f465eb15772da2de5))

## [0.75.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.74.1...@nanobpm/urban-0.75.0) (2026-08-21)


### Features

* **urban:** let page datasources read SQL VIEWs (schema introspects views, tagged read-only) ([#429](https://github.com/nanobpm/nano-ide/issues/429)) ([917a0ea](https://github.com/nanobpm/nano-ide/commit/917a0ea5b679961eb7aa3c145b4b6b9bbe2960d9))

## [0.74.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.74.0...@nanobpm/urban-0.74.1) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @nanobpm/workflow bumped from ^0.13.1 to ^0.14.0

## [0.74.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.73.0...@nanobpm/urban-0.74.0) (2026-08-21)


### Features

* **urban:** serve appView sidecar + dist assets so the embed iframe 200s in deployed apps ([944aa7c](https://github.com/nanobpm/nano-ide/commit/944aa7c7ab67282cdbd394f8071ce53c89d6de44)), closes [#420](https://github.com/nanobpm/nano-ide/issues/420) [#416](https://github.com/nanobpm/nano-ide/issues/416)
* **urban:** serve appView sidecar + dist assets so the embed iframe 200s in deployed apps (closes [#420](https://github.com/nanobpm/nano-ide/issues/420)) ([#428](https://github.com/nanobpm/nano-ide/issues/428)) ([944aa7c](https://github.com/nanobpm/nano-ide/commit/944aa7c7ab67282cdbd394f8071ce53c89d6de44))

## [0.73.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.72.2...@nanobpm/urban-0.73.0) (2026-08-20)


### Features

* **urban:** add the appView page-node renderer (mount the App View iframe) ([#419](https://github.com/nanobpm/nano-ide/issues/419)) ([57cc8bd](https://github.com/nanobpm/nano-ide/commit/57cc8bd7d67d4b7f5481218f14bace640a385b2e))

## [0.72.2](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.72.1...@nanobpm/urban-0.72.2) (2026-08-20)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @nanobpm/workflow bumped from ^0.13.0 to ^0.13.1

## [0.72.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.72.0...@nanobpm/urban-0.72.1) (2026-08-20)


### Bug Fixes

* **connectors:** fail loud on a job with no processInstanceKey ([3ebe752](https://github.com/nanobpm/nano-ide/commit/3ebe752e61e02d3880158f082e993b047f069cf7))
* **connectors:** fail loud on a job with no processInstanceKey instead of masking to '' ([#413](https://github.com/nanobpm/nano-ide/issues/413)) ([3ebe752](https://github.com/nanobpm/nano-ide/commit/3ebe752e61e02d3880158f082e993b047f069cf7))

## [0.72.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.71.1...@nanobpm/urban-0.72.0) (2026-08-20)


### Features

* **urban:** thread virtual-clock scheduler into mountWorkers + expose an app clock/wait seam ([#409](https://github.com/nanobpm/nano-ide/issues/409)) ([c41b066](https://github.com/nanobpm/nano-ide/commit/c41b066493b18179e00772d8c7861628a3b2448e))

## [0.71.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.71.0...@nanobpm/urban-0.71.1) (2026-08-20)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @nanobpm/workflow bumped from ^0.12.0 to ^0.13.0

## [0.71.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.70.0...@nanobpm/urban-0.71.0) (2026-08-19)


### Features

* **urban:** build-time no-PII gate + layout-aware classification + erasure/immutability docs ([#386](https://github.com/nanobpm/nano-ide/issues/386)) ([1bde841](https://github.com/nanobpm/nano-ide/commit/1bde8417e68c50ffa1548a2403705fb0c73209cd))

## [0.70.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.69.1...@nanobpm/urban-0.70.0) (2026-08-19)


### Features

* **urban/retrieval:** retrieval over the git system-of-record (@nanobpm/urban/context/retrieval) ([#387](https://github.com/nanobpm/nano-ide/issues/387)) ([70a1854](https://github.com/nanobpm/nano-ide/commit/70a18548e44a76707df3be925f6967b50b13b096))

## [0.69.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.69.0...@nanobpm/urban-0.69.1) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * create-urban-app bumped from ^0.14.0 to ^0.15.0

## [0.69.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.68.1...@nanobpm/urban-0.69.0) (2026-08-19)


### Features

* **urban:** git substrate + PR-governance write layer with mandatory PII guard (@nanobpm/urban/context/git) ([#363](https://github.com/nanobpm/nano-ide/issues/363)) ([3c38d01](https://github.com/nanobpm/nano-ide/commit/3c38d01867a29cf568a9ecb83aba7f8ece0d9421))

## [0.68.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.68.0...@nanobpm/urban-0.68.1) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @nanobpm/workflow bumped from ^0.11.0 to ^0.12.0

## [0.68.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.67.0...@nanobpm/urban-0.68.0) (2026-08-19)


### Features

* **urban:** schema-derived multi-field / choice detail.form ([#375](https://github.com/nanobpm/nano-ide/issues/375)) ([be43540](https://github.com/nanobpm/nano-ide/commit/be43540c9e6d96df11b01e8ba586355245ea5182))

## [0.67.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.66.2...@nanobpm/urban-0.67.0) (2026-08-19)


### Features

* **urban:** add PII classifier + mandatory pre-commit guard for @nanobpm/urban/context/pii ([#358](https://github.com/nanobpm/nano-ide/issues/358)) ([f794ec3](https://github.com/nanobpm/nano-ide/commit/f794ec3c64de47b42698615107518b7e69c95e97))

## [0.66.2](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.66.1...@nanobpm/urban-0.66.2) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @nanobpm/workflow bumped from ^0.10.0 to ^0.11.0

## [0.66.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.66.0...@nanobpm/urban-0.66.1) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @nanobpm/workflow bumped from ^0.9.0 to ^0.10.0

## [0.66.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.65.0...@nanobpm/urban-0.66.0) (2026-08-19)


### Features

* **urban:** derive awaiting_operator from open user tasks (onWaitingHuman) ([#356](https://github.com/nanobpm/nano-ide/issues/356)) ([d27c8d8](https://github.com/nanobpm/nano-ide/commit/d27c8d8babd4d58414aa9b476e85bec9f49d8cb4))

## [0.65.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.64.0...@nanobpm/urban-0.65.0) (2026-08-19)


### Features

* **urban:** bindable `context` resource + binding descriptor ([#309](https://github.com/nanobpm/nano-ide/issues/309)) ([c833a02](https://github.com/nanobpm/nano-ide/commit/c833a02cde3bc7f5302070f83d23ec3f8d941991))

## [0.64.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.63.1...@nanobpm/urban-0.64.0) (2026-08-19)


### Features

* **urban:** pipeline locus supports a processExplorer link ([#348](https://github.com/nanobpm/nano-ide/issues/348)) ([7f9fe1a](https://github.com/nanobpm/nano-ide/commit/7f9fe1ab8328c02e5e488640f35ed6710cb330ff))

## [0.63.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.63.0...@nanobpm/urban-0.63.1) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @nanobpm/workflow bumped from ^0.8.0 to ^0.9.0

## [0.63.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.62.0...@nanobpm/urban-0.63.0) (2026-08-19)


### Features

* **urban:** let dataGrid child-grid rows host a detail.form (inline answer/resume) ([#336](https://github.com/nanobpm/nano-ide/issues/336)) ([1abd913](https://github.com/nanobpm/nano-ide/commit/1abd913833c6ffdc779e2fea8490904a6d6a79bf))

## [0.62.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.61.0...@nanobpm/urban-0.62.0) (2026-08-19)


### Features

* **urban-testkit:** guard the fake against the full EngineClient surface ([#343](https://github.com/nanobpm/nano-ide/issues/343)) ([a2e57e9](https://github.com/nanobpm/nano-ide/commit/a2e57e92ac0db07f670e96ca8966bd6ea2e4342d))

## [0.61.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.60.0...@nanobpm/urban-0.61.0) (2026-08-19)


### Features

* **urban:** live count badge on nav items (datasource-bound) ([#342](https://github.com/nanobpm/nano-ide/issues/342)) ([ee99d4f](https://github.com/nanobpm/nano-ide/commit/ee99d4fcbcc0d80f98acc393da62b582c44f7edf))

## [0.60.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.59.0...@nanobpm/urban-0.60.0) (2026-08-19)


### Features

* **urban:** collapsible per-row expansion for dataGrid child grids ([#332](https://github.com/nanobpm/nano-ide/issues/332)) ([#335](https://github.com/nanobpm/nano-ide/issues/335)) ([6b2a37a](https://github.com/nanobpm/nano-ide/commit/6b2a37ac0f6e33269cbf20e9f0604ac2346c668e))

## [0.59.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.58.0...@nanobpm/urban-0.59.0) (2026-08-19)


### Features

* **urban:** col.format="datetime" — render grid timestamps in the viewer's local time ([#329](https://github.com/nanobpm/nano-ide/issues/329)) ([66bfdb7](https://github.com/nanobpm/nano-ide/commit/66bfdb7acb34f151509334251677bbc1b72246d1))
* **urban:** col.format="datetime" renders grid timestamps in the viewer's local time ([66bfdb7](https://github.com/nanobpm/nano-ide/commit/66bfdb7acb34f151509334251677bbc1b72246d1)), closes [#327](https://github.com/nanobpm/nano-ide/issues/327)

## [0.58.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.57.0...@nanobpm/urban-0.58.0) (2026-08-18)


### Features

* **urban:** add S2 memory-record schema, provenance/mode model, and conformance corpus ([#311](https://github.com/nanobpm/nano-ide/issues/311)) ([11d90c1](https://github.com/nanobpm/nano-ide/commit/11d90c15a6cf2a42093a7236f32a9baa67f134ec))

## [0.57.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.56.0...@nanobpm/urban-0.57.0) (2026-08-18)


### Features

* **urban:** scaffold @nanobpm/urban context-layer skeleton (exports, scripts, subdir seams, barrels) ([#306](https://github.com/nanobpm/nano-ide/issues/306)) ([3025ace](https://github.com/nanobpm/nano-ide/commit/3025acedf39eeee6411f5c000b2d02c3a10becd9))

## [0.56.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-0.55.0...@nanobpm/urban-0.56.0) (2026-08-18)


### Features

* **urban:** extract browser runtime from String.raw blob into type-checked source ([#298](https://github.com/nanobpm/nano-ide/issues/298)) ([6800871](https://github.com/nanobpm/nano-ide/commit/6800871fb1fc4a2ff7cc3ac01a7d106d255a2e61))

## [0.55.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban@0.54.0...@nanobpm/urban-0.55.0) (2026-08-17)


### Miscellaneous Chores

* **urban:** trigger release for openUserTasks accessor ([#283](https://github.com/nanobpm/nano-ide/issues/283)) ([#285](https://github.com/nanobpm/nano-ide/issues/285)) ([0416c85](https://github.com/nanobpm/nano-ide/commit/0416c8500e7e3f16a9d4d4a9746f8fd739aa7882))
