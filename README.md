# family-tree

Convert GEDCOM files to lossless, AI-ready JSON. Preserve family genealogy data with perfect fidelity for current and future integrations.

## 🎯 Philosophy

**Lossless preservation**: Every piece of data from your GEDCOM files is retained, including unfamiliar tags stored in `rawTags` fields.

**AI-ready JSON**: Clean, machine-friendly structure designed for embeddings, RAG systems, and future analysis pipelines.

**Future-proof**: Scalable architecture ready for integrations with webtrees, FamilySearch API, and AI pipelines.

**Non-technical friendly**: Simple scripts and clear documentation so anyone can convert and analyze family data.

## 📋 Prerequisites

- **Node.js 20.0.0+** ([download](https://nodejs.org/))
- Your GEDCOM (.ged) files from Ancestry.com or other genealogy software

## 🚀 Quick Start

### 1. Clone or download this repository

```bash
cd family-tree
```

### 2. Install dependencies

```bash
npm install
```

### 3. Add your GEDCOM (local)

Place your `.ged` files in `data/raw/`. These files are ignored by default and should not be committed.

### 4. Convert GEDCOM to JSON

```bash
npm run convert -- data/raw/yourfile.ged
```

**Output**: A timestamped JSON file in `data/json/yourfile-YYYY-MM-DD.json`

### 5. Analyze the results

```bash
npm run stats -- data/json/yourfile-YYYY-MM-DD.json
```

Prints family counts, date ranges, top surnames, and birthplaces.

### 6. Validate quality (optional)

```bash
npm run validate -- data/json/yourfile-YYYY-MM-DD.json
```

Checks each person record against the JSON schema.

### 7. Deep verification (recommended)

```bash
npm run verify
```

Writes a dated report to `data/verification-report-YYYY-MM-DD.json`.

### 8. Build multi-source historical context (optional, long-running)

```bash
npm run fetch-sources
npm run build-context
```

This pipeline first fetches period+place facts from external sources (DPLA, Europeana, Chronicling America, LOC, OWID, and optional World History Encyclopedia), then uses Ollama only to synthesize those facts into narrative-ready context under `data/historical-context/`.
Typical runtime is **20-60 minutes** for a full tree range, which is expected.
See `docs/setup-context-sources.md` for API key setup and run order.

Useful scoped builds:

```bash
npm run context:status
npm run build-context:world
npm run build-context:usa
npm run build-context:ohio
npm run build-context:indiana
npm run enrich-context
npm run build-context:reset
```

## 📁 Folder Structure

```
family-tree/
├── data/
│   ├── raw/              # Original .ged files (never modified)
│   ├── json/             # Converted JSON output (timestamped)
│   └── archive/          # Older versions for reference
├── scripts/
│   ├── ged-to-json.js    # Main conversion engine
│   ├── validate.js       # Schema validation
│   └── stats.js          # Statistical analysis
├── schema/
│   └── person.schema.json # JSON schema for validation
├── docs/
│   ├── data-dictionary.md # Explains every JSON field
│   └── integrations.md    # Future API integrations
└── README.md             # This file
```

## 📊 Output Format

Converted JSON follows a standardized structure:

```json
{
  "meta": {
    "source": "myfamily.ged",
    "convertedAt": "2024-01-15T14:30:00Z",
    "gedcomVersion": "5.5.1",
    "totalIndividuals": 250,
    "totalFamilies": 80
  },
  "individuals": [
    {
      "id": "@I1@",
      "name": {
        "full": "John Henry Smith",
        "given": "John Henry",
        "surname": "Smith"
      },
      "sex": "M",
      "birth": {
        "date": "12 MAR 1845",
        "dateISO": "1845-03-12",
        "place": "Boston, Massachusetts, USA"
      },
      "death": { ... },
      "familiesAsSpouse": ["@F1@"],
      "familiesAsChild": ["@F2@"]
    }
  ],
  "families": [ ... ],
  "sources": [ ... ],
  "notes": [ ... ],
  "repositories": [ ... ]
}
```

**Key features**:
- ✅ Both raw GEDCOM dates AND ISO 8601 conversions
- ✅ Date qualifiers (ABT, BEF, AFT, BET) preserved
- ✅ All unrecognized tags stored in `rawTags` — nothing is lost
- ✅ Warnings logged for unparseable or unfamiliar GEDCOM elements

## 🔧 Commands

### Convert a GEDCOM file

```bash
npm run convert -- data/raw/myfile.ged
```

Outputs to `data/json/myfile-YYYY-MM-DD.json`. Re-running produces the same output (idempotent).

### Print statistics

```bash
npm run stats -- data/json/myfile-YYYY-MM-DD.json
```

Shows:
- Person and family counts
- Male/female/unknown breakdown
- Earliest and latest birth/death years
- Top 10 surnames
- Top 10 birthplaces

### Validate JSON quality

```bash
npm run validate -- data/json/myfile-YYYY-MM-DD.json
```

Checks each person record against the schema. Reports any validation errors.

### Scaffold local document workspace

```bash
npm run scaffold
```

Creates `documents/by-person/...` folders and per-person `metadata.json` (local-only).

### Inventory media references from GEDCOM

```bash
npm run media-inventory
```

Writes `data/media-inventory.json` showing which referenced media files are present locally vs missing.

## 📖 Documentation

- **[data-dictionary.md](docs/data-dictionary.md)** — Complete reference for every JSON field
- **[integrations.md](docs/integrations.md)** — Roadmap for webtrees, FamilySearch API, and AI pipelines

## 🔐 Privacy

⚠️ **Important**: GEDCOM files may contain private information about living relatives. Consider these options:

1. **Use a private repository**: Store sensitive `.ged` files in a private Git repository or locally only
2. **Anonymize before sharing**: Remove dates and details for living people before publishing
3. **Separate public/private data**: Keep sensitive files in `data/archive/private/`

Your `.git/config` can use `core.sparseCheckout` to selectively version files.

This repo is configured for public publishing: `.gitignore` excludes `data/raw/`, `data/json/*.json`, and per-person `documents/by-person/` content by default. See `data/README.md` and `documents/README.md`.

## 🗺️ Roadmap

- [x] GEDCOM → JSON conversion with lossless preservation
- [x] JSON schema validation
- [x] Statistical analysis
- [ ] **webtrees integration** — Import JSON directly into webtrees
- [x] **FamilySearch API integration (read-only)** — Matching + download tooling
- [ ] **AI/RAG pipeline** — Generate embeddings and query with LLMs
- [ ] **GEDCOM-X support** — Upgrade to modern GEDCOM-X format
- [ ] **Web UI** — Visual tree explorer and editor
- [ ] **Mobile app** — React Native companion for mobile browsing

## 💡 Use Cases

- 📱 **Backup & preservation**: Store family data in durable JSON format
- 🤖 **AI analysis**: Generate embeddings for RAG systems
- 🌳 **Web publishing**: Easily import into webtrees for family website
- 📊 **Research**: Analyze genealogy data programmatically
- 🔗 **Integration**: Connect with FamilySearch, Ancestry, other platforms
- 🕐 **Version control**: Track genealogy changes over time with Git

## ⚙️ Technical Details

- **Parser**: [parse-gedcom](https://www.npmjs.com/package/parse-gedcom) — Fast, standard GEDCOM parsing
- **Validation**: [ajv](https://www.npmjs.com/package/ajv) — JSON Schema validation
- **Date parsing**: [date-fns](https://www.npmjs.com/package/date-fns) — Robust date handling
- **Format**: GEDCOM 5.5.1 (standard format from Ancestry.com)

## 🐛 Troubleshooting

**Q: "File not found" error**

A: Make sure your .ged file path is relative to the project root, e.g., `data/raw/myfile.ged`

**Q: Warnings logged for many tags**

A: This is normal! The converter preserves all GEDCOM tags, even non-standard ones. Check `data/json/warnings-YYYY-MM-DD.log` for details. They're safe in `rawTags`.

**Q: Dates not parsing correctly**

A: GEDCOM supports many date formats. If a date doesn't convert to ISO 8601, it's preserved as-is in the `date` field for manual inspection.

**Q: How do I merge multiple GEDCOM files?**

A: Not yet automated, but you can merge the `individuals`, `families`, and other arrays in the JSON files manually. Check `integrations.md` for upcoming merge tools.

**Q: Why does context generation take so long?**

A: `fetch-sources` + `build-context` process many 5-year windows across multiple scopes and enforce API/model rate limits. A full run commonly takes 20-60 minutes. Run `npm run update-context` quarterly for incremental refresh.

## 📝 License

MIT — Feel free to use, modify, and share.

## 🤝 Contributing

Ideas? Found a bug? Please open an issue or submit a pull request!

---

**Happy genealogy hunting! 🌳**

## Before You Push Your Own Fork Public

- [ ] Delete any personal data files from data/ and documents/ before 
      committing (they are gitignored but exist in your working tree)
- [ ] Confirm no private files were accidentally committed: 
      `git ls-files data/json/ data/raw/ documents/by-person/`
- [ ] Copy .env.example to .env and fill in your credentials (never commit .env)
- [ ] Run `npm run scaffold` after converting your GEDCOM to create person folders
- [ ] Run `npm run verify` to check your data quality before running any API scripts
