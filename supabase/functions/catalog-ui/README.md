# catalog-ui

Serves the catalog dashboard. The page source lives in `app/index.html`; this
function carries it as base64 inside `index.ts` because the deploy pipeline
ships only the entrypoint — a static file placed next to it is not present at
runtime.

After editing `app/index.html`, regenerate the constant:

```
base64 -w0 app/index.html
```

and redeploy the function with the new value.
