# site

Where the site workflow writes. `files/site/` is the site itself: open `index.html` in a browser from disk.

Nothing here is served by the runtime — the workbench never serves a page an agent wrote from its own origin
(SEC-31), because a page on that origin could read the API with the token in the URL.
