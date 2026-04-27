# Data Folder (Local Only)

This repo is designed to be safe to publish publicly. The `data/` folder is where **your personal genealogy files** live when you run the scripts locally.

By default, `.gitignore` excludes:

- `data/raw/` (GEDCOM exports)
- `data/json/*.json` (converted full tree)
- `data/fs-mapping.json`, `data/media-inventory.json`, `data/verification-report-*.json` (derived outputs)
- `data/.fs-token-cache.json` (FamilySearch token cache)

## Getting Started

1. Put a GEDCOM file at `data/raw/<your-file>.ged`
2. Convert it: `npm run convert -- "data/raw/<your-file>.ged"`
3. Then you can run:
   - `npm run scaffold`
   - `npm run verify`
   - `npm run media-inventory`

