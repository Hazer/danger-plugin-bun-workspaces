// DangerJS has a weird compile/runtime environment, but this is a stable detail!
// Extra files that want to import danger need this to make typescript happy.
//
// Briefly documented here:
// https://github.com/danger/danger-js/blob/main/docs/usage/extending-danger.html.md#writing-your-plugin
// https://github.com/danger/danger-js/discussions/1153#discussioncomment-10981472

import type { DangerRuntimeContainer, Scheduleable } from "danger";
import type { DangerDSLType } from "../node_modules/danger/distribution/dsl/DangerDSL";
import type {
  JSONDiff as DangerJSONDiff,
  JSONDiffValue as DangerJSONDiffValue,
} from "../node_modules/danger/distribution/dsl/GitDSL";

export {};

declare global {
  type JSONDiff = DangerJSONDiff;
  type JSONDiffValue = DangerJSONDiffValue;

  let danger: DangerDSLType;

  function warn(message: string, file?: string, line?: number): void;
  function fail(message: string, file?: string, line?: number): void;
  function markdown(message: string, file?: string, line?: number): void;
  function message(message: string, file?: string, line?: number): void;

  const results: DangerRuntimeContainer;
  /**
   * A Dangerfile, in Peril, is evaluated as a script, and so async code does not work
   * out of the box. By using the `schedule` function you can now register a
   * section of code to evaluate across multiple tick cycles.
   *
   * `schedule` currently handles two types of arguments, either a promise or a function with a resolve arg.
   *
   * @param {Function} asyncFunction the function to run asynchronously
   */
  function schedule(asyncFunction: Scheduleable): void;
}
