// Runs on `npm version` (the "version" lifecycle script): keeps .claude-plugin/plugin.json at package.json's version.
import fs from "node:fs";

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const file = ".claude-plugin/plugin.json";
const field = /("version":\s*")[^"]*(")/;
const text = fs.readFileSync(file, "utf8");
if (!field.test(text)) throw new Error(`no version field in ${file}`);
fs.writeFileSync(file, text.replace(field, `$1${version}$2`));
