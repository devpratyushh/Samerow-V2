// simple-peer's stream dependencies use these two browser shims. Avoid
// bundling Node's entire standard library and its unused crypto polyfills.
import { Buffer } from 'buffer';
import process from 'process';
globalThis.Buffer ||= Buffer;
globalThis.process ||= process;
globalThis.global ||= globalThis;
