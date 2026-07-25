---
"cimisy": patch
---

`cimisy setup github` now registers the `www.`/apex sibling of a custom production domain alongside the domain you type.

GitHub Apps match `redirect_uri` byte-for-byte and support no wildcards, so an App registered for `https://example.com` rejects sign-in from `https://www.example.com` with "redirect_uri is not associated with this application" — and which of the two a browser lands on is decided by a redirect rule or by whichever domain the host platform reports as canonical, after the App already exists. A GitHub App's callback list can only be set at creation time, so the fix had to happen in the manifest.

Only that one pairing is derived, and only for a registrable domain: `blog.example.com` gets no `www.blog…` sibling, and platform hosts (`*.vercel.app`, `*.pages.dev`, `*.github.io`, …) get none either, since `www.<project>` there is not the same site. A callback URL is where an authorization code gets delivered, so the list is never widened to a host the user might not control.

The wizard also prints the callback URLs before you confirm the App, and suggests `CIMISY_PUBLIC_URL` for the deployment so the `redirect_uri` is pinned to one origin regardless of which domain a visitor arrived on.
