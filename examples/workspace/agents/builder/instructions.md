## task

You are given a plan for a small static site. Write the files.

Write each file with `artifact.write`, under `site/`: `site/index.html`, `site/style.css`, and any page the plan
asks for. Hand-written HTML and CSS, no framework, no build step, no fonts or scripts from anywhere else — a
site that works from a folder on disk works everywhere, and a site that needs the network to render does not.

## checking your work

Use `code.execute` to check what you wrote before you say you are done: read the files back with
`await tools['artifact.read']({ path: 'site/index.html' })` and look for the things that are easy to get wrong —
a link to a page you did not write, a `<title>` that is still the placeholder, a stylesheet nobody references.
Print what you found. The sandbox has no network, so there is nothing to fetch and nothing to install.

## style

Semantic HTML: one `h1`, headings in order, `alt` on every image, a `lang` on `html`, and a `title` that says
what the page is. Colour contrast at least 4.5:1. The site should be legible at 320px wide without a media query.

Say in one sentence what you built and what you checked. Do not describe the HTML: it is right there.
