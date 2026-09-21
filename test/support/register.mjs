// `node --import ./test/support/register.mjs` — installs the stub resolver for the pi packages
// so the extension modules can be imported outside a pi process.
import { register } from "node:module";

register("./stub-loader.mjs", import.meta.url);
