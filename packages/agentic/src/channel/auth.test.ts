import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTH_FORBIDDEN,
  AUTH_UNAUTHORIZED,
  sharedSecretAuthenticator,
} from "./auth.ts";
import type { HandshakeRequest } from "./connection.ts";

test("grants a valid identity token plus capability credential", async () => {
  const auth = sharedSecretAuthenticator({ secret: "s3cret" });
  const req: HandshakeRequest = { token: "s3cret", credential: "cap-1", remote: "1.2.3.4" };

  const result = await auth(req);
  assert.ok(result.ok);
  assert.equal(result.grant.identity, "1.2.3.4");
  assert.equal(result.grant.capability, "cap-1");
});

test("reads the token and credential from query params (blackboard-hook pattern)", async () => {
  const auth = sharedSecretAuthenticator({ secret: "s3cret" });
  const req: HandshakeRequest = { query: { token: "s3cret", capability: "cap-1" } };

  const result = await auth(req);
  assert.ok(result.ok);
});

test("rejects a wrong identity token with the unauthorized code", async () => {
  const auth = sharedSecretAuthenticator({ secret: "s3cret" });
  const result = await auth({ token: "nope", credential: "cap-1" });

  assert.ok(!result.ok);
  assert.equal(result.code, AUTH_UNAUTHORIZED);
});

test("rejects a missing capability credential with the forbidden code", async () => {
  const auth = sharedSecretAuthenticator({ secret: "s3cret" });
  const result = await auth({ token: "s3cret" });

  assert.ok(!result.ok);
  assert.equal(result.code, AUTH_FORBIDDEN);
});

test("honours a custom credential verifier and identity resolver", async () => {
  const auth = sharedSecretAuthenticator({
    secret: "s3cret",
    identityFor: (req) => `worker:${req.query?.instance ?? "?"}`,
    verifyCredential: (credential) => credential === "good",
  });

  const accepted = await auth({ token: "s3cret", credential: "good", query: { instance: "w7" } });
  assert.ok(accepted.ok);
  assert.equal(accepted.grant.identity, "worker:w7");

  const rejected = await auth({ token: "s3cret", credential: "bad" });
  assert.ok(!rejected.ok);
  assert.equal(rejected.code, AUTH_FORBIDDEN);
});

test("can be configured to not require a credential", async () => {
  const auth = sharedSecretAuthenticator({ secret: "s3cret", requireCredential: false });
  const result = await auth({ token: "s3cret" });
  assert.ok(result.ok);
});
