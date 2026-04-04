import { describe, expect, it } from "vitest";
import { buildPackageCatalog } from "../core/bootstrap/packageCatalog";
import type { CockpitPackage } from "../core/types/module";

function packageFactory(id: string): () => CockpitPackage {
  return () => ({
    id,
    version: "1.0.0",
    enabledByDefault: true,
    modules: []
  });
}

describe("package catalog", () => {
  it("discovers package when index and config.json are present", () => {
    const catalog = buildPackageCatalog(
      {
        "../../packages/nav2/index.tsx": {
          createPackage: packageFactory("nav2")
        }
      },
      {
        "../../packages/nav2/config.json": {
          default: {
            key: "value"
          }
        }
      }
    );

    expect(catalog).toHaveLength(1);
    expect(catalog[0].cockpitPackage.id).toBe("nav2");
    expect(catalog[0].config).toEqual({ key: "value" });
  });

  it("ignores package when config.json is missing", () => {
    const catalog = buildPackageCatalog(
      {
        "../../packages/nav2/index.tsx": {
          createPackage: packageFactory("nav2")
        }
      },
      {}
    );
    expect(catalog).toHaveLength(0);
  });

  it("ignores package when config.json root is not an object", () => {
    const catalog = buildPackageCatalog(
      {
        "../../packages/nav2/index.tsx": {
          createPackage: packageFactory("nav2")
        }
      },
      {
        "../../packages/nav2/config.json": {
          default: ["not-object"]
        }
      }
    );
    expect(catalog).toHaveLength(0);
  });
});
