import * as v from 'valibot';

export const urlSchema = v.pipe(v.string(), v.url());

export const coercedUrlListSchema = v.union([
  v.array(urlSchema),
  v.pipe(
    v.string(),
    v.transform((value) => value.split(',')),
    v.array(urlSchema),
  ),
]);

export const booleanishSchema = v.union(
  [v.boolean(), v.pipe(v.string(), v.trim(), v.parseBoolean())],
  'Expected a boolean or a string that can be parsed as a boolean (e.g. "true", "false", "1", "0")',
);

// Env vars are always strings — "3" needs to become 3, same reasoning as
// booleanishSchema above. Without this, any numeric config field set via an
// env var (as opposed to a JS default) fails validation unconditionally,
// regardless of what value is actually in it.
export const numberishSchema = v.union(
  [
    v.number(),
    v.pipe(
      v.string(),
      v.trim(),
      v.transform(Number),
      v.check((value) => !Number.isNaN(value), 'Expected a valid number'),
    ),
  ],
  'Expected a number or a string that can be parsed as a number',
);

export const appSchemeSchema = v.union([
  v.pipe(
    v.string(),
    v.transform((value) => value.split(',')),
  ),
  v.array(v.string()),
]);
