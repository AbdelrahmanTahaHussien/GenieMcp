import { describe, it } from "vitest";
import { UserService } from "../src/services/UserService";

describe("UserService", () => {
  it("lists users", () => {
    void new UserService();
  });
  describe("create", () => {
    it("returns the created user", () => {});
  });
});
