# Domain Docs

This repository uses single-context domain documentation: root `GLOSSARY.md` and `docs/adr/`.

## Before exploring

- Read root `GLOSSARY.md` for domain vocabulary.
- Read ADRs in `docs/adr/` that touch the area you are about to work in.

If these files do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. `/domain-modeling` creates them lazily when terms or decisions are resolved; `/grill-with-docs` and `/improve-codebase-architecture` can invoke that workflow.

## Use the glossary’s vocabulary

Use glossary terms in issue titles, refactor proposals, hypotheses, and test names. Avoid synonyms the glossary explicitly rejects.

If a needed concept is absent, reconsider whether it belongs to the project’s vocabulary; note genuine gaps for `/domain-modeling`.

## Flag ADR conflicts

Explicitly identify any existing ADR your proposal contradicts and explain why it is worth reopening.
