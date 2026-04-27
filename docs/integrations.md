# Integrations & Roadmap

Planned integrations and expansion opportunities for the family-tree project.

## 🌳 webtrees Integration

**Status**: Planned  
**Priority**: High

### Overview
[webtrees](https://www.webtrees.net/) is a free online genealogy platform. This integration will allow bi-directional sync between our JSON format and webtrees databases.

### Implementation Plan

1. **JSON → webtrees importer** (One-way)
   - Parse our JSON structure
   - Generate GEDCOM compatible with webtrees
   - Import via webtrees API or direct database insertion
   
2. **webtrees → JSON exporter** (One-way)
   - Query webtrees database
   - Convert family tree to our JSON schema
   - Enable archival and backup

3. **Schema mapping**
   - Document GEDCOM → webtrees field mappings
   - Handle privacy settings for living persons
   - Support webtrees-specific features (media, notes, etc.)

### Benefits

- 📱 Host your tree online with webtrees
- 🔄 Sync changes from JSON to web
- 💾 Backup webtrees data as JSON
- 🔐 Manage privacy via JSON file versioning

---

## 📍 FamilySearch API Integration

**Status**: Planned  
**Priority**: High

### Overview
[FamilySearch](https://www.familysearch.org/) is a massive collaborative genealogy database. Integration enables:
- Looking up ancestors in FamilySearch
- Enriching your tree with community data
- Contributing findings back to the community

### Implementation Plan

1. **FamilySearch API client**
   - OAuth2 authentication
   - Query persons by name/date range
   - Download person records

2. **Enrichment tool**
   - Cross-reference local JSON with FamilySearch
   - Merge person records (avoiding duplicates)
   - Flag potential matches for review

3. **Contribution tool**
   - Upload new persons to FamilySearch
   - Update existing records with sources
   - Track source citations

### Key Challenges

- Privacy: FamilySearch has strict privacy rules for living persons
- Duplicate detection: Matching the same person across databases
- Conflict resolution: Merging contradictory information

### Possible Commands

```bash
npm run enrich -- data/json/myfile-2024-01-01.json --source familysearch
npm run publish -- data/json/myfile-2024-01-01.json --target familysearch
```

---

## 🤖 AI & RAG Pipeline Integration

**Status**: Planned  
**Priority**: Medium

### Overview
Prepare family tree data for AI analysis and Retrieval-Augmented Generation (RAG) systems.

### Components

1. **Embeddings generator**
   - Convert each person record to semantic embeddings
   - Support multiple models (OpenAI, Hugging Face, local models)
   - Store embeddings in vector database

2. **RAG query engine**
   - Query family tree using natural language
   - Example: "Who were the farmers in Massachusetts in 1880?"
   - Example: "Find all descendants of John Smith with children after 1900"

3. **Narrative generation**
   - Generate family histories from data
   - Create biographical summaries
   - Answer genealogy questions

### Integration Points

- **LLM providers**: OpenAI, Anthropic, Hugging Face
- **Vector databases**: Pinecone, Milvus, Qdrant, local embeddings
- **Query languages**: Natural language, SQL-like genealogy queries

### Example Use Case

```bash
npm run embed -- data/json/myfile-2024-01-01.json --model openai
npm run query -- "Tell me about farmers in Massachusetts" --source myfile-embeddings.db
```

---

## 📄 GEDCOM-X Migration

**Status**: Planned  
**Priority**: Medium

### Overview
[GEDCOM-X](https://www.gedcomx.io/) is a modern alternative to GEDCOM 5.5.1, designed to address limitations in the older format.

### Why Migrate?

- ✅ Better structure for complex relationships
- ✅ Native JSON support (vs. text-based GEDCOM)
- ✅ Improved privacy and data model
- ✅ Better suited for APIs and web services

### Implementation

1. **GEDCOM → GEDCOM-X converter**
   - Map our JSON to GEDCOM-X schema
   - Preserve all information during conversion
   - Validate against GEDCOM-X schema

2. **GEDCOM-X → JSON converter**
   - Ingest GEDCOM-X files
   - Convert to our standard JSON format

### Commands

```bash
npm run migrate -- data/json/myfile-2024-01-01.json --to gedcomx
npm run import-gedcomx -- data/raw/myfile.gedx
```

---

## 🌐 Web UI

**Status**: Planned  
**Priority**: Low (depends on API completion)

### Overview
A browser-based interface for visualizing and editing family trees.

### Features

- 🌳 Interactive tree visualization
- 🔍 Search and filter
- 📝 Add/edit persons and families
- 📷 Photo gallery
- 🔗 Link to sources and notes
- 📊 Statistics dashboard

### Tech Stack

- Frontend: React, D3.js or vis.js
- Backend: Node.js Express
- Database: JSON file storage or SQL
- Real-time sync: WebSockets

### Architecture

```
family-tree/
├── web-ui/
│   ├── frontend/        # React SPA
│   ├── backend/         # Express API
│   └── docker-compose.yml
```

---

## 📱 Mobile App

**Status**: Planned  
**Priority**: Low

### Overview
Native mobile app for browsing and contributing to family trees.

### Features

- View family tree on the go
- Add new family members with photos
- Sync with web UI
- Offline mode
- GPS-tagged photos at historical sites

### Tech Stack

- Framework: React Native
- State: Redux
- Backend: Sync with web API
- Database: SQLite (local)

---

## 🔧 Merge Tool

**Status**: Planned  
**Priority**: Medium

### Overview
Combine multiple GEDCOM files or JSON exports into a single family tree.

### Challenges

- Duplicate detection (same person in multiple files)
- Conflict resolution (different dates/places)
- ID remapping (avoid collisions)
- Proof of relationships (track merges)

### Implementation

```bash
npm run merge -- data/json/file1-2024-01-01.json data/json/file2-2024-01-01.json --output merged-2024-01-01.json
```

### Algorithm

1. Parse all input files
2. Build name/date index
3. Score potential duplicates
4. Require user confirmation for merges
5. Output merged JSON with merge history

---

## 🛠️ Maintenance & Operations

### Planned Tools

- **Diff tool**: Compare two JSON files
- **Diff viewer**: Visual comparison UI
- **Sync tool**: Bidirectional sync with external sources
- **Backup tool**: Incremental backups to cloud (S3, etc.)
- **CI/CD**: Automated validation and archival

### Example Commands

```bash
npm run diff -- data/json/file1.json data/json/file2.json
npm run sync -- --direction bidirectional --target webtrees
npm run backup -- data/ --destination s3://mybucket/genealogy/
```

---

## 🗺️ Development Priorities

### Phase 1 (Current)
- ✅ Core GEDCOM → JSON conversion
- ✅ JSON validation & stats
- ✅ Documentation

### Phase 2 (Q1 2024)
- 🎯 webtrees integration
- 🎯 FamilySearch API exploration
- 🎯 Merge tool

### Phase 3 (Q2 2024)
- 🎯 Embeddings & RAG pipeline
- 🎯 AI-driven analysis

### Phase 4 (Q3 2024+)
- 🎯 Web UI prototype
- 🎯 GEDCOM-X support
- 🎯 Mobile companion app

---

## 🤝 Contributing

Interested in any of these integrations? Contributions are welcome!

1. Fork the repository
2. Create a feature branch
3. Submit a pull request with documentation

Please follow the existing code style and include tests for new features.

---

## 📚 References

- **GEDCOM 5.5.1 Spec**: https://www.gedcom.org/
- **GEDCOM-X**: https://www.gedcomx.io/
- **webtrees**: https://www.webtrees.net/
- **FamilySearch API**: https://developers.familysearch.org/
- **JSON Schema**: https://json-schema.org/
- **OpenAI Embeddings**: https://platform.openai.com/docs/guides/embeddings
- **Pinecone Vector DB**: https://www.pinecone.io/

---

## 📋 Integration Checklist

When implementing a new integration, consider:

- [ ] Data flow diagram (input → processing → output)
- [ ] Schema mapping (our JSON ↔ external format)
- [ ] Error handling & validation
- [ ] Privacy considerations (living persons)
- [ ] Documentation (README section + examples)
- [ ] Tests (unit + integration)
- [ ] Example data / test fixtures
- [ ] Performance benchmarks
- [ ] Security review (especially for APIs)

---

**Last updated**: January 2024  
**Next review**: Quarterly
