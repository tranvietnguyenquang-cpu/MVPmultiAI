// Stands in for the real OS "open browser" command in tests: writes the URL it was
// asked to open to a marker file instead of ever launching a real browser.
import { writeFileSync } from "node:fs";

writeFileSync(process.env.FIXTURE_MARKER, process.argv[2] ?? "");
