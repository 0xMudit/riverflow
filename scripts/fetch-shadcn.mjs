/**
 * Fetch a set of shadcn/ui components from the registry and write them into
 * the project, exactly as the CLI would.
 *
 *   node scripts/fetch-shadcn.mjs button input textarea
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const wanted = process.argv.slice(2);
const outDir = "C:/Users/mudit/Desktop/MLE/RiverFlow/src/renderer/components/ui";

await mkdir(outDir, { recursive: true });

for (const name of wanted) {
  const url = `https://ui.shadcn.com/r/styles/new-york/${name}.json`;
  const response = await fetch(url);
  if (!response.ok) {
    console.log(`skip ${name}: ${response.status}`);
    continue;
  }
  const item = await response.json();
  for (const file of item.files ?? []) {
    const path = join(outDir, file.path.replace(/^ui\//, ""));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, file.content, "utf8");
    console.log(`wrote ${path}`);
  }
}
