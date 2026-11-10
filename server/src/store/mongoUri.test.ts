import { describe, expect, it } from "vitest";
import { databaseName, redactMongoUri } from "./mongoStore.js";

describe("MongoDB URI handling", () => {
  it("uses the database in the URI path, or build-or-not when there is none (never 'test')", () => {
    expect(databaseName("mongodb+srv://u:p@cluster0.x.mongodb.net/")).toBe("build-or-not");
    expect(databaseName("mongodb+srv://u:p@cluster0.x.mongodb.net/?retryWrites=true&w=majority")).toBe("build-or-not");
    expect(databaseName("mongodb+srv://u:p@cluster0.x.mongodb.net")).toBe("build-or-not");
    expect(databaseName("mongodb+srv://u:p@cluster0.x.mongodb.net/build-or-not?retryWrites=true")).toBe("build-or-not");
    expect(databaseName("mongodb://h1:27017,h2:27017/mydb?replicaSet=rs")).toBe("mydb");
  });

  it("hides the username and password before anything is logged", () => {
    const shown = redactMongoUri("mongodb+srv://app_user:S3cretPass@cluster0.x.mongodb.net/build-or-not");
    expect(shown).toBe("mongodb+srv://***:***@cluster0.x.mongodb.net/build-or-not");
    expect(shown).not.toContain("S3cretPass");
  });
});
