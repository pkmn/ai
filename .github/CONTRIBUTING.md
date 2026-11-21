# Contributing

> [!TIP]
> Copy-editing and typo-fix PRs are always welcome.

Read [DESIGN.md](../docs/DESIGN.md) for an overview. Run locally at <http://localhost:1234>:

```sh
npm install && npm run compile && npm start
```

## Concepts

Before writing a concept article, [open an issue](https://github.com/pkmn/ai/issues/new) with an
outline or [discuss in chat](https://pkmn.ai/chat) so the scope fits the site.

## Research

Any research relevant to competitive Pokémon AI is eligible for [`research.bib`](../static/research.bib):

- Key format: `FirstAuthorLastName:Date` (append a letter to disambiguate).
- Omit `abstractnote`.
- Supported types: `@misc`, `@article`, `@inproceedings`, `@phdthesis`, `@mastersthesis` (add more in
  [`research.tsx`](../static/research.tsx)).
- Field order: `title`, `author`, ..., `url` last.
- Authors: `Last, First and Last First and ...`.
- `url`: direct link to the most informative PDF when possible. Prefer citing published work over
  preprints, though linking a more complete preprint URL is fine.
- `pages`: separate with `--` (en-dash).
- arXiv entries: `@misc` with `archiveprefix`, `primaryclass`, and `preprint`.
- File order doesn't matter (append to end); match existing alignment ([`LaTeX Workshop`](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop) helps).

Cite research in pages as `[(Name Date)](/research#Name:Date){.subtle}`.

## Projects

[`projects.bib`](../static/projects.bib) follows the [Research](#research) rules above except entries
must be sorted chronologically. It supplements [`projects.yml`](../static/projects.yml), which is
required for a project to appear on [Projects](https://pkmn.ai/projects).

## Glossary

Include both basic and advanced terms (aiming for the transitive closure of terms used in other
definitions) so newcomers to either competitive Pokémon or AI can follow discussions. Tie general
definitions back to competitive Pokémon AI with concrete examples:

- Use `[TERM]{.dfn}` for inline definitions/expansions without a top-level entry; don't use bold for
  non-definitions.
- Prefer italics over quotes for literal terms.
