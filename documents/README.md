# Documents Folder (Local Only)

`documents/` is the local document/media workspace created by the scripts.

- Primary storage is `documents/by-person/<id>-<surname>-<given>/`
- Indexes live in `documents/index.json` and `documents/by-type/*.json`

Only the empty folder structure and index templates are meant to be committed. Per-person folders and any uploaded files are ignored by default via `.gitignore`.

