# Data Dictionary

Complete reference for every field in the converted JSON format.

## Top-Level Structure

### `meta` — Metadata about the conversion

```json
{
  "meta": {
    "source": "filename.ged",
    "convertedAt": "2024-01-15T14:30:00Z",
    "gedcomVersion": "5.5.1",
    "totalIndividuals": 250,
    "totalFamilies": 80,
    "totalSources": 45,
    "totalNotes": 120,
    "totalRepositories": 3
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `source` | string | Original GEDCOM filename |
| `convertedAt` | string | ISO 8601 timestamp of conversion |
| `gedcomVersion` | string | GEDCOM standard version (usually "5.5.1") |
| `totalIndividuals` | number | Count of persons |
| `totalFamilies` | number | Count of families |
| `totalSources` | number | Count of sources/citations |
| `totalNotes` | number | Count of notes |
| `totalRepositories` | number | Count of repositories |

---

## Person Record

```json
{
  "individuals": [
    {
      "id": "@I1@",
      "name": { ... },
      "sex": "M",
      "birth": { ... },
      "death": { ... },
      "burial": { ... },
      "events": [ ... ],
      "attributes": [ ... ],
      "familiesAsSpouse": ["@F1@"],
      "familiesAsChild": ["@F2@"],
      "notes": [],
      "sources": [],
      "media": [],
      "rawTags": {}
    }
  ]
}
```

### `id` — Unique identifier

**Type**: string  
**Format**: `@I[number]@` (e.g., `@I1@`, `@I12345@`)  
**Description**: GEDCOM cross-reference pointer. Immutable within a file and used to link to families.

### `name` — Name components

```json
{
  "full": "John Henry Smith Jr.",
  "given": "John Henry",
  "surname": "Smith",
  "prefix": "",
  "suffix": "Jr."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `full` | string | Complete name as stored in GEDCOM |
| `given` | string \| null | Given/first names |
| `surname` | string \| null | Family surname |
| `prefix` | string \| null | Name prefix (e.g., "von", "de") |
| `suffix` | string \| null | Name suffix (e.g., "Jr.", "III", "Sr.") |

### `sex` — Biological sex

**Type**: string \| null  
**Enum**: `"M"`, `"F"`, `"U"`, or `null`

| Value | Meaning |
|-------|---------|
| `"M"` | Male |
| `"F"` | Female |
| `"U"` | Unknown |
| `null` | Not specified |

### `birth` — Birth event

```json
{
  "date": "12 MAR 1845",
  "dateISO": "1845-03-12",
  "dateQualifier": null,
  "place": "Boston, Suffolk, Massachusetts, USA",
  "sourceRefs": ["@S1@", "@S2@"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `date` | string | Raw GEDCOM date string |
| `dateISO` | string \| null | ISO 8601 date (YYYY-MM-DD), null if unparseable |
| `dateQualifier` | string \| null | Date qualifier: `"ABT"` (about), `"BEF"` (before), `"AFT"` (after), `"BET"` (between) |
| `place` | string | Birth location (e.g., city, county, state, country) |
| `sourceRefs` | array | IDs of source records supporting this event |

### `death` — Death event

**Structure identical to `birth`.**

```json
{
  "date": "15 APR 1910",
  "dateISO": "1910-04-15",
  "dateQualifier": null,
  "place": "New York, New York, USA",
  "sourceRefs": []
}
```

### `burial` — Burial event

```json
{
  "date": "20 APR 1910",
  "place": "Mount Auburn Cemetery, Cambridge, Massachusetts, USA"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `date` | string | Burial date (raw GEDCOM format) |
| `place` | string | Burial location |

### `events` — Additional life events

```json
{
  "events": [
    {
      "type": "CENS",
      "date": "01 JUN 1880",
      "dateISO": "1880-06-01",
      "dateQualifier": null,
      "place": "Boston, Massachusetts, USA",
      "description": "1880 US Census"
    },
    {
      "type": "EMIG",
      "date": "1865",
      "dateISO": "1865-01-01",
      "dateQualifier": null,
      "place": "Boston, Massachusetts, USA → New York, USA",
      "description": "Emigrated to New York"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Event type: `"CENS"` (census), `"EMIG"` (emigration), `"RESI"` (residence), `"OCCU"` (occupation), `"NATI"` (nationality), `"RELI"` (religion), `"TITL"` (title), `"GRAD"` (graduation), `"PROB"` (probate), `"WILL"` (will) |
| `date` | string | Raw GEDCOM date |
| `dateISO` | string \| null | ISO 8601 date |
| `dateQualifier` | string \| null | Date qualifier |
| `place` | string | Event location |
| `description` | string \| null | Additional description |

### `attributes` — Personal attributes

```json
{
  "attributes": [
    { "type": "OCCU", "value": "Farmer" },
    { "type": "RELI", "value": "Baptist" },
    { "type": "NATI", "value": "American" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Attribute type: `"OCCU"` (occupation), `"RELI"` (religion), `"NATI"` (nationality), `"TITL"` (title) |
| `value` | string \| null | Attribute value |

### `familiesAsSpouse` — Marriages

**Type**: array of strings  
**Format**: Family IDs (e.g., `["@F1@", "@F2@"]`)  
**Description**: IDs of family records where this person is a spouse (husband or wife).

### `familiesAsChild` — Parents and siblings

**Type**: array of strings  
**Format**: Family IDs (e.g., `["@F2@"]`)  
**Description**: IDs of family records where this person is a child.

### `notes` — Associated notes

**Type**: array of strings  
**Format**: Note IDs (e.g., `["@N1@", "@N2@"]`)  
**Description**: References to note records with additional information.

### `sources` — Associated sources

**Type**: array of strings  
**Format**: Source IDs (e.g., `["@S1@"]`)  
**Description**: References to source/citation records.

### `media` — Photos and documents

```json
{
  "media": [
    {
      "id": "@M1@",
      "title": "John Henry Smith Portrait",
      "type": "image/jpeg"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Media ID |
| `title` | string \| null | Media title or description |
| `type` | string \| null | MIME type (e.g., `"image/jpeg"`, `"application/pdf"`) |

### `rawTags` — Unprocessed GEDCOM tags

**Type**: object  
**Description**: Any GEDCOM tags not explicitly mapped to the above fields are stored here for lossless preservation.

```json
{
  "rawTags": {
    "EVEN": [
      { "value": "Battle of Gettysburg", "tree": [...] }
    ],
    "IDNO": [
      { "value": "ABC123", "tree": [...] }
    ]
  }
}
```

---

## Family Record

```json
{
  "families": [
    {
      "id": "@F1@",
      "husband": "@I1@",
      "wife": "@I2@",
      "children": ["@I3@", "@I4@", "@I5@"],
      "marriage": { ... },
      "divorce": { ... },
      "notes": [],
      "sources": [],
      "rawTags": {}
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique family ID (format: `@F[number]@`) |
| `husband` | string \| null | Spouse 1 ID (typically husband in GEDCOM) |
| `wife` | string \| null | Spouse 2 ID (typically wife in GEDCOM) |
| `children` | array | IDs of child persons |
| `marriage` | object | Marriage event (date, place, sources) |
| `divorce` | object | Divorce event (date, place, sources) |
| `notes` | array | Note IDs |
| `sources` | array | Source IDs |
| `rawTags` | object | Unprocessed GEDCOM tags |

### `marriage` and `divorce` — Family events

Same structure as person events:

```json
{
  "date": "25 JUN 1865",
  "dateISO": "1865-06-25",
  "dateQualifier": null,
  "place": "Boston, Massachusetts, USA",
  "sourceRefs": ["@S1@"]
}
```

---

## Source Record

```json
{
  "sources": [
    {
      "id": "@S1@",
      "title": "1880 United States Federal Census",
      "author": "U.S. Census Bureau",
      "publication": "Ancestry.com",
      "rawTags": [...]
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique source ID |
| `title` | string | Source title |
| `author` | string | Source author |
| `publication` | string | Publication or repository |
| `rawTags` | array | Full GEDCOM tree for this source |

---

## Note Record

```json
{
  "notes": [
    {
      "id": "@N1@",
      "text": "John was known for his farming innovations...",
      "rawTags": [...]
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique note ID |
| `text` | string | Note content |
| `rawTags` | array | Full GEDCOM tree for this note |

---

## Repository Record

```json
{
  "repositories": [
    {
      "id": "@R1@",
      "name": "Massachusetts Historical Society",
      "address": "Boston, MA",
      "rawTags": [...]
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique repository ID |
| `name` | string | Repository name |
| `address` | string | Physical or web address |
| `rawTags` | array | Full GEDCOM tree for this repository |

---

## Date Handling

### ISO 8601 Format

All dates are converted to `YYYY-MM-DD` format when possible:

| GEDCOM Date | ISO 8601 |
|-------------|----------|
| `"12 MAR 1845"` | `"1845-03-12"` |
| `"MAR 1845"` | `"1845-03-01"` (day defaults to 01) |
| `"1845"` | `"1845-01-01"` (month and day default to 01) |
| `"ABT 1845"` | `"1845-01-01"` (qualifier stored separately) |
| Unparseable | `null` (preserved in raw `date` field) |

### Date Qualifiers

GEDCOM supports approximate dates:

| Qualifier | Meaning | Example |
|-----------|---------|---------|
| `"ABT"` | About/approximately | `ABT 1850` |
| `"BEF"` | Before | `BEF 1900` |
| `"AFT"` | After | `AFT 1920` |
| `"BET"` | Between | `BET 1850 AND 1860` |

Qualifiers are stored in the `dateQualifier` field.

---

## Examples

### Complete Person Record

```json
{
  "id": "@I1@",
  "name": {
    "full": "John Henry /Smith/",
    "given": "John Henry",
    "surname": "Smith",
    "prefix": null,
    "suffix": null
  },
  "sex": "M",
  "birth": {
    "date": "12 MAR 1845",
    "dateISO": "1845-03-12",
    "dateQualifier": null,
    "place": "Boston, Suffolk, Massachusetts, USA",
    "sourceRefs": ["@S1@"]
  },
  "death": {
    "date": "15 APR 1910",
    "dateISO": "1910-04-15",
    "dateQualifier": null,
    "place": "New York, New York, USA",
    "sourceRefs": []
  },
  "burial": {
    "date": "20 APR 1910",
    "place": "Mount Auburn Cemetery, Cambridge, Massachusetts, USA"
  },
  "events": [
    {
      "type": "CENS",
      "date": "01 JUN 1880",
      "dateISO": "1880-06-01",
      "dateQualifier": null,
      "place": "Boston, Massachusetts, USA",
      "description": null
    }
  ],
  "attributes": [
    { "type": "OCCU", "value": "Farmer" },
    { "type": "RELI", "value": "Baptist" }
  ],
  "familiesAsSpouse": ["@F1@"],
  "familiesAsChild": ["@F2@"],
  "notes": [],
  "sources": ["@S1@"],
  "media": [],
  "rawTags": {}
}
```

### Complete Family Record

```json
{
  "id": "@F1@",
  "husband": "@I1@",
  "wife": "@I2@",
  "children": ["@I3@", "@I4@", "@I5@"],
  "marriage": {
    "date": "25 JUN 1865",
    "dateISO": "1865-06-25",
    "dateQualifier": null,
    "place": "Boston, Massachusetts, USA",
    "sourceRefs": ["@S2@"]
  },
  "divorce": {
    "date": "",
    "dateISO": null,
    "dateQualifier": null,
    "place": "",
    "sourceRefs": []
  },
  "notes": [],
  "sources": [],
  "rawTags": {}
}
```

---

## Notes

- **Lossless preservation**: The `rawTags` field on any record captures unhandled GEDCOM tags, ensuring no data is lost.
- **Idempotent conversion**: Running the converter twice produces identical JSON output.
- **Schema validation**: Use `npm run validate` to check JSON quality against `schema/person.schema.json`.
- **Future extensibility**: New fields can be added without breaking existing consumers.
