import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { register, resolve, unregister } from "../../src/main/documents.js";

describe("documents", () => {
  it("resolves a registered token to its path", () => {
    const token = register("/Users/me/a.pdf");
    assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(resolve(token), "/Users/me/a.pdf");
  });

  it("gives each registration its own token", () => {
    assert.notEqual(register("/Users/me/b.pdf"), register("/Users/me/b.pdf"));
  });

  it("forgets unregistered tokens", () => {
    const token = register("/Users/me/c.pdf");
    unregister(token);
    assert.equal(resolve(token), undefined);
  });

  it("knows no other tokens", () => {
    for (const token of ["", "nope", "__proto__", "constructor", "toString"]) {
      assert.equal(resolve(token), undefined);
    }
  });
});
