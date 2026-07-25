## What

<!-- Brief description of the change -->

## Why

<!-- Link to issue (closes #123) or explain the motivation -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Docs
- [ ] CI/Tooling

## How to test

<!-- Steps to verify the change works, e.g. -->
<!-- 1. Run `mex check` on a test project -->
<!-- 2. Verify output shows... -->

## Checklist

- [ ] Tests pass (`npm test`)
- [ ] No breaking changes (or documented below)
- [ ] Tested locally with a real project

## Code-graph changes

<!-- Complete this section only for code-graph changes. Otherwise, leave it unchecked. -->

- [ ] This PR targets `main`
- [ ] A linked issue agrees on the bounded extractor/resolver scope
- [ ] The change follows the frozen `LanguageExtractor` or `FrameworkResolver` interface
- [ ] A focused fixture and assertions for the expected node/edge shape are included
- [ ] Any new grammar WASM, extension mapping, extractor, or resolver is registered
- [ ] No graph identity, reconciliation, schema, or drift-semantics changes are included, or a `core / discuss-first` issue is linked above
