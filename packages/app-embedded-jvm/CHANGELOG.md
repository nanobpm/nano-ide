# Changelog

## [1.3.0](https://github.com/nanobpm/nano-ide/compare/@nanobpm/nano-ide-app-embedded-jvm-1.2.1...@nanobpm/nano-ide-app-embedded-jvm-1.3.0) (2026-09-01)


### Features

* **app-embedded-{jvm,graalvm-native}:** use stock Camunda REST on outer path ([fad81bb](https://github.com/nanobpm/nano-ide/commit/fad81bb321fad7b3541c63bbca78c1210e2326db))
* **app-embedded-{jvm,graalvm-native}:** use stock Camunda REST on outer path (1.1.0) ([5a5ea75](https://github.com/nanobpm/nano-ide/commit/5a5ea7582231717db98dc2c9e128731deb54c064))
* **kyc:** split KycMicroservice into OuterKycService + InnerKycService ([9023718](https://github.com/nanobpm/nano-ide/commit/90237184f1ecc4b83e30578d0197d250475f7e6f))
* **kyc:** split KycMicroservice into OuterKycService + InnerKycService ([c513724](https://github.com/nanobpm/nano-ide/commit/c51372473c8cb23fb9df48b3af1967494d97a274))
* **manifests:** split template labels into title + description for card view ([#42](https://github.com/nanobpm/nano-ide/issues/42)) ([d2b61f8](https://github.com/nanobpm/nano-ide/commit/d2b61f89cc2d03f2743de2f6ffb613c2c11432e8))


### Bug Fixes

* **app-embedded-jvm,app-embedded-graalvm-native:** pin camunda-client-java-falcon to released 1.1.0 ([1e29864](https://github.com/nanobpm/nano-ide/commit/1e29864ce808f260113957d4ccbaba3e8088e1f2))
* **app-embedded-jvm:** prefix Run toolchain with 'compile' ([c0c6eb5](https://github.com/nanobpm/nano-ide/commit/c0c6eb59a03912451138f900a3aae15011e2a6b0))
* **app-embedded-jvm:** Run must compile first (exec:java doesn't build) ([7650e2a](https://github.com/nanobpm/nano-ide/commit/7650e2a0c22418377e8357af0bf8988e1392549f))
* **embedded-jvm/graalvm:** pin camunda-client-java-falcon to released 1.1.0 ([44f1ef8](https://github.com/nanobpm/nano-ide/commit/44f1ef897dfc71c5c16dc35951dc7a0f7f3e37bf))
* Java app packs must declare requires — new projects fell back to Deno ([c09605e](https://github.com/nanobpm/nano-ide/commit/c09605ed1046633ef47f7892a14dd16a8cf40306))
* **packaging:** eliminate npm publish auto-correct warnings ([#60](https://github.com/nanobpm/nano-ide/issues/60)) ([6b4de3a](https://github.com/nanobpm/nano-ide/commit/6b4de3af109ca8d508069f34d264b47250196f7b))
* **templates:** add BPMN DI so template models render in the modeler ([67d3b77](https://github.com/nanobpm/nano-ide/commit/67d3b775e523b93e333d4bfcb513e5bcd1562024))
* **templates:** add BPMN DI to template BPMN files ([a972908](https://github.com/nanobpm/nano-ide/commit/a972908cfc98691a268ce456ed0d8f6f70059956))
