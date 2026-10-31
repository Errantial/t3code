import * as S from "effect/Schema";
import * as ns from "./namespace.ts";
console.log(ns);
export { Remote as Reexported } from "./remote.ts";
export const Text = S.String;
export const Alias = Text;
const Internal = S.Boolean;
export type Internal = typeof Internal.Type;
export const PublicAlias = Internal;
export default Text;
export const Record = S.Struct({ name: Text }).annotate({ title: "record" });
export const Branded = S.String.pipe(S.brand("Name"));
export class Failure extends S.TaggedError<Failure>()("Failure", { reason: Text }) {}
export class Person extends S.Class<Person>("Person")({ name: Text }) {}
export type UnusedType = { name: string };
export interface UnusedInterface {
  name: string;
}
