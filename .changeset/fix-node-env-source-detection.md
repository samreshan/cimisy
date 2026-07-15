---
"cimisy": patch
---

Fix `cimisy import`'s config-source detection ignoring the actual value of `process.env.NODE_ENV` when the config uses the README's own recommended local/production switch:

```ts
source:
  process.env.NODE_ENV === "development"
    ? localSource({ rootDir: "./content" })
    : githubSource({ /* ... */ }),
```

`detectSource` statically walks the config's AST for `localSource(...)`/`githubSource(...)` calls without any awareness of conditionals — for the ternary above it found both calls and kept whichever came last in source order (`githubSource`, since it's always the `:` branch), regardless of the real `NODE_ENV`. `cimisy import` then refused to run at all ("uses githubSource"), even in local dev. It now recognizes a ternary keyed on `process.env.NODE_ENV` and evaluates it against the CLI's actual `NODE_ENV`, so the branch that would really execute is the one inspected. A conditional keyed on anything else is left as `unknown` rather than guessed at.

Also: the "uses githubSource" / "could not determine storage adapter" errors now name the config file that was actually read (e.g. `cimisy.config.js`) instead of always saying `cimisy.config.ts`.
