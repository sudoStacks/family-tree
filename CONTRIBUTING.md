# Contributing

Thanks for contributing!

## Local Setup

```bash
npm install
```

Place your GEDCOM file at `data/raw/<your-file>.ged` (this folder is ignored by git).

## Running Scripts

- Convert: `npm run convert -- data/raw/<your-file>.ged`
- Stats: `npm run stats -- data/json/<your-file>-YYYY-MM-DD.json`
- Schema validation: `npm run validate -- data/json/<your-file>-YYYY-MM-DD.json`
- Deep verification: `npm run verify`
- Document scaffolding: `npm run scaffold`
- Media inventory: `npm run media-inventory`

FamilySearch (optional):

- Copy `.env.example` to `.env` and set credentials
- Run: `npm run fs-match -- --resume`

## What We’d Love PRs For

- Support additional export formats (other GEDCOM variants, GEDCOM-X, etc.)
- Additional read-only API integrations (records search, media download helpers)
- Better date parsing / normalization
- A UI layer (tree browsing, document management)

## Privacy / Data Policy (Important)

Never include personal family data in a PR:

- No `data/raw/` GEDCOM files
- No converted `data/json/*.json`
- No `documents/by-person/` folders or uploaded media
- No `.env` files or token caches

If you need to demonstrate behavior, add a tiny **synthetic** (fake) fixture that contains no real people.

