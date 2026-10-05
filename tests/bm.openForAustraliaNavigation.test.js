import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Open For Australia Business Manager navigation", () => {
  it("accepts Students only as a configurable menu label", () => {
    const controller = fs.readFileSync(
      path.join(root, "src/controllers/bm.navigation.links.controller.js"),
      "utf8",
    );
    const menuStart = controller.indexOf("menu: [");
    const menuEnd = controller.indexOf("],", menuStart);
    const menuLabels = controller.slice(menuStart, menuEnd);
    const headerLabels = controller.slice(
      controller.indexOf("header: ["),
      menuStart,
    );
    expect(menuLabels).toContain('"Students"');
    expect(headerLabels).not.toContain('"Students"');
  });
});
