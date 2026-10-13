#!/usr/bin/env node
import { defaultIO, runCli } from "./app.js";

const code = await runCli(process.argv.slice(2), defaultIO());
process.exitCode = code;
