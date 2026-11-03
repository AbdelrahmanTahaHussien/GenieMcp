import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractPropsFromSource } from "../dist/extract-props.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureSrc = join(here, "fixtures", "sample-app", "src");

describe("extractPropsFromSource", () => {
  it("pulls prop names from a component's <Name>Props interface in source", async () => {
    const file = join(fixtureSrc, "components", "ui", "Button", "Button.tsx");
    // ButtonProps { label; onClick? } — props come straight from source, with no
    // dependency on any generated docs folder having a **Props** list.
    expect((await extractPropsFromSource(file, "Button")).sort()).toEqual([
      "label",
      "onClick",
    ]);
  });

  it("returns [] for a file with no matching *Props declaration", async () => {
    const file = join(fixtureSrc, "pages", "LazyPage.tsx");
    expect(await extractPropsFromSource(file, "LazyPage")).toEqual([]);
  });

  it("returns [] for an unreadable file instead of throwing", async () => {
    expect(
      await extractPropsFromSource(join(fixtureSrc, "does-not-exist.tsx"), "X"),
    ).toEqual([]);
  });
});
