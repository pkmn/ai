# Contributing

> [!TIP]
> Pull requests for copy editing (especially to fix typos) are very welcome!

Please read through the [DESIGN](../DESIGN.md) document for a high-level overview of the project.
You can get started quickly by installing dependencies and then experimenting on
the [local server](http://localhost:1234):

```sh
$ npm install
$ npm run compile
$ npm start
```

## Concepts

If you wish to write an article about a specific concept, please first [open an
issue](https://github.com/pkmn/ai/issues/new) with an outline of what you wish to cover
or [discuss it in chat](https://pkmn.ai/chat) to ensure the content will be approriate for the site
and that there isn't wasted effort on pages which might not be a good fit.

## Research

Currently, any research remotely interesting/relevant to competitive Pokémon AI researchers is
eligible for inclusion (eventually the list will likely be pruned once it is clear what is most
important/relevant). To add a new paper you must add citation information to
[`research.bib`](../src/static/research.bib):

  - citation keys take the form of `FirstAuthorLastName:Date`, with letters added to disambiguate if
    necessary
  - do not include an abstract (`abstractnote`)
  - `@misc`, `@article`, `@inproceedings`, `@phdthesis`, and `@mastersthesis` are currently the only
    supported citation types, though support for other types can be added to
    [`research.ts`](../src/static/research.ts)
  - field order should be `title`, followed by `author`, and the last field should always be `url`
  - author names should be formatted as `Last, First and Last First and ...`
  - wherever possible, the `url` should be a direct link to a PDF, and whichever PDF has the most
    information should be chosen
  - prefer citing actual published work over preprints, though often preprints contain more
    information so still might be a better source (though you can also optionally cite the published
    work and link the preprint URL)
  - if present, `pages` should be separated with `--` to make sure they get rendered as an en-dash
  - arXiv citations should use `@misc` and include `archiveprefix`, `primaryclass`, and `preprint`
    fields
  - order within the file doesn't matter, usually its easier to add new entries to the end
  - follow the same formatting as the other entries - the [`LaTeX Workshop`
    plugin](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop) can be used
    to help align fields correctly

When referencing research from other pages, always use the form `[(Name
Date)](/research#Name:Date){.subtle}`.

## Projects

[`projects.bib`](../src/static/projects.bib) has the same formatting requirements as covered above
for [Research](#research), with the exception that entries must be sorted chronologically. Note that
the `projects.bib` file is simply supplemental to the main
[`projects.yml`](../src/static/projects.yml) file - inclusion in the latter is required for projects
to actually be listed on the [Projects](https://pkmn.ai/projects) page.

## Glossary

Inclusion of terms in the glossary is rather nebulous - ideally someone with relatively little
experience at either competitive Pokémon or AI research should be able to follow discussions by
simply referencing the glossary page, which means both basic and advanced definitions can be
included. Furthermore, because of this goal the glossary aims to include the transitive closure of
terms which are useful and thus terms that are used in the definition of other terms are usually
included. Wherever possible, the glossary should attempt to define terms with respect to their use
in competitive Pokémon AI - general definitions should always try to tie things back to Pokémon with
specific examples. Some other guidelines:

  - use `[TERM]{.dfn}` to call out definitions/expansions of abbreviations in the text that don't have
    there own top level entry and avoid using bold styling for things which aren't definitions
  - prefer italics to quotations when talking about literal terms
