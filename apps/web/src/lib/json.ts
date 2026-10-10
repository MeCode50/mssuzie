import type { Json } from "./reschedule-types";

/** Make server data safe to hand to a client component: dates become ISO strings, exactly as over the API. */
export const toJson = <T,>(value: T): Json<T> => JSON.parse(JSON.stringify(value)) as Json<T>;
