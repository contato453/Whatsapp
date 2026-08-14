import { describe, expect, it } from "vitest";
import { hasRole } from "../src/lib/auth.js";

describe("hasRole (autorização por papel)", () => {
  it("admin tem acesso a tudo", () => {
    expect(hasRole("admin", "admin")).toBe(true);
    expect(hasRole("admin", "supervisor")).toBe(true);
    expect(hasRole("admin", "agent")).toBe(true);
  });

  it("supervisor não acessa recursos de admin", () => {
    expect(hasRole("supervisor", "admin")).toBe(false);
    expect(hasRole("supervisor", "supervisor")).toBe(true);
    expect(hasRole("supervisor", "agent")).toBe(true);
  });

  it("agent só acessa recursos de agent", () => {
    expect(hasRole("agent", "admin")).toBe(false);
    expect(hasRole("agent", "supervisor")).toBe(false);
    expect(hasRole("agent", "agent")).toBe(true);
  });
});
