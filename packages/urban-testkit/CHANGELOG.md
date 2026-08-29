# Changelog

## [1.0.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.15.1...@nanobpm/urban-testkit-1.0.0) (2026-08-29)


### ⚠ BREAKING CHANGES

* **urban-testkit:** `@nanobpm/urban-testkit` no longer rewrites call activities at deploy time and removes `mockChildProcess`/`clearChildProcessMock`. Consumers relying on the unmocked auto-complete must deploy the called process (or the engine raises a recoverable incident); consumers using `mockChildProcess` must deploy a real child process instead.

### Features

* **urban-testkit:** remove deploy-time callActivity rewrite — execute call activities natively ([#513](https://github.com/nanobpm/nano-ide/issues/513)) ([bb7028a](https://github.com/nanobpm/nano-ide/commit/bb7028ab19263eda357b2d38ff70754b172014c6))

## [0.15.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.15.0...@nanobpm/urban-testkit-0.15.1) (2026-08-28)


### Bug Fixes

* **urban:** pin wait-state parity to the deployed JOB|MESSAGE floor ([#499](https://github.com/nanobpm/nano-ide/issues/499)) ([0a92e65](https://github.com/nanobpm/nano-ide/commit/0a92e65a59662a0aa17a6af4e27e8b420f92be44))


### Dependencies

* The following workspace dependencies were updated
  * peerDependencies
    * @nanobpm/urban bumped from >=0.81.0 to >=0.86.1

## [0.15.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.14.0...@nanobpm/urban-testkit-0.15.0) (2026-08-27)


### Features

* **urban:** extend EngineClient seam with incidents, resolve/retry, and setVariables ([#490](https://github.com/nanobpm/nano-ide/issues/490)) ([b7c0d48](https://github.com/nanobpm/nano-ide/commit/b7c0d48a6b81477e7cf68697a566b7db24ff8c96))


### Dependencies

* The following workspace dependencies were updated
  * peerDependencies
    * @nanobpm/urban bumped from >=0.81.0 to >=0.84.0

## [0.14.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.13.1...@nanobpm/urban-testkit-0.14.0) (2026-08-25)


### Features

* **urban:** surface element-instance queries on EngineClient ([#477](https://github.com/nanobpm/nano-ide/issues/477)) ([d80eddb](https://github.com/nanobpm/nano-ide/commit/d80eddb6501fd19724a9a9099eea39558fe91ba4))


### Dependencies

* The following workspace dependencies were updated
  * peerDependencies
    * @nanobpm/urban bumped from >=0.81.0 to >=0.83.0

## [0.13.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.13.0...@nanobpm/urban-testkit-0.13.1) (2026-08-23)


### Dependencies

* **urban-testkit:** bump engine-wasm/engine-testkit/urban ranges and drop duplicate urban dep ([#466](https://github.com/nanobpm/nano-ide/issues/466)) ([bedca06](https://github.com/nanobpm/nano-ide/commit/bedca065c7be9d787480dcb7f8cca13f1cd4681a))

## [0.13.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.16...@nanobpm/urban-testkit-0.13.0) (2026-08-23)


### Features

* **urban:** invert instanceTracking reconciler from writer to source (ADR 0065) ([#462](https://github.com/nanobpm/nano-ide/issues/462)) ([912c16a](https://github.com/nanobpm/nano-ide/commit/912c16a08314d5db43d414398196d0d00a972e56))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.80.0 to >=0.81.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.81.0

## [0.12.16](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.15...@nanobpm/urban-testkit-0.12.16) (2026-08-23)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.79.0 to >=0.80.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.80.0

## [0.12.15](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.14...@nanobpm/urban-testkit-0.12.15) (2026-08-22)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.78.0 to >=0.79.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.79.0

## [0.12.14](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.13...@nanobpm/urban-testkit-0.12.14) (2026-08-22)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.77.4 to >=0.78.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.78.0

## [0.12.13](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.12...@nanobpm/urban-testkit-0.12.13) (2026-08-22)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.77.3 to >=0.77.4
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.77.4

## [0.12.12](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.11...@nanobpm/urban-testkit-0.12.12) (2026-08-22)


### Bug Fixes

* **urban-testkit:** close() awaits in-flight handlers before free() (use-after-free) ([#447](https://github.com/nanobpm/nano-ide/issues/447)) ([eadca4e](https://github.com/nanobpm/nano-ide/commit/eadca4e8d73b00c2717f0a7523ec38f5d868d29c))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.77.2 to >=0.77.3
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.77.3

## [0.12.11](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.10...@nanobpm/urban-testkit-0.12.11) (2026-08-22)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.77.1 to >=0.77.2
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.77.2

## [0.12.10](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.9...@nanobpm/urban-testkit-0.12.10) (2026-08-22)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.77.0 to >=0.77.1
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.77.1

## [0.12.9](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.8...@nanobpm/urban-testkit-0.12.9) (2026-08-22)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.76.0 to >=0.77.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.77.0

## [0.12.8](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.7...@nanobpm/urban-testkit-0.12.8) (2026-08-22)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.75.1 to >=0.76.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.76.0

## [0.12.7](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.6...@nanobpm/urban-testkit-0.12.7) (2026-08-22)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.75.0 to >=0.75.1
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.75.1

## [0.12.6](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.5...@nanobpm/urban-testkit-0.12.6) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.74.1 to >=0.75.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.75.0

## [0.12.5](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.4...@nanobpm/urban-testkit-0.12.5) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.74.0 to >=0.74.1
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.74.1

## [0.12.4](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.3...@nanobpm/urban-testkit-0.12.4) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.73.0 to >=0.74.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.74.0

## [0.12.3](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.2...@nanobpm/urban-testkit-0.12.3) (2026-08-20)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.72.2 to >=0.73.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.73.0

## [0.12.2](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.1...@nanobpm/urban-testkit-0.12.2) (2026-08-20)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.72.1 to >=0.72.2
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.72.2

## [0.12.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.12.0...@nanobpm/urban-testkit-0.12.1) (2026-08-20)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.72.0 to >=0.72.1
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.72.1

## [0.12.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.11.4...@nanobpm/urban-testkit-0.12.0) (2026-08-20)


### Features

* **urban:** thread virtual-clock scheduler into mountWorkers + expose an app clock/wait seam ([#409](https://github.com/nanobpm/nano-ide/issues/409)) ([c41b066](https://github.com/nanobpm/nano-ide/commit/c41b066493b18179e00772d8c7861628a3b2448e))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.71.1 to >=0.72.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.72.0

## [0.11.4](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.11.3...@nanobpm/urban-testkit-0.11.4) (2026-08-20)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.71.0 to >=0.71.1
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.71.1

## [0.11.3](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.11.2...@nanobpm/urban-testkit-0.11.3) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.70.0 to >=0.71.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.71.0

## [0.11.2](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.11.1...@nanobpm/urban-testkit-0.11.2) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.69.1 to >=0.70.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.70.0

## [0.11.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.11.0...@nanobpm/urban-testkit-0.11.1) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.69.0 to >=0.69.1
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.69.1

## [0.11.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.10.3...@nanobpm/urban-testkit-0.11.0) (2026-08-19)


### Features

* **urban-testkit:** adopt engine-wasm 0.7.0 and derive read-model DTOs from readmodel-types ([#383](https://github.com/nanobpm/nano-ide/issues/383)) ([2534245](https://github.com/nanobpm/nano-ide/commit/25342459c3b942a7cc7dfee85e21fd2da257d1fb))

## [0.10.3](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.10.2...@nanobpm/urban-testkit-0.10.3) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.68.1 to >=0.69.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.69.0

## [0.10.2](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.10.1...@nanobpm/urban-testkit-0.10.2) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.68.0 to >=0.68.1
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.68.1

## [0.10.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.10.0...@nanobpm/urban-testkit-0.10.1) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.67.0 to >=0.68.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.68.0

## [0.10.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.9.0...@nanobpm/urban-testkit-0.10.0) (2026-08-19)


### Features

* **urban-testkit:** add AI-judge & semantic-similarity assertions (opt-in, deterministic-by-default) ([#369](https://github.com/nanobpm/nano-ide/issues/369)) ([1670b43](https://github.com/nanobpm/nano-ide/commit/1670b43fc53b7e4471dfcec6443125b30f8e897a))

## [0.9.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.8.8...@nanobpm/urban-testkit-0.9.0) (2026-08-19)


### Features

* **urban-testkit:** first-class worker & child-process mocking ([#368](https://github.com/nanobpm/nano-ide/issues/368)) ([7d92083](https://github.com/nanobpm/nano-ide/commit/7d92083ab82116d360e039f02601b4bbd5166d05))

## [0.8.8](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.8.7...@nanobpm/urban-testkit-0.8.8) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.66.2 to >=0.67.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.67.0

## [0.8.7](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.8.6...@nanobpm/urban-testkit-0.8.7) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.66.1 to >=0.66.2
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.66.2

## [0.8.6](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.8.5...@nanobpm/urban-testkit-0.8.6) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.66.0 to >=0.66.1
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.66.1

## [0.8.5](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.8.4...@nanobpm/urban-testkit-0.8.5) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.65.0 to >=0.66.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.66.0

## [0.8.4](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.8.3...@nanobpm/urban-testkit-0.8.4) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.64.0 to >=0.65.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.65.0

## [0.8.3](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.8.2...@nanobpm/urban-testkit-0.8.3) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.63.1 to >=0.64.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.64.0

## [0.8.2](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.8.1...@nanobpm/urban-testkit-0.8.2) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.63.0 to >=0.63.1
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.63.1

## [0.8.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.8.0...@nanobpm/urban-testkit-0.8.1) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.62.0 to >=0.63.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.63.0

## [0.8.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.7.2...@nanobpm/urban-testkit-0.8.0) (2026-08-19)


### Features

* **urban-testkit:** guard the fake against the full EngineClient surface ([#343](https://github.com/nanobpm/nano-ide/issues/343)) ([a2e57e9](https://github.com/nanobpm/nano-ide/commit/a2e57e92ac0db07f670e96ca8966bd6ea2e4342d))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.61.0 to >=0.62.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.62.0

## [0.7.2](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.7.1...@nanobpm/urban-testkit-0.7.2) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.60.0 to >=0.61.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.61.0

## [0.7.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.7.0...@nanobpm/urban-testkit-0.7.1) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.59.0 to >=0.60.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.60.0

## [0.7.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.6.4...@nanobpm/urban-testkit-0.7.0) (2026-08-19)


### Features

* test dsl ([#326](https://github.com/nanobpm/nano-ide/issues/326)) ([21d02d7](https://github.com/nanobpm/nano-ide/commit/21d02d7d7b0337003921dc6c1b81b19da450457c))

## [0.6.4](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.6.3...@nanobpm/urban-testkit-0.6.4) (2026-08-19)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.58.0 to >=0.59.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.59.0

## [0.6.3](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.6.2...@nanobpm/urban-testkit-0.6.3) (2026-08-18)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.57.0 to >=0.58.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.58.0

## [0.6.2](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.6.1...@nanobpm/urban-testkit-0.6.2) (2026-08-18)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.56.0 to >=0.57.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.57.0

## [0.6.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.6.0...@nanobpm/urban-testkit-0.6.1) (2026-08-18)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.55.0 to >=0.56.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.56.0

## [0.6.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit-0.5.1...@nanobpm/urban-testkit-0.6.0) (2026-08-18)


### Features

* **urban-testkit:** back WasmEngineClient reads with the real read model ([#288](https://github.com/nanobpm/nano-ide/issues/288)) ([c098913](https://github.com/nanobpm/nano-ide/commit/c098913b750a7f3a5740dd389994e5b7ad8b17e8))

## [0.5.1](https://github.com/nanobpm/nano-ide/compare/@nanobpm/urban-testkit@0.5.0...@nanobpm/urban-testkit-0.5.1) (2026-08-17)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.55.0
  * peerDependencies
    * @nanobpm/urban bumped from >=0.50.0 to >=0.55.0
